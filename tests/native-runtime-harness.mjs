// Runs INSIDE the extracted 0.2.2-rc.1 runtime directory, so every
// `@deepseek-ai/*` import resolves to the real desktop packages.
import assert from 'node:assert/strict'
import { mkdtemp, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { SelectionMemoryRuntime } from './selection-memory.mjs'
import { SelectionSessions } from './selection-chat.mjs'

const versions = JSON.parse(await (await import('node:fs/promises')).readFile(new URL('./node_modules/@deepseek-ai/dsh-tools/package.json', import.meta.url), 'utf8')).version
assert.equal(versions, '0.2.2-rc.1', 'real new DSH packages required')

const disk = await mkdtemp(join(tmpdir(), 'atlas-native-rc1-'))
const root = new Context()
await root.plugin(LlmRuntime)
await root.plugin(SessionStore)
const calls = []
let failure = false
class Fixture extends LlmAdapter {
  async resolveModel(provider, model) { return { provider, id: model, name: model } }
  async *stream(options) {
    calls.push(options)
    if (failure) { failure = false; throw new Error('fixture failure') }
    const last = options.messages.filter(m => m.role === 'user' && m.source?.kind === 'user').at(-1)?.content.filter(b => b.type === 'text').map(b => b.text).join('\n') ?? ''
    if (last.includes('工具测试') && options.messages.at(-1)?.role !== 'tool') {
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'native-probe-1', name: 'atlas_native_probe', arguments: '{"text":"probe"}' } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    const text = 'private memory answer'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    for (const word of ['private ', 'memory ', 'answer']) {
      await new Promise(resolve => setTimeout(resolve, 15))
      if (options.signal?.aborted) throw options.signal.reason
      yield { type: 'text-delta', index: 0, text: word }
    }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
root.llm.registerAdapter(['fixture'], new Fixture())

// Baseline: the real new tools service throws without an executor, even with zero tools.
const bare = new Context()
bare.provide('llm', root.llm)
for (const plugin of [SessionStore, SessionProjectionRegistry, SystemPrompt, ToolRuntime, AgentRegistry]) await bare.plugin(plugin)
assert.throws(() => bare.tools.selectExecutor(), /The selected tool executor is unavailable/, 'new host needs a scoped executor even with an empty tool list')
await bare.fiber.dispose()

async function settled(service, id) {
  const start = Date.now()
  while (Date.now() - start < 8000) {
    const state = service.state(id)
    if (!state.running && state.entries.some(({ event }) => event.type === 'turn/end')) return state
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('native turn did not settle')
}

const source = { sessionId: 'main', messageKey: 'm1', text: '页分裂', start: 3, end: 6, paragraph: '通过页分裂腾出空间。' }
const page = '01010101-0101-0101-0101-010101010101'
const id1 = '02020202-0202-0202-0202-020202020202'
const id2 = '03030303-0303-0303-0303-030303030303'
const handles = []
const host = {
  workspaceRegistry: { archivedSessionIds: [] },
  sessionController: { create() { throw new Error('persisted Session creation MUST NOT be used') } },
  sessionQuery: { async readSurface(id) { return { session: { id, cwd: disk }, events: [] } } },
}
const runtime = new SelectionMemoryRuntime(root.llm, () => ({ provider: 'fixture', model: 'fixture' }))
const service = new SelectionSessions(host, {
  async create(...args) { const handle = await runtime.create(...args); handles.push(handle); return handle },
  dispose: () => runtime.dispose(),
})
try {
  const results = await Promise.all(Array.from({ length: 10 }, () => service.open(page, id1, source)))
  const id = results[0].sessionId
  assert.equal(new Set(results.map(r => r.sessionId)).size, 1)
  assert.equal(handles.length, 1, 'initial explanation is deduplicated')
  const executor = handles[0].agent.ctx.tools.selectExecutor()
  assert.equal(executor.constructor.name, 'NativeToolExecutor', 'real new executor is mounted in the private scope')
  assert.deepEqual(executor.describe([]), { schemas: [] }, 'tool description preparation selects the executor')
  assert.equal(handles[0].agent.ctx.tools.definitions(handles[0].agent).length, 0, 'allow: [] still hides every tool')

  let updates = 0
  const unsubscribe = service.subscribe(id, () => updates++)
  await settled(service, id)
  assert.ok(updates > 3, 'streaming frames reach subscribers')
  assert.equal(calls.length, 1, 'pure selection/one click => exactly one first explanation')
  assert.deepEqual(calls[0].tools ?? [], [], 'no tool schemas reach the model')
  assert.equal(handles[0].agent.ctx.get('sessionPersistence'), undefined, 'no persistence plugin')
  assert.equal(root.sessions.list().length, 0, 'private Session never enters the main catalog')
  assert.deepEqual(await readdir(disk), [], 'no session log, workspace or memory files')
  await service.open(page, id1, source)
  assert.equal(calls.length, 1, 'lost create acknowledgement cannot duplicate the first prompt')

  await Promise.all([service.send(id, '第一次追问：蓝色盒子', 'follow-1'), service.send(id, '第一次追问：蓝色盒子', 'follow-1')])
  await new Promise(resolve => setTimeout(resolve, 120))
  await service.send(id, '第二次追问：盒子指什么', 'follow-2')
  await new Promise(resolve => setTimeout(resolve, 120))
  assert.equal(calls.length, 3, 'multi-turn followups each start exactly one turn')
  assert.ok(calls[2].messages.some(m => m.role === 'user' && m.content.some(b => b.type === 'text' && b.text.includes('第一次追问'))), 'conversation context is retained')

  // Model attempts a tool call: the guard must deny it, no tool body may run.
  let executions = 0
  handles[0].agent.ctx.tools.register(defineTool({
    name: 'atlas_native_probe', description: 'native runtime probe',
    parameters: { text: { type: 'string' } },
    output: { schema: { type: 'string' }, render: () => [{ type: 'text', text: '' }], presentationMeta: () => ({}) },
    async execute() { executions++; return [{ type: 'text', text: 'executed' }] },
  }))
  await service.send(id, '工具测试', 'tool-attempt')
  await new Promise(resolve => setTimeout(resolve, 250))
  assert.equal(executions, 0, 'a model tool call is never executed in a temporary chat')
  assert.ok(handles[0].agent.session.snapshotEvents().some(e => e.type === 'tool/result'), 'denial is recorded in the private session')

  const beforeClose = handles[0].agent.ctx.sessions
  await service.close(page, id1)
  assert.throws(() => service.state(id), /清空/)
  assert.equal(beforeClose.list().length, 0, 'closing releases the native Session and its history')
  await assert.rejects(service.open(page, id1, source), /清空/)
  unsubscribe()

  const fresh = await service.open(page, id2, source)
  assert.notEqual(fresh.sessionId, id)
  await settled(service, fresh.sessionId)
  assert.ok(!calls.at(-1).messages.some(m => m.content.some(b => b.type === 'text' && b.text.includes('第一次追问'))), 'reopening starts a clean native context')
  await service.send(fresh.sessionId, 'slow fixture question', 'stop-me')
  await new Promise(resolve => setTimeout(resolve, 20))
  service.stop(fresh.sessionId)
  await new Promise(resolve => setTimeout(resolve, 90))
  assert.equal(service.state(fresh.sessionId).entries.filter(({ event }) => event.type === 'turn/end').at(-1).event.data.reason.kind, 'aborted', 'stop aborts the stream')

  failure = true
  await service.send(fresh.sessionId, 'fail once', 'fail')
  await new Promise(resolve => setTimeout(resolve, 90))
  assert.ok(service.state(fresh.sessionId).error, 'model failure surfaces an error')
  await service.send(fresh.sessionId, 'retry same context', 'retry')
  await new Promise(resolve => setTimeout(resolve, 120))
  assert.equal(service.state(fresh.sessionId).error, undefined, 'retry recovers')

  await service.dispose()
  assert.equal(root.sessions.list().length, 0)
  assert.deepEqual(await readdir(disk), [], 'closing never writes files')
  console.log('Real DSH 0.2.2-rc.1: NativeToolExecutor mounted; first explanation, multi-turn, streaming, stop, retry, close/reopen, tool denial, no persistence or files passed')
} finally {
  await service.dispose()
  await root.fiber.dispose()
}
