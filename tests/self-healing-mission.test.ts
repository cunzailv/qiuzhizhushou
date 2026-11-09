// M3 · 任务优先保障与单岗位故障隔离
// 覆盖 executeCampaignTask 的 try-finally 边界、清理现场复原、单岗位异常隔离。
// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const { dismissMock } = vi.hoisted(() => ({ dismissMock: vi.fn() }))

// 只保留 task-runner 运行时真正依赖的模块，其余全部替换为可控桩
vi.mock('../src/shared/platform/boss/action-simulator', () => ({
  dismissUnexpectedModals: dismissMock,
}))
vi.mock('../src/shared/antiBot', () => ({
  scanRisk: vi.fn(() => null),
  randomDelay: vi.fn(async () => {}),
}))
vi.mock('../src/shared/ai/remote-matcher', () => ({
  matchResumeToJob: vi.fn(async () => ({
    jobId: 'job-1',
    score: 88,
    recommendation: '高度匹配',
    isRecommended: true,
    skillMatch: [],
    skillGap: [],
  })),
}))
vi.mock('../src/shared/ai/greeting', () => ({
  generateJobGreeting: vi.fn(async () => ({ text: '您好，我对这个岗位很感兴趣' })),
}))
vi.mock('../src/shared/ai/resume-router', () => ({
  getOptimalResumeForJob: vi.fn(async () => null),
}))
vi.mock('../src/shared/db/shared-state', () => ({
  addSharedAppliedJobId: vi.fn(async () => {}),
}))
vi.mock('../src/shared/db/diagnostics-store', () => ({
  recordSelfHealingEvent: vi.fn(async (e: Record<string, unknown>) => ({
    ...e,
    id: 'diag-mock',
    createdAt: new Date().toISOString(),
  })),
}))
vi.mock('../src/shared/utils/logger', () => ({
  log: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}))

import { executeCampaignTask, cleanupUi } from '../src/content/task-runner'
import { recordSelfHealingEvent } from '../src/shared/db/diagnostics-store'
import type { PlatformAdapter } from '../src/shared/platform/types'
import type { ApplyTask } from '../src/shared/agent/queue-store'
import type { Resume } from '../src/shared/types/resume'

const JD = '岗位描述：负责前端开发，熟悉 React、TypeScript 与工程化。'

function makeAdapter(overrides: Record<string, unknown> = {}): PlatformAdapter {
  const detail = document.createElement('div')
  detail.textContent = JD
  const adapter = {
    id: 'boss',
    name: 'Boss直聘',
    icon: '',
    homeUrl: 'https://www.zhipin.com',
    matchesUrl: () => true,
    detectPageType: () => 'search',
    parseJobCardsFromSearchPage: () => [],
    parseJobDetailFromPage: () => null,
    extractJobDescriptionFromDetail: () => JD,
    collectJobCards: async () => [],
    activateJobCard: async () => detail,
    activateJobCardWithFallback: async () => detail,
    clickApplyButton: async () => true,
    fillGreetingMessage: async () => true,
    getJobSpecificGreeting: () => '您好',
    snapshotCommunicationUi: () => ({ inputs: new Set(), visibleDialogs: new Set() }),
    getRiskConfig: () => ({}),
    closeDetailPanel: async () => {},
    ...overrides,
  }
  return adapter as unknown as PlatformAdapter
}

function makeTask(id = 'boss:job-1'): ApplyTask {
  return {
    id,
    platform: 'boss',
    jobId: 'job-1',
    jobTitle: '前端开发工程师',
    company: '某某科技',
    jobUrl: 'https://www.zhipin.com/job_detail/job-1.html',
    status: 'pending',
    attempts: 0,
    createdAt: Date.now(),
    matchScore: 88,
    matchReason: '高度匹配',
    greeting: '您好，我对这个岗位很感兴趣',
  } as ApplyTask
}

const resume = { id: 'resume-1' } as Resume

describe('M3 · 任务优先保障与单岗位故障隔离 (try-finally Mission Boundary)', () => {
  beforeEach(() => {
    dismissMock.mockReset()
    dismissMock.mockReturnValue(false)
    vi.mocked(recordSelfHealingEvent).mockClear()
    document.body.innerHTML = ''
    document.body.style.overflow = ''
    vi.stubGlobal('chrome', {
      runtime: {
        lastError: null,
        sendMessage: vi.fn((_msg: unknown, cb?: (r: unknown) => void) => {
          if (typeof cb === 'function') cb({ success: true })
          return Promise.resolve({ success: true })
        }),
      },
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
    document.body.innerHTML = ''
  })

  // ─── Suite 1: try-finally 正常路径 ───
  describe('Suite 1: 正常路径始终执行现场复原', () => {
    it('1.1 投递成功返回 done，且 finally 中 cleanupUi 触发 dismissUnexpectedModals', async () => {
      const res = await executeCampaignTask(makeTask(), makeAdapter(), resume)
      expect(res.status).toBe('done')
      expect(res.taskId).toBe('boss:job-1')
      expect(dismissMock).toHaveBeenCalledTimes(1)
    })

    it('1.2 成功后恢复 body 滚动锁死并失焦活跃元素', async () => {
      document.body.style.overflow = 'hidden'
      const input = document.createElement('input')
      document.body.appendChild(input)
      input.focus()

      await executeCampaignTask(makeTask(), makeAdapter(), resume)

      expect(document.body.style.overflow).toBe('')
      expect(document.activeElement).not.toBe(input)
    })

    it('1.3 列表页已就绪、目标岗位不在当前页 → failed，且 finally 仍执行', async () => {
      // 页面必须先有卡片：空壳页（0 卡片 / 0 详情链接）在新版会被判为
      // 「列表页未就绪」→ skipped 待重试，不走 failed，避免触发清空队列自愈。
      // 这里锁的是另一种情况：页面正常，只是这个岗位找不到。
      document.body.innerHTML = '<div class="joblist"><div class="joblist-item">其它岗位</div></div>'
      const noCard = makeAdapter({ activateJobCardWithFallback: async () => null })
      const res = await executeCampaignTask(makeTask(), noCard, resume)
      expect(res.status).toBe('failed')
      expect(res.failReason).toContain('岗位卡片')
      expect(dismissMock).toHaveBeenCalledTimes(1)
    })

    it('1.4 低分跳过分支同样只清理一次（不重复调用）', async () => {
      const task = { ...makeTask(), matchScore: 30 }
      const res = await executeCampaignTask(task as ApplyTask, makeAdapter(), resume)
      expect(res.status).toBe('skipped')
      expect(dismissMock).toHaveBeenCalledTimes(1)
    })
  })

  // ─── Suite 2: try-finally 异常路径 ───
  describe('Suite 2: 异常路径由 catch 收敛，finally 仍执行', () => {
    it('2.1 点击按钮抛异常时返回 failed 且 cleanupUi 仍被调用', async () => {
      const broken = makeAdapter({
        clickApplyButton: async () => {
          throw new Error('DOM detached')
        },
      })

      const res = await executeCampaignTask(makeTask(), broken, resume)

      expect(res.status).toBe('failed')
      expect(res.failReason).toContain('任务执行异常')
      expect(res.failReason).toContain('DOM detached')
      expect(dismissMock).toHaveBeenCalledTimes(1)
    })

    it('2.2 catch 中写入 task_isolated 诊断事件（不阻断主链路）', async () => {
      const broken = makeAdapter({
        activateJobCardWithFallback: async () => {
          throw new Error('navigation timeout')
        },
      })

      await executeCampaignTask(makeTask(), broken, resume)

      expect(recordSelfHealingEvent).toHaveBeenCalledTimes(1)
      expect(recordSelfHealingEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          platform: 'boss',
          category: 'task_isolated',
          bypassPath: 'skip_and_continue',
          taskId: 'boss:job-1',
          success: false,
        }),
      )
    })

    it('2.3 异常信息已上报后台（reportRunnerError）', async () => {
      const broken = makeAdapter({
        clickApplyButton: async () => {
          throw new Error('crash')
        },
      })
      await executeCampaignTask(makeTask(), broken, resume)

      const sent = vi.mocked(chrome.runtime.sendMessage).mock.calls
      expect(sent.some(([msg]) => (msg as { type?: string })?.type === 'RECORD_ERROR')).toBe(true)
    })
  })

  // ─── Suite 3: 单岗位故障隔离 ───
  describe('Suite 3: 单岗位异常不卡死后续投递流水线', () => {
    it('3.1 失败任务之后，下一个任务仍可正常投递成功', async () => {
      const broken = makeAdapter({
        clickApplyButton: async () => {
          throw new Error('single job crash')
        },
      })

      const r1 = await executeCampaignTask(makeTask('boss:bad'), broken, resume)
      const r2 = await executeCampaignTask(makeTask('boss:good'), makeAdapter(), resume)

      expect(r1.status).toBe('failed')
      expect(r2.status).toBe('done')
      expect(dismissMock).toHaveBeenCalledTimes(2)
    })

    it('3.2 连续 5 个任务（含 2 个异常）全部返回结果，无卡死', async () => {
      const broken = makeAdapter({
        clickApplyButton: async () => {
          throw new Error('intermittent')
        },
      })
      const plans = [broken, makeAdapter(), broken, makeAdapter(), makeAdapter()]
      const results = []
      for (let i = 0; i < plans.length; i++) {
        results.push(await executeCampaignTask(makeTask(`boss:j-${i}`), plans[i], resume))
      }

      expect(results).toHaveLength(5)
      expect(results.map((r) => r.status)).toEqual(['failed', 'done', 'failed', 'done', 'done'])
      expect(dismissMock).toHaveBeenCalledTimes(5)
    })

    it('3.3 首个任务残留的 body 锁死不会污染下一个任务', async () => {
      document.body.style.overflow = 'hidden'
      const broken = makeAdapter({
        clickApplyButton: async () => {
          document.body.style.overflow = 'hidden'
          throw new Error('locked page')
        },
      })

      await executeCampaignTask(makeTask('boss:bad'), broken, resume)
      expect(document.body.style.overflow).toBe('') // finally 已复原

      const r2 = await executeCampaignTask(makeTask('boss:good'), makeAdapter(), resume)
      expect(r2.status).toBe('done')
    })
  })

  // ─── Suite 4: cleanupUi 自身异常不外溢 ───
  describe('Suite 4: 清理链路异常被双层保护吞掉', () => {
    it('4.1 dismissUnexpectedModals 抛错时任务仍正常返回 done', async () => {
      dismissMock.mockImplementationOnce(() => {
        throw new Error('cleanup exploded')
      })

      const res = await executeCampaignTask(makeTask(), makeAdapter(), resume)
      expect(res.status).toBe('done')
    })

    it('4.2 adapter.closeDetailPanel 抛错时 cleanupUi 仍 resolve', async () => {
      const adapter = makeAdapter({
        closeDetailPanel: async () => {
          throw new Error('panel close failed')
        },
      })
      await expect(cleanupUi(adapter)).resolves.toBeUndefined()
    })

    it('4.3 关闭按钮 click 抛错时，finally 兜底仍复原 body overflow', async () => {
      document.body.style.overflow = 'hidden'
      const wrap = document.createElement('div')
      wrap.className = 'dialog-wrap'
      const btn = document.createElement('button')
      btn.className = 'icon-close'
      Object.defineProperty(btn, 'offsetWidth', { value: 20, configurable: true })
      btn.click = () => {
        throw new Error('click failed')
      }
      wrap.appendChild(btn)
      document.body.appendChild(wrap)

      await expect(cleanupUi()).resolves.toBeUndefined()
      expect(document.body.style.overflow).toBe('')
    })

    it('4.4 cleanupUi 返回 Promise 且不会抛出未捕获异常', async () => {
      dismissMock.mockImplementation(() => {
        throw new Error('always throws')
      })
      await expect(Promise.all([cleanupUi(), cleanupUi(), cleanupUi()])).resolves.toHaveLength(3)
    })
  })

  // ─── Suite 5: adapter 缺省安全 ───
  describe('Suite 5: adapter 未传入时 cleanupUi 安全返回', () => {
    it('5.1 cleanupUi() 无参数时不抛错且仍调用 dismissUnexpectedModals', async () => {
      await expect(cleanupUi()).resolves.toBeUndefined()
      expect(dismissMock).toHaveBeenCalledTimes(1)
    })

    it('5.2 无 adapter 时仍恢复滚动锁死与焦点', async () => {
      document.body.style.overflow = 'hidden'
      const input = document.createElement('input')
      document.body.appendChild(input)
      input.focus()

      await cleanupUi()

      expect(document.body.style.overflow).toBe('')
      expect(document.activeElement).not.toBe(input)
    })

    it('5.3 cleanupUi(undefined) 与 cleanupUi() 行为一致', async () => {
      await expect(cleanupUi(undefined)).resolves.toBeUndefined()
      expect(dismissMock).toHaveBeenCalledTimes(1)
    })
  })
})
