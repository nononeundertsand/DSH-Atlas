// Read-only audit of a PRIVATE MEMORY Session after native UI verification.
// node tests/dsh-fixture/selection-audit.mjs <isolated-home> <main-id> <memory-id>
// zstd is needed only for DSH's default compression. The memory id MUST have no log.
import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
const [home, mainId, memoryId] = process.argv.slice(2)
assert.ok(home && mainId && memoryId?.startsWith('atlas-memory-'), 'Pass isolated home, ordinary main id and private memory id')
let main
let ordinarySessions = 0
for (const project of await readdir(join(home, 'sessions'))) {
  for (const id of await readdir(join(home, 'sessions', project))) {
    assert.ok(!id.startsWith('atlas-memory-'), 'private Session must never have a persisted directory')
    ordinarySessions++
    if (id !== mainId) continue
    const base = join(home, 'sessions', project, id)
    const name = (await readdir(base)).find(name => /^session\.v4\.jsonl(?:\.zstd)?$/.test(name))
    assert.ok(name)
    const path = join(base, name)
    const content = name.endsWith('.zstd') ? execFileSync('zstd', ['-dc', path], { maxBuffer: 20 * 1024 * 1024 }).toString() : await readFile(path, 'utf8')
    main = content.trim().split('\n').map(JSON.parse)
  }
}
assert.ok(main, 'main native log remains present')
const users = main.filter(e => e.type === 'user/message' && e.data.source.kind === 'user')
const text = e => e.data.content.filter(b => b.type === 'text').map(b => b.text).join('\n')
assert.ok(users.every(e => !/selectedText|第一次追问|第二次追问/.test(text(e))))
for (const type of ['permission/preset', 'sandbox/mode', 'approval/policy']) assert.equal(main.filter(e => e.type === type).length, 1, 'main policy is unchanged')
console.log(JSON.stringify({ model: 'offline fixture; no real-model quality claim', mainId, memoryId, ordinarySessions, mainUserMessages: users.length, mainPolicyUnchanged: true, privateSessionLogDirectories: 0, privatePromptsInMainLog: 0 }, null, 2))
