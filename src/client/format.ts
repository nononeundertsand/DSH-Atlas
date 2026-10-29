import type { AtlasNode } from '../shared/types.js'

export function formatRelativeTime(iso?: string): string {
  if (!iso) return ''
  const time = Date.parse(iso)
  if (Number.isNaN(time)) return ''
  const diff = Math.max(0, Date.now() - time)
  const minutes = Math.floor(diff / 60_000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days} 天前`
  const date = new Date(time)
  return `${date.getMonth() + 1} 月 ${date.getDate()} 日`
}

export function formatDuration(ms?: number): string {
  if (ms === undefined || !Number.isFinite(ms)) return '—'
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 1) return '<1 秒'
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  return `${hours} 小时 ${minutes % 60} 分`
}

/** 画布卡片用的紧凑写法：例「上次 2 小时前 · 12 分钟」；完整文案见 title。 */
export function formatVisit(node: Pick<AtlasNode, 'lastOpenedAt' | 'lastDurationMs'>): string | undefined {
  if (!node.lastOpenedAt) return undefined
  return `上次 ${formatRelativeTime(node.lastOpenedAt)} · ${formatDuration(node.lastDurationMs)}`
}
