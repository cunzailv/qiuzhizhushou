import { describe, it, expect } from 'vitest'
import { evaluateJobWorth, selectTopJobs, salaryFit, preferenceFit, TIER_THRESHOLDS } from '../src/shared/agent/butler/job-selector'
import { buildStrategy, planDailySchedule, buildDailyReport, DEFAULT_DAILY_QUOTA } from '../src/shared/agent/butler/butler-planner'
import { matchQuestionType, respondToQuestion, generatePersonalizedGreeting } from '../src/shared/agent/butler/chat'
import { scanFollowUps, generateFollowUpMessage, daysSinceApplied } from '../src/shared/agent/butler/followup-planner'
import { memoryReplyRate } from '../src/shared/db/butler-store'
import type { JobCard, MatchResult } from '../src/shared/types/job'
import type { CompanyMemory, UserJobProfile } from '../src/shared/types/butler'

function makeJob(overrides: Partial<JobCard> = {}): JobCard {
  return {
    id: 'job-1',
    title: '前端工程师',
    companyName: '测试科技',
    salary: '20K-30K',
    location: '深圳',
    experience: '',
    education: '',
    tags: ['React'],
    jobDescription: 'React TypeScript 前端开发',
    bossName: '张HR',
    bossTitle: 'HR',
    bossOnline: false,
    publishedAt: '',
    url: 'https://www.zhipin.com/job_detail/job-1.html',
    ...overrides,
  }
}

function makeMatch(overrides: Partial<MatchResult> = {}): MatchResult {
  return {
    jobId: 'job-1',
    score: 83,
    skillMatch: ['React', 'TypeScript'],
    skillGap: [],
    strengths: ['技能匹配'],
    weaknesses: [],
    improvementSuggestions: [],
    recommendation: '推荐',
    scoreBypassed: false,
    dimensions: { skills: 45, similarity: 12, direction: 20, experience: 6, education: 0 },
    ...overrides,
  }
}

const defaultProfile: UserJobProfile = {
  targetTitles: ['前端'],
  targetCities: ['深圳'],
  salaryMin: 15,
  salaryMax: 30,
  dailyQuota: 10,
}

describe('B2 选岗 Agent', () => {
  it('推荐层：高匹配 + 薪资契合 + 目标命中 → recommend', () => {
    const result = evaluateJobWorth(makeJob(), makeMatch(), defaultProfile)
    expect(result.tier).toBe('recommend')
    expect(result.worthScore).toBeGreaterThanOrEqual(TIER_THRESHOLDS.recommend)
    expect(result.reasons.length).toBeGreaterThan(0)
    expect(result.reasons.some((r) => r.includes('匹配分'))).toBe(true)
  })

  it('硬门槛未过 → 直接 mismatch 且分数为 0', () => {
    const match = makeMatch({ hardGate: { passed: false, reasons: ['学历要求硕士，简历为本科'] } })
    const result = evaluateJobWorth(makeJob(), match, defaultProfile)
    expect(result.tier).toBe('mismatch')
    expect(result.worthScore).toBe(0)
    expect(result.reasons[0]).toContain('硬门槛')
  })

  it('低匹配 + 低偏好 → watch 或 mismatch，且给出理由', () => {
    const match = makeMatch({ score: 38, hardGate: { passed: true, reasons: [] } })
    const result = evaluateJobWorth(
      makeJob({ title: 'Java后端', location: '北京', jobDescription: 'Java Spring 后端开发' }),
      match,
      { ...defaultProfile, targetTitles: ['前端'], targetCities: ['深圳'] },
    )
    expect(result.tier).toBe('mismatch')
    expect(result.worthScore).toBeLessThan(TIER_THRESHOLDS.watch)
  })

  it('公司记忆高回复率提升 worthScore 并写入理由', () => {
    const memory: CompanyMemory = {
      id: '测试科技',
      companyName: '测试科技',
      touchCount: 10,
      replyCount: 9,
      updatedAt: '',
    }
    const withMemory = evaluateJobWorth(makeJob(), makeMatch(), defaultProfile, memory)
    const without = evaluateJobWorth(makeJob(), makeMatch(), defaultProfile)
    expect(withMemory.worthScore).toBeGreaterThan(without.worthScore)
    expect(withMemory.reasons.some((r) => r.includes('回复率'))).toBe(true)
  })

  it('selectTopJobs 过滤 mismatch 并按分数排序', () => {
    const jobs = [
      makeJob({ id: 'a' }),
      makeJob({ id: 'b', title: 'Java后端', location: '北京' }),
      makeJob({ id: 'c', companyName: '测试科技二', salary: '40K-60K' }),
    ]
    const matches = new Map<string, MatchResult>([
      ['a', makeMatch()],
      ['b', makeMatch({ score: 20, hardGate: { passed: true, reasons: [] } })],
      ['c', makeMatch({ score: 92 })],
    ])
    const top = selectTopJobs(jobs, matches, defaultProfile, new Map(), 2)
    expect(top).toHaveLength(2)
    expect(top[0].jobId).toBe('c')
    expect(top.every((e) => e.tier !== 'mismatch')).toBe(true)
  })

  it('salaryFit：期望上限低于岗位下限 → 高适配', () => {
    expect(salaryFit('20K-30K', 10, 15)).toBeGreaterThanOrEqual(0.85)
    expect(salaryFit('20K-30K', 35)).toBeLessThanOrEqual(0.2)
  })

  it('preferenceFit：目标标题/城市命中计分', () => {
    expect(preferenceFit(makeJob(), defaultProfile)).toBeGreaterThanOrEqual(0.8)
    expect(preferenceFit(makeJob({ title: 'Java后端', location: '北京', jobDescription: 'Java Spring 后端开发' }), defaultProfile)).toBeLessThanOrEqual(0.25)
  })
})

describe('B1 求职管家 Agent', () => {
  it('buildStrategy 生成配额/优先级/摘要', () => {
    const strategy = buildStrategy(defaultProfile)
    expect(strategy.dailyQuota).toBe(10)
    expect(strategy.priorities.some((p) => p.includes('前端'))).toBe(true)
    expect(strategy.summary).toContain('10')
  })

  it('buildStrategy 缺省配额 = 20', () => {
    expect(buildStrategy({}).dailyQuota).toBe(DEFAULT_DAILY_QUOTA)
  })

  it('planDailySchedule 推荐层优先、配额封顶', () => {
    const evaluations = [
      { jobId: 'a', tier: 'recommend' as const, worthScore: 90, jobTitle: '', companyName: '', reasons: [], matchScore: 90 },
      { jobId: 'b', tier: 'watch' as const, worthScore: 60, jobTitle: '', companyName: '', reasons: [], matchScore: 60 },
      { jobId: 'c', tier: 'recommend' as const, worthScore: 95, jobTitle: '', companyName: '', reasons: [], matchScore: 95 },
    ]
    const plan = planDailySchedule(evaluations, 2)
    expect(plan).toHaveLength(2)
    expect(plan[0].jobId).toBe('c')
    expect(plan.every((e) => e.tier === 'recommend')).toBe(true)
  })

  it('buildDailyReport 漏斗统计与建议', () => {
    const now = new Date().toISOString()
    const applications = [
      { id: '1', status: 'read' as const, appliedAt: now, companyName: 'A', jobTitle: '前端' },
      { id: '2', status: 'interview' as const, appliedAt: now, companyName: 'B', jobTitle: '后端' },
      { id: '3', status: 'applied' as const, appliedAt: now, companyName: 'C', jobTitle: '测试' },
    ]
    const report = buildDailyReport(applications as never, [], buildStrategy(defaultProfile))
    expect(report.funnel.total).toBe(3)
    expect(report.funnel.read).toBe(1)
    expect(report.funnel.interview).toBe(1)
    expect(report.suggestions.length).toBeGreaterThan(0)
    expect(report.summary).toContain('3')
  })
})

describe('B3 沟通 Agent', () => {
  it('matchQuestionType 识别薪资/到岗/自我介绍/经验问题', () => {
    expect(matchQuestionType('你的期望薪资是多少？')).toBe('salary')
    expect(matchQuestionType('最快什么时候能到岗？')).toBe('start_date')
    expect(matchQuestionType('简单介绍下自己')).toBe('self_intro')
    expect(matchQuestionType('有 React 项目经验吗？')).toBe('experience')
    expect(matchQuestionType('今天天气怎么样')).toBe('other')
  })

  it('respondToQuestion 模板答案含简历事实', async () => {
    const resume = {
      id: 'r1',
      name: '测试用户',
      rawText: 'React 前端开发',
      structuredData: {
        name: '测试用户', email: '', phone: '',
        education: [{ school: '测试大学', degree: '本科', major: '计算机', startDate: '', endDate: '' }],
        workExperience: [], skills: ['React', 'TypeScript'], projects: [], summary: '', yearsOfExperience: 3,
      },
    } as never
    const salary = await respondToQuestion('期望薪资？', resume as never, makeJob(), false)
    expect(salary.matched).toBe(true)
    expect(salary.answer).toContain('20K-30K')
    const intro = await respondToQuestion('介绍下自己', resume as never, makeJob(), false)
    expect(intro.answer).toContain('3 年')
    expect(intro.answer).toContain('React')
  })

  it('generatePersonalizedGreeting 关闭 AI 时回退模板（与旧行为一致）', async () => {
    const greeting = await generatePersonalizedGreeting('测试用户', makeJob(), makeMatch(), undefined, false)
    expect(greeting).toContain('测试科技')
    expect(greeting).toContain('前端工程师')
  })

  it('generatePersonalizedGreeting AI 开启但无 key → 回退模板', async () => {
    const greeting = await generatePersonalizedGreeting('测试用户', makeJob(), makeMatch(), undefined, true)
    expect(greeting.length).toBeGreaterThan(10)
    expect(greeting).toContain('测试科技')
  })
})

describe('B4 跟进 Agent', () => {
  it('daysSinceApplied 计算天数', () => {
    const threeDaysAgo = new Date(Date.now() - 3 * 86400000).toISOString()
    expect(daysSinceApplied(threeDaysAgo)).toBe(3)
  })

  it('scanFollowUps 只返回超时未推进的投递', () => {
    const now = Date.now()
    const stale = { id: '1', status: 'applied' as const, appliedAt: new Date(now - 3 * 86400000).toISOString(), companyName: 'A', jobTitle: '前端' }
    const fresh = { id: '2', status: 'applied' as const, appliedAt: new Date(now - 1 * 86400000).toISOString(), companyName: 'B', jobTitle: '后端' }
    const rejected = { id: '3', status: 'rejected' as const, appliedAt: new Date(now - 5 * 86400000).toISOString(), companyName: 'C', jobTitle: '测试' }
    const results = scanFollowUps([stale as never, fresh as never, rejected as never], { days: 2, now })
    expect(results).toHaveLength(1)
    expect(results[0].app.id).toBe('1')
  })

  it('generateFollowUpMessage 含公司与岗位', () => {
    const app = { id: '1', companyName: '测试科技', jobTitle: '前端工程师', status: 'applied' as const } as never
    const message = generateFollowUpMessage(app, undefined)
    expect(message).toContain('测试科技')
    expect(message).toContain('前端工程师')
  })

  it('memoryReplyRate 计算回复率', () => {
    expect(memoryReplyRate(undefined)).toBe(0.5)
    expect(memoryReplyRate({ touchCount: 4, replyCount: 3 } as never)).toBeCloseTo(0.75)
  })
})
