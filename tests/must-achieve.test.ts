// @vitest-environment jsdom
/**
 * 回归产品语义变更：「仍不保证 2 小时投满 80 份，不行，设定了目标必须要成功，哪怕是海投」。
 *
 * 旧实现把「N 小时投满 M 份」当成截止节奏建议：配额打满 / 平台标日限 / 工作时段 /
 * 关键词被标无效 / 超时 missed，任何一条都能让 AIbot 自行宣布完成并停机。
 * 这些其实全是插件自己能改的参数，不能拿它们当「目标没达成」的理由。
 *
 * 本文件覆盖：
 *  1. 必达模式纯函数底座（配额 / 平台 / 时段 / 采集 / 门槛 / 关键词锁）；
 *  2. isCampaignFinished 真实行为：目标未达成时，全平台日限耗尽也不算完成；
 *  3. 静态接线契约：自动接管真的被启动与调度调用，而不是只留在配置层。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  MUST_ACHIEVE_EXHAUSTED_COOLDOWN_MS,
  MUST_ACHIEVE_HEADROOM_RATIO,
  MUST_ACHIEVE_MATCH_THRESHOLD,
  MUST_ACHIEVE_MAX_JOBS,
  planMustAchieveQuotas,
  relaxFiltersForMustAchieve,
  resolveCollectMaxJobs,
  resolveMustAchieveMatchThreshold,
  shouldBypassRelevanceGate,
  shouldBypassWorkWindow,
  shouldKeepCollectingOnNoSource,
  shouldMarkKeywordInvalid,
  type MustAchieveQuotaMap,
} from '../src/shared/agent/must-achieve'
import { DEFAULT_FILTERS } from '../src/shared/types/filters'
import { isCampaignFinished } from '../src/shared/agent/campaign'
import {
  clearPlatformExhausted,
  createNewCampaign,
  getCampaign,
  saveCampaign,
} from '../src/shared/agent/queue-store'
import type { PlatformId } from '../src/shared/agent/quota'

const ROOT = process.cwd()
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf-8')

const SERVICE = 'src/background/campaign-service.ts'
const CONTENT = 'src/content/index.ts'
const RUNNER = 'src/content/task-runner.ts'
const PANEL = 'src/popup/components/CampaignPanel.tsx'
const CAMPAIGN = 'src/shared/agent/campaign.ts'

const mockStorage: Record<string, any> = {}
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
  await createNewCampaign()
})

const quota = (over: Partial<{
  quota: number; applied: number; exhausted: boolean; enabled: boolean
}> = {}) => ({ quota: 80, applied: 0, exhausted: false, enabled: true, ...over })

// ─────────── ① 可控参数自动接管 ───────────

describe('必达配额规划 · 目标之外留余量，平台一律全开', () => {
  it('配额不足时抬到「目标 + 25% 余量」，并平均分摊到所有平台', () => {
    expect(MUST_ACHIEVE_HEADROOM_RATIO).toBe(0.25)
    const quotas: MustAchieveQuotaMap = {
      boss: quota({ quota: 5 }),
      liepin: quota({ quota: 5 }),
    }
    const plan = planMustAchieveQuotas(quotas, 80, { maxPerPlatform: 500 })
    // 80 + max(10, 20) = 100，两个平台各 50
    expect(plan.quotas).toEqual({ boss: 50, liepin: 50 })
    expect(plan.plannedTotalQuota).toBe(100)
    expect(plan.changed).toBe(true)
    expect(plan.reasons.join('；')).toContain('余量 20')
  })

  it('配额只升不降：已经够高的平台不会被改小', () => {
    const plan = planMustAchieveQuotas({
      boss: quota({ quota: 300 }),
      liepin: quota({ quota: 300 }),
    }, 20, { maxPerPlatform: 500 })
    expect(plan.quotas).toEqual({})
    expect(plan.plannedTotalQuota).toBe(600)
  })

  it('未启用平台重新开启；被标日限但没投满的平台解除标记', () => {
    const plan = planMustAchieveQuotas({
      boss: quota({ quota: 100 }),
      liepin: quota({ quota: 100, enabled: false, exhausted: true }),
    }, 80, { maxPerPlatform: 500 })
    expect(plan.enablePlatforms).toEqual(['liepin'])
    expect(plan.revivePlatforms).toEqual(['liepin'])
    expect(plan.changed).toBe(true)
    expect(plan.reasons.join('；')).toContain('解除 1 个平台的日限标记')
  })

  it('冷却期内 allowRevive=false：只重新规划，不立刻复活被限流平台', () => {
    const quotas: MustAchieveQuotaMap = {
      boss: quota({ quota: 100, exhausted: true }),
    }
    expect(planMustAchieveQuotas(quotas, 80).revivePlatforms).toEqual(['boss'])
    const cooling = planMustAchieveQuotas(quotas, 80, { allowRevive: false })
    expect(cooling.revivePlatforms).toEqual([])
    expect(cooling.changed).toBe(false)
    expect(cooling.quotas).toEqual({})
  })

  it('已经投到新配额上限的平台不复活', () => {
    const plan = planMustAchieveQuotas({
      boss: quota({ quota: 200, applied: 200, exhausted: true }),
    }, 500, { maxPerPlatform: 120 })
    expect(plan.revivePlatforms).toEqual([])
    expect(plan.plannedTotalQuota).toBe(200)
  })

  it('单平台上限只约束新分摊值，不会把用户已设的更高配额改小', () => {
    const plan = planMustAchieveQuotas({
      boss: quota({ quota: 300, applied: 0 }),
    }, 80, { maxPerPlatform: 120 })
    expect(plan.quotas).toEqual({})
    expect(plan.plannedTotalQuota).toBe(300)
    expect(plan.changed).toBe(false)
  })

  it('规划是幂等的：条件已满足时 changed=false，避免每 tick 刷日志', () => {
    const quotas: MustAchieveQuotaMap = {
      boss: quota({ quota: 100 }),
      liepin: quota({ quota: 100 }),
    }
    expect(planMustAchieveQuotas(quotas, 80, { maxPerPlatform: 500 }).changed).toBe(false)
  })

  it('日限冷却 10 分钟，常量稳定', () => {
    expect(MUST_ACHIEVE_EXHAUSTED_COOLDOWN_MS).toBe(10 * 60_000)
  })
})

describe('必达模式 · 工作时段 / 采集 / 门槛 / 关键词锁', () => {
  it('未达成时放行工作时段，达成后立刻恢复用户设置', () => {
    expect(shouldBypassWorkWindow(true, false)).toBe(true)
    expect(shouldBypassWorkWindow(true, true)).toBe(false)
    expect(shouldBypassWorkWindow(false, false)).toBe(false)
  })

  it('只放宽下发副本的活跃时间，绝不改写用户保存的筛选偏好', () => {
    const original = Object.freeze({ ...DEFAULT_FILTERS, publishTime: 'today' })
    const relaxed = relaxFiltersForMustAchieve(original, true)
    expect(relaxed.filters.publishTime).toBe('all')
    expect(original.publishTime).toBe('today')
    expect(relaxed.filters.salaryMin).toBe(DEFAULT_FILTERS.salaryMin)
    expect(relaxed.filters.minMatchScore).toBe(DEFAULT_FILTERS.minMatchScore)
    expect(relaxed.relaxed.join('；')).toContain('活跃时间 today → 不限时间')
  })

  it('非必达时原样返回同一个对象，不产生副本', () => {
    const filters = { ...DEFAULT_FILTERS }
    const result = relaxFiltersForMustAchieve(filters, false)
    expect(result.filters).toBe(filters)
    expect(result.relaxed).toEqual([])
  })

  it('必达模式匹配分门槛降到 0（只排序不否决），常规模式保持原门槛', () => {
    expect(MUST_ACHIEVE_MATCH_THRESHOLD).toBe(0)
    expect(resolveMustAchieveMatchThreshold(20, true)).toBe(0)
    expect(resolveMustAchieveMatchThreshold(20, false)).toBe(20)
    expect(resolveMustAchieveMatchThreshold(-5, false)).toBe(0)
  })

  it('岗位名称是不可让渡的硬约束：必达 / 海投都不再绕过语义闸门', () => {
    expect(shouldBypassRelevanceGate(true)).toBe(false)
    expect(shouldBypassRelevanceGate(false)).toBe(false)
    expect(read(CONTENT)).toContain('isCrossStackJob')
    expect(read(CONTENT)).toContain('isJobTitleAllowed(job.title, targetCareers)')
    expect(read(CONTENT)).toContain('const strictRelevanceGate = !!searchKeyword')
    expect(read(CONTENT)).not.toContain('shouldBypassRelevanceGate(mustAchieve)')
  })

  it('关键词全部无效时不停机，也不再写 24 小时无效标记', () => {
    expect(shouldKeepCollectingOnNoSource(true)).toBe(true)
    expect(shouldKeepCollectingOnNoSource(false)).toBe(false)
    expect(shouldMarkKeywordInvalid(true)).toBe(false)
    expect(shouldMarkKeywordInvalid(false)).toBe(true)
  })

  it('采集上限放大到 50，但用户原本设得更大时不会被改小', () => {
    expect(MUST_ACHIEVE_MAX_JOBS).toBe(50)
    expect(resolveCollectMaxJobs(35, true)).toBe(50)
    expect(resolveCollectMaxJobs(60, true)).toBe(60)
    expect(resolveCollectMaxJobs(35, false)).toBe(35)
  })
})

// ─────────── ② 生命周期：未达成就不算完成 ───────────

describe('isCampaignFinished · 必达目标未达成时永不自行判完成', () => {
  const goal = { enabled: true, hours: 2, targetJobs: 80, mustAchieve: true, startedAt: Date.now() }

  it('所有平台都被标日限 / 配额打满，只要确认投递数没到目标仍返回 false', async () => {
    const campaign = (await createNewCampaign())!
    campaign.capacityGoal = { ...goal }
    for (const pid of Object.keys(campaign.quotas) as PlatformId[]) {
      campaign.quotas[pid].exhausted = true
      campaign.quotas[pid].applied = 0
    }
    expect(isCampaignFinished(campaign)).toBe(false)
  })

  it('平台确认投递数达标后才允许判完成', async () => {
    const campaign = (await createNewCampaign())!
    campaign.capacityGoal = { ...goal }
    for (const pid of Object.keys(campaign.quotas) as PlatformId[]) {
      campaign.quotas[pid].exhausted = true
      campaign.quotas[pid].applied = 0
    }
    campaign.quotas.boss.applied = 80
    expect(isCampaignFinished(campaign)).toBe(true)
  })

  it('用户显式关掉必达后，恢复「所有平台耗尽即完成」的旧语义', async () => {
    const campaign = (await createNewCampaign())!
    campaign.capacityGoal = { ...goal, mustAchieve: false }
    for (const pid of Object.keys(campaign.quotas) as PlatformId[]) {
      campaign.quotas[pid].exhausted = true
    }
    expect(isCampaignFinished(campaign)).toBe(true)
  })

  it('clearPlatformExhausted 能解除日限标记，供冷却结束后重试', async () => {
    const campaign = (await createNewCampaign())!
    campaign.quotas.boss.exhausted = true
    campaign.quotas.liepin.exhausted = true
    // 写回真实存储后再调用，验证它读的是落盘副本
    await saveCampaign(campaign)
    expect(await clearPlatformExhausted(['boss'])).toBe(1)
    const stored = await getCampaign()
    expect(stored!.quotas.boss.exhausted).toBe(false)
    expect(stored!.quotas.liepin.exhausted).toBe(true)
  })
})

// ─────────── ③ 接线静态契约：功能真的被调度调用 ───────────

describe('必达模式接线契约', () => {
  const service = read(SERVICE)

  it('启动与运行中改目标都会触发自动接管，并清掉自设的关键词锁', () => {
    expect(service).toContain('applyMustAchieveTakeover(live, savedGoal, \'start\')')
    expect(service).toContain('applyMustAchieveTakeover(current, goal, \'goal\')')
    expect(service).toContain('await clearInvalidKeywords()')
    expect(service).toContain('applyDeliveryStrategy(\'volume\')')
    expect(service).toContain('savePlatformQuotas(plan.quotas)')
    expect(service).toContain('togglePlatformEnabled(pid, true)')
  })

  it('目标达成才停机，设定时限只作进度参考、绝不判 missed', () => {
    expect(service).toContain('goalAchieved && isMustAchieve(goalNow)')
    expect(service).toContain('🏆 目标必达')
    expect(service).toContain('必达模式继续投递，不设到点放弃')
    expect(service).not.toContain('已超时')
    expect(service).not.toContain('目标必达 · 超时继续')
    expect(read(CAMPAIGN)).toContain('if (!isGoalAchieved(campaign.capacityGoal!, applied)) return false')
  })

  it('工作时段 / 休息 / 补仓频率 / 全平台日限都不再是停机出口', () => {
    expect(service).toContain('shouldBypassWorkWindow(mustAchieveActive, goalAchieved)')
    expect(service).toContain('userRestEnabled && !mustAchieveActive')
    expect(service).toContain('mustAchieveActive || isCapacityUrgent(capacity?.status)')
    expect(service).toContain('activePlatforms.length === 0 && mustAchieveActive')
    // 全平台被标日限不再空等 10 分钟：每轮解除标记 + 30 秒后立刻重试
    expect(service).toContain('clearPlatformExhausted(exhaustedPlatforms)')
    expect(service).toContain('scheduleNextTick(MUST_ACHIEVE_EXHAUSTED_RETRY_MS)')
    expect(service).not.toContain('coolingDown')
    expect(service).toContain('shouldKeepCollectingOnNoSource(mustAchieve)')
  })

  it('采集层放宽活跃时间 / 语义闸门 / 采集上限，评分门槛随任务下发', () => {
    expect(service).toContain('relaxFiltersForMustAchieve(userFilters, mustAchieve)')
    expect(service).toContain('resolveCollectMaxJobs(35, mustAchieve)')
    expect(service).toContain('mustAchieve,\n            keyword: primaryCareerKeyword')
    expect(service).toContain('mustAchieve: mustAchieveActive,\n            targetCareers: gateCareers,')
    expect(service).toContain('type: \'EXECUTE_CAMPAIGN_TASK\'')
    expect(read(CONTENT)).toContain('const mustAchieve = message.payload?.mustAchieve === true')
    expect(read(RUNNER)).toContain('resolveMustAchieveMatchThreshold(baseMatchThreshold, mustAchieve)')
  })

  it('验证码不再整体停机；账号受限仍保留安全熔断但明确说明', () => {
    expect(service).toContain('必达模式不整体停机')
    expect(service).toContain('await markPlatformExhausted(task.platform)')
    // 必达模式只熔断出问题的平台，不再把整个活动 abort 成永久停机
    expect(service).toContain('其余平台继续投递直到目标达成')
    expect(service).toContain('await abortAgentCampaign(\'blocked\')')
  })

  it('UI 默认开启必达并把承诺写清楚', () => {
    expect(read(PANEL)).toContain('aria-label="必达模式"')
    expect(read(PANEL)).toContain('DEFAULT_CAPACITY_GOAL.mustAchieve !== false')
    expect(read(PANEL)).toContain('目标未达成前不停机')
    expect(read(PANEL)).toContain('必达 · 未达成不停机')
  })
})
