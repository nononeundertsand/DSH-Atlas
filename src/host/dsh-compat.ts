/**
 * DSH 0.2.1-rc.2 / 0.2.2-rc.1 会话接口兼容边界。
 *
 * 会话检查：旧版用 sessionController.inspect(id)，抛 ApiSessionNotFound；
 * 新版移除 inspect，改用 sessionQuery.observeSession(id, { projectionMode: 'none' })，
 * 返回带 [Symbol.dispose]() 的观察租约，不存在时抛 code = SESSION_QUERY_SESSION_NOT_FOUND。
 *
 * 标题：旧版 readTitleSnapshots() 返回 Session ID → 标题映射；
 * 新版返回逐会话结果列表 { sessionId, status, value?, reason? }，
 * 其中 value.title 是 dsh-session-title 的快照对象 { title: string, ... }。
 */
import type { HostContext, SessionObservation } from '../shared/dsh.js'

export interface SessionPorts {
  sessionQuery?: HostContext['sessionQuery']
  sessionController?: HostContext['sessionController']
}

export type SessionExistence = 'exists' | 'missing'
export type SessionChecker = (sessionId: string) => Promise<SessionExistence>

const NEW_NOT_FOUND = 'SESSION_QUERY_SESSION_NOT_FOUND'

function isNewSessionNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === NEW_NOT_FOUND
}

function isLegacySessionNotFound(error: unknown): boolean {
  return error instanceof Error && error.constructor.name === 'ApiSessionNotFound'
}

/**
 * 按实际能力选择会话检查接口。必须放在工作区创建、会话创建和绑定变更之前调用，
 * 且不能在插件加载时调用（缺少能力只影响节点打开，不阻止插件加载）。
 * 新版接口存在时只走新版：查询失败原样上抛，不降级调用旧版掩盖异常。
 */
export function sessionChecker(ports: SessionPorts): SessionChecker {
  const query = ports.sessionQuery
  if (typeof query?.observeSession === 'function') {
    return async sessionId => {
      let observation: SessionObservation
      try {
        observation = await query.observeSession!(sessionId, { projectionMode: 'none' })
      } catch (error) {
        if (isNewSessionNotFound(error)) return 'missing'
        throw error
      }
      try { return 'exists' }
      finally { observation[Symbol.dispose]?.() }
    }
  }
  const controller = ports.sessionController
  if (typeof controller?.inspect === 'function') {
    return async sessionId => {
      try {
        await controller.inspect!(sessionId)
        return 'exists'
      } catch (error) {
        if (isLegacySessionNotFound(error)) return 'missing'
        throw error
      }
    }
  }
  throw new Error('E_UNSUPPORTED: Atlas 与当前 DSH 会话接口不兼容，无法检查会话（新版 sessionQuery.observeSession 与旧版 sessionController.inspect 均不可用）')
}

export type TitleMap = Record<string, string>

/** 旧版映射值是标题字符串；新版 value.title 是含 title 文本的快照对象。 */
function titleText(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() ? value : undefined
  if (value && typeof value === 'object') {
    const text = (value as { title?: unknown }).title
    if (typeof text === 'string' && text.trim()) return text
  }
  return undefined
}

/** 把新旧两种 readTitleSnapshots 返回值统一成插件内部的 Session ID → 标题映射。 */
export function toTitleMap(raw: unknown): TitleMap {
  const titles: TitleMap = {}
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (!entry || typeof entry !== 'object') continue
      const result = entry as { sessionId?: unknown; status?: unknown; value?: unknown }
      // 单项失败（rejected / 无 value）只回退该项，不影响其他成功项。
      if (result.status !== 'fulfilled' || typeof result.sessionId !== 'string' || !result.sessionId) continue
      const value = result.value
      if (!value || typeof value !== 'object') continue
      const text = titleText((value as { title?: unknown }).title)
      if (text) titles[result.sessionId] = text
    }
    return titles
  }
  if (raw && typeof raw === 'object') {
    for (const [sessionId, value] of Object.entries(raw as Record<string, unknown>)) {
      const text = titleText(value)
      if (text) titles[sessionId] = text
    }
  }
  return titles
}

/** 读取标题映射；整体查询失败时返回空映射，列表仍可用。 */
export async function readTitleMap(query: HostContext['sessionQuery'], ids: string[]): Promise<TitleMap> {
  if (!query || !ids.length) return {}
  try { return toTitleMap(await query.readTitleSnapshots(ids)) }
  catch { return {} }
}
