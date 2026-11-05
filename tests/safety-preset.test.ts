// @vitest-environment jsdom
// 安全阀档位：默认保守、三档参数单调性、custom 判定、首启迁移不覆盖老用户
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  SAFETY_PRESETS,
  SAFETY_PROFILE_LABELS,
  DEFAULT_SAFETY_PROFILE,
  CONSERVATIVE_VALUES,
  getSafetyPreset,
  detectSafetyProfile,
} from '../src/shared/types/safety-preset'
import { DEFAULT_SETTINGS } from '../src/shared/types/settings'
import { resolveSafetyProfile } from '../src/shared/db/settings-store'
import { db } from '../src/shared/db'

const mockStorage: Record<string, any> = {}

function installChromeMock() {
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: vi.fn(async (keys: string | string[] | null) => {
          if (keys === null) return { ...mockStorage }
          if (typeof keys === 'string') return { [keys]: mockStorage[keys] }
          const res: Record<string, any> = {}
          for (const k of keys) res[k] = mockStorage[k]
          return res
        }),
        set: vi.fn(async (obj: Record<string, any>) => {
          Object.assign(mockStorage, obj)
        }),
      },
    },
  })
}

beforeEach(async () => {
  for (const k of Object.keys(mockStorage)) delete mockStorage[k]
  // setSetting 会双写 Dexie，必须一并清空，否则上一用例的值会兜底回来
  await db.settings.clear()
  installChromeMock()
})

describe('安全阀档位定义', () => {
  it('默认档位是保守', () => {
    expect(DEFAULT_SAFETY_PROFILE).toBe('conservative')
  })

  it('CONSERVATIVE_VALUES 与保守档完全一致（单一真源）', () => {
    expect(CONSERVATIVE_VALUES).toBe(SAFETY_PRESETS.conservative.values)
  })

  it('DEFAULT_SETTINGS 的节奏参数取保守档', () => {
    expect(DEFAULT_SETTINGS.safetyProfile).toBe('conservative')
    expect(DEFAULT_SETTINGS.dailyLimit).toBe(30)
    expect(DEFAULT_SETTINGS.minDelay).toBe(5000)
    expect(DEFAULT_SETTINGS.maxDelay).toBe(15000)
    expect(DEFAULT_SETTINGS.maxScanCount).toBe(20)
    expect(DEFAULT_SETTINGS.aiDailyBudget).toBe(30)
    expect(DEFAULT_SETTINGS.applyMode).toBe('recommend')
  })

  it('默认值不得回到历史激进值（回归护栏）', () => {
    expect(DEFAULT_SETTINGS.dailyLimit).toBeLessThanOrEqual(50)
    expect(DEFAULT_SETTINGS.maxScanCount).toBeLessThanOrEqual(30)
    expect(DEFAULT_SETTINGS.minDelay).toBeGreaterThanOrEqual(3000)
  })

  it('三档的每日上限与 AI 预算递增，延迟递减', () => {
    const c = SAFETY_PRESETS.conservative.values
    const s = SAFETY_PRESETS.standard.values
    const a = SAFETY_PRESETS.aggressive.values
    expect(c.dailyLimit).toBeLessThan(s.dailyLimit)
    expect(s.dailyLimit).toBeLessThan(a.dailyLimit)
    expect(c.aiDailyBudget).toBeLessThan(s.aiDailyBudget)
    expect(c.maxScanCount).toBeLessThan(s.maxScanCount)
    expect(c.minDelay).toBeGreaterThan(s.minDelay)
    expect(s.minDelay).toBeGreaterThan(a.minDelay)
    expect(c.maxDelay).toBeGreaterThan(a.maxDelay)
  })

  it('只有激进档带风险提示，且保守档为推荐后确认', () => {
    expect(SAFETY_PRESETS.conservative.warning).toBeUndefined()
    expect(SAFETY_PRESETS.aggressive.warning).toBeTruthy()
    expect(SAFETY_PRESETS.conservative.values.applyMode).toBe('recommend')
    expect(SAFETY_PRESETS.standard.values.applyMode).toBe('batch')
  })

  it('getSafetyPreset 对 custom / 非法值返回 undefined', () => {
    expect(getSafetyPreset('custom')).toBeUndefined()
    expect(getSafetyPreset(undefined)).toBeUndefined()
    expect(getSafetyPreset('nope')).toBeUndefined()
    expect(getSafetyPreset('standard')?.id).toBe('standard')
  })

  it('中文标签齐全', () => {
    expect(SAFETY_PROFILE_LABELS.conservative).toBe('保守')
    expect(SAFETY_PROFILE_LABELS.custom).toBe('自定义')
  })
})

describe('detectSafetyProfile 反查', () => {
  it('完全命中保守档返回 conservative', () => {
    expect(detectSafetyProfile({ ...CONSERVATIVE_VALUES })).toBe('conservative')
  })

  it('命中标准档返回 standard', () => {
    expect(detectSafetyProfile({ ...SAFETY_PRESETS.standard.values })).toBe('standard')
  })

  it('部分字段缺失时按已给字段判定', () => {
    expect(detectSafetyProfile({ dailyLimit: 30, minDelay: 5000 })).toBe('conservative')
  })

  it('任一项偏离则判为 custom', () => {
    expect(detectSafetyProfile({ ...CONSERVATIVE_VALUES, dailyLimit: 31 })).toBe('custom')
    expect(detectSafetyProfile({ ...CONSERVATIVE_VALUES, applyMode: 'batch' })).toBe('custom')
  })
})

describe('resolveSafetyProfile 首启迁移', () => {
  it('全新安装写入保守档', async () => {
    const profile = await resolveSafetyProfile()
    expect(profile).toBe('conservative')
    expect(mockStorage['setting_safetyProfile']).toBe('conservative')
  })

  it('已存在档位时原样返回，不重复写', async () => {
    mockStorage['setting_safetyProfile'] = 'aggressive'
    const profile = await resolveSafetyProfile()
    expect(profile).toBe('aggressive')
  })

  it('老用户已有节奏参数时标记 custom，且不覆盖原值', async () => {
    mockStorage['setting_dailyLimit'] = 500
    mockStorage['setting_minDelay'] = 1500

    const profile = await resolveSafetyProfile()
    expect(profile).toBe('custom')
    expect(mockStorage['setting_safetyProfile']).toBe('custom')
    expect(mockStorage['setting_dailyLimit']).toBe(500)
    expect(mockStorage['setting_minDelay']).toBe(1500)
  })

  it('幂等：连续调用结果一致', async () => {
    expect(await resolveSafetyProfile()).toBe('conservative')
    expect(await resolveSafetyProfile()).toBe('conservative')
  })
})
