import { useState } from 'react'
import type { AtlasNode } from '../shared/types.js'

export function SessionUnavailable({ node, onNew, onRestore, onBack }: { node: AtlasNode; onNew(): Promise<void>; onRestore(): Promise<void>; onBack(): void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const run = async (action: () => Promise<void>) => {
    setBusy(true)
    setError('')
    try { await action() } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }
  return <div className="atlas-app"><div className="atlas-empty"><section className="atlas-empty-card">
    <h2>当前没有会话</h2><p>节点「{node.title}」仍保留，旧会话已移入 DSH 归档，不会自动恢复。</p>
    <p>可恢复上次归档的会话，或创建全新 Session，不继承旧历史。DSH 归档中的历史日志仍然保留。</p>
    {error ? <p role="alert">{error}</p> : null}
    <div className="atlas-manage-buttons"><button disabled={busy} onClick={onBack}>返回画布</button><button disabled={busy} onClick={() => void run(onRestore)}>恢复上次会话</button><button disabled={busy} onClick={() => void run(onNew)}>{busy ? '正在处理…' : '创建新会话'}</button></div>
  </section></div></div>
}
