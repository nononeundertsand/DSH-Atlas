/**
 * 浏览器端的唯一网络出口。
 * 所有请求都走同源 /ext/atlas，不额外引入 RPC 框架。
 */
import { ROUTES } from '../shared/protocol.js'
import type {
  ApiError,
  AtlasNode,
  ClosureCard,
  CreateNodeInput,
  CreateSubthreadInput,
  ExplainResult,
  MessageQuote,
  SearchHit,
  Thread,
  ThreadSnapshot,
  TurnInput,
  UpdateInfo,
  UpdateNodeInput,
  Viewport,
  VisitInput,
  Workspace,
  WorkspaceSnapshot,
} from '../shared/types.js'

export interface BootstrapPayload {
  workspaces: Workspace[]
  snapshot: WorkspaceSnapshot
  dataDir: string
}

export interface TurnHandlers {
  onMeta?: (info: { threadId: string; messageId: string; model: string }) => void
  onDelta?: (text: string) => void
  onDone?: (info: { messageId: string; usage?: { input: number; output: number } }) => void
  onError?: (error: ApiError) => void
}

export class ApiErr extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  })
  const text = await response.text()
  let body: unknown
  try {
    body = text ? JSON.parse(text) : undefined
  } catch {
    body = undefined
  }
  if (!response.ok) {
    const error = (body as { error?: ApiError } | undefined)?.error
    throw new ApiErr(
      error?.code ?? 'E_INTERNAL',
      error?.message ?? text.slice(0, 240) ?? `请求失败（${response.status}）`,
    )
  }
  return body as T
}

export const api = {
  bootstrap: () => request<BootstrapPayload>(ROUTES.bootstrap),

  checkUpdate: () => request<UpdateInfo>(ROUTES.update),

  createWorkspace: (name: string, goal?: string) =>
    request<{ workspace: Workspace; snapshot: WorkspaceSnapshot; workspaces: Workspace[] }>(ROUTES.workspaces, {
      method: 'POST',
      body: JSON.stringify({ name, goal }),
    }),

  activateWorkspace: (workspaceId: string) =>
    request<{ snapshot: WorkspaceSnapshot; workspaces: Workspace[] }>(ROUTES.workspace(workspaceId), {
      method: 'PATCH',
      body: JSON.stringify({ active: true }),
    }),

  updateViewport: (workspaceId: string, viewport: Viewport) =>
    request<{ viewport: Viewport }>(ROUTES.viewport(workspaceId), {
      method: 'PATCH',
      body: JSON.stringify({ viewport }),
    }),

  createNode: (input: CreateNodeInput) =>
    request<{ node: AtlasNode; thread: Thread }>(ROUTES.nodes, {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  updateNode: (nodeId: string, patch: UpdateNodeInput) =>
    request<{ node: AtlasNode }>(ROUTES.node(nodeId), {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),

  deleteNode: (nodeId: string) =>
    request<{ deleted: string[] }>(ROUTES.node(nodeId), { method: 'DELETE' }),

  closeNode: (nodeId: string, threadId?: string) =>
    request<{ card: ClosureCard; node: AtlasNode }>(ROUTES.closeNode(nodeId), {
      method: 'POST',
      body: JSON.stringify({ threadId }),
    }),

  recordVisit: (nodeId: string, input: VisitInput, keepalive = false) =>
    request<{ node: AtlasNode }>(ROUTES.visitNode(nodeId), {
      method: 'POST',
      body: JSON.stringify(input),
      keepalive,
    }),

  explain: (threadId: string, text: string, signal?: AbortSignal) =>
    request<ExplainResult>(ROUTES.explain(threadId), {
      method: 'POST',
      body: JSON.stringify({ text }),
      signal,
    }),

  getThread: (threadId: string) =>
    request<{ snapshot: ThreadSnapshot }>(ROUTES.thread(threadId)),

  createSubthread: (input: CreateSubthreadInput & { nodeId: string }) =>
    request<{ thread: Thread }>(ROUTES.threads, {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  setThreadCollapsed: (threadId: string, collapsed: boolean) =>
    request<{ thread: Thread }>(ROUTES.thread(threadId), {
      method: 'PATCH',
      body: JSON.stringify({ collapsed }),
    }),

  promote: (threadId: string, title?: string) =>
    request<{ node: AtlasNode }>(ROUTES.promote(threadId), {
      method: 'POST',
      body: JSON.stringify({ threadId, title }),
    }),

  search: (q: string, workspaceId: string) =>
    request<{ hits: SearchHit[] }>(
      `${ROUTES.search}?q=${encodeURIComponent(q)}&workspaceId=${encodeURIComponent(workspaceId)}`,
    ),
}

/** 读取 SSE 一轮对话；返回时流已结束。 */
export async function streamTurn(
  threadId: string,
  input: TurnInput,
  handlers: TurnHandlers,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch(ROUTES.turn(threadId), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
    signal,
  })
  if (!response.ok || !response.body) {
    const text = await response.text().catch(() => '')
    let error: ApiError = { code: 'E_INTERNAL', message: `连接失败（${response.status}）` }
    try {
      error = (JSON.parse(text) as { error: ApiError }).error
    } catch {
      // 保留通用错误。
    }
    handlers.onError?.(error)
    return
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  const consume = (frame: string) => {
    let name = ''
    const data: string[] = []
    for (const line of frame.split('\n')) {
      if (line.startsWith('event:')) name = line.slice(6).trim()
      else if (line.startsWith('data:')) data.push(line.slice(5).trim())
    }
    if (!name || data.length === 0) return
    const payload = JSON.parse(data.join('\n')) as Record<string, unknown>
    if (name === 'meta') handlers.onMeta?.(payload as never)
    else if (name === 'delta') handlers.onDelta?.(String(payload['text'] ?? ''))
    else if (name === 'done') handlers.onDone?.(payload as never)
    else if (name === 'error') handlers.onError?.(payload as never)
  }

  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true }).replaceAll('\r\n', '\n')
    let index = buffer.indexOf('\n\n')
    while (index >= 0) {
      consume(buffer.slice(0, index))
      buffer = buffer.slice(index + 2)
      index = buffer.indexOf('\n\n')
    }
  }
  if (buffer.trim()) consume(buffer)
}

export type { MessageQuote }
