// 系统感知与归纳引擎 (Perception & Induction Engine)
// 版本说明：早期实现用硬编码的「500+ JD / 回复率 +40%」伪装成统计结论，
// 现已全部移除。所有数值来自 buildReview 对真实投递记录的统计；
// 样本不足时明确标注「不构成统计结论」，不编造提升幅度。
//
// 职责：
// 1. 用真实投递结果生成可解释的策略方向建议（是否采纳由人决定）；
// 2. 把「某方向投递 N 次零回复」这类判断沉淀为 L3 经验记忆；
// 3. 经验带证据、可过期、可被用户驳回，供 Planner 下次规划时检索。

import type { EvolutionProposal } from '../../types/butler-evolution'
import { getAllApplications } from '../../db/application-store'
import { getCampaign } from '../queue-store'
import { listEvolutionProposals, saveEvolutionProposal } from '../../db/butler-evolution-store'
import { recordExperience } from '../../db/experience-store'
import { MIN_EXPERIENCE_SAMPLE } from '../../types/experience'
import { buildReview } from './review-planner'
import { log } from '../../utils/logger'

const MOD = 'InductionEngine'

interface StrategyDirection {
  type: EvolutionProposal['type']
  title: string
  badge: string
  observation: string
  recommendation: string
  diff: EvolutionProposal['diff']
}

const GUARDRAILS = [
  '严格遵守各平台每日配额上限（如 Boss 60/天），绝不冒进突击',
  '维持 45-180s 拟人随机延时，模拟真人阅读与点击节奏',
  '仅在允许的工作时段内运行，非时段静默休眠',
  '遇安全验证码 1 秒级安全挂起熔断，保护账号绝对安全',
]

/** 策略方向模板：只描述「可以考虑什么」，不含任何虚构的统计数字 */
const STRATEGY_DIRECTIONS: StrategyDirection[] = [
  {
    type: 'skill_keyword',
    title: '技术词进化：提炼「AI 智能体落地 / 全栈交付」高频热词',
    badge: '技术词学习',
    observation: '可优先突出你简历里确实具备的工程化能力词；是否带来回复率变化，需用你自己的投递数据验证。',
    recommendation:
      '建议将简历高光技能词升级为「AI智能体平台开发、Next.js/React全栈交付、大模型API工程化」，你是否同意填写并学习入画像？',
    diff: {
      before: '传统后端开发、接口设计、数据库运维',
      after: 'AI 智能体工程落地、Next.js 全栈交付、大模型工程化与高并发架构',
      targetField: 'skills',
    },
  },
  {
    type: 'strategic_pivot',
    title: '主攻方向跃迁：建议将主攻方向从「纯后端」转向「AI 全栈工程师」',
    badge: '方向跃迁',
    observation: '主攻方向是否需要拓展，应以近 14 天各岗位方向的实际回复率与面试转化为准。',
    recommendation:
      '建议我们将求职主攻方向从纯后端拓展跃迁为「AI全栈工程师」，在保留深厚后端架构底蕴的同时突出全栈交付能力。你是否同意并授权学习？',
    diff: {
      before: 'PHP后端工程师 后端开发 高级后端',
      after: '全栈工程师（AI 智能体方向） AI全栈开发 全栈专家',
      targetField: 'targetTitles',
    },
  },
  {
    type: 'greeting_upgrade',
    title: '话术进化：前置突出「独立从 0 到 1 闭环交付」案例',
    badge: '话术进化',
    observation: '首句是否更有效，需在同一岗位方向下用真实回复率做对比验证，不预设提升幅度。',
    recommendation:
      '建议打招呼首句强化闭环交付成果与即战力，直接呈现项目量化成效。是否同意升级？',
    diff: {
      before: '您好！我对贵司招聘的职位非常感兴趣，希望能有进一步沟通的机会。',
      after: '您好！我拥有 6 年架构经验，曾独立闭环交付 AI 智能体商业平台，技术栈与贵司要求高度吻合，能快速上手产出！',
      targetField: 'greetingTemplate',
    },
  },
]

/** 运行真实统计归纳，生成/更新策略方向建议，并沉淀 L3 经验 */
export async function runInductionAnalysis(): Promise<EvolutionProposal[]> {
  const allApps = await getAllApplications()
  const campaign = await getCampaign()
  const review = buildReview(allApps, { days: 14 })
  const currentProposals = await listEvolutionProposals('all')

  const queuedCount = campaign?.tasks?.length ?? 0
  const hasEnoughSamples = review.total >= MIN_EXPERIENCE_SAMPLE
  const zeroReplyTitles = review.byTitle.filter(
    (t) => t.count >= 3 && t.replyRate === 0,
  )

  const evidenceLine = hasEnoughSamples
    ? `基于近 14 天 ${review.total} 条真实投递记录：整体回复率 ${review.replyRate}%，其中 ${zeroReplyTitles.length} 个岗位方向存在 3+ 投递零回复；待投队列 ${queuedCount} 个。`
    : `当前仅 ${review.total} 条真实投递记录，样本不足 ${MIN_EXPERIENCE_SAMPLE} 条，不构成统计结论；待投队列 ${queuedCount} 个。`

  for (const pattern of STRATEGY_DIRECTIONS) {
    const existing = currentProposals.find((p) => p.title === pattern.title)
    if (existing) {
      // 已存在的待决提案：用最新真实统计刷新证据，不覆盖用户已做出的采纳/拒绝决策
      if (existing.status === 'pending') {
        existing.insight = `${evidenceLine}${pattern.observation}`
        existing.evidenceStats = {
          sampleSize: review.total,
          metricName: '近14天真实投递回复率',
          beforeValue: `${review.replyRate}%`,
          afterValue: '待验证',
          liftRate: '待验证',
        }
        await saveEvolutionProposal(existing)
      }
      continue
    }
    const proposal: EvolutionProposal = {
      id: `prop_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      type: pattern.type,
      title: pattern.title,
      categoryBadge: pattern.badge,
      insight: `${evidenceLine}${pattern.observation}`,
      evidenceStats: {
        sampleSize: review.total,
        metricName: '近14天真实投递回复率',
        beforeValue: `${review.replyRate}%`,
        afterValue: '待验证',
        liftRate: '待验证',
      },
      recommendation: pattern.recommendation,
      diff: pattern.diff,
      guardrails: [...GUARDRAILS],
      status: 'pending',
      createdAt: new Date().toISOString(),
    }
    await saveEvolutionProposal(proposal)
    currentProposals.unshift(proposal)
  }

  // L3 经验沉淀：只写有足够样本支撑的判断，样本不足一律不下结论
  for (const stat of zeroReplyTitles) {
    await recordExperience({
      pattern: `岗位名含 ${stat.title}`,
      verdict: 'avoid',
      sampleSize: stat.count,
      replyRate: stat.replyRate,
      evidenceIds: allApps
        .filter((app) => app.jobTitle === stat.title)
        .map((app) => app.id)
        .slice(0, 20),
      reason: `近 14 天该方向投递 ${stat.count} 次，回复率 0%`,
      source: 'review',
    })
  }

  log(
    MOD,
    'runInductionAnalysis',
    `Real-data induction completed: ${review.total} applications, ${currentProposals.length} proposals, ${zeroReplyTitles.length} zero-reply patterns.`,
  )
  return currentProposals
}
