import { describe, expect, it, vi, beforeEach } from 'vitest'
import {
  parseSalaryRange,
  parseExperienceYears,
  parseEducationRequirement,
  analyzeJdLocally,
  analyzeJd,
} from '../src/shared/ai/jd-analyzer'
import type { JobCard } from '../src/shared/types/job'

vi.mock('../src/shared/ai/api-client', () => ({
  chatCompletion: vi.fn(),
}))

// analyzeJd 尊重 aiEnabled 开关，单测里默认开启 AI 路径
vi.mock('../src/shared/db/settings-store', () => ({
  getSetting: vi.fn(async () => true),
}))

import { chatCompletion } from '../src/shared/ai/api-client'
const mockChat = chatCompletion as unknown as ReturnType<typeof vi.fn>

function createJob(overrides: Partial<JobCard>): JobCard {
  return {
    id: 'job',
    title: '',
    companyName: '测试公司',
    companyLogo: '',
    salary: '',
    location: '深圳',
    experience: '',
    education: '',
    tags: [],
    jobDescription: '',
    bossName: '',
    bossTitle: '',
    bossOnline: true,
    publishedAt: '',
    url: 'https://www.zhipin.com/job_detail/job.html',
    ...overrides,
  }
}

describe('parseSalaryRange', () => {
  it('parses K-based monthly salary', () => {
    expect(parseSalaryRange('20K-30K')).toEqual({ min: 20000, max: 30000 })
  })

  it('parses bare K range', () => {
    expect(parseSalaryRange('15-25K')).toEqual({ min: 15000, max: 25000 })
  })

  it('treats 万 ranges below 10 as monthly salary', () => {
    expect(parseSalaryRange('2-4万')).toEqual({ min: 20000, max: 40000 })
  })

  it('treats 万 ranges at or above 10 as annual salary', () => {
    const parsed = parseSalaryRange('20-40万')
    expect(parsed!.min).toBe(Math.round((20 * 10000) / 12))
    expect(parsed!.max).toBe(Math.round((40 * 10000) / 12))
  })

  it('returns null for 面议', () => {
    expect(parseSalaryRange('面议')).toBeNull()
  })
})

describe('parseExperienceYears', () => {
  it('uses the lower bound of a range', () => {
    expect(parseExperienceYears('3-5年')).toBe(3)
  })

  it('parses floor expressions', () => {
    expect(parseExperienceYears('5年以上')).toBe(5)
    expect(parseExperienceYears('3年及以上')).toBe(3)
  })

  it('returns 0 for 经验不限', () => {
    expect(parseExperienceYears('经验不限')).toBe(0)
  })

  it('returns 0 when nothing is parsed', () => {
    expect(parseExperienceYears('')).toBe(0)
  })
})

describe('parseEducationRequirement', () => {
  it('parses degree floors', () => {
    expect(parseEducationRequirement('本科及以上')).toBe('本科')
    expect(parseEducationRequirement('统招硕士')).toBe('硕士')
    expect(parseEducationRequirement('大专及以上')).toBe('大专')
  })

  it('returns 不限 for open requirements', () => {
    expect(parseEducationRequirement('学历不限')).toBe('不限')
  })

  it('returns empty when nothing is parsed', () => {
    expect(parseEducationRequirement('')).toBe('')
  })
})

describe('analyzeJdLocally', () => {
  it('splits sections and classifies skills as required vs nice-to-have', () => {
    const job = createJob({
      title: 'Go 后端工程师',
      salary: '20K-30K',
      experience: '3-5年',
      education: '本科及以上',
      jobDescription: `
岗位职责
负责订单中台微服务开发，使用 Go、Redis

任职要求
本科及以上学历，3年以上后端开发经验
熟练掌握 Go、MySQL
有分布式系统经验者优先

加分项
熟悉 Kubernetes、Docker 优先
`,
    })
    const local = analyzeJdLocally(job)
    expect(local.salaryMin).toBe(20000)
    expect(local.salaryMax).toBe(30000)
    expect(local.experienceYears).toBe(3)
    expect(local.education).toBe('本科')
    expect(local.responsibilities.length).toBeGreaterThanOrEqual(1)
    expect(local.hardRequirements.length).toBeGreaterThanOrEqual(1)
    expect(local.niceToHave.length).toBeGreaterThanOrEqual(1)

    const go = local.skills.find((s) => s.skill === 'Go')
    expect(go?.required).toBe(true)
    const mysql = local.skills.find((s) => s.skill === 'MySQL')
    expect(mysql?.required).toBe(true)
    const k8s = local.skills.find((s) => s.skill === 'Kubernetes')
    expect(k8s?.required).toBe(false)
    const docker = local.skills.find((s) => s.skill === 'Docker')
    expect(docker?.required).toBe(false)
  })
})

describe('analyzeJd (AI enrichment)', () => {
  beforeEach(() => {
    mockChat.mockReset()
  })

  it('merges AI structured output with local parsing', async () => {
    mockChat.mockResolvedValue(JSON.stringify({
      responsibilities: ['负责订单中台开发', '负责系统性能优化'],
      hardRequirements: ['本科及以上学历', '3年以上Go开发经验'],
      niceToHave: ['有高并发经验'],
      education: '本科',
      experienceYears: 3,
      skills: [{ skill: 'Go', required: true }, { skill: 'Rust', required: false }],
    }))
    const job = createJob({
      title: 'Go 后端工程师',
      salary: '20K-30K',
      jobDescription: '任职要求：熟练掌握 Go、MySQL',
    })
    const req = await analyzeJd(job)
    expect(mockChat).toHaveBeenCalledTimes(1)
    expect(req.source).toBe('hybrid')
    expect(req.responsibilities).toContain('负责订单中台开发')
    expect(req.skills.find((s) => s.skill === 'Go')?.required).toBe(true)
    // 本地薪资解析保留
    expect(req.salaryMin).toBe(20000)
  })

  it('falls back to local when AI is unavailable', async () => {
    mockChat.mockResolvedValue('')
    const job = createJob({
      title: 'Go 后端工程师',
      salary: '20K-30K',
      jobDescription: '任职要求：熟练掌握 Go、MySQL',
    })
    const req = await analyzeJd(job)
    expect(req.source).toBe('local')
    expect(req.salaryMin).toBe(20000)
    expect(req.skills.find((s) => s.skill === 'Go')?.required).toBe(true)
  })

  it('tolerates malformed AI JSON', async () => {
    mockChat.mockResolvedValue('无法解析')
    const job = createJob({ title: 'Go 后端工程师', jobDescription: '任职要求：熟练掌握 Go' })
    const req = await analyzeJd(job)
    expect(req.source).toBe('local')
  })
})
