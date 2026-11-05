// 管家日报与进化策略提案持久化存储层

import type {
  ButlerDailyReport,
  DailyReportConfig,
  EvolutionProposal,
} from '../types/butler-evolution'
import { DEFAULT_DAILY_REPORT_CONFIG } from '../types/butler-evolution'
import { getSetting, setSetting } from './settings-store'
import { logDecision } from './butler-store'
import { getCareerProfile, updateCareerProfile } from './career-store'
import { log } from '../utils/logger'

const MOD = 'ButlerEvolutionStore'

const KEY_DAILY_REPORTS = 'butler_daily_reports'
const KEY_REPORT_CONFIG = 'butler_daily_report_config'
const KEY_EVOLUTION_PROPOSALS = 'butler_evolution_proposals'

// ─── 1. 日报配置存储 ───

export async function getDailyReportConfig(): Promise<DailyReportConfig> {
  const cfg = await getSetting<DailyReportConfig>(KEY_REPORT_CONFIG, DEFAULT_DAILY_REPORT_CONFIG)
  return { ...DEFAULT_DAILY_REPORT_CONFIG, ...cfg }
}

export async function saveDailyReportConfig(
  partial: Partial<DailyReportConfig>,
): Promise<DailyReportConfig> {
  const current = await getDailyReportConfig()
  const updated: DailyReportConfig = { ...current, ...partial }
  await setSetting(KEY_REPORT_CONFIG, updated)
  return updated
}

// ─── 2. 管家日报存储 ───

export async function listDailyReports(limit = 14): Promise<ButlerDailyReport[]> {
  const reports = await getSetting<ButlerDailyReport[]>(KEY_DAILY_REPORTS, [])
  return (reports || []).slice(0, limit)
}

export async function getDailyReport(date?: string): Promise<ButlerDailyReport | null> {
  const targetDate = date || new Date().toISOString().slice(0, 10)
  const reports = await listDailyReports(30)
  return reports.find((r) => r.date === targetDate) || null
}

export async function saveDailyReport(report: ButlerDailyReport): Promise<void> {
  const existing = await listDailyReports(30)
  const filtered = existing.filter((r) => r.date !== report.date)
  const updated = [report, ...filtered].slice(0, 30) // 最多保留近 30 天
  await setSetting(KEY_DAILY_REPORTS, updated)

  // 记录最后生成日期
  await saveDailyReportConfig({ lastGeneratedDate: report.date })
  log(MOD, 'saveDailyReport', `Daily report for ${report.date} saved`)
}

// ─── 3. 进化提案存储与战略抉择 ───

/** 获取进化提案列表 */
export async function listEvolutionProposals(
  statusFilter: 'pending' | 'accepted' | 'rejected' | 'all' = 'all',
): Promise<EvolutionProposal[]> {
  let proposals = await getSetting<EvolutionProposal[]>(KEY_EVOLUTION_PROPOSALS, [])
  if (!proposals || proposals.length === 0) {
    proposals = await seedInitialProposals()
  }
  if (statusFilter === 'all') return proposals
  return proposals.filter((p) => p.status === statusFilter)
}

export async function saveEvolutionProposal(proposal: EvolutionProposal): Promise<void> {
  const list = await listEvolutionProposals('all')
  const filtered = list.filter((p) => p.id !== proposal.id)
  await setSetting(KEY_EVOLUTION_PROPOSALS, [proposal, ...filtered])
}

/**
 * 人做出战略抉择：同意并采纳提案（人机协同）
 * 系统在严格的安全护栏与拟人策略下克制地执行
 */
export async function acceptEvolutionProposal(
  proposalId: string,
  humanNote?: string,
): Promise<{ success: boolean; appliedChange: string }> {
  const list = await listEvolutionProposals('all')
  const target = list.find((p) => p.id === proposalId)
  if (!target) {
    return { success: false, appliedChange: '未找到指定提案' }
  }

  target.status = 'accepted'
  target.respondedAt = new Date().toISOString()
  target.humanDecisionNote = humanNote || '用户已同意战略采纳并写入自进化记忆'

  let appliedChange = ''

  // 1. 严格安全护栏约束下克制应用策略变更
  if (target.diff.targetField === 'skills') {
    // 技术词学习：将新技能词沉淀入用户技能画像
    const profile = await getCareerProfile()
    const newSkillTerms = target.diff.after.split(/[,，、/ ]+/).filter(Boolean)
    const existingNames = new Set((profile.skills || []).map((s) => s.name))
    const toAdd = newSkillTerms
      .filter((term) => !existingNames.has(term))
      .map((term) => ({ name: term, level: '熟练' as const }))
    const updatedSkills = [...(profile.skills || []), ...toAdd]
    await updateCareerProfile({ skills: updatedSkills })
    appliedChange = `已将「${target.diff.after}」增补写入职业画像技能库`
  } else if (target.diff.targetField === 'targetTitles') {
    // 战略方向跃迁：将新目标职位并入投递搜索偏好
    const applyFilters = (await getSetting<any>('applyFilters', {})) || {}
    const currentTitles = (applyFilters.jobTitles || '').split(/\s+/).filter(Boolean)
    const newTitles = target.diff.after.split(/[,，、/ ]+/).filter(Boolean)
    const combined = Array.from(new Set([...currentTitles, ...newTitles])).join(' ')
    applyFilters.jobTitles = combined
    await setSetting('applyFilters', applyFilters)
    appliedChange = `已将主攻岗位方向升级扩展为：「${combined}」`
  } else if (target.diff.targetField === 'greetingTemplate') {
    // 打招呼话术进化
    await setSetting('custom_greeting_template_highlight', target.diff.after)
    appliedChange = `已将打招呼提炼特征更新为：「${target.diff.after}」`
  }

  // 2. 战略抉择在 AI 决策中心终身留痕（确保人机协作透明可溯）
  await logDecision({
    source: 'butler_evolution',
    subject: `【用户战略采纳】${target.title}`,
    context: `依据洞察：${target.insight}。预期提升：${target.evidenceStats.liftRate}`,
    thinking: `用户授权同意变更：[${target.diff.before}] → [${target.diff.after}]。系统安全护栏保障：${target.guardrails.join('；')}`,
    decision: appliedChange,
  })

  // 3. 更新持久化
  await setSetting(KEY_EVOLUTION_PROPOSALS, list)
  log(MOD, 'acceptEvolutionProposal', `Proposal ${proposalId} accepted: ${appliedChange}`)

  return { success: true, appliedChange }
}

/** 人做出战略抉择：拒绝并保留现方案 */
export async function rejectEvolutionProposal(
  proposalId: string,
  humanNote?: string,
): Promise<void> {
  const list = await listEvolutionProposals('all')
  const target = list.find((p) => p.id === proposalId)
  if (!target) return

  target.status = 'rejected'
  target.respondedAt = new Date().toISOString()
  target.humanDecisionNote = humanNote || '用户选择保留现有策略方案'

  // 记录拒绝决策，系统尊重人的权威并不再私自变动
  await logDecision({
    source: 'butler_evolution',
    subject: `【用户保留原方案】${target.title}`,
    context: `洞察提议：${target.recommendation}`,
    thinking: '用户做出战略抉择，明确拒绝该建议。系统保持当前安全基线不变，绝不越界。',
    decision: '保留现有方案，维持原有技能与方向设置',
  })

  await setSetting(KEY_EVOLUTION_PROPOSALS, list)
  log(MOD, 'rejectEvolutionProposal', `Proposal ${proposalId} rejected`)
}

// ─── 4. 初始化种子洞察提案（感知与归纳的标杆范式） ───

async function seedInitialProposals(): Promise<EvolutionProposal[]> {
  const seeds: EvolutionProposal[] = [
    {
      id: 'prop_001_tech_words',
      type: 'skill_keyword',
      title: '技术词进化：提炼「AI 智能体落地 / 全栈交付」高频热词',
      categoryBadge: '技术词学习',
      insight:
        '策略方向建议：目前尚无足够的真实投递记录支撑统计结论，是否突出工程化能力词请用你自己的回复率数据验证。',
      evidenceStats: {
        sampleSize: 0,
        metricName: '近14天真实投递回复率',
        beforeValue: '暂无数据',
        afterValue: '待验证',
        liftRate: '待验证',
      },
      recommendation:
        '建议将简历高光技能词升级为「AI智能体平台开发、Next.js/React全栈交付、大模型API工程化」，你是否同意填写并学习入画像？',
      diff: {
        before: '传统后端开发、接口设计、数据库运维',
        after: 'AI 智能体工程落地、Next.js 全栈交付、大模型工程化与高并发架构',
        targetField: 'skills',
      },
      guardrails: [
        '严格遵守各平台每日配额上限（如 Boss 60/天），绝不冒进',
        '维持 45-180s 拟人随机延时，模拟真人阅读与点击',
        '仅在上午 09:00-11:30 与下午 14:00-17:30 工作时段投递',
        '遭遇验证码 1 秒级安全挂起熔断',
      ],
      status: 'pending',
      createdAt: new Date().toISOString(),
    },
    {
      id: 'prop_002_pivot_fullstack',
      type: 'strategic_pivot',
      title: '主攻方向跃迁：建议将主攻方向从「纯后端」转向「AI 全栈工程师」',
      categoryBadge: '方向跃迁',
      insight:
        '策略方向建议：主攻方向是否需要拓展，应以近 14 天各岗位方向的实际回复率与面试转化为准，当前样本不足，不预设提升幅度。',
      evidenceStats: {
        sampleSize: 0,
        metricName: '近14天真实投递回复率',
        beforeValue: '暂无数据',
        afterValue: '待验证',
        liftRate: '待验证',
      },
      recommendation:
        '建议我们将求职主攻方向从纯后端拓展跃迁为「AI全栈工程师」，在保留深厚后端架构底蕴的同时突出全栈交付能力。你是否同意并授权学习？',
      diff: {
        before: 'PHP后端工程师 后端开发 高级后端',
        after: '全栈工程师（AI 智能体方向） AI全栈开发 全栈专家',
        targetField: 'targetTitles',
      },
      guardrails: [
        '优先筛选与过往背景技能重合度高于 70% 的契合岗位',
        '绝不上浮超出实际技能经验的虚假描述，保持真实诚信底线',
        '每日多平台轮转分散，单平台单日不超限',
      ],
      status: 'pending',
      createdAt: new Date(Date.now() - 3600_000).toISOString(),
    },
    {
      id: 'prop_003_greeting_pitch',
      type: 'greeting_upgrade',
      title: '话术进化：前置突出「独立从 0 到 1 闭环交付」案例',
      categoryBadge: '话术进化',
      insight:
        '策略方向建议：首句是否更有效，需在同一岗位方向下用真实回复率做对比验证；当前样本不足，不预设提升幅度。',
      evidenceStats: {
        sampleSize: 0,
        metricName: '近14天真实投递回复率',
        beforeValue: '暂无数据',
        afterValue: '待验证',
        liftRate: '待验证',
      },
      recommendation:
        '建议打招呼首句强化闭环交付成果与即战力，直接呈现项目量化成效。是否同意升级？',
      diff: {
        before: '您好！我对贵司招聘的职位非常感兴趣，希望能有进一步沟通的机会。',
        after: '您好！我拥有 6 年架构经验，曾独立闭环交付 AI 智能体商业平台，技术栈与贵司要求高度吻合，能快速上手产出！',
        targetField: 'greetingTemplate',
      },
      guardrails: [
        '打招呼字数控制在 90 字以内，避免阅读疲劳',
        '每次沟通保持真人随机输入节奏',
      ],
      status: 'pending',
      createdAt: new Date(Date.now() - 7200_000).toISOString(),
    },
  ]

  await setSetting(KEY_EVOLUTION_PROPOSALS, seeds)
  return seeds
}
