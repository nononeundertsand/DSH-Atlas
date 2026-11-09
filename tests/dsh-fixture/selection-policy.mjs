import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
const compiled = await build({ entryPoints: ['src/host/selection-chat.ts'], bundle: true, write: false, format: 'esm', platform: 'node', packages: 'external' })
const cache = new URL('node_modules/.cache/', import.meta.url)
await mkdir(cache, { recursive: true })
const temporary = await mkdtemp(new URL('atlas-policy-', cache))
const file = temporary + '/policy.mjs'
await writeFile(file, compiled.outputFiles[0].text)
const { restrictTemporaryAgent } = await import(pathToFileURL(file).href)
const ctx = new Context()
let executions = 0
class Fixture extends LlmAdapter {
  async resolveModel(provider, model) { return { provider, id: model, name: model } }
  async *stream(options) {
    if (options.messages.at(-1)?.role !== 'tool') {
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'forbidden', name: 'own_fixture_tool', arguments: '{}' } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    } else {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'done' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
}
async function turn(agent) {
  const idle = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { off(); reject(new Error('no idle')) }, 10000)
    const off = ctx.on('agent/status', ({ agent: subject, status }) => { if (subject === agent && status === 'idle') { clearTimeout(timer); off(); resolve() } })
  })
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'attempt a fixture tool' }], source: { kind: 'user' } }))
  await idle
}
try {
  for (const plugin of [LlmRuntime, SessionStore, SessionProjectionRegistry, SystemPrompt, ToolRuntime, AgentRegistry]) await ctx.plugin(plugin)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['fixture'], new Fixture())
  const temp = await ctx.agents.create({ sessionId: 'atlas-selection-policy-fixture', agentOptions: { provider: 'fixture', model: 'fixture' } })
  restrictTemporaryAgent(temp.agent)
  // The own layer is exempt from inherited allow-lists. The monotonic guard must still deny it.
  temp.agent.ctx.tools.register(defineContentToolFixture({ name: 'own_fixture_tool', description: 'isolated test counter', parameters: {}, async execute() { executions++; return [{ type: 'text', text: 'executed' }] } }))
  await turn(temp.agent)
  assert.equal(executions, 0)
  assert.ok(temp.agent.session.snapshotEvents().some(e => e.type === 'tool/result'))
  await temp.dispose()
  const main = await ctx.agents.create({ sessionId: 'ordinary-policy-fixture', agentOptions: { provider: 'fixture', model: 'fixture' } })
  restrictTemporaryAgent(main.agent)
  main.agent.ctx.tools.register(defineContentToolFixture({ name: 'own_fixture_tool', description: 'isolated test counter', parameters: {}, async execute() { executions++; return [{ type: 'text', text: 'executed' }] } }))
  await turn(main.agent)
  assert.equal(executions, 1)
  await main.dispose()
  console.log('Real DSH ToolRuntime: temporary own-layer tool denied; ordinary Session tool unaffected (offline model)')
} finally { await ctx.fiber.dispose(); await rm(temporary, { recursive: true, force: true }) }
