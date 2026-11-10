import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
const cache = new URL('../node_modules/.cache/', import.meta.url)
await mkdir(cache, { recursive: true })
const compiled = await mkdtemp(new URL('atlas-memory-test-', cache))
async function load(path) {
  const output = await build({ entryPoints: [path], bundle: true, write: false, platform: 'node', format: 'esm', packages: 'external' })
  const file = join(compiled, path.split('/').at(-1).replace('.ts', '.mjs'))
  await writeFile(file, output.outputFiles[0].text)
  return import(pathToFileURL(file).href)
}
const { SelectionMemoryRuntime } = await load('src/host/selection-memory.ts')
const { SelectionSessions } = await load('src/host/selection-chat.ts')
const disk = await mkdtemp(join(tmpdir(), 'atlas-memory-disk-proof-'))
const root = new Context()
let service
const calls = []
let failure = false
class Fixture extends LlmAdapter {
  async resolveModel(provider, model) { return { provider, id: model, name: model } }
  async *stream(options) {
    calls.push(options)
    if (failure) { failure = false; throw new Error('fixture failure') }
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
async function settled(id) {
  const start = Date.now()
  while (Date.now() - start < 5000) {
    const state = service.state(id)
    if (!state.running && state.entries.some(({ event }) => event.type === 'turn/end')) return state
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('memory turn did not settle')
}
const source = { sessionId: 'main', messageKey: 'm1', text: '页', start: 2, end: 3, paragraph: '通过页分裂腾出空间。' }
const page = '01010101-0101-0101-0101-010101010101'
const id1 = '02020202-0202-0202-0202-020202020202'
const id2 = '03030303-0303-0303-0303-030303030303'
const id3 = '04040404-0404-0404-0404-040404040404'
const handles = []
let queryFails = false
const host = {
  workspaceRegistry: { archivedSessionIds: [] },
  sessionController: { create() { throw new Error('ordinary persisted Session creation MUST NOT be used') } },
  sessionQuery: { async readSurface(id) { if (queryFails) throw new Error('query failed'); return { session: { id, cwd: disk }, events: [] } } },
}
try {
  await root.plugin(LlmRuntime); await root.plugin(SessionStore)
  root.llm.registerAdapter(['fixture'], new Fixture())
  const native = new SelectionMemoryRuntime(root.llm, () => ({ provider: 'fixture', model: 'fixture' }))
  service = new SelectionSessions(host, { async create(...args) { const handle = await native.create(...args); handles.push(handle); return handle }, dispose: () => native.dispose() })
  const results = await Promise.all(Array.from({ length: 10 }, () => service.open(page, id1, source)))
  const id = results[0].sessionId
  assert.equal(new Set(results.map(r => r.sessionId)).size, 1)
  assert.equal(handles.length, 1)
  let updates = 0
  const unsubscribe = service.subscribe(id, () => updates++)
  await settled(id)
  assert.ok(updates > 3, 'native transient frames reach subscribers')
  assert.equal(calls.length, 1)
  assert.ok(calls[0].messages.some(message => message.content.some(block => block.type === 'text' && block.text.includes('"selectedText":"页"'))), 'the first explanation receives the single selected character')
  assert.deepEqual(calls[0].tools ?? [], [])
  assert.equal(handles[0].agent.ctx.get('sessionPersistence'), undefined)
  assert.equal(root.sessions.list().length, 0, 'private native Session never enters the root catalog')
  assert.deepEqual(await readdir(disk), [], 'no logs, workspaces or memory files')
  await service.open(page, id1, source)
  assert.equal(calls.length, 1, 'lost create acknowledgement cannot duplicate the first prompt')
  await Promise.all([service.send(id, '第一次追问：蓝色盒子', 'follow-1'), service.send(id, '第一次追问：蓝色盒子', 'follow-1')])
  await new Promise(resolve => setTimeout(resolve, 100))
  await service.send(id, '第二次追问：盒子指什么', 'follow-2')
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(calls.length, 3)
  assert.ok(calls[2].messages.some(message => message.role === 'user' && message.content.some(b => b.type === 'text' && b.text.includes('第一次追问'))))
  const beforeClose = handles[0].agent.ctx.sessions
  await service.close(page, id1)
  assert.throws(() => service.state(id), /清空/)
  assert.equal(beforeClose.list().length, 0, 'closing releases native Session and its message history')
  await assert.rejects(service.open(page, id1, source), /清空/)
  unsubscribe()
  const fresh = await service.open(page, id2, source)
  assert.notEqual(fresh.sessionId, id)
  await settled(fresh.sessionId)
  assert.ok(!calls.at(-1).messages.some(message => message.content.some(b => b.type === 'text' && b.text.includes('第一次追问'))), 'reopening starts with clean native context')
  await service.send(fresh.sessionId, 'slow fixture question', 'stop-me')
  await new Promise(resolve => setTimeout(resolve, 20))
  service.stop(fresh.sessionId)
  await new Promise(resolve => setTimeout(resolve, 70))
  assert.equal(service.state(fresh.sessionId).entries.filter(({event}) => event.type === 'turn/end').at(-1).event.data.reason.kind, 'aborted')
  failure = true
  await service.send(fresh.sessionId, 'fail once', 'fail')
  await new Promise(resolve => setTimeout(resolve, 70))
  assert.ok(service.state(fresh.sessionId).error)
  await service.send(fresh.sessionId, 'retry same context', 'retry')
  await new Promise(resolve => setTimeout(resolve, 90))
  assert.equal(service.state(fresh.sessionId).error, undefined)
  host.workspaceRegistry.archivedSessionIds.push('main')
  await assert.rejects(service.send(fresh.sessionId, 'blocked', 'archive'), /归档/)
  host.workspaceRegistry.archivedSessionIds.length = 0
  queryFails = true
  await assert.rejects(service.open(page, id3, source), /无法读取/)
  queryFails = false
  await assert.rejects(service.open('bad', id3, source), /选区无效/)
  // Closing before creation resolves must dispose the late native handle.
  let releaseCreation
  const delayed = new SelectionSessions(host, { async create(...args) { await new Promise(resolve => { releaseCreation = resolve }); return native.create(...args) }, async dispose() {} })
  const pending = delayed.open(page, id3, source)
  while (!releaseCreation) await new Promise(resolve => setTimeout(resolve, 1))
  await assert.rejects(delayed.open(page, id3, { ...source, messageKey: 'different' }), /来源不一致/)
  await delayed.close(page, id3)
  releaseCreation()
  await assert.rejects(pending, /清空/)
  await delayed.dispose()
  await service.dispose()
  assert.equal(root.sessions.list().length, 0)
  assert.deepEqual(await readdir(disk), [])
  console.log('Private DSH memory Sessions: no root catalog/files; native multi-turn/streaming; dedupe/retry/stop; close, fresh reopen and late-create cleanup passed (offline model)')
} finally {
  await service?.dispose()
  await root.fiber.dispose()
  await rm(disk, { recursive: true, force: true })
  await rm(compiled, { recursive: true, force: true })
}
