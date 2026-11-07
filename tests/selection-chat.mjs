import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { JSDOM } from 'jsdom'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

const cache = new URL('../node_modules/.cache/', import.meta.url)
await mkdir(cache, { recursive: true })
const temporary = await mkdtemp(new URL('atlas-selection-', cache))
async function load(path, platform = 'node') {
  const result = await build({ entryPoints: [path], bundle: true, write: false, format: 'esm', platform, target: 'node22', packages: 'external' })
  const file = temporary + '/' + path.split('/').at(-1).replace(/\.tsx?$/, '.mjs')
  await writeFile(file, result.outputFiles[0].text)
  return import(pathToFileURL(file).href)
}
const { explanationPrompt } = await load('src/host/selection-chat.ts')
const { chatRows } = await load('src/client/selection-sessions.ts')
const { captureSelection, listenSelections } = await load('src/client/selection-capture.ts')
const source = { sessionId: 'main', messageKey: 'message1', start: 0, end: 3, text: '页分裂', paragraph: '在 B+ 树中通过页分裂腾出空间。' }
const secret = 'INTERNAL_DO_NOT_COPY'
const events = [
  { type: 'user/message', seq: 0, data: { source: { kind: 'runtime-context' }, content: [{ type: 'text', text: secret }] } },
  ...Array.from({ length: 12 }, (_, i) => ({ type: i % 2 ? 'assistant/message' : 'user/message', seq: i + 1, data: i % 2 ? { message: { content: [{ type: 'text', text: String(i).repeat(1600) }, { type: 'reasoning', text: secret }] } } : { source: { kind: 'user' }, content: [{ type: 'text', text: String(i).repeat(1600) }, { type: 'tool-call', text: secret }] } })),
  { type: 'tool/result', seq: 14, data: { content: [{ type: 'text', text: secret }] } },
]
const prompt = explanationPrompt(source, events)
assert.ok(!prompt.includes(secret))
const material = JSON.parse(prompt.slice(prompt.indexOf('{')))
assert.ok(material.recentConversation.length <= 8)
assert.ok(material.recentConversation.every(m => m.text.length <= 1200))
assert.ok(material.recentConversation.reduce((n, m) => n + m.text.length, 0) <= 6000)
assert.equal(material.visibleParagraph, source.paragraph)
const rows = chatRows([
  { event: { type: 'user/message', seq: 1, data: { source: { kind: 'runtime-context' }, content: [{ type: 'text', text: secret }] } } },
  { event: { type: 'user/message', seq: 2, data: { source: { kind: 'user', rpcId: 'initial' }, content: [{ type: 'text', text: prompt }] } } },
  { event: { type: 'user/message', seq: 3, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '追问' }] } } },
  ...[
    { type: 'block-start', index: 0, blockType: 'reasoning' }, { type: 'text-delta', index: 0, text: secret },
    { type: 'block-start', index: 1, blockType: 'text' }, { type: 'text-delta', index: 1, text: '回答' },
  ].map(chunk => ({ event: { type: 'assistant/live-chunk', seq: 4, data: { attemptId: 'a', chunk } } })),
], 'initial')
assert.deepEqual(rows.map(r => r.text), ['追问', '回答'])

const dom = new JSDOM('<body><div data-conversation-session="main"><div data-chat-node-key="m1" data-chat-flow-kind="assistant-step"><p>这里是页分裂的第一段。</p><p>跨段落的说明。</p></div><div data-chat-node-key="m2" data-chat-flow-kind="user"><span data-slot="conversation.user.text.node">页分裂的问题</span></div></div></body>', { pretendToBeVisual: true })
for (const name of ['window', 'document', 'Element', 'HTMLElement', 'Node', 'MutationObserver', 'PointerEvent']) if (dom.window[name]) globalThis[name] = dom.window[name]
dom.window.Range.prototype.getBoundingClientRect = () => ({ x: 10, y: 20, bottom: 30 })
dom.window.HTMLElement.prototype.getClientRects = () => [{ x: 0, y: 0 }]
function select(first, start, last = first, end = start + 3) {
  const selection = dom.window.getSelection()
  const range = dom.window.document.createRange()
  range.setStart(first, start); range.setEnd(last, end)
  selection.removeAllRanges(); selection.addRange(range)
  return selection
}
const paragraphs = document.querySelectorAll('p')
let selected = select(paragraphs[0].firstChild, 3)
assert.equal(captureSelection(selected).source.text, '页分裂')
assert.equal(captureSelection(selected).source.sessionId, 'main')
assert.match(captureSelection(select(paragraphs[0].firstChild, 3, paragraphs[1].firstChild, 4)).source.paragraph, /跨段落/)
assert.equal(captureSelection(select(paragraphs[0].firstChild, 3, document.querySelector('span').firstChild, 3)), undefined)
assert.ok(captureSelection(select(document.querySelector('span').firstChild, 0)))
const excluded = document.createElement('div')
excluded.dataset.variant = 'think'; excluded.innerHTML = '<p>推理排除区域</p>'
paragraphs[0].after(excluded)
assert.equal(captureSelection(select(excluded.firstChild.firstChild, 0)), undefined)
assert.equal(captureSelection(select(paragraphs[0].firstChild, 3, paragraphs[1].firstChild, 4)), undefined)
excluded.remove()
const tool = document.createElement('div')
tool.setAttribute('data-chat-node-key', 'tool'); tool.innerHTML = '<p>工具排除区域</p>'
paragraphs[0].after(tool)
assert.equal(captureSelection(select(paragraphs[0].firstChild, 3, paragraphs[1].firstChild, 4)), undefined)
tool.remove()
document.querySelector('[data-conversation-session]').setAttribute('data-atlas-selection-chat', '')
assert.equal(captureSelection(select(paragraphs[0].firstChild, 3)), undefined)
document.querySelector('[data-conversation-session]').removeAttribute('data-atlas-selection-chat')
let opened = 0
const cleanup = listenSelections(() => opened++, () => {})
select(paragraphs[0].firstChild, 3)
document.dispatchEvent(new dom.window.KeyboardEvent('keyup', { key: 'Shift' }))
await new Promise(resolve => setTimeout(resolve, 150))
assert.equal(opened, 1)
cleanup()
document.dispatchEvent(new dom.window.KeyboardEvent('keyup', { key: 'Shift' }))
await new Promise(resolve => setTimeout(resolve, 150))
assert.equal(opened, 1)
dom.window.close()
await rm(temporary, { recursive: true, force: true })
console.log('Selection chat: text context bounds, native feed, DOM exclusions, keyboard and listener disposal passed')
