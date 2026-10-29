/** Atlas 主面板：把画布、对话面板、工作区与搜索串成一个可用的最小闭环。 */
import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import type { AtlasNode, Point, SearchHit, ThreadSnapshot, UpdateInfo, Viewport, Workspace, WorkspaceSnapshot } from '../shared/types.js'
import { api } from './api.js'
import { Canvas } from './Canvas.js'
import { ChatSheet } from './ChatSheet.js'
import { DEFAULT_SETTINGS, loadSettings, normalize, saveSettings, type AtlasSettings } from './settings.js'

export function AtlasApp({ onExit }: { onExit?: () => void }) {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot | null>(null)
  const [dataDir, setDataDir] = useState('')
  const [thread, setThread] = useState<ThreadSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [threadLoading, setThreadLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [dialog, setDialog] = useState<{ kind: 'node' | 'workspace'; parentId?: string | null } | null>(null)
  const [dialogValue, setDialogValue] = useState('')
  const [emptyTitle, setEmptyTitle] = useState('')
  const [search, setSearch] = useState('')
  const [hits, setHits] = useState<SearchHit[]>([])
  const [searchOpen, setSearchOpen] = useState(false)
  const [update, setUpdate] = useState<UpdateInfo | null>(null)
  const [settings, setSettings] = useState<AtlasSettings>(() => loadSettings())
  const [settingsOpen, setSettingsOpen] = useState(false)
  const visitRef = useRef<{ nodeId: string; openedAt: number } | null>(null)
  const toastTimer = useRef<number | undefined>(undefined)

  const appStyle = {
    '--atlas-card-scale': settings.cardScale,
    '--atlas-sheet-width': `${settings.chatWidth}px`,
    '--atlas-chat-font-size': `${settings.chatFontSize}px`,
  } as CSSProperties

  const showToast = useCallback((message: string) => {
    setToast(message)
    window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(null), 2600)
  }, [])

  const reload = useCallback(async () => {
    const boot = await api.bootstrap()
    setWorkspaces(boot.workspaces)
    setSnapshot(boot.snapshot)
    setDataDir(boot.dataDir)
  }, [])

  useEffect(() => {
    let alive = true
    reload()
      .catch((reason: unknown) => {
        if (alive) setError(reason instanceof Error ? reason.message : '无法连接 Atlas 服务')
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [reload])

  useEffect(() => {
    let alive = true
    api
      .checkUpdate()
      .then((info) => {
        if (alive && info.updateAvailable) setUpdate(info)
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => {
    if (!search.trim() || !snapshot) {
      setHits([])
      return
    }
    const timer = window.setTimeout(() => {
      api
        .search(search, snapshot.workspace.id)
        .then((result) => setHits(result.hits))
        .catch(() => setHits([]))
    }, 220)
    return () => window.clearTimeout(timer)
  }, [search, snapshot?.workspace.id])

  const flushVisit = useCallback((keepalive = false) => {
    const visit = visitRef.current
    if (!visit) return undefined
    visitRef.current = null
    return api
      .recordVisit(
        visit.nodeId,
        { openedAt: new Date(visit.openedAt).toISOString(), durationMs: Date.now() - visit.openedAt },
        keepalive,
      )
      .catch(() => undefined)
  }, [])

  useEffect(() => {
    const onUnload = () => {
      void flushVisit(true)
    }
    window.addEventListener('beforeunload', onUnload)
    return () => window.removeEventListener('beforeunload', onUnload)
  }, [flushVisit])

  const openNode = useCallback(
    async (node: AtlasNode) => {
      void flushVisit()
      setThreadLoading(true)
      try {
        const result = await api.getThread(node.threadId)
        setThread(result.snapshot)
        visitRef.current = { nodeId: node.id, openedAt: Date.now() }
      } catch (reason) {
        showToast(reason instanceof Error ? reason.message : '打开节点失败')
      } finally {
        setThreadLoading(false)
      }
    },
    [flushVisit, showToast],
  )

  const closeSheet = useCallback(() => {
    setThread(null)
    const task = flushVisit()
    if (task) void task.then(() => reload()).catch(() => undefined)
  }, [flushVisit, reload])

  const updateSettings = (patch: Partial<AtlasSettings>) => {
    setSettings((current) => {
      const next = normalize({ ...current, ...patch })
      saveSettings(next)
      return next
    })
  }

  const resetSettings = () => {
    const next = { ...DEFAULT_SETTINGS }
    setSettings(next)
    saveSettings(next)
  }

  const createNode = async (title: string, parentId: string | null) => {
    if (!snapshot) return
    try {
      const created = await api.createNode({
        workspaceId: snapshot.workspace.id,
        parentId,
        title: title.trim() || '未命名节点',
      })
      await reload()
      await openNode(created.node)
    } catch (reason) {
      showToast(reason instanceof Error ? reason.message : '创建节点失败')
    }
  }

  const createWorkspace = async (name: string) => {
    try {
      const result = await api.createWorkspace(name.trim() || '新地图')
      setWorkspaces(result.workspaces)
      setSnapshot(result.snapshot)
      setThread(null)
      showToast('已创建新地图')
    } catch (reason) {
      showToast(reason instanceof Error ? reason.message : '创建工作区失败')
    }
  }

  const switchWorkspace = async (workspaceId: string) => {
    if (!snapshot || workspaceId === snapshot.workspace.id) return
    try {
      const result = await api.activateWorkspace(workspaceId)
      setWorkspaces(result.workspaces)
      setSnapshot(result.snapshot)
      setThread(null)
      setSearch('')
    } catch (reason) {
      showToast(reason instanceof Error ? reason.message : '切换工作区失败')
    }
  }

  const moveNode = (nodeId: string, position: Point) => {
    setSnapshot((current) =>
      current
        ? {
            ...current,
            nodes: current.nodes.map((node) => (node.id === nodeId ? { ...node, position } : node)),
          }
        : current,
    )
    void api.updateNode(nodeId, { position }).catch(() => reload().catch(() => undefined))
  }

  const saveViewport = (viewport: Viewport) => {
    if (!snapshot) return
    void api.updateViewport(snapshot.workspace.id, viewport).catch(() => undefined)
  }

  const updateNodeLocal = (node: AtlasNode) => {
    setSnapshot((current) =>
      current ? { ...current, nodes: current.nodes.map((item) => (item.id === node.id ? node : item)) } : current,
    )
  }

  const submitDialog = async () => {
    const value = dialogValue.trim()
    if (!dialog) return
    setDialog(null)
    setDialogValue('')
    if (dialog.kind === 'workspace') await createWorkspace(value)
    else await createNode(value, dialog.parentId ?? null)
  }

  const openSearchHit = (hit: SearchHit) => {
    const node = snapshot?.nodes.find((item) => item.id === hit.nodeId)
    setSearch('')
    setHits([])
    setSearchOpen(false)
    if (node) void openNode(node)
  }

  if (loading) {
    return (
      <div className="atlas-app">
        <div className="atlas-loading">
          <span className="atlas-spinner" /> 正在打开地图…
        </div>
      </div>
    )
  }

  if (error || !snapshot) {
    return (
      <div className="atlas-app">
        <div className="atlas-empty">
          <div className="atlas-empty-card">
            <h2>Atlas 没能连上</h2>
            <p>{error ?? '工作区为空。'}</p>
            <button
              type="button"
              className="atlas-btn primary"
              onClick={() => {
                setError(null)
                setLoading(true)
                reload()
                  .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : '重试失败'))
                  .finally(() => setLoading(false))
              }}
            >
              重试
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="atlas-app" style={appStyle}>
      <Canvas
        key={snapshot.workspace.id}
        workspaceId={snapshot.workspace.id}
        cardScale={settings.cardScale}
        nodes={snapshot.nodes}
        viewport={snapshot.viewport}
        onOpen={(node) => void openNode(node)}
        onAddChild={(parent) => {
          setDialogValue('')
          setDialog({ kind: 'node', parentId: parent.id })
        }}
        onMove={moveNode}
        onViewport={saveViewport}
      />

      <div className="atlas-topbar">
        <div className="atlas-brand" title={`工作区存储：${dataDir}`}>
          <span className="atlas-brand-mark">A</span>
          <div>
            <div className="atlas-brand-name">Atlas · 图志</div>
            <div className="atlas-brand-sub">{snapshot.nodes.length} 个节点 · {snapshot.nodes.filter((node) => node.status === 'closed').length} 已收口</div>
          </div>
        </div>

        {update ? (
          <a
            className="atlas-update"
            href={update.url}
            target="_blank"
            rel="noreferrer"
            title={`新版本 ${update.latestVersion}：运行 dsh plugin --profile web update dsh-atlas 后重启 DSH`}
          >
            ↑ v{update.latestVersion}
          </a>
        ) : null}

        <select className="atlas-select" value={snapshot.workspace.id} onChange={(event) => void switchWorkspace(event.target.value)} title="切换工作区">
          {workspaces.map((workspace) => (
            <option key={workspace.id} value={workspace.id}>
              {workspace.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="atlas-btn"
          onClick={() => {
            setDialogValue('')
            setDialog({ kind: 'workspace' })
          }}
          title="新建工作区"
        >
          ＋地图
        </button>

        <span className="atlas-spacer" />

        <div className="atlas-search-wrap">
          <input
            className="atlas-search"
            placeholder="搜索节点、消息、收口卡…"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value)
              setSearchOpen(true)
            }}
            onFocus={() => setSearchOpen(true)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') setSearchOpen(false)
              if (event.key === 'Enter' && hits[0]) openSearchHit(hits[0])
            }}
          />
          {searchOpen && search.trim() ? (
            <div className="atlas-search-pop">
              {hits.length === 0 ? (
                <div className="atlas-search-empty">没有命中</div>
              ) : (
                hits.map((hit) => (
                  <button key={`${hit.kind}-${hit.id}`} type="button" className="atlas-search-hit" onClick={() => openSearchHit(hit)}>
                    <b>
                      {hit.kind === 'node' ? '节点' : hit.kind === 'card' ? '收口卡' : '消息'} · {hit.title}
                    </b>
                    <span>{hit.excerpt || '（无摘要）'}</span>
                  </button>
                ))
              )}
            </div>
          ) : null}
        </div>

        <button type="button" className="atlas-btn" onClick={() => setSettingsOpen(true)} title="界面设置">
          ⚙ 设置
        </button>
        <button
          type="button"
          className="atlas-btn primary"
          onClick={() => {
            setDialogValue('')
            setDialog({ kind: 'node', parentId: null })
          }}
        >
          ＋ 节点
        </button>
        {onExit ? (
          <button type="button" className="atlas-btn ghost" onClick={onExit} title="返回对话">
            ← 对话
          </button>
        ) : null}
      </div>

      {snapshot.nodes.length === 0 ? (
        <div className="atlas-empty">
          <form
            className="atlas-empty-card"
            onSubmit={(event) => {
              event.preventDefault()
              if (emptyTitle.trim()) void createNode(emptyTitle, null)
            }}
          >
            <h2>把第一个模块放上地图</h2>
            <p>例如「02 索引」。之后每次深入都可以开一个节点，关闭时生成收口卡。</p>
            <div className="atlas-empty-form">
              <input
                className="atlas-input"
                autoFocus
                placeholder="节点标题，例如：02 索引"
                value={emptyTitle}
                onChange={(event) => setEmptyTitle(event.target.value)}
              />
              <button type="submit" className="atlas-btn primary">
                开始
              </button>
            </div>
          </form>
        </div>
      ) : null}

      {thread ? (
        <ChatSheet
          key={thread.thread.id}
          snapshot={thread}
          onBack={closeSheet}
          onNodeChanged={updateNodeLocal}
          onSnapshotStale={() => void reload().catch(() => undefined)}
          onDeleted={() => {
            visitRef.current = null
            setThread(null)
            void reload().catch(() => undefined)
          }}
          onToast={showToast}
        />
      ) : null}

      {threadLoading ? (
        <div className="atlas-sheet-backdrop">
          <div className="atlas-sheet" style={{ height: 180, alignSelf: 'center' }}>
            <div className="atlas-loading">
              <span className="atlas-spinner" /> 正在打开对话…
            </div>
          </div>
        </div>
      ) : null}

      {dialog ? (
        <div className="atlas-dialog-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setDialog(null)}>
          <form
            className="atlas-dialog"
            onSubmit={(event) => {
              event.preventDefault()
              void submitDialog()
            }}
          >
            <h3>{dialog.kind === 'workspace' ? '新建地图' : dialog.parentId ? '添加子节点' : '添加节点'}</h3>
            <input
              className="atlas-input"
              autoFocus
              placeholder={dialog.kind === 'workspace' ? '例如：数据库系统' : '例如：02 索引'}
              value={dialogValue}
              onChange={(event) => setDialogValue(event.target.value)}
              onKeyDown={(event) => event.key === 'Escape' && setDialog(null)}
            />
            <div className="atlas-dialog-actions">
              <button type="button" className="atlas-btn" onClick={() => setDialog(null)}>
                取消
              </button>
              <button type="submit" className="atlas-btn primary" disabled={!dialogValue.trim()}>
                创建
              </button>
            </div>
          </form>
        </div>
      ) : null}

      {settingsOpen ? (
        <div
          className="atlas-dialog-backdrop"
          onMouseDown={(event) => event.target === event.currentTarget && setSettingsOpen(false)}
        >
          <div className="atlas-dialog atlas-settings">
            <h3>Atlas 界面设置</h3>
            <label className="atlas-setting">
              <span>节点卡片大小</span>
              <output>{Math.round(settings.cardScale * 100)}%</output>
              <input
                type="range"
                min={85}
                max={135}
                step={5}
                value={Math.round(settings.cardScale * 100)}
                onChange={(event) => updateSettings({ cardScale: Number(event.target.value) / 100 })}
              />
            </label>
            <label className="atlas-setting">
              <span>对话面板宽度</span>
              <output>{settings.chatWidth}px</output>
              <input
                type="range"
                min={820}
                max={1400}
                step={20}
                value={settings.chatWidth}
                onChange={(event) => updateSettings({ chatWidth: Number(event.target.value) })}
              />
            </label>
            <label className="atlas-setting">
              <span>对话字体大小</span>
              <output>{settings.chatFontSize}px</output>
              <input
                type="range"
                min={13}
                max={20}
                step={1}
                value={settings.chatFontSize}
                onChange={(event) => updateSettings({ chatFontSize: Number(event.target.value) })}
              />
            </label>
            <p className="atlas-settings-note">设置保存在当前浏览器，不影响其他人。</p>
            <div className="atlas-dialog-actions">
              <button type="button" className="atlas-btn" onClick={resetSettings}>
                恢复默认
              </button>
              <button type="button" className="atlas-btn primary" onClick={() => setSettingsOpen(false)}>
                完成
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {toast ? <div className="atlas-toast">{toast}</div> : null}
    </div>
  )
}
