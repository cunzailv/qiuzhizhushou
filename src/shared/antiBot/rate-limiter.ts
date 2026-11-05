// 每日沟通计数器（基于 chrome.storage.local，跨上下文可访问）
// - 通过 chrome.alarms 每日重置（background/index.ts 中的 daily-reset alarm）
// - 分平台上限与 AIbot 面板的「各平台投递数量」共用同一真源，改一处即全局生效
import {
  DEFAULT_PLATFORM_QUOTAS as AGENT_DEFAULT_QUOTAS,
  SETTINGS_KEY_PLATFORM_QUOTAS,
  normalizePlatformQuotas,
} from '../agent/quota'
import type { PlatformId } from '../agent/quota'
import { CONSERVATIVE_VALUES } from '../types/safety-preset'

const STORAGE_KEY_DAILY_COUNT = 'daily_application_count'
const STORAGE_KEY_DAILY_DATE = 'daily_application_date'
const STORAGE_KEY_PLATFORM_COUNTS = 'daily_platform_counts'

// 默认分平台保护配额（与 campaign 推荐配额保持一致）
export const DEFAULT_PLATFORM_QUOTAS: Record<string, number> = { ...AGENT_DEFAULT_QUOTAS }

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
    const result = await chrome.storage.local.get([SETTINGS_KEY_PLATFORM_QUOTAS, 'shared_settings'])
    const settings = result['shared_settings'] as Record<string, unknown> | undefined
    if (platformId) {
      // 第一优先级：AIbot 面板里用户自定义的各平台投递数量（持久化在 aibot_platform_quotas）
      const savedQuotas = result[SETTINGS_KEY_PLATFORM_QUOTAS]
      if (savedQuotas !== undefined) {
        return (
          normalizePlatformQuotas(savedQuotas)[platformId as PlatformId] ??
          DEFAULT_PLATFORM_QUOTAS[platformId] ??
          80
        )
      }
      // 兼容旧版设置页写入的 platformQuotas
      const legacyQuotas = settings?.platformQuotas as Record<string, number> | undefined
      if (legacyQuotas?.[platformId] !== undefined) return legacyQuotas[platformId]
      return DEFAULT_PLATFORM_QUOTAS[platformId] ?? (settings?.dailyLimit as number) ?? 80
    }
    return (settings?.dailyLimit as number) ?? CONSERVATIVE_VALUES.dailyLimit
  } catch {
    return platformId ? (DEFAULT_PLATFORM_QUOTAS[platformId] ?? 80) : CONSERVATIVE_VALUES.dailyLimit
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
