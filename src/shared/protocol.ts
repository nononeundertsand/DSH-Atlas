/**
 * Host 路由与浏览器请求之间的唯一契约。
 * 所有路径都以 ATLAS_BASE 为前缀，由 DSH 的 webServer 直接承载。
 */
export const ATLAS_BASE = '/ext/atlas'

export const ROUTES = {
  bootstrap: `${ATLAS_BASE}/bootstrap`,
  workspaces: `${ATLAS_BASE}/workspaces`,
  workspace: (id: string) => `${ATLAS_BASE}/workspaces/${id}`,
  viewport: (id: string) => `${ATLAS_BASE}/workspaces/${id}/viewport`,
  nodes: `${ATLAS_BASE}/nodes`,
  node: (id: string) => `${ATLAS_BASE}/nodes/${id}`,
  closeNode: (id: string) => `${ATLAS_BASE}/nodes/${id}/close`,
  threads: `${ATLAS_BASE}/threads`,
  thread: (id: string) => `${ATLAS_BASE}/threads/${id}`,
  turn: (id: string) => `${ATLAS_BASE}/threads/${id}/turn`,
  promote: (id: string) => `${ATLAS_BASE}/threads/${id}/promote`,
  search: `${ATLAS_BASE}/search`,
} as const

export const DEFAULT_VIEWPORT = { x: 0, y: 0, zoom: 1 }

export const LIMITS = {
  recentTurns: 12,
  maxMessageChars: 32_000,
  maxNodes: 500,
  maxMessagesPerThread: 2_000,
} as const
