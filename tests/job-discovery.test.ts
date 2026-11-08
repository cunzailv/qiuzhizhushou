import { describe, it, expect, beforeEach } from 'vitest'
import 'fake-indexeddb/auto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  extractSearchKeywords,
  isGenericNoiseKeyword,
  getDiscoveryKeywordRotationIndex,
  advanceDiscoveryKeywordRotationIndex,
  getNextSearchKeyword,
  isQueueBelowThreshold,
  formatDiscoveryLogMessage,
} from '../src/shared/agent/job-discovery'
import type { Resume } from '../src/shared/types/resume'
import type { Campaign } from '../src/shared/agent/queue-store'

const ROOT = process.cwd()
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf-8')

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

  it('returns no keywords instead of guessing unrelated roles (front-end / full-stack)', () => {
    // 旧版硬编码兜底 ['全栈工程师', '前端开发工程师', ...] 会让 PHP 后端用户
    // 真的去搜前端岗位并投递。没有可信来源时必须返回空，由调度层提示用户填写。
    const keywords = extractSearchKeywords(null)
    expect(keywords).toEqual([])
    expect(keywords).not.toContain('前端开发工程师')
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

  describe('岗位名称 → 搜索词（用户实际填法回归）', () => {
    const userTyped = 'php开发 后端开发 AI 全栈开发'

    it('空格填法：保留可搜短词，但不再产出孤立的「AI」去乱搜', () => {
      const keywords = extractSearchKeywords(null, undefined, { jobTitles: userTyped } as any)
      expect(keywords).toContain('php开发')
      expect(keywords).toContain('后端开发')
      expect(keywords).toContain('全栈开发')
      expect(keywords).not.toContain('AI')
      expect(isGenericNoiseKeyword('AI')).toBe(true)
    })

    it('空格填法：把「AI 全栈开发」补成一次精准组合搜索', () => {
      const keywords = extractSearchKeywords(null, undefined, { jobTitles: userTyped } as any)
      expect(keywords).toContain('AI 全栈开发')
      expect(isGenericNoiseKeyword('AI 全栈开发')).toBe(false)
    })

    it('推荐填法（逗号分隔）：每个岗位名整体成为一个搜索词', () => {
      const keywords = extractSearchKeywords(null, undefined, {
        jobTitles: 'php开发, 后端开发, AI 全栈开发',
      } as any)
      expect(keywords).toContain('php开发')
      expect(keywords).toContain('后端开发')
      expect(keywords).toContain('AI 全栈开发')
      expect(keywords).not.toContain('AI')
    })

    it('PHP / Java / Laravel / AI开发 等真实职位词不被泛词规则误杀', () => {
      const keywords = extractSearchKeywords(null, undefined, {
        jobTitles: 'PHP开发, Laravel, Java后端, AI开发',
      } as any)
      expect(keywords).toContain('PHP开发')
      expect(keywords).toContain('Laravel')
      expect(keywords).toContain('Java后端')
      expect(keywords).toContain('AI开发')
    })

    it('简历工作经历里拆出的孤立「AI」同样被清掉', () => {
      const resume = {
        ...sampleResume,
        structuredData: {
          ...sampleResume.structuredData,
          workExperience: [
            { company: '某公司', position: 'AI', startDate: '2024', endDate: '2025', description: '' },
          ],
        },
      } as any as Resume
      const keywords = extractSearchKeywords(resume, undefined, { jobTitles: '' } as any)
      expect(keywords).not.toContain('AI')
    })

    it('启动时把解析出的搜索词写进行为日志，且真的带词去导航（静态契约）', () => {
      const svc = read('src/background/campaign-service.ts')
      expect(svc).toContain('🔎 已读取岗位名称')
      expect(svc).toContain('extractSearchKeywords(startResume, undefined, startFilters)')
      expect(svc).toContain('ensurePlatformTab(platform, primaryCareerKeyword, currentPage)')
      expect(svc).toContain('🔍 本轮搜索词')
    })

    it('界面提示与后台一致：多个岗位名用逗号或顿号分隔', () => {
      const panel = read('src/popup/components/FilterPanel.tsx')
      expect(panel).toContain('多个岗位名请用逗号或顿号分隔')
      expect(panel).toContain('php开发, 后端开发, AI 全栈开发')
    })
  })
})
