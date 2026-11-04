import { useEffect, useState } from 'react'
import type { LibraryItem, SessionRecord } from '../shared/types.js'
import { api } from './api.js'

export function NodeLibrary({ initialTab = 'retained', onOpenSession, onBack }: {
  initialTab?: 'retained' | 'trash'; onOpenSession(id: string): Promise<void>; onBack(): void
}) {
  const [tab, setTab] = useState(initialTab)
  const [nodes, setNodes] = useState<LibraryItem[]>([])
  const [sessions, setSessions] = useState<SessionRecord[]>([])
  const [filter, setFilter] = useState('all')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [purging, setPurging] = useState<LibraryItem[]>()
  const [archiving, setArchiving] = useState<SessionRecord[]>()
  const [ready, setReady] = useState(false)
  const reload = async () => {
    const result = await api.trash()
    if (result.version !== 8) { setReady(false); throw new Error('Atlas 后端版本未更新，请完全退出并重新打开 DeepSeek Harness。仅刷新页面不会更新后端。') }
    setNodes(result.nodes); setSessions(result.sessions ?? []); setReady(true)
  }
  useEffect(() => { void reload().catch(e => setError(String(e))) }, [])
  const restore = async (id: string) => {
    setBusy(true)
    try { await api.restoreNode(id); await reload(); setError('') }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }
  const purge = async () => {
    if (!purging?.length) return
    setBusy(true)
    try { await api.purgeNodes(purging.map(n => ({ id: n.id, batchId: n.deletionBatchId! }))); await reload(); setPurging(undefined); setError('') }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }
  const openSession = async (sessionId: string) => {
    setBusy(true)
    try { await onOpenSession(sessionId) }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }
  const archiveOne = async (sessionId: string) => {
    setBusy(true)
    try { await api.archiveSessions([sessionId]); await reload(); setError('') }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }
  const unarchiveOne = async (sessionId: string) => {
    setBusy(true)
    try { const r = await api.unarchiveSession(sessionId); await reload(); setError(''); return r }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }
  const archiveMany = async () => {
    if (!archiving?.length) return
    setBusy(true)
    try { await api.archiveSessions(archiving.map(s => s.sessionId)); await reload(); setArchiving(undefined); setError('') }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }
  const workspaces = new Map(nodes.map(n => [n.workspaceId, n.workspaceName]))
  const sessionWorkspaces = new Map(sessions.map(s => [s.originWorkspaceId, s.workspaceName ?? `未知地图 (${s.originWorkspaceId})`]))
  const visibleNodes = nodes.filter(n => (filter === 'all' || n.workspaceId === filter) && !n.purgedAt && n.id === n.deletionRootId)
    .sort((a, b) => (b.deletedAt ?? '').localeCompare(a.deletedAt ?? ''))
  const visibleSessions = sessions.filter(s => filter === 'all' || s.originWorkspaceId === filter)
    .sort((a, b) => (b.archivedAt ?? '').localeCompare(a.archivedAt ?? ''))
  const nodeGroups = [...new Set(visibleNodes.map(n => n.workspaceId))]
  const sessionGroups = [...new Set(visibleSessions.map(s => s.originWorkspaceId))]
  const statusTag = (s: SessionRecord) => s.archived
    ? <span className="atlas-library-status archived">已归档</span>
    : <span className="atlas-library-status available">可用</span>
  const bindingTag = (s: SessionRecord) => s.isCurrent
    ? <span className="atlas-library-status current">当前绑定</span>
    : <span className="atlas-library-status source">历史来源</span>
  return <div className="atlas-library"><div className="atlas-library-content">
    <button className="atlas-library-back" onClick={onBack}>← 返回画布</button>
    <header><div><span className="atlas-library-eyebrow">ATLAS</span><h2>回收站</h2><p>{tab === 'retained' ? '已删除节点或手动归档的会话，会话归档状态以 DSH 原生状态为准。' : '彻底删除节点时保留 Session、历史日志与工作目录。'}</p></div></header>
    <div className="atlas-library-controls"><div className="atlas-library-tabs"><button aria-pressed={tab === 'retained'} onClick={() => setTab('retained')}>会话</button><button aria-pressed={tab === 'trash'} onClick={() => setTab('trash')}>节点</button></div>
      <div className="atlas-library-actions"><select aria-label="按地图筛选" value={filter} onChange={e => setFilter(e.target.value)}><option value="all">全部地图</option>{[...new Set([...workspaces.keys(), ...sessionWorkspaces.keys()])].map(id => <option key={id} value={id}>{workspaces.get(id) ?? sessionWorkspaces.get(id) ?? id}</option>)}</select>{tab === 'trash' ? <button className="atlas-library-delete" disabled={busy || !ready || !visibleNodes.length} onClick={() => { setError(''); setPurging(visibleNodes) }}><LibraryIcon kind="delete" />彻底删除所选节点</button> : <button className="atlas-library-delete" disabled={busy || !ready || !visibleSessions.some(s => !s.archived)} onClick={() => { setError(''); setArchiving(visibleSessions.filter(s => !s.archived)) }}><LibraryIcon kind="delete" />归档全部可用会话</button>}</div>
    </div>
    {error && !purging && !archiving ? <p role="alert">{error}</p> : null}
    {tab === 'retained' ? sessionGroups.map(id => <section className="atlas-library-group" key={id}>
      <div className="atlas-library-group-head"><span>▱ &nbsp;{sessionWorkspaces.get(id) ?? `未知地图 (${id})`}</span><small>{visibleSessions.filter(s => s.originWorkspaceId === id).length} 条记录</small></div>
      <div className="atlas-library-card">{visibleSessions.filter(s => s.originWorkspaceId === id).map(s => <article key={s.sessionId}>
        <div className="atlas-library-item-icon" aria-hidden="true">▤</div>
        <div className="atlas-library-item"><strong>{s.title}</strong><small>来源节点：{s.nodeTitle} · {statusTag(s)}{bindingTag(s)}</small><small>{s.archivedAt ? new Date(s.archivedAt).toLocaleString() : '可用'}</small></div>
        <div className="atlas-library-actions">{s.archived ? <button className="atlas-library-action" disabled={busy} onClick={() => void unarchiveOne(s.sessionId)}><LibraryIcon kind="open" />恢复会话</button> : <><button className="atlas-library-action" disabled={busy} onClick={() => void openSession(s.sessionId)}><LibraryIcon kind="open" />打开</button><button className="atlas-library-delete" disabled={busy} onClick={() => { setError(''); void archiveOne(s.sessionId) }}><LibraryIcon kind="delete" />归档</button></>}</div>
      </article>)}</div>
    </section>) : nodeGroups.map(id => <section className="atlas-library-group" key={id}>
      <div className="atlas-library-group-head"><span>▱ &nbsp;{workspaces.get(id) ?? `未知地图 (${id})`}</span><small>{visibleNodes.filter(n => n.workspaceId === id).length} 条记录</small></div>
      <div className="atlas-library-card">{visibleNodes.filter(n => n.workspaceId === id).map(node => <article key={node.id}>
        <div className="atlas-library-item-icon" aria-hidden="true">▤</div>
        <div className="atlas-library-item"><strong>{node.title}</strong><small>原位置：{node.workspaceName ?? `未知地图 (${id})`} / {!node.pathComplete ? '… / ' : ''}{(node.pathTitles ?? [node.title]).join(' / ')}</small><small>{node.deletedAt ? new Date(node.deletedAt).toLocaleString() : '时间未知'} · {nodes.filter(n => n.deletionBatchId === node.deletionBatchId).length} 个节点</small></div>
        <div className="atlas-library-actions"><button className="atlas-library-action" disabled={busy} onClick={() => void restore(node.id)}>恢复节点</button><button className="atlas-library-delete" disabled={busy} onClick={() => { setError(''); setPurging([node]) }}>彻底删除</button></div>
      </article>)}</div>
    </section>)}
    {tab === 'retained' ? (!visibleSessions.length ? <p className="atlas-library-empty">暂无会话</p> : null) : (!visibleNodes.length ? <p className="atlas-library-empty">暂无节点</p> : null)}
    {archiving ? <div className="atlas-manage-backdrop"><section className="atlas-manage-dialog" role="dialog" aria-modal="true" aria-label="归档会话确认"><h3>归档 {archiving.length} 条会话？</h3><p>{filter === 'all' ? '全部地图' : sessionWorkspaces.get(filter)} · 会话。将同步移入 DSH 原生归档，节点保留，历史日志与目录文件保留。</p>{error ? <p role="alert">{error}</p> : null}<div className="atlas-manage-buttons"><button disabled={busy} onClick={() => setArchiving(undefined)}>取消</button><button className="danger" disabled={busy} onClick={() => void archiveMany()}>归档</button></div></section></div> : null}
    {purging ? <div className="atlas-manage-backdrop"><section className="atlas-manage-dialog" role="dialog" aria-modal="true" aria-label="彻底删除确认"><h3>彻底删除{purging.length === 1 ? `「${purging[0]!.title}」` : '所选范围的节点'}？</h3><p>{filter === 'all' ? '全部地图' : workspaces.get(filter)} · 节点 · 共 {nodes.filter(n => purging.some(p => p.deletionBatchId === n.deletionBatchId)).length} 个节点。删除后无法恢复节点记录，但保留 Session、历史日志与工作目录。</p>{error ? <p role="alert">{error}</p> : null}<div className="atlas-manage-buttons"><button disabled={busy} onClick={() => setPurging(undefined)}>取消</button><button className="danger" disabled={busy} onClick={() => void purge()}>彻底删除节点</button></div></section></div> : null}
  </div></div>
}

function LibraryIcon({ kind }: { kind: 'open' | 'delete' }) {
  return <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round">{kind === 'open' ? <><path d="M9 2h5v5M14 2 7 9" /><path d="M6 3H3a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-3" /></> : <><path d="M2 4h12M6 4V2h4v2M4 4l.5 10h7L12 4M7 7v4M9 7v4" /></>}</svg>
}
