import { db } from './index'
import type { CandidateProfilePreferences } from '../types/candidate-profile'
import { DEFAULT_CANDIDATE_PREFERENCES } from '../types/candidate-profile'
import { DEFAULT_SAFETY_PROFILE, type SafetyProfileId } from '../types/safety-preset'

// 重要：content script 里的 IndexedDB 属于「网页域」（如 zhipin.com），
// 与 popup/options（扩展域）不是同一个数据库，直接用 Dexie 读设置会读不到。
// 因此设置采用双写：Dexie（扩展页面内的历史兼容）+ chrome.storage.local（全上下文共享）。
// 读取时优先 chrome.storage.local，保证 content script 拿到的是用户真实配置。

const STORAGE_PREFIX = 'setting_'

function storageKey(key: string): string {
  return `${STORAGE_PREFIX}${key}`
}

function hasChromeStorage(): boolean {
  try {
    return typeof chrome !== 'undefined' && !!chrome.storage?.local
  } catch {
    return false
  }
}

export async function getSetting<T>(key: string, defaultValue: T): Promise<T> {
  // 1) 优先读 chrome.storage.local（popup / options / content / background 一致）
  if (hasChromeStorage()) {
    try {
      const res = await chrome.storage.local.get(storageKey(key))
      const value = res[storageKey(key)]
      if (value !== undefined) return value as T
    } catch {
      // ignore, fall through to Dexie
    }
  }

  // 2) 回退 Dexie（兼容旧数据；content script 中此处为页面域 DB，通常为空）
  try {
    const result = await db.settings.get(key)
    if (result) {
      // 迁移：把旧值镜像到 chrome.storage.local，之后 content script 也能读到
      if (hasChromeStorage()) {
        chrome.storage.local.set({ [storageKey(key)]: result.value }).catch(() => {})
      }
      return result.value as T
    }
  } catch {
    // ignore
  }
  return defaultValue
}

export async function setSetting(key: string, value: unknown): Promise<void> {
  // 双写：Dexie + chrome.storage.local
  try {
    await db.settings.put({ key, value })
  } catch {
    // content script 中写入页面域 DB 失败也无妨
  }
  if (hasChromeStorage()) {
    try {
      await chrome.storage.local.set({ [storageKey(key)]: value })
    } catch {
      // ignore
    }
  }
}

export async function getAllSettings(): Promise<Record<string, unknown>> {
  const result: Record<string, unknown> = {}

  // 先取 Dexie 旧数据
  try {
    const all = await db.settings.toArray()
    for (const item of all) {
      result[item.key] = item.value
    }
  } catch {
    // ignore
  }

  // 再用 chrome.storage.local 覆盖（更权威）
  if (hasChromeStorage()) {
    try {
      const stored = await chrome.storage.local.get(null)
      for (const [k, v] of Object.entries(stored)) {
        if (k.startsWith(STORAGE_PREFIX)) {
          result[k.slice(STORAGE_PREFIX.length)] = v
        }
      }
    } catch {
      // ignore
    }
  }
  return result
}

/**
 * 迁移工具：把 Dexie 中的历史设置全量镜像到 chrome.storage.local。
 * 在扩展页面（popup / options）启动时调用一次，确保 content script 能读到旧设置。
 */
export async function syncSettingsToSharedStorage(): Promise<void> {
  if (!hasChromeStorage()) return
  try {
    const all = await db.settings.toArray()
    if (all.length === 0) return
    const existing = await chrome.storage.local.get(all.map((i) => storageKey(i.key)))
    const patch: Record<string, unknown> = {}
    for (const item of all) {
      if (existing[storageKey(item.key)] === undefined) {
        patch[storageKey(item.key)] = item.value
      }
    }
    if (Object.keys(patch).length > 0) {
      await chrome.storage.local.set(patch)
    }
  } catch {
    // ignore
  }
}

const CANDIDATE_PREFS_KEY = 'candidate_profile_preferences'

/** 获取求职者画像与底线配置 */
export async function getCandidatePreferences(): Promise<CandidateProfilePreferences> {
  const saved = await getSetting<Partial<CandidateProfilePreferences> | null>(
    CANDIDATE_PREFS_KEY,
    null,
  )
  if (!saved) return { ...DEFAULT_CANDIDATE_PREFERENCES }
  return {
    ...DEFAULT_CANDIDATE_PREFERENCES,
    ...saved,
  }
}

/** 保存求职者画像与底线配置 */
export async function saveCandidatePreferences(
  prefs: Partial<CandidateProfilePreferences>,
): Promise<CandidateProfilePreferences> {
  const current = await getCandidatePreferences()
  const updated: CandidateProfilePreferences = {
    ...current,
    ...prefs,
  }
  await setSetting(CANDIDATE_PREFS_KEY, updated)
  return updated
}

// ─────────────── 安全阀档位（Safety Profile）───────────────
// 只在「首次启动且本地没有任何节奏参数」时写入默认保守档；
// 老用户若已经调过 dailyLimit / minDelay 等任意一项，标记为 custom，绝不覆盖其数值。

const SAFETY_PROFILE_KEY = 'safetyProfile'
const SAFETY_PARAM_KEYS = [
  'dailyLimit',
  'minDelay',
  'maxDelay',
  'scrollDelay',
  'maxScanCount',
  'aiDailyBudget',
  'applyMode',
] as const

/**
 * 确定当前安全档位（幂等，可多次调用）。
 * - 已有 safetyProfile → 原样返回
 * - 无 safetyProfile 但存在节奏参数 → 标记 custom（老用户，保留其配置）
 * - 全空 → 写入默认（保守档）
 */
export async function resolveSafetyProfile(): Promise<SafetyProfileId> {
  const saved = await getSetting<SafetyProfileId | null>(SAFETY_PROFILE_KEY, null)
  if (saved) return saved

  const existing = await Promise.all(
    SAFETY_PARAM_KEYS.map((k) => getSetting<unknown>(k, null)),
  )
  if (existing.some((v) => v !== null && v !== undefined)) {
    await setSetting(SAFETY_PROFILE_KEY, 'custom')
    return 'custom'
  }

  await setSetting(SAFETY_PROFILE_KEY, DEFAULT_SAFETY_PROFILE)
  return DEFAULT_SAFETY_PROFILE
}
