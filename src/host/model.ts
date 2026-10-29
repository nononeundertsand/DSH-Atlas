/**
 * 模型适配：选路由、流式取文本、一次性取 JSON。
 * 这里只依赖 LlmPort，不关心 provider 的具体协议。
 */
import type { LlmPort, LlmRequestMessage, ModelSelection } from '../shared/dsh.js'

export interface AtlasModelConfig {
  provider?: string
  model?: string
  maxTokens?: number
}

export interface RunOptions {
  system: string
  messages: LlmRequestMessage[]
  maxTokens?: number
  signal?: AbortSignal
  onDelta?: (text: string) => void
}

export interface RunResult {
  text: string
  provider: string
  model: string
  usage: { input: number; output: number }
}

export class AtlasModel {
  private routeCache: Promise<{ provider: string; model: string }> | undefined

  constructor(
    private readonly llm: LlmPort | undefined,
    private readonly config: AtlasModelConfig = {},
    private readonly defaultSelection?: () => ModelSelection | undefined,
  ) {}

  async run(options: RunOptions): Promise<RunResult> {
    const route = await this.route()
    const chunks = this.requireLlm().stream({
      provider: route.provider,
      model: route.model,
      system: options.system,
      messages: options.messages,
      maxTokens: options.maxTokens ?? this.config.maxTokens ?? 1600,
      signal: options.signal,
    })

    let text = ''
    let usage = { input: 0, output: 0 }
    for await (const chunk of chunks) {
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
        text += chunk.text
        options.onDelta?.(chunk.text)
      } else if (chunk.type === 'usage' && chunk.usage) {
        usage = {
          input: chunk.usage.inputTokens ?? 0,
          output: chunk.usage.outputTokens ?? 0,
        }
      } else if (chunk.type === 'finish') {
        const kind = chunk.reason?.kind
        if (kind === 'error' || kind === 'aborted') {
          throw new Error(`E_MODEL: ${chunk.reason?.failure?.message ?? '模型调用失败'}`)
        }
      }
    }

    if (!text.trim()) throw new Error('E_MODEL: 模型没有返回内容')
    return { text, provider: route.provider, model: route.model, usage }
  }

  async json<T>(options: Omit<RunOptions, 'onDelta'>): Promise<{ value: T; model: string }> {
    const result = await this.run({ ...options, maxTokens: options.maxTokens ?? 1200 })
    return { value: parseJson<T>(result.text), model: result.model }
  }

  private async route(): Promise<{ provider: string; model: string }> {
    this.routeCache ??= this.resolveRoute().catch((error: unknown) => {
      this.routeCache = undefined
      throw error
    })
    return this.routeCache
  }

  private async resolveRoute(): Promise<{ provider: string; model: string }> {
    const llm = this.requireLlm()
    const defaults = this.defaultSelection?.()
    const providers = llm.listProviders()
    if (providers.length === 0) {
      throw new Error(
        'E_AUTH: 没有可用的模型 provider。请先在 DSH 设置 → 模型 中配置 provider 与 API key。',
      )
    }

    const provider =
      providers.find((item) => item.id === this.config.provider)?.id ??
      providers.find((item) => item.id === defaults?.provider)?.id ??
      providers.find((item) => item.id === 'deepseek-official')?.id ??
      providers[0]!.id

    let models: Array<{ id: string; name: string }> = []
    try {
      models = await llm.listModels(provider)
    } catch {
      // 允许直接使用配置里的 model；listModels 失败不阻塞调用。
    }

    // 优先使用显式配置，其次是 DSH 的默认模型服务，最后取目录第一项。
    const model = this.config.model ?? defaults?.model ?? models[0]?.id
    if (!model) {
      throw new Error(
        `E_MODEL: provider「${provider}」没有可用模型。请检查 DSH 设置 → 模型，或在 Atlas 配置中显式指定 model。`,
      )
    }
    return { provider, model }
  }

  private requireLlm(): LlmPort {
    if (!this.llm) throw new Error('E_UNSUPPORTED: 当前 DSH 没有提供 llm.stream 能力')
    return this.llm
  }
}

/** 从模型输出中提取第一个 JSON 对象，容忍 ```json 围栏、前后说明与截断。 */
export function parseJson<T>(text: string): T {
  const candidates: string[] = []
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
  if (fence?.[1]) candidates.push(fence[1])
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start >= 0 && end > start) candidates.push(text.slice(start, end + 1))
  candidates.push(text)

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as T
    } catch {
      try {
        return JSON.parse(candidate.replace(/,\s*([}\]])/g, '$1')) as T
      } catch {
        // 继续尝试下一个候选
      }
    }
  }

  const salvaged = salvageFields(text)
  if (salvaged) return salvaged as T
  if (start < 0 || end <= start) throw new Error('E_VALIDATION: 模型没有返回 JSON 对象')
  throw new Error('E_VALIDATION: 模型返回的 JSON 无法解析')
}

/** 输出被截断时，按字段名捞出已经写出的字符串。 */
function salvageFields(text: string): Record<string, string> | undefined {
  const pick = (key: string): string | undefined => {
    const matched = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`).exec(text)
    if (!matched?.[1]) return undefined
    const value = matched[1]
      .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\r')
      .replace(/\\t/g, '\t')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\')
      .trim()
    return value || undefined
  }
  const term = pick('term')
  const meaning = pick('meaning')
  const inContext = pick('inContext')
  if (!term && !meaning && !inContext) return undefined
  return { ...(term ? { term } : {}), ...(meaning ? { meaning } : {}), ...(inContext ? { inContext } : {}) }
}
