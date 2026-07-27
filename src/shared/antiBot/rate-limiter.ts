// 每日投递计数器（基于 chrome.storage.local，跨上下文可访问）
// - 通过 chrome.alarms 每日重置（background/index.ts 中的 daily-reset alarm）
// - 用户可在设置中配置 dailyLimit 上限

const STORAGE_KEY_DAILY_COUNT = 'daily_application_count'
const STORAGE_KEY_DAILY_DATE = 'daily_application_date'

function getTodayKey(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

async function getDailyCount(): Promise<number> {
  try {
    const result = await chrome.storage.local.get([STORAGE_KEY_DAILY_COUNT, STORAGE_KEY_DAILY_DATE])
    const storedDate = result[STORAGE_KEY_DAILY_DATE] as string | undefined
    const today = getTodayKey()
    if (storedDate !== today) {
      // 日期已变，重置计数
      await chrome.storage.local.set({
        [STORAGE_KEY_DAILY_COUNT]: 0,
        [STORAGE_KEY_DAILY_DATE]: today,
      })
      return 0
    }
    return (result[STORAGE_KEY_DAILY_COUNT] as number) ?? 0
  } catch {
    return 0
  }
}

async function getDailyLimitFromSettings(): Promise<number> {
  try {
    const result = await chrome.storage.local.get('shared_settings')
    const settings = result['shared_settings'] as Record<string, unknown> | undefined
    return (settings?.dailyLimit as number) ?? 10000
  } catch {
    return 10000
  }
}

export async function checkDailyLimit(): Promise<{ allowed: boolean; remaining: number }> {
  const [count, limit] = await Promise.all([getDailyCount(), getDailyLimitFromSettings()])
  const remaining = Math.max(0, limit - count)
  return {
    allowed: count < limit,
    remaining,
  }
}

export async function incrementCounter(): Promise<void> {
  const count = await getDailyCount()
  const today = getTodayKey()
  await chrome.storage.local.set({
    [STORAGE_KEY_DAILY_COUNT]: count + 1,
    [STORAGE_KEY_DAILY_DATE]: today,
  })
}

export async function isLimitReached(): Promise<boolean> {
  const { allowed } = await checkDailyLimit()
  return !allowed
}

export async function resetDailyCounter(): Promise<void> {
  const today = getTodayKey()
  await chrome.storage.local.set({
    [STORAGE_KEY_DAILY_COUNT]: 0,
    [STORAGE_KEY_DAILY_DATE]: today,
  })
}
