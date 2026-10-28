/**
 * 纸张式对话面板：主线程 + 目录轨 + 收口卡 + 一级子聊天。
 * 关闭节点 = 收口；重新打开先看到续接简报。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  AtlasMessage,
  AtlasNode,
  ClosureCard,
  MessageQuote,
  SubthreadSnapshot,
  ThreadSnapshot,
} from '../shared/types.js'
import { api, streamTurn } from './api.js'
import { Markdown, extractHeadings } from './markdown.js'

export interface ChatSheetProps {
  snapshot: ThreadSnapshot
  onBack: () => void
  onNodeChanged: (node: AtlasNode) => void
  onSnapshotStale: () => void
  onDeleted: (nodeId: string) => void
  onToast: (message: string) => void
}

export function ChatSheet({ snapshot, onBack, onNodeChanged, onSnapshotStale, onDeleted, onToast }: ChatSheetProps) {
  const [node, setNode] = useState(snapshot.node)
  const [title, setTitle] = useState(snapshot.node.title)
  const [messages, setMessages] = useState(snapshot.messages)
  const [subs, setSubs] = useState(snapshot.subthreads ?? [])
  const [card, setCard] = useState<ClosureCard | undefined>(snapshot.card)
  const [quote, setQuote] = useState<MessageQuote | null>(null)
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState<string | null>(null)
  const [closing, setClosing] = useState(false)
  const [branch, setBranch] = useState<{ messageId: string; text: string } | null>(null)
  const [subDrafts, setSubDrafts] = useState<Record<string, string>>({})
  const threadRef = useRef<HTMLDivElement>(null)
  const composerRef = useRef<HTMLTextAreaElement>(null)
  const autoScroll = useRef(true)
  const sendingRef = useRef(false)

  useEffect(() => {
    setNode(snapshot.node)
    setTitle(snapshot.node.title)
    setMessages(snapshot.messages)
    setSubs(snapshot.subthreads ?? [])
    setCard(snapshot.card)
    setQuote(null)
    setDraft('')
    setBranch(null)
    setSubDrafts({})
  }, [snapshot])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onBack()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onBack])

  useEffect(() => {
    if (!autoScroll.current) return
    const element = threadRef.current
    if (element) element.scrollTop = element.scrollHeight
  }, [messages, subs])

  const outline = useMemo(
    () => messages.filter((message) => message.role === 'assistant').flatMap((message) => extractHeadings(message.content, message.id)),
    [messages],
  )

  const turnCount = Math.ceil(messages.filter((message) => message.role === 'user').length)

  const updateMain = (updater: (list: AtlasMessage[]) => AtlasMessage[]) => setMessages(updater)
  const updateSub = (threadId: string, updater: (list: AtlasMessage[]) => AtlasMessage[]) =>
    setSubs((current) =>
      current.map((sub) => (sub.thread.id === threadId ? { ...sub, messages: updater(sub.messages) } : sub)),
    )

  const runTurn = async (
    threadId: string,
    text: string,
    turnQuote: MessageQuote | undefined,
    target: { kind: 'main' } | { kind: 'sub'; id: string },
  ) => {
    if (sendingRef.current) return
    sendingRef.current = true
    const key = target.kind === 'main' ? 'main' : target.id
    const user: AtlasMessage = {
      id: `local_u_${randomId()}`,
      threadId,
      role: 'user',
      content: text,
      createdAt: new Date().toISOString(),
      quote: turnQuote,
    }
    const assistant: AtlasMessage = {
      id: `local_a_${randomId()}`,
      threadId,
      role: 'assistant',
      content: '',
      createdAt: new Date().toISOString(),
    }
    const apply = (updater: (list: AtlasMessage[]) => AtlasMessage[]) =>
      target.kind === 'main' ? updateMain(updater) : updateSub(target.id, updater)

    apply((list) => [...list, user, assistant])
    autoScroll.current = true
    setSending(key)

    let assistantId = assistant.id
    try {
      await streamTurn(threadId, { text, quote: turnQuote }, {
        onMeta: (meta) => {
          const previous = assistantId
          assistantId = meta.messageId
          apply((list) => list.map((message) => (message.id === previous ? { ...message, id: assistantId } : message)))
        },
        onDelta: (delta) => {
          apply((list) =>
            list.map((message) => (message.id === assistantId ? { ...message, content: message.content + delta } : message)),
          )
        },
        onError: (error) => {
          apply((list) =>
            list.map((message) =>
              message.id === assistantId
                ? {
                    ...message,
                    error: true,
                    content: message.content
                      ? `${message.content}\n\n> ⚠️ ${error.message}`
                      : `⚠️ ${error.message}`,
                  }
                : message,
            ),
          )
          onToast(error.message)
        },
      })
      if (node.status !== 'active') {
        const updated = { ...node, status: 'active' as const }
        setNode(updated)
        onNodeChanged(updated)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : '网络请求失败'
      apply((list) =>
        list.map((item) => (item.id === assistantId ? { ...item, error: true, content: item.content || `⚠️ ${message}` } : item)),
      )
      onToast(message)
    } finally {
      sendingRef.current = false
      setSending(null)
    }
  }

  const sendMain = () => {
    const text = draft.trim()
    if (!text || sending) return
    setDraft('')
    void runTurn(snapshot.thread.id, text, quote ?? undefined, { kind: 'main' })
    setQuote(null)
  }

  const sendSub = (sub: SubthreadSnapshot) => {
    const text = (subDrafts[sub.thread.id] ?? '').trim()
    if (!text || sending) return
    setSubDrafts((current) => ({ ...current, [sub.thread.id]: '' }))
    void runTurn(sub.thread.id, text, undefined, { kind: 'sub', id: sub.thread.id })
  }

  const startBranch = async () => {
    const question = branch?.text.trim()
    if (!branch || !question) return
    const source = messages.find((message) => message.id === branch.messageId)
    const turnQuote: MessageQuote | undefined = source
      ? { messageId: source.id, text: source.content.slice(0, 1200) }
      : undefined
    try {
      const { thread } = await api.createSubthread({
        nodeId: node.id,
        title: question.slice(0, 60),
        anchorMessageId: branch.messageId,
        quote: turnQuote,
      })
      setSubs((current) => [...current, { thread, messages: [] }])
      setBranch(null)
      await runTurn(thread.id, question, turnQuote, { kind: 'sub', id: thread.id })
    } catch (error) {
      onToast(error instanceof Error ? error.message : '创建子聊天失败')
    }
  }

  const closeNode = async () => {
    if (closing) return
    setClosing(true)
    try {
      const result = await api.closeNode(node.id, snapshot.thread.id)
      setCard(result.card)
      setNode(result.node)
      onNodeChanged(result.node)
      onToast('已收口')
    } catch (error) {
      onToast(error instanceof Error ? error.message : '收口失败')
    } finally {
      setClosing(false)
    }
  }

  const reopenNode = async () => {
    try {
      const result = await api.updateNode(node.id, { status: 'active' })
      setNode(result.node)
      onNodeChanged(result.node)
      onToast('已重新打开，可以直接继续追问')
    } catch (error) {
      onToast(error instanceof Error ? error.message : '重新打开失败')
    }
  }

  const saveTitle = async () => {
    const next = title.trim()
    if (!next || next === node.title) return
    try {
      const result = await api.updateNode(node.id, { title: next })
      setNode(result.node)
      onNodeChanged(result.node)
      onSnapshotStale()
    } catch (error) {
      onToast(error instanceof Error ? error.message : '重命名失败')
    }
  }

  const setMastery = async (value: number) => {
    try {
      const result = await api.updateNode(node.id, { mastery: value })
      setNode(result.node)
      onNodeChanged(result.node)
    } catch (error) {
      onToast(error instanceof Error ? error.message : '更新掌握度失败')
    }
  }

  const promote = async (sub: SubthreadSnapshot) => {
    try {
      await api.promote(sub.thread.id, sub.thread.title)
      setSubs((current) =>
        current.map((item) =>
          item.thread.id === sub.thread.id ? { ...item, thread: { ...item.thread, collapsed: true } } : item,
        ),
      )
      onSnapshotStale()
      onToast('已提升为画布子节点')
    } catch (error) {
      onToast(error instanceof Error ? error.message : '提升失败')
    }
  }

  const remove = async () => {
    if (!window.confirm(`删除节点「${node.title}」及其所有子节点？`)) return
    try {
      await api.deleteNode(node.id)
      onDeleted(node.id)
    } catch (error) {
      onToast(error instanceof Error ? error.message : '删除失败')
    }
  }

  const anchorSubs = (messageId: string) => subs.filter((sub) => sub.thread.anchorMessageId === messageId)
  const unattached = subs.filter(
    (sub) => !sub.thread.anchorMessageId || !messages.some((message) => message.id === sub.thread.anchorMessageId),
  )

  return (
    <div className="atlas-sheet-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onBack()}>
      <div className="atlas-sheet" onMouseDown={(event) => event.stopPropagation()}>
        <header className="atlas-sheet-head">
          <div className="atlas-sheet-head-main">
            <div className="atlas-breadcrumb">{snapshot.path.map((item) => item.title).join(' › ') || node.title}</div>
            <input
              className="atlas-title-input"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              onBlur={saveTitle}
              onKeyDown={(event) => event.key === 'Enter' && event.currentTarget.blur()}
              aria-label="节点标题"
            />
            <div className="atlas-head-meta">
              <span>{statusLabel(node.status)}</span>
              <span>·</span>
              <span>{turnCount} 轮</span>
              <span>·</span>
              <span className="atlas-mastery" title="点击设置掌握度">
                {Array.from({ length: 5 }, (_, index) => (
                  <button
                    key={index}
                    type="button"
                    onClick={() => void setMastery(index + 1 === node.mastery ? index : index + 1)}
                    style={{ border: 0, padding: 0, background: 'transparent', cursor: 'pointer' }}
                  >
                    <i className={index < node.mastery ? 'on' : ''} style={{ display: 'block', width: 5, height: 5, borderRadius: 2, background: index < node.mastery ? 'var(--atlas-green)' : '#2b3a4d' }} />
                  </button>
                ))}
              </span>
            </div>
          </div>
          <div className="atlas-head-actions">
            <button type="button" className="atlas-paper-btn primary" onClick={closeNode} disabled={closing || Boolean(sending)}>
              {closing ? '收口中…' : card ? '重新收口' : '收口'}
            </button>
            <button type="button" className="atlas-paper-btn danger" onClick={remove} title="删除节点">
              删除
            </button>
            <button type="button" className="atlas-paper-btn" onClick={onBack} title="返回画布（Esc）">
              ✕
            </button>
          </div>
        </header>

        <div className="atlas-sheet-body">
          <aside className="atlas-outline">
            <div className="atlas-outline-title">本节目录</div>
            {card ? (
              <button
                type="button"
                className="atlas-outline-item"
                onClick={() => threadRef.current?.scrollTo({ top: 0, behavior: 'smooth' })}
              >
                ▸ 收口卡
              </button>
            ) : null}
            {outline.length === 0 ? (
              <div className="atlas-outline-empty">回答里出现 ## 或 ### 标题时，会在这里生成目录。</div>
            ) : (
              outline.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={`atlas-outline-item ${item.level === 3 ? 'lvl3' : ''}`}
                  onClick={() => document.getElementById(item.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
                  title={item.text}
                >
                  {item.text}
                </button>
              ))
            )}
          </aside>

          <div
            className="atlas-thread"
            ref={threadRef}
            onScroll={(event) => {
              const element = event.currentTarget
              autoScroll.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80
            }}
          >
            <div className="atlas-thread-inner">
              {card ? (
                <ClosureCardView
                  card={card}
                  closed={node.status === 'closed'}
                  onReopen={node.status === 'closed' ? reopenNode : undefined}
                  onRecollapse={closeNode}
                />
              ) : null}

              {messages.length === 0 ? (
                <div style={{ padding: '28px 0', color: 'var(--paper-muted)', fontSize: 13, lineHeight: 1.8 }}>
                  这是一个新节点。问第一个问题，或者先用一句话写下你要解决什么。
                </div>
              ) : null}

              {messages.map((message) => (
                <div key={message.id} className={`atlas-msg ${message.role === 'user' ? 'is-user' : ''} ${message.error ? 'error' : ''}`} id={`msg-${message.id}`}>
                  {message.role === 'user' ? (
                    <>
                      {message.quote ? <QuoteView quote={message.quote} /> : null}
                      <div className="atlas-msg-user">{message.content}</div>
                    </>
                  ) : (
                    <>
                      <div className="atlas-msg-role">Atlas</div>
                      {message.content ? (
                        <div className="atlas-msg-assistant">
                          <Markdown text={message.content} idPrefix={message.id} />
                        </div>
                      ) : sending ? (
                        <div className="atlas-loading" style={{ justifyContent: 'flex-start', height: 32 }}>
                          <span className="atlas-spinner" /> 正在组织回答…
                        </div>
                      ) : null}
                      {message.content ? (
                        <div className="atlas-msg-actions">
                          <button
                            type="button"
                            className="atlas-mini"
                            onClick={() => {
                              setQuote({ messageId: message.id, text: message.content.slice(0, 1200) })
                              composerRef.current?.focus()
                            }}
                          >
                            引用
                          </button>
                          <button
                            type="button"
                            className="atlas-mini"
                            onClick={() => setBranch({ messageId: message.id, text: '' })}
                          >
                            分支
                          </button>
                        </div>
                      ) : null}
                      {branch?.messageId === message.id ? (
                        <div className="atlas-sub-form">
                          <input
                            className="atlas-input"
                            autoFocus
                            placeholder="把这个问题展开成子聊天…"
                            value={branch.text}
                            onChange={(event) => setBranch({ messageId: message.id, text: event.target.value })}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter') void startBranch()
                              if (event.key === 'Escape') setBranch(null)
                            }}
                          />
                          <button type="button" className="atlas-paper-btn primary" onClick={() => void startBranch()}>
                            开始
                          </button>
                          <button type="button" className="atlas-paper-btn" onClick={() => setBranch(null)}>
                            取消
                          </button>
                        </div>
                      ) : null}
                      {anchorSubs(message.id).map((sub) => (
                        <SubthreadView
                          key={sub.thread.id}
                          sub={sub}
                          sending={sending === sub.thread.id}
                          draft={subDrafts[sub.thread.id] ?? ''}
                          onDraft={(value) => setSubDrafts((current) => ({ ...current, [sub.thread.id]: value }))}
                          onSend={() => sendSub(sub)}
                          onToggle={() => {
                            const collapsed = !sub.thread.collapsed
                            setSubs((current) =>
                              current.map((item) =>
                                item.thread.id === sub.thread.id ? { ...item, thread: { ...item.thread, collapsed } } : item,
                              ),
                            )
                            void api.setThreadCollapsed(sub.thread.id, collapsed).catch(() => undefined)
                          }}
                          onPromote={() => void promote(sub)}
                        />
                      ))}
                    </>
                  )}
                </div>
              ))}

              {unattached.map((sub) => (
                <SubthreadView
                  key={sub.thread.id}
                  sub={sub}
                  sending={sending === sub.thread.id}
                  draft={subDrafts[sub.thread.id] ?? ''}
                  onDraft={(value) => setSubDrafts((current) => ({ ...current, [sub.thread.id]: value }))}
                  onSend={() => sendSub(sub)}
                  onToggle={() => {
                    const collapsed = !sub.thread.collapsed
                    setSubs((current) =>
                      current.map((item) =>
                        item.thread.id === sub.thread.id ? { ...item, thread: { ...item.thread, collapsed } } : item,
                      ),
                    )
                    void api.setThreadCollapsed(sub.thread.id, collapsed).catch(() => undefined)
                  }}
                  onPromote={() => void promote(sub)}
                />
              ))}
            </div>
          </div>
        </div>

        <footer className="atlas-composer-wrap">
          {quote ? <QuoteView quote={quote} onRemove={() => setQuote(null)} /> : null}
          <div className="atlas-composer">
            <textarea
              ref={composerRef}
              value={draft}
              placeholder="问这一节点范围内的问题…"
              rows={1}
              onChange={(event) => setDraft(event.target.value)}
              onInput={(event) => {
                const target = event.currentTarget
                target.style.height = 'auto'
                target.style.height = `${Math.min(target.scrollHeight, 160)}px`
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault()
                  sendMain()
                }
              }}
            />
            <button type="button" className="atlas-send" onClick={sendMain} disabled={!draft.trim() || sending === 'main'} title="发送（Enter）">
              ↑
            </button>
          </div>
          <div className="atlas-composer-hint">
            <span>Enter 发送 · Shift+Enter 换行 · Esc 回到地图</span>
            <span>{sending ? '正在生成…' : '收口后节点会变绿'}</span>
          </div>
        </footer>
      </div>
    </div>
  )
}

function SubthreadView({
  sub,
  sending,
  draft,
  onDraft,
  onSend,
  onToggle,
  onPromote,
}: {
  sub: SubthreadSnapshot
  sending: boolean
  draft: string
  onDraft: (value: string) => void
  onSend: () => void
  onToggle: () => void
  onPromote: () => void
}) {
  return (
    <div className="atlas-sub" id={`sub-${sub.thread.id}`}>
      <div className="atlas-sub-head">
        <button type="button" className="atlas-mini" onClick={onToggle}>
          {sub.thread.collapsed ? '▸' : '▾'}
        </button>
        <b>{sub.thread.title}</b>
        <span>{Math.ceil(sub.messages.filter((message) => message.role === 'user').length)} 轮</span>
        <button type="button" className="atlas-mini" onClick={onPromote} title="提升为画布子节点">
          提升为节点
        </button>
      </div>
      {sub.thread.collapsed ? null : (
        <>
          {sub.messages.map((message) => (
            <div key={message.id} className={`atlas-sub-msg ${message.role === 'user' ? 'is-user' : ''}`}>
              {message.quote ? <QuoteView quote={message.quote} compact /> : null}
              <div className="who">{message.role === 'user' ? '你' : 'Atlas'}</div>
              <div className="body">
                {message.content ? <Markdown text={message.content} idPrefix={message.id} /> : sending ? '…' : ''}
              </div>
            </div>
          ))}
          <div className="atlas-sub-composer">
            <input
              className="atlas-input"
              placeholder="在子聊天里继续追问…"
              value={draft}
              onChange={(event) => onDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  onSend()
                }
              }}
            />
            <button type="button" className="atlas-paper-btn primary" onClick={onSend} disabled={!draft.trim() || sending}>
              发送
            </button>
          </div>
        </>
      )}
    </div>
  )
}

function QuoteView({ quote, onRemove, compact = false }: { quote: MessageQuote; onRemove?: () => void; compact?: boolean }) {
  return (
    <div className="atlas-quote" style={compact ? { maxWidth: '100%', fontSize: 11 } : undefined}>
      <div className="atlas-quote-head">
        <span>引用</span>
        {onRemove ? (
          <button type="button" onClick={onRemove} aria-label="取消引用">
            ✕
          </button>
        ) : null}
      </div>
      {quote.text.length > 240 ? `${quote.text.slice(0, 240)}…` : quote.text}
    </div>
  )
}

function ClosureCardView({
  card,
  closed,
  onReopen,
  onRecollapse,
}: {
  card: ClosureCard
  closed: boolean
  onReopen?: () => void
  onRecollapse: () => void
}) {
  return (
    <div className={`atlas-card ${closed ? '' : 'amber'}`} id="atlas-closure-card">
      <div className="atlas-card-head">
        <span>{closed ? '收口卡 · 已收口' : '续接简报 · 正在继续'}</span>
        <span style={{ marginLeft: 'auto' }}>掌握 {card.mastery}/5</span>
      </div>
      <h4>{card.tldr}</h4>
      <ul>
        {card.points.map((point, index) => (
          <li key={index}>{point}</li>
        ))}
      </ul>
      {card.openQuestions.length ? (
        <div className="open">
          <b>未解问题</b>
          <ul>
            {card.openQuestions.map((question, index) => (
              <li key={index}>{question}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="next">↳ {card.nextHint}</div>
      <div className="atlas-card-actions">
        {onReopen ? (
          <button type="button" className="atlas-paper-btn" onClick={onReopen}>
            重新打开
          </button>
        ) : null}
        <button type="button" className="atlas-paper-btn" onClick={onRecollapse}>
          更新收口卡
        </button>
      </div>
    </div>
  )
}

function statusLabel(status: AtlasNode['status']): string {
  switch (status) {
    case 'active':
      return '进行中'
    case 'closed':
      return '已收口'
    case 'paused':
      return '暂停'
    case 'archived':
      return '归档'
    default:
      return '未开始'
  }
}

function randomId(): string {
  return Math.random().toString(36).slice(2, 8)
}
