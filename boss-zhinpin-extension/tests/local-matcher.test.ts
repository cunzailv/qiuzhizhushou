import { describe, expect, it } from 'vitest'
import { computeLocalMatch } from '../src/shared/ai/local-matcher'
import type { JobCard } from '../src/shared/types/job'
import type { Resume } from '../src/shared/types/resume'

const resume: Resume = {
  id: 'resume-local-match',
  name: '前端候选人',
  fileName: 'resume.pdf',
  fileType: 'pdf',
  fileData: new ArrayBuffer(0),
  rawText: '三年前端开发经验，熟练使用 React、TypeScript、JavaScript 和 CSS。',
  structuredData: {
    name: '前端候选人',
    email: '',
    phone: '',
    city: '深圳',
    education: [{
      school: '测试大学',
      degree: '本科',
      major: '计算机科学',
      startDate: '',
      endDate: '',
    }],
    workExperience: [
      {
        company: '甲公司',
        position: '前端工程师',
        startDate: '',
        endDate: '',
        description: '负责 React 和 TypeScript 项目开发',
      },
      {
        company: '乙公司',
        position: 'Web 开发工程师',
        startDate: '',
        endDate: '',
        description: '负责前端性能优化和组件建设',
      },
    ],
    skills: ['React', 'TypeScript', 'JavaScript', 'CSS', 'Vite'],
    projects: [{
      name: '管理后台',
      role: '前端开发',
      startDate: '',
      endDate: '',
      description: '使用 React TypeScript 开发企业管理后台',
      technologies: ['React', 'TypeScript'],
    }],
    summary: '三年前端开发经验，熟练使用 React、TypeScript、JavaScript 和 CSS。',
    yearsOfExperience: 3,
  },
  aiAnalysis: null,
  isDefault: true,
  createdAt: '2026-07-26T00:00:00.000Z',
  updatedAt: '2026-07-26T00:00:00.000Z',
}

function createJob(overrides: Partial<JobCard>): JobCard {
  return {
    id: 'job',
    title: '',
    companyName: '测试公司',
    companyLogo: '',
    salary: '20K-30K',
    location: '深圳',
    experience: '3-5年',
    education: '本科',
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

describe('local matcher', () => {
  it('scores matching card metadata materially higher than an unrelated job', () => {
    const matching = computeLocalMatch(resume, createJob({
      id: 'frontend',
      title: '高级前端工程师',
      tags: ['React', 'TypeScript', '前端开发'],
      jobDescription: '高级前端工程师 React TypeScript 前端开发 3-5年 本科',
    }))
    const unrelated = computeLocalMatch(resume, createJob({
      id: 'backend',
      title: 'Java 后端工程师',
      tags: ['Java', 'Spring Boot', '后端开发'],
      jobDescription: 'Java 后端工程师 Java Spring Boot 后端开发 3-5年 本科',
    }))

    expect(matching.score).toBeGreaterThanOrEqual(60)
    expect(matching.score - unrelated.score).toBeGreaterThanOrEqual(20)
  })

  it('uses the job title to distinguish the candidate career direction', () => {
    const relevant = computeLocalMatch(resume, createJob({
      id: 'title-frontend',
      title: '高级前端开发工程师',
      jobDescription: '深圳 3-5年 本科',
    }))
    const unrelated = computeLocalMatch(resume, createJob({
      id: 'title-finance',
      title: '高级财务会计',
      jobDescription: '深圳 3-5年 本科',
    }))

    expect(relevant.score - unrelated.score).toBeGreaterThanOrEqual(20)
  })
})
