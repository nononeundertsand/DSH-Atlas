import type { SessionEvent } from './selection-chat.js'

/**
 * DSH 适配边界：只保留 Atlas 实际用到的能力，并把名字固定在这里。
 *
 * DSH 0.1.x → 0.2.x 期间插件 API 发生过变动；把 `webServer`、`llm`、
 * `slots` 等面收敛成最小端口，Host/Client 业务代码不直接依赖内部类。
 */

export interface LlmChunk {
  type: string
  text?: string
  delta?: string
  usage?: { inputTokens?: number; outputTokens?: number }
  reason?: { kind?: string; failure?: { message?: string; code?: string } }
}

export interface LlmRequestMessage {
  id?: string
  role: 'user' | 'assistant' | 'system'
  content: Array<{ type: 'text'; text: string }>
  source?: { kind: string; provider?: string; model?: string }
}

export interface LlmPort {
  listProviders(): Array<{ id: string; name: string }>
  listModels(provider: string): Promise<Array<{ id: string; name: string }>>
  stream(options: {
    provider: string
    model: string
    system?: string
    messages: LlmRequestMessage[]
    maxTokens?: number
    signal?: AbortSignal
  }): AsyncIterable<LlmChunk>
}

export interface WebRoute {
  kind: 'exact' | 'prefix'
  path: string
  handler: (req: unknown, res: unknown) => void | Promise<void>
}

export interface WebServerPort {
  register(route: WebRoute): () => void
}

export interface ModelSelection {
  provider: string
  model: string
  reasoningEffort?: string
}

export interface DefaultModelPort {
  currentSelection(): ModelSelection
}

/** 新版 DSH sessionQuery.observeSession() 返回的观察租约，用完必须 [Symbol.dispose]() 释放。 */
export interface SessionObservation {
  readonly header: { id: string }
  [Symbol.dispose](): void
}

export interface HostContext {
  agents?: { get(id: string): { status: string } | undefined }
  on?(event: 'agent/created', listener: (payload: { agent: { id: string; ctx: { tools?: { restrict(filter: { allow: string[] }): unknown; guard(check: () => string): unknown } } } }) => void): () => void
  workspaceRegistry?: {
    create(path: string, title?: string): Promise<{ id: string; attachSession(id: string): Promise<void> }>
    list?(): Array<{ id: string; path: string; sessionIds: string[] }>
    delete?(id: string): Promise<boolean>
    archiveSession?(sessionId: string): Promise<void>
    unarchiveSession?(sessionId: string): Promise<void>
    readonly archivedSessionIds?: string[]
  }
  sessionController?: {
    create(input: { sessionId: string; workspaceId?: string; cwd?: string; agentPreset?: string }): Promise<{ sessionId: string }>
    /** 旧版 DSH 的会话检查；0.2.2-rc.1 已移除。 */
    inspect?(id: string): Promise<unknown>
  }
  /** DSH 会话查询：读真实 session/title 事件，缺失时回退节点标题。 */
  sessionQuery?: {
    readSurface?(id: string): Promise<{ session: { id: string; cwd?: string }; events: import('./selection-chat.js').SessionEvent[] }>
    /** 新版 DSH：取代 controller.inspect 的定点会话检查。 */
    observeSession?(sessionId: string, options: { projectionMode: 'none' | 'all'; signal?: AbortSignal }): Promise<SessionObservation>
    /** 旧版返回 Session ID → 标题映射；新版返回逐会话 fulfilled/rejected 结果列表。 */
    readTitleSnapshots(ids: string[]): Promise<unknown>
  }
  webServer: WebServerPort
  llm?: LlmPort
  /** DSH 的默认模型选择；通过 inject 声明后可直接读取。 */
  agentDefaultModel?: DefaultModelPort
  effect(fn: () => void | (() => void | Promise<void>), label?: string): void
}

/** 浏览器端最小端口，避免把整棵 DSH 客户端类型带进产物。 */
export interface SlotOptions {
  priority?: number
  name: string
  key?: string
  id?: string
  order?: number
  label?: string | (() => string)
  /** Namespace for the injected `t` of a registered cell. */
  locale?: string
  inject?: (...args: never[]) => Record<string, unknown>
}

/** Raw slot cell; `entries` keeps every registration, unlike `entriesOfSlot`. */
export interface StoredSlotEntry {
  component?: unknown
  options: { key?: string; priority?: number; locale?: string; registrant?: string }
}

export interface SlotRegistryPort {
  inject(name: string, register: () => void | (() => void)): void | (() => void)
  register(options: SlotOptions, component: unknown): () => void
  /** New DSH: raw cells (keeps lower-priority same-key registrations). */
  entries?(name: string): readonly StoredSlotEntry[]
}

export interface ClientContext {
  sessions: SelectionClientPort
  workspaces: { list: { getSnapshot(): { archivedSessionIds: string[] }; subscribe(listener: () => void): () => void } }
  uiWorkspace: { openSession(sessionId: string): void }
  slots: SlotRegistryPort
  layout: { selectPanel(id: string | null): void }
  /** Read a service without the plugin-level `inject` requirement (legacy hosts lack it). */
  get?(name: string): unknown
  effect(fn: () => void | (() => void | Promise<void>), label?: string): void
}

export interface NativeSnapshot { running: boolean; removed: boolean; openState: string; openError: { message: string } | null; lastAgentError: string | null }
export interface NativeSession {
  getSnapshot(): NativeSnapshot
  subscribe(listener: () => void): () => void
  prompt(content: Array<{ type: 'text'; text: string }>, mode: 'queue', signal?: AbortSignal, requestId?: string): Promise<{ ok: boolean; error?: { message: string } }>
  cancel(): Promise<{ ok: boolean; error?: { message: string } }>
  resync(): Promise<void>
}
export interface NativeBinding {
  session: NativeSession
  eventSource: { getSnapshot(): { entries: Array<{ event: SessionEvent }> }; subscribe(listener: () => void): () => void }
}
export interface NativeReference { ready: Promise<NativeBinding>; release(): void }
export interface SelectionClientPort {
  refresh(): Promise<void>
}
