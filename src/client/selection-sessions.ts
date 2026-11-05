import { textOnly, type SessionEvent } from '../shared/selection-chat.js'

export async function selectionRequest<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch('/ext/atlas/selection-chat' + path, body === undefined ? undefined : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const result = await response.json()
  if (!response.ok) throw new Error(result.error?.message ?? `DSH 请求失败 (${response.status})`)
  return result as T
}

export interface ChatRow { key: string; role: 'user' | 'assistant'; text: string }
/** A presentation fold of DSH's event feed, including its reconnect stream baseline. */
export function chatRows(entries: Array<{ event: SessionEvent }>, initialRequest: string): ChatRow[] {
  const rows: ChatRow[] = []
  const attempts = new Map<string, { row: ChatRow; textBlocks: Set<number> }>()
  for (const { event } of entries) {
    if (event.type === 'user/message') {
      if (event.data.source?.kind !== 'user' || event.data.source.rpcId === initialRequest) continue
      const text = textOnly(event.data.content)
      if (text) rows.push({ key: `u${event.seq}`, role: 'user', text })
    } else if (event.type === 'assistant/message') {
      const text = textOnly(event.data.message?.content)
      if (text) rows.push({ key: `a${event.seq}`, role: 'assistant', text })
    } else if (event.type === 'assistant/live-chunk') {
      const { attemptId, chunk } = event.data
      if (!attemptId || !chunk) continue
      let attempt = attempts.get(attemptId)
      if (!attempt) { attempt = { row: { key: attemptId, role: 'assistant', text: '' }, textBlocks: new Set() }; attempts.set(attemptId, attempt); rows.push(attempt.row) }
      if (chunk.type === 'block-start' && chunk.blockType === 'text') attempt.textBlocks.add(chunk.index ?? 0)
      if (chunk.type === 'text-delta' && attempt.textBlocks.has(chunk.index ?? 0)) attempt.row.text += chunk.text ?? ''
    }
  }
  return rows.filter(row => row.text)
}

export function lastTurnError(entries: Array<{ event: SessionEvent }>): string | undefined {
  const end = [...entries].reverse().find(({ event }) => event.type === 'turn/end')?.event
  return end?.data.reason?.kind === 'error' ? end.data.reason.error?.message ?? 'DSH 回复失败' : undefined
}

/** The host owns a genuine DSH Session in its private, non-persistent runtime. */
export function connectMemorySession(id: string): import('../shared/dsh.js').NativeReference {
  let snapshot: import('../shared/dsh.js').NativeSnapshot = { running: false, removed: false, openState: 'loading', openError: null, lastAgentError: null }
  let feed: { entries: Array<{ event: SessionEvent }> } = { entries: [] }
  const listeners = new Set<() => void>()
  const notify = () => { for (const listener of listeners) listener() }
  const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
  let stream: EventSource | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let released = false
  let cancelOpening: (() => void) | undefined
  const closeStream = () => { stream?.close(); clearTimeout(timer); cancelOpening?.(); cancelOpening = undefined }
  const open = (): Promise<void> => {
    closeStream()
    if (released) return Promise.reject(new Error('内存会话连接已释放'))
    return new Promise((resolve, reject) => {
      cancelOpening = () => reject(new Error('内存会话连接已释放'))
      snapshot = { ...snapshot, openState: 'loading', openError: null }
      notify()
      const events = new EventSource(`/ext/atlas/selection-chat/${encodeURIComponent(id)}/events`)
      stream = events
      const fail = (message: string) => {
        if (released || stream !== events) return
        events.close(); clearTimeout(timer); cancelOpening = undefined
        snapshot = { ...snapshot, openState: 'error', openError: { message } }
        notify(); reject(new Error(message))
      }
      timer = setTimeout(() => fail('内存会话连接超时，请重试'), 10000)
      events.onmessage = event => {
        if (released || stream !== events) return
        try {
          const state = JSON.parse(event.data) as import('../shared/selection-chat.js').MemorySessionState & { closed?: boolean }
          if (state.closed) { snapshot = { ...snapshot, removed: true }; fail(state.error ?? '一次性会话已清空'); return }
          feed = { entries: state.entries }
          snapshot = { ...snapshot, running: state.running, openState: 'open', openError: null, lastAgentError: state.error ?? null }
          clearTimeout(timer); cancelOpening = undefined; notify(); resolve()
        } catch { fail('内存会话数据读取失败，请重试') }
      }
      events.onerror = () => fail('内存会话连接中断，请重试；若已关闭，请重新搜索')
    })
  }
  const operation = async (path: string, body: unknown) => {
    try { await selectionRequest(`/${encodeURIComponent(id)}/${path}`, body); return { ok: true } }
    catch (error) { return { ok: false, error: { message: error instanceof Error ? error.message : String(error) } } }
  }
  const binding: import('../shared/dsh.js').NativeBinding = {
    session: {
      getSnapshot: () => snapshot, subscribe,
      prompt: (content, _mode, _signal, requestId) => operation('turn', { text: textOnly(content), requestId: requestId ?? crypto.randomUUID() }),
      cancel: () => operation('stop', {}),
      resync: async () => { await selectionRequest(`/${encodeURIComponent(id)}`); await open() },
    },
    eventSource: { getSnapshot: () => feed, subscribe },
  }
  return { ready: open().then(() => binding), release() { released = true; closeStream(); listeners.clear(); feed = { entries: [] } } }
}
