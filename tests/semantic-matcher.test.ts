import { describe, expect, it, vi, beforeEach } from 'vitest'
import { checkHardGates, computeLocalMatch } from '../src/shared/ai/local-matcher'
import { matchWithSemanticAI } from '../src/shared/ai/semantic-matcher'
import type { JobCard, JdRequirements } from '../src/shared/types/job'
import type { Resume } from '../src/shared/types/resume'

vi.mock('../src/shared/ai/api-client', () => ({
  chatCompletion: vi.fn(),
}))

import { chatCompletion } from '../src/shared/ai/api-client'
const mockChat = chatCompletion as unknown as ReturnType<typeof vi.fn>

const resume: Resume = {
  id: 'resume-a3',
  name: '候选人',
  fileName: 'resume.pdf',
  fileType: 'pdf',
  fileData: new ArrayBuffer(0),
  rawText: '三年前端开发经验，熟练使用 React、TypeScript、JavaScript 和 CSS。',
  structuredData: {
    name: '候选人',
    email: '',
    phone: '',
    city: '深圳',
    education: [{ school: '测试大学', degree: '本科', major: '计算机科学', startDate: '', endDate: '' }],
    workExperience: [
      { company: '甲公司', position: '前端工程师', startDate: '2020-06', endDate: '2023-05', description: '负责 React 和 TypeScript 项目开发' },
    ],
    skills: ['React', 'TypeScript', 'JavaScript', 'CSS', 'Vite'],
    projects: [],
    summary: '三年前端开发经验，熟练使用 React、TypeScript、JavaScript 和 CSS。',
    yearsOfExperience: 3,
  },
  aiAnalysis: null,
  profile: null,
  isDefault: true,
  createdAt: '2026-07-26T00:00:00.000Z',
  updatedAt: '2026-07-26T00:00:00.000Z',
}

function createJob(overrides: Partial<JobCard>): JobCard {
  return {
    id: 'job',
    title: '高级前端工程师',
    companyName: '测试公司',
    companyLogo: '',
    salary: '20K-30K',
    location: '深圳',
    experience: '3-5年',
    education: '本科',
    tags: ['React', 'TypeScript'],
    jobDescription: '高级前端工程师 React TypeScript 前端开发 3-5年 本科',
    bossName: '',
    bossTitle: '',
    bossOnline: true,
    publishedAt: '',
    url: 'https://www.zhipin.com/job_detail/job.html',
    ...overrides,
  }
}

function withRequirements(req: Partial<JdRequirements>): Partial<JobCard> {
  return {
    requirements: {
      responsibilities: [],
      hardRequirements: [],
      niceToHave: [],
      education: '本科',
      experienceYears: 3,
      salaryMin: null,
      salaryMax: null,
      skills: [{ skill: 'React', required: true }, { skill: 'TypeScript', required: true }],
      source: 'local',
      parsedAt: new Date().toISOString(),
      ...req,
    },
  }
}

describe('checkHardGates', () => {
  it('blocks when resume education is below the requirement', () => {
    const job = createJob(withRequirements({ education: '硕士' }))
    const gate = checkHardGates(job, resume)
    expect(gate.passed).toBe(false)
    expect(gate.reasons[0]).toContain('学历')
  })

  it('blocks when resume years are below the requirement', () => {
    const job = createJob(withRequirements({ experienceYears: 5 }))
    const gate = checkHardGates(job, resume)
    expect(gate.passed).toBe(false)
    expect(gate.reasons[0]).toContain('年限')
  })

  it('passes when requirements are satisfied or unknown', () => {
    const satisfied = checkHardGates(createJob(withRequirements({ education: '本科', experienceYears: 3 })), resume)
    expect(satisfied.passed).toBe(true)
    const unknown = checkHardGates(createJob({}), resume)
    expect(unknown.passed).toBe(true)
  })
})

describe('computeLocalMatch (A3 refactor)', () => {
  it('caps the score and marks not recommended when hard gate blocks', () => {
    const job = createJob(withRequirements({ education: '硕士', experienceYears: 5 }))
    const result = computeLocalMatch(resume, job)
    expect(result.hardGate?.passed).toBe(false)
    expect(result.score).toBeLessThanOrEqual(45)
    expect(result.isRecommended).toBe(false)
    expect(result.recommendation).toContain('硬性要求')
  })

  it('exposes interpretable dimension scores', () => {
    const result = computeLocalMatch(resume, createJob(withRequirements({})))
    expect(result.dimensions).toBeDefined()
    const d = result.dimensions!
    expect(d.skills).toBeGreaterThan(0)
    expect(d.experience).toBeGreaterThan(0)
    expect(d.education).toBeGreaterThan(0)
  })

  it('still scores a matching job materially higher than an unrelated one', () => {
    const matching = computeLocalMatch(resume, createJob(withRequirements({})))
    const unrelated = computeLocalMatch(resume, createJob({
      id: 'backend',
      title: 'Java 后端工程师',
      tags: ['Java', 'Spring Boot'],
      jobDescription: 'Java 后端工程师 Java Spring Boot 后端开发 3-5年 本科',
      requirements: undefined,
    }))
    expect(matching.score).toBeGreaterThanOrEqual(60)
    expect(matching.score - unrelated.score).toBeGreaterThanOrEqual(20)
  })
})

describe('matchWithSemanticAI', () => {
  beforeEach(() => {
    mockChat.mockReset()
  })

  it('skips AI when hard gate blocks and returns local result', async () => {
    const job = createJob(withRequirements({ education: '硕士' }))
    const result = await matchWithSemanticAI(resume, job)
    expect(mockChat).not.toHaveBeenCalled()
    expect(result.hardGate?.passed).toBe(false)
    expect(result.score).toBeLessThanOrEqual(45)
  })

  it('uses AI semantic dimensions when available', async () => {
    mockChat.mockResolvedValue(JSON.stringify({
      score: 85,
      dimensions: { skills: 40, similarity: 10, direction: 20, experience: 10, education: 8 },
      skillMatch: ['React', 'TypeScript'],
      skillGap: ['性能优化'],
      recommendation: '技能与岗位高度契合，建议投递',
      isRecommended: true,
    }))
    const result = await matchWithSemanticAI(resume, createJob(withRequirements({})))
    expect(mockChat).toHaveBeenCalledTimes(1)
    expect(result.score).toBe(85)
    expect(result.dimensions?.skills).toBe(40)
    expect(result.recommendation).toContain('高度契合')
    expect(result.isRecommended).toBe(true)
  })

  it('falls back to local when AI is unavailable', async () => {
    mockChat.mockResolvedValue('')
    const result = await matchWithSemanticAI(resume, createJob(withRequirements({})))
    expect(result.score).toBeGreaterThan(0)
    expect(result.dimensions).toBeDefined()
  })

  it('tolerates malformed AI JSON', async () => {
    mockChat.mockResolvedValue('无法解析的响应')
    const result = await matchWithSemanticAI(resume, createJob(withRequirements({})))
    expect(result.dimensions).toBeDefined()
  })
})
