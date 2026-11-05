import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  generateDailyButlerReport,
  getTodayDateStr,
} from '../src/shared/agent/butler/daily-report-generator'
import {
  getDailyReport,
  listDailyReports,
  getDailyReportConfig,
  saveDailyReportConfig,
  listEvolutionProposals,
  acceptEvolutionProposal,
  rejectEvolutionProposal,
} from '../src/shared/db/butler-evolution-store'
import { runInductionAnalysis } from '../src/shared/agent/butler/induction-engine'
import { getRecentDecisions } from '../src/shared/db/butler-store'
import { getCareerProfile } from '../src/shared/db/career-store'

// 模拟 chrome.storage.local 与 chrome.notifications
const mockStorage: Record<string, any> = {}

beforeEach(() => {
  for (const k of Object.keys(mockStorage)) {
    delete mockStorage[k]
  }

  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: vi.fn(async (keys: string | string[]) => {
          if (typeof keys === 'string') {
            return { [keys]: mockStorage[keys] }
          }
          const res: Record<string, any> = {}
          for (const k of keys) {
            res[k] = mockStorage[k]
          }
          return res
        }),
        set: vi.fn(async (obj: Record<string, any>) => {
          Object.assign(mockStorage, obj)
        }),
        remove: vi.fn(async (keys: string | string[]) => {
          const list = Array.isArray(keys) ? keys : [keys]
          for (const k of list) delete mockStorage[k]
        }),
      },
    },
    notifications: {
      create: vi.fn(),
    },
  })
})

describe('Butler Daily Review Report (管家日报)', () => {
  it('generates structured daily report with funnel, safety guardrails and next day plan', async () => {
    const today = getTodayDateStr()
    const report = await generateDailyButlerReport('scheduled', today)

    expect(report.id).toBe(`report_${today}`)
    expect(report.date).toBe(today)
    expect(report.trigger).toBe('scheduled')
    expect(report.summary).toBeDefined()
    expect(report.summary.length).toBeGreaterThan(10)

    // 验证漏斗数据结构
    expect(report.funnel).toBeDefined()
    expect(report.funnel).toHaveProperty('scanned')
    expect(report.funnel).toHaveProperty('filtered')
    expect(report.funnel).toHaveProperty('applied')
    expect(report.funnel).toHaveProperty('replyRate')

    // 验证安全护栏（Guardrails）与拟人保障指标
    expect(report.guardrailStatus).toBeDefined()
    expect(report.guardrailStatus.safetyScore).toBe(100)
    expect(report.guardrailStatus.intervalRange).toContain('秒')
    expect(report.guardrailStatus.captchaEncounters).toBe(0)
    expect(report.guardrailStatus.safeStatusText).toContain('100')

    // 验证平台细分、高光亮点与诊断
    expect(report.platformBreakdown).toBeDefined()
    expect(report.highlights.length).toBeGreaterThan(0)
    expect(report.diagnostics.length).toBeGreaterThan(0)

    // 验证明日作战指南
    expect(report.nextDayActionPlan.focusTitles.length).toBeGreaterThan(0)
    expect(report.nextDayActionPlan.recommendedHours).toBeDefined()
    expect(report.nextDayActionPlan.suggestedQuota).toBeGreaterThan(0)

    // 验证持久化存储与查询
    const saved = await getDailyReport(today)
    expect(saved?.id).toBe(report.id)

    const history = await listDailyReports()
    expect(history.length).toBeGreaterThanOrEqual(1)
  })

  it('saves and updates daily report schedule configuration', async () => {
    const initialConfig = await getDailyReportConfig()
    expect(initialConfig.autoGenerate).toBe(true)
    expect(initialConfig.scheduledTime).toBe('18:00')

    const updated = await saveDailyReportConfig({
      scheduledTime: '19:30',
      triggerOnCampaignFinished: true,
    })
    expect(updated.scheduledTime).toBe('19:30')
    expect(updated.triggerOnCampaignFinished).toBe(true)

    const reloaded = await getDailyReportConfig()
    expect(reloaded.scheduledTime).toBe('19:30')
  })
})

describe('Perception, Induction & Evolution Strategy Engine (感知、归纳与自进化闭环)', () => {
  it('runs induction on real application records and never fabricates lift rates', async () => {
    const proposals = await runInductionAnalysis()
    expect(proposals.length).toBeGreaterThanOrEqual(3)

    // 验证技术词进化提案：数据必须来自真实投递记录，不编造样本量与提升幅度
    const skillProp = proposals.find((p) => p.type === 'skill_keyword')
    expect(skillProp).toBeDefined()
    expect(skillProp?.insight).toContain('真实投递记录')
    expect(skillProp?.insight).not.toMatch(/5\d{2}\+/)
    expect(skillProp?.evidenceStats.liftRate).toBe('待验证')
    expect(skillProp?.evidenceStats.metricName).toContain('真实')
    expect(skillProp?.diff.before).toBeDefined()
    expect(skillProp?.diff.after).toContain('AI 智能体')

    // 验证主攻方向跃迁提案（从纯后端转向全栈）
    const pivotProp = proposals.find((p) => p.type === 'strategic_pivot')
    expect(pivotProp).toBeDefined()
    expect(pivotProp?.recommendation).toContain('从纯后端拓展跃迁为「AI全栈工程师」')
    expect(pivotProp?.diff.before).toContain('PHP后端工程师')
    expect(pivotProp?.diff.after).toContain('全栈工程师（AI 智能体方向）')

    // 验证安全护栏承诺（Guardrails）
    expect(pivotProp?.guardrails.length).toBeGreaterThan(0)
    expect(pivotProp?.guardrails.some((g) => g.includes('不超限') || g.includes('配额'))).toBe(true)
    expect(skillProp?.guardrails.some((g) => g.includes('配额上限'))).toBe(true)
  })

  it('empowers human strategic decision: accept and learn into career profile under guardrails', async () => {
    const proposals = await listEvolutionProposals('pending')
    const skillProp = proposals.find((p) => p.type === 'skill_keyword')
    expect(skillProp).toBeDefined()

    // 人做出战略抉择：同意并采纳
    const res = await acceptEvolutionProposal(skillProp!.id, '用户确认采纳此项技术词演进')
    expect(res.success).toBe(true)
    expect(res.appliedChange).toContain('职业画像技能库')

    // 验证状态变为 accepted
    const updatedList = await listEvolutionProposals('all')
    const updatedTarget = updatedList.find((p) => p.id === skillProp!.id)
    expect(updatedTarget?.status).toBe('accepted')
    expect(updatedTarget?.humanDecisionNote).toBe('用户确认采纳此项技术词演进')

    // 验证职业画像技能库成功增补
    const profile = await getCareerProfile()
    expect(profile.skills.some((s) => s.name.includes('AI 智能体') || s.name.includes('大模型'))).toBe(true)

    // 验证留痕中心完整记录了此项人机协同战略抉择
    const decisions = await getRecentDecisions(5)
    expect(decisions.some((d) => d.source === 'butler_evolution' && d.subject.includes('用户战略采纳'))).toBe(true)
  })

  it('empowers human strategic decision: reject and preserve current baseline', async () => {
    const proposals = await listEvolutionProposals('pending')
    const pivotProp = proposals.find((p) => p.type === 'strategic_pivot')
    expect(pivotProp).toBeDefined()

    // 人做出战略抉择：拒绝并保留现方案
    await rejectEvolutionProposal(pivotProp!.id, '用户决定暂不调整主攻方向，保持纯后端')

    const updatedList = await listEvolutionProposals('all')
    const updatedTarget = updatedList.find((p) => p.id === pivotProp!.id)
    expect(updatedTarget?.status).toBe('rejected')

    // 验证留痕记录了用户的拒绝与系统克制承诺
    const decisions = await getRecentDecisions(5)
    expect(decisions.some((d) => d.source === 'butler_evolution' && d.subject.includes('用户保留原方案'))).toBe(true)
  })
})
