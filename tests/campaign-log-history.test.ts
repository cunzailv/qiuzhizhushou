// @vitest-environment jsdom
// 回归「行为日志不能滑动、不知道之前干了什么」：
// 日志条目被并发覆盖、只留 120 条、新一轮 campaign 清空、没有日期。
import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  createNewCampaign,
  appendCampaignLog,
  getCampaign,
  getCampaignLogHistory,
  clearCampaignLogHistory,
  clearCampaign,
} from '../src/shared/agent/queue-store'

const mockStorage: Record<string, any> = {}

beforeEach(async () => {
  for (const k of Object.keys(mockStorage)) delete mockStorage[k]
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: vi.fn(async (key: string) => ({ [key]: mockStorage[key] })),
        set: vi.fn(async (obj: Record<string, any>) => { Object.assign(mockStorage, obj) }),
        remove: vi.fn(async (key: string) => { delete mockStorage[key] }),
      },
    },
  })
  // 等上一轮写入链彻底排空，避免用例之间互相污染
  await appendCampaignLog('__flush__', 'info')
  await clearCampaignLogHistory()
  await clearCampaign()
})

describe('行为日志条目', () => {
  it('带日期与 campaignId，跨天回看能分辨是哪一轮', async () => {
    const campaign = await createNewCampaign()
    await appendCampaignLog('采集到 3 个岗位', 'info')
    const logs = (await getCampaign())!.logs
    expect(logs.length).toBe(2)
    expect(logs[0].date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(logs[0].campaignId).toBe(campaign.id)
    expect(logs[1].campaignId).toBe(campaign.id)
    expect(logs[1].message).toBe('采集到 3 个岗位')
  })

  it('并发追加 30 条不丢任何一条（串行写入链）', async () => {
    await createNewCampaign()
    await Promise.all(
      Array.from({ length: 30 }, (_, i) => appendCampaignLog(`并发日志 ${i}`, 'info')),
    )
    const logs = (await getCampaign())!.logs
    const messages = logs.map((l) => l.message)
    expect(logs.length).toBe(31) // init + 30
    for (let i = 0; i < 30; i += 1) {
      expect(messages).toContain(`并发日志 ${i}`)
    }
  })

  it('当前 campaign 保留最近 500 条，不再 120 条就截断', async () => {
    await createNewCampaign()
    for (let i = 0; i < 520; i += 1) {
      await appendCampaignLog(`第 ${i} 条`, 'info')
    }
    const logs = (await getCampaign())!.logs
    expect(logs.length).toBe(500)
    expect(logs[0].message).toBe('第 20 条')
    expect(logs[logs.length - 1].message).toBe('第 519 条')
  })
})

describe('跨轮次日志归档', () => {
  it('新建 / 清空 campaign 后历史仍在，能回看上一轮干了什么', async () => {
    const first = await createNewCampaign()
    await appendCampaignLog('第一轮：投递成功', 'success')

    await clearCampaign()
    const second = await createNewCampaign()
    expect(second.id).not.toBe(first.id)
    await appendCampaignLog('第二轮：开始扫描', 'info')

    const history = await getCampaignLogHistory()
    const messages = history.map((l) => l.message)
    expect(messages).toContain('第一轮：投递成功')
    expect(messages).toContain('第二轮：开始扫描')
    expect(history.find((l) => l.message === '第一轮：投递成功')?.campaignId).toBe(first.id)
    expect(history.find((l) => l.message === '第二轮：开始扫描')?.campaignId).toBe(second.id)
  })

  it('归档按时间正序，最多 2000 条', async () => {
    await createNewCampaign()
    for (let i = 0; i < 2010; i += 1) {
      await appendCampaignLog(`归档 ${i}`, 'info')
    }
    const history = await getCampaignLogHistory()
    expect(history.length).toBe(2000)
    expect(history[0].message).toBe('归档 10')
    expect(history[history.length - 1].message).toBe('归档 2009')
  })

  it('清空归档后返回空数组，脏数据不抛错', async () => {
    await createNewCampaign()
    await appendCampaignLog('清理前', 'info')
    await clearCampaignLogHistory()
    expect(await getCampaignLogHistory()).toEqual([])
    mockStorage.campaign_log_history_v1 = '不是数组'
    expect(await getCampaignLogHistory()).toEqual([])
  })
})
