import { useEffect, useRef, useState } from 'react'
import type { AtlasNode, DeletePreview } from '../shared/types.js'
import { api } from './api.js'

export interface NodeMenuTarget { node: AtlasNode; x: number; y: number }
export function NodeActions({ target, onClose, onOpen, onAddChild, onDeleted }: {
  target: NodeMenuTarget; onClose(): void; onOpen(node: AtlasNode): void; onAddChild(node: AtlasNode): void; onDeleted(ids: string[]): void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [preview, setPreview] = useState<DeletePreview>()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose() }
    const outside = (e: PointerEvent) => { if (!preview && !busy && !ref.current?.contains(e.target as Node)) onClose() }
    document.addEventListener('keydown', key)
    document.addEventListener('pointerdown', outside)
    return () => { document.removeEventListener('keydown', key); document.removeEventListener('pointerdown', outside) }
  }, [preview, busy, onClose])
  const prepare = async () => {
    setBusy(true)
    try { setPreview(await api.deletePreview(target.node.id)); setError('') }
    catch (e) { setError(String(e)) } finally { setBusy(false) }
  }
  const remove = async () => {
    if (!preview || busy) return
    setBusy(true)
    try { const result = await api.deleteNode(target.node.id, preview.token); onDeleted(result.deleted); onClose() }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }
  const archive = async () => {
    setBusy(true)
    try {
      if (target.node.sessionId) await api.archiveSession(target.node.id, target.node.sessionId)
      onClose()
    }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }
  if (preview) return <div className="atlas-manage-backdrop"><section className="atlas-manage-dialog" role="dialog" aria-modal="true" aria-label="删除节点确认">
    <h3>将「{target.node.title}」移至回收站？</h3>
    <p>共 {preview.nodes.length} 个节点。绑定会话不会归档，只移除工作区分组，会话进入 DSH 未分组，仍可独立使用。</p>
    <ul>{preview.nodes.map(n => <li key={n.id}>{n.title}</li>)}</ul>
    {error ? <p role="alert">{error}</p> : null}
    <div className="atlas-manage-buttons"><button autoFocus disabled={busy} onClick={onClose}>取消</button><button disabled={busy} onClick={() => void prepare()}>刷新范围</button><button className="danger" disabled={busy} onClick={() => void remove()}>移至回收站</button></div>
  </section></div>
  return <div ref={ref} role="menu" className="atlas-node-menu" style={{ left: Math.max(8, Math.min(target.x, window.innerWidth - 208)), top: Math.max(8, Math.min(target.y, window.innerHeight - 160)) }}>
    <button autoFocus role="menuitem" onClick={() => { onClose(); onOpen(target.node) }}>打开会话</button>
    <button role="menuitem" onClick={() => { onClose(); onAddChild(target.node) }}>创建子节点</button>
    {target.node.sessionId ? <button role="menuitem" onClick={() => { setError(''); void archive() }}>归档会话</button> : null}
    <button role="menuitem" className="danger" disabled={busy} onClick={() => void prepare()}>删除节点…</button>
    {error ? <p role="alert">{error}</p> : null}
  </div>
}
