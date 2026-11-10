// @vitest-environment jsdom
/**
 * 2026-11-10 用户现场反馈（第四轮）：「有问题，我打开网页，插件 bot 自动跑了」。
 *
 * 前三轮把停机锁装在了「把非 running 拉回 running 的复活入口」：
 *   resumeAutomationIfAllowed / ensureMustAchieveAlive / decideMustAchieveWatchdog /
 *   normalizeInitialPanelState(closed)。但漏了三处：
 *   1. runCampaignTick() 只要 campaign.status === 'running' 就一路跑到底，
 *      停机锁不是它的 stop 条件，还会自己 scheduleNextTick() 无限续命；
 *   2. onInstalled 的 resumeFalseCaptchaPauseIfNeeded()、tabs.onUpdated 的
 *      recordApplySuccessFromUrl() 会把 shutdown 清掉的 alarm 重新挂回来；
 *   3. content 的 init() 把 bubble 归一成 expanded 并写回全局，
 *      EXECUTE_CAMPAIGN_TASK 先 createFloatingPanel() 才判 closed，
 *      COLLECT_PLATFORM_JOBS 连 closed 判断都没有 —— 打开网页就会重建浮窗并扫描。
 *
 * 本文件锁死新原则：**用户关掉 AIbot 后，任何自动化入口都不得自己跑起来，
 * 直到用户本人在扩展里重新点「开始投递」。**
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  planAutomationHalt,
  isAutomationStartTool,
  AUTOMATION_START_TOOLS,
  setUserStopped,
  USER_STOPPED_KEY,
  type AutomationHaltSnapshot,
} from '../src/shared/agent/user-intent'

const ROOT = process.cwd()
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf-8')
const SERVICE = 'src/background/campaign-service.ts'
const BG = 'src/background/index.ts'
const CONTENT = 'src/content/index.ts'
const RPC = 'src/background/external-ai-rpc.ts'

const store: Record<string, unknown> = {}
const alarmClear = vi.fn(async () => true)
const alarmGet = vi.fn(async () => undefined)
const alarmCreate = vi.fn()
const tabsCreate = vi.fn(async () => ({ id: 1 }))

function stubChrome(): void {
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: vi.fn(async (key: string | string[] | null) => {
          if (key === null) return { ...store }
          if (Array.isArray(key)) return Object.fromEntries(key.map((k) => [k, store[k]]))
          return { [key]: store[key] }
        }),
        set: vi.fn(async (obj: Record<string, unknown>) => { Object.assign(store, obj) }),
        remove: vi.fn(async (key: string) => { delete store[key] }),
      },
    },
    alarms: { create: alarmCreate, clear: alarmClear, get: alarmGet },
    notifications: { create: vi.fn() },
    runtime: { getManifest: vi.fn(() => ({ content_scripts: [{ js: ['a.js'] }] })) },
    tabs: {
      query: vi.fn(async () => []),
      update: vi.fn(async () => ({})),
      create: tabsCreate,
      get: vi.fn(async () => ({ status: 'complete' })),
    },
    windows: { update: vi.fn(async () => ({})) },
  })
}

beforeEach(() => {
  for (const k of Object.keys(store)) delete store[k]
  alarmClear.mockClear()
  alarmGet.mockClear()
  alarmCreate.mockClear()
  tabsCreate.mockClear()
  stubChrome()
})
afterEach(() => vi.unstubAllGlobals())

const snapshot = (over: Partial<AutomationHaltSnapshot> = {}): AutomationHaltSnapshot => ({
  userStopped: true,
  campaignRunning: true,
  hasTickAlarm: true,
  hasWatchdogAlarm: true,
  hasTimer: true,
  ...over,
})

describe('停机总闸的纯决策 planAutomationHalt', () => {
  it('用户没关闭 → 完全不干预，正常投递不受影响', () => {
    expect(planAutomationHalt(snapshot({ userStopped: false }))).toEqual({
      halt: false,
      clearTimer: false,
      clearTickAlarm: false,
      clearWatchdogAlarm: false,
      abortCampaign: false,
    })
  })

  it('用户已关闭且仍有 running + 定时器 + 两个 alarm → 全部拆掉', () => {
    expect(planAutomationHalt(snapshot())).toEqual({
      halt: true,
      clearTimer: true,
      clearTickAlarm: true,
      clearWatchdogAlarm: true,
      abortCampaign: true,
    })
  })

  it('状态已 aborted / alarm 已清干净时仍然 halt，但不再重复写盘', () => {
    expect(planAutomationHalt(snapshot({
      campaignRunning: false,
      hasTickAlarm: false,
      hasWatchdogAlarm: false,
      hasTimer: false,
    }))).toEqual({
      halt: true,
      clearTimer: false,
      clearTickAlarm: false,
      clearWatchdogAlarm: false,
      abortCampaign: false,
    })
  })

  it('只残留 running 状态（关闭时在途回执覆盖写回）→ 幂等改回 aborted', () => {
    const plan = planAutomationHalt(snapshot({
      hasTickAlarm: false, hasWatchdogAlarm: false, hasTimer: false,
    }))
    expect(plan.halt).toBe(true)
    expect(plan.abortCampaign).toBe(true)
  })
})

describe('外部 AI 启动类工具识别', () => {
  it('启动 / 恢复 / 补采 / 清队列重采都要被停机锁挡住', () => {
    for (const name of AUTOMATION_START_TOOLS) {
      expect(isAutomationStartTool(name), name).toBe(true)
    }
  })

  it('只读与停机类工具不受影响', () => {
    for (const name of ['get_status', 'get_campaign_stats', 'stop_campaign', 'pause_campaign', 'add_blacklist']) {
      expect(isAutomationStartTool(name), name).toBe(false)
    }
    expect(isAutomationStartTool('')).toBe(false)
    expect(isAutomationStartTool('START_CAMPAIGN')).toBe(false)
  })
})

describe('停机总闸的真实行为（直接调 campaign-service）', () => {
  it('用户已关闭：拦下本轮、清掉两个 alarm、把残留 running 改成 aborted', async () => {
    await setUserStopped(true)
    const { createNewCampaign, getCampaign } = await import('../src/shared/agent/queue-store')
    await createNewCampaign()
    // createNewCampaign 默认就是 running，模拟「关掉后状态被在途回执写回」
    alarmGet.mockImplementation(async (name: string) => (name === 'apply-tick' || name === 'must-achieve-watchdog'
      ? ({ name } as chrome.alarms.Alarm)
      : undefined))

    const { haltAutomationIfUserStopped, runCampaignTick } = await import('../src/background/campaign-service')
    expect(await haltAutomationIfUserStopped()).toBe(true)
    expect((await getCampaign())?.status).toBe('aborted')
    expect(alarmClear.mock.calls.map((c) => c[0])).toEqual(
      expect.arrayContaining(['apply-tick', 'must-achieve-watchdog']),
    )

    // 即使有人再触发一次 tick，也不许开 tab / 派任务
    await runCampaignTick()
    expect(tabsCreate).not.toHaveBeenCalled()
    expect((await getCampaign())?.status).toBe('aborted')
    expect(store[USER_STOPPED_KEY]).toBe(true)
  })

  it('用户没关闭：总闸完全不干预，不误清调度', async () => {
    const { haltAutomationIfUserStopped } = await import('../src/background/campaign-service')
    expect(await haltAutomationIfUserStopped()).toBe(false)
    expect(alarmClear).not.toHaveBeenCalled()
  })
})

describe('全链路静态契约：每个复活入口都必须过停机锁', () => {
  it('调度循环第一行就是总闸，且总闸由纯决策驱动', () => {
    const src = read(SERVICE)
    const tick = src.slice(src.indexOf('export async function runCampaignTick'))
    expect(tick.slice(0, 400)).toContain('haltAutomationIfUserStopped()')
    expect(src).toContain('const plan = planAutomationHalt({')
    expect(src).toContain('return plan.halt')
    expect(src.indexOf('export async function haltAutomationIfUserStopped')).toBeLessThan(
      src.indexOf('export async function runCampaignTick'),
    )
  })

  it('两个 alarm 分支、tabs.onUpdated、shutdown 都接上停机意图', () => {
    const bg = read(BG)
    expect(bg).toContain("if (alarm.name === 'apply-tick')")
    expect(bg.slice(bg.indexOf("if (alarm.name === 'apply-tick'"), bg.indexOf("if (alarm.name === 'butler-daily-report-check'")))
      .toContain('haltAutomationIfUserStopped()')
    expect(bg.slice(bg.indexOf('chrome.tabs.onUpdated.addListener'), bg.indexOf('async function resumeAutomationIfAllowed')))
      .toContain('readUserStopped()')
    expect(bg.slice(bg.indexOf('async function shutdownAssistant'), bg.indexOf('chrome.runtime.onMessage.addListener')))
      .toContain('setUserStopped(true)')
  })

  it('看门狗注册、验证码自愈、成功页补记、自动补采四处都有停机早退', () => {
    const src = read(SERVICE)
    const section = (start: string, end?: string) => {
      const from = src.indexOf(start)
      expect(from, start).toBeGreaterThan(-1)
      return src.slice(from, end ? src.indexOf(end, from) : from + 900)
    }
    expect(section('export async function ensureWatchdogAlarm')).toContain('readUserStopped()')
    expect(section('export async function resumeFalseCaptchaPauseIfNeeded')).toContain('readUserStopped()')
    expect(section('export async function recordApplySuccessFromUrl')).toContain('readUserStopped()')
    expect(section('triggerAutoCollect: async ()')).toContain('readUserStopped()')
    expect(src).toContain('userStopped: await readUserStopped()')
    expect(src).toContain('userStopped?: boolean')
    expect(src).toContain('?.userStopped')
  })

  it('外部 AI RPC 在停机时拒绝启动类指令，但不影响对话台', () => {
    const rpc = read(RPC)
    expect(rpc).toContain('isAutomationStartTool(tool.name)')
    expect(rpc).toContain('await readUserStopped()')
    expect(rpc).toContain('外部指令不能自动启动投递')
    // 只加在 handleExternalAiRpc，executeToolForButler 仍是用户本人下指令
    const butler = rpc.slice(rpc.indexOf('export async function executeToolForButler'), rpc.indexOf('export async function handleExternalAiRpc'))
    expect(butler).not.toContain('isAutomationStartTool')
  })

  it('content init 停机时不归一 expanded、不写回、不重建浮窗', () => {
    const c = read(CONTENT)
    const init = c.slice(c.indexOf('async function init()'), c.indexOf('// ------ Listen for popup messages'))
    expect(init).toContain('const stoppedByUser = await readUserStopped()')
    expect(init).toContain("assistantState = { ...assistantState, panelState: 'closed' }")
    expect(init).toContain('const keepPanelHidden')
    expect(init).toContain('if (!keepPanelHidden) panelHost = createFloatingPanel()')
    expect(init).toContain('if (panelHost)')
  })

  it('content 两个任务入口都在建浮窗 / 扫描之前先查停机锁', () => {
    const c = read(CONTENT)
    const exec = c.slice(c.indexOf("if (message.type === 'EXECUTE_CAMPAIGN_TASK')"), c.indexOf("if (message.type === 'COLLECT_PLATFORM_JOBS')"))
    expect(exec).toContain('await readUserStopped()')
    expect(exec.indexOf('await readUserStopped()')).toBeLessThan(exec.indexOf('panelHost = createFloatingPanel()'))
    expect(exec).toContain('用户显式停机，执行层拦截')

    const collect = c.slice(c.indexOf("if (message.type === 'COLLECT_PLATFORM_JOBS')"), c.indexOf("if (message.type === 'CHECK_PLATFORM_LOGIN')"))
    expect(collect).toContain('await readUserStopped()')
    expect(collect.indexOf('await readUserStopped()')).toBeLessThan(collect.indexOf('adapter.collectJobCards'))
    expect(collect).toContain('userStopped: true')
  })
})
