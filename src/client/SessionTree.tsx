import { useEffect, useState } from 'react'
import type { AtlasNode, ThreadSnapshot, WorkspaceSnapshot } from '../shared/types.js'
import { api } from './api.js'
import { ChatSheet } from './ChatSheet.js'

export interface SessionTreeProps {
  current: AtlasNode
  openNode(node: AtlasNode): Promise<void>
  showMap(): void
  showWorkspaces(): void
}

export function SessionTree({ current, openNode, showMap, showWorkspaces }: SessionTreeProps) {
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot>()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [history, setHistory] = useState<ThreadSnapshot>()
  const [menu, setMenu] = useState<string>()
  const [creatingUnder, setCreatingUnder] = useState<AtlasNode>()
  const [title, setTitle] = useState('')
  const [childrenCollapsed, setChildrenCollapsed] = useState(false)
  const reload = async () => setSnapshot((await api.getWorkspace(current.workspaceId)).snapshot)
  useEffect(() => { void reload().catch(e => setError(String(e))) }, [current.id, current.workspaceId])
  const run = async (action: () => Promise<void>) => {
    if (busy) return
    setBusy(true)
    setError('')
    try { await action() } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }
  const createChild = (parent: AtlasNode) => run(async () => {
    if (!title?.trim()) return
    const result = await api.createNode({ workspaceId: parent.workspaceId, parentId: parent.id, title: title.trim() })
    await reload()
    setCreatingUnder(undefined)
    setTitle('')
    await openNode(result.node)
  })
  const nodes = snapshot?.nodes ?? []
  const parent = nodes.find(n => n.id === current.parentId)
  const siblings = nodes.filter(n => n.parentId === current.parentId)
  const children = nodes.filter(n => n.parentId === current.id)
  const row = (node: AtlasNode, child = false) => {
    const selected = node.id === current.id
    return <div key={node.id} className={child ? 'atlas-tree-branch' : undefined}>
      <div className={`atlas-tree-row ${selected ? 'selected' : ''}`}
        onContextMenu={e => { e.preventDefault(); setMenu(menu === node.id ? undefined : node.id) }}>
        {selected && children.length ? <button className={`atlas-tree-toggle ${childrenCollapsed ? 'collapsed' : ''}`}
          aria-label={`${childrenCollapsed ? '展开' : '收起'}「${node.title}」的子节点`}
          aria-expanded={!childrenCollapsed} aria-controls={`atlas-children-${node.id}`}
          onClick={() => setChildrenCollapsed(value => !value)}><TreeIcon kind="chevron" /></button> : null}
        <button className="atlas-tree-open" disabled={busy} aria-current={selected ? 'page' : undefined}
          title={node.title} onClick={() => void run(() => openNode(node))}>
          {!(selected && children.length) ? <TreeIcon kind="chat" /> : null}
          <span className="atlas-tree-label">{node.title}</span>
          {selected ? <span className="atlas-tree-current" aria-label="当前节点" /> : null}
        </button>
      </div>
      {menu === node.id ? <button className="atlas-tree-context" disabled={busy} onClick={() => { setCreatingUnder(node); setMenu(undefined) }}><TreeIcon kind="plus" />创建子节点</button> : null}
    </div>
  }
  return <section className="atlas-session-tree" aria-label="Atlas 工作区树">
    <header className="atlas-tree-toolbar">
      <span>工作区</span>
      <div>
        <button onClick={showMap} aria-label="返回画布" title="返回画布"><TreeIcon kind="map" /></button>
        <button onClick={showWorkspaces} aria-label="切换到 DSH 工作区" title="切换到 DSH 工作区"><TreeIcon kind="exit" /></button>
      </div>
    </header>
    <div className="atlas-tree-workspace"><TreeIcon kind="folder" /><span>{snapshot?.workspace.name ?? 'Atlas'}</span></div>
    <div className="atlas-tree-body">
      {parent ? <button className="atlas-tree-parent" title={parent.title} disabled={busy} onClick={() => void run(() => openNode(parent))}><TreeIcon kind="back" /><span>{parent.title}</span></button> : null}
      <nav aria-label="附近节点">
        {siblings.map(n => <div key={n.id}>{row(n)}{n.id === current.id && children.length ? <div id={`atlas-children-${n.id}`} className="atlas-tree-children" hidden={childrenCollapsed}>{children.map(child => row(child, true))}</div> : null}</div>)}
      </nav>
      <button className="atlas-tree-add" disabled={busy} onClick={() => setCreatingUnder(current)}><TreeIcon kind="plus" />创建子节点</button>
      {creatingUnder ? <form className="atlas-tree-form" onSubmit={e => { e.preventDefault(); void createChild(creatingUnder) }}>
        <label htmlFor="atlas-child-title">在「{creatingUnder.title}」下创建</label>
        <input id="atlas-child-title" autoFocus aria-label="子节点标题" placeholder="节点名称" value={title} onChange={e => setTitle(e.target.value)} />
        <div><button type="button" onClick={() => setCreatingUnder(undefined)}>取消</button><button className="primary" disabled={busy || !title.trim()} type="submit">创建并打开</button></div>
      </form> : null}
      {busy ? <p className="atlas-tree-notice" role="status">正在打开…</p> : null}
      {error ? <p className="atlas-tree-notice" role="alert">{error}</p> : null}
    </div>
    <footer className="atlas-tree-footer"><button disabled={busy} title="查看原 Atlas 线程的只读历史" onClick={() => void run(async () => setHistory((await api.getThread(current.threadId)).snapshot))}><TreeIcon kind="history" />历史对话<TreeIcon kind="chevron" /></button></footer>
    {history ? <div className="atlas-app" style={{position: 'fixed', inset: 0, zIndex: 100}}><ChatSheet readOnly snapshot={history} onBack={() => setHistory(undefined)} onNodeChanged={() => void reload()} onSnapshotStale={() => void reload()} onDeleted={() => { setHistory(undefined); showMap() }} onToast={setError} /></div> : null}
  </section>
}

function TreeIcon({ kind }: { kind: 'folder' | 'map' | 'exit' | 'plus' | 'back' | 'chat' | 'chevron' | 'history' }) {
  const paths = {
    folder: <path d="M2 5a1 1 0 0 1 1-1h4l1.5 1.5H13a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1Z" />,
    map: <><rect x="2" y="2" width="4" height="4" rx="1" /><rect x="10" y="2" width="4" height="4" rx="1" /><rect x="6" y="10" width="4" height="4" rx="1" /><path d="M4 6v2h8V6M8 8v2" /></>,
    exit: <><path d="M7 3H3v10h4M6 8h8m-3-3 3 3-3 3" /></>,
    plus: <path d="M8 3v10M3 8h10" />,
    back: <path d="m6 4-4 4 4 4M2 8h11" />,
    chat: <path d="M3 3h10v8H7l-4 3Z" />,
    chevron: <path d="m5 6 3 3 3-3" />,
    history: <><path d="M3 5a5.5 5.5 0 1 1-1 5M2 2v4h4M8 5v3l2 1" /></>,
  }
  return <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round">{paths[kind]}</svg>
}
