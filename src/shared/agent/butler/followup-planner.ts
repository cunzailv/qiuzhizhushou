// B4 · 跟进 Agent
// 定时扫描投递状态：N 天未回复 → 生成跟进话术草稿（建议 + 确认，不自动发送）。
import type { Application } from '../../types/application'
import type { CompanyMemory, FollowUpSuggestion } from '../../types/butler'

/** 需要跟进的投递状态：仍停留在"已投递/已读/沟通中"且超时未推进 */
const FOLLOW_UP_STATUSES = new Set(['applied', 'read', 'communicating'])

export interface FollowUpCandidate {
  app: Application
  daysSince: number
}

/** 计算距投递天数（按天取整） */
export function daysSinceApplied(appliedAt: string, now = Date.now()): number {
  const at = new Date(appliedAt).getTime()
  if (Number.isNaN(at)) return 0
  return Math.max(0, Math.floor((now - at) / 86400000))
}

/** 生成跟进话术草稿（模板，含公司/岗位；不自动发送） */
export function generateFollowUpMessage(app: Application, memory?: CompanyMemory): string {
  const replyHint =
    memory && memory.touchCount > 0
      ? `（该公司历史回复率 ${Math.round((memory.replyCount / memory.touchCount) * 100)}%）`
      : ''
  return `您好，之前看到贵司（${app.companyName}）在招“${app.jobTitle}”，我投递了简历，也想进一步了解岗位细节。${replyHint}方便的话期待您的回复，谢谢！`
}

/** B4 跟进 Agent：扫描应用列表，找出需要跟进的投递（阈值可配） */
export function scanFollowUps(
  applications: Application[],
  options: { days?: number; now?: number } = {},
): FollowUpCandidate[] {
  const days = options.days ?? 2
  const now = options.now ?? Date.now()
  return applications
    .filter((app) => FOLLOW_UP_STATUSES.has(app.status))
    .map((app) => ({ app, daysSince: daysSinceApplied(app.appliedAt, now) }))
    .filter(({ daysSince }) => daysSince >= days)
    .sort((a, b) => b.daysSince - a.daysSince)
}

/** 生成跟进建议记录（B4 产出，供 popup 展示/background 通知） */
export function buildFollowUpSuggestions(
  applications: Application[],
  memories: Map<string, CompanyMemory>,
  options: { days?: number; now?: number } = {},
): Omit<FollowUpSuggestion, 'id' | 'createdAt' | 'dismissed'>[] {
  return scanFollowUps(applications, options).map(({ app, daysSince }) => ({
    applicationId: app.id,
    companyName: app.companyName,
    jobTitle: app.jobTitle,
    daysSince,
    status: app.status,
    draftMessage: generateFollowUpMessage(app, memories.get(app.companyName)),
  }))
}
