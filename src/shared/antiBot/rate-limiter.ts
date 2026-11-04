// 每日沟通计数器（基于 chrome.storage.local，跨上下文可访问）
// - 通过 chrome.alarms 每日重置（background/index.ts 中的 daily-reset alarm）
// - 用户可在设置中配置 platformQuotas 或全局 dailyLimit 上限

const STORAGE_KEY_DAILY_COUNT = 'daily_application_count'
const STORAGE_KEY_DAILY_DATE = 'daily_application_date'
const STORAGE_KEY_PLATFORM_COUNTS = 'daily_platform_counts'

// 默认分平台保护配额
export const DEFAULT_PLATFORM_QUOTAS: Record<string, number> = {
  boss: 80,
  liepin: 100,
  zhaopin: 60,
  '51job': 50,
  maimai: 25,
}

function getTodayKey(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

export async function getDailyCount(platformId?: string): Promise<number> {
  try {
    const result = await chrome.storage.local.get([
      STORAGE_KEY_DAILY_COUNT,
      STORAGE_KEY_DAILY_DATE,
      STORAGE_KEY_PLATFORM_COUNTS,
    ])
    const storedDate = result[STORAGE_KEY_DAILY_DATE] as string | undefined
    const today = getTodayKey()
    if (storedDate !== today) {
      // 日期已变，重置计数
      await chrome.storage.local.set({
        [STORAGE_KEY_DAILY_COUNT]: 0,
        [STORAGE_KEY_PLATFORM_COUNTS]: {},
        [STORAGE_KEY_DAILY_DATE]: today,
      })
      return 0
    }
    if (platformId) {
      const platformCounts = (result[STORAGE_KEY_PLATFORM_COUNTS] as Record<string, number>) ?? {}
      return platformCounts[platformId] ?? 0
    }
    return (result[STORAGE_KEY_DAILY_COUNT] as number) ?? 0
  } catch {
    return 0
  }
}

async function getDailyLimitFromSettings(platformId?: string): Promise<number> {
  try {
    const result = await chrome.storage.local.get('shared_settings')
    const settings = result['shared_settings'] as Record<string, unknown> | undefined
    if (platformId) {
      const platformQuotas = (settings?.platformQuotas as Record<string, number>) ?? {}
      if (platformQuotas[platformId] !== undefined) {
        return platformQuotas[platformId]
      }
      return DEFAULT_PLATFORM_QUOTAS[platformId] ?? (settings?.dailyLimit as number) ?? 80
    }
    return (settings?.dailyLimit as number) ?? 10000
  } catch {
    return platformId ? (DEFAULT_PLATFORM_QUOTAS[platformId] ?? 80) : 10000
  }
}

export async function checkDailyLimit(platformId?: string): Promise<{ allowed: boolean; remaining: number }> {
  const [count, limit] = await Promise.all([
    getDailyCount(platformId),
    getDailyLimitFromSettings(platformId),
  ])
  const remaining = Math.max(0, limit - count)
  return {
    allowed: count < limit,
    remaining,
  }
}

export async function incrementCounter(platformId?: string): Promise<void> {
  const result = await chrome.storage.local.get([
    STORAGE_KEY_DAILY_COUNT,
    STORAGE_KEY_DAILY_DATE,
    STORAGE_KEY_PLATFORM_COUNTS,
  ])
  const today = getTodayKey()
  const count = (result[STORAGE_KEY_DAILY_DATE] === today ? (result[STORAGE_KEY_DAILY_COUNT] as number) : 0) || 0
  const platformCounts: Record<string, number> =
    result[STORAGE_KEY_DAILY_DATE] === today ? ((result[STORAGE_KEY_PLATFORM_COUNTS] as Record<string, number>) || {}) : {}

  if (platformId) {
    platformCounts[platformId] = (platformCounts[platformId] || 0) + 1
  }

  await chrome.storage.local.set({
    [STORAGE_KEY_DAILY_COUNT]: count + 1,
    [STORAGE_KEY_PLATFORM_COUNTS]: platformCounts,
    [STORAGE_KEY_DAILY_DATE]: today,
  })
}

export async function isLimitReached(platformId?: string): Promise<boolean> {
  const { allowed } = await checkDailyLimit(platformId)
  return !allowed
}

export async function resetDailyCounter(): Promise<void> {
  const today = getTodayKey()
  await chrome.storage.local.set({
    [STORAGE_KEY_DAILY_COUNT]: 0,
    [STORAGE_KEY_PLATFORM_COUNTS]: {},
    [STORAGE_KEY_DAILY_DATE]: today,
  })
}
