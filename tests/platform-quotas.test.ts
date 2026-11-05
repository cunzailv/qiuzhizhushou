// @vitest-environment jsdom
// 各平台投递数量可修改：存储真源校验 / campaign 即时生效 / 每日风控上限同步
import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  DEFAULT_PLATFORM_QUOTAS,
  SETTINGS_KEY_PLATFORM_QUOTAS,
  MIN_PLATFORM_QUOTA,
  MAX_PLATFORM_QUOTA,
  normalizePlatformQuotas,
  getSavedPlatformQuotas,
  savePlatformQuotas,
  resetPlatformQuotas,
} from '../src/shared/agent/quota'
import {
  createNewCampaign,
  getCampaign,
  saveCampaign,
  updateCampaignQuotas,
} from '../src/shared/agent/queue-store'
import { startCampaign, aggregateCampaignStats } from '../src/shared/agent/campaign'
import { checkDailyLimit, incrementCounter } from '../src/shared/antiBot/rate-limiter'

const mockStorage: Record<string, any> = {}

beforeEach(() => {
  for (const k of Object.keys(mockStorage)) {
    delete mockStorage[k]
  }

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
        remove: vi.fn(async (keys: string | string[]) => {
          const list = Array.isArray(keys) ? keys : [keys]
          for (const k of list) delete mockStorage[k]
        }),
      },
    },
  })
})

describe('配额表校验与持久化', () => {
  it('未设置时返回推荐默认数量', async () => {
    expect(await getSavedPlatformQuotas()).toEqual(DEFAULT_PLATFORM_QUOTAS)
    expect(DEFAULT_PLATFORM_QUOTAS.boss).toBe(80)
    expect(DEFAULT_PLATFORM_QUOTAS.liepin).toBe(100)
  })

  it('脏数据、越界值与数字字符串都能被安全归一', () => {
    expect(normalizePlatformQuotas(null)).toEqual(DEFAULT_PLATFORM_QUOTAS)
    expect(normalizePlatformQuotas({ boss: '120' }).boss).toBe(120)
    expect(normalizePlatformQuotas({ boss: 'abc' }).boss).toBe(80)
    expect(normalizePlatformQuotas({ boss: Number.NaN }).boss).toBe(80)
    expect(normalizePlatformQuotas({ boss: 0 }).boss).toBe(MIN_PLATFORM_QUOTA)
    expect(normalizePlatformQuotas({ boss: 9999 }).boss).toBe(MAX_PLATFORM_QUOTA)
    expect(normalizePlatformQuotas({ boss: 20.6 }).boss).toBe(21)
    // 未知平台字段不应污染配额表
    expect(Object.keys(normalizePlatformQuotas({ unknown: 5 }))).toHaveLength(5)
  })

  it('局部保存后可读回完整配额表，恢复默认可还原', async () => {
    const next = await savePlatformQuotas({ boss: 200, maimai: 7 })
    expect(next.boss).toBe(200)
    expect(next.maimai).toBe(7)
    expect(next.liepin).toBe(100)
    expect(mockStorage[SETTINGS_KEY_PLATFORM_QUOTAS].boss).toBe(200)
    expect(await getSavedPlatformQuotas()).toEqual(next)

    // 二次局部修改不覆盖其他平台
    const second = await savePlatformQuotas({ liepin: 33 })
    expect(second.boss).toBe(200)
    expect(second.liepin).toBe(33)

    expect(await resetPlatformQuotas()).toEqual(DEFAULT_PLATFORM_QUOTAS)
    expect((await getSavedPlatformQuotas()).boss).toBe(80)
  })
})

describe('新建 / 复用 campaign 时采用自定义数量', () => {
  it('后台独立创建活动（未传 quotas）也读取保存的数量', async () => {
    await savePlatformQuotas({ boss: 12, maimai: 7 })
    const cmp = await createNewCampaign()
    expect(cmp.quotas.boss.quota).toBe(12)
    expect(cmp.quotas.maimai.quota).toBe(7)
    expect(cmp.quotas.liepin.quota).toBe(100)
  })

  it('显式传入部分配额时，其余平台仍沿用用户保存值', async () => {
    await savePlatformQuotas({ boss: 12, maimai: 7 })
    const cmp = await createNewCampaign({ liepin: 55 })
    expect(cmp.quotas.boss.quota).toBe(12)
    expect(cmp.quotas.liepin.quota).toBe(55)
    expect(cmp.quotas.maimai.quota).toBe(7)
    expect(cmp.quotas.zhaopin.quota).toBe(60)
  })

  it('复用已有活动时同步最新数量，避免「改了再开跑」沿用旧计划', async () => {
    await createNewCampaign({ boss: 42 })
    await savePlatformQuotas({ boss: 77 })
    await startCampaign()
    const saved = await getCampaign()
    expect(saved?.quotas.boss.quota).toBe(77)
    expect(saved?.status).toBe('running')
  })
})

describe('运行中动态修改数量', () => {
  it('即时更新 quota 并在战报与日志中体现', async () => {
    await createNewCampaign()
    const updated = await updateCampaignQuotas({ boss: 150, liepin: 20 })
    expect(updated?.quotas.boss.quota).toBe(150)
    expect(updated?.quotas.liepin.quota).toBe(20)

    const saved = await getCampaign()
    expect(saved?.quotas.boss.quota).toBe(150)
    expect(saved?.logs.some((l) => l.message.includes('已更新投递数量'))).toBe(true)
    expect(aggregateCampaignStats(saved!).platformBreakdown.boss.quota).toBe(150)
  })

  it('调大数量解除「已耗尽」标记，调小后按已投数判定完成', async () => {
    await createNewCampaign()
    const cmp = await getCampaign()
    cmp!.quotas.boss.applied = 80
    cmp!.quotas.boss.exhausted = true
    await saveCampaign(cmp!)

    await updateCampaignQuotas({ boss: 150 })
    expect((await getCampaign())?.quotas.boss.exhausted).toBe(false)

    await updateCampaignQuotas({ boss: 50 })
    const shrunk = await getCampaign()
    expect(shrunk?.quotas.boss.quota).toBe(50)
    // 已投数超过新上限时不需要额外的耗尽标记：下一 tick 由 applied >= quota 判定该平台完成
    expect(shrunk!.quotas.boss.applied).toBeGreaterThanOrEqual(shrunk!.quotas.boss.quota)
    expect(shrunk?.quotas.boss.exhausted).toBe(false)
  })

  it('无活动或数值无变化时安全返回，不产生脏写入', async () => {
    expect(await updateCampaignQuotas({ boss: 150 })).toBeNull()
    await createNewCampaign()
    const before = await getCampaign()
    await updateCampaignQuotas({ boss: 80 })
    const after = await getCampaign()
    expect(after?.quotas.boss.quota).toBe(80)
    expect(after?.logs.length).toBe(before?.logs.length)
  })
})

describe('每日风控上限与面板数量同源', () => {
  it('修改数量后每日剩余额度同步变化', async () => {
    expect((await checkDailyLimit('boss')).remaining).toBe(80)

    await savePlatformQuotas({ boss: 200, maimai: 5 })
    expect((await checkDailyLimit('boss')).remaining).toBe(200)
    expect((await checkDailyLimit('maimai')).remaining).toBe(5)

    await incrementCounter('boss')
    expect((await checkDailyLimit('boss')).remaining).toBe(199)
    expect((await checkDailyLimit('liepin')).remaining).toBe(100)
  })

  it('恢复默认后风控上限也回到默认值', async () => {
    await savePlatformQuotas({ boss: 300 })
    expect((await checkDailyLimit('boss')).remaining).toBe(300)
    await resetPlatformQuotas()
    expect((await checkDailyLimit('boss')).remaining).toBe(80)
  })
})
