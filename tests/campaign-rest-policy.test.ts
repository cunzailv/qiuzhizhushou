// @vitest-environment jsdom
/**
 * 回归「模拟真人作息休息 12 分钟，投了一天还没投满 80」。
 *
 * P0 死锁：旧 runCampaignTick 休息分支只改内存对象：
 *   campaign.restUntil = now + restDuration
 *   campaign.consecutiveRestCounter = 0
 *   await appendCampaignLog(...)   ← 内部 getCampaign() 读 storage 旧副本并整份写回
 * 于是 restUntil 从未落盘、连投计数从未清零。5 分钟切片每醒一次就「重新休息一次」，
 * AIbot 一整天都在休息循环里，配额当然永远投不满。
 *
 * 附带修复：阈值每 tick 重随机、休息节奏与精投/海投脱钩、休息日志刷屏、
 * 休息到期后还要空跑一整轮、用户没有任何「立刻继续」的出口。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  appendCampaignLog,
  clearCampaign,
  createNewCampaign,
  getCampaign,
  persistRestState,
} from '../src/shared/agent/queue-store'
import {
  DEFAULT_REST_ENABLED,
  PRECISION_REST_POLICY,
  REST_ENABLED_KEY,
  REST_NOTICE_INTERVAL_MS,
  VOLUME_REST_POLICY,
  decideRest,
  estimateRemainingMs,
  pickInitialRestThreshold,
  pickRestDurationMs,
  pickRestThreshold,
  resolveRestPolicy,
} from '../src/shared/agent/rest-policy'

const ROOT = process.cwd()
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf-8')

const CAMPAIGN_SERVICE = 'src/background/campaign-service.ts'
const BACKGROUND_INDEX = 'src/background/index.ts'
const PANEL = 'src/popup/components/CampaignPanel.tsx'
const QUEUE_STORE = 'src/shared/agent/queue-store.ts'

const mockStorage: Record<string, any> = {}
/** 真实 Chrome storage 返回的是结构化克隆副本；用深拷贝才能复现「内存改动被覆盖」 */
const clone = <T>(value: T): T =>
  value === undefined ? value : JSON.parse(JSON.stringify(value))

beforeEach(async () => {
  for (const k of Object.keys(mockStorage)) delete mockStorage[k]
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: vi.fn(async (key: string | string[] | null) => {
          if (key === null) return clone(mockStorage)
          if (Array.isArray(key)) {
            return Object.fromEntries(key.map((k) => [k, clone(mockStorage[k])]))
          }
          return { [key]: clone(mockStorage[key]) }
        }),
        set: vi.fn(async (obj: Record<string, any>) => {
          Object.assign(mockStorage, clone(obj))
        }),
        remove: vi.fn(async (key: string) => { delete mockStorage[key] }),
      },
    },
  })
  await appendCampaignLog('__flush__', 'info')
  await clearCampaign()
})

describe('P0 死锁复现 · 为什么休息状态必须原子落盘', () => {
  it('只改内存再写日志：restUntil 与清零后的连投计数会被日志整份覆盖', async () => {
    await createNewCampaign()
    // 连投 18 份已由 updateTaskResult 正常落盘
    await persistRestState({ consecutiveRestCounter: 18 })
    expect((await getCampaign())!.consecutiveRestCounter).toBe(18)

    // 模拟旧实现：从 storage 取一份副本，只改内存，然后写日志
    const campaign = (await getCampaign())!
    campaign.restUntil = Date.now() + 12 * 60_000
    campaign.consecutiveRestCounter = 0
    await appendCampaignLog('☕ 已连续投递 18 份，模拟真人作息休息 12 分钟', 'info')

    const after = (await getCampaign())!
    expect(after.restUntil).toBeUndefined()
    expect(after.consecutiveRestCounter).toBe(18)
    // 下一轮 tick 读到 counter 仍 >= 阈值 → 又触发一次休息 → 永久循环
    expect(after.consecutiveRestCounter).toBeGreaterThanOrEqual(15)
  })

  it('persistRestState 后写日志不会覆盖休息状态', async () => {
    await createNewCampaign()
    const restUntil = Date.now() + 12 * 60_000
    await persistRestState({
      restUntil,
      consecutiveRestCounter: 0,
      restThreshold: 20,
    })
    await appendCampaignLog('☕ 休息 12 分钟', 'info')
    await appendCampaignLog('🔁 5 分钟切片自愈检查', 'info')

    const after = (await getCampaign())!
    expect(after.restUntil).toBe(restUntil)
    expect(after.consecutiveRestCounter).toBe(0)
    expect(after.restThreshold).toBe(20)
    expect(after.logs.map((l) => l.message)).toContain('☕ 休息 12 分钟')
    expect(after.logs.map((l) => l.message)).toContain('🔁 5 分钟切片自愈检查')
  })

  it('并发「状态写入 + 日志写入」不互相覆盖（同一条串行链）', async () => {
    await createNewCampaign()
    const restUntil = Date.now() + 6 * 60_000
    await Promise.all([
      persistRestState({ restUntil, consecutiveRestCounter: 0, restThreshold: 33 }),
      appendCampaignLog('日志 A', 'info'),
      persistRestState({ restThreshold: 34 }),
      appendCampaignLog('日志 B', 'info'),
    ])
    const after = (await getCampaign())!
    expect(after.restUntil).toBe(restUntil)
    expect(after.restThreshold).toBe(34)
    expect(after.logs.map((l) => l.message)).toEqual(expect.arrayContaining(['日志 A', '日志 B']))
  })

  it('restUntil: null 原子清除休息状态（resume 与一键跳过都走这里）', async () => {
    await createNewCampaign()
    await persistRestState({ restUntil: Date.now() + 60_000, restThreshold: 20 })
    expect((await getCampaign())!.restUntil).toBeGreaterThan(0)

    await persistRestState({ restUntil: null, consecutiveRestCounter: 0, restThreshold: 21 })
    const after = (await getCampaign())!
    expect(after.restUntil).toBeUndefined()
    expect(after.consecutiveRestCounter).toBe(0)
    expect(after.restThreshold).toBe(21)
  })

  it('脏 patch 不会写坏 campaign', async () => {
    await createNewCampaign()
    await persistRestState({
      consecutiveRestCounter: Number.NaN,
      restThreshold: Number.POSITIVE_INFINITY,
    })
    const after = (await getCampaign())!
    expect(Number.isFinite(after.consecutiveRestCounter)).toBe(true)
    expect(after.restThreshold).toBeUndefined()
  })
})

describe('休息策略 · 精投 / 海投不再共用同一套节奏', () => {
  it('未选策略或精投走保守策略，海投走铺量策略', () => {
    expect(resolveRestPolicy(null)).toBe(PRECISION_REST_POLICY)
    expect(resolveRestPolicy(undefined)).toBe(PRECISION_REST_POLICY)
    expect(resolveRestPolicy('precision')).toBe(PRECISION_REST_POLICY)
    expect(resolveRestPolicy('volume')).toBe(VOLUME_REST_POLICY)
  })

  it('海投批次更大、休息更短，不会再出现「休息比干活久」', () => {
    expect(VOLUME_REST_POLICY.batchMin).toBeGreaterThan(PRECISION_REST_POLICY.batchMin)
    expect(VOLUME_REST_POLICY.restMaxMs).toBeLessThan(PRECISION_REST_POLICY.restMinMs)
    expect(VOLUME_REST_POLICY.restMaxMs).toBe(6 * 60_000)
    expect(PRECISION_REST_POLICY.restMaxMs).toBe(20 * 60_000)
  })

  it('阈值与时长都落在闭区间内，random 边界不越界', () => {
    expect(pickRestThreshold(PRECISION_REST_POLICY, () => 0)).toBe(15)
    expect(pickRestThreshold(PRECISION_REST_POLICY, () => 0.999999)).toBe(25)
    expect(pickRestThreshold(VOLUME_REST_POLICY, () => 0)).toBe(30)
    expect(pickRestThreshold(VOLUME_REST_POLICY, () => 0.999999)).toBe(45)
    expect(pickRestDurationMs(VOLUME_REST_POLICY, () => 0)).toBe(3 * 60_000)
    expect(pickRestDurationMs(VOLUME_REST_POLICY, () => 0.999999)).toBe(6 * 60_000)
    expect(pickRestDurationMs(PRECISION_REST_POLICY, () => 0)).toBe(8 * 60_000)
    expect(pickInitialRestThreshold(VOLUME_REST_POLICY, () => 0)).toBe(30)
  })

  it('非法 random 不会算出 NaN', () => {
    expect(Number.isFinite(pickRestThreshold(PRECISION_REST_POLICY, () => Number.NaN))).toBe(true)
    expect(Number.isFinite(pickRestDurationMs(VOLUME_REST_POLICY, () => Number.NaN))).toBe(true)
  })

  it('默认开启休息，设置键稳定', () => {
    expect(DEFAULT_REST_ENABLED).toBe(true)
    expect(REST_ENABLED_KEY).toBe('aibotRestEnabled')
    expect(REST_NOTICE_INTERVAL_MS).toBe(10 * 60_000)
  })
})

describe('休息状态机 · decideRest', () => {
  const now = 1_700_000_000_000
  const base = {
    now,
    consecutiveRestCounter: 0,
    restThreshold: 20,
    policy: PRECISION_REST_POLICY,
    enabled: true,
  }

  it('未达阈值继续投递', () => {
    expect(decideRest({ ...base, consecutiveRestCounter: 19 })).toEqual({ kind: 'continue' })
  })

  it('旧 campaign 缺阈值时补一个固定阈值，而不是每 tick 重随机', () => {
    const decision = decideRest({ ...base, restThreshold: undefined, random: () => 0 })
    expect(decision.kind).toBe('continue')
    if (decision.kind === 'continue') expect(decision.restThreshold).toBe(15)
  })

  it('达到阈值触发休息，并提前生成下一批阈值', () => {
    const decision = decideRest({
      ...base,
      consecutiveRestCounter: 20,
      policy: VOLUME_REST_POLICY,
      random: () => 0,
    })
    expect(decision.kind).toBe('start-rest')
    if (decision.kind === 'start-rest') {
      expect(decision.threshold).toBe(20)
      expect(decision.durationMs).toBe(3 * 60_000)
      expect(decision.nextThreshold).toBe(30)
    }
  })

  it('同一份持久化阈值不会因为 random 改变而让判断漂动', () => {
    const first = decideRest({ ...base, consecutiveRestCounter: 20, random: () => 0 })
    const second = decideRest({ ...base, consecutiveRestCounter: 20, random: () => 0.9 })
    expect(first.kind).toBe('start-rest')
    expect(second.kind).toBe('start-rest')
  })

  it('休息中返回 waiting，日志按 10 分钟节流，5 分钟切片不刷屏', () => {
    const restUntil = now + 12 * 60_000
    const fresh = decideRest({ ...base, restUntil, lastRestNoticeAt: now, random: () => 0 })
    expect(fresh.kind).toBe('waiting')
    if (fresh.kind === 'waiting') {
      expect(fresh.remainingMs).toBe(12 * 60_000)
      expect(fresh.shouldLog).toBe(false)
    }
    const stale = decideRest({
      ...base,
      restUntil,
      lastRestNoticeAt: now - REST_NOTICE_INTERVAL_MS,
      random: () => 0,
    })
    expect(stale.kind).toBe('waiting')
    if (stale.kind === 'waiting') expect(stale.shouldLog).toBe(true)
  })

  it('休息到期返回 resume，调用方本轮就继续投递', () => {
    expect(decideRest({ ...base, restUntil: now - 1 })).toEqual({ kind: 'resume' })
  })

  it('用户关掉休息：正在休息立即 resume，否则正常 continue', () => {
    expect(decideRest({ ...base, enabled: false, restUntil: now + 60_000 })).toEqual({ kind: 'resume' })
    expect(decideRest({ ...base, enabled: false })).toEqual({ kind: 'continue' })
  })

  it('估算剩余耗时：关掉休息后只算间隔，不再叠加休息空档', () => {
    const withRest = estimateRemainingMs(80, 30_000, VOLUME_REST_POLICY, true)
    const withoutRest = estimateRemainingMs(80, 30_000, VOLUME_REST_POLICY, false)
    expect(withoutRest).toBe(80 * 30_000)
    expect(withRest).toBeGreaterThan(withoutRest)
    expect(estimateRemainingMs(0, 30_000, VOLUME_REST_POLICY, true)).toBe(0)
  })
})

describe('调用链静态契约 · 休息不再卡死产能', () => {
  const service = read(CAMPAIGN_SERVICE)

  it('休息状态一律原子落盘，代码里不再直接改内存 campaign', () => {
    expect(service).toContain('persistRestState({')
    expect(service).not.toContain('campaign.restUntil = now +')
    expect(service).not.toContain('campaign.consecutiveRestCounter = 0')
    expect(read(QUEUE_STORE)).toContain('export function persistRestState')
  })

  it('阈值一次生成并持久化，不再每个 tick 重新随机', () => {
    expect(service).not.toContain('15 + Math.floor(Math.random() * 10)')
    expect(service).toContain('restThreshold: campaign.restThreshold')
    expect(service).toContain('restThreshold: restDecision.restThreshold')
  })

  it('升级迁移：补写阈值时把死锁期间累积的连投计数一并归零', () => {
    const block = service.slice(
      service.indexOf('} else if (restDecision.restThreshold !== undefined)'),
      service.indexOf('// 3.5 自主重规划'),
    )
    expect(block).toContain('restThreshold: restDecision.restThreshold')
    expect(block).toContain('consecutiveRestCounter: 0')
  })

  it('休息节奏跟随精投/海投策略，且可由用户关闭', () => {
    expect(service).toContain('resolveRestPolicy(strategy)')
    expect(service).toContain('REST_ENABLED_KEY')
    expect(service).toContain('getDeliveryStrategy()')
  })

  it('休息到期本轮立即继续投递，且日志写明今日配额进度', () => {
    expect(service).toContain('刻意不 return')
    expect(service).toContain('summarizeQuotaProgress')
    expect(service).toContain('今日已确认投递')
  })

  it('提供一键跳过休息的后台服务与消息路由', () => {
    expect(service).toContain('skipRest: async () =>')
    expect(read(BACKGROUND_INDEX)).toContain("message.type === 'SKIP_REST'")
  })

  it('面板给出口、给进度目标、给休息开关', () => {
    const panel = read(PANEL)
    expect(panel).toContain('REST_ENABLED_KEY')
    expect(panel).toContain('handleRestEnabledChange')
    expect(panel).toContain('handleSkipRest')
    expect(panel).toContain('立即继续')
    expect(panel).toContain('目标 {totalQuota}')
    expect(panel).toContain('海投连投 30-45 份只休息 3-6 分钟')
  })

  it('休息开关与跳过按钮不破坏分层收纳（低频控件仍在折叠组）', () => {
    const panel = read(PANEL)
    const disclosure = panel.indexOf('<Disclosure label="复盘与维护工具"')
    const end = panel.indexOf('</Disclosure>', disclosure)
    expect(disclosure).toBeGreaterThan(-1)
    expect(panel.slice(disclosure, end)).toContain('handleRestEnabledChange')
  })
})
