// C2 · 复盘 Agent（B5 角色落地）
// 周期复盘：投递→沟通→面试→Offer 漏斗、岗位/平台命中率、策略建议；
// 结果回流 → 推荐权重校准建议（解决"越用越不准"）。
import type { Application } from '../../types/application'
import type { FunnelStats } from './butler-planner'

export interface TitleStat {
  title: string
  count: number
  replyRate: number
}

export interface ReviewResult {
  /** 复盘区间说明，如 "近 7 天" */
  period: string
  total: number
  funnel: FunnelStats
  replyRate: number
  byTitle: TitleStat[]
  suggestions: string[]
  /** 权重校准建议 */
  calibration: { suggested: boolean; message: string }
}

const REPLY_STATUSES = new Set(['read', 'communicating', 'interview', 'hired'])

function computeFunnel(applications: Application[]): FunnelStats {
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
  return funnel
}

/** 周复盘（默认近 14 天 / 2 周） */
export function buildReview(
  applications: Application[],
  options: { days?: number; now?: number } = {},
): ReviewResult {
  const days = options.days ?? 14
  const now = options.now ?? Date.now()
  const cutoff = now - days * 86400000

  const recent = applications.filter((app) => new Date(app.appliedAt).getTime() >= cutoff)
  const funnel = computeFunnel(recent)
  const replied = recent.filter((app) => REPLY_STATUSES.has(app.status)).length
  const replyRate = recent.length > 0 ? Math.round((replied / recent.length) * 100) : 0

  // 按岗位统计命中率
  const titleMap = new Map<string, { count: number; replied: number }>()
  for (const app of recent) {
    const key = app.jobTitle || '未知岗位'
    const entry = titleMap.get(key) ?? { count: 0, replied: 0 }
    entry.count += 1
    if (REPLY_STATUSES.has(app.status)) entry.replied += 1
    titleMap.set(key, entry)
  }
  const byTitle: TitleStat[] = Array.from(titleMap.entries())
    .map(([title, value]) => ({
      title,
      count: value.count,
      replyRate: value.count > 0 ? Math.round((value.replied / value.count) * 100) : 0,
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8)

  const suggestions: string[] = []
  if (recent.length === 0) {
    suggestions.push('近段时间暂无投递记录，建议启动一轮管家策略沟通。')
  } else {
    if (replyRate < 30) suggestions.push('整体回复率偏低：优先优化打招呼语与目标岗位筛选，减少广撒网。')
    else if (replyRate >= 60) suggestions.push('回复率健康，可适当提高每日配额、扩大目标范围。')

    const zeroReplyTitles = byTitle.filter((t) => t.count >= 3 && t.replyRate === 0).map((t) => t.title)
    if (zeroReplyTitles.length > 0) suggestions.push(`以下岗位方向 3+ 投递零回复，建议调整或降权：${zeroReplyTitles.slice(0, 3).join('、')}。`)

    if (funnel.interview === 0 && recent.length >= 10) suggestions.push('投递 10+ 仍无面试邀约：检查错位岗位占比，可降低期望薪资或收窄目标。')
  }

  // 权重校准：推荐层命中率明显偏低 → 建议降低匹配权重 / 提高偏好权重
  const scored = recent.filter((app) => app.matchScore != null)
  const recommended = scored.filter((app) => (app.matchScore ?? 0) >= 60)
  const recommendedReplied = recommended.filter((app) => REPLY_STATUSES.has(app.status)).length
  let calibration: ReviewResult['calibration'] = { suggested: false, message: '样本不足，暂不校准' }
  if (recommended.length >= 5) {
    const hitRate = recommendedReplied / recommended.length
    if (hitRate < 0.2) {
      calibration = {
        suggested: true,
        message: `推荐层（≥60 分）命中率仅 ${Math.round(hitRate * 100)}%，建议下调匹配权重、上调偏好/薪资权重，减少"高分但不对路"投递。`,
      }
    } else if (hitRate >= 0.5) {
      calibration = {
        suggested: true,
        message: `推荐层命中率 ${Math.round(hitRate * 100)}%，权重保持；可逐步提高每日配额。`,
      }
    } else {
      calibration = { suggested: true, message: `推荐层命中率 ${Math.round(hitRate * 100)}%，权重暂不调整，继续观察。` }
    }
  }

  return {
    period: `近 ${days / 7} 周（${days} 天）`,
    total: recent.length,
    funnel,
    replyRate,
    byTitle,
    suggestions,
    calibration,
  }
}
