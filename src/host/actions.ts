/**
 * 跨存储的动作：提升为节点。
 * 收口本身在 closure.ts，这里只处理“把子聊天变成地图上的节点”。
 */
import type { AtlasStore } from './store.js'
import type { AtlasNode, Point } from '../shared/types.js'

export interface PromoteOptions {
  title?: string
  position?: Point
}

export async function promoteSubthread(
  store: AtlasStore,
  threadId: string,
  options: PromoteOptions = {},
): Promise<AtlasNode> {
  const snapshot = await store.getThread(threadId)
  if (snapshot.thread.kind !== 'sub') throw new Error('E_BAD_REQUEST: 只有子聊天可以提升为节点')

  const title =
    options.title?.trim() ||
    snapshot.thread.title ||
    firstLine(snapshot.messages.find((message) => message.role === 'user')?.content ?? '') ||
    '新的子节点'

  const parent = snapshot.node
  const { node } = await store.createNode({
    workspaceId: parent.workspaceId,
    parentId: parent.id,
    title,
    subtitle: `从「${parent.title}」提升`,
    position: options.position,
  })

  for (const message of snapshot.messages) {
    if (message.role === 'system') continue
    await store.appendMessage(node.threadId, message.role, message.content, message.quote)
  }

  const promoted =
    snapshot.messages.length > 0 ? await store.updateNode(node.id, { status: 'active' }) : node
  await store.setThreadCollapsed(threadId, true)
  return promoted
}

function firstLine(text: string): string {
  return text.split('\n').find((line) => line.trim())?.trim().slice(0, 60) ?? ''
}
