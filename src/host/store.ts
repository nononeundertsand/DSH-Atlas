/**
 * 本地优先的工作区存储。
 *
 * 目录布局（~/.dsh/atlas）：
 *   workspaces/<id>/workspace.json
 *   workspaces/<id>/nodes.json
 *   workspaces/<id>/threads.json
 *   workspaces/<id>/viewport.json
 *   workspaces/<id>/threads/<thread-id>.jsonl
 *   workspaces/<id>/cards/<node-id>.json
 *
 * 所有整文件写入都走 write-temp → rename；消息是追加写。
 * 单用户、单进程前提下用一个 Promise 队列串行化写操作。
 */
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import {
  type AtlasMessage,
  type AtlasNode,
  type ClosureCard,
  type CreateNodeInput,
  type CreateSubthreadInput,
  type PathBrief,
  type Role,
  type Thread,
  type ThreadSnapshot,
  type LibraryItem,
  type NodeSessionLink,
  type SessionRecord,
  type Viewport,
  type Workspace,
  type WorkspaceSnapshot,
} from '../shared/types.js'
import { DEFAULT_VIEWPORT } from '../shared/protocol.js'

type Json = Record<string, unknown>

const SAFE_ID = /^[A-Za-z0-9_-]+$/
const NODE_W = 288
const NODE_H = 104

export class AtlasStore {
  private readonly root: string
  private writeQueue: Promise<unknown> = Promise.resolve()

  constructor(dataDir?: string) {
    this.root = dataDir ?? dshHomePath('atlas')
  }

  get location(): string {
    return this.root
  }

  // ── 工作区 ────────────────────────────────────────────────────────────────

  async listWorkspaces(): Promise<Workspace[]> {
    await mkdir(this.workspacesRoot(), { recursive: true })
    const entries = await readdir(this.workspacesRoot(), { withFileTypes: true })
    const workspaces: Workspace[] = []
    for (const entry of entries) {
      if (!entry.isDirectory() || !SAFE_ID.test(entry.name)) continue
      const workspace = await this.readJson<Workspace>(this.workspaceFile(entry.name))
      if (workspace) workspaces.push(workspace)
    }
    return workspaces.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  async ensureWorkspace(): Promise<Workspace> {
    const workspaces = await this.listWorkspaces()
    const active = workspaces.find((item) => item.active) ?? workspaces[0]
    if (active) {
      if (!active.active) await this.setActive(active.id)
      return active
    }
    return this.createWorkspace('我的地图')
  }

  async createWorkspace(name: string, goal?: string): Promise<Workspace> {
    return this.mutate(async () => {
      const now = new Date().toISOString()
      const workspace: Workspace = {
        id: `w_${shortId()}`,
        name: name.trim() || '未命名地图',
        goal: goal?.trim() || undefined,
        createdAt: now,
        updatedAt: now,
        active: true,
        rev: 1,
      }
      for (const other of await this.listWorkspaces()) {
        if (other.active) {
          await this.writeJson(this.workspaceFile(other.id), { ...other, active: false, rev: other.rev + 1 })
        }
      }
      await mkdir(this.workspaceDir(workspace.id), { recursive: true })
      await this.writeJson(this.workspaceFile(workspace.id), workspace)
      await this.writeJson(this.nodesFile(workspace.id), [])
      await this.writeJson(this.threadsFile(workspace.id), [])
      await this.writeJson(this.viewportFile(workspace.id), { ...DEFAULT_VIEWPORT })
      return workspace
    })
  }

  async setActive(workspaceId: string): Promise<Workspace> {
    return this.mutate(async () => {
      const target = await this.requireWorkspace(workspaceId)
      for (const other of await this.listWorkspaces()) {
        const active = other.id === workspaceId
        if (other.active !== active) {
          await this.writeJson(this.workspaceFile(other.id), {
            ...other,
            active,
            rev: other.rev + 1,
            updatedAt: active ? new Date().toISOString() : other.updatedAt,
          })
        }
      }
      return { ...target, active: true }
    })
  }

  async updateWorkspace(workspaceId: string, patch: { name?: string; goal?: string }): Promise<Workspace> {
    return this.mutate(async () => {
      const workspace = await this.requireWorkspace(workspaceId)
      const next: Workspace = {
        ...workspace,
        name: patch.name?.trim() || workspace.name,
        goal: patch.goal?.trim() || workspace.goal,
        updatedAt: new Date().toISOString(),
        rev: workspace.rev + 1,
      }
      await this.writeJson(this.workspaceFile(workspaceId), next)
      return next
    })
  }

  async snapshot(workspaceId: string): Promise<WorkspaceSnapshot> {
    const workspace = await this.requireWorkspace(workspaceId)
    const [nodes, threads, viewport] = await Promise.all([
      this.readJson<AtlasNode[]>(this.nodesFile(workspaceId)),
      this.readJson<Thread[]>(this.threadsFile(workspaceId)),
      this.readJson<Viewport>(this.viewportFile(workspaceId)),
    ])
    return {
      workspace,
      nodes: (nodes ?? []).filter(node => !node.deletedAt),
      threads: (threads ?? []).filter((thread) => thread.kind === 'main' && (nodes ?? []).some(node => node.id === thread.nodeId && !node.deletedAt)),
      viewport: viewport ?? { ...DEFAULT_VIEWPORT },
      rev: workspace.rev,
    }
  }

  async saveViewport(workspaceId: string, viewport: Viewport): Promise<Viewport> {
    return this.mutate(async () => {
      await this.requireWorkspace(workspaceId)
      const safe: Viewport = {
        x: finite(viewport.x, 0),
        y: finite(viewport.y, 0),
        zoom: clamp(finite(viewport.zoom, 1), 0.15, 2.5),
      }
      await this.writeJson(this.viewportFile(workspaceId), safe)
      return safe
    })
  }

  // ── 节点 ──────────────────────────────────────────────────────────────────

  async createNode(input: CreateNodeInput): Promise<{ node: AtlasNode; thread: Thread }> {
    return this.mutate(async () => {
      const snapshot = await this.snapshot(input.workspaceId)
      if (snapshot.nodes.length >= 500) throw new Error('E_BUDGET: 节点数量已达上限')
      const parent = input.parentId ? snapshot.nodes.find((node) => node.id === input.parentId) : undefined
      if (input.parentId && !parent) throw new Error('E_NOT_FOUND: 父节点不存在')

      const now = new Date().toISOString()
      const nodeId = `n_${shortId()}`
      const threadId = `t_${shortId()}`
      const siblings = snapshot.nodes.filter((node) => node.parentId === (input.parentId ?? null))
      const position = input.position ?? defaultPosition(parent, siblings.length)
      const node: AtlasNode = {
        id: nodeId,
        workspaceId: input.workspaceId,
        parentId: parent?.id ?? null,
        title: input.title.trim() || '未命名节点',
        subtitle: input.subtitle?.trim() || undefined,
        kind: parent ? 'topic' : 'module',
        status: 'seed',
        mastery: 0,
        position,
        threadId,
        createdAt: now,
        updatedAt: now,
      }
      const thread: Thread = {
        id: threadId,
        nodeId,
        parentThreadId: null,
        kind: 'main',
        title: node.title,
        order: 0,
        collapsed: false,
        createdAt: now,
      }
      const allNodes = (await this.readJson<AtlasNode[]>(this.nodesFile(input.workspaceId))) ?? []
      await this.writeJson(this.nodesFile(input.workspaceId), [...allNodes, node])
      const threads = (await this.readJson<Thread[]>(this.threadsFile(input.workspaceId))) ?? []
      await this.writeJson(this.threadsFile(input.workspaceId), [...threads, thread])
      await this.touch(input.workspaceId)
      return { node, thread }
    })
  }

  async updateNode(nodeId: string, patch: Partial<Pick<AtlasNode, 'title' | 'subtitle' | 'position' | 'status' | 'mastery' | 'dueAt'>>): Promise<AtlasNode> {
    return this.mutate(async () => {
      const { workspaceId, nodes, node } = await this.findNode(nodeId)
      const next: AtlasNode = {
        ...node,
        ...(patch.position === undefined ? {} : { position: patch.position }),
        ...(patch.status === undefined ? {} : { status: patch.status }),
        ...(patch.dueAt === undefined ? {} : { dueAt: patch.dueAt }),
        title: patch.title?.trim() || node.title,
        subtitle: patch.subtitle?.trim() ?? node.subtitle,
        mastery: patch.mastery === undefined ? node.mastery : clamp(Math.round(patch.mastery), 0, 5),
        updatedAt: new Date().toISOString(),
      }
      await this.writeJson(this.nodesFile(workspaceId), nodes.map((item) => (item.id === nodeId ? next : item)))
      await this.touch(workspaceId)
      return next
    })
  }

  async deletionPreview(nodeId: string): Promise<{ nodes: AtlasNode[]; token: string }> {
    const { nodes } = await this.findNode(nodeId)
    const ids = new Set(descendantsOf(nodeId, nodes))
    return { nodes: nodes.filter(node => ids.has(node.id) && !node.deletedAt), token: nodesToken(nodes) }
  }

  async deletedNodes(includeHidden = false): Promise<LibraryItem[]> {
    const results: LibraryItem[] = []
    const existing = new Set<string>()
    for (const workspace of await this.listWorkspaces()) {
      const nodes = (await this.readJson<AtlasNode[]>(this.nodesFile(workspace.id))) ?? []
      for (const node of nodes) existing.add(node.id)
      const byId = new Map(nodes.map(node => [node.id, node]))
      // 已删除节点 + 手动归档会话（节点仍在，仅打 sessionArchivedAt）。
      for (const node of nodes.filter(node => node.deletedAt || node.sessionArchivedAt)) {
        const pathTitles: string[] = []
        const visited = new Set<string>()
        let item: AtlasNode | undefined = node
        let pathComplete = true
        while (item) {
          if (visited.has(item.id)) { pathComplete = false; break }
          visited.add(item.id)
          pathTitles.unshift(item.title)
          if (!item.parentId) break
          const parent = byId.get(item.parentId)
          if (!parent) { pathComplete = false; break }
          item = parent
        }
        results.push({ ...node, workspaceName: workspace.name, pathTitles, pathComplete })
      }
    }
    const archived = await this.readRetainedSessions()
    const hidden = (await this.readJson<string[]>(join(this.root, 'hidden-sessions.json'))) ?? []
    return [...results, ...archived.filter(node => !existing.has(node.id))].map(node => !includeHidden && hidden.includes(node.id) ? { ...node, sessionId: undefined } : node)
  }

  /**
   * 会话页数据：历史来源 + 当前绑定合并，归档状态由调用方传入的 DSH 原生集合决定。
   * @param archivedSessionIds DSH 原生归档集合（事实来源）。
   */
  async listSessions(archivedSessionIds: Set<string>): Promise<SessionRecord[]> {
    const links = await this.listSessionLinks()
    const currentBySession = new Map<string, { nodeId: string; workspaceId: string }>()
    const workspaceNames = new Map<string, string>()
    const nodeTitles = new Map<string, string>()
    for (const workspace of await this.listWorkspaces()) {
      workspaceNames.set(workspace.id, workspace.name)
      const nodes = (await this.readJson<AtlasNode[]>(this.nodesFile(workspace.id))) ?? []
      for (const node of nodes) {
        nodeTitles.set(node.id, node.title)
        if (node.sessionId) currentBySession.set(node.sessionId, { nodeId: node.id, workspaceId: workspace.id })
      }
    }
    const records: SessionRecord[] = []
    const seen = new Set<string>()
    for (const link of links) {
      seen.add(link.sessionId)
      const current = currentBySession.get(link.sessionId)
      records.push({
        sessionId: link.sessionId,
        originNodeId: link.originNodeId,
        originWorkspaceId: link.originWorkspaceId,
        workspaceName: workspaceNames.get(link.originWorkspaceId),
        nodeTitle: link.nodeTitleSnapshot,
        title: link.nodeTitleSnapshot,
        isCurrent: !!current,
        currentNodeId: current?.nodeId,
        archived: archivedSessionIds.has(link.sessionId),
        archivedAt: link.archivedAt,
      })
    }
    // 当前绑定但尚无来源记录（例如绑定写入前旧数据）也列出。
    for (const [sessionId, current] of currentBySession) {
      if (seen.has(sessionId)) continue
      records.push({
        sessionId,
        originNodeId: current.nodeId,
        originWorkspaceId: current.workspaceId,
        workspaceName: workspaceNames.get(current.workspaceId),
        nodeTitle: nodeTitles.get(current.nodeId) ?? current.nodeId,
        title: nodeTitles.get(current.nodeId) ?? current.nodeId,
        isCurrent: true,
        currentNodeId: current.nodeId,
        archived: archivedSessionIds.has(sessionId),
      })
    }
    return records
  }

  async dismissSessions(ids: string[], archive?: (sessionIds: string[]) => Promise<void>): Promise<void> {
    return this.mutate(async () => {
      if (!Array.isArray(ids) || !ids.length || ids.length > 500 || ids.some(id => typeof id !== 'string')) throw new Error('E_BAD_REQUEST: 会话范围无效')
      const records = (await this.deletedNodes(true)).filter(n => n.sessionId)
      const available = new Set(records.map(n => n.id))
      if (ids.some(id => !available.has(id))) throw new Error('E_CONFLICT: 会话列表已变化，请刷新后重试')
      await archive?.(records.filter(n => ids.includes(n.id)).map(n => n.sessionId!))
      const file = join(this.root, 'hidden-sessions.json')
      const hidden = (await this.readJson<string[]>(file)) ?? []
      await this.writeJson(file, [...new Set([...hidden, ...ids])])
    })
  }

  async purgeNode(nodeId: string, batchId: string, cleanup?: (ids: string[]) => Promise<void>): Promise<string[]> {
    return this.purgeNodes([{ id: nodeId, batchId }], cleanup)
  }

  async purgeNodes(targets: Array<{ id: string; batchId: string }>, cleanup?: (ids: string[]) => Promise<void>): Promise<string[]> {
    return this.mutate(async () => {
      if (!Array.isArray(targets) || !targets.length || targets.length > 500) throw new Error('E_BAD_REQUEST: 删除范围无效')
      const plans = new Map<string, { nodes: AtlasNode[]; ids: Set<string> }>()
      for (const { id: nodeId, batchId } of targets) {
      const { workspaceId, nodes, node } = await this.findNode(nodeId, true)
      if (!node.deletedAt || !node.deletionBatchId || node.deletionRootId !== nodeId || node.deletionBatchId !== batchId) throw new Error('E_CONFLICT: 删除批次已变化，请刷新后重试')
      const batch = nodes.filter(n => n.deletionBatchId === batchId)
      const ids = new Set(batch.map(n => n.id))
      const plan = plans.get(workspaceId) ?? { nodes, ids: new Set<string>() }
      for (const id of ids) plan.ids.add(id)
      plans.set(workspaceId, plan)
      }
      for (const { nodes, ids } of plans.values()) {
        if (nodes.some(n => !ids.has(n.id) && n.parentId && ids.has(n.parentId))) throw new Error('E_CONFLICT: 此节点下仍有其他批次的节点，请先恢复或彻底删除它们')
      }
      const ids = new Set([...plans.values()].flatMap(plan => [...plan.ids]))
      await cleanup?.([...ids])
      const file = join(this.root, 'retained-sessions.json')
      const archived = await this.readRetainedSessions()
      const items = (await this.deletedNodes(true)).filter(n => ids.has(n.id) && n.sessionId).map(n => ({ id: n.id, workspaceId: n.workspaceId, workspaceName: n.workspaceName, title: n.title, sessionId: n.sessionId, deletedAt: n.deletedAt, pathTitles: n.pathTitles, pathComplete: n.pathComplete, purgedAt: new Date().toISOString() }))
      await this.writeJson(file, [...archived.filter(n => !ids.has(n.id)), ...items])
      for (const [workspaceId, plan] of plans) {
        await this.writeJson(this.nodesFile(workspaceId), plan.nodes.filter(n => !plan.ids.has(n.id)))
        await this.touch(workspaceId)
      }
      return [...ids]
    })
  }

  async deleteNode(nodeId: string, token: string, beforeDelete?: (nodes: AtlasNode[]) => Promise<void>): Promise<string[]> {
    return this.mutate(async () => {
      const { workspaceId, nodes, node } = await this.findNode(nodeId, true)
      if (node.deletedAt) {
        const batch = nodes.filter(n => n.deletionBatchId === node.deletionBatchId)
        await beforeDelete?.(batch)
        return batch.map(n => n.id)
      }
      if (token !== nodesToken(nodes)) throw new Error('E_CONFLICT: 节点已发生变化，请重新确认删除范围')
      const ids = new Set(descendantsOf(nodeId, nodes))
      const targets = nodes.filter(n => ids.has(n.id) && !n.deletedAt)
      await beforeDelete?.(targets)
      const deletedAt = new Date().toISOString()
      const deletionBatchId = randomUUID()
      const targetIds = new Set(targets.map(n => n.id))
      // 删除节点只进回收站并解除工作区分组；绑定关系与 Session 保留（进入 DSH 未分组），不归档。
      await this.writeJson(this.nodesFile(workspaceId), nodes.map(n => targetIds.has(n.id)
        ? { ...n, deletedAt, deletionBatchId, deletionRootId: nodeId } : n))
      await this.touch(workspaceId)
      return [...targetIds]
    })
  }

  async restoreNode(nodeId: string): Promise<string[]> {
    return this.mutate(async () => {
      const { workspaceId, nodes, node } = await this.findNode(nodeId, true)
      if (!node.deletedAt) return []
      const batch = nodes.filter(n => n.deletionBatchId === node.deletionBatchId)
      const ids = new Set(batch.map(n => n.id))
      if (batch.some(n => n.parentId && !ids.has(n.parentId) && !nodes.some(parent => parent.id === n.parentId && !parent.deletedAt))) {
        throw new Error('E_CONFLICT: 请先恢复父节点所在的删除批次')
      }
      await this.writeJson(this.nodesFile(workspaceId), nodes.map(n => {
        if (!ids.has(n.id)) return n
        const { deletedAt, deletionBatchId, deletionRootId, ...rest } = n
        return rest
      }))
      await this.touch(workspaceId)
      return [...ids]
    })
  }

  // ── 线程与消息 ────────────────────────────────────────────────────────────

  async getThread(threadId: string): Promise<ThreadSnapshot> {
    const { workspaceId, node, thread } = await this.findThread(threadId)
    const [workspace, messages, card, nodes, threads] = await Promise.all([
      this.requireWorkspace(workspaceId),
      this.readMessages(workspaceId, threadId),
      thread.kind === 'main' ? this.readJson<ClosureCard>(this.cardFile(workspaceId, node.id)) : undefined,
      this.readJson<AtlasNode[]>(this.nodesFile(workspaceId)),
      this.readJson<Thread[]>(this.threadsFile(workspaceId)),
    ])
    const subthreads =
      thread.kind === 'main'
        ? await Promise.all(
            (threads ?? [])
              .filter((item) => item.nodeId === node.id && item.kind === 'sub')
              .sort((a, b) => a.order - b.order)
              .map(async (item) => ({
                thread: item,
                messages: await this.readMessages(workspaceId, item.id),
              })),
          )
        : undefined
    return {
      workspace,
      thread,
      messages,
      card: card ?? undefined,
      path: await this.pathBriefs(workspaceId, node, nodes ?? []),
      node,
      subthreads,
    }
  }

  async getNode(nodeId: string, includeDeleted = false): Promise<AtlasNode> {
    return (await this.findNode(nodeId, includeDeleted)).node
  }

  /** 用户显式新建，先持久化新身份；失败重试不复用旧历史。旧会话来源记录保留。 */
  async replaceSession(nodeId: string, expectedSessionId: string): Promise<AtlasNode> {
    return this.mutate(async () => {
      const { workspaceId, nodes, node } = await this.findNode(nodeId)
      if (node.replacedSessionId === expectedSessionId && node.sessionId !== expectedSessionId) return node
      // 节点当前无绑定（归档已清空）且 expectedSessionId 是已知历史来源 → 允许新建。
      const links = await this.listSessionLinks()
      const isKnownHistorical = links.some(l => l.sessionId === expectedSessionId)
      if (!expectedSessionId || (node.sessionId && node.sessionId !== expectedSessionId)) {
        if (!(node.sessionId === undefined && isKnownHistorical)) {
          throw new Error('E_CONFLICT: 会话绑定已变化，请重新打开节点')
        }
      }
      const { sessionArchivedAt, ...retained } = node
      const next = { ...retained, sessionId: `atlas-${node.id}-${shortId()}`, replacedSessionId: expectedSessionId, updatedAt: new Date().toISOString() }
      await this.writeJson(this.nodesFile(workspaceId), nodes.map(n => n.id === nodeId ? next : n))
      await this.touch(workspaceId)
      // 旧会话来源保留为历史来源（若尚未记录）。
      const currentLinks = await this.listSessionLinks()
      const toAdd: NodeSessionLink[] = []
      if (!currentLinks.some(l => l.sessionId === expectedSessionId)) {
        toAdd.push({ sessionId: expectedSessionId, originNodeId: nodeId, originWorkspaceId: workspaceId, nodeTitleSnapshot: node.title, archivedAt: sessionArchivedAt, createdAt: new Date().toISOString() })
      }
      if (!currentLinks.some(l => l.sessionId === next.sessionId)) {
        toAdd.push({ sessionId: next.sessionId, originNodeId: nodeId, originWorkspaceId: workspaceId, nodeTitleSnapshot: node.title, createdAt: new Date().toISOString() })
      }
      if (toAdd.length) await this.writeJson(this.linksFile(), [...currentLinks, ...toAdd])
      return next
    })
  }

  /** 将节点绑定到唯一 Session；普通绑定禁止替换已有身份。 */
  async bindSession(nodeId: string, sessionId: string, runtimeWorkspaceId?: string): Promise<AtlasNode> {
    if (!SAFE_ID.test(sessionId)) throw new Error('E_BAD_REQUEST: Session ID 不合法')
    return this.mutate(async () => {
      const { workspaceId, nodes, node } = await this.findNode(nodeId)
      if (node.sessionId === sessionId && (!runtimeWorkspaceId || node.runtimeWorkspaceId === runtimeWorkspaceId)) return node
      if (node.sessionId && node.sessionId !== sessionId) throw new Error('E_CONFLICT: 节点已经绑定其他 Session')
      for (const workspace of await this.listWorkspaces()) {
        const candidates = workspace.id === workspaceId
          ? nodes
          : JSON.parse(await readFile(this.nodesFile(workspace.id), 'utf8')) as AtlasNode[]
        if (candidates.some((item) => item.id !== nodeId && item.sessionId === sessionId)) {
          throw new Error('E_CONFLICT: Session 已绑定其他节点')
        }
      }
      const next = { ...node, sessionId, ...(runtimeWorkspaceId ? { runtimeWorkspaceId } : {}), updatedAt: new Date().toISOString() }
      await this.writeJson(this.nodesFile(workspaceId), nodes.map((item) => item.id === nodeId ? next : item))
      await this.touch(workspaceId)
      // 记录历史来源（幂等，不覆盖更早来源）。
      const links = await this.listSessionLinks()
      if (!links.some(l => l.sessionId === sessionId)) {
        await this.writeJson(this.linksFile(), [...links, {
          sessionId,
          originNodeId: nodeId,
          originWorkspaceId: workspaceId,
          nodeTitleSnapshot: node.title,
          createdAt: new Date().toISOString(),
        }])
      }
      return next
    })
  }

  /**
   * 归档会话（节点保留）：显式指定 sessionId，把该会话从节点当前绑定腾空，
   * 并在历史来源记录上打归档标记。节点保留，sessionId 字段清空。
   */
  async archiveSession(nodeId: string, sessionId: string): Promise<AtlasNode> {
    if (!SAFE_ID.test(sessionId)) throw new Error('E_BAD_REQUEST: Session ID 不合法')
    return this.mutate(async () => {
      const { workspaceId, nodes, node } = await this.findNode(nodeId, true)
      if (node.sessionId && node.sessionId !== sessionId) throw new Error('E_CONFLICT: 节点当前绑定的是其他会话')
      if (node.sessionId === sessionId) {
        const next: AtlasNode = {
          ...node,
          sessionId: undefined,
          sessionArchivedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }
        await this.writeJson(this.nodesFile(workspaceId), nodes.map((item) => (item.id === nodeId ? next : item)))
        await this.touch(workspaceId)
        await this.markSessionLinkArchivedUnsafe(sessionId, next.sessionArchivedAt!)
        return next
      }
      // 节点当前无绑定，仍记录来源与归档状态。
      await this.markSessionLinkArchivedUnsafe(sessionId, new Date().toISOString())
      return node
    })
  }

  /**
   * 恢复归档会话：显式指定 sessionId 取消归档标记。
   * 仅当来源节点存在、未删除且当前无会话时才自动回绑；否则只恢复历史来源的可用性。
   */
  async unarchiveSession(sessionId: string): Promise<{ nodeId?: string; rebound: boolean }> {
    if (!SAFE_ID.test(sessionId)) throw new Error('E_BAD_REQUEST: Session ID 不合法')
    return this.mutate(async () => {
      await this.clearSessionLinkArchivedUnsafe(sessionId)
      const link = (await this.listSessionLinks()).find(l => l.sessionId === sessionId)
      if (!link) return { rebound: false }
      let found: { workspaceId: string; nodes: AtlasNode[]; node: AtlasNode }
      try { found = await this.findNode(link.originNodeId, true) }
      catch { return { nodeId: link.originNodeId, rebound: false } }
      const { workspaceId, nodes, node } = found
      if (node.deletedAt) return { nodeId: node.id, rebound: false }
      if (node.sessionId && node.sessionId !== sessionId) return { nodeId: node.id, rebound: false }
      if (!node.sessionId) {
        const next: AtlasNode = { ...node, sessionId, sessionArchivedAt: undefined, updatedAt: new Date().toISOString() }
        await this.writeJson(this.nodesFile(workspaceId), nodes.map((item) => (item.id === node.id ? next : item)))
        await this.touch(workspaceId)
        return { nodeId: node.id, rebound: true }
      }
      return { nodeId: node.id, rebound: false }
    })
  }

  async recordVisit(nodeId: string, openedAt: string, durationMs: number): Promise<AtlasNode> {
    return this.mutate(async () => {
      const { workspaceId, nodes, node } = await this.findNode(nodeId)
      const next: AtlasNode = {
        ...node,
        lastOpenedAt: openedAt,
        lastDurationMs: clamp(Math.round(durationMs), 0, 12 * 60 * 60 * 1000),
        openCount: (node.openCount ?? 0) + 1,
        updatedAt: new Date().toISOString(),
      }
      await this.writeJson(this.nodesFile(workspaceId), nodes.map((item) => (item.id === nodeId ? next : item)))
      await this.touch(workspaceId)
      return next
    })
  }

  async listSubthreads(nodeId: string): Promise<Thread[]> {
    const { workspaceId } = await this.findNode(nodeId)
    const threads = (await this.readJson<Thread[]>(this.threadsFile(workspaceId))) ?? []
    return threads.filter((thread) => thread.nodeId === nodeId && thread.kind === 'sub').sort((a, b) => a.order - b.order)
  }

  async createSubthread(nodeId: string, input: CreateSubthreadInput): Promise<Thread> {
    return this.mutate(async () => {
      const { workspaceId, node } = await this.findNode(nodeId)
      const threads = (await this.readJson<Thread[]>(this.threadsFile(workspaceId))) ?? []
      const siblings = threads.filter((thread) => thread.nodeId === nodeId && thread.kind === 'sub')
      const thread: Thread = {
        id: `t_${shortId()}`,
        nodeId,
        parentThreadId: node.threadId,
        anchorMessageId: input.anchorMessageId,
        kind: 'sub',
        title: input.title.trim() || '未命名子聊天',
        order: siblings.length,
        collapsed: false,
        createdAt: new Date().toISOString(),
      }
      await this.writeJson(this.threadsFile(workspaceId), [...threads, thread])
      await this.touch(workspaceId)
      return thread
    })
  }

  async setThreadCollapsed(threadId: string, collapsed: boolean): Promise<Thread> {
    return this.mutate(async () => {
      const { workspaceId, thread } = await this.findThread(threadId)
      const threads = (await this.readJson<Thread[]>(this.threadsFile(workspaceId))) ?? []
      const next = { ...thread, collapsed }
      await this.writeJson(this.threadsFile(workspaceId), threads.map((item) => (item.id === threadId ? next : item)))
      return next
    })
  }

  async appendMessage(threadId: string, role: Role, content: string, quote?: AtlasMessage['quote']): Promise<AtlasMessage> {
    return this.mutate(async () => {
      const { workspaceId } = await this.findThread(threadId)
      const messages = await this.readMessages(workspaceId, threadId)
      if (messages.length >= 2_000) throw new Error('E_BUDGET: 线程消息已达上限')
      const message: AtlasMessage = {
        id: `m_${shortId()}`,
        threadId,
        role,
        content,
        createdAt: new Date().toISOString(),
        quote,
      }
      await this.appendJsonl(this.threadFile(workspaceId, threadId), message)
      return message
    })
  }

  async updateMessage(workspaceId: string, threadId: string, messageId: string, content: string, error = false): Promise<void> {
    return this.mutate(async () => {
      const messages = await this.readMessages(workspaceId, threadId)
      const next = messages.map((message) =>
        message.id === messageId ? { ...message, content, error } : message,
      )
      await this.writeJsonl(this.threadFile(workspaceId, threadId), next)
    })
  }

  async recentMessages(workspaceId: string, threadId: string, limit: number): Promise<AtlasMessage[]> {
    const messages = await this.readMessages(workspaceId, threadId)
    return messages.slice(-limit)
  }

  async pathBriefs(workspaceId: string, node: AtlasNode, nodes: AtlasNode[]): Promise<PathBrief[]> {
    const path: PathBrief[] = []
    let current: AtlasNode | undefined = node
    while (current) {
      const card = await this.readJson<ClosureCard>(this.cardFile(workspaceId, current.id))
      path.unshift({ nodeId: current.id, title: current.title, tldr: card?.tldr })
      current = current.parentId ? nodes.find((item) => item.id === current?.parentId) : undefined
    }
    return path
  }

  // ── 收口卡 ────────────────────────────────────────────────────────────────

  async saveCard(card: ClosureCard): Promise<ClosureCard> {
    return this.mutate(async () => {
      const { workspaceId, node } = await this.findNode(card.nodeId)
      await this.writeJson(this.cardFile(workspaceId, node.id), card)
      const nodes = (await this.readJson<AtlasNode[]>(this.nodesFile(workspaceId))) ?? []
      const next: AtlasNode = {
        ...node,
        status: 'closed',
        mastery: clamp(Math.round(card.mastery), 0, 5),
        closedAt: card.generatedAt,
        updatedAt: card.generatedAt,
      }
      await this.writeJson(this.nodesFile(workspaceId), nodes.map((item) => (item.id === node.id ? next : item)))
      await this.touch(workspaceId)
      return card
    })
  }

  async getCard(nodeId: string): Promise<ClosureCard | undefined> {
    const { workspaceId } = await this.findNode(nodeId)
    return (await this.readJson<ClosureCard>(this.cardFile(workspaceId, nodeId))) ?? undefined
  }

  // ── 搜索 ──────────────────────────────────────────────────────────────────

  async search(workspaceId: string, query: string): Promise<Array<{ kind: 'node' | 'message' | 'card'; id: string; nodeId: string; title: string; excerpt: string }>> {
    const needle = query.trim().toLocaleLowerCase()
    if (!needle) return []
    const snapshot = await this.snapshot(workspaceId)
    const threads = (await this.readJson<Thread[]>(this.threadsFile(workspaceId))) ?? []
    const results: Array<{ kind: 'node' | 'message' | 'card'; id: string; nodeId: string; title: string; excerpt: string }> = []

    for (const node of snapshot.nodes) {
      if (match(node.title, needle) || match(node.subtitle ?? '', needle)) {
        results.push({ kind: 'node', id: node.id, nodeId: node.id, title: node.title, excerpt: node.subtitle ?? '' })
      }
      const card = await this.readJson<ClosureCard>(this.cardFile(workspaceId, node.id))
      if (card && [card.tldr, ...card.points, ...card.openQuestions].some((text) => match(text, needle))) {
        results.push({ kind: 'card', id: card.id, nodeId: node.id, title: node.title, excerpt: card.tldr })
      }
      for (const thread of threads.filter((item) => item.nodeId === node.id)) {
        const messages = await this.readMessages(workspaceId, thread.id)
        for (const message of messages) {
          if (match(message.content, needle)) {
            results.push({
              kind: 'message',
              id: message.id,
              nodeId: node.id,
              title: node.title,
              excerpt: excerptAround(message.content, needle),
            })
            if (results.length >= 40) return results
          }
        }
      }
    }
    return results.slice(0, 40)
  }

  // ── 内部：读取与写入 ──────────────────────────────────────────────────────

  private async findNode(nodeId: string, includeDeleted = false): Promise<{ workspaceId: string; nodes: AtlasNode[]; node: AtlasNode }> {
    for (const workspace of await this.listWorkspaces()) {
      const nodes = (await this.readJson<AtlasNode[]>(this.nodesFile(workspace.id))) ?? []
      const node = nodes.find((item) => item.id === nodeId)
      if (node && (includeDeleted || !node.deletedAt)) return { workspaceId: workspace.id, nodes, node }
    }
    throw new Error('E_NOT_FOUND: 节点不存在')
  }

  private async findThread(threadId: string): Promise<{ workspaceId: string; thread: Thread; node: AtlasNode }> {
    for (const workspace of await this.listWorkspaces()) {
      const threads = (await this.readJson<Thread[]>(this.threadsFile(workspace.id))) ?? []
      const thread = threads.find((item) => item.id === threadId)
      if (!thread) continue
      const nodes = (await this.readJson<AtlasNode[]>(this.nodesFile(workspace.id))) ?? []
      const node = nodes.find((item) => item.id === thread.nodeId)
      if (node && !node.deletedAt) return { workspaceId: workspace.id, thread, node }
    }
    throw new Error('E_NOT_FOUND: 线程不存在')
  }

  private async requireWorkspace(workspaceId: string): Promise<Workspace> {
    if (!SAFE_ID.test(workspaceId)) throw new Error('E_BAD_REQUEST: 非法工作区 id')
    const workspace = await this.readJson<Workspace>(this.workspaceFile(workspaceId))
    if (!workspace) throw new Error('E_NOT_FOUND: 工作区不存在')
    return workspace
  }

  private async touch(workspaceId: string): Promise<void> {
    const workspace = await this.requireWorkspace(workspaceId)
    await this.writeJson(this.workspaceFile(workspaceId), {
      ...workspace,
      rev: workspace.rev + 1,
      updatedAt: new Date().toISOString(),
    })
  }

  private async readMessages(workspaceId: string, threadId: string): Promise<AtlasMessage[]> {
    const text = await readFile(this.threadFile(workspaceId, threadId), 'utf8').catch(() => '')
    const messages: AtlasMessage[] = []
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try {
        messages.push(JSON.parse(line) as AtlasMessage)
      } catch {
        // 崩溃留下的半行不阻塞读取。
      }
    }
    return messages
  }

  private async readJson<T>(file: string): Promise<T | undefined> {
    try {
      return JSON.parse(await readFile(file, 'utf8')) as T
    } catch {
      return undefined
    }
  }

  private async readRetainedSessions(): Promise<LibraryItem[]> {
    let text: string
    try { text = await readFile(join(this.root, 'retained-sessions.json'), 'utf8') }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
    const records: unknown = JSON.parse(text)
    if (!Array.isArray(records)) throw new Error('E_INTERNAL: 会话归档格式无效')
    return records as LibraryItem[]
  }

  // ── 历史会话来源记录 ────────────────────────────────────────────────────
  // 独立于节点当前绑定，按 Session ID 保存，不被新建会话覆盖。

  private linksFile(): string {
    return join(this.root, 'session-links.json')
  }

  async listSessionLinks(): Promise<NodeSessionLink[]> {
    return (await this.readJson<NodeSessionLink[]>(this.linksFile())) ?? []
  }

  /** 记录一条历史来源（幂等：同一 sessionId 不重复，保留最早来源）。非 mutate，需在 writeQueue 内调用。 */
  private async recordSessionLinkUnsafe(link: NodeSessionLink): Promise<void> {
    const links = await this.listSessionLinks()
    if (links.some(item => item.sessionId === link.sessionId)) return
    await this.writeJson(this.linksFile(), [...links, link])
  }

  /** 标记某会话已被归档（展示用时间戳，原生归档状态仍以 DSH 为准）。非 mutate。 */
  private async markSessionLinkArchivedUnsafe(sessionId: string, archivedAt: string): Promise<void> {
    const links = await this.listSessionLinks()
    if (!links.some(item => item.sessionId === sessionId)) return
    await this.writeJson(this.linksFile(), links.map(item => item.sessionId === sessionId ? { ...item, archivedAt } : item))
  }

  private async clearSessionLinkArchivedUnsafe(sessionId: string): Promise<void> {
    const links = await this.listSessionLinks()
    await this.writeJson(this.linksFile(), links.map(item => item.sessionId === sessionId ? { ...item, archivedAt: undefined } : item))
  }

  /**
   * 从现有明确身份生成来源记录（幂等）：当前 sessionId、replacedSessionId、
   * 以及 retained-sessions.json 中的 sessionId。不凭相同 cwd 猜测归属。
   */
  async migrateSessionLinks(): Promise<number> {
    return this.mutate(async () => {
      const existing = new Set((await this.listSessionLinks()).map(l => l.sessionId))
      const links: NodeSessionLink[] = []
      const now = new Date().toISOString()
      for (const workspace of await this.listWorkspaces()) {
        const nodes = (await this.readJson<AtlasNode[]>(this.nodesFile(workspace.id))) ?? []
        for (const node of nodes) {
          for (const sessionId of [node.sessionId, node.replacedSessionId]) {
            if (!sessionId || existing.has(sessionId)) continue
            existing.add(sessionId)
            links.push({
              sessionId,
              originNodeId: node.id,
              originWorkspaceId: workspace.id,
              nodeTitleSnapshot: node.title,
              archivedAt: node.sessionArchivedAt,
              createdAt: now,
            })
          }
        }
      }
      for (const retained of await this.readRetainedSessions()) {
        if (!retained.sessionId || existing.has(retained.sessionId)) continue
        existing.add(retained.sessionId)
        links.push({
          sessionId: retained.sessionId,
          originNodeId: retained.id,
          originWorkspaceId: retained.workspaceId,
          nodeTitleSnapshot: retained.title,
          createdAt: now,
        })
      }
      if (links.length) await this.writeJson(this.linksFile(), [...(await this.listSessionLinks()), ...links])
      return links.length
    })
  }

  /** 供会话页等只读路径标记归档时间（独立 mutate，避免嵌套死锁）。 */
  async markSessionLinkArchived(sessionId: string, archivedAt: string): Promise<void> {
    return this.mutate(() => this.markSessionLinkArchivedUnsafe(sessionId, archivedAt))
  }

  private async writeJson(file: string, value: Json | unknown[] | unknown): Promise<void> {
    await this.writeAtomic(file, `${JSON.stringify(value, null, 2)}\n`)
  }

  private async writeJsonl(file: string, rows: unknown[]): Promise<void> {
    await this.writeAtomic(file, rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''))
  }

  private async appendJsonl(file: string, row: unknown): Promise<void> {
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, `${JSON.stringify(row)}\n`, { flag: 'a', encoding: 'utf8' })
  }

  private async writeAtomic(file: string, data: string): Promise<void> {
    await mkdir(dirname(file), { recursive: true })
    const tmp = `${file}.${randomUUID()}.tmp`
    await writeFile(tmp, data, 'utf8')
    try {
      await rename(tmp, file)
    } catch (error) {
      // Windows 上目标被占用时，rename 可能失败；退化为先删后改名。
      await rm(file, { force: true })
      await rename(tmp, file).catch(async (retryError) => {
        await rm(tmp, { force: true })
        throw retryError ?? error
      })
    }
  }

  private mutate<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.writeQueue.then(fn, fn)
    this.writeQueue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  private workspacesRoot(): string {
    return join(this.root, 'workspaces')
  }

  private workspaceDir(workspaceId: string): string {
    return join(this.workspacesRoot(), workspaceId)
  }

  private workspaceFile(workspaceId: string): string {
    return join(this.workspaceDir(workspaceId), 'workspace.json')
  }

  private nodesFile(workspaceId: string): string {
    return join(this.workspaceDir(workspaceId), 'nodes.json')
  }

  private threadsFile(workspaceId: string): string {
    return join(this.workspaceDir(workspaceId), 'threads.json')
  }

  private viewportFile(workspaceId: string): string {
    return join(this.workspaceDir(workspaceId), 'viewport.json')
  }

  private threadFile(workspaceId: string, threadId: string): string {
    return join(this.workspaceDir(workspaceId), 'threads', `${threadId}.jsonl`)
  }

  private cardFile(workspaceId: string, nodeId: string): string {
    return join(this.workspaceDir(workspaceId), 'cards', `${nodeId}.json`)
  }
}

// ── 纯函数 ──────────────────────────────────────────────────────────────────

function shortId(): string {
  return randomUUID().replaceAll('-', '').slice(0, 12)
}

function finite(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function defaultPosition(parent: AtlasNode | undefined, siblingIndex: number): { x: number; y: number } {
  if (parent) {
    return {
      x: parent.position.x + NODE_W + 96,
      y: parent.position.y + siblingIndex * (NODE_H + 34),
    }
  }
  return { x: 80, y: 80 + siblingIndex * (NODE_H + 34) }
}

function descendantsOf(rootId: string, nodes: AtlasNode[]): string[] {
  const doomed = [rootId]
  for (let index = 0; index < doomed.length; index++) {
    const parentId = doomed[index]
    for (const node of nodes) {
      if (node.parentId === parentId && !doomed.includes(node.id)) doomed.push(node.id)
    }
  }
  return doomed
}

function match(text: string, needle: string): boolean {
  return text.toLocaleLowerCase().includes(needle)
}

function excerptAround(text: string, needle: string, radius = 48): string {
  const lower = text.toLocaleLowerCase()
  const at = lower.indexOf(needle)
  if (at < 0) return text.slice(0, radius * 2)
  const start = Math.max(0, at - radius)
  const end = Math.min(text.length, at + needle.length + radius)
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`
}

function nodesToken(nodes: AtlasNode[]): string {
  return createHash('sha256').update(JSON.stringify(nodes)).digest('hex')
}
