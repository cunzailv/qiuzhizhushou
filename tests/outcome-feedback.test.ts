// @vitest-environment jsdom
// L3 结果复盘：真实事件去重、方向归因、回复率统计、planner 回灌、LLM 数字幻觉拦截
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const { mockChatCompletion } = vi.hoisted(() => ({
  mockChatCompletion: vi.fn(async (_sys: string, _user: string) => ''),
}))

vi.mock('../src/shared/ai/api-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/shared/ai/api-client')>()
  return { ...actual, chatCompletion: mockChatCompletion }
})

import {
  recordOutcomeEvent,
  getOutcomeEvents,
  clearOutcomeEvents,
  buildOutcomeEventKey,
  OUTCOME_EVENTS_KEY,
  type OutcomeEvent,
} from '../src/shared/db/outcome-store'
import {
  summarizeOutcomes,
  buildOutcomeFeedback,
  type OutcomeFeedback,
} from '../src/shared/agent/outcome-feedback'
import {
  deriveProposals,
  planNextCycle,
  type PlanningContext,
} from '../src/shared/agent/planner'
import { DEFAULT_AUTHORIZATION_POLICY } from '../src/shared/types/candidate-profile'
import type { Campaign } from '../src/shared/agent/queue-store'
import type { ReviewResult } from '../src/shared/agent/butler/review-planner'

const mockStorage: Record<string, any> = {}
const NOW = 1_770_000_000_000
const DAY = 86_400_000

function setupChrome(): void {
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: vi.fn(async (keys: string | string[]) => {
          if (typeof keys === 'string') return { [keys]: mockStorage[keys] }
          if (!Array.isArray(keys)) return { ...mockStorage }
          const res: Record<string, any> = {}
          for (const k of keys) res[k] = mockStorage[k]
          return res
        }),
        set: vi.fn(async (obj: Record<string, any>) => Object.assign(mockStorage, obj)),
        remove: vi.fn(async (keys: string | string[]) => {
          const list = Array.isArray(keys) ? keys : [keys]
          for (const k of list) delete mockStorage[k]
        }),
      },
    },
  })
}

beforeEach(() => {
  for (const k of Object.keys(mockStorage)) delete mockStorage[k]
  mockChatCompletion.mockReset()
  mockChatCompletion.mockResolvedValue('')
  setupChrome()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function event(over: Partial<OutcomeEvent> & Pick<OutcomeEvent, 'kind' | 'at'>): OutcomeEvent {
  return {
    id: `${over.kind}-${Math.random().toString(36).slice(2)}`,
    key: `k-${Math.random().toString(36).slice(2)}`,
    jobTitle: 'PHP开发工程师',
    company: '某公司',
    ...over,
  }
}

describe('结果事件存储 outcome-store', () => {
  it('同一投递只记一次，避免重复投递事件夸大样本量', async () => {
    const input = {
      kind: 'applied' as const,
      jobId: 'job-1',
      jobTitle: 'PHP开发工程师',
      company: '竖云科技',
      direction: '后端开发',
      at: NOW,
    }
    expect(await recordOutcomeEvent(input)).toBe(true)
    expect(await recordOutcomeEvent(input)).toBe(false)
    expect(await getOutcomeEvents()).toHaveLength(1)
  })

  it('聊天页轮询到同一条 HR 消息只记一次，不同消息分别记录', async () => {
    const base = {
      kind: 'hr_reply' as const,
      jobTitle: 'PHP开发工程师',
      company: '竖云科技',
      snippet: '方便发一份简历吗？',
      at: NOW,
    }
    expect(await recordOutcomeEvent(base)).toBe(true)
    expect(await recordOutcomeEvent(base)).toBe(false)
    expect(await recordOutcomeEvent({ ...base, snippet: '薪资期望多少？' })).toBe(true)
    expect(await getOutcomeEvents()).toHaveLength(2)
    expect(buildOutcomeEventKey(base)).not.toBe(buildOutcomeEventKey({ ...base, snippet: '别的' }))
  })

  it('按时间升序返回，且 clear 后可重新记录', async () => {
    await recordOutcomeEvent({ kind: 'applied', jobId: 'a', jobTitle: 'A', company: 'C', at: NOW - 1000 })
    await recordOutcomeEvent({ kind: 'applied', jobId: 'b', jobTitle: 'B', company: 'C', at: NOW - 5000 })
    const list = await getOutcomeEvents()
    expect(list.map((e) => e.jobId)).toEqual(['b', 'a'])
    await clearOutcomeEvents()
    expect(mockStorage[OUTCOME_EVENTS_KEY]).toBeUndefined()
  })

  it('无 chrome 环境（单测/普通网页）静默降级，不抛异常', async () => {
    vi.unstubAllGlobals()
    await expect(recordOutcomeEvent({ kind: 'applied', jobTitle: 'A', company: 'C' })).resolves.toBe(false)
    await expect(getOutcomeEvents()).resolves.toEqual([])
  })
})

describe('结果复盘聚合 summarizeOutcomes', () => {
  it('按搜索方向统计真实回复率，区分零回复方向与有效方向', () => {
    const events: OutcomeEvent[] = []
    // 方向「后端开发」投 4 个，零回复
    for (let i = 0; i < 4; i++) {
      events.push(event({
        kind: 'applied', at: NOW - DAY, jobId: `b${i}`,
        direction: '后端开发', jobTitle: `后端岗位${i}`, company: `公司${i}`,
      }))
    }
    // 方向「PHP」投 3 个，2 个 HR 回复 + 1 个面试邀约
    for (let i = 0; i < 3; i++) {
      events.push(event({
        kind: 'applied', at: NOW - DAY, jobId: `p${i}`,
        direction: 'PHP', jobTitle: `PHP岗位${i}`, company: `P公司${i}`,
      }))
    }
    events.push(event({ kind: 'hr_reply', at: NOW - 1000, jobTitle: 'PHP岗位0', company: 'P公司0', snippet: '方便发简历吗' }))
    events.push(event({ kind: 'hr_reply', at: NOW - 900, jobTitle: 'PHP岗位1', company: 'P公司1', snippet: '薪资期望多少' }))
    events.push(event({ kind: 'interview', at: NOW - 800, jobId: 'p2', jobTitle: 'PHP岗位2', company: 'P公司2' }))

    const fb = summarizeOutcomes(events, { days: 7, now: NOW })
    expect(fb.trackedApplications).toBe(7)
    expect(fb.hrReplies).toBe(2)
    expect(fb.interviews).toBe(1)
    expect(fb.staleDirections).toContain('后端开发')
    expect(fb.healthyDirections).toContain('PHP')
    expect(fb.recentHrSnippets).toContain('方便发简历吗')
    expect(fb.hasFreshSignal).toBe(true)
    expect(fb.confidence).toBe('low')
    expect(fb.byDirection.find((d) => d.direction === 'PHP')?.replyRate).toBe(100)
    expect(fb.summary).toContain('AIbot 记录 7 次投递')
  })

  it('同一岗位 read + hr_reply 只算一次回复，不重复计数', () => {
    const events = [
      event({ kind: 'applied', at: NOW - DAY, jobId: 'x', direction: '全栈', jobTitle: '全栈工程师', company: 'A' }),
      event({ kind: 'read', at: NOW - 500, jobId: 'x', jobTitle: '全栈工程师', company: 'A' }),
      event({ kind: 'hr_reply', at: NOW - 400, jobTitle: '全栈工程师', company: 'A', snippet: '你好' }),
      event({ kind: 'communicating', at: NOW - 300, jobId: 'x', jobTitle: '全栈工程师', company: 'A' }),
    ]
    const fb = summarizeOutcomes(events, { days: 7, now: NOW })
    expect(fb.hrReplies).toBe(1)
    expect(fb.byDirection[0].replied).toBe(1)
  })

  it('超出时间窗的旧事件不参与复盘', () => {
    const events = [
      event({ kind: 'applied', at: NOW - 10 * DAY, jobId: 'old', direction: '旧方向' }),
      event({ kind: 'hr_reply', at: NOW - 10 * DAY, jobId: 'old', snippet: '旧消息' }),
      event({ kind: 'applied', at: NOW - DAY, jobId: 'new', direction: '新方向' }),
    ]
    const fb = summarizeOutcomes(events, { days: 7, now: NOW })
    expect(fb.trackedApplications).toBe(1)
    expect(fb.byDirection.map((d) => d.direction)).toEqual(['新方向'])
    expect(fb.hrReplies).toBe(0)
    expect(fb.hasFreshSignal).toBe(false)
  })

  it('没有投递事件时明确标 none，不编造样本量', () => {
    const fb = summarizeOutcomes([], { days: 7, now: NOW })
    expect(fb.confidence).toBe('none')
    expect(fb.trackedApplications).toBe(0)
    expect(fb.summary).toContain('暂无 AIbot 投递结果记录')
    expect(fb.summary).not.toContain('次投递')
  })

  it('30+ 投递样本才给 high 可信度', () => {
    const events = Array.from({ length: 30 }, (_, i) => event({
      kind: 'applied', at: NOW - DAY, jobId: `s${i}`, direction: '全栈',
      jobTitle: `岗位${i}`, company: `C${i}`,
    }))
    expect(summarizeOutcomes(events, { days: 7, now: NOW }).confidence).toBe('high')
    expect(summarizeOutcomes(events.slice(0, 9), { days: 7, now: NOW }).confidence).toBe('low')
  })

  it('无法归因方向的 HR 回复归入「未归类」，不瞎猜', () => {
    const events = [
      event({ kind: 'applied', at: NOW - DAY, jobId: 'a', direction: 'PHP', jobTitle: 'PHP工程师', company: 'A' }),
      event({ kind: 'hr_reply', at: NOW - 100, jobTitle: '未知岗位', company: '未知公司', snippet: '你好' }),
    ]
    const fb = summarizeOutcomes(events, { days: 7, now: NOW })
    expect(fb.byDirection.some((d) => d.direction === '未归类' && d.replied === 1)).toBe(true)
  })

  it('buildOutcomeFeedback 直接读持久化事件', async () => {
    await recordOutcomeEvent({
      kind: 'applied', at: NOW - DAY, jobId: 'j1',
      jobTitle: 'PHP工程师', company: 'A', direction: 'PHP',
    })
    const fb = await buildOutcomeFeedback(7, NOW)
    expect(fb.trackedApplications).toBe(1)
    expect(fb.byDirection[0].direction).toBe('PHP')
  })
})

function makeOutcome(over: Partial<OutcomeFeedback> = {}): OutcomeFeedback {
  return {
    windowDays: 7,
    trackedApplications: 12,
    hrReplies: 2,
    interviews: 1,
    rejects: 1,
    byDirection: [
      { direction: '后端开发', applied: 8, replied: 0, interviews: 0, rejects: 1, replyRate: 0 },
      { direction: 'PHP', applied: 4, replied: 2, interviews: 1, rejects: 0, replyRate: 50 },
    ],
    staleDirections: ['后端开发'],
    healthyDirections: ['PHP'],
    recentHrSnippets: ['方便发一份简历吗'],
    confidence: 'medium',
    hasFreshSignal: true,
    summary: 'L3 结果复盘（近 7 天）：AIbot 记录 12 次投递，HR 回复 2 条、面试邀约 1 个。',
    ...over,
  }
}

function makeContext(over: Partial<PlanningContext> = {}): PlanningContext {
  const review: ReviewResult = {
    period: '近 1 周', total: 20,
    funnel: { total: 20, read: 1, communicating: 0, interview: 0, hired: 0, rejected: 0, pending: 19 },
    replyRate: 5,
    byTitle: [{ title: 'PHP后端', count: 8, replyRate: 0 }],
    suggestions: ['整体回复率偏低：优先优化打招呼语与目标岗位筛选'],
    calibration: { suggested: false, message: '样本不足' },
  }
  return {
    sampleSize: 20,
    replyRate: 5,
    review,
    experiences: [],
    policy: { ...DEFAULT_AUTHORIZATION_POLICY, enabled: true, updatedAt: new Date().toISOString() },
    campaign: {} as unknown as Campaign,
    ...over,
  }
}

describe('Planner 回灌 L3 真实结果', () => {
  it('零回复方向降权、有效方向加权、HR 回复触发话术优化', () => {
    const proposals = deriveProposals(makeContext({ outcome: makeOutcome() }))
    const l3 = proposals.filter((p) => p.detail.includes('L3 结果复盘'))
    expect(l3.length).toBeGreaterThanOrEqual(3)
    expect(l3.some((p) => p.detail.includes('后端开发') && p.kind === 'tune_keywords')).toBe(true)
    expect(l3.some((p) => p.kind === 'tune_platform_weights')).toBe(true)
    expect(l3.some((p) => p.kind === 'tune_greeting')).toBe(true)
  })

  it('没有 L3 事件时不产出任何「复盘」建议', () => {
    const proposals = deriveProposals(makeContext())
    expect(proposals.some((p) => p.detail.includes('L3 结果复盘'))).toBe(false)
  })

  it('确定性摘要带真实数字，LLM 只给不含数字的定性解读', async () => {
    mockChatCompletion.mockResolvedValue('建议优先复盘零回复方向的招呼语，暂不扩大范围。')
    const decision = await planNextCycle(makeContext({ outcome: makeOutcome() }))
    expect(decision.source).toBe('llm_assisted')
    expect(decision.summary).toContain('回复率 5%')
    expect(decision.summary).toContain('AIbot 记录 12 次投递')
    expect(decision.narrative).toBe('建议优先复盘零回复方向的招呼语，暂不扩大范围。')
    expect(decision.outcomeConfidence).toBe('medium')
  })

  it('LLM 编造数字时整条解读丢弃，日志里不会出现幻觉数字', async () => {
    mockChatCompletion.mockResolvedValue('在样本量为 175、回复率为 1 的情况下，建议降低期望薪资。')
    const decision = await planNextCycle(makeContext({ outcome: makeOutcome() }))
    expect(decision.source).toBe('local_rules')
    expect(decision.narrative).toBeUndefined()
    expect(decision.summary).not.toContain('175')
    expect(decision.summary).toContain('AIbot 记录 12 次投递')
  })

  it('未配置 AI 时降级为纯本地结论', async () => {
    mockChatCompletion.mockResolvedValue('')
    const decision = await planNextCycle(makeContext({ outcome: makeOutcome() }))
    expect(decision.source).toBe('local_rules')
    expect(decision.summary).toContain('回复率')
    expect(decision.proposals.length).toBeGreaterThan(0)
  })
})
