// M3 · 白盒对抗压测：cleanupUi 并发安全 + 异常绝不外溢
// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const { dismissMock } = vi.hoisted(() => ({ dismissMock: vi.fn() }))

vi.mock('../src/shared/platform/boss/action-simulator', () => ({
  dismissUnexpectedModals: dismissMock,
}))
vi.mock('../src/shared/antiBot', () => ({
  scanRisk: vi.fn(() => null),
  randomDelay: vi.fn(async () => {}),
}))
vi.mock('../src/shared/ai/remote-matcher', () => ({
  matchResumeToJob: vi.fn(async () => ({
    jobId: 'j', score: 90, recommendation: 'ok', isRecommended: true, skillMatch: [], skillGap: [],
  })),
}))
vi.mock('../src/shared/ai/greeting', () => ({
  generateJobGreeting: vi.fn(async () => ({ text: 'hi' })),
}))
vi.mock('../src/shared/ai/resume-router', () => ({
  getOptimalResumeForJob: vi.fn(async () => null),
}))
vi.mock('../src/shared/db/shared-state', () => ({
  addSharedAppliedJobId: vi.fn(async () => {}),
}))
vi.mock('../src/shared/db/diagnostics-store', () => ({
  recordSelfHealingEvent: vi.fn(async (e: Record<string, unknown>) => ({ ...e, id: 'm', createdAt: 'x' })),
}))
vi.mock('../src/shared/utils/logger', () => ({ log: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))

import { executeCampaignTask, cleanupUi } from '../src/content/task-runner'
import type { PlatformAdapter } from '../src/shared/platform/types'
import type { ApplyTask } from '../src/shared/agent/queue-store'
import type { Resume } from '../src/shared/types/resume'

const JD = '前端工程师，React + TypeScript，三年以上经验。'

function makeAdapter(overrides: Record<string, unknown> = {}): PlatformAdapter {
  const detail = document.createElement('div')
  detail.textContent = JD
  return {
    id: 'boss', name: 'Boss', icon: '', homeUrl: '',
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
    getJobSpecificGreeting: () => 'hi',
    snapshotCommunicationUi: () => ({ inputs: new Set(), visibleDialogs: new Set() }),
    getRiskConfig: () => ({}),
    closeDetailPanel: async () => {},
    ...overrides,
  } as unknown as PlatformAdapter
}

function makeTask(id: string): ApplyTask {
  return {
    id, platform: 'boss', jobId: id, jobTitle: '前端工程师', company: '测试公司',
    jobUrl: 'https://www.zhipin.com/job_detail/a.html',
    status: 'pending', attempts: 0, createdAt: Date.now(),
    matchScore: 90, matchReason: 'ok', greeting: 'hi',
  } as ApplyTask
}

const resume = { id: 'r1' } as Resume

describe('M3 · 对抗压测：cleanupUi 并发安全与异常隔离', () => {
  beforeEach(() => {
    dismissMock.mockReset()
    dismissMock.mockReturnValue(false)
    document.body.innerHTML = ''
    document.body.style.overflow = ''
    vi.stubGlobal('chrome', {
      runtime: {
        lastError: null,
        sendMessage: vi.fn((_m: unknown, cb?: (r: unknown) => void) => {
          if (typeof cb === 'function') cb({ success: true })
          return Promise.resolve({ success: true })
        }),
      },
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    document.body.innerHTML = ''
  })

  describe('Suite 1: cleanupUi 并发安全', () => {
    it('1.1 30 次并发 cleanupUi 全部 resolve，且每次都执行脱困', async () => {
      const calls = Array.from({ length: 30 }, () => cleanupUi())
      await expect(Promise.all(calls)).resolves.toHaveLength(30)
      expect(dismissMock).toHaveBeenCalledTimes(30)
    })

    it('1.2 有/无 adapter 混合并发不产生竞态或异常', async () => {
      const good = makeAdapter()
      const broken = makeAdapter({
        closeDetailPanel: async () => { throw new Error('close boom') },
      })
      const calls = Array.from({ length: 12 }, (_, i) =>
        cleanupUi(i % 3 === 0 ? broken : i % 3 === 1 ? good : undefined),
      )
      await expect(Promise.all(calls)).resolves.toHaveLength(12)
    })

    it('1.3 并发下 body 滚动锁死始终被复原', async () => {
      document.body.style.overflow = 'hidden'
      await Promise.all(Array.from({ length: 10 }, () => cleanupUi()))
      expect(document.body.style.overflow).toBe('')
    })
  })

  describe('Suite 2: 清理链路异常绝不外溢', () => {
    it('2.1 dismissUnexpectedModals 同步抛错 100 次，cleanupUi 全部静默', async () => {
      dismissMock.mockImplementation(() => { throw new Error('always fail') })
      await expect(Promise.all(Array.from({ length: 100 }, () => cleanupUi()))).resolves.toHaveLength(100)
    })

    it('2.2 adapter.closeDetailPanel 抛错时不影响 finally 兜底复原', async () => {
      document.body.style.overflow = 'hidden'
      const broken = makeAdapter({
        closeDetailPanel: async () => { throw new Error('panel detached') },
      })
      await expect(cleanupUi(broken)).resolves.toBeUndefined()
      expect(document.body.style.overflow).toBe('')
    })

    it('2.3 畸形 adapter（closeDetailPanel 非函数）不导致崩溃', async () => {
      const malformed = { closeDetailPanel: 'not-a-function' } as unknown as PlatformAdapter
      await expect(cleanupUi(malformed)).resolves.toBeUndefined()
    })

    it('2.4 activeElement 无 blur 方法时 cleanupUi 仍安全返回', async () => {
      Object.defineProperty(document, 'activeElement', { value: {}, configurable: true })
      await expect(cleanupUi()).resolves.toBeUndefined()
      // @ts-expect-error 删除实例属性以恢复原型 getter
      delete document.activeElement
    })

    it('2.5 关闭按钮 click 抛错 + dismiss 抛错叠加，仍不外溢', async () => {
      dismissMock.mockImplementation(() => { throw new Error('dismiss fail') })
      const wrap = document.createElement('div')
      wrap.className = 'dialog-wrap'
      const btn = document.createElement('button')
      btn.className = 'icon-close'
      Object.defineProperty(btn, 'offsetWidth', { value: 30, configurable: true })
      btn.click = () => { throw new Error('click fail') }
      wrap.appendChild(btn)
      document.body.appendChild(wrap)

      await expect(cleanupUi()).resolves.toBeUndefined()
      expect(document.body.style.overflow).toBe('')
    })
  })

  describe('Suite 3: 并发任务队列不卡死', () => {
    it('3.1 8 个任务并发（4 成功 / 4 异常）全部返回结果', async () => {
      const broken = makeAdapter({
        clickApplyButton: async () => { throw new Error('random crash') },
      })
      const jobs = Array.from({ length: 8 }, (_, i) =>
        executeCampaignTask(makeTask(`boss:c-${i}`), i % 2 === 0 ? broken : makeAdapter(), resume),
      )
      const results = await Promise.all(jobs)
      expect(results).toHaveLength(8)
      expect(results.filter((r) => r.status === 'done')).toHaveLength(4)
      expect(results.filter((r) => r.status === 'failed')).toHaveLength(4)
      expect(dismissMock).toHaveBeenCalledTimes(8)
    })

    it('3.2 串行 20 个任务，异常穿插，末尾任务仍成功', async () => {
      const broken = makeAdapter({
        clickApplyButton: async () => { throw new Error('flaky') },
      })
      const statuses: string[] = []
      for (let i = 0; i < 20; i++) {
        const res = await executeCampaignTask(makeTask(`boss:s-${i}`), i % 4 === 0 ? broken : makeAdapter(), resume)
        statuses.push(res.status)
      }
      expect(statuses).toHaveLength(20)
      expect(statuses[19]).toBe('done')
      expect(dismissMock).toHaveBeenCalledTimes(20)
    })
  })
})
