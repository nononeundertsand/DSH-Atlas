import { createElement } from 'react'
import type { ClientContext } from '../shared/dsh.js'
import { captureSelection, visibleSession, type CapturedSelection } from './selection-capture.js'

const SLOT = 'conversation.chat.text-interaction'
const QUOTE_KEY = 'quote'
/**
 * Real 0.2.2-rc.1 contract (app.asar):
 * - `uiConversation.interactions.dispatch` returns the first handler that calls `open()`.
 * - Chat renders `renderSlot(SLOT, ownerProps, { entryKey: active.id })`; keyed cells
 *   are deduplicated by key, keeping the lowest `priority`.
 * - message-quotes owns id/key `quote` at the default priority 0.
 * Taking the `quote` cell at a lower priority therefore wins that one surface without
 * hiding its action: the shipped cell is still in `slots.entries()` and is composed below.
 */
const ATLAS_PRIORITY = -10
const QUOTE_LOCALE = 'messageQuotes'

interface SurfaceProps extends Record<string, unknown> {
  trigger?: 'selection' | 'contextmenu'
  sessionId?: string
  readText?: () => string | null
  dismiss?: () => void
  clearSelection?: () => void
  t?: (key: string) => string
}

let searchHandler: ((selection: CapturedSelection) => void) | undefined
export function setNativeSearchHandler(handler?: (selection: CapturedSelection) => void): void {
  searchHandler = handler
}
export function invokeNativeSearch(selection: CapturedSelection): void {
  searchHandler?.(selection)
}

// The slot is declared later than plugin `apply`, so activate when it is actually
// mounted. SelectionChat subscribes, which keeps exactly one entry enabled.
let active = false
const listeners = new Set<() => void>()
export function nativeSelectionActive(): boolean { return active }
export function subscribeNativeSelection(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
function setActive(value: boolean): void {
  if (active === value) return
  active = value
  for (const listener of listeners) listener()
}

/** Only the new DSH exposes the text-interaction registry and raw slot cells.
 * `ctx.uiConversation` cannot be read directly: Cordis throws
 * "cannot get property ... without inject" unless the plugin declares it, and
 * declaring it would prevent the plugin from ever activating on legacy hosts.
 * `ctx.get()` reads the service without that requirement. */
export function supportsNativeSelection(ctx: ClientContext): boolean {
  const ui = ctx.get?.('uiConversation') as { interactions?: { register?: unknown } } | undefined
  return typeof ui?.interactions?.register === 'function' && typeof ctx.slots?.entries === 'function'
}

/** The shipped quote cell stays registered; raw `entries` keeps it after our priority wins. */
function shippedQuoteCell(ctx: ClientContext): unknown {
  return ctx.slots.entries?.(SLOT).find(cell => cell.options.key === QUOTE_KEY && cell.options.priority !== ATLAS_PRIORITY)?.component
}

/** Behaves exactly like the shipped QuoteSelectionAction when its cell is not
 * yet visible in `entries()` (registration order). Uses the same native props. */
function FallbackQuote(props: SurfaceProps) {
  const label = props.t?.('quote.add') ?? '引用文本'
  const quote = () => {
    const text = props.readText?.() ?? null
    if (text === null) { props.dismiss?.(); return }
    const input = props.inputActions as { insertQuote?(text: string): boolean } | undefined
    if (!input?.insertQuote?.(text)) return
    props.clearSelection?.()
    props.dismiss?.()
  }
  return createElement('button', {
    type: 'button', className: 'atlas-selection-native-action', 'aria-label': label,
    onPointerDown: (event: { preventDefault(): void }) => event.preventDefault(),
    onClick: quote,
  }, label)
}

function createAction(ctx: ClientContext) {
  return function AtlasTextInteraction(props: SurfaceProps) {
    const QuoteAction = shippedQuoteCell(ctx)
    const search = () => {
      // The native request only carries text; Atlas needs the message identity,
      // offsets and visible paragraph from the DOM selection.
      const captured = captureSelection(window.getSelection())
      const text = props.readText?.()
      if (!captured || text === null || text === undefined || props.trigger === 'contextmenu' || visibleSession() !== captured.source.sessionId || (typeof props.sessionId === 'string' && props.sessionId !== captured.source.sessionId)) {
        props.dismiss?.()
        return
      }
      props.clearSelection?.()
      props.dismiss?.()
      invokeNativeSearch(captured)
    }
    return createElement('div', { className: 'atlas-selection-native-actions' },
      QuoteAction ? createElement(QuoteAction as never, props) : createElement(FallbackQuote, props),
      createElement('button', {
        type: 'button', className: 'atlas-selection-native-action',
        'aria-label': '在临时会话中解释选中的文本', title: '在临时会话中解释选中的文本',
        onPointerDown: (event: { preventDefault(): void }) => event.preventDefault(),
        onClick: search,
      }, '搜索'),
    )
  }
}

/** Register the one Atlas cell. Independent fixed-position entry is disabled by the caller. */
export function registerNativeSelection(ctx: ClientContext): void {
  const Action = createAction(ctx)
  ctx.slots.inject(SLOT, () => {
    // Legacy DSH never declares this slot; the shipped `quote` cell is composed
    // from raw `entries()` only after the new registry is really present.
    if (!supportsNativeSelection(ctx)) return
    const dispose = ctx.slots.register(
      { name: SLOT, key: QUOTE_KEY, priority: ATLAS_PRIORITY, locale: QUOTE_LOCALE },
      Action,
    )
    setActive(true)
    return () => { dispose(); setActive(false) }
  })
}

/**
 * One unified pill instead of two separate floating buttons. Child selectors beat
 * the shipped `.IPIy-a_action` class, so both the native quote button and Atlas's
 * button become plain text cells with a single divider between them.
 * Override `--atlas-selection-surface` to change the container colour.
 */
export const NATIVE_SELECTION_CSS = `
.atlas-selection-native-actions{--atlas-selection-surface:var(--dsw-alias-button-floating-fill);--dsw-elevation-stroke-color:var(--dsw-alias-border-l3);display:inline-flex;align-items:stretch;gap:0;background:var(--atlas-selection-surface);box-shadow:var(--dsw-elevation-panel);color:var(--dsw-alias-label-primary);font:var(--dsw-font-xs-13);border-radius:999px;overflow:hidden;white-space:nowrap}
.atlas-selection-native-actions>button,.atlas-selection-native-actions>button.atlas-selection-native-action{background:transparent;box-shadow:none;border:0;border-radius:0;margin:0;padding:7px 16px;color:inherit;font:inherit;cursor:pointer;white-space:nowrap}
.atlas-selection-native-actions>button+button{position:relative}
.atlas-selection-native-actions>button+button::before{content:"";position:absolute;left:0;top:24%;bottom:24%;width:1px;background:var(--dsw-alias-border-l3);pointer-events:none}
.atlas-selection-native-actions>button:hover{background:var(--dsw-alias-button-floating-hover)}
.atlas-selection-native-actions>button:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:-2px;background:var(--dsw-alias-button-floating-hover)}
@media (hover:hover){.atlas-selection-native-actions>button:hover{background:var(--dsw-alias-button-floating-hover)}}
`
