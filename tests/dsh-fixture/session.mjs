import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from '../../node_modules/esbuild/lib/main.js'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'

const root = await mkdtemp(join(tmpdir(), 'atlas-dsh-fixture-'))
const allowed = join(root, 'allowed')
const denied = join(root, 'denied')
await mkdir(allowed)
await mkdir(denied)
let ctx
class FixtureAdapter extends LlmAdapter {
  constructor() { super(); this.requests = []; this.script = [] }
  async resolveModel(provider, model) { return { provider, id: model, name: model } }
  async *stream(options) {
    this.requests.push(options)
    const chunks = this.script.shift()
    if (!chunks) throw new Error('fixture response script exhausted')
    yield* chunks
  }
}
const adapter = new FixtureAdapter()
function textResponse(text) {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}
function toolResponse(path, id) {
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'fixture_write', arguments: JSON.stringify({ path }) } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}
function waitForIdle(agent) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { dispose(); reject(new Error('Agent did not reach idle')) }, 10000)
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') { clearTimeout(timeout); dispose(); resolve() }
    })
  })
}
async function turn(agent, text) {
  const idle = waitForIdle(agent)
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  await idle
}
try {
  ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions'), compression: 'none' })
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['fixture'], adapter)
  ctx.tools.register(defineContentToolFixture({
    name: 'fixture_write', description: 'write one fixture file',
    parameters: { path: { type: 'string', required: true } },
    async execute(args) {
      await writeFile(args.path, 'fixture-only')
      return [{ type: 'text', text: 'written' }]
    },
  }))
  const ok = join(allowed, 'ok.txt')
  const blocked = join(denied, 'blocked.txt')
  await writeFile(blocked, 'original')
  // This guard is intentionally limited to exact fixture paths and tool name.
  ctx.tools.guard(exec => exec.name === 'fixture_write' && exec.arguments?.path !== ok ? 'fixture path denied' : undefined)
  const compiled = await build({ entryPoints: [fileURLToPath(new URL('../../src/host/store.ts', import.meta.url))], bundle: true, write: false, format: 'esm', platform: 'node', target: 'node24' })
  const { AtlasStore } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`)
  const store = new AtlasStore(join(root, 'atlas'))
  const workspace = await store.createWorkspace('fixture')
  const first = await store.createNode({ workspaceId: workspace.id, title: 'first' })
  const second = await store.createNode({ workspaceId: workspace.id, title: 'second' })
  assert.equal(first.node.sessionId, undefined)
  const id = SessionId('atlas-fixture-session')
  const handle = await ctx.agents.create({ sessionId: id, meta: { cwd: allowed }, agentOptions: { provider: 'fixture', model: 'fixture' } })
  const bound = await store.bindSession(first.node.id, id)
  assert.equal(bound.sessionId, handle.agent.session.id)
  assert.equal((await store.bindSession(first.node.id, id)).sessionId, id)
  await assert.rejects(store.bindSession(second.node.id, id), /E_CONFLICT/)
  await assert.rejects(store.bindSession(first.node.id, 'other-session'), /E_CONFLICT/)
  await assert.rejects(store.bindSession(second.node.id, '../bad'), /E_BAD_REQUEST/)
  const anotherWorkspace = await store.createWorkspace('other')
  const other = await store.createNode({ workspaceId: anotherWorkspace.id, title: 'other' })
  await assert.rejects(store.bindSession(other.node.id, id), /E_CONFLICT/)
  const reopenedStore = new AtlasStore(join(root, 'atlas'))
  assert.equal((await reopenedStore.getNode(first.node.id)).sessionId, id)
  adapter.script.push(toolResponse(ok, 'allowed-call'), textResponse('allowed done'))
  await turn(handle.agent, 'write allowed file')
  assert.equal(await readFile(ok, 'utf8'), 'fixture-only')
  adapter.script.push(toolResponse(blocked, 'denied-call'), textResponse('denied done'))
  await turn(handle.agent, 'try denied file')
  assert.equal(await readFile(blocked, 'utf8'), 'original')
  const events = handle.agent.session.snapshotEvents()
  assert.ok(events.some(event => event.type === 'tool/call' && event.data.callId === 'allowed-call'))
  assert.ok(events.some(event => event.type === 'tool/result' && event.data.message.source.callId === 'allowed-call'))
  assert.ok(events.some(event => event.type === 'tool/call' && event.data.callId === 'denied-call'))
  assert.ok(events.some(event => event.type === 'tool/result' && event.data.message.source.callId === 'denied-call'))
  assert.ok(adapter.requests.length >= 4)
  await handle.dispose()
  const resumed = await ctx.agents.resume({ resumeSessionId: id, agentOptions: { provider: 'fixture', model: 'fixture' } })
  adapter.script.push(toolResponse(blocked, 'denied-after-resume'), textResponse('resumed and denied'))
  await turn(resumed.agent, 'continue after release and try denied file')
  assert.equal(await readFile(blocked, 'utf8'), 'original')
  assert.ok(resumed.agent.session.snapshotEvents().some(event => event.type === 'tool/result' && event.data.message.source.callId === 'denied-after-resume'))
  assert.equal(resumed.agent.session.id, (await store.getNode(first.node.id)).sessionId)
  assert.ok(resumed.agent.session.snapshotEvents().some(event => event.type === 'tool/call' && event.data.callId === 'allowed-call'))
  await resumed.dispose()
  await ctx.fiber.dispose()
  ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions'), compression: 'none' })
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['fixture'], adapter)
  const afterRestart = await ctx.agents.resume({ resumeSessionId: id, agentOptions: { provider: 'fixture', model: 'fixture' } })
  adapter.script.push(textResponse('after restart'))
  await turn(afterRestart.agent, 'continue after host restart')
  assert.ok(afterRestart.agent.session.snapshotEvents().some(event => event.type === 'tool/call' && event.data.callId === 'allowed-call'))
  await afterRestart.dispose()
  console.log('DSH rc.2 fixture: tool allow/deny, Session resume and isolated Host restart passed (mock model)')
} finally {
  if (ctx) await ctx.fiber.dispose()
  await rm(root, { recursive: true, force: true })
}
