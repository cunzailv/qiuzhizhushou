// @vitest-environment jsdom
/**
 * 回归现场日志「有问题，没有实现目标」：
 *
 *  ① 本页 35/45 个语义对口岗位，却「本轮未新增岗位」→ 页码游标只在整页全被排除时
 *     才推进 + skipped/failed 历史任务永久占去重键 = 供给死锁；
 *  ② 「高级php工程师」匹配分 30、门槛 33 被跳过 → 本地评分量纲把已过硬筛的
 *     对口岗位否掉，目标产能结构性不可达；
 *  ③ 目标「2 小时投满 80 份」看似还在倒计时，21:00 后工作时段结束直接休眠，
 *     休眠日志还重复两次 → 墙钟时间与有效工时混为一谈。
 *
 * 本套测试既验证纯函数状态机，也用「静态链路契约」锁住跨文件的接线，
 * 避免只改了某一层、另一层没收到 capacityUrgent 的回归。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  CAPACITY_PRIORITY_THRESHOLD,
  checkCapacityWindowFit,
  describeCapacityStatus,
  evaluateCapacityGoal,
  hasWindowConflict,
  isCapacityUrgent,
} from '../src/shared/agent/capacity-goal'
import { countUsableMinutesUntil, DEFAULT_WINDOWS } from '../src/shared/agent/quota'
import { VOLUME_REST_POLICY } from '../src/shared/agent/rest-policy'
import {
  MAX_TASK_RECYCLES,
  TASK_RETRY_COOLDOWN_MS,
  appendTasksToCampaign,
  clearCampaign,
  createNewCampaign,
  getCampaign,
  isRecyclableTask,
  saveCampaign,
} from '../src/shared/agent/queue-store'
import type { ApplyTask } from '../src/shared/agent/queue-store'
import { aggregateCampaignStats } from '../src/shared/agent/campaign'

const ROOT = process.cwd()
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf-8')

const SERVICE = 'src/background/campaign-service.ts'
const CONTENT = 'src/content/index.ts'
const RUNNER = 'src/content/task-runner.ts'
const PANEL = 'src/popup/components/CampaignPanel.tsx'
const GOAL = 'src/shared/agent/capacity-goal.ts'
const QUEUE = 'src/shared/agent/queue-store.ts'
const CAMPAIGN = 'src/shared/agent/campaign.ts'
const QUOTA = 'src/shared/agent/quota.ts'

const mockStorage: Record<string, any> = {}
const clone = <T>(value: T): T =>
  value === undefined ? value : JSON.parse(JSON.stringify(value))

const alarmCreate = vi.fn()

beforeEach(async () => {
  for (const k of Object.keys(mockStorage)) delete mockStorage[k]
  alarmCreate.mockClear()
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        // 必须深拷贝：getCampaign() 返回的是副本，引用型 mock 会掩盖
        // 「改内存 + 之后写日志把旧副本整份写回」这一类真实 bug。
        get: vi.fn(async (key: string | null) =>
          key === null ? clone(mockStorage) : { [key]: clone(mockStorage[key]) },
        ),
        set: vi.fn(async (obj: Record<string, any>) => { Object.assign(mockStorage, clone(obj)) }),
        remove: vi.fn(async (key: string) => { delete mockStorage[key] }),
      },
    },
    alarms: {
      create: alarmCreate,
      clear: vi.fn(async () => true),
      get: vi.fn(async () => undefined),
    },
    runtime: { sendMessage: vi.fn(async () => ({})) },
  })
  await clearCampaign()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

// ─────────── ① 页码游标：零新增就必须翻页 ───────────

describe('补仓供给 · 页码推进', () => {
  it('1→2→…→5→1 循环，最后回到第 1 页交给关键词轮转', async () => {
    const { nextSearchPage } = await import('../src/background/campaign-service')
    expect(nextSearchPage(1)).toBe(2)
    expect(nextSearchPage(4)).toBe(5)
    expect(nextSearchPage(5)).toBe(1)
    expect(nextSearchPage(3, 3)).toBe(1)
  })

  it('真实持久化游标能跨 Service Worker 重启读回', async () => {
    const { getSearchPageCursor, setSearchPageCursor } = await import('../src/background/campaign-service')
    expect(await getSearchPageCursor('boss:php')).toBe(1)
    await setSearchPageCursor('boss:php', 3)
    expect(await getSearchPageCursor('boss:php')).toBe(3)
    expect(await getSearchPageCursor('boss:java')).toBe(1)
  })

  it('静态契约：零新增分支不再被 collected===0 卡住，且只在主补仓路径推进游标', () => {
    const service = read(SERVICE)
    expect(service).toContain('opts.managePageCursor && collectRes?.success && pageCardTotal > 0')
    expect(service).toContain('await setSearchPageCursor(pageKey, nextPage)')
    expect(service).toContain('const nextPage = nextSearchPage(currentPage)')
    expect(service).not.toContain('if (collected === 0 && excludedOnPage > 0)')
    expect(service).toContain('managePageCursor: true')
  })

  it('采集层回传真实去重 / 截断 / 入队数字，不再把截断数冒充「已投过」', () => {
    const content = read(CONTENT)
    expect(content).toContain('const excludedOnPage = finalCards.filter(isExcludedOnPage).length')
    expect(content).toContain('const truncatedByCap = Math.max(0, pageCardTotal - excludedOnPage - rawJobs.length)')
    expect(content).toContain('tasksProduced: tasks.length')
    expect(content).toContain('duplicatesAtAppend: Math.max(0, tasks.length - added)')
    expect(content).toContain('truncatedByCap,')
    const service = read(SERVICE)
    expect(service).toContain('其中 ${duplicatesAtAppend} 个是历史已处理岗位被去重挡下')
    expect(service).toContain('采集上限截断 ${truncatedByCap} 张')
  })
})

// ─────────── ② 历史任务回收：只回收 skipped，且带重试上限 ───────────

function makeTask(over: Partial<ApplyTask> = {}): ApplyTask {
  return {
    id: 'boss:job-1',
    platform: 'boss',
    jobId: 'job-1',
    jobTitle: '高级php工程师',
    company: '壹众互动',
    jobUrl: 'https://www.zhipin.com/job_detail/job-1.html',
    status: 'skipped',
    attempts: 1,
    createdAt: 1_000_000,
    ...over,
  }
}

describe('补仓供给 · 历史任务回收的安全边界', () => {
  it('只回收 skipped：failed 可能已在平台侧建立沟通，绝不重试造成重复投递', () => {
    const now = 1_000_000 + TASK_RETRY_COOLDOWN_MS + 1
    expect(isRecyclableTask(makeTask(), now)).toBe(true)
    expect(isRecyclableTask(makeTask({ status: 'failed' }), now)).toBe(false)
    expect(isRecyclableTask(makeTask({ status: 'done' }), now)).toBe(false)
    expect(isRecyclableTask(makeTask({ status: 'pending' }), now)).toBe(false)
    expect(isRecyclableTask(makeTask({ status: 'paused' }), now)).toBe(false)
  })

  it('常规节奏要过冷却期；目标产能落后时可传 0 立刻重评', () => {
    const createdAt = 1_000_000
    expect(isRecyclableTask(makeTask({ createdAt }), createdAt + 60_000)).toBe(false)
    expect(isRecyclableTask(makeTask({ createdAt }), createdAt + 60_000, 0)).toBe(true)
  })

  it('同一个岗位最多回收 3 次，避免永远不达标的卡片吃掉整段目标时间', () => {
    expect(MAX_TASK_RECYCLES).toBe(3)
    const now = 1_000_000 + TASK_RETRY_COOLDOWN_MS + 1
    expect(isRecyclableTask(makeTask({ attempts: 2 }), now)).toBe(true)
    expect(isRecyclableTask(makeTask({ attempts: 3 }), now)).toBe(false)
    expect(isRecyclableTask(makeTask({ attempts: 9 }), now)).toBe(false)
  })

  it('真实复现供给死锁：3 个对口 skipped 岗位，常规冷却下 added=0，产能优先下全部回归队列', async () => {
    await createNewCampaign()
    const campaign = (await getCampaign())!
    campaign.tasks = [1, 2, 3].map((n) => makeTask({
      id: `boss:job-${n}`,
      jobId: `job-${n}`,
      jobTitle: `高级php工程师${n}`,
      company: `公司${n}`,
      createdAt: 1_000_000,
      attempts: 1,
    }))
    await saveCampaign(campaign)

    const incoming = [1, 2, 3].map((n) => ({
      id: `boss:job-${n}`,
      platform: 'boss' as const,
      jobId: `job-${n}`,
      jobTitle: `高级php工程师${n}`,
      company: `公司${n}`,
      jobUrl: `https://www.zhipin.com/job_detail/job-${n}.html`,
    }))

    // 模拟 1 分钟前刚跳过：常规节奏不允许回收，页面再来同一批岗位也是 0 新增
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000 + 60_000)
    expect(await appendTasksToCampaign(incoming)).toBe(0)

    // 目标产能落后 → 后台把冷却设为 0，同一批岗位立刻重新入队
    expect(await appendTasksToCampaign(incoming, { retryCooldownMs: 0 })).toBe(3)
    const after = (await getCampaign())!
    expect(after.tasks).toHaveLength(3)
    expect(after.tasks.every((t) => t.status === 'pending')).toBe(true)
    // 已尝试次数要带过去，第 3 次跳过后就不再回收
    expect(after.tasks.every((t) => t.attempts === 2)).toBe(true)
    expect(after.logs.some((l) => l.message.includes('已回收 3 条历史跳过岗位记录'))).toBe(true)
    vi.restoreAllMocks()
  })

  it('failed 记录即使过冷却期也不回收、不释放去重键', async () => {
    await createNewCampaign()
    const campaign = (await getCampaign())!
    campaign.tasks = [makeTask({ status: 'failed', createdAt: 1_000_000 })]
    await saveCampaign(campaign)

    vi.spyOn(Date, 'now').mockReturnValue(1_000_000 + TASK_RETRY_COOLDOWN_MS + 1)
    const added = await appendTasksToCampaign([{
      id: 'boss:job-1',
      platform: 'boss',
      jobId: 'job-1',
      jobTitle: '高级php工程师',
      company: '壹众互动',
      jobUrl: 'https://www.zhipin.com/job_detail/job-1.html',
    }], { retryCooldownMs: 0 })
    expect(added).toBe(0)
    expect((await getCampaign())!.tasks[0].status).toBe('failed')
    vi.restoreAllMocks()
  })

  it('后台与页面用同一个冷却期，回收不会「一头放行一头仍占位」', () => {
    const service = read(SERVICE)
    expect(service).toContain('const retryCooldownMs = opts.capacityUrgent ? 0 : TASK_RETRY_COOLDOWN_MS')
    expect(service).toContain('!isRecyclableTask(t, nowForDedupe, retryCooldownMs)')
    expect(service).toContain('retryCooldownMs,')
    expect(read(CONTENT)).toContain('appendTasksToCampaign(tasks, appendOptions)')
  })
})

// ─────────── ③ 产能优先门槛 ───────────

describe('目标产能优先 · 评分门槛', () => {
  it('产能优先门槛是 20 分，低于常规最低门槛 30 分', () => {
    expect(CAPACITY_PRIORITY_THRESHOLD).toBe(20)
    expect(read(RUNNER)).toContain('const MIN_THRESHOLD = 30')
  })

  it('只有 at-risk / blocked 才算紧急，achieved / missed 不触发产能优先', () => {
    expect(isCapacityUrgent('at-risk')).toBe(true)
    expect(isCapacityUrgent('blocked')).toBe(true)
    expect(isCapacityUrgent('on-track')).toBe(false)
    expect(isCapacityUrgent('achieved')).toBe(false)
    expect(isCapacityUrgent('missed')).toBe(false)
    expect(isCapacityUrgent(null)).toBe(false)
  })

  it('静态契约：紧急状态从后台一路下发到页面执行层，并在日志里说明放宽原因', () => {
    const service = read(SERVICE)
    expect(service).toContain('mustAchieveActive || isCapacityUrgent(capacity?.status)')
    expect(service).toContain('mustAchieve: mustAchieveActive,\n            targetCareers: gateCareers,')
    expect(service).toContain('type: \'EXECUTE_CAMPAIGN_TASK\'')
    expect(service).toContain('autoCollectJobsForCampaign(campaign, activePlatforms, {\n        capacityUrgent,\n        mustAchieve: mustAchieveActive,\n        managePageCursor: true,\n      })')
    expect(read(CONTENT)).toContain('capacityUrgent: message.payload?.capacityUrgent === true')
    expect(read(CONTENT)).toContain('mustAchieve: message.payload?.mustAchieve === true')
    const runner = read(RUNNER)
    expect(runner).toContain('capacityUrgent?: boolean')
    expect(runner).toContain('Math.min(adaptiveThreshold, CAPACITY_PRIORITY_THRESHOLD)')
    expect(runner).toContain('不再让本地评分量纲卡住目标产能')
  })

  it('产能优先不降频补仓，也不再谎称「自动降频」', () => {
    const service = read(SERVICE)
    expect(service).toContain('const nextMs = capacityUrgent\n          ? 30_000')
    expect(service).toContain('目标产能未达成，保持每 30 秒高频巡检补仓')
    expect(service).toContain('真正卡住产出的是岗位供给与投递门槛，不是间隔')
  })

  it('投递成功后只回退一档，不把降档清零造成门槛震荡', () => {
    const runner = read(RUNNER)
    expect(runner).toContain('Math.max(0, level - 1)')
    expect(runner).not.toContain("writeNumberSetting(THRESHOLD_RELAX_KEY, 0)")
  })
})

// ─────────── ④ 目标产能 × 工作时段 ───────────

const HOUR = 60 * 60_000

function capacityContext(over: Record<string, unknown> = {}) {
  return {
    goal: { enabled: true, hours: 2, targetJobs: 80 },
    now: new Date('2026-11-07T19:15:00+08:00').getTime(),
    startedAt: new Date('2026-11-07T19:15:00+08:00').getTime(),
    applied: 21,
    totalQuota: 80,
    baseIntervalMs: 30_000,
    policy: VOLUME_REST_POLICY,
    restEnabled: true,
    ...over,
  }
}

describe('目标产能 × 工作时段 · 有效工时', () => {
  it('countUsableMinutesUntil：21:15 之后设 2 小时目标，实际 0 分钟可投', () => {
    const relaxed = [{ startHour: 9, startMin: 0, endHour: 21, endMin: 0 }]
    const at2115 = new Date('2026-11-07T21:15:00+08:00')
    expect(countUsableMinutesUntil(relaxed, at2115, 2 * HOUR)).toBe(0)
    expect(countUsableMinutesUntil([], at2115, 2 * HOUR)).toBe(120)
    expect(countUsableMinutesUntil(DEFAULT_WINDOWS, at2115, 2 * HOUR)).toBe(0)
  })

  it('19:15 设 2 小时目标，只有 106 分钟落在 09:00-21:00 内（21:00 那一分钟含端点）', () => {
    const relaxed = [{ startHour: 9, startMin: 0, endHour: 21, endMin: 0 }]
    const at1915 = new Date('2026-11-07T19:15:00+08:00')
    expect(countUsableMinutesUntil(relaxed, at1915, 2 * HOUR)).toBe(106)
    expect(countUsableMinutesUntil(relaxed, at1915, 2 * HOUR)).toBeLessThan(120)
  })

  it('有效工时为 0 → blocked，且给出可操作建议', () => {
    const ev = evaluateCapacityGoal(capacityContext({ usableMinutes: 0 }))
    expect(ev.status).toBe('blocked')
    expect(ev.usableMinutes).toBe(0)
    expect(ev.effectiveRemainingMs).toBe(0)
    expect(ev.advice).toContain('工作时段')
    expect(describeCapacityStatus(ev, { enabled: true, hours: 2, targetJobs: 80 }))
      .toContain('当前无法投递')
    expect(hasWindowConflict(ev)).toBe(true)
  })

  it('有效工时小于墙钟 → 可达性判断用有效工时而不是墙钟', () => {
    const ev = evaluateCapacityGoal(capacityContext({ usableMinutes: 105 }))
    expect(ev.remainingMs).toBe(2 * HOUR)
    expect(ev.usableMinutes).toBe(105)
    expect(ev.requiredIntervalMs).toBe((105 * 60_000) / 59)
    expect(ev.advice).toContain('工作时段内只有 105 分钟可投')
  })

  it('设定目标时预检：冲突 / 完全冲突 / 不冲突三种文案', () => {
    expect(checkCapacityWindowFit({ hours: 2, usableMinutes: 105, now: 0 }).conflict).toBe(true)
    expect(checkCapacityWindowFit({ hours: 2, usableMinutes: 105, now: 0 }).advice)
      .toContain('只有 105 分钟')
    expect(checkCapacityWindowFit({ hours: 2, usableMinutes: 0, now: 0 }).advice)
      .toContain('一直休眠')
    expect(checkCapacityWindowFit({ hours: 2, usableMinutes: 120, now: 0 }).conflict).toBe(false)
    expect(checkCapacityWindowFit({ hours: 2, usableMinutes: 120, now: 0 }).advice).toBe('')
  })

  it('统计层透传真实时段，面板不会拿表单默认值误判 blocked', () => {
    expect(read(CAMPAIGN)).toContain('windows: campaign.windows || []')
    const panel = read(PANEL)
    expect(panel).toContain('stats && Array.isArray(stats.windows) ? stats.windows : timeWindows')
    expect(aggregateCampaignStats({
      id: 'c1', createdAt: '', status: 'running', tasks: [], quotas: {} as any,
      windows: [], intervalConfig: { minSeconds: 15, maxSeconds: 45 },
      aiBudgetUsed: 0, consecutiveRestCounter: 0, logs: [],
    }).windows).toEqual([])
  })

  it('首屏提供真正落盘的一键放行，且日志不再谎称「一键设为 24小时不限」', () => {
    const panel = read(PANEL)
    expect(panel).toContain('解除时段限制并继续')
    expect(panel).toContain("type: 'UPDATE_CAMPAIGN_WINDOWS'")
    expect(panel).toContain('await saveTimeWindows(windows)')
    expect(panel).toContain('hasWindowConflict(capacityEvaluation)')
    expect(panel).toContain('checkCapacityWindowFit(')
    const service = read(SERVICE)
    expect(service).toContain('checkCapacityWindowFit({ hours: goal.hours, usableMinutes, now })')
    expect(service).not.toContain('一键设为【24小时不限】')
  })

  it('休眠日志去重持久化，SW 重启后不重复刷屏', () => {
    const service = read(SERVICE)
    expect(service).toContain("const WINDOW_SLEEP_LOG_KEY = 'aibot_last_window_sleep_log_at'")
    expect(service).toContain('await readWindowSleepLogAt()')
    expect(service).toContain('await markWindowSleepLogAt(Date.now())')
    expect(service).toContain('if ((await readWindowSleepLogAt()) !== 0) await markWindowSleepLogAt(0)')
    expect(service).not.toContain('let lastWindowSleepLogAt = 0')
  })

  it('目标产能纯函数与配额时间工具都在独立模块，便于 UI/后台共用', () => {
    expect(read(GOAL)).toContain('export function isCapacityUrgent')
    expect(read(GOAL)).toContain('export const CAPACITY_PRIORITY_THRESHOLD')
    expect(read(QUOTA)).toContain('export function countUsableMinutesUntil')
    expect(read(QUEUE)).toContain('export function isRecyclableTask')
  })
})
