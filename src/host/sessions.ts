import { mkdir, realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { HostContext } from '../shared/dsh.js'
import type { AtlasNode } from '../shared/types.js'
import type { AtlasStore } from './store.js'
import { sessionChecker } from './dsh-compat.js'
import type { SessionChecker } from './dsh-compat.js'

/** 使用原生 controller 保留普通 Session 的 preset 和恢复语义。 */
export class NodeSessions {
  private readonly pending = new Map<string, Promise<AtlasNode>>()
  private reconciliation?: Promise<void>
  isOpening(nodeId: string): boolean { return this.pending.has(nodeId) }
  get archivedSessionIds(): string[] { return this.workspaces?.archivedSessionIds ?? [] }

  async sessionState(nodeId: string): Promise<{ node: AtlasNode; archivedSessionId?: string }> {
    const node = await this.store.getNode(nodeId)
    if (node.sessionId) return { node, archivedSessionId: node.sessionArchivedAt || this.archivedSessionIds.includes(node.sessionId) ? node.sessionId : undefined }
    const links = (await this.store.listSessionLinks()).filter(link => link.originNodeId === nodeId)
    const sources = new Set(links.map(link => link.sessionId))
    // 空白 Session 可能未落盘；仍保留用户已归档且清空绑定的意图，不复用旧身份。
    const archivedSessionId = [...this.archivedSessionIds].reverse().find(id => sources.has(id))
      ?? (node.sessionArchivedAt ? [...links].reverse().find(link => link.archivedAt)?.sessionId : undefined)
    return { node, archivedSessionId }
  }

  async archiveSessions(sessionIds: string[], isRunning?: (id: string) => boolean): Promise<void> {
    if (!sessionIds.length) return
    if (!this.workspaces?.archiveSession) throw new Error('E_UNSUPPORTED: 当前 DSH 不支持归档会话')
    if (sessionIds.some(id => isRunning?.(id))) throw new Error('E_CONFLICT: 会话仍在运行，请先停止后再删除')
    for (const id of new Set(sessionIds)) {
      try { await this.workspaces.archiveSession(id) }
      catch (error) {
        if (!(error instanceof Error) || error.constructor.name !== 'WorkspaceUnknownSessionError') throw error
        // 空白 Session 重启后可能从未留下日志，此时已无会话可归档。
      }
    }
  }

  async deleteNode(nodeId: string, token: string, isRunning?: (id: string) => boolean): Promise<string[]> {
    return this.store.deleteNode(nodeId, token, async nodes => {
      if (nodes.some(n => this.isOpening(n.id))) throw new Error('E_CONFLICT: 会话正在打开，请稍后重试')
      // 删除节点不归档会话：移除对应工作区分组，Session 进入 DSH 未分组，仍可独立使用。
      if (!this.workspaces?.list || !this.workspaces.delete) return
      const ids = nodes.filter(n => n.runtimeWorkspaceId).map(n => n.id)
      if (ids.length) await this.removeWorkspaces(ids, isRunning)
    })
  }

  constructor(
    private readonly store: AtlasStore,
    private readonly controller: HostContext['sessionController'],
    private readonly workspaces: HostContext['workspaceRegistry'],
    private readonly sessionQuery?: HostContext['sessionQuery'],
  ) {}

  reconcileWorkspaces(): Promise<void> {
    if (!this.workspaces?.list || !this.controller) return Promise.resolve()
    if (this.reconciliation) return this.reconciliation
    this.reconciliation = this.reconcile().finally(() => { this.reconciliation = undefined })
    return this.reconciliation
  }

  /**
   * 核对 DSH 分组与 Atlas 逻辑树，但不因此删除任何节点。
   * 分组缺失仅作为显示状态或显式修复依据，不反向推断节点应进回收站。
   * 删除 Atlas 节点是唯一的逻辑树删除入口。
   */
  private async reconcile(): Promise<void> {
    // 本轮移除「分组缺失 → 删除节点」的反向推断。
    // 分组状态由读取快照时按需展示，此处不再写节点。
  }

  /** 能力检查只影响节点打开，不在插件加载时执行，避免能力缺失拖垮整个插件。 */
  private checker(): SessionChecker {
    return sessionChecker({ sessionQuery: this.sessionQuery, sessionController: this.controller })
  }

  open(nodeId: string): Promise<AtlasNode> {
    const existing = this.pending.get(nodeId)
    if (existing) return existing
    const task = (async () => this.createOrOpen(nodeId, this.checker()))().finally(() => this.pending.delete(nodeId))
    this.pending.set(nodeId, task)
    return task
  }

  startNew(nodeId: string, expectedSessionId: string): Promise<AtlasNode> {
    if (this.isOpening(nodeId)) return Promise.reject(new Error('E_CONFLICT: 会话正在打开，请稍后重试'))
    const task = (async () => {
      const check = this.checker() // 先于 replaceSession 的绑定变更
      const current = await this.store.getNode(nodeId)
      const archivedSource = !current.sessionId && current.sessionArchivedAt && (await this.store.listSessionLinks()).some(link => link.sessionId === expectedSessionId && link.originNodeId === nodeId)
      if (!this.archivedSessionIds.includes(expectedSessionId) && !(current.sessionId === expectedSessionId && current.sessionArchivedAt) && !archivedSource && current.replacedSessionId !== expectedSessionId) throw new Error('E_CONFLICT: 原会话尚未归档，不能替换')
      await this.store.replaceSession(nodeId, expectedSessionId)
      return this.createOrOpen(nodeId, check)
    })().finally(() => this.pending.delete(nodeId))
    this.pending.set(nodeId, task)
    return task
  }

  async restoreWorkspace(nodeId: string): Promise<void> {
    const node = await this.store.getNode(nodeId)
    if (!node.sessionId) return
    if (!this.workspaces) throw new Error('E_UNSUPPORTED: DSH 工作区服务不可用')
    const path = join(this.store.location, 'session-workspaces', node.id)
    await mkdir(path, { recursive: true })
    const workspace = await this.workspaces.create(path, node.title)
    await this.store.bindSession(node.id, node.sessionId, workspace.id)
  }

  /**
   * 移除节点专属的工作区分组。Session 与 cwd 目录均保留，会话进入 DSH 未分组，
   * 仍可独立使用；这是「删除节点」与「彻底删除节点」的公共前置动作，不归档会话。
   */
  async removeWorkspaces(nodeIds: string[], isRunning?: (sessionId: string) => boolean): Promise<void> {
    if (!this.workspaces?.list || !this.workspaces.delete) throw new Error('E_UNSUPPORTED: 当前 DSH 不支持删除工作区分组')
    if (nodeIds.some(id => !/^n_[A-Za-z0-9_-]+$/.test(id))) throw new Error('E_BAD_REQUEST: 节点 ID 无效')
    const canonical = async (path: string) => realpath(path).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return resolve(path); throw error })
    const root = await realpath(this.store.location)
    const base = join(root, 'session-workspaces')
    if (await canonical(base) !== base) throw new Error('E_CONFLICT: 节点目录根路径是符号链接，拒绝删除')
    const paths = new Set(nodeIds.map(id => join(base, id)))
    const targets = []
    for (const workspace of this.workspaces.list()) {
      if (paths.has(await canonical(workspace.path))) targets.push(workspace)
    }
    const nodes = await Promise.all(nodeIds.map(id => this.store.getNode(id, true)))
    if (nodeIds.some(id => this.isOpening(id)) || nodes.some(n => n.sessionId && isRunning?.(n.sessionId)) || targets.some(w => w.sessionIds.some(id => isRunning?.(id)))) throw new Error('E_CONFLICT: 工作区中仍有正在运行的会话，请先停止')
    for (const workspace of targets) await this.workspaces.delete(workspace.id)
    // 方案 A：保留 session-workspaces/<nodeId> 目录（Session 的 cwd），Session 仍可独立使用。
  }

  /**
   * 归档会话（节点保留）：显式指定 sessionId，调用 DSH 原生归档，
   * 成功后清空节点当前绑定并保留历史来源记录。失败不误报成功。
   */
  async archiveSession(nodeId: string, sessionId: string, isRunning?: (id: string) => boolean): Promise<AtlasNode> {
    const node = await this.store.getNode(nodeId, true)
    if (node.sessionId && node.sessionId !== sessionId) throw new Error('E_CONFLICT: 节点当前绑定的是其他会话')
    if (isRunning?.(sessionId)) throw new Error('E_CONFLICT: 会话仍在运行，请先停止后再归档')
    if (this.isOpening(nodeId)) throw new Error('E_CONFLICT: 会话正在打开，请稍后重试')
    await this.archiveSessions([sessionId], isRunning)
    return this.store.archiveSession(nodeId, sessionId)
  }

  async archiveStoredSession(sessionId: string, isRunning?: (id: string) => boolean): Promise<void> {
    const record = (await this.store.listSessions(new Set(this.archivedSessionIds))).find(item => item.sessionId === sessionId)
    if (!record) throw new Error('E_NOT_FOUND: 会话来源记录不存在')
    if (record.currentNodeId) {
      await this.archiveSession(record.currentNodeId, sessionId, isRunning)
      return
    }
    await this.archiveSessions([sessionId], isRunning)
    await this.store.markSessionLinkArchived(sessionId, new Date().toISOString())
  }

  /**
   * 恢复归档会话：显式指定 sessionId，先取消 DSH 原生归档，
   * 再按来源节点当前状态决定是否回绑（节点存在、未删除且当前无会话才回绑）。
   * 分组恢复失败如实抛出，不吞错误报成功。
   */
  async unarchiveSession(sessionId: string, isRunning?: (id: string) => boolean): Promise<{ nodeId?: string; rebound: boolean }> {
    if (isRunning?.(sessionId)) throw new Error('E_CONFLICT: 会话仍在运行，请先停止')
    if (!this.workspaces?.unarchiveSession) throw new Error('E_UNSUPPORTED: 当前 DSH 不支持恢复归档会话')
    await this.workspaces.unarchiveSession(sessionId)
    const result = await this.store.unarchiveSession(sessionId)
    if (result.rebound && result.nodeId) await this.restoreWorkspace(result.nodeId)
    return result
  }

  private async createOrOpen(nodeId: string, check: SessionChecker): Promise<AtlasNode> {
    const { node, archivedSessionId } = await this.sessionState(nodeId)
    if (!this.controller || !this.workspaces) throw new Error('E_UNSUPPORTED: DSH Session 服务不可用')
    if (archivedSessionId) throw new Error('E_SESSION_ARCHIVED: 当前没有可用会话，请恢复归档会话或创建新会话')
    // 真实查询在任何副作用之前完成：其他错误原样上抛，不得误判为不存在、覆盖绑定或换 Session ID。
    const exists = node.sessionId ? (await check(node.sessionId)) === 'exists' : false
    await mkdir(join(this.store.location, 'session-workspaces', node.id), { recursive: true })
    const workspace = await this.workspaces.create(join(this.store.location, 'session-workspaces', node.id), node.title)
    if (exists && node.sessionId) {
      await workspace.attachSession(node.sessionId)
      return this.store.bindSession(node.id, node.sessionId, workspace.id)
    }
    // 只有明确的「会话不存在」才到这里：空白 Session 沿用原确定身份重建。
    // 固定 ID 允许创建成功、绑定写入失败后重试空白 Session。
    const sessionId = node.sessionId ?? `atlas-${node.id}`
    const result = await this.controller.create({
      sessionId,
      workspaceId: workspace.id,
    })
    if (result.sessionId !== sessionId) {
      throw new Error('E_CONFLICT: 原 Session 已被使用，拒绝自动替换；请检查 Session 绑定')
    }
    return this.store.bindSession(node.id, sessionId, workspace.id)
  }
}
