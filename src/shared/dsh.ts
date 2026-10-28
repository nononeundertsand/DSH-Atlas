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

export interface HostContext {
  webServer: WebServerPort
  llm?: LlmPort
  /** DSH 的默认模型选择；通过 inject 声明后可直接读取。 */
  agentDefaultModel?: DefaultModelPort
  effect(fn: () => void | (() => void), label?: string): void
}

/** 浏览器端最小端口，避免把整棵 DSH 客户端类型带进产物。 */
export interface SlotOptions {
  name: string
  key?: string
  id?: string
  order?: number
  label?: string | (() => string)
  inject?: (...args: never[]) => Record<string, unknown>
}

export interface SlotRegistryPort {
  inject(name: string, register: () => void): void
  register(options: SlotOptions, component: unknown): () => void
}

export interface ClientContext {
  slots: SlotRegistryPort
  layout: { selectPanel(id: string | null): void }
  effect(fn: () => void | (() => void), label?: string): void
}
