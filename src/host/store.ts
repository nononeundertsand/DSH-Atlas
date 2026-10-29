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
import { randomUUID } from 'node:crypto'
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
      nodes: nodes ?? [],
      threads: (threads ?? []).filter((thread) => thread.kind === 'main'),
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
      await this.writeJson(this.nodesFile(input.workspaceId), [...snapshot.nodes, node])
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
        ...patch,
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

  async deleteNode(nodeId: string): Promise<string[]> {
    return this.mutate(async () => {
      const { workspaceId, nodes } = await this.findNode(nodeId)
      const doomed = descendantsOf(nodeId, nodes)
      const doomedSet = new Set(doomed)
      const threads = (await this.readJson<Thread[]>(this.threadsFile(workspaceId))) ?? []
      const doomedThreads = threads.filter((thread) => doomedSet.has(thread.nodeId))

      await this.writeJson(this.nodesFile(workspaceId), nodes.filter((node) => !doomedSet.has(node.id)))
      await this.writeJson(this.threadsFile(workspaceId), threads.filter((thread) => !doomedSet.has(thread.nodeId)))
      await Promise.all(
        doomedThreads.map(async (thread) => {
          await rm(this.threadFile(workspaceId, thread.id), { force: true })
        }),
      )
      await Promise.all(doomed.map((id) => rm(this.cardFile(workspaceId, id), { force: true })))
      await this.touch(workspaceId)
      return doomed
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

  async getNode(nodeId: string): Promise<AtlasNode> {
    return (await this.findNode(nodeId)).node
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

  private async findNode(nodeId: string): Promise<{ workspaceId: string; nodes: AtlasNode[]; node: AtlasNode }> {
    for (const workspace of await this.listWorkspaces()) {
      const nodes = (await this.readJson<AtlasNode[]>(this.nodesFile(workspace.id))) ?? []
      const node = nodes.find((item) => item.id === nodeId)
      if (node) return { workspaceId: workspace.id, nodes, node }
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
      if (node) return { workspaceId: workspace.id, thread, node }
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
