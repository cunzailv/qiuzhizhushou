// 拟人节奏与分平台配额引擎

export type PlatformId = 'boss' | 'liepin' | 'zhaopin' | '51job' | 'maimai'

export interface QuotaConfig {
  quota: number
  minDelayMs: number
  maxDelayMs: number
}

// 推荐安全配额与拟人间歇（毫秒）
export const DEFAULT_PLATFORM_CONFIGS: Record<PlatformId, QuotaConfig> = {
  boss: {
    quota: 80,
    minDelayMs: 60_000,
    maxDelayMs: 180_000,
  },
  liepin: {
    quota: 100,
    minDelayMs: 45_000,
    maxDelayMs: 120_000,
  },
  zhaopin: {
    quota: 60,
    minDelayMs: 60_000,
    maxDelayMs: 150_000,
  },
  '51job': {
    quota: 50,
    minDelayMs: 60_000,
    maxDelayMs: 150_000,
  },
  maimai: {
    quota: 25,
    minDelayMs: 90_000,
    maxDelayMs: 240_000,
  },
}

// 运行时间窗口（默认：上午 09:00-11:30，下午 14:00-17:30）
export interface TimeWindow {
  startHour: number
  startMin: number
  endHour: number
  endMin: number
}

// 拟人间歇配置（秒）
export interface IntervalConfig {
  minSeconds: number
  maxSeconds: number
}

export const DEFAULT_INTERVAL_CONFIG: IntervalConfig = {
  minSeconds: 45,
  maxSeconds: 180,
}

export const SETTINGS_KEY_INTERVAL_CONFIG = 'aibot_interval_config'

/** 读取用户自定义的拟人间歇（秒），默认 45-180 秒 */
export async function getSavedIntervalConfig(): Promise<IntervalConfig> {
  try {
    const result = await chrome.storage.local.get(SETTINGS_KEY_INTERVAL_CONFIG)
    const saved = result[SETTINGS_KEY_INTERVAL_CONFIG] as IntervalConfig | undefined
    if (saved && saved.minSeconds > 0 && saved.maxSeconds >= saved.minSeconds) {
      return saved
    }
  } catch {}
  return DEFAULT_INTERVAL_CONFIG
}

/** 保存用户自定义的拟人间歇（秒） */
export async function saveIntervalConfig(config: IntervalConfig): Promise<void> {
  await chrome.storage.local.set({ [SETTINGS_KEY_INTERVAL_CONFIG]: config })
}

export const DEFAULT_WINDOWS: TimeWindow[] = [
  { startHour: 9, startMin: 0, endHour: 11, endMin: 30 },
  { startHour: 14, startMin: 0, endHour: 17, endMin: 30 },
]

export const SETTINGS_KEY_TIME_WINDOWS = 'aibot_time_windows'

/** 格式化单个时间窗口为 HH:mm-HH:mm */
export function formatTimeWindow(win: TimeWindow): string {
  const sh = String(win.startHour).padStart(2, '0')
  const sm = String(win.startMin).padStart(2, '0')
  const eh = String(win.endHour).padStart(2, '0')
  const em = String(win.endMin).padStart(2, '0')
  return `${sh}:${sm}-${eh}:${em}`
}

/** 格式化多个时间窗口 */
export function formatTimeWindows(windows: TimeWindow[]): string {
  if (!windows || windows.length === 0) return '全天 24 小时不限'
  return windows.map(formatTimeWindow).join(' / ')
}

/** 解析 HH:mm 字符串 */
export function parseTimeString(timeStr: string): { hour: number; min: number } | null {
  const parts = timeStr.split(':')
  if (parts.length < 2) return null
  const hour = parseInt(parts[0], 10)
  const min = parseInt(parts[1], 10)
  if (isNaN(hour) || isNaN(min)) return null
  return { hour, min }
}

/** 读取用户保存的工作时段，若无则返回默认 */
export async function getSavedTimeWindows(): Promise<TimeWindow[]> {
  try {
    const result = await chrome.storage.local.get(SETTINGS_KEY_TIME_WINDOWS)
    const saved = result[SETTINGS_KEY_TIME_WINDOWS] as TimeWindow[] | undefined
    if (saved && Array.isArray(saved) && saved.length > 0) {
      return saved
    }
  } catch {
    // 忽略异常
  }
  return DEFAULT_WINDOWS
}

/** 保存用户自定义的工作时段 */
export async function saveTimeWindows(windows: TimeWindow[]): Promise<void> {
  await chrome.storage.local.set({ [SETTINGS_KEY_TIME_WINDOWS]: windows })
}

/** 检查当前时间是否处于允许投递的时间窗口内 */
export function isWithinWindow(windows: TimeWindow[] = DEFAULT_WINDOWS, now = new Date()): boolean {
  if (!windows || windows.length === 0) return true // 若未配置时段，默认全天允许
  const currentMinutes = now.getHours() * 60 + now.getMinutes()
  return windows.some((win) => {
    const start = win.startHour * 60 + win.startMin
    const end = win.endHour * 60 + win.endMin
    return currentMinutes >= start && currentMinutes <= end
  })
}

/** 获取距离下一个时间窗口开启的毫秒数，如果在窗口内返回 0 */
export function getDelayUntilNextWindow(windows: TimeWindow[] = DEFAULT_WINDOWS, now = new Date()): number {
  if (isWithinWindow(windows, now)) return 0
  if (!windows || windows.length === 0) return 0
  const currentMinutes = now.getHours() * 60 + now.getMinutes()

  // 寻找今天后续的窗口
  for (const win of windows) {
    const start = win.startHour * 60 + win.startMin
    if (start > currentMinutes) {
      return (start - currentMinutes) * 60 * 1000
    }
  }

  // 今天窗口都已过，计算距离明天第一个窗口的时间
  if (windows.length > 0) {
    const firstWin = windows[0]
    const tomorrowMinutes = 24 * 60 - currentMinutes + (firstWin.startHour * 60 + firstWin.startMin)
    return tomorrowMinutes * 60 * 1000
  }

  return 60_000
}

/** 生成指定平台的拟人随机延迟（毫秒），支持传入用户自定义秒级间歇配置 */
export function getRandomInterval(
  platform: PlatformId,
  config?: Partial<QuotaConfig>,
  customInterval?: IntervalConfig,
): number {
  if (customInterval && customInterval.minSeconds > 0 && customInterval.maxSeconds >= customInterval.minSeconds) {
    const minMs = customInterval.minSeconds * 1000
    const maxMs = customInterval.maxSeconds * 1000
    return Math.floor(minMs + Math.random() * (maxMs - minMs))
  }
  const base = DEFAULT_PLATFORM_CONFIGS[platform] || DEFAULT_PLATFORM_CONFIGS.boss
  const min = config?.minDelayMs ?? base.minDelayMs
  const max = config?.maxDelayMs ?? base.maxDelayMs
  return Math.floor(min + Math.random() * (max - min))
}
