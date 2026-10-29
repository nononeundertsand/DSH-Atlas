/**
 * /ext/atlas/* 的 HTTP 路由。
 *
 * 这里只做三件事：解析请求、调用领域函数、编码响应/SSE。
 * 业务状态全部在 store / context / closure / actions 中。
 */
import type { IncomingHttpHeaders } from 'node:http'
import type { AtlasStore } from './store.js'
import type { AtlasModel } from './model.js'
import { buildChatContext } from './context.js'
import { generateClosure } from './closure.js'
import { promoteSubthread } from './actions.js'
import type {
  ApiError,
  AtlasErrorCode,
  AtlasEvent,
  CloseInput,
  CreateNodeInput,
  CreateSubthreadInput,
  CreateWorkspaceInput,
  PromoteInput,
  TurnInput,
  UpdateInfo,
  UpdateNodeInput,
  Viewport,
} from '../shared/types.js'
import { ATLAS_BASE, LIMITS } from '../shared/protocol.js'

interface RequestLike {
  method?: string
  url?: string
  headers: IncomingHttpHeaders
  on(event: 'close', listener: () => void): void
  [Symbol.asyncIterator](): AsyncIterator<Buffer | string>
}

interface ResponseLike {
  writeHead(status: number, headers?: Record<string, string>): void
  write(chunk: string): boolean
  end(chunk?: string): void
  flushHeaders?(): void
  on(event: 'close', listener: () => void): void
}

export interface RouterDeps {
  store: AtlasStore
  model: AtlasModel
  dataDir: string
  modelHint: string
  checkUpdate: (force?: boolean) => Promise<UpdateInfo>
}

export function createAtlasRouter(deps: RouterDeps) {
  return async (rawReq: unknown, rawRes: unknown): Promise<void> => {
    const req = rawReq as RequestLike
    const res = rawRes as ResponseLike
    try {
      await route(req, res, deps)
    } catch (error) {
      sendError(res, error)
    }
  }
}

async function route(req: RequestLike, res: ResponseLike, deps: RouterDeps): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://atlas.local')
  const segments = url.pathname.split('/').filter(Boolean)
  if (segments[0] !== 'ext' || segments[1] !== 'atlas') {
    return send(res, 404, { error: { code: 'E_NOT_FOUND', message: 'Not found' } })
  }
  const path = segments.slice(2)
  const method = (req.method ?? 'GET').toUpperCase()

  // GET /update ─ 版本检测（不自动安装）
  if (path.length === 1 && path[0] === 'update') {
    allow(method, ['GET'])
    return send(res, 200, await deps.checkUpdate(url.searchParams.get('force') === '1'))
  }

  // GET /bootstrap ─ 首次进入：工作区列表 + 当前快照
  if (path.length === 1 && path[0] === 'bootstrap') {
    allow(method, ['GET'])
    const workspace = await deps.store.ensureWorkspace()
    const [workspaces, snapshot] = await Promise.all([
      deps.store.listWorkspaces(),
      deps.store.snapshot(workspace.id),
    ])
    return send(res, 200, { workspaces, snapshot, dataDir: deps.dataDir })
  }

  // /workspaces
  if (path[0] === 'workspaces') {
    if (path.length === 1) {
      allow(method, ['GET', 'POST'])
      if (method === 'GET') return send(res, 200, { workspaces: await deps.store.listWorkspaces() })

      const body = await readJson<CreateWorkspaceInput>(req)
      if (!body.name?.trim()) throw new Error('E_BAD_REQUEST: 工作区名称不能为空')
      const workspace = await deps.store.createWorkspace(body.name, body.goal)
      return send(res, 200, {
        workspace,
        snapshot: await deps.store.snapshot(workspace.id),
        workspaces: await deps.store.listWorkspaces(),
      })
    }

    const workspaceId = decode(path[1]!)
    if (path.length === 2) {
      allow(method, ['GET', 'PATCH'])
      if (method === 'GET') return send(res, 200, { snapshot: await deps.store.snapshot(workspaceId) })

      const body = await readJson<{ name?: string; goal?: string; active?: boolean }>(req)
      if (body.active) await deps.store.setActive(workspaceId)
      else await deps.store.updateWorkspace(workspaceId, body)
      return send(res, 200, {
        snapshot: await deps.store.snapshot(workspaceId),
        workspaces: await deps.store.listWorkspaces(),
      })
    }

    if (path.length === 3 && path[2] === 'viewport') {
      allow(method, ['PATCH'])
      const body = await readJson<{ viewport: Viewport }>(req)
      if (!body.viewport) throw new Error('E_BAD_REQUEST: 缺少 viewport')
      return send(res, 200, { viewport: await deps.store.saveViewport(workspaceId, body.viewport) })
    }
  }

  // /nodes
  if (path[0] === 'nodes') {
    if (path.length === 1) {
      allow(method, ['POST'])
      const body = await readJson<CreateNodeInput>(req)
      if (!body.workspaceId || !body.title?.trim()) {
        throw new Error('E_BAD_REQUEST: 需要 workspaceId 和 title')
      }
      const created = await deps.store.createNode(body)
      return send(res, 200, created)
    }

    const nodeId = decode(path[1]!)
    if (path.length === 2) {
      allow(method, ['PATCH', 'DELETE'])
      if (method === 'PATCH') {
        const body = await readJson<UpdateNodeInput>(req)
        const node = await deps.store.updateNode(nodeId, body)
        return send(res, 200, { node })
      }
      const deleted = await deps.store.deleteNode(nodeId)
      return send(res, 200, { deleted })
    }

    if (path.length === 3 && path[2] === 'close') {
      allow(method, ['POST'])
      const body = await readJson<CloseInput>(req)
      const node = await deps.store.getNode(nodeId)
      const threadId = body.threadId ?? node.threadId
      const thread = await deps.store.getThread(threadId)
      if (thread.node.id !== node.id) throw new Error('E_BAD_REQUEST: 线程不属于该节点')
      const card = await generateClosure(deps.store, deps.model, node, threadId)
      return send(res, 200, { card, node: await deps.store.getNode(nodeId) })
    }
  }

  // /threads
  if (path[0] === 'threads') {
    if (path.length === 1) {
      allow(method, ['POST'])
      const body = await readJson<CreateSubthreadInput & { nodeId: string }>(req)
      if (!body.nodeId || !body.title?.trim()) throw new Error('E_BAD_REQUEST: 需要 nodeId 和 title')
      const thread = await deps.store.createSubthread(body.nodeId, body)
      return send(res, 200, { thread })
    }

    const threadId = decode(path[1]!)
    if (path.length === 2) {
      allow(method, ['GET', 'PATCH'])
      if (method === 'GET') return send(res, 200, { snapshot: await deps.store.getThread(threadId) })
      const body = await readJson<{ collapsed?: boolean }>(req)
      const thread = await deps.store.setThreadCollapsed(threadId, body.collapsed ?? true)
      return send(res, 200, { thread })
    }

    if (path.length === 3 && path[2] === 'turn') {
      allow(method, ['POST'])
      return turn(req, res, deps, threadId)
    }

    if (path.length === 3 && path[2] === 'promote') {
      allow(method, ['POST'])
      const body = await readJson<PromoteInput>(req)
      const node = await promoteSubthread(deps.store, threadId, {
        title: body.title,
        position: body.position,
      })
      return send(res, 200, { node })
    }
  }

  // GET /search?q=
  if (path.length === 1 && path[0] === 'search') {
    allow(method, ['GET'])
    const q = url.searchParams.get('q')?.trim() ?? ''
    if (!q) return send(res, 200, { hits: [] })
    let workspaceId = url.searchParams.get('workspaceId') ?? ''
    if (!workspaceId) workspaceId = (await deps.store.ensureWorkspace()).id
    return send(res, 200, { hits: await deps.store.search(workspaceId, q) })
  }

  send(res, 404, { error: { code: 'E_NOT_FOUND', message: `未知路由：${url.pathname}` } })
}

async function turn(req: RequestLike, res: ResponseLike, deps: RouterDeps, threadId: string): Promise<void> {
  const body = await readJson<TurnInput>(req)
  const text = body.text?.trim()
  if (!text) throw new Error('E_BAD_REQUEST: 消息不能为空')
  if (text.length > LIMITS.maxMessageChars) throw new Error('E_BUDGET: 单条消息过长')

  const snapshot = await deps.store.getThread(threadId)
  const { workspace, node } = snapshot

  const userMessage = await deps.store.appendMessage(threadId, 'user', text, body.quote)
  if (node.status !== 'active') await deps.store.updateNode(node.id, { status: 'active' })

  const parentMessages =
    snapshot.thread.kind === 'sub' && snapshot.thread.parentThreadId
      ? (await deps.store.getThread(snapshot.thread.parentThreadId)).messages.slice(-2)
      : undefined

  const context = buildChatContext({
    workspace,
    node,
    path: snapshot.path,
    card: snapshot.card,
    messages: [...snapshot.messages, userMessage],
    parentMessages,
  })

  const assistant = await deps.store.appendMessage(threadId, 'assistant', '')
  const controller = new AbortController()
  res.on('close', () => controller.abort())

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    'connection': 'keep-alive',
    'x-accel-buffering': 'no',
  })
  res.flushHeaders?.()
  event(res, 'meta', { threadId, messageId: assistant.id, model: deps.modelHint })

  let streamed = ''
  try {
    const result = await deps.model.run({
      system: context.system,
      messages: context.messages,
      signal: controller.signal,
      onDelta: (delta) => {
        streamed += delta
        event(res, 'delta', { messageId: assistant.id, text: delta })
      },
    })
    await deps.store.updateMessage(workspace.id, threadId, assistant.id, result.text)
    event(res, 'done', {
      messageId: assistant.id,
      usage: { input: result.usage.input, output: result.usage.output },
    })
  } catch (error) {
    const apiError = toApiError(error)
    const content = streamed
      ? `${streamed}\n\n> ⚠️ ${apiError.message}`
      : `⚠️ ${apiError.message}`
    await deps.store.updateMessage(workspace.id, threadId, assistant.id, content, true).catch(() => undefined)
    event(res, 'error', apiError)
    event(res, 'done', { messageId: assistant.id })
  } finally {
    res.end()
  }
}

// ── 工具 ────────────────────────────────────────────────────────────────────

function send(res: ResponseLike, status: number, body: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

function sendError(res: ResponseLike, error: unknown): void {
  const apiError = toApiError(error)
  send(res, statusOf(apiError.code), { error: apiError })
}

function event(res: ResponseLike, name: AtlasEvent['event'], data: unknown): void {
  try {
    res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`)
  } catch {
    // 客户端已经断开；SSE 不需要重试。
  }
}

async function readJson<T>(req: RequestLike): Promise<T> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > 1_000_000) throw new Error('E_BAD_REQUEST: 请求体过大')
    chunks.push(buffer)
  }
  if (chunks.length === 0) return {} as T
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T
  } catch {
    throw new Error('E_BAD_REQUEST: 请求体不是合法 JSON')
  }
}

function allow(method: string, methods: string[]): void {
  if (!methods.includes(method)) throw new Error(`E_BAD_REQUEST: 不支持 ${method}`)
}

function decode(value: string): string {
  return decodeURIComponent(value)
}

function toApiError(error: unknown): ApiError {
  const raw = error instanceof Error ? error.message : String(error)
  const matched = /^(E_[A-Z_]+):\s*(.*)$/s.exec(raw)
  if (matched) return { code: matched[1] as AtlasErrorCode, message: matched[2] || raw }
  if (process.env['DSH_ATLAS_DEBUG']) console.warn('[atlas]', error)
  return { code: 'E_INTERNAL', message: '服务器内部错误' }
}

function statusOf(code: AtlasErrorCode): number {
  switch (code) {
    case 'E_NOT_FOUND':
      return 404
    case 'E_AUTH':
      return 401
    case 'E_CONFLICT':
      return 409
    case 'E_BUDGET':
      return 413
    case 'E_UNSUPPORTED':
      return 501
    case 'E_MODEL':
      return 502
    case 'E_VALIDATION':
    case 'E_BAD_REQUEST':
      return 400
    default:
      return 500
  }
}

