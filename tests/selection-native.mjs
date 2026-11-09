import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { JSDOM } from 'jsdom'
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

const cache = new URL('../node_modules/.cache/', import.meta.url)
await mkdir(cache, { recursive: true })
const temporary = await mkdtemp(new URL('atlas-native-selection-', cache))
async function load(path, platform = 'node') {
  const output = await build({ entryPoints: [path], bundle: true, write: false, format: 'esm', platform, target: 'es2022', packages: 'external', logLevel: 'silent' })
  const file = temporary + '/' + path.split('/').at(-1).replace(/\.tsx?$/, '.mjs')
  await writeFile(file, output.outputFiles[0].text)
  return import(pathToFileURL(file).href)
}

const dom = new JSDOM('<body><div data-conversation-session="main"><div data-chat-node-key="m1" data-chat-flow-kind="assistant-step"><p>这里是页分裂的第一段。</p></div><div data-chat-node-key="m2" data-chat-flow-kind="user"><span data-slot="conversation.user.text.node">页分裂的问题</span></div></div></body>', { pretendToBeVisual: true, url: 'http://localhost/' })
for (const name of ['window', 'document', 'Element', 'HTMLElement', 'Node', 'MutationObserver', 'PointerEvent', 'KeyboardEvent', 'Range']) if (dom.window[name]) globalThis[name] = dom.window[name]
dom.window.Range.prototype.getBoundingClientRect = () => ({ x: 10, y: 20, bottom: 30, left: 10, right: 60, top: 20, height: 10, width: 50 })
dom.window.HTMLElement.prototype.getClientRects = () => [{ x: 0, y: 0 }]
const paragraph = document.querySelector('p')
function select(first, start, last = first, end = start + 3) {
  const range = document.createRange()
  range.setStart(first, start); range.setEnd(last, end)
  const selection = dom.window.getSelection()
  selection.removeAllRanges(); selection.addRange(range)
  return selection
}

const { supportsNativeSelection, registerNativeSelection, setNativeSearchHandler, NATIVE_SELECTION_CSS } = await load('src/client/native-selection.tsx', 'browser')
const { captureSelection } = await load('src/client/selection-capture.ts', 'browser')
const SLOT = 'conversation.chat.text-interaction'

// Real 0.2.2-rc.1 semantics: first interaction to open() wins; keyed cells sort by
// priority and entriesOfSlot keeps only the first cell per key; entries() keeps all.
function makeContext(native) {
  const cells = new Map()
  const injections = []
  const registrations = []
  const interactions = []
  const slots = {
    entries(name) { return cells.get(name) ?? [] },
    entriesOfSlot(name) {
      const sorted = [...(cells.get(name) ?? [])].sort((a, b) => (a.options.priority ?? 0) - (b.options.priority ?? 0))
      const keys = new Set()
      return sorted.filter(entry => { if (keys.has(entry.options.key)) return false; keys.add(entry.options.key); return true })
    },
    inject(name, register) { injections.push({ name, register }); return () => {} },
    register(options, component) {
      const list = cells.get(options.name) ?? []
      const entry = { options, component }
      list.push(entry); cells.set(options.name, list)
      registrations.push(entry)
      return () => { cells.set(options.name, list.filter(e => e !== entry)) }
    },
  }
  const ctx = {
    slots, injections, registrations, interactions,
    uiConversation: native ? { interactions: {
      register(definition) { interactions.push(definition); return () => {} },
      dispatch(gesture, sessionId = 'main') {
        for (const definition of interactions) {
          let opened = false
          definition.onInteraction({ ...gesture, sessionId, open: () => { opened = true } })
          if (opened) return definition.id
        }
        return null
      },
    } } : undefined,
    layout: { selectPanel() {} },
    sessions: { refresh: async () => {} },
    workspaces: { list: { getSnapshot: () => ({ archivedSessionIds: [] }), subscribe: () => () => {} } },
    uiWorkspace: { openSession() {} },
    effect(fn) { const cleanup = fn(); return () => { if (typeof cleanup === 'function') cleanup() } },
  }
  // Real Cordis rejects `ctx.uiConversation` unless declared in `inject`;
  // `ctx.get('uiConversation')` is the safe read used by the plugin.
  ctx.get = native ? name => name === 'uiConversation' ? ctx.uiConversation : undefined : () => undefined
  return ctx
}

// Shipped message-quotes plugin, transcribed from the installed 0.2.2-rc.1 source.
function ShippedQuote(props) {
  return { type: 'button', props: { type: 'button', 'aria-label': props.t('quote.add'), onClick: () => {
    const text = props.readText()
    if (text === null) { props.dismiss(); return }
    if (!props.inputActions.insertQuote(text)) return
    props.clearSelection(); props.dismiss()
  } }, children: '引用文本' }
}
function installShipped(ctx) {
  ctx.slots.register({ name: SLOT, key: 'quote', locale: 'messageQuotes' }, ShippedQuote)
  ctx.uiConversation.interactions.register({
    id: 'quote',
    onInteraction(request) { if (request.trigger !== 'selection' || request.readText() === null) return; request.open() },
  })
}

const modelRequests = []
const searches = []
const quoteInserts = []
let dismissals = 0
let cleared = 0
function surfaceProps(overrides = {}) {
  return {
    trigger: 'selection', sessionId: 'main',
    readText: () => '页分裂',
    dismiss: () => { dismissals++ },
    clearSelection: () => { cleared++ },
    t: key => key === 'quote.add' ? '引用文本' : key,
    inputActions: { insertQuote(text) { quoteInserts.push(text); return true } },
    ...overrides,
  }
}

const old = makeContext(false)
assert.equal(supportsNativeSelection(old), false, 'legacy host has no native text-interaction registry')
const current = makeContext(true)
assert.equal(supportsNativeSelection(current), true)
installShipped(current)
registerNativeSelection(current)
const declaration = current.injections.find(entry => entry.name === SLOT)
assert.ok(declaration, 'Atlas injects the native slot')
const dispose = declaration.register()
assert.equal(current.slots.entries(SLOT).length, 2, 'shipped quote cell stays registered')
const winners = current.slots.entriesOfSlot(SLOT)
assert.equal(winners.length, 1, 'one action cell per gesture')
assert.equal(winners[0].options.priority, -10)
assert.equal(winners[0].options.key, 'quote')
assert.ok(!/display\s*:\s*none/.test(NATIVE_SELECTION_CSS), 'no global hiding of the native quote button')
assert.ok(!/position\s*:\s*fixed/.test(NATIVE_SELECTION_CSS), 'no independent fixed-position button')
// Unified pill: one container, plain-text cells, one divider, no per-button capsule.
assert.match(NATIVE_SELECTION_CSS, /atlas-selection-native-actions\{[^}]*border-radius:999px/, 'one pill container')
assert.match(NATIVE_SELECTION_CSS, /atlas-selection-native-actions>button\+button::before\{[^}]*width:1px/, 'single inset divider between the two actions')
assert.match(NATIVE_SELECTION_CSS, /atlas-selection-native-actions>button[^{]*\{background:transparent/, 'child cells have no own background')
assert.ok(!/\.atlas-selection-native-action\{[^}]*border-radius:999px/.test(NATIVE_SELECTION_CSS), 'no independent capsule buttons')

setNativeSearchHandler(selection => searches.push(selection))
const Action = winners[0].component
const props = surfaceProps()
const winnerId = current.uiConversation.interactions.dispatch({ trigger: 'selection', readText: () => '页分裂', preventDefault() {} })
assert.equal(winnerId, 'quote')
assert.equal(searches.length, 0, 'selection alone never opens a temporary chat or model request')
assert.equal(modelRequests.length, 0)

select(paragraph.firstChild, 3)
const tree = Action(props)
assert.equal(tree.type, 'div')
assert.equal(tree.props.className, 'atlas-selection-native-actions')
const children = tree.props.children
const quoteElement = children[0]
const searchButton = children[1]
assert.equal(quoteElement.type, ShippedQuote, 'shipped quote action is still rendered')
assert.equal(searchButton.props.children, '搜索')
// Native quote remains functional.
const shippedButton = quoteElement.type(quoteElement.props)
assert.equal(shippedButton.props['aria-label'], '引用文本')
shippedButton.props.onClick()
assert.deepEqual(quoteInserts, ['页分裂'])
assert.equal(cleared, 1)
assert.equal(dismissals, 1)

// Clicking search: once, with the full Atlas source context, native selection contract honoured.
cleared = 0; dismissals = 0
searchButton.props.onClick()
assert.equal(searches.length, 1)
assert.equal(cleared, 1, 'clearSelection() from the native surface')
assert.equal(dismissals, 1, 'dismiss() closes the single surface')
const source = searches[0].source
assert.equal(source.sessionId, 'main')
assert.equal(source.messageKey, 'm1')
assert.equal(source.text, '页分裂')
assert.deepEqual([source.start, source.end], [3, 6])
assert.match(source.paragraph, /页分裂/)
assert.ok(captureSelection(dom.window.getSelection()))
// Re-selection without a click still sends nothing.
current.uiConversation.interactions.dispatch({ trigger: 'selection', readText: () => '页分裂', preventDefault() {} })
assert.equal(searches.length, 1, 'repeated selection never starts a model request')

select(paragraph.firstChild, 3, paragraph.firstChild, 4)
Action(surfaceProps({ readText: () => '页' })).props.children[1].props.onClick()
assert.equal(searches.length, 2, 'a single selected character opens a temporary chat')
assert.equal(searches.at(-1).source.text, '页')

// Excluded areas: composer, tool cards, thinking, and Atlas temp chat must not trigger search.
const message = document.querySelector('[data-chat-node-key="m1"]')
const excluded = [
  { label: 'composer', html: '<div contenteditable="true"><p>页分裂输入框</p></div>' },
  { label: 'think', html: '<div data-variant="think"><p>页分裂推理</p></div>' },
  { label: 'tool', html: '<div data-chat-node-key="tool"><p>页分裂工具卡片</p></div>' },
]
for (const item of excluded) {
  const holder = document.createElement('div')
  holder.innerHTML = item.html
  message.append(holder)
  select(holder.querySelector('p').firstChild, 0)
  assert.equal(captureSelection(dom.window.getSelection()), undefined, `${item.label} is outside the selection policy`)
  const before = searches.length
  Action(surfaceProps({ readText: () => '页分裂' })).props.children[1].props.onClick()
  assert.equal(searches.length, before, `${item.label} must not open a temporary chat`)
  holder.remove()
}
select(paragraph.firstChild, 3)
const tempChat = document.createElement('div')
tempChat.dataset.atlasSelectionChat = ''
tempChat.innerHTML = '<div data-conversation-session="temp"><div data-chat-node-key="m3" data-chat-flow-kind="assistant-step"><p>页分裂临时回答</p></div></div>'
document.body.append(tempChat)
const tempParagraph = tempChat.querySelector('p')
select(tempParagraph.firstChild, 0)
const beforeTemp = searches.length
Action(surfaceProps({ readText: () => '页分裂' })).props.children[1].props.onClick()
assert.equal(searches.length, beforeTemp, 'temporary chat itself must not trigger search')
tempChat.remove()
select(paragraph.firstChild, 3)

// Context-menu gestures do not open a temporary chat.
const beforeMenu = searches.length
Action(surfaceProps({ trigger: 'contextmenu' })).props.children[1].props.onClick()
assert.equal(searches.length, beforeMenu)

dispose()
assert.equal(current.slots.entries(SLOT).length, 1, 'disposal restores the shipped cell only')
setNativeSearchHandler(undefined)

// Mutual exclusion at the plugin entry point (built client module).
const { apply } = await load('src/client/index.tsx', 'browser')
function applyFor(native) {
  const ctx = makeContext(native)
  if (native) installShipped(ctx)
  apply(ctx)
  const overlay = ctx.injections.find(entry => entry.name === 'shell.overlay')
  assert.ok(overlay)
  overlay.register()
  const cell = ctx.registrations.find(entry => entry.options.id === 'atlas-selection-chat')
  assert.ok(cell)
  const injected = cell.options.inject()
  const before = injected.nativeMode()
  const declarations = ctx.injections.filter(entry => entry.name === SLOT)
  for (const declaration of declarations) declaration.register()
  return { ctx, before, nativeMode: injected.nativeMode(), declarations }
}
const legacy = applyFor(false)
assert.equal(legacy.before, false)
assert.equal(legacy.nativeMode, false, 'legacy keeps the standalone entry')
assert.equal(legacy.ctx.slots.entries(SLOT).some(entry => entry.options.priority === -10), false, 'legacy never registers a native cell')
const modern = applyFor(true)
assert.equal(modern.before, false, 'native mode activates only when the slot is declared')
assert.equal(modern.nativeMode, true)
assert.equal(modern.declarations.length, 1, 'new host registers exactly one native cell')
assert.equal(modern.ctx.slots.entries(SLOT).filter(entry => entry.options.priority === -10).length, 1)
assert.equal(supportsNativeSelection(modern.ctx), true)

// Fatal executor message must not offer a retry button.
const chat = await readFile(new URL('../src/client/SelectionChat.tsx', import.meta.url), 'utf8')
assert.match(chat, /工具执行器初始化失败/)
assert.match(chat, /!fatal && <button/)
assert.match(chat, /!nativeActive && candidate/, 'legacy standalone button is gated off in native mode')
assert.match(chat, /listenSelections\(nativeActive \?/, 'legacy selection listener cannot open a second surface')
assert.match(chat, /useSyncExternalStore\(subscribeNativeSelection/, 'entry switching is reactive to slot declaration')
const host = await readFile(new URL('../src/host/selection-memory.ts', import.meta.url), 'utf8')
assert.match(host, /dsh-tool-executor-native/)
assert.match(host, /setExecutor/)
assert.match(host, /restrict\(\{ allow: \[\] \}\)/)
assert.match(host, /guard\(/)
assert.match(host, /await import\(specifier\)/, 'new-version module is loaded dynamically only on the new host')
assert.equal(chat.includes("from '@deepseek-ai/dsh-tool-executor-native'"), false, 'no static import breaks legacy plugin loading')
const nativeSource = await readFile(new URL('../src/client/native-selection.tsx', import.meta.url), 'utf8')
assert.match(nativeSource, /ctx\.get\?\.\('uiConversation'\)/, 'capability probe uses inject-free service read')
assert.equal(/\bctx\.uiConversation\?\.interactions/.test(nativeSource), false, 'direct service access would throw without inject')

// Behavioural: when a host exposes setExecutor but the executor package is
// missing, the failure is explicit, actionable and non-retryable.
const { Context } = await import('@deepseek-ai/cordis')
const LlmRuntime = (await import('@deepseek-ai/dsh-llm')).default
const ToolRuntime = (await import('@deepseek-ai/dsh-tools')).default
const { SelectionMemoryRuntime } = await load('src/host/selection-memory.ts')
const root = new Context()
await root.plugin(LlmRuntime)
const toolsPrototype = ToolRuntime.prototype
const hadSetExecutor = 'setExecutor' in toolsPrototype
const originalSetExecutor = toolsPrototype.setExecutor
toolsPrototype.setExecutor = () => {}
try {
  const broken = new SelectionMemoryRuntime(root.llm, () => ({ provider: 'fixture', model: 'fixture' }))
  await assert.rejects(broken.create('atlas-executor-missing', '/tmp'), error => {
    assert.match(error.message, /工具执行器初始化失败/)
    assert.match(error.message, /dsh-tool-executor-native/)
    assert.match(error.message, /重试临时搜索不会恢复/)
    return true
  })
  await broken.dispose()
} finally {
  if (hadSetExecutor) toolsPrototype.setExecutor = originalSetExecutor
  else delete toolsPrototype.setExecutor
  await root.fiber.dispose()
}

dom.window.close()
console.log('Native selection entry: new/legacy mutual exclusion, one surface, shipped quote intact, zero selection requests, one click with full context, DOM exclusions, executor failure message passed')
