import { describe, it, expect } from 'vitest'
import {
  calculateResumeJobAffinity,
  selectBestResumeForJob,
  type ResumeRoutingResult,
} from '../src/shared/ai/resume-router'
import type { Resume } from '../src/shared/types/resume'

describe('Dynamic Resume Router (一人多面多版本简历智能动态路由)', () => {
  const frontendResume: Resume = {
    id: 'resume_fe',
    name: '资深前端工程师',
    fileName: 'resume_fe.pdf',
    fileType: 'pdf',
    fileData: new ArrayBuffer(0),
    rawText: '精通 React, Vue3, TypeScript, Webpack, Vite, 微前端, 前端性能优化, 前端架构',
    structuredData: {
      name: '张三',
      phone: '13800000001',
      email: 'zhangsan@test.com',
      city: '北京',
      yearsOfExperience: 6,
      education: [
        {
          school: '清华大学',
          degree: '本科',
          major: '软件工程',
          startDate: '2016',
          endDate: '2020',
        },
      ],
      workExperience: [
        {
          company: '某互联网科技',
          position: '前端负责人',
          startDate: '2020-07',
          endDate: '2024-03',
          description: '负责前端核心基建建设，推进微前端与跨端架构优化',
        },
      ],
      projects: [
        {
          name: '大型前端低代码平台',
          role: '前端架构师',
          startDate: '2022',
          endDate: '2023',
          description: '构建基于 React + TypeScript 的可视化拖拽低代码平台',
          technologies: ['React', 'TypeScript', 'Vite'],
        },
      ],
      skills: ['React', 'Vue', 'TypeScript', 'JavaScript', 'Webpack', '微前端', '性能优化'],
      summary: '6年前端资深开发经验，精通React/Vue及前端工程化架构',
    },
    aiAnalysis: null,
    isDefault: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }

  const aiAgentResume: Resume = {
    id: 'resume_ai',
    name: 'AI全栈架构师',
    fileName: 'resume_ai.pdf',
    fileType: 'pdf',
    fileData: new ArrayBuffer(0),
    rawText: '精通 Python, LangChain, 大模型, LLM, Agent, 智能体工程, Next.js, Docker, Kubernetes',
    structuredData: {
      name: '张三',
      phone: '13800000001',
      email: 'zhangsan@test.com',
      city: '北京',
      yearsOfExperience: 6,
      education: [
        {
          school: '清华大学',
          degree: '本科',
          major: '软件工程',
          startDate: '2016',
          endDate: '2020',
        },
      ],
      workExperience: [
        {
          company: 'AI 创新实验室',
          position: '大模型应用架构师',
          startDate: '2023-01',
          endDate: '2026-03',
          description: '主导企业级智能体 Agentic Workflow 落地与 LLM 微调部署',
        },
      ],
      projects: [
        {
          name: '企业级多智能体协同系统',
          role: '全栈架构师',
          startDate: '2024',
          endDate: '2025',
          description: '基于 Python + Next.js + LangChain 搭建自主任务规划系统',
          technologies: ['Python', 'LLM', 'Next.js', 'Docker', 'Agent'],
        },
      ],
      skills: ['Python', 'LLM', 'Agent', '智能体', '大模型', 'LangChain', 'Next.js', 'Docker'],
      summary: '全栈与 AI 智能体领域专家，专注于大模型应用落地与全栈架构',
    },
    aiAnalysis: null,
    isDefault: true,
    createdAt: '2026-01-02T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
  }

  it('calculates higher affinity for frontend resume on frontend position', () => {
    const job = {
      title: '高级前端开发工程师',
      jobDescription: '熟练掌握 React、Vue3、TypeScript，有微前端与组件库建设经验',
      tags: ['前端', 'React', 'Vue', 'TypeScript'],
    }

    const feScore = calculateResumeJobAffinity(frontendResume, job)
    const aiScore = calculateResumeJobAffinity(aiAgentResume, job)

    expect(feScore.score).toBeGreaterThan(aiScore.score)
    expect(feScore.titleScore).toBeGreaterThanOrEqual(30)
    expect(feScore.skillsScore).toBeGreaterThan(aiScore.skillsScore)
  })

  it('calculates higher affinity for AI fullstack resume on AI agent position', () => {
    const job = {
      title: 'AI智能体开发专家',
      jobDescription: '负责大模型 LLM 应用工程化、LangChain 智能体工作流设计，熟悉 Python 和 Next.js',
      tags: ['AI', '大模型', 'Python', 'LLM', 'Agent'],
    }

    const aiScore = calculateResumeJobAffinity(aiAgentResume, job)
    const feScore = calculateResumeJobAffinity(frontendResume, job)

    expect(aiScore.score).toBeGreaterThan(feScore.score)
    expect(aiScore.skillsScore).toBeGreaterThan(feScore.skillsScore)
  })

  it('selects best matching resume and provides transparent routing rationale', () => {
    const resumes = [frontendResume, aiAgentResume]

    // Route for frontend job
    const feJobResult = selectBestResumeForJob(
      {
        title: '资深前端架构师',
        jobDescription: '主导大型 Web 前端项目，深入掌握 React/Vue 工程化规范',
        tags: ['React', 'TypeScript', 'Webpack'],
      },
      resumes,
    )

    expect(feJobResult.selectedResume.id).toBe('resume_fe')
    expect(feJobResult.routingReason).toContain('资深前端工程师')
    expect(feJobResult.candidatesCount).toBe(2)
    expect(feJobResult.allScores[0].resumeId).toBe('resume_fe')

    // Route for AI job
    const aiJobResult = selectBestResumeForJob(
      {
        title: '大模型应用全栈工程师',
        jobDescription: '搭建企业级多智能体 Agent 平台，熟练使用 Python 及 Docker',
        tags: ['AI', 'Python', 'Docker', '大模型'],
      },
      resumes,
    )

    expect(aiJobResult.selectedResume.id).toBe('resume_ai')
    expect(aiJobResult.routingReason).toContain('AI全栈架构师')
    expect(aiJobResult.candidatesCount).toBe(2)
  })

  it('falls back gracefully to single resume when only one available', () => {
    const result = selectBestResumeForJob(
      { title: '后端开发工程师' },
      [frontendResume],
    )

    expect(result.selectedResume.id).toBe('resume_fe')
    expect(result.candidatesCount).toBe(1)
    expect(result.routingReason).toContain('仅配置单份简历')
  })
})
