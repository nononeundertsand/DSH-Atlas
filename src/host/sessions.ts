import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { HostContext } from '../shared/dsh.js'
import type { AtlasNode } from '../shared/types.js'
import type { AtlasStore } from './store.js'

/** 使用原生 controller 保留普通 Session 的 preset 和恢复语义。 */
export class NodeSessions {
  private readonly pending = new Map<string, Promise<AtlasNode>>()

  constructor(private readonly store: AtlasStore, private readonly controller: HostContext['sessionController'], private readonly workspaces: HostContext['workspaceRegistry']) {}

  open(nodeId: string): Promise<AtlasNode> {
    const existing = this.pending.get(nodeId)
    if (existing) return existing
    const task = this.createOrOpen(nodeId).finally(() => this.pending.delete(nodeId))
    this.pending.set(nodeId, task)
    return task
  }

  private async createOrOpen(nodeId: string): Promise<AtlasNode> {
    const node = await this.store.getNode(nodeId)
    if (!this.controller || !this.workspaces) throw new Error('E_UNSUPPORTED: DSH Session 服务不可用')
    await mkdir(join(this.store.location, 'session-workspaces', node.id), { recursive: true })
    const workspace = await this.workspaces.create(join(this.store.location, 'session-workspaces', node.id), node.title)
    if (node.sessionId) {
      try {
        await this.controller.inspect(node.sessionId)
        await workspace.attachSession(node.sessionId)
        return node
      } catch (error) {
        if (!(error instanceof Error) || error.constructor.name !== 'ApiSessionNotFound') throw error
        // 空白 Session 可能尚未形成持久日志；只重建同一确定身份。
      }
    }
    // 固定 ID 允许创建成功、绑定写入失败后重试空白 Session。
    const sessionId = `atlas-${node.id}`
    const result = await this.controller.create({
      sessionId,
      workspaceId: workspace.id,
    })
    if (result.sessionId !== sessionId) {
      throw new Error('E_CONFLICT: 原 Session 已被使用，拒绝自动替换；请检查 Session 绑定')
    }
    return this.store.bindSession(node.id, sessionId)
  }
}
