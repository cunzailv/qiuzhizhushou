// @vitest-environment jsdom
// 投递方式（精投 / 海投）：必须成套应用配置，不能出现参数混搭
import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  getDeliveryStrategy,
  applyDeliveryStrategy,
  describeStrategy,
  STRATEGY_PROFILES,
  STRATEGY_STORAGE_KEY,
} from '../src/shared/agent/delivery-strategy'
import { getSavedIntervalConfig } from '../src/shared/agent/quota'

const mockStorage: Record<string, any> = {}

beforeEach(() => {
  for (const k of Object.keys(mockStorage)) delete mockStorage[k]
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: vi.fn(async (keys: string | string[]) => {
          if (typeof keys === 'string') return { [keys]: mockStorage[keys] }
          if (!Array.isArray(keys)) return { ...mockStorage }
          const res: Record<string, any> = {}
          for (const k of keys) res[k] = mockStorage[k]
          return res
        }),
        set: vi.fn(async (obj: Record<string, any>) => Object.assign(mockStorage, obj)),
        remove: vi.fn(async (keys: string | string[]) => {
          const list = Array.isArray(keys) ? keys : [keys]
          for (const k of list) delete mockStorage[k]
        }),
      },
    },
  })
})

describe('投递方式读取 getDeliveryStrategy', () => {
  it('用户尚未选择时返回 null，用于触发启动前引导', async () => {
    expect(await getDeliveryStrategy()).toBeNull()
  })

  it('非法值不生效', async () => {
    mockStorage[`setting_${STRATEGY_STORAGE_KEY}`] = 'whatever'
    expect(await getDeliveryStrategy()).toBeNull()
  })
})

describe('投递方式应用 applyDeliveryStrategy', () => {
  it('海投：15-45 秒、门槛 25、关闭 AI 语义评分与极速开关打开', async () => {
    await applyDeliveryStrategy('volume')

    expect(await getDeliveryStrategy()).toBe('volume')
    const interval = await getSavedIntervalConfig()
    expect(interval.minSeconds).toBe(15)
    expect(interval.maxSeconds).toBe(45)
    expect(mockStorage['setting_aibotFastMode']).toBe(true)
    expect(mockStorage['setting_filterMinMatchScore']).toBe(25)
    expect(mockStorage['setting_enableAiMatch']).toBe(false)
    expect(mockStorage['setting_filterEnableAiMatch']).toBe(false)
  })

  it('精投：45-180 秒、门槛 60、开启 AI 语义评分', async () => {
    await applyDeliveryStrategy('precision')

    expect(await getDeliveryStrategy()).toBe('precision')
    const interval = await getSavedIntervalConfig()
    expect(interval.minSeconds).toBe(45)
    expect(interval.maxSeconds).toBe(180)
    expect(mockStorage['setting_aibotFastMode']).toBe(false)
    expect(mockStorage['setting_filterMinMatchScore']).toBe(60)
    expect(mockStorage['setting_enableAiMatch']).toBe(true)
  })

  it('切换策略时整套参数一起替换，不会残留上一套的值', async () => {
    await applyDeliveryStrategy('volume')
    await applyDeliveryStrategy('precision')

    const interval = await getSavedIntervalConfig()
    expect(interval.minSeconds).toBe(45)
    expect(mockStorage['setting_aibotFastMode']).toBe(false)
    expect(mockStorage['setting_filterMinMatchScore']).toBe(60)
  })
})

describe('策略描述 describeStrategy', () => {
  it('未选择时给出明确提示', () => {
    expect(describeStrategy(null)).toContain('尚未选择')
  })

  it('两个策略都有中文标签', () => {
    expect(describeStrategy('precision')).toContain(STRATEGY_PROFILES.precision.label)
    expect(describeStrategy('volume')).toContain(STRATEGY_PROFILES.volume.label)
  })
})
