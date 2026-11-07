// @vitest-environment jsdom
/**
 * 回归新需求「能设定多少个小时必须投满多少简历吗」，以及后续的产品语义变更：
 * 「设定了目标必须要成功，哪怕是海投」。
 *
 * 现在默认开启**必达模式**：目标未达成前自动接管所有可控参数、超时不停机；
 * 只有用户显式关掉必达（mustAchieve=false）才回到「截止节奏管理」的旧语义。
 * 无论哪种模式都只认平台已确认投递数，绝不把点击算成功。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  CAPACITY_GOAL_KEY,
  DEFAULT_CAPACITY_GOAL,
  MAX_CAPACITY_HOURS,
  MAX_CAPACITY_TARGET,
  MIN_CAPACITY_HOURS,
  MIN_CAPACITY_TARGET,
  MIN_PACING_INTERVAL_MS,
  describeCapacityStatus,
  describeMustAchieveTakeover,
  evaluateCapacityGoal,
  isGoalAchieved,
  isMustAchieve,
  normalizeCapacityGoal,
  resolvePacingInterval,
  type CapacityContext,
} from '../src/shared/agent/capacity-goal'
import { PRECISION_REST_POLICY, VOLUME_REST_POLICY } from '../src/shared/agent/rest-policy'
import {
  appendCampaignLog,
  clearCampaign,
  createNewCampaign,
  getCampaign,
  persistCapacityGoal,
} from '../src/shared/agent/queue-store'

const ROOT = process.cwd()
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf-8')

const SERVICE = 'src/background/campaign-service.ts'
const BACKGROUND = 'src/background/index.ts'
const PANEL = 'src/popup/components/CampaignPanel.tsx'
const CAMPAIGN = 'src/shared/agent/campaign.ts'
const QUEUE = 'src/shared/agent/queue-store.ts'

const T0 = 1_700_000_000_000
const HOUR = 60 * 60_000

function context(over: Partial<CapacityContext> = {}): CapacityContext {
  return {
    // 旧用例验证的是「尽力而为」的截止节奏语义，显式关掉必达
    goal: { enabled: true, hours: 8, targetJobs: 80, mustAchieve: false },
    now: T0,
    startedAt: T0,
    applied: 0,
    totalQuota: 180,
    baseIntervalMs: 30_000,
    policy: VOLUME_REST_POLICY,
    restEnabled: true,
    ...over,
  }
}

const mockStorage: Record<string, any> = {}
const clone = <T>(value: T): T =>
  value === undefined ? value : JSON.parse(JSON.stringify(value))

beforeEach(async () => {
  for (const k of Object.keys(mockStorage)) delete mockStorage[k]
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: vi.fn(async (key: string | null) =>
          key === null ? clone(mockStorage) : { [key]: clone(mockStorage[key]) },
        ),
        set: vi.fn(async (obj: Record<string, any>) => { Object.assign(mockStorage, clone(obj)) }),
        remove: vi.fn(async (key: string) => { delete mockStorage[key] }),
      },
    },
  })
  await appendCampaignLog('__flush__', 'info')
  await clearCampaign()
})

describe('目标设定归一化', () => {
  it('默认值关闭、8 小时 80 份、必达默认开启，设置键稳定', () => {
    expect(DEFAULT_CAPACITY_GOAL).toEqual({
      enabled: false, hours: 8, targetJobs: 80, mustAchieve: true,
    })
    expect(CAPACITY_GOAL_KEY).toBe('aibotCapacityGoal')
    expect(MIN_CAPACITY_HOURS).toBe(1)
    expect(MAX_CAPACITY_HOURS).toBe(24)
    expect(MIN_CAPACITY_TARGET).toBe(1)
    expect(MAX_CAPACITY_TARGET).toBe(500)
  })

  it('越界值被夹到合法区间，小时支持 0.5 步进，必达默认补 true', () => {
    expect(normalizeCapacityGoal({ enabled: true, hours: 999, targetJobs: 9999 })).toEqual({
      enabled: true, hours: MAX_CAPACITY_HOURS, targetJobs: MAX_CAPACITY_TARGET, mustAchieve: true,
    })
    expect(normalizeCapacityGoal({ enabled: true, hours: -3, targetJobs: 0 })).toEqual({
      enabled: true, hours: MIN_CAPACITY_HOURS, targetJobs: MIN_CAPACITY_TARGET, mustAchieve: true,
    })
    expect(normalizeCapacityGoal({ enabled: true, hours: 2.5, targetJobs: 30 }).hours).toBe(2.5)
  })

  it('脏数据 / 非布尔 enabled 不会把调度算坏；老数据缺字段按必达处理', () => {
    expect(normalizeCapacityGoal(null)).toEqual({
      enabled: false, hours: 8, targetJobs: 80, mustAchieve: true,
    })
    expect(normalizeCapacityGoal({ enabled: 'yes', hours: NaN, targetJobs: 'abc' })).toEqual({
      enabled: false, hours: 8, targetJobs: 80, mustAchieve: true,
    })
    expect(normalizeCapacityGoal({ enabled: true, hours: 2, targetJobs: 80 }).mustAchieve).toBe(true)
    expect(normalizeCapacityGoal({ enabled: true, hours: 2, targetJobs: 80, mustAchieve: false }).mustAchieve).toBe(false)
  })
})

describe('可达性评估 · 五种状态', () => {
  it('未启用 → off，不做任何调速', () => {
    const ev = evaluateCapacityGoal(context({ goal: { enabled: false, hours: 8, targetJobs: 80 } }))
    expect(ev.status).toBe('off')
    expect(ev.shouldSkipRest).toBe(false)
    expect(resolvePacingInterval(30_000, ev)).toBe(30_000)
    expect(describeCapacityStatus(ev, DEFAULT_CAPACITY_GOAL)).toBe('未设定目标产能')
  })

  it('节奏够快 → on-track，算出截止时间与平摊间隔', () => {
    const ev = evaluateCapacityGoal(context())
    expect(ev.status).toBe('on-track')
    expect(ev.deadlineAt).toBe(T0 + 8 * HOUR)
    expect(ev.remainingJobs).toBe(80)
    expect(ev.requiredIntervalMs).toBe((8 * HOUR) / 80)
    expect(ev.suggestedIntervalMs).toBe(30_000)
    expect(ev.shouldSkipRest).toBe(false)
    expect(ev.advice).toContain('按当前节奏可在截止前完成')
  })

  it('按当前节奏超时 → at-risk，要求压缩间隔并跳过休息', () => {
    const ev = evaluateCapacityGoal(context({ baseIntervalMs: 600_000 }))
    expect(ev.status).toBe('at-risk')
    expect(ev.projectedFinishAt).toBeGreaterThan(ev.deadlineAt)
    expect(ev.shouldSkipRest).toBe(true)
    expect(ev.suggestedIntervalMs).toBeLessThan(600_000)
    expect(ev.advice).toContain('自动压缩间隔并跳过模拟休息')
    expect(describeCapacityStatus(ev, { enabled: true, hours: 8, targetJobs: 80 })).toContain('已自动加速')
  })

  it('已投满 → achieved，即使时间还没到', () => {
    const ev = evaluateCapacityGoal(context({ applied: 80, now: T0 + HOUR }))
    expect(ev.status).toBe('achieved')
    expect(ev.remainingJobs).toBe(0)
    expect(ev.progressPercent).toBe(100)
    expect(ev.advice).toContain('提前')
  })

  it('到点未投满 → missed，给出可操作诊断', () => {
    const ev = evaluateCapacityGoal(context({ now: T0 + 9 * HOUR, applied: 30 }))
    expect(ev.status).toBe('missed')
    expect(ev.remainingMs).toBe(0)
    expect(ev.remainingJobs).toBe(50)
    expect(ev.advice).toContain('未记为投递成功')
  })

  it('进度百分比按目标份数算，不超过 100', () => {
    expect(evaluateCapacityGoal(context({ applied: 40 })).progressPercent).toBe(50)
    expect(evaluateCapacityGoal(context({ applied: 120 })).progressPercent).toBe(100)
  })

  it('目标份数超过配额合计时明确提示先调高配额', () => {
    const ev = evaluateCapacityGoal(context({ totalQuota: 25, targetJobs: 80 }))
    expect(ev.advice).toContain('超过当前已开启平台配额合计 25')
  })
})

describe('必达模式 · 设定即承诺', () => {
  const goal = { enabled: true, hours: 2, targetJobs: 80, mustAchieve: true }

  it('老数据缺 mustAchieve 字段时默认开启；只有显式 false / 未启用才关闭', () => {
    expect(isMustAchieve({ enabled: true, hours: 2, targetJobs: 80 })).toBe(true)
    expect(isMustAchieve(goal)).toBe(true)
    expect(isMustAchieve({ ...goal, mustAchieve: false })).toBe(false)
    expect(isMustAchieve({ ...goal, enabled: false })).toBe(false)
    expect(isMustAchieve(null)).toBe(false)
  })

  it('只认达到目标份数，差一份也不算达成', () => {
    expect(isGoalAchieved(goal, 0)).toBe(false)
    expect(isGoalAchieved(goal, 79)).toBe(false)
    expect(isGoalAchieved(goal, 80)).toBe(true)
    expect(isGoalAchieved(goal, 120)).toBe(true)
  })

  it('超时不返回 missed：继续 at-risk、跳过休息、压缩间隔且明确说不停机', () => {
    const ev = evaluateCapacityGoal(context({
      goal, mustAchieve: true, now: T0 + 9 * HOUR, applied: 30,
    }))
    expect(ev.status).toBe('at-risk')
    expect(ev.remainingMs).toBe(0)
    expect(ev.shouldSkipRest).toBe(true)
    expect(ev.advice).toContain('不会自行停机')
    expect(resolvePacingInterval(45_000, ev)).toBe(MIN_PACING_INTERVAL_MS)
  })

  it('显式关掉必达后，超时仍是 missed（旧语义向后兼容）', () => {
    const ev = evaluateCapacityGoal(context({
      now: T0 + 9 * HOUR, applied: 30, mustAchieve: false,
    }))
    expect(ev.status).toBe('missed')
    expect(ev.advice).toContain('未记为投递成功')
  })

  it('接管说明覆盖所有可控参数，且明确「达成前不停机」', () => {
    const text = describeMustAchieveTakeover()
    expect(text).toContain('自动切海投')
    expect(text).toContain('自动抬配额')
    expect(text).toContain('开启全部平台')
    expect(text).toContain('放行工作时段')
    expect(text).toContain('关闭模拟休息')
    expect(text).toContain('放宽评分门槛')
    expect(text).toContain('达成前不停机')
  })
})

describe('自动调速 · 有防风控下限', () => {
  it('时间很紧也不会把间隔压到 8 秒以下', () => {
    const ev = evaluateCapacityGoal(context({ now: T0 + 8 * HOUR - 1_000, baseIntervalMs: 30_000 }))
    expect(ev.status).toBe('at-risk')
    expect(resolvePacingInterval(30_000, ev)).toBe(MIN_PACING_INTERVAL_MS)
    expect(MIN_PACING_INTERVAL_MS).toBe(8_000)
  })

  it('已达成 / 已超时不再压缩，交给常规节奏', () => {
    const achieved = evaluateCapacityGoal(context({ applied: 80 }))
    const missed = evaluateCapacityGoal(context({ now: T0 + 9 * HOUR }))
    expect(resolvePacingInterval(45_000, achieved)).toBe(45_000)
    expect(resolvePacingInterval(45_000, missed)).toBe(45_000)
  })

  it('精投策略的休息开销会让预测更保守', () => {
    const volume = evaluateCapacityGoal(context({ policy: VOLUME_REST_POLICY, baseIntervalMs: 30_000 }))
    const precision = evaluateCapacityGoal(context({ policy: PRECISION_REST_POLICY, baseIntervalMs: 30_000 }))
    expect(precision.projectedFinishAt).toBeGreaterThanOrEqual(volume.projectedFinishAt)
  })
})

describe('目标随 campaign 持久化 · 倒计时不因重启重置', () => {
  it('参数不变沿用 startedAt，参数被改则重新计时', async () => {
    await createNewCampaign()
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(T0)

    await persistCapacityGoal({ enabled: true, hours: 8, targetJobs: 80 })
    const first = (await getCampaign())!.capacityGoal
    expect(first).toMatchObject({ enabled: true, hours: 8, targetJobs: 80, startedAt: T0 })

    nowSpy.mockReturnValue(T0 + 2 * HOUR)
    await persistCapacityGoal({ enabled: true, hours: 8, targetJobs: 80 })
    expect((await getCampaign())!.capacityGoal!.startedAt).toBe(T0)

    await persistCapacityGoal({ enabled: true, hours: 4, targetJobs: 40 })
    const changed = (await getCampaign())!.capacityGoal!
    expect(changed.startedAt).toBe(T0 + 2 * HOUR)
    expect(changed.hours).toBe(4)
    expect(changed.targetJobs).toBe(40)
    nowSpy.mockRestore()
  })

  it('关闭目标会清掉 campaign 上的目标状态', async () => {
    await createNewCampaign()
    await persistCapacityGoal({ enabled: true, hours: 6, targetJobs: 60 })
    await persistCapacityGoal({ enabled: false, hours: 6, targetJobs: 60 })
    expect((await getCampaign())!.capacityGoal).toBeUndefined()
  })

  it('持久化与日志并发不互相覆盖', async () => {
    await createNewCampaign()
    await Promise.all([
      persistCapacityGoal({ enabled: true, hours: 5, targetJobs: 50 }),
      appendCampaignLog('日志 A', 'info'),
      appendCampaignLog('日志 B', 'info'),
    ])
    const after = (await getCampaign())!
    expect(after.capacityGoal?.targetJobs).toBe(50)
    expect(after.logs.map((l) => l.message)).toEqual(expect.arrayContaining(['日志 A', '日志 B']))
  })
})

describe('调用链静态契约 · 设定能真正影响调度', () => {
  const service = read(SERVICE)

  it('后台读取目标、压缩间隔、落后或必达时跳过休息', () => {
    expect(service).toContain('readCapacityEvaluation')
    expect(service).toContain('resolvePacingInterval(rawInterval, capacity)')
    expect(service).toContain('!mustAchieveActive && !capacity?.shouldSkipRest')
    expect(service).toContain('scheduleNextTick(nextInterval)')
  })

  it('启动时把设定写进 campaign，到点未达成一次性诊断', () => {
    expect(service).toContain('persistCapacityGoal(savedGoal)')
    expect(service).toContain('capacityMissedNotifiedFor')
    expect(service).toContain('目标产能未达成')
    expect(service).toContain('目标产能预警')
  })

  it('提供运行中修改目标的服务与消息路由', () => {
    expect(service).toContain('setCapacityGoal: async (raw: unknown)')
    expect(read(BACKGROUND)).toContain("message.type === 'SET_CAPACITY_GOAL'")
  })

  it('面板可设定小时/份数/必达开关，并显示进度与可达性', () => {
    const panel = read(PANEL)
    expect(panel).toContain('handleSaveCapacityGoal')
    expect(panel).toContain('aria-label="目标小时数"')
    expect(panel).toContain('aria-label="目标份数"')
    expect(panel).toContain('aria-label="必达模式"')
    expect(panel).toContain('mustAchieve: mustAchieveInput')
    expect(panel).toContain('保存并启用')
    expect(panel).toContain('queue-rule-fill')
    expect(panel).toContain('目标产能 · {capacityGoal.hours} 小时投满 {capacityGoal.targetJobs} 份')
  })

  it('诚实披露：必达是接管承诺，但不虚报成功、不解除安全约束', () => {
    const panel = read(PANEL)
    expect(panel).toContain('目标未达成前不停机')
    expect(panel).toContain('只认平台确认投递数，绝不把点击算成功')
    expect(panel).toContain('技术栈 / 岗位方向 / 黑名单硬约束保留')
    expect(panel).toContain('不会虚报成功')
    expect(panel).not.toContain('系统不会凭空承诺达标')
  })

  it('后台在启动与改目标时都会自动接管，且必达目标未达成不允许判完成', () => {
    expect(service).toContain('applyMustAchieveTakeover(live, savedGoal, \'start\')')
    expect(service).toContain('applyMustAchieveTakeover(current, goal, \'goal\')')
    expect(service).toContain('isMustAchieve(goalNow)')
    expect(service).toContain('shouldBypassWorkWindow(mustAchieveActive, goalAchieved)')
    expect(read(CAMPAIGN)).toContain('if (!isGoalAchieved(campaign.capacityGoal!, applied)) return false')
  })

  it('设定项收在低频折叠组里，不堆回首屏', () => {
    const panel = read(PANEL)
    const disclosure = panel.indexOf('<Disclosure label="复盘与维护工具"')
    const end = panel.indexOf('</Disclosure>', disclosure)
    expect(disclosure).toBeGreaterThan(-1)
    expect(panel.slice(disclosure, end)).toContain('handleSaveCapacityGoal')
  })

  it('统计层透传 capacityGoal，队列层有类型与原子写入', () => {
    expect(read(CAMPAIGN)).toContain('capacityGoal: campaign.capacityGoal')
    expect(read(QUEUE)).toContain('capacityGoal?: CapacityGoal')
    expect(read(QUEUE)).toContain('export function persistCapacityGoal')
    expect(read(QUEUE)).toContain('unchanged ? prev.startedAt : Date.now()')
  })
})
