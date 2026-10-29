/** Atlas 的浏览器本地界面设置。 */
export interface AtlasSettings {
  /** 画布节点卡片缩放，1 = 288×104。 */
  cardScale: number
  /** 对话面板最大宽度（px）。 */
  chatWidth: number
  /** 对话正文字号（px）。 */
  chatFontSize: number
}

export const DEFAULT_SETTINGS: AtlasSettings = {
  cardScale: 1,
  chatWidth: 1040,
  chatFontSize: 14,
}

const KEY = 'dsh-atlas:settings:v1'

export function loadSettings(): AtlasSettings {
  try {
    const raw = window.localStorage.getItem(KEY)
    const value = raw ? (JSON.parse(raw) as Partial<AtlasSettings>) : {}
    return normalize({ ...DEFAULT_SETTINGS, ...value })
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

export function saveSettings(settings: AtlasSettings): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(settings))
  } catch {
    // localStorage 不可用时只保留本次会话。
  }
}

export function normalize(settings: AtlasSettings): AtlasSettings {
  return {
    cardScale: clamp(settings.cardScale, 0.85, 1.35),
    chatWidth: Math.round(clamp(settings.chatWidth, 820, 1400)),
    chatFontSize: Math.round(clamp(settings.chatFontSize, 13, 20)),
  }
}

function clamp(value: number, min: number, max: number): number {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : min
}
