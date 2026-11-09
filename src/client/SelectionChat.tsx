import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ClientContext, NativeBinding } from '../shared/dsh.js'
import { sourceKey, type TemporarySession } from '../shared/selection-chat.js'
import { listenSelections, visibleSession, type CapturedSelection } from './selection-capture.js'
import { chatRows, connectMemorySession, lastTurnError, selectionRequest } from './selection-sessions.js'
import { Markdown } from './markdown.js'
import { setNativeSearchHandler, subscribeNativeSelection } from './native-selection.js'

interface Conversation {
  selection: CapturedSelection
  id: string
  closed: boolean
  draft: string
  temporary?: TemporarySession
  opening?: Promise<void>
  initialSent: boolean
  error?: string
  pendingSend?: { text: string; requestId: string }
  sending: boolean
  x: number
  y: number
  expanded: boolean
}

const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error)

export function SelectionChat({ ctx, nativeMode = () => false }: { ctx: ClientContext; nativeMode?: () => boolean }) {
  // The native slot is declared after this overlay mounts; subscribe so the two
  // entries can never be enabled at the same time.
  const nativeActive = useSyncExternalStore(subscribeNativeSelection, nativeMode)
  const workspaceState = useSyncExternalStore(listener => ctx.workspaces.list.subscribe(listener), () => ctx.workspaces.list.getSnapshot())
  const [pageId] = useState(() => crypto.randomUUID())
  const activeRef = useRef<Conversation>()
  const [candidate, setCandidate] = useState<CapturedSelection>()
  const dismissCandidate = useCallback(() => setCandidate(undefined), [])
  const [active, setActive] = useState<Conversation>()
  const [, update] = useState(0)
  const repaint = () => update(n => n + 1)
  const [connection, setConnection] = useState<{ id: string; value: NativeBinding }>()
  const binding = connection?.id === active?.temporary?.sessionId ? connection?.value : undefined
  const [connectionVersion, reconnect] = useState(0)
  const [, feedChanged] = useState(0)
  const root = useRef<HTMLElement>(null)
  const transcript = useRef<HTMLDivElement>(null)
  const alive = useRef(true)
  const notify = () => { if (alive.current) repaint() }

  const release = useCallback((conversation: Conversation | undefined) => {
    if (!conversation || conversation.closed) return
    conversation.closed = true
    conversation.draft = ''
    const data = JSON.stringify({ pageId, conversationId: conversation.id })
    const url = '/ext/atlas/selection-chat/close'
    if (!navigator.sendBeacon?.(url, new Blob([data], { type: 'application/json' }))) void fetch(url, { method: 'POST', body: data, headers: { 'content-type': 'application/json' }, keepalive: true }).catch(() => {})
  }, [pageId])
  const closeCurrent = useCallback(() => {
    release(activeRef.current)
    activeRef.current = undefined
    setActive(undefined)
  }, [release])

  async function ensure(conversation: Conversation): Promise<void> {
    if (conversation.opening) return conversation.opening
    conversation.error = undefined
    conversation.opening = (async () => {
      conversation.sending = true
      try {
        const temporary = await selectionRequest<TemporarySession>('', { pageId, conversationId: conversation.id, source: conversation.selection.source })
        if (conversation.closed || !alive.current) return
        conversation.temporary = temporary
        conversation.initialSent = true
      } catch (error) { if (!conversation.closed) conversation.error = messageOf(error) }
      finally { conversation.sending = false; conversation.opening = undefined; notify() }
    })()
    notify()
    return conversation.opening
  }

  function searchSelection(selection: CapturedSelection) {
    setCandidate(undefined)
    if (visibleSession() !== selection.source.sessionId) return
    const current = activeRef.current
    if (current && !current.closed && sourceKey(current.selection.source) === sourceKey(selection.source)) { root.current?.focus(); return }
    release(current)
    const conversation: Conversation = { id: crypto.randomUUID(), closed: false, selection, draft: '', initialSent: false, sending: false, expanded: false, x: selection.rect.x, y: selection.rect.bottom + 10 }
    activeRef.current = conversation
    setActive(conversation)
    void ensure(conversation)
  }
  const nativeSearch = useRef<(selection: CapturedSelection) => void>(() => {})
  nativeSearch.current = searchSelection

  useEffect(() => {
    if (!nativeActive) return
    setNativeSearchHandler(selection => nativeSearch.current(selection))
    return () => setNativeSearchHandler(undefined)
  }, [nativeActive])

  useEffect(() => {
    alive.current = true
    const stop = listenSelections(nativeActive ? () => {} : setCandidate, () => { setCandidate(undefined); closeCurrent() })
    const unload = () => { setCandidate(undefined); closeCurrent() }
    window.addEventListener('pagehide', unload)
    return () => {
      alive.current = false; stop(); window.removeEventListener('pagehide', unload)
      release(activeRef.current); activeRef.current = undefined
    }
  }, [closeCurrent, release, nativeActive])

  useEffect(() => {
    setConnection(undefined)
    if (!active?.temporary) return
    const conversation = active
    const temporary = active.temporary
    let disposed = false
    let reference: ReturnType<typeof connectMemorySession> | undefined
    let stopFeed: (() => void) | undefined
    let stopState: (() => void) | undefined
    void (async () => {
      try {
        await selectionRequest(`/${encodeURIComponent(conversation.selection.source.sessionId)}`)
        await selectionRequest(`/${encodeURIComponent(temporary.sessionId)}`)
        if (disposed) return
        reference = connectMemorySession(temporary.sessionId)
        const value = await reference.ready
        if (disposed) return
        setConnection({ id: temporary.sessionId, value })
        const changed = () => { if (!disposed) feedChanged(n => n + 1) }
        stopFeed = value.eventSource.subscribe(changed)
        stopState = value.session.subscribe(changed)
      } catch (error) { if (!disposed) { conversation.error = messageOf(error); notify() } }
    })()
    return () => { disposed = true; stopFeed?.(); stopState?.(); reference?.release() }
  }, [active, active?.temporary?.sessionId, connectionVersion])

  const snapshot = binding?.session.getSnapshot()
  const rows = binding && active?.temporary ? chatRows(binding.eventSource.getSnapshot().entries, active.temporary.requestId) : []
  const running = snapshot?.running || active?.sending
  const [viewport, setViewport] = useState({ width: window.innerWidth, height: window.innerHeight })
  useEffect(() => {
    const resize = () => setViewport({ width: window.innerWidth, height: window.innerHeight })
    window.addEventListener('resize', resize)
    return () => window.removeEventListener('resize', resize)
  }, [])
  useEffect(() => {
    root.current?.focus({ preventScroll: true })
  }, [active])
  useEffect(() => {
    const el = transcript.current
    if (el) el.scrollTop = el.scrollHeight
  }, [binding])
  useEffect(() => {
    const el = transcript.current
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 180) el.scrollTop = el.scrollHeight
  }, [rows.at(-1)?.text, active])

  const selectionAction = !nativeActive && candidate && <SelectionSearch selection={candidate} onSearch={() => searchSelection(candidate)} onDismiss={dismissCandidate} />
  if (!active) return selectionAction
  const conversation = active
  const width = Math.min(active.expanded ? 880 : 500, viewport.width - 16)
  const height = Math.min(active.expanded ? viewport.height - 32 : 530, viewport.height - 16)
  const x = Math.max(8, Math.min(active.x, viewport.width - width - 8))
  const y = Math.max(8, Math.min(active.y, viewport.height - height - 8))
  const unavailable = snapshot?.removed || conversation.error?.includes('归档') || workspaceState.archivedSessionIds.includes(conversation.selection.source.sessionId)
  const error = conversation.error ?? snapshot?.openError?.message ?? snapshot?.lastAgentError ?? (binding && !running ? lastTurnError(binding.eventSource.getSnapshot().entries) : undefined)
  // An unloadable executor is a deployment/config fault: retrying cannot fix it.
  const fatal = !!error && /工具执行器初始化失败/.test(error)

  async function send(retryPending = false) {
    if (!binding || conversation.sending || snapshot?.running || unavailable) return
    const pending = conversation.pendingSend && (retryPending || conversation.pendingSend.text === conversation.draft.trim()) ? conversation.pendingSend : { text: conversation.draft.trim(), requestId: crypto.randomUUID() }
    if (!pending.text) return
    conversation.pendingSend = pending
    conversation.sending = true
    conversation.error = undefined
    notify()
    try {
      await selectionRequest(`/${encodeURIComponent(conversation.selection.source.sessionId)}`)
      await selectionRequest(`/${encodeURIComponent(conversation.temporary!.sessionId)}`)
      const result = await binding.session.prompt([{ type: 'text', text: pending.text }], 'queue', undefined, pending.requestId)
      if (!result.ok) throw new Error(result.error?.message ?? '消息发送失败')
      if (conversation.draft.trim() === pending.text) conversation.draft = ''
      conversation.pendingSend = undefined
    } catch (error) { conversation.error = messageOf(error) }
    finally { conversation.sending = false; notify() }
  }

  async function retry() {
    if (fatal) return
    if (!conversation.temporary) { await ensure(conversation); return }
    conversation.error = undefined
    if (conversation.pendingSend) { await send(true); return }
    // A rejected first admission keeps its original request identity.
    if (!conversation.initialSent) { await ensure(conversation); reconnect(n => n + 1); return }
    if (!binding || snapshot?.openState === 'error') { reconnect(n => n + 1); return }
    try {
      await binding?.session.resync()
      if (error || !rows.some(row => row.role === 'assistant')) {
        conversation.pendingSend = { text: '请继续回答上一条问题。', requestId: crypto.randomUUID() }
        await send(true)
      }
    } catch (error) { conversation.error = messageOf(error) }
    notify()
  }

  return <>{selectionAction}<section ref={root} tabIndex={-1} role="dialog" aria-label={`${active.selection.source.text} · 临时会话`} data-atlas-selection-chat="" data-temporary-session={active.temporary?.sessionId} className="atlas-selection-chat" style={{ left: x, top: y, width, height }}
    onKeyDown={event => {
      if (event.key !== 'Escape') return
      if (document.querySelector('[role="menu"],[role="listbox"],[data-state="open"][role="dialog"]')) { event.stopPropagation(); return }
      event.preventDefault(); event.stopPropagation(); closeCurrent()
    }} onWheel={event => event.stopPropagation()}>
    <header onPointerDown={event => {
      if ((event.target as Element).closest('button') || event.button !== 0) return
      const el = event.currentTarget
      el.setPointerCapture(event.pointerId)
      const start = { x: event.clientX, y: event.clientY }
      const move = (e: PointerEvent) => { conversation.x = Math.max(8, Math.min(x + e.clientX - start.x, viewport.width - width - 8)); conversation.y = Math.max(8, Math.min(y + e.clientY - start.y, viewport.height - height - 8)); notify() }
      const end = () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', end); el.removeEventListener('pointercancel', end); el.removeEventListener('lostpointercapture', end) }
      el.addEventListener('pointermove', move); el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end); el.addEventListener('lostpointercapture', end)
      event.preventDefault()
    }}>
      <span aria-hidden="true">⠿</span><strong title={active.selection.source.text}>{active.selection.source.text}</strong><small>临时会话</small>
      <button aria-label={active.expanded ? '还原临时会话' : '展开临时会话'} onClick={() => { active.expanded = !active.expanded; repaint() }}>{active.expanded ? '↙' : '↗'}</button>
      <button aria-label="关闭临时会话" onClick={closeCurrent}>×</button>
    </header>
    <blockquote><b>来自主对话</b><span title={active.selection.source.paragraph}>{active.selection.source.paragraph}</span></blockquote>
    <div ref={transcript} className="atlas-selection-transcript" aria-label="临时会话记录">
      {!binding && !error && <p role="status">正在连接 DSH 临时会话…</p>}
      {rows.map(row => <div key={row.key} data-role={row.role} className="atlas-selection-row"><small>{row.role === 'assistant' ? 'AI 解释' : '你'}</small><div>{row.role === 'assistant' ? <Markdown text={row.text} /> : row.text}</div></div>)}
      {running && <p role="status">正在回答…</p>}
      {!running && binding && active.initialSent && !rows.some(row => row.role === 'assistant') && !error && <p role="status">尚无文字回复。可以继续提问，或重试连接。</p>}
      {unavailable && <p role="alert">来源会话不可用，或本次会话已清空。临时内容不会保存。</p>}
      {error && <p role="alert">{error} {!fatal && <button disabled={!!running} onClick={() => void retry()}>重试</button>}</p>}
      {!fatal && snapshot?.openState === 'error' && !error && <button onClick={() => void retry()}>重新连接</button>}
    </div>
    <form onSubmit={event => { event.preventDefault(); void send() }}>
      <textarea aria-label="临时会话追问" placeholder={`围绕「${active.selection.source.text}」继续追问…`} value={active.draft} onChange={event => { active.draft = event.target.value; repaint() }} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send() } }} />
      {running ? <button type="button" aria-label="停止临时回复" disabled={!binding || !snapshot?.running} onClick={() => void binding?.session.cancel().then(result => { if (!result.ok) throw new Error(result.error?.message); }).catch(error => { active.error = messageOf(error); notify() })}>■</button> : <button type="submit" aria-label="发送临时追问" disabled={!binding || !active.initialSent || !!unavailable || !active.draft.trim()}>↑</button>}
    </form>
    <footer>仅本次使用 · 关闭即清空 {!fatal && <button type="button" onClick={() => void retry()}>重新连接</button>}</footer>
  </section></>
}

/** Selection alone is UI-only: creating/sending a Session requires this action. */
function SelectionSearch({ selection, onSearch, onDismiss }: { selection: CapturedSelection; onSearch: () => void; onDismiss: () => void }) {
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) onDismiss() }
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault(); event.stopImmediatePropagation(); onDismiss()
    }
    document.addEventListener('pointerdown', outside, true)
    root.current?.addEventListener('keydown', escape)
    window.addEventListener('scroll', onDismiss, true)
    window.addEventListener('resize', onDismiss)
    const element = root.current
    return () => {
      document.removeEventListener('pointerdown', outside, true)
      element?.removeEventListener('keydown', escape)
      window.removeEventListener('scroll', onDismiss, true)
      window.removeEventListener('resize', onDismiss)
    }
  }, [selection, onDismiss])
  const left = Math.max(8, Math.min(selection.rect.x, window.innerWidth - 88))
  const top = Math.max(8, Math.min(selection.rect.bottom + 6, window.innerHeight - 48))
  return <div ref={root} role="toolbar" aria-label="划词操作" data-atlas-selection-chat="" className="atlas-selection-search" style={{ left, top }}>
    <button autoFocus type="button" title={`在临时会话中解释「${selection.source.text}」`} onPointerDown={event => event.preventDefault()} onClick={onSearch}>搜索</button>
  </div>
}

export const SELECTION_CHAT_CSS = `
.atlas-selection-search{position:fixed;z-index:51;pointer-events:auto;padding:4px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l1);border-radius:10px;box-shadow:0 4px 18px #0003}.atlas-selection-search button{display:block;padding:5px 16px;border:0;border-radius:6px;background:transparent;color:inherit;font:14px/1.5 var(--dsh-font-family-ui,system-ui);cursor:pointer}.atlas-selection-search button:hover{background:var(--dsw-alias-interactive-bg-hover)}.atlas-selection-search button:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}

.atlas-selection-chat{position:fixed;z-index:50;box-sizing:border-box;display:flex;flex-direction:column;min-width:0;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);border-radius:16px;box-shadow:0 12px 44px #0004;font:14px/1.6 var(--dsh-font-family-ui,system-ui);outline:none;overflow:hidden;pointer-events:auto}
.atlas-selection-chat *{box-sizing:border-box}.atlas-selection-chat button{font:inherit;color:inherit;border:0;border-radius:8px;background:transparent;cursor:pointer;padding:3px 8px}.atlas-selection-chat button:hover{background:var(--dsw-alias-interactive-bg-hover)}.atlas-selection-chat button:disabled{opacity:.4;cursor:default}
.atlas-selection-chat header{display:flex;align-items:center;gap:8px;padding:10px 14px;cursor:grab;touch-action:none;flex:none;user-select:none}.atlas-selection-chat header strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:65%}.atlas-selection-chat header small{white-space:nowrap;background:var(--dsw-alias-interactive-bg-hover);border-radius:8px;padding:0 6px}.atlas-selection-chat header button:first-of-type{margin-left:auto}.atlas-selection-chat header button{font-size:22px;line-height:1}
.atlas-selection-chat blockquote{display:flex;gap:12px;margin:0 14px 8px;padding:7px 10px;border-left:4px solid var(--dsw-alias-state-business-primary,#7379ee);border-radius:6px;background:var(--dsw-alias-interactive-bg-hover);font-size:12px;flex:none;max-height:58px;overflow:hidden}.atlas-selection-chat blockquote b{color:var(--dsw-alias-state-business-primary);white-space:nowrap}.atlas-selection-chat blockquote span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.atlas-selection-transcript{flex:1;min-height:0;overflow:auto;overscroll-behavior:contain;padding:8px 16px;scrollbar-width:thin}.atlas-selection-row{margin-bottom:14px;white-space:pre-wrap;overflow-wrap:anywhere}.atlas-selection-row>small{display:block;color:var(--dsw-alias-label-tertiary);font-size:11px}.atlas-selection-row>div{border-radius:12px;background:var(--dsw-alias-interactive-bg-hover);padding:8px 12px;width:fit-content;max-width:94%}.atlas-selection-row[data-role=user]{display:flex;flex-direction:column;align-items:flex-end}.atlas-selection-row[data-role=user]>div{background:var(--dsw-specific-bubble,var(--dsw-alias-interactive-bg-hover))}.atlas-selection-row p{margin:0 0 8px}.atlas-selection-row p:last-child{margin-bottom:0}.atlas-selection-row pre{white-space:pre-wrap;overflow:auto}.atlas-selection-chat [role=alert]{color:var(--dsw-alias-state-error-primary);overflow-wrap:anywhere}
.atlas-selection-chat form{display:flex;gap:6px;align-items:flex-end;margin:8px 14px 0;padding:6px;border:1px solid var(--dsw-alias-border-l1);border-radius:14px;background:var(--dsw-specific-input-major);flex:none}.atlas-selection-chat textarea{resize:none;min-width:0;flex:1;max-height:100px;height:58px;border:0;background:transparent;color:inherit;font:inherit;padding:4px 6px;outline:none}.atlas-selection-chat form button{background:var(--dsw-alias-state-business-primary,#626ae6);color:white;border-radius:50%;width:32px;height:32px;margin-bottom:2px}.atlas-selection-chat footer{font-size:11px;color:var(--dsw-alias-label-tertiary);text-align:center;padding:3px 10px 8px;flex:none}
`
