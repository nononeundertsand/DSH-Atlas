import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { installModelSelection } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import type LlmRuntime from '@deepseek-ai/dsh-llm'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { LlmPort, ModelSelection } from '../shared/dsh.js'

/** A separate DSH runtime: no persistence, workspace/catalog, memory or telemetry plugins. */
export class SelectionMemoryRuntime {
  private ready?: Promise<Context>
  private closed = false
  constructor(private readonly llm: LlmPort, private readonly selection: () => ModelSelection) {}

  private initialize(): Promise<Context> {
    if (this.closed) return Promise.reject(new Error('E_SESSION_UNAVAILABLE: 临时会话运行域已关闭'))
    return this.ready ??= (async () => {
      const ctx = new Context()
      try {
        // Borrow only the host model service, never its Session/Agent registries.
        ctx.provide('llm', this.llm as LlmRuntime)
        for (const plugin of [SessionStore, SessionProjectionRegistry, SystemPrompt, ToolRuntime, AgentRegistry]) await ctx.plugin(plugin)
        await ctx.plugin(AgentLoop, { agents: [] })
        if (this.closed) throw new Error('E_SESSION_UNAVAILABLE: 临时会话运行域已关闭')
        return ctx
      } catch (error) { await ctx.fiber.dispose(); throw error }
    })()
  }

  async create(id: string, cwd: string) {
    const ctx = await this.initialize()
    const getSelection = () => {
      const value = this.selection()
      return { provider: value.provider, model: value.model, ...(value.reasoningEffort ? { reasoningEffort: ReasoningEffortId(value.reasoningEffort) } : {}) }
    }
    return ctx.agents.create({ sessionId: SessionId(id), meta: { cwd }, agentOptions: getSelection(), setup(agentCtx) {
      agentCtx.tools.restrict({ allow: [] })
      agentCtx.tools.guard(() => '临时解释会话不允许执行工具')
      installModelSelection(agentCtx, { assembled: undefined, get current() { return getSelection() } })
    } })
  }

  async dispose(): Promise<void> {
    this.closed = true
    await this.ready?.then(ctx => ctx.fiber.dispose(), () => undefined)
  }
}
