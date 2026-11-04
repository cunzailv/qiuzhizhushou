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

  it('blocks a job whose required skills are entirely absent from the resume (e.g. Java)', () => {
    const javaJob = computeLocalMatch(resume, createJob({
      id: 'java-backend',
      title: '后端开发工程师',
      tags: ['Java', 'Spring', 'MySQL'],
      jobDescription: '后端开发工程师 3年以上Java工作经验 熟悉Java语言 Spring SpringBoot MySQL 本科',
      requirements: {
        education: '本科',
        experienceYears: 3,
        skills: [
          { skill: 'Java', required: true },
          { skill: 'Spring', required: true },
          { skill: 'MySQL', required: true },
        ],
        responsibilities: [],
        hardRequirements: ['3年以上Java工作经验'],
        niceToHave: [],
        salaryMin: null,
        salaryMax: null,
        source: 'local',
        parsedAt: '2026-07-26T00:00:00.000Z',
      },
    }))

    // 简历只有前端技能（React/TypeScript/JavaScript/CSS/Vite），与 Java 岗核心技能零交集
    expect(javaJob.hardGate?.passed).toBe(false)
    expect(javaJob.hardGate?.reasons.join('')).toContain('核心技能门槛')
    expect(javaJob.score).toBeLessThanOrEqual(45)
    expect(javaJob.isRecommended).toBe(false)
  })

  it('still recommends a job when the resume shares at least one required skill', () => {
    const mixedJob = computeLocalMatch(resume, createJob({
      id: 'fullstack',
      title: '全栈开发工程师',
      tags: ['React', 'Java', 'Node.js'],
      jobDescription: '全栈开发工程师 React Node.js Java Spring 3-5年 本科',
      requirements: {
        education: '本科',
        experienceYears: 3,
        skills: [
          { skill: 'React', required: true },
          { skill: 'Java', required: true },
        ],
        responsibilities: [],
        hardRequirements: [],
        niceToHave: [],
        salaryMin: null,
        salaryMax: null,
        source: 'local',
        parsedAt: '2026-07-26T00:00:00.000Z',
      },
    }))

    // 命中 React → 不触发技能硬门槛（技能分正常计算）
    expect(mixedJob.hardGate?.passed).toBe(true)
    expect(mixedJob.skillMatch).toContain('React')
  })

  it('blocks a Go job even when the resume lists the Gin framework (framework is not language experience)', () => {
    const goResume: Resume = {
      ...resume,
      rawText: 'PHP 后端开发，熟悉 Gin 框架。',
      structuredData: {
        ...resume.structuredData,
        skills: [...resume.structuredData.skills, 'Gin', 'PHP'],
      },
    }
    const goJob = computeLocalMatch(goResume, createJob({
      id: 'go-backend',
      title: 'Go 后台开发工程师',
      tags: ['Go', 'Golang', 'Gin', 'MySQL'],
      jobDescription: 'Go后台开发工程师 Golang Go Gin MySQL Redis 3-5年 大专 熟悉Gin框架',
      requirements: {
        education: '大专',
        experienceYears: 3,
        skills: [
          { skill: 'Go', required: true },
          { skill: 'Golang', required: true },
          { skill: 'MySQL', required: true },
          { skill: 'Redis', required: true },
        ],
        responsibilities: [],
        hardRequirements: [],
        niceToHave: [],
        salaryMin: null,
        salaryMax: null,
        source: 'local',
        parsedAt: '2026-07-26T00:00:00.000Z',
      },
    }))

    // 简历含 Gin（Go 框架）+ MySQL/Redis 命中，核心技能交集非空不拦；
    // 但语言门槛必须兜底：简历没有 Go 语言经验
    expect(goJob.hardGate?.passed).toBe(false)
    expect(goJob.hardGate?.reasons.join('')).toContain('语言门槛')
    expect(goJob.score).toBeLessThanOrEqual(45)
    expect(goJob.isRecommended).toBe(false)
  })

  it('blocks a Java job even when the resume lists the Spring framework', () => {
    const springResume: Resume = {
      ...resume,
      rawText: '后端开发，熟悉 Spring 框架。',
      structuredData: {
        ...resume.structuredData,
        skills: [...resume.structuredData.skills, 'Spring'],
      },
    }
    const javaJob = computeLocalMatch(springResume, createJob({
      id: 'java-spring',
      title: 'Java 后端工程师',
      tags: ['Java', 'Spring'],
      jobDescription: 'Java后端工程师 Java Spring SpringBoot MySQL 3-5年 本科',
      requirements: {
        education: '本科',
        experienceYears: 3,
        skills: [
          { skill: 'Java', required: true },
          { skill: 'Spring', required: true },
        ],
        responsibilities: [],
        hardRequirements: [],
        niceToHave: [],
        salaryMin: null,
        salaryMax: null,
        source: 'local',
        parsedAt: '2026-07-26T00:00:00.000Z',
      },
    }))

    // Spring 命中 → 核心技能交集非空；但语言门槛：简历无 Java 语言经验
    expect(javaJob.hardGate?.passed).toBe(false)
    expect(javaJob.hardGate?.reasons.join('')).toContain('语言门槛')
    expect(javaJob.score).toBeLessThanOrEqual(45)
    expect(javaJob.isRecommended).toBe(false)
  })

  it('does not block a PHP job when the resume has PHP', () => {
    const phpResume: Resume = {
      ...resume,
      rawText: 'PHP 后端开发经验。',
      structuredData: {
        ...resume.structuredData,
        skills: [...resume.structuredData.skills, 'PHP', 'Laravel'],
      },
    }
    const phpJob = computeLocalMatch(phpResume, createJob({
      id: 'php-backend',
      title: 'PHP 开发工程师',
      tags: ['PHP', 'Laravel', 'MySQL'],
      jobDescription: 'PHP开发工程师 PHP Laravel MySQL 3-5年 本科',
      requirements: {
        education: '本科',
        experienceYears: 3,
        skills: [
          { skill: 'PHP', required: true },
          { skill: 'Laravel', required: true },
        ],
        responsibilities: [],
        hardRequirements: [],
        niceToHave: [],
        salaryMin: null,
        salaryMax: null,
        source: 'local',
        parsedAt: '2026-07-26T00:00:00.000Z',
      },
    }))

    expect(phpJob.hardGate?.passed).toBe(true)
  })
})
