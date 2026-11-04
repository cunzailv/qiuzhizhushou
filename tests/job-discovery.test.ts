import { describe, it, expect, beforeEach } from 'vitest'
import 'fake-indexeddb/auto'
import {
  extractSearchKeywords,
  getDiscoveryKeywordRotationIndex,
  advanceDiscoveryKeywordRotationIndex,
  getNextSearchKeyword,
  isQueueBelowThreshold,
  formatDiscoveryLogMessage,
} from '../src/shared/agent/job-discovery'
import type { Resume } from '../src/shared/types/resume'
import type { Campaign } from '../src/shared/agent/queue-store'

describe('Job Discovery & Auto Queue Feeder (待投队列全自主搜寻采集中枢)', () => {
  const sampleResume: Resume = {
    id: 'res_sample',
    name: '全栈架构师 (AI智能体方向)',
    fileName: 'resume.pdf',
    fileType: 'pdf',
    fileData: new ArrayBuffer(0),
    rawText: '精通 Python, Next.js, AI 智能体, Docker',
    structuredData: {
      name: '李四',
      phone: '13900000000',
      email: 'lisi@test.com',
      city: '上海',
      yearsOfExperience: 5,
      education: [],
      workExperience: [
        {
          company: '前沿智能科技',
          position: '资深全栈开发',
          startDate: '2021',
          endDate: '2024',
          description: '负责核心产品架构与微服务体系',
        },
      ],
      projects: [
        {
          name: '智能招聘中枢系统',
          role: '技术负责人',
          startDate: '2023',
          endDate: '2024',
          description: '研发多智能体协同流水线',
          technologies: ['Next.js', 'Python'],
        },
      ],
      skills: ['Python', 'Next.js', 'Docker', 'AI智能体'],
      summary: '5年全栈开发架构经验',
    },
    aiAnalysis: null,
    isDefault: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }

  it('extracts prioritized keywords from user filters and resume', () => {
    const filters = {
      jobTitles: '大模型工程师, AI Agent 架构师',
    } as any

    const keywords = extractSearchKeywords(sampleResume, undefined, filters)

    expect(keywords).toContain('大模型工程师')
    expect(keywords).toContain('AI Agent 架构师')
    expect(keywords).toContain('全栈架构师')
    expect(keywords).toContain('资深全栈开发')
    expect(keywords.length).toBeGreaterThanOrEqual(3)
  })

  it('falls back to default keywords when resume and filters are empty', () => {
    const keywords = extractSearchKeywords(null)
    expect(keywords.length).toBeGreaterThanOrEqual(1)
    expect(keywords).toContain('全栈工程师')
  })

  it('rotates keywords predictably across iterations', async () => {
    const total = 3
    const idx1 = await advanceDiscoveryKeywordRotationIndex(total)
    const idx2 = await advanceDiscoveryKeywordRotationIndex(total)
    const idx3 = await advanceDiscoveryKeywordRotationIndex(total)

    expect(idx2).toBe((idx1 + 1) % total)
    expect(idx3).toBe((idx2 + 1) % total)
  })

  it('detects when queue is below safe threshold (< 5)', () => {
    const dryCampaign: Campaign = {
      id: 'c_dry',
      status: 'running',
      startedAt: '2026-11-03',
      windows: [],
      quotas: {} as any,
      tasks: [
        { id: 't1', status: 'pending' },
        { id: 't2', status: 'pending' },
        { id: 't3', status: 'done' },
      ] as any,
      logs: [],
    }
    expect(isQueueBelowThreshold(dryCampaign, 5)).toBe(true)

    const healthyCampaign: Campaign = {
      ...dryCampaign,
      tasks: [
        { id: 't1', status: 'pending' },
        { id: 't2', status: 'pending' },
        { id: 't3', status: 'pending' },
        { id: 't4', status: 'pending' },
        { id: 't5', status: 'pending' },
        { id: 't6', status: 'pending' },
      ] as any,
    }
    expect(isQueueBelowThreshold(healthyCampaign, 5)).toBe(false)
  })

  it('formats discovery log messages properly', () => {
    const successMsg = formatDiscoveryLogMessage({
      keyword: '全栈工程师',
      platform: 'Boss直聘',
      discovered: 20,
      added: 8,
      pendingCount: 2,
    })
    expect(successMsg).toContain('Boss直聘')
    expect(successMsg).toContain('新增')
    expect(successMsg).toContain('8 个优质岗位')
    expect(successMsg).toContain('当前待投队列增至 10 个')

    const emptyMsg = formatDiscoveryLogMessage({
      keyword: '全栈工程师',
      platform: '猎聘',
      discovered: 0,
      added: 0,
      pendingCount: 2,
    })
    expect(emptyMsg).toContain('暂无更多未投递新增岗位')
  })
})
