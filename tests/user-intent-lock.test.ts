// @vitest-environment jsdom
/**
 * 2026-11-10 用户现场反馈：
 *   1、插件关闭了，有时候自动打开
 *   2、平台关闭了投递了，总是自动打开，一开启投递又自动打开了
 *
 * 旧版把「用户手动关掉的东西」也算成必达模式的可控参数：
 *  - `shutdownAssistant()` 只清 apply-tick，**故意留着周期 watchdog**（注释写「负责按
 *    必达规则按时把流水线拉回来」），15 分钟冷却一过就 resume；后台复活后下发任务，
 *    content 侧 `EXECUTE_CAMPAIGN_TASK` 会 `createFloatingPanel()` → 浮窗自己冒出来。
 *  - `normalizeInitialPanelState()` 把 closed 归一成 expanded 并写回全局，一刷新就重现。
 *  - `planMustAchieveQuotas()` 每轮把 `enabled === false` 的平台列进 enablePlatforms，
 *    `applyMustAchieveTakeover()` 在 start / goal / blocked / watchdog / tick 里反复
 *    `togglePlatformEnabled(pid, true)`，用户刚关掉就被拉回来。
 *
 * 本文件锁死新原则：**用户手动关的，系统不许开；用户自己重新开，才算解除。**
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  readUserStopped,
  setUserStopped,
  readUserDisabledPlatforms,
  setUserDisabledPlatform,
  resolveUserDisabledPlatforms,
  syncUserDisabledPlatforms,
  USER_STOPPED_KEY,
  USER_DISABLED_PLATFORMS_KEY,
} from '../src/shared/agent/user-intent'
import {
  decideMustAchieveWatchdog,
  planMustAchieveQuotas,
  type MustAchieveWatchdogInput,
  type MustAchieveQuotaMap,
} from '../src/shared/agent/must-achieve'
import { normalizeInitialPanelState, DEFAULT_ASSISTANT_STATE } from '../src/shared/assistant-state'

const ROOT = process.cwd()
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf-8')

const store: Record<string, unknown> = {}
beforeEach(() => {
  for (const k of Object.keys(store)) delete store[k]
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: vi.fn(async (key: string) => ({ [key]: store[key] })),
        set: vi.fn(async (obj: Record<string, unknown>) => { Object.assign(store, obj) }),
        remove: vi.fn(async (key: string) => { delete store[key] }),
      },
    },
  })
})
afterEach(() => vi.unstubAllGlobals())

describe('用户停机意图锁', () => {
  it('关闭时落盘、重新开始时清除', async () => {
    expect(await readUserStopped()).toBe(false)
    await setUserStopped(true)
    expect(store[USER_STOPPED_KEY]).toBe(true)
    expect(await readUserStopped()).toBe(true)
    await setUserStopped(false)
    expect(USER_STOPPED_KEY in store).toBe(false)
    expect(await readUserStopped()).toBe(false)
  })

  it('storage 异常时按「未停机」安全降级，不抛错', async () => {
    vi.stubGlobal('chrome', {
      storage: { local: { get: vi.fn(async () => { throw new Error('storage down') }) } },
    })
    await expect(readUserStopped()).resolves.toBe(false)
    await expect(setUserStopped(true)).resolves.toBeUndefined()
  })
})

describe('用户手动关闭的平台保护名单', () => {
  it('关一个记一个，开回来就解除，去重且清空时删 key', async () => {
    await setUserDisabledPlatform('liepin', true)
    await setUserDisabledPlatform('liepin', true)
    await setUserDisabledPlatform('51job', true)
    expect(await readUserDisabledPlatforms()).toEqual(['liepin', '51job'])
    expect(store[USER_DISABLED_PLATFORMS_KEY]).toEqual(['liepin', '51job'])

    await setUserDisabledPlatform('liepin', false)
    expect(await readUserDisabledPlatforms()).toEqual(['51job'])
    await setUserDisabledPlatform('51job', false)
    expect(USER_DISABLED_PLATFORMS_KEY in store).toBe(false)
  })

  it('脏数据（非数组）安全读成空名单', async () => {
    store[USER_DISABLED_PLATFORMS_KEY] = 'liepin'
    expect(await readUserDisabledPlatforms()).toEqual([])
  })

  it('启动时只勾选部分平台，其余也算用户显式关闭', () => {
    const all = ['boss', 'liepin', '51job', 'zhaopin', 'maimai'] as const
    expect(resolveUserDisabledPlatforms(all, ['boss', '51job'])).toEqual([
      'liepin', 'zhaopin', 'maimai',
    ])
    // 没传勾选列表 = 沿用既有保护名单，不擅自清空
    expect(resolveUserDisabledPlatforms(all, undefined)).toEqual([])
    expect(resolveUserDisabledPlatforms(all, [])).toEqual([])
  })

  it('syncUserDisabledPlatforms 真落盘，全部启用时清 key', async () => {
    const all = ['boss', 'liepin', '51job'] as const
    await syncUserDisabledPlatforms(all, ['boss'])
    expect(await readUserDisabledPlatforms()).toEqual(['liepin', '51job'])
    await syncUserDisabledPlatforms(all, [...all])
    expect(USER_DISABLED_PLATFORMS_KEY in store).toBe(false)
  })
})

describe('必达看门狗：用户关了就是关了', () => {
  const base = (patch: Partial<MustAchieveWatchdogInput> = {}): MustAchieveWatchdogInput => ({
    status: 'aborted',
    pausedReason: 'blocked',
    pausedAt: 0,
    mustAchieve: true,
    achieved: false,
    applied: 3,
    targetJobs: 80,
    now: 1_000_000,
    ...patch,
  })

  it('对照组：没有停机意图时，冷却结束确实会按原规则复活', () => {
    expect(decideMustAchieveWatchdog(base()).kind).toBe('resume')
  })

  it('停机意图优先于所有复活规则', () => {
    const cases = [
      base({ userStopped: true }),
      base({ userStopped: true, status: 'paused', pausedReason: 'user' }),
      base({ userStopped: true, status: 'paused', pausedReason: 'captcha' }),
      base({ userStopped: true, status: 'done' }),
      base({ userStopped: true, status: 'running' }),
    ]
    for (const input of cases) {
      expect(decideMustAchieveWatchdog(input)).toEqual({ kind: 'idle' })
    }
  })

  it('userStopped=false 不改变既有语义', () => {
    expect(decideMustAchieveWatchdog(base({ userStopped: false })).kind).toBe('resume')
  })
})

describe('必达配额规划：跳过用户手动关闭的平台', () => {
  const quotas: MustAchieveQuotaMap = {
    boss: { quota: 20, applied: 0, exhausted: false, enabled: false },
    liepin: { quota: 20, applied: 0, exhausted: true, enabled: false },
    '51job': { quota: 20, applied: 0, exhausted: false, enabled: true },
  }

  it('旧行为对照：不传保护名单时三个平台都被接管', () => {
    const plan = planMustAchieveQuotas(quotas, 80, { maxPerPlatform: 500 })
    expect(plan.enablePlatforms).toEqual(['boss', 'liepin'])
    expect(plan.revivePlatforms).toContain('liepin')
    expect(plan.quotas.liepin).toBeGreaterThan(20)
  })

  it('受保护的平台：不抬配额、不开启、不解除日限', () => {
    const plan = planMustAchieveQuotas(quotas, 80, {
      maxPerPlatform: 500,
      protectedPlatforms: ['liepin'],
    })
    expect(plan.protectedPlatforms).toEqual(['liepin'])
    expect(plan.enablePlatforms).toEqual(['boss'])
    expect(plan.enablePlatforms).not.toContain('liepin')
    expect(plan.revivePlatforms).not.toContain('liepin')
    expect(plan.quotas.liepin).toBeUndefined()
    expect(plan.quotas.boss).toBeGreaterThan(20)
  })

  it('全部平台被手动关闭时规划空转，不偷偷开任何一个', () => {
    const plan = planMustAchieveQuotas(quotas, 80, {
      protectedPlatforms: ['boss', 'liepin', '51job'],
    })
    expect(plan.changed).toBe(false)
    expect(plan.enablePlatforms).toEqual([])
    expect(plan.quotas).toEqual({})
    expect(plan.protectedPlatforms).toHaveLength(3)
  })
})

describe('面板归一：关闭状态不再被新页面自动展开', () => {
  it('closed 与 pinned+closed 都保持关闭', () => {
    const closed = { ...DEFAULT_ASSISTANT_STATE, panelState: 'closed' as const }
    expect(normalizeInitialPanelState(closed).panelState).toBe('closed')
    expect(normalizeInitialPanelState({ ...closed, pinned: true }).panelState).toBe('closed')
  })
})

describe('接线契约：所有自动恢复入口都过意图闸', () => {
  const BG = read('src/background/index.ts')
  const SVC = read('src/background/campaign-service.ts')

  it('关闭助手时清掉周期看门狗并写停机锁', () => {
    const from = BG.indexOf('async function shutdownAssistant()')
    const block = BG.slice(from, from + 900)
    expect(block).toContain('chrome.alarms.clear(MUST_ACHIEVE_WATCHDOG_ALARM)')
    expect(block).toContain('await setUserStopped(true)')
    expect(block).toContain("patchAssistantState({ panelState: 'closed' })")
  })

  it('看门狗复活前先读停机锁，且不再偷偷注册 alarm', () => {
    const from = SVC.indexOf('export async function ensureMustAchieveAlive')
    const block = SVC.slice(from, from + 700)
    expect(block).toContain('if (await readUserStopped()) return false')
    expect(block.indexOf('readUserStopped')).toBeLessThan(block.indexOf('ensureWatchdogAlarm'))
  })

  it('启动 / 恢复清停机锁并重建看门狗，终止写停机锁', () => {
    expect(SVC).toContain('await setUserStopped(false)')
    expect(SVC).toContain('await setUserStopped(true)')
    expect(SVC).toContain('⏹ 已彻底停止：目标必达不会自动恢复投递')
    expect(SVC).not.toContain('15 分钟后看门狗会自动恢复投递')
  })

  it('平台开关与启动勾选都同步保护名单，接管时传入', () => {
    expect(SVC).toContain('await setUserDisabledPlatform(platform, !enabled)')
    expect(SVC).toContain('await syncUserDisabledPlatforms(')
    expect(SVC).toContain('const protectedPlatforms = await readUserDisabledPlatforms()')
    expect(SVC).toContain('protectedPlatforms,')
    expect(SVC).toContain('🔒 已尊重你手动关闭的')
  })

  it('全部平台被关闭时明确提示无平台可投，UI 无条件上报开关', () => {
    expect(SVC).toContain('⛔ 所有平台都是你手动关闭的')
    const PANEL = read('src/popup/components/CampaignPanel.tsx')
    expect(PANEL).toContain("type: 'TOGGLE_PLATFORM'")
    // 旧版只在 stats 存在时才通知后台，campaign 未创建时用户关的平台不会进保护名单
    expect(PANEL).toContain('if (stats) await fetchStats()')
  })

  it('必达规划与状态机的纯函数都带上了意图参数', () => {
    const MA = read('src/shared/agent/must-achieve.ts')
    expect(MA).toContain('protectedPlatforms?: readonly PlatformId[]')
    expect(MA).toContain('if (protectedSet.has(pid))')
    expect(MA).toContain('if (input.userStopped) return { kind: \'idle\' }')
  })
})
