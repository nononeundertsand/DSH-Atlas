/** Page-local source identity; the paragraph is a visible quotation, never a log claim. */
export interface SelectionSource {
  sessionId: string
  messageKey: string
  text: string
  start: number
  end: number
  paragraph: string
}
export interface TemporarySession { sessionId: string; requestId: string }
export interface TextBlock { type: string; text?: string }
export interface SessionEvent {
  type: string
  seq: number
  data: {
    content?: TextBlock[]
    message?: { id?: string; content: TextBlock[] }
    source?: { kind?: string; rpcId?: string }
    reason?: { kind: string; error?: { message: string } }
    attemptId?: string
    chunk?: { type: string; index?: number; text?: string; blockType?: string }
  }
}
export const textOnly = (blocks: TextBlock[] = []): string => blocks.filter(b => b.type === 'text').map(b => b.text ?? '').join('\n')
export const sourceKey = (s: SelectionSource): string => JSON.stringify([s.sessionId, s.messageKey, s.start, s.end, s.text])

/** Wire snapshots are a text-only view of the private DSH Session, held only in RAM. */
export interface MemorySessionState {
  running: boolean
  error?: string
  entries: Array<{ event: SessionEvent }>
}
