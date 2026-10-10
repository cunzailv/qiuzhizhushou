import { describe, it, expect, beforeEach } from 'vitest'
import { semanticSimilarity, normalizeText, sharedRoleKeywordCount } from '../src/shared/ai/semantic-refine'
import { getAiBudgetLimit, getAiUsageToday, consumeAiCall, isAiBudgetExhausted, resetAiBudget, DEFAULT_DAILY_BUDGET } from '../src/shared/ai/ai-budget'
import { buildReview } from '../src/shared/agent/butler/review-planner'
import type { Application } from '../src/shared/types/application'

describe('C1 本地语义精筛', () => {
  it('别名归一：JS↔JavaScript / Node↔Node.js 跨写法可匹配', () => {
    const high = semanticSimilarity('React JS 前端开发', 'React JavaScript 前端开发')
    const low = semanticSimilarity('Java 后端开发', 'React 前端开发')
    expect(high).toBeGreaterThan(low)
  })

  it('normalizeText 归一别名', () => {
    expect(normalizeText('Node.js & TS')).toBe('nodejs & typescript')
  })

  it('方向词共现增强相似度', () => {
    const withRole = sharedRoleKeywordCount('前端 React 开发', '前端 Vue 开发')
    expect(withRole).toBeGreaterThan(0)
  })

  it('完全无关文本相似度趋近 0', () => {
    expect(semanticSimilarity('Java 微服务', '新媒体运营')).toBeLessThan(0.3)
  })

  it('高度重合文本相似度高', () => {
    expect(semanticSimilarity('React TypeScript HTML CSS', 'React TypeScript HTML CSS')).toBeGreaterThan(0.7)
  })
})

describe('C4 AI 预算护栏', () => {
  beforeEach(async () => {
    await resetAiBudget()
  })

  it('默认预算 = 50', async () => {
    expect(DEFAULT_DAILY_BUDGET).toBe(50)
    expect(await getAiBudgetLimit()).toBe(50)
  })

  it('消耗后剩余递减，超限判定生效', async () => {
    expect(await getAiUsageToday()).toBe(0)
    await consumeAiCall()
    await consumeAiCall()
    expect(await getAiUsageToday()).toBe(2)
    expect(await isAiBudgetExhausted()).toBe(false)
  })

  it('消耗满预算后 isAiBudgetExhausted = true', async () => {
    const limit = await getAiBudgetLimit()
    for (let i = 0; i < limit; i++) {
      await consumeAiCall()
    }
    expect(await isAiBudgetExhausted()).toBe(true)
    // 继续消耗返回负剩余
    expect(await consumeAiCall()).toBeLessThan(0)
  })

  it('resetAiBudget 清零', async () => {
    await consumeAiCall()
    await resetAiBudget()
    expect(await getAiUsageToday()).toBe(0)
  })
})

describe('C2 复盘 Agent', () => {
  const daysAgo = (days: number) => new Date(Date.now() - days * 86400000).toISOString()

  function makeApp(overrides: Partial<Application>): Application {
    return {
      id: 'a1',
      jobId: 'j1',
      jobTitle: '前端工程师',
      companyName: '测试科技',
      salary: '20K-30K',
      location: '深圳',
      experience: '',
      education: '',
      tags: [],
      jobDescription: '',
      resumeId: 'r1',
      matchScore: 80,
      matchReason: '推荐',
      status: 'applied',
      notes: '',
      appliedAt: daysAgo(1),
      updatedAt: daysAgo(1),
      platformId: 'boss',
      ...overrides,
    }
  }

  it('近 14 天漏斗与回复率统计', () => {
    const apps = [
      makeApp({ id: 'a1', status: 'applied', appliedAt: daysAgo(1) }),
      makeApp({ id: 'a2', status: 'read', appliedAt: daysAgo(3) }),
      makeApp({ id: 'a3', status: 'interview', appliedAt: daysAgo(2) }),
      makeApp({ id: 'a4', status: 'rejected', appliedAt: daysAgo(30) }), // 超出窗口
    ]
    const review = buildReview(apps, { now: Date.now() })
    expect(review.total).toBe(3)
    expect(review.funnel.read).toBe(1)
    expect(review.funnel.interview).toBe(1)
    expect(review.replyRate).toBe(67)
  })

  it('低回复率给出建议', () => {
    const apps = [
      makeApp({ id: 'a1', status: 'applied', appliedAt: daysAgo(1) }),
      makeApp({ id: 'a2', status: 'applied', appliedAt: daysAgo(2) }),
      makeApp({ id: 'a3', status: 'applied', appliedAt: daysAgo(3) }),
    ]
    const review = buildReview(apps)
    expect(review.replyRate).toBe(0)
    expect(review.suggestions.some((s) => s.includes('回复率偏低'))).toBe(true)
  })

  it('推荐层命中率低 → 触发权重校准建议', () => {
    const apps = Array.from({ length: 6 }, (_, i) =>
      makeApp({ id: `b${i}`, status: 'applied', matchScore: 75, appliedAt: daysAgo(i + 1) }),
    )
    const review = buildReview(apps)
    expect(review.calibration.suggested).toBe(true)
    expect(review.calibration.message).toContain('命中率')
  })

  it('样本不足时不校准', () => {
    const review = buildReview([makeApp({ id: 'c1', status: 'applied' })])
    expect(review.calibration.suggested).toBe(false)
  })
})
