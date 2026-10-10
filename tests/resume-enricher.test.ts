import { describe, expect, it, vi, beforeEach } from 'vitest'
import {
  parseDateRange,
  computeYearsOfExperience,
  extractProjects,
  extractSkillLevels,
  extractStructuredData,
} from '../src/shared/parser/structure-extractor'
import { enrichResumeProfile } from '../src/shared/ai/resume-enricher'
import type { Resume } from '../src/shared/types/resume'

vi.mock('../src/shared/ai/api-client', () => ({
  chatCompletion: vi.fn(),
}))

import { chatCompletion } from '../src/shared/ai/api-client'
const mockChat = chatCompletion as unknown as ReturnType<typeof vi.fn>

function makeResume(overrides: Partial<Resume['structuredData']> = {}): Resume {
  return {
    id: 'resume-a1',
    name: '候选人',
    fileName: 'resume.pdf',
    fileType: 'pdf',
    fileData: new ArrayBuffer(0),
    rawText: '',
    structuredData: {
      name: '候选人',
      email: '',
      phone: '',
      city: '深圳',
      education: [],
      workExperience: [],
      projects: [],
      skills: [],
      summary: '',
      yearsOfExperience: 0,
      ...overrides,
    },
    aiAnalysis: null,
    profile: null,
    isDefault: true,
    createdAt: '2026-07-26T00:00:00.000Z',
    updatedAt: '2026-07-26T00:00:00.000Z',
  }
}

describe('parseDateRange', () => {
  it('parses a closed date range and computes years', () => {
    const range = parseDateRange('2020.06 - 2023.05 后端工程师')
    expect(range).not.toBeNull()
    expect(range!.startDate).toBe('2020-06')
    expect(range!.endDate).toBe('2023-05')
    expect(range!.years).toBeGreaterThanOrEqual(2.9)
    expect(range!.years).toBeLessThanOrEqual(3.1)
  })

  it('parses alternative separators and month-less dates', () => {
    const range = parseDateRange('2018/07至2021/6')
    expect(range!.startDate).toBe('2018-07')
    expect(range!.endDate).toBe('2021-06')
    expect(range!.years).toBeGreaterThanOrEqual(2.9)
  })

  it('treats 至今 as the current date', () => {
    const range = parseDateRange('2020.01 - 至今')
    expect(range!.endDate).toBe('')
    const now = new Date()
    const expected = (now.getFullYear() - 2020) + (now.getMonth() + 1 - 1) / 12
    expect(Math.abs(range!.years - expected)).toBeLessThan(0.2)
  })

  it('returns null when no date range is present', () => {
    expect(parseDateRange('负责 React 项目开发')).toBeNull()
  })
})

describe('computeYearsOfExperience', () => {
  it('sums years across dated positions', () => {
    const years = computeYearsOfExperience([
      { startDate: '2020-06', endDate: '2023-05', position: '后端工程师' },
      { startDate: '2023-06', endDate: '', position: '高级后端工程师' },
    ])
    const now = new Date()
    const expected = 3 + (now.getFullYear() - 2023) + (now.getMonth() + 1 - 6) / 12
    expect(Math.abs(years - expected)).toBeLessThan(0.3)
  })

  it('halves internship years', () => {
    const years = computeYearsOfExperience([
      { startDate: '2022-01', endDate: '2024-01', position: '实习生' },
    ])
    expect(years).toBe(1)
  })

  it('returns 0 for positions without dates', () => {
    expect(computeYearsOfExperience([{ startDate: '', endDate: '', position: '工程师' }])).toBe(0)
  })
})

describe('extractProjects', () => {
  it('extracts projects with role, dates and technologies', () => {
    const text = `
工作经历
2020.06-2023.05 某公司 后端工程师
负责订单系统开发

项目经历
2021.01-2021.12 订单中台重构
角色：核心开发
使用 Go、Redis 重构订单中台，支撑双11峰值
`
    const projects = extractProjects(text)
    expect(projects.length).toBeGreaterThanOrEqual(1)
    expect(projects[0].name).toContain('订单中台')
    expect(projects[0].startDate).toBe('2021-01')
    expect(projects[0].endDate).toBe('2021-12')
    expect(projects[0].technologies).toContain('Go')
  })
})

describe('extractSkillLevels', () => {
  it('maps Chinese proficiency phrases to levels', () => {
    const levels = extractSkillLevels('精通Go，熟练掌握分布式系统，熟悉Redis，了解Kubernetes')
    const bySkill = new Map(levels.map((l) => [l.skill, l.level]))
    expect(bySkill.get('Go')).toBe('expert')
    expect(bySkill.get('分布式系统')).toBe('proficient')
    expect(bySkill.get('Redis')).toBe('familiar')
    expect(bySkill.get('Kubernetes')).toBe('basic')
  })
})

describe('extractStructuredData (A1 integration)', () => {
  it('computes yearsOfExperience and projects from real text', () => {
    const text = `
姓名：张三
电话：13800138000
邮箱：zhang@example.com
深圳

工作经历
2020.06 - 2023.05 深圳某科技公司 后端工程师
负责订单系统微服务开发

项目经历
2021.01 - 2021.12 订单中台
角色：核心开发
使用 Go、Redis 重构订单中台
`
    const data = extractStructuredData(text)
    expect(data.yearsOfExperience).toBeGreaterThanOrEqual(2.9)
    expect(data.projects.length).toBeGreaterThanOrEqual(1)
  })
})

describe('enrichResumeProfile', () => {
  beforeEach(() => {
    mockChat.mockReset()
  })

  it('returns a local profile without calling AI when years are known', async () => {
    const resume = makeResume({
      yearsOfExperience: 3,
      workExperience: [{ company: '甲公司', position: '前端工程师', startDate: '2020-06', endDate: '2023-05', description: '负责 React 开发' }],
      skills: ['React', 'TypeScript'],
      summary: '三年前端经验',
    })
    const profile = await enrichResumeProfile(resume, '精通React，熟练掌握TypeScript')
    expect(mockChat).not.toHaveBeenCalled()
    expect(profile.yearsOfExperience).toBe(3)
    expect(profile.source).toBe('local')
    expect(profile.profile).toContain('3年')
    expect(profile.skillLevels.length).toBeGreaterThanOrEqual(1)
  })

  it('infers years via AI when local parsing has no dates', async () => {
    mockChat.mockResolvedValue(JSON.stringify({
      yearsOfExperience: 5,
      profile: '5年后端开发经验，精通Go与分布式系统，主导过订单中台重构',
      skillLevels: [{ skill: 'Go', level: 'expert' }],
      achievementHighlights: ['订单中台重构后支撑双11峰值'],
    }))
    const resume = makeResume({
      workExperience: [{ company: '甲公司', position: '后端工程师', startDate: '', endDate: '', description: '多年后端开发' }],
    })
    const profile = await enrichResumeProfile(resume, '5年后端开发经验，精通Go')
    expect(mockChat).toHaveBeenCalledTimes(1)
    expect(profile.source).toBe('ai')
    expect(profile.yearsOfExperience).toBe(5)
    expect(profile.profile).toContain('5年')
    expect(profile.achievementHighlights.length).toBeGreaterThanOrEqual(1)
  })

  it('falls back to local when AI is unavailable', async () => {
    mockChat.mockResolvedValue('')
    const resume = makeResume({
      yearsOfExperience: 0,
      workExperience: [{ company: '甲公司', position: '后端工程师', startDate: '', endDate: '', description: '' }],
    })
    const profile = await enrichResumeProfile(resume, '')
    expect(profile.source).toBe('local')
    expect(profile.yearsOfExperience).toBe(0)
  })

  it('tolerates malformed AI JSON', async () => {
    mockChat.mockResolvedValue('抱歉，我无法回答')
    const resume = makeResume({
      yearsOfExperience: 0,
    })
    const profile = await enrichResumeProfile(resume, '')
    expect(profile.source).toBe('local')
  })
})
