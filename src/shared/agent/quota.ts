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

/** 支持的平台顺序（UI / 存储 / 调度共用） */
export const PLATFORM_IDS: PlatformId[] = ['boss', 'liepin', 'zhaopin', '51job', 'maimai']

/** 各平台默认投递数量（由推荐安全配额派生，保持单一来源） */
export const DEFAULT_PLATFORM_QUOTAS: Record<PlatformId, number> = {
  boss: DEFAULT_PLATFORM_CONFIGS.boss.quota,
  liepin: DEFAULT_PLATFORM_CONFIGS.liepin.quota,
  zhaopin: DEFAULT_PLATFORM_CONFIGS.zhaopin.quota,
  '51job': DEFAULT_PLATFORM_CONFIGS['51job'].quota,
  maimai: DEFAULT_PLATFORM_CONFIGS.maimai.quota,
}

/** 单个平台可设置的投递数量区间 */
export const MIN_PLATFORM_QUOTA = 1
export const MAX_PLATFORM_QUOTA = 500

/** 用户自定义的各平台投递数量（chrome.storage.local 单一真源） */
export const SETTINGS_KEY_PLATFORM_QUOTAS = 'aibot_platform_quotas'

/**
 * 把任意来源（storage / 消息 payload）的配额整理成完整的合法配额表。
 * 缺失、非数字、越界的值统一回退到平台默认值，避免脏数据卡住调度。
 */
export function normalizePlatformQuotas(raw: unknown): Record<PlatformId, number> {
  const source = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const result: Record<PlatformId, number> = { ...DEFAULT_PLATFORM_QUOTAS }
  for (const pid of PLATFORM_IDS) {
    const candidate = source[pid]
    const numeric =
      typeof candidate === 'number'
        ? candidate
        : typeof candidate === 'string' && candidate.trim() !== ''
          ? Number(candidate)
          : NaN
    if (!Number.isFinite(numeric)) continue
    result[pid] = Math.min(
      MAX_PLATFORM_QUOTA,
      Math.max(MIN_PLATFORM_QUOTA, Math.round(numeric)),
    )
  }
  return result
}

/** 读取用户自定义的各平台投递数量，未设置时返回推荐默认值 */
export async function getSavedPlatformQuotas(): Promise<Record<PlatformId, number>> {
  try {
    const result = await chrome.storage.local.get(SETTINGS_KEY_PLATFORM_QUOTAS)
    return normalizePlatformQuotas(result[SETTINGS_KEY_PLATFORM_QUOTAS])
  } catch {
    return { ...DEFAULT_PLATFORM_QUOTAS }
  }
}

/** 局部更新各平台投递数量，返回更新后的完整配额表 */
export async function savePlatformQuotas(
  quotas: Partial<Record<PlatformId, number>>,
): Promise<Record<PlatformId, number>> {
  const current = await getSavedPlatformQuotas()
  const next = normalizePlatformQuotas({ ...current, ...quotas })
  await chrome.storage.local.set({ [SETTINGS_KEY_PLATFORM_QUOTAS]: next })
  return next
}

/** 恢复各平台推荐默认投递数量 */
export async function resetPlatformQuotas(): Promise<Record<PlatformId, number>> {
  const defaults = { ...DEFAULT_PLATFORM_QUOTAS }
  await chrome.storage.local.set({ [SETTINGS_KEY_PLATFORM_QUOTAS]: defaults })
  return defaults
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
  } catch { /* 预期内异常，安全忽略 */ }
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

/** 检查当前时间是否处于允许投递的时间窗口内（支持跨午夜窗口，如 22:00-02:00） */
export function isWithinWindow(windows: TimeWindow[] = DEFAULT_WINDOWS, now = new Date()): boolean {
  if (!windows || windows.length === 0) return true // 若未配置时段，默认全天允许
  const currentMinutes = now.getHours() * 60 + now.getMinutes()
  return windows.some((win) => {
    const start = win.startHour * 60 + win.startMin
    const end = win.endHour * 60 + win.endMin
    if (start === end) return true // 首尾相同视为全天
    if (start < end) return currentMinutes >= start && currentMinutes <= end
    // 跨午夜：当天晚些时候到次日凌晨
    return currentMinutes >= start || currentMinutes <= end
  })
}

/** 获取距离下一个时间窗口开启的毫秒数，如果在窗口内返回 0 */
export function getDelayUntilNextWindow(windows: TimeWindow[] = DEFAULT_WINDOWS, now = new Date()): number {
  if (isWithinWindow(windows, now)) return 0
  if (!windows || windows.length === 0) return 0
  const currentMinutes = now.getHours() * 60 + now.getMinutes()

  // 统一按“距离最近的窗口开始时间”计算，跨午夜窗口也成立
  let minDeltaMinutes = Number.POSITIVE_INFINITY
  for (const win of windows) {
    const start = win.startHour * 60 + win.startMin
    let delta = start - currentMinutes
    if (delta <= 0) delta += 24 * 60
    if (delta < minDeltaMinutes) minDeltaMinutes = delta
  }

  if (!Number.isFinite(minDeltaMinutes)) return 60_000
  return minDeltaMinutes * 60 * 1000
}

/**
 * 统计从 now 到 deadline 之间，真正落在「允许投递时段」内的分钟数。
 *
 * 目标产能必须用它算可达性：墙钟还剩 2 小时，但工作时段 21:00 就结束，
 * 实际可投时长可能是 0。旧版只看墙钟时间，会给出假的「进度正常」，
 * 用户设了「2 小时投满 80 份」却在 21:00 被直接休眠到第二天早上。
 */
export function countUsableMinutesUntil(
  windows: TimeWindow[] = DEFAULT_WINDOWS,
  now = new Date(),
  deadlineMs = 0,
): number {
  const wallMinutes = Math.max(0, Math.ceil(deadlineMs / 60_000))
  if (!windows || windows.length === 0) return wallMinutes
  const totalMinutes = Math.min(24 * 60, wallMinutes)
  let usable = 0
  for (let minute = 0; minute < totalMinutes; minute++) {
    if (isWithinWindow(windows, new Date(now.getTime() + minute * 60_000))) usable++
  }
  return usable
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
