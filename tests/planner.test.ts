// 单一主脑 Planner：真实统计驱动、授权逐条判定、LLM 缺失时降级
import 'fake-indexeddb/auto'
import { describe, it, expect } from 'vitest'
import {
  deriveProposals,
  planNextCycle,
  resetPlannerState,
  type PlanningContext,
} from '../src/shared/agent/planner'
import { DEFAULT_AUTHORIZATION_POLICY } from '../src/shared/types/candidate-profile'
import type { Campaign } from '../src/shared/agent/queue-store'

function makeContext(over: Partial<PlanningContext> = {}): PlanningContext {
  return {
    sampleSize: 20,
    replyRate: 5,
    review: {
      period: '近 1 周',
      total: 20,
      funnel: { total: 20, read: 1, communicating: 0, interview: 0, hired: 0, rejected: 0, pending: 19 },
      replyRate: 5,
      byTitle: [{ title: 'PHP后端', count: 8, replyRate: 0 }],
      suggestions: ['整体回复率偏低：优先优化打招呼语与目标岗位筛选'],
      calibration: { suggested: false, message: '样本不足' },
    },
    experiences: [],
    policy: null,
    campaign: {} as unknown as Campaign,
    ...over,
  }
}

function enabledPolicy() {
  return {
    ...DEFAULT_AUTHORIZATION_POLICY,
    enabled: true,
    updatedAt: new Date().toISOString(),
  }
}

describe('Planner · 根据真实结果推导今日策略', () => {
  it('回复率低迷时产出改写话术、收窄关键词、零回复方向降权', () => {
    const proposals = deriveProposals(makeContext())
    expect(proposals.length).toBeGreaterThanOrEqual(3)
    expect(proposals.some((p) => p.kind === 'tune_greeting')).toBe(true)
    expect(proposals.some((p) => p.detail.includes('PHP后端'))).toBe(true)
  })

  it('无明确改进信号时只给一条维持原策略', () => {
    const ctx = makeContext({
      sampleSize: 3,
      replyRate: 80,
      review: {
        period: '近 1 周', total: 3,
        funnel: { total: 3, read: 2, communicating: 0, interview: 0, hired: 0, rejected: 0, pending: 1 },
        replyRate: 80, byTitle: [], suggestions: [], calibration: { suggested: false, message: '' },
      },
    })
    const proposals = deriveProposals(ctx)
    expect(proposals).toHaveLength(1)
    expect(proposals[0].detail).toContain('维持原策略')
  })

  it('经验记忆中的避坑判断会进入策略建议', () => {
    const ctx = makeContext({
      experiences: [{
        id: 'exp_1', pattern: 'JD 含 外包驻场', verdict: 'avoid',
        sampleSize: 6, replyRate: 0, evidenceIds: ['a1'], source: 'review',
        reason: '命中外包底线', createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(), enabled: true,
      }],
    })
    expect(deriveProposals(ctx).some((p) => p.detail.includes('经验记忆'))).toBe(true)
  })
})

describe('Planner · 每条建议都过授权契约', () => {
  it('授权未启用时全部为 confirm，不擅自改动任何参数', () => {
    const proposals = deriveProposals(makeContext())
    expect(proposals.every((p) => p.level === 'confirm')).toBe(true)
  })

  it('授权启用且已确认时，白名单内的调参项为 auto', () => {
    const proposals = deriveProposals(makeContext({ policy: enabledPolicy() }))
    expect(proposals.some((p) => p.level === 'auto')).toBe(true)
    expect(proposals.filter((p) => p.level === 'auto').every((p) => !!p.cited)).toBe(true)
  })

  it('授权过期时全部降级为 confirm', () => {
    const stale = {
      ...enabledPolicy(),
      updatedAt: new Date(Date.now() - 30 * 86_400_000).toISOString(),
    }
    const proposals = deriveProposals(makeContext({ policy: stale }))
    expect(proposals.every((p) => p.level === 'confirm')).toBe(true)
  })
})

describe('Planner · LLM 缺失时静默降级', () => {
  it('未配置 API Key 仍产出可解释的本地结论', async () => {
    const decision = await planNextCycle(makeContext())
    expect(decision.source).toBe('local_rules')
    expect(decision.summary).toContain('回复率')
    expect(decision.proposals.length).toBeGreaterThan(0)
    expect(decision.applied).toEqual([])
  })

  it('重置节流状态不抛错', () => {
    expect(() => resetPlannerState()).not.toThrow()
  })
})
