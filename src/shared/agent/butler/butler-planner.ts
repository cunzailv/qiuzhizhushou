// B1 · 求职管家 Agent（总协调）
// 理解用户目标 → 制定投递策略（配额分配、岗位/平台优先级）→ 编排 B2 选岗 → 日报。
// 本地确定性计算 + 可选 AI 文案；策略可解释、留痕。
import type { Application } from '../../types/application'
import type { ButlerStrategy, FollowUpSuggestion, JobEvaluation, UserJobProfile } from '../../types/butler'
import { TIER_LABELS } from './job-selector'

export const DEFAULT_DAILY_QUOTA = 20
export const DEFAULT_FOLLOW_UP_DAYS = 2

/** 从设置/画像构建管家今日策略（B1） */
export function buildStrategy(profile: UserJobProfile): ButlerStrategy {
  const dailyQuota = profile.dailyQuota && profile.dailyQuota > 0 ? profile.dailyQuota : DEFAULT_DAILY_QUOTA
  const targetTitles = profile.targetTitles ?? []
  const targetCities = profile.targetCities ?? []
  const priorities: string[] = []
  if (targetTitles.length > 0) {
    priorities.push(`优先岗位：${targetTitles.slice(0, 5).join('、')}`)
  }
  if (targetCities.length > 0) {
    priorities.push(`目标城市：${targetCities.slice(0, 5).join('、')}`)
  }
  if (profile.salaryMin || profile.salaryMax) {
    priorities.push(`期望薪资：${profile.salaryMin ?? '不限'}K - ${profile.salaryMax ?? '不限'}K/月`)
  }
  priorities.push(`每日配额：${dailyQuota} 个岗位（推荐层优先，观望层补充）`)
  priorities.push('分层原则：推荐投递 → 观望 → 错位不投；硬门槛未过一律不投')

  const summary =
    `今日目标沟通 ${dailyQuota} 个岗位，聚焦「${targetTitles.slice(0, 3).join('、') || '不限岗位'}」` +
    (targetCities.length > 0 ? `、城市「${targetCities.slice(0, 3).join('、')}」` : '') +
    '，推荐层优先，AI 辅助解释、人工确认后执行。'

  return {
    dailyQuota,
    targetTitles,
    targetCities,
    priorities,
    summary,
    createdAt: new Date().toISOString(),
  }
}

/** 从选岗结果编排今日沟通计划：推荐层优先，配额不足时用观望层补位（B1 调度） */
export function planDailySchedule(evaluations: JobEvaluation[], dailyQuota: number): JobEvaluation[] {
  const sorted = [...evaluations].sort((a, b) => b.worthScore - a.worthScore)
  const plan: JobEvaluation[] = []
  const quota = Math.max(1, dailyQuota)
  for (const evaluation of sorted) {
    if (plan.length >= quota) break
    if (evaluation.tier === 'recommend' || (evaluation.tier === 'watch' && plan.filter((e) => e.tier === 'recommend').length >= Math.ceil(quota * 0.6))) {
      plan.push(evaluation)
    }
  }
  return plan.slice(0, quota)
}

/** 投递漏斗统计 */
export interface FunnelStats {
  total: number
  read: number
  communicating: number
  interview: number
  hired: number
  rejected: number
  pending: number
}

/** 日报：投递漏斗 + 跟进建议 + 策略建议（B1 产出，AI 可选润色） */
export function buildDailyReport(
  applications: Application[],
  followUps: FollowUpSuggestion[],
  strategy: ButlerStrategy,
): { funnel: FunnelStats; suggestions: string[]; summary: string } {
  const funnel: FunnelStats = {
    total: applications.length,
    read: 0,
    communicating: 0,
    interview: 0,
    hired: 0,
    rejected: 0,
    pending: 0,
  }
  for (const app of applications) {
    switch (app.status) {
      case 'read': funnel.read += 1; break
      case 'communicating': funnel.communicating += 1; break
      case 'interview': funnel.interview += 1; break
      case 'hired': funnel.hired += 1; break
      case 'rejected': funnel.rejected += 1; break
      default: funnel.pending += 1
    }
  }

  const suggestions: string[] = []
  if (funnel.total === 0) {
    suggestions.push('今天还没有投递记录，建议按管家策略开始第一轮沟通。')
  } else {
    const replyRate = funnel.total > 0 ? Math.round(((funnel.read + funnel.communicating + funnel.interview + funnel.hired) / funnel.total) * 100) : 0
    suggestions.push(`当前回复率约 ${replyRate}%${replyRate < 30 ? '，偏低：建议优化打招呼语与目标岗位筛选' : '，健康' }。`)
    if (funnel.interview === 0 && funnel.total >= 10) {
      suggestions.push('投递 10+ 暂无面试邀约：检查错位岗位占比，缩小目标范围或调整期望薪资。')
    }
  }
  if (followUps.length > 0) {
    suggestions.push(`${followUps.length} 条跟进建议待处理：投递后 2 天未回复可温和跟进一次。`)
  }
  suggestions.push(`今日策略：${strategy.summary}`)

  const summary = `今日共投递 ${funnel.total} 个岗位，${funnel.read} 已读、${funnel.communicating} 沟通中、${funnel.interview} 面试、${funnel.hired} 录用、${funnel.rejected} 未通过。${suggestions.join('')}`

  return { funnel, suggestions, summary }
}

export { TIER_LABELS }
