/**
 * DSH 浏览器插件入口。
 *
 * 注册两个位置：
 * - main / key=atlas：中央全局面板；
 * - sidebar.panellist / id=atlas：侧边栏的 Atlas 图标（由 DSH 负责选中逻辑）。
 */
import type { ClientContext } from '../shared/dsh.js'
import { AtlasApp } from './AtlasApp.js'
import { ATLAS_CSS } from './styles.js'
import { SessionTree } from './SessionTree.js'
import { api } from './api.js'
import type { AtlasNode } from '../shared/types.js'

const PANEL_ID = 'atlas'

export const inject = ['slots', 'layout', 'uiWorkspace', 'sessions']

export function apply(ctx: ClientContext): void {
  let removeTree: (() => void) | undefined
  let pending: Promise<void> | undefined
  let disposed = false
  const showWorkspaces = () => { removeTree?.(); removeTree = undefined; sessionStorage.removeItem('atlas.current-node') }
  const openSession = (node: AtlasNode): Promise<void> => {
    if (pending) return pending
    pending = (async () => {
      const result = await api.openSession(node.id)
      if (disposed) return
      const bound = result.node
      if (!bound.sessionId) throw new Error('节点缺少 Session 绑定')
      await ctx.sessions.refresh()
      removeTree?.()
      removeTree = ctx.slots.register({
        name: 'sidebar.workspaces', priority: -10,
        inject: () => ({ current: bound, openNode: openSession, showMap: () => ctx.layout.selectPanel(PANEL_ID), showWorkspaces }),
      }, SessionTree)
      sessionStorage.setItem('atlas.current-node', bound.id)
      ctx.uiWorkspace.openSession(bound.sessionId)
    })().finally(() => { pending = undefined })
    return pending
  }
  ctx.effect(() => () => { disposed = true; removeTree?.() }, 'dsh-atlas: session navigation')
  ctx.effect(() => {
    const existing = document.querySelector('style[data-dsh-atlas]')
    if (existing) return
    const style = document.createElement('style')
    style.dataset.dshAtlas = 'true'
    style.textContent = ATLAS_CSS
    document.head.append(style)
    return () => style.remove()
  }, 'dsh-atlas: styles')

  ctx.slots.inject('main', () => {
    const dispose = ctx.slots.register(
      {
        name: 'main',
        key: PANEL_ID,
        inject: () => ({ exit: () => ctx.layout.selectPanel(null), openSession }),
      },
      AtlasPanel as never,
    )
    // 深链：.../#atlas 直接打开地图，也便于自动化验收。
    if (window.location.hash === '#atlas') ctx.layout.selectPanel(PANEL_ID)
    return dispose
  })

  ctx.slots.inject('sidebar.panellist', () =>
    ctx.slots.register(
      { name: 'sidebar.panellist', id: PANEL_ID, order: 5, label: 'Atlas · 图志' },
      AtlasIcon as never,
    ),
  )
  ctx.slots.inject('sidebar.workspaces', () => {
    const last = sessionStorage.getItem('atlas.current-node')
    if (last) void api.bootstrap().then(async ({ workspaces }) => {
      for (const workspace of workspaces) {
        const { snapshot } = await api.getWorkspace(workspace.id)
        const node = snapshot.nodes.find(item => item.id === last)
        if (node && !disposed) { await openSession(node); return }
      }
    }).catch(() => { sessionStorage.removeItem('atlas.current-node') })
  })
}

function AtlasPanel({ exit, openSession }: { exit: () => void; openSession: (node: AtlasNode) => Promise<void> }) {
  return <AtlasApp onExit={exit} onOpenSession={openSession} />
}

function AtlasIcon({ size = 16, active = false }: { size?: number; active?: boolean }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      style={{ opacity: active ? 1 : 0.72 }}
    >
      <rect x="1.5" y="2" width="5.2" height="4.2" rx="1.2" stroke="currentColor" strokeWidth="1.1" />
      <rect x="9.3" y="2" width="5.2" height="4.2" rx="1.2" stroke="currentColor" strokeWidth="1.1" />
      <rect x="5.4" y="9.8" width="5.2" height="4.2" rx="1.2" stroke="currentColor" strokeWidth="1.1" />
      <path d="M6.7 6.2v1.4h2.6V6.2M8 7.6v2.2" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
    </svg>
  )
}
