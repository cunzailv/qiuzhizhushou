// @vitest-environment jsdom
/**
 * 回归「我的意思是必须完成呀，问题是你写的代码，还有 bot 没有完成任务」。
 *
 * 现场症状：设了「2 小时投满 80 份」，跑到 16/80 就再也不动。
 * 真正的原因不是节奏慢，而是**调度链断了**：
 *
 *  1. `apply-tick` 是一次性 alarm，触发完就没了；
 *  2. `runCampaignTick()` 只要看到 status !== 'running' 就直接 return，且不重建调度；
 *  3. 验证码 / 无岗位来源 / 平台日限 / 账号受限 / 误判完成，全都会把 status 写成非 running。
 *
 * 于是任何一次内部挂起都让流水线永久静默，之前写的「未达成不停机」全成死代码。
 * 本文件锁死修复：独立周期看门狗 + 目标未达成自动复活 + 不再被可控参数阻塞。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  decideMustAchieveWatchdog,
  MUST_ACHIEVE_WATCHDOG_ALARM,
  MUST_ACHIEVE_WATCHDOG_PERIOD_MINUTES,
  MUST_ACHIEVE_BLOCK_COOLDOWN_MS,
  MUST_ACHIEVE_MANUAL_PAUSE_MS,
  MUST_ACHIEVE_EXHAUSTED_RETRY_MS,
  type MustAchieveWatchdogInput,
} from '../src/shared/agent/must-achieve'

const ROOT = process.cwd()
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf-8')
const SERVICE = 'src/background/campaign-service.ts'
const BG = 'src/background/index.ts'
const CONTENT = 'src/content/index.ts'
const STORE = 'src/shared/agent/queue-store.ts'

const NOW = 1_800_000_000_000
const base = (over: Partial<MustAchieveWatchdogInput> = {}): MustAchieveWatchdogInput => ({
  status: 'paused',
  pausedReason: 'captcha',
  pausedAt: 0,
  mustAchieve: true,
  achieved: false,
  applied: 16,
  targetJobs: 80,
  now: NOW,
  ...over,
})

describe('目标必达看门狗：状态复活判定（纯函数）', () => {
  it('目标已达成 → 完全不干预，用户想停就停', () => {
    expect(decideMustAchieveWatchdog(base({ status: 'done', achieved: true }))).toEqual({ kind: 'idle' })
  })

  it('没开必达 → 完全不干预，保留常规模式的暂停语义', () => {
    expect(decideMustAchieveWatchdog(base({ mustAchieve: false }))).toEqual({ kind: 'idle' })
  })

  it('正在 running → 本轮无需复活', () => {
    expect(decideMustAchieveWatchdog(base({ status: 'running' }))).toEqual({ kind: 'idle' })
  })

  it.each(['captcha', 'no_source', 'rate'] as const)(
    '系统自设的挂起原因 %s（16/80 未达成）→ 立即恢复',
    (pausedReason) => {
      const action = decideMustAchieveWatchdog(base({ pausedReason }))
      expect(action.kind).toBe('resume')
      expect((action as { reason: string }).reason).toContain('16/80')
    },
  )

  it('被误判成 done 但只投了 16 份 → 立即恢复', () => {
    expect(decideMustAchieveWatchdog(base({ status: 'done', pausedReason: undefined })).kind)
      .toBe('resume')
  })

  it('历史脏数据没有 pausedAt：按「已卡死很久」处理，不会被 wait 永久锁住', () => {
    expect(decideMustAchieveWatchdog(base({ pausedReason: 'user', pausedAt: 0 })).kind)
      .toBe('resume')
  })

  it('人工暂停还在 5 分钟宽限内 → 等待，不擅自打断用户', () => {
    const action = decideMustAchieveWatchdog(base({
      pausedReason: 'user',
      pausedAt: NOW - 60_000,
    }))
    expect(action.kind).toBe('wait')
    expect((action as { retryMs: number }).retryMs).toBe(MUST_ACHIEVE_MANUAL_PAUSE_MS - 60_000)
  })

  it('人工暂停超过 5 分钟且目标未达成 → 自动回来继续投', () => {
    expect(decideMustAchieveWatchdog(base({
      pausedReason: 'user',
      pausedAt: NOW - MUST_ACHIEVE_MANUAL_PAUSE_MS - 1,
    })).kind).toBe('resume')
  })

  it('账号受限冷却中 → 等待（继续猛点会加重处罚）', () => {
    const action = decideMustAchieveWatchdog(base({
      status: 'aborted',
      pausedReason: 'blocked',
      pausedAt: NOW - 60_000,
    }))
    expect(action.kind).toBe('wait')
    expect((action as { retryMs: number }).retryMs)
      .toBe(MUST_ACHIEVE_BLOCK_COOLDOWN_MS - 60_000)
  })

  it('账号冷却 15 分钟到点 → 自动恢复，不再永久停机', () => {
    expect(decideMustAchieveWatchdog(base({
      status: 'aborted',
      pausedReason: 'blocked',
      pausedAt: NOW - MUST_ACHIEVE_BLOCK_COOLDOWN_MS - 1,
    })).kind).toBe('resume')
  })

  it('等待时间永远不为 0 或负数，避免忙轮询', () => {
    const action = decideMustAchieveWatchdog(base({
      pausedReason: 'user',
      pausedAt: NOW - MUST_ACHIEVE_MANUAL_PAUSE_MS + 10,
    }))
    expect((action as { retryMs: number }).retryMs).toBeGreaterThan(0)
  })

  it('常量：周期 alarm 为 1 分钟，日限重试 30 秒（不再是 10 分钟空等）', () => {
    expect(MUST_ACHIEVE_WATCHDOG_ALARM).toBe('must-achieve-watchdog')
    expect(MUST_ACHIEVE_WATCHDOG_PERIOD_MINUTES).toBe(1)
    expect(MUST_ACHIEVE_EXHAUSTED_RETRY_MS).toBe(30_000)
    expect(MUST_ACHIEVE_EXHAUSTED_RETRY_MS).toBeLessThan(60_000)
  })
})

describe('目标必达看门狗：真实接线契约', () => {
  it('后台注册独立周期 alarm，且不依赖一次性 apply-tick', () => {
    const service = read(SERVICE)
    const bg = read(BG)
    expect(service).toContain('ensureWatchdogAlarm')
    expect(service).toContain('periodInMinutes: MUST_ACHIEVE_WATCHDOG_PERIOD_MINUTES')
    expect(service).toContain('delayInMinutes: MUST_ACHIEVE_WATCHDOG_PERIOD_MINUTES')
    expect(bg).toContain('MUST_ACHIEVE_WATCHDOG_ALARM')
    expect(bg).toContain('void ensureWatchdogAlarm()')
    expect(bg).toContain('await ensureMustAchieveAlive()')
  })

  it('tick 开头先自愈再判断 status，不再裸 return 让调度永久消失', () => {
    const service = read(SERVICE)
    const tickStart = service.indexOf('export async function runCampaignTick')
    const selfHeal = service.indexOf('const revived = await ensureMustAchieveAlive(campaign)')
    const statusGuard = service.indexOf("if (!campaign || campaign.status !== 'running') return", tickStart)
    expect(tickStart).toBeGreaterThan(-1)
    expect(selfHeal).toBeGreaterThan(tickStart)
    expect(statusGuard).toBeGreaterThan(selfHeal)
    expect(service).toContain('if (revived) campaign = await getCampaign()')
  })

  it('冷启动恢复也会跑看门狗，status 非 running 时不再直接放弃', () => {
    const service = read(SERVICE)
    const resume = service.indexOf('export async function resumeSchedulerIfNeeded')
    const alive = service.indexOf('await ensureMustAchieveAlive()', resume)
    expect(alive).toBeGreaterThan(resume)
  })

  it('复活时把休息态 / 无效词锁 / 日限标记一起清掉，否则下一轮又停', () => {
    const service = read(SERVICE)
    expect(service).toContain('await resumeAgentCampaign()')
    expect(service).toContain('await persistRestState({ restUntil: null, consecutiveRestCounter: 0 })')
    expect(service).toContain('await clearInvalidKeywords()')
    expect(service).toContain('await clearPlatformExhausted(blocked)')
    expect(service).toContain("applyMustAchieveTakeover(live, goal, 'watchdog')")
    expect(service).toContain('只认平台确认投递数')
  })

  it('全平台日限不再空等 10 分钟冷却，每轮解除并 30 秒重试', () => {
    const service = read(SERVICE)
    expect(service).toContain('clearPlatformExhausted(exhaustedPlatforms)')
    expect(service).toContain('scheduleNextTick(MUST_ACHIEVE_EXHAUSTED_RETRY_MS)')
    expect(service).not.toContain('coolingDown')
    expect(service).not.toContain('scheduleNextTick(Math.min(cooldownLeft, 5 * 60_000))')
  })

  it('必达模式没读到搜索词时降级到推荐流继续采，不再永久空转', () => {
    const service = read(SERVICE)
    expect(service).toContain('if (keywordInfo.reason === \'no_keywords\')')
    expect(service).toContain('if (mustAchieve)')
    expect(service).toContain('exhausted: false')
    expect(service).toContain('if (keywordInfo.exhausted) return false')
  })

  it('账号受限在必达模式只熔断单平台，其它平台继续投', () => {
    const service = read(SERVICE)
    expect(service).toContain('其余平台继续投递直到目标达成')
    expect(service).toContain('await markPlatformExhausted(task.platform)')
    // 非必达模式才允许整机 abort
    expect(service).toContain("await abortAgentCampaign('blocked')")
  })

  it('人工暂停 / 终止会记录时间，让看门狗按宽限期自动恢复', () => {
    const service = read(SERVICE)
    expect(service).toContain('markPausedAt(Date.now())')
    expect(service).toContain('5 分钟后看门狗会自动恢复投递')
    expect(service).toContain('15 分钟后看门狗会自动恢复投递')
  })

  it('任务执行前回到「关键词 + 来源页码」列表页，避免找不到岗位卡片', () => {
    const service = read(SERVICE)
    const content = read(CONTENT)
    const store = read(STORE)
    expect(service).toContain('ensurePlatformTab(task.platform, taskKeyword || undefined, taskPage, {')
    // 51job 点岗位链接会整页导航到详情页/公司页，只比关键词与页码会把详情页误判为「已对齐」；
    // 执行前必须强制要求列表页，否则现场 0 张岗位卡片、必然报「未找到对应岗位卡片」。
    expect(service).toContain('requireListPage: true')
    expect(service).toContain('page: currentPage')
    expect(content).toContain('const searchPage = Math.max(1, Math.round(Number(message.payload?.page) || 1))')
    expect(content).toContain('searchPage: searchKeyword && searchPage > 1 ? searchPage : undefined')
    expect(store).toContain('searchPage?: number')
  })
})

// ─────────── 行为测试：真的把停掉的流水线拉回来 ───────────
const mockStorage: Record<string, any> = {}
const alarmCreate = vi.fn()

function stubChrome() {
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: vi.fn(async (key: string | string[] | null) => {
          if (key === null) return { ...mockStorage }
          if (Array.isArray(key)) {
            return Object.fromEntries(key.map((k) => [k, mockStorage[k]]))
          }
          return { [key]: mockStorage[key] }
        }),
        set: vi.fn(async (obj: Record<string, any>) => { Object.assign(mockStorage, obj) }),
        remove: vi.fn(async (key: string) => { delete mockStorage[key] }),
      },
    },
    alarms: {
      create: alarmCreate,
      clear: vi.fn(async () => true),
      get: vi.fn(async () => undefined),
    },
    notifications: { create: vi.fn() },
    runtime: { getManifest: vi.fn(() => ({ content_scripts: [{ js: ['a.js'] }] })) },
    tabs: {
      query: vi.fn(async () => []),
      update: vi.fn(async () => ({})),
      create: vi.fn(async () => ({ id: 1 })),
      get: vi.fn(async () => ({ status: 'complete' })),
    },
    windows: { update: vi.fn(async () => ({})) },
  })
}

async function makeStalledCampaign(applied: number, targetJobs = 80) {
  const { createNewCampaign, getCampaign, saveCampaign } = await import('../src/shared/agent/queue-store')
  await createNewCampaign()
  const cmp = await getCampaign()
  if (!cmp) throw new Error('campaign not created')
  cmp.status = 'paused'
  cmp.pausedReason = 'no_source'
  cmp.capacityGoal = {
    enabled: true,
    hours: 2,
    targetJobs,
    mustAchieve: true,
    startedAt: Date.now(),
  } as typeof cmp.capacityGoal
  cmp.quotas.boss.applied = applied
  await saveCampaign(cmp)
  return cmp
}

describe('ensureMustAchieveAlive：停掉的流水线必须真的复活', () => {
  beforeEach(() => {
    for (const k of Object.keys(mockStorage)) delete mockStorage[k]
    alarmCreate.mockClear()
    vi.useFakeTimers()
    stubChrome()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('16/80 被挂成 paused：复活成 running、解除挂起原因、重挂 tick 与周期看门狗', async () => {
    await makeStalledCampaign(16)
    const { getCampaign } = await import('../src/shared/agent/queue-store')
    const { ensureMustAchieveAlive } = await import('../src/background/campaign-service')

    const revived = await ensureMustAchieveAlive()

    expect(revived).toBe(true)
    const after = await getCampaign()
    expect(after?.status).toBe('running')
    expect(after?.pausedReason).toBeUndefined()
    // 复活后必须立刻安排下一轮，否则又是一次性停机
    expect(alarmCreate.mock.calls.some((c) => c[0] === 'apply-tick')).toBe(true)
    expect(alarmCreate.mock.calls.some((c) => c[0] === MUST_ACHIEVE_WATCHDOG_ALARM)).toBe(true)
  })

  it('目标已达成后停机：看门狗不干预，不会把已完成的流水线反复拉起', async () => {
    await makeStalledCampaign(80)
    const cmp = await (await import('../src/shared/agent/queue-store')).getCampaign()
    cmp!.status = 'done'
    cmp!.pausedReason = undefined
    await (await import('../src/shared/agent/queue-store')).saveCampaign(cmp!)
    const { ensureMustAchieveAlive } = await import('../src/background/campaign-service')

    const revived = await ensureMustAchieveAlive()

    expect(revived).toBe(false)
    const after = await (await import('../src/shared/agent/queue-store')).getCampaign()
    expect(after?.status).toBe('done')
  })
})
