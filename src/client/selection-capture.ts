import { sourceKey, type SelectionSource } from '../shared/selection-chat.js'

const SESSION = '[data-conversation-session]'
const MESSAGE = '[data-chat-node-key]'
const EXCLUDED = '[data-atlas-selection-chat],input,textarea,[contenteditable="true"],button,[role="button"],[role="menu"],[data-message-attachments],[data-variant="think"],[data-slot="conversation.chat.reasoning.body"],[data-slot="conversation.chat.reasoning.content"],[data-submission-echo],[data-pending-steering],[data-context-text],[data-approval-key]'
const elementOf = (node: Node): Element | null => node instanceof Element ? node : node.parentElement

export interface CapturedSelection { source: SelectionSource; rect: { x: number; y: number; bottom: number } }

/** All dependence on the native semantic DOM lives here; no renderer replacement. */
export function captureSelection(selection: Selection | null): CapturedSelection | undefined {
  if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return
  const range = selection.getRangeAt(0)
  const first = elementOf(range.startContainer)
  const last = elementOf(range.endContainer)
  if (!first || !last || first.closest(EXCLUDED) || last.closest(EXCLUDED)) return
  const message = first.closest(MESSAGE)
  const container = first.closest(SESSION)
  if (!message || !container || !message.isConnected || !container.isConnected || container.getAttribute('data-conversation-session') !== visibleSession() || last.closest(MESSAGE) !== message || last.closest(SESSION) !== container) return
  const kind = message.getAttribute('data-chat-flow-kind')
  if (kind !== 'user' && kind !== 'assistant-step') return
  if (message.getAttribute('data-chat-group-part') === 'reasoning') return
  // Only text presentation: Markdown or the native sent-user text Factory.
  const BODY = kind === 'user' ? '[data-slot="conversation.user.text.node"]' : 'p,li,blockquote,h1,h2,h3,h4,h5,h6,td,th,pre:has(code)'
  if (!first.closest(BODY) || !last.closest(BODY)) return
  // Range endpoints alone cannot reject a tool/reasoning card crossed in its middle.
  for (const el of message.querySelectorAll(`${EXCLUDED},[data-chat-node-key]`)) {
    if (range.intersectsNode(el)) return
  }
  const text = range.toString().trim()
  if ([...text].length < 2 || [...text].length > 200) return
  const prefix = range.cloneRange()
  prefix.selectNodeContents(message)
  prefix.setEnd(range.startContainer, range.startOffset)
  const start = prefix.toString().length
  const paragraph = first.closest('p,li,pre,blockquote') ?? first.closest(BODY)!
  const contextRange = range.cloneRange()
  contextRange.selectNodeContents(paragraph)
  const lastParagraph = last.closest('p,li,pre,blockquote') ?? last.closest(BODY)!
  if (lastParagraph !== paragraph) contextRange.setEndAfter(lastParagraph)
  const paragraphPrefix = contextRange.cloneRange()
  paragraphPrefix.setEnd(range.startContainer, range.startOffset)
  const offset = paragraphPrefix.toString().length
  const context = contextRange.toString()
  const contextStart = Math.max(0, offset - 450)
  const rect = range.getBoundingClientRect()
  return { source: { sessionId: container.getAttribute('data-conversation-session')!, messageKey: message.getAttribute('data-chat-node-key')!, text, start, end: start + range.toString().length, paragraph: context.slice(contextStart, contextStart + 1200) }, rect: { x: rect.x, y: rect.y, bottom: rect.bottom } }
}

export function visibleSession(): string | undefined {
  return [...document.querySelectorAll<HTMLElement>(SESSION)].find(el => !el.closest('[data-atlas-selection-chat]') && el.getClientRects().length > 0)?.dataset.conversationSession
}

export function listenSelections(open: (selection: CapturedSelection) => void, switched: (id?: string) => void): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined
  let lastKey = ''
  let current = visibleSession()
  let disposed = false
  const capture = () => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      const value = captureSelection(window.getSelection())
      if (!value) { lastKey = ''; return }
      const key = sourceKey(value.source)
      if (key === lastKey) return
      lastKey = key
      open(value)
    }, 120)
  }
  let selecting = false
  const pointerDown = (event: PointerEvent) => {
    const target = elementOf(event.target as Node)
    selecting = event.button === 0 && !!target?.closest(MESSAGE) && !target.closest(EXCLUDED)
  }
  const pointer = (event: PointerEvent) => {
    const startedInMessage = selecting
    selecting = false
    if (!startedInMessage || event.button !== 0) return
    lastKey = '' // a deliberate repeat selection reopens a collapsed window
    capture()
  }
  const keyboard = (event: KeyboardEvent) => { if (elementOf(event.target as Node)?.closest(EXCLUDED)) return; if (event.key === 'Shift' || event.shiftKey && /Arrow|Home|End/.test(event.key)) capture() }
  const checkSession = () => {
    if (disposed) return
    const id = visibleSession()
    if (id !== current) { current = id; lastKey = ''; switched(id) }
  }
  const observer = new MutationObserver(records => {
    // Ignore chunk text changes; only a native container replacement or identity matters.
    if (records.some(r => r.type === 'attributes' || [...r.addedNodes, ...r.removedNodes].some(n => n instanceof Element && (n.matches(SESSION) || n.querySelector(SESSION))))) checkSession()
  })
  observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-conversation-session'] })
  document.addEventListener('pointerdown', pointerDown)
  document.addEventListener('pointerup', pointer)
  document.addEventListener('keyup', keyboard)
  return () => { disposed = true; clearTimeout(timer); observer.disconnect(); document.removeEventListener('pointerdown', pointerDown); document.removeEventListener('pointerup', pointer); document.removeEventListener('keyup', keyboard) }
}
