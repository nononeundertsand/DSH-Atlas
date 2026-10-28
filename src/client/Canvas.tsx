/**
 * 无限画布：世界坐标 + 相机，自绘 DOM + 单层 SVG 边。
 * 只做地图该做的事：平移、缩放、拖拽、适配、语义缩放。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AtlasNode, Point, Viewport } from '../shared/types.js'

const NODE_W = 288
const NODE_H = 104

export interface CanvasProps {
  workspaceId: string
  nodes: AtlasNode[]
  viewport: Viewport
  onOpen: (node: AtlasNode) => void
  onAddChild: (parent: AtlasNode) => void
  onMove: (nodeId: string, position: Point) => void
  onViewport: (viewport: Viewport) => void
}

interface DragState {
  nodeId: string
  startX: number
  startY: number
  originX: number
  originY: number
  position: Point
  moved: boolean
}

export function Canvas({ workspaceId, nodes, viewport, onOpen, onAddChild, onMove, onViewport }: CanvasProps) {
  const stageRef = useRef<HTMLDivElement>(null)
  const [camera, setCamera] = useState<Viewport>(viewport)
  const [localNodes, setLocalNodes] = useState(nodes)
  const [collapsed, setCollapsed] = useState<Set<string>>(() => loadCollapsed(workspaceId))
  const [panning, setPanning] = useState(false)
  const panRef = useRef<{ x: number; y: number; camX: number; camY: number } | null>(null)
  const dragRef = useRef<DragState | null>(null)
  const suppressClick = useRef(false)
  const saveTimer = useRef<number | undefined>(undefined)

  useEffect(() => setLocalNodes(nodes), [nodes])
  useEffect(() => setCamera(viewport), [viewport])
  useEffect(() => setCollapsed(loadCollapsed(workspaceId)), [workspaceId])
  useEffect(() => saveCollapsed(workspaceId, collapsed), [workspaceId, collapsed])

  const hidden = useMemo(() => hiddenDescendants(localNodes, collapsed), [localNodes, collapsed])
  const visibleNodes = useMemo(() => localNodes.filter((node) => !hidden.has(node.id)), [localNodes, hidden])

  const persist = useCallback(
    (next: Viewport) => {
      window.clearTimeout(saveTimer.current)
      saveTimer.current = window.setTimeout(() => onViewport(next), 260)
    },
    [onViewport],
  )

  const zoomAt = useCallback((factor: number, clientX: number, clientY: number) => {
    const stage = stageRef.current
    if (!stage) return
    const rect = stage.getBoundingClientRect()
    const px = clientX - rect.left
    const py = clientY - rect.top
    setCamera((current) => {
      const zoom = clamp(current.zoom * factor, 0.15, 2.5)
      const worldX = (px - current.x) / current.zoom
      const worldY = (py - current.y) / current.zoom
      const next = { zoom, x: px - worldX * zoom, y: py - worldY * zoom }
      persist(next)
      return next
    })
  }, [persist])

  // 原生 wheel 监听，确保可以 preventDefault。
  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      zoomAt(Math.exp(-event.deltaY * 0.0015), event.clientX, event.clientY)
    }
    stage.addEventListener('wheel', onWheel, { passive: false })
    return () => stage.removeEventListener('wheel', onWheel)
  }, [zoomAt])

  const fit = useCallback(() => {
    const stage = stageRef.current
    if (!stage || visibleNodes.length === 0) return
    const rect = stage.getBoundingClientRect()
    const minX = Math.min(...visibleNodes.map((node) => node.position.x))
    const minY = Math.min(...visibleNodes.map((node) => node.position.y))
    const maxX = Math.max(...visibleNodes.map((node) => node.position.x + NODE_W))
    const maxY = Math.max(...visibleNodes.map((node) => node.position.y + NODE_H))
    const pad = 70
    const zoom = clamp(
      Math.min((rect.width - pad * 2) / (maxX - minX), (rect.height - pad * 2) / (maxY - minY), 1.15),
      0.18,
      1.15,
    )
    const next = {
      zoom,
      x: (rect.width - (maxX - minX) * zoom) / 2 - minX * zoom,
      y: (rect.height - (maxY - minY) * zoom) / 2 - minY * zoom,
    }
    setCamera(next)
    persist(next)
  }, [visibleNodes, persist])

  const lod = camera.zoom >= 0.85 ? '' : camera.zoom >= 0.5 ? 'lod-mid' : camera.zoom >= 0.3 ? 'lod-far' : 'lod-map'

  return (
    <div
      ref={stageRef}
      className={`atlas-canvas ${panning ? 'panning' : ''} ${lod}`}
      onPointerDown={(event) => {
        if (event.button !== 0 || event.target !== event.currentTarget) return
        panRef.current = { x: event.clientX, y: event.clientY, camX: camera.x, camY: camera.y }
        setPanning(true)
        event.currentTarget.setPointerCapture(event.pointerId)
      }}
      onPointerMove={(event) => {
        const pan = panRef.current
        if (!pan) return
        setCamera((current) => ({ ...current, x: pan.camX + event.clientX - pan.x, y: pan.camY + event.clientY - pan.y }))
      }}
      onPointerUp={() => {
        if (!panRef.current) return
        panRef.current = null
        setPanning(false)
        setCamera((current) => {
          persist(current)
          return current
        })
      }}
      onDoubleClick={(event) => {
        if (event.target === event.currentTarget) fit()
      }}
    >
      <div
        className="atlas-grid"
        style={{
          backgroundSize: `${26 * camera.zoom}px ${26 * camera.zoom}px`,
          backgroundPosition: `${camera.x}px ${camera.y}px`,
        }}
      />

      <div className="atlas-world" style={{ transform: `translate(${camera.x}px, ${camera.y}px) scale(${camera.zoom})` }}>
        <svg className="atlas-edges" width={1} height={1} style={{ overflow: 'visible', position: 'absolute', left: 0, top: 0 }}>
          {visibleNodes.map((node) => {
            const parent = node.parentId ? visibleNodes.find((item) => item.id === node.parentId) : undefined
            if (!parent) return null
            const x1 = parent.position.x + NODE_W
            const y1 = parent.position.y + NODE_H / 2
            const x2 = node.position.x
            const y2 = node.position.y + NODE_H / 2
            const mid = (x1 + x2) / 2
            const active = node.status === 'active'
            return (
              <path
                key={`${parent.id}-${node.id}`}
                className={`atlas-edge ${active ? 'is-active' : ''}`}
                d={`M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`}
              />
            )
          })}
        </svg>

        {visibleNodes.map((node) => {
          const childCount = localNodes.filter((item) => item.parentId === node.id).length
          const descendantTotal = countDescendants(localNodes, node.id)
          const isCollapsed = collapsed.has(node.id)
          return (
          <div
            key={node.id}
            className={`atlas-node is-${node.status} ${childCount > 0 ? 'has-children' : ''} ${isCollapsed ? 'is-collapsed' : ''}`}
            style={{ transform: `translate(${node.position.x}px, ${node.position.y}px)` }}
            title={node.title}
            onPointerDown={(event) => {
              if (event.button !== 0) return
              event.stopPropagation()
              const target = event.target as HTMLElement
              if (target.closest('button')) return
              dragRef.current = {
                nodeId: node.id,
                startX: event.clientX,
                startY: event.clientY,
                originX: node.position.x,
                originY: node.position.y,
                position: node.position,
                moved: false,
              }
              event.currentTarget.setPointerCapture(event.pointerId)
            }}
            onPointerMove={(event) => {
              const drag = dragRef.current
              if (!drag || drag.nodeId !== node.id) return
              const dx = (event.clientX - drag.startX) / camera.zoom
              const dy = (event.clientY - drag.startY) / camera.zoom
              if (Math.abs(dx) + Math.abs(dy) > 2) drag.moved = true
              const position = { x: drag.originX + dx, y: drag.originY + dy }
              drag.position = position
              setLocalNodes((current) =>
                current.map((item) => (item.id === node.id ? { ...item, position } : item)),
              )
            }}
            onPointerUp={(event) => {
              const drag = dragRef.current
              if (!drag || drag.nodeId !== node.id) return
              dragRef.current = null
              suppressClick.current = drag.moved
              if (drag.moved) onMove(node.id, drag.position)
              event.stopPropagation()
            }}
            onClick={() => {
              if (suppressClick.current) {
                suppressClick.current = false
                return
              }
              onOpen(node)
            }}
          >
            <div className="atlas-node-title">{node.title}</div>
            <div className="atlas-node-sub">{node.subtitle || '点击进入对话'}</div>
            <div className="atlas-node-meta">
              <span className="atlas-status-dot" />
              <span>{statusLabel(node.status)}</span>
              <span className="atlas-mastery">
                {Array.from({ length: 5 }, (_, index) => (
                  <i key={index} className={index < node.mastery ? 'on' : ''} />
                ))}
              </span>
            </div>
            <div className="atlas-node-actions">
              {childCount > 0 ? (
                <button
                  type="button"
                  className="atlas-node-toggle"
                  title={isCollapsed ? `展开 ${descendantTotal} 个后代节点` : `收起 ${descendantTotal} 个后代节点`}
                  onClick={(event) => {
                    event.stopPropagation()
                    setCollapsed((current) => {
                      const next = new Set(current)
                      if (next.has(node.id)) next.delete(node.id)
                      else next.add(node.id)
                      return next
                    })
                  }}
                >
                  {isCollapsed ? `+${descendantTotal}` : '−'}
                </button>
              ) : null}
              <button
                type="button"
                className="atlas-node-add"
                title="添加子节点"
                onClick={(event) => {
                  event.stopPropagation()
                  setCollapsed((current) => {
                    if (!current.has(node.id)) return current
                    const next = new Set(current)
                    next.delete(node.id)
                    return next
                  })
                  onAddChild(node)
                }}
              >
                +
              </button>
            </div>
          </div>
          )
        })}
      </div>

      <div style={{ position: 'absolute', right: 16, bottom: 16, display: 'flex', gap: 6, zIndex: 10 }}>
        <button type="button" className="atlas-btn" onClick={() => zoomAt(1.2, (stageRef.current?.clientWidth ?? 0) / 2, (stageRef.current?.clientHeight ?? 0) / 2)}>
          +
        </button>
        <button type="button" className="atlas-btn" onClick={() => zoomAt(1 / 1.2, (stageRef.current?.clientWidth ?? 0) / 2, (stageRef.current?.clientHeight ?? 0) / 2)}>
          −
        </button>
        <button type="button" className="atlas-btn" onClick={fit} title="适配视图（F）">
          {Math.round(camera.zoom * 100)}%
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

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function countDescendants(nodes: AtlasNode[], nodeId: string): number {
  let count = 0
  const walk = (parentId: string) => {
    for (const node of nodes) {
      if (node.parentId !== parentId) continue
      count++
      walk(node.id)
    }
  }
  walk(nodeId)
  return count
}

/** 收起一个节点时，隐藏它的整棵子树。 */
function hiddenDescendants(nodes: AtlasNode[], collapsed: Set<string>): Set<string> {
  const hidden = new Set<string>()
  const walk = (parentId: string) => {
    for (const node of nodes) {
      if (node.parentId !== parentId || hidden.has(node.id)) continue
      hidden.add(node.id)
      walk(node.id)
    }
  }
  for (const id of collapsed) walk(id)
  return hidden
}

function collapseKey(workspaceId: string): string {
  return `dsh-atlas:collapsed:${workspaceId}`
}

function loadCollapsed(workspaceId: string): Set<string> {
  try {
    const raw = window.localStorage.getItem(collapseKey(workspaceId))
    const ids = raw ? (JSON.parse(raw) as unknown) : []
    return new Set(Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [])
  } catch {
    return new Set()
  }
}

function saveCollapsed(workspaceId: string, collapsed: Set<string>): void {
  try {
    window.localStorage.setItem(collapseKey(workspaceId), JSON.stringify([...collapsed]))
  } catch {
    // localStorage 不可用时只保留本次会话的收起状态。
  }
}
