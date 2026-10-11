// H4 · 反馈自进化：投递结果回流 → 沉淀提升方向
// 当投递状态更新为 rejected 时，把匹配理由/备注中的复盘结论
// 沉淀到职业画像 improvementDirections（与差距报告同源，后台职业看板可见）。
// 正反馈（interview/hired）不产生方向，但会通过 learnFromApplication
// 更新公司记忆的 lastOutcome（已有链路）。

import { addImprovementDirection, getCareerProfile } from '../db/career-store'
import type { Application, ApplicationStatus } from '../types/application'

const NEGATIVE_STATUSES: ApplicationStatus[] = ['rejected']

/** 从一条投递的反馈结果中提取可学习的复盘要点 */
export function extractFeedbackInsight(app: Pick<Application, 'jobTitle' | 'companyName' | 'matchReason' | 'notes'>): string | null {
  const parts = [app.matchReason, app.notes].map((s) => (s || '').trim()).filter(Boolean)
  if (parts.length === 0) return null
  const joined = parts.join('；')
  if (joined.length < 4) return null
  return `投递「${app.jobTitle} @ ${app.companyName}」未通过后的复盘：${joined.slice(0, 80)}`
}

/**
 * 投递结果回流入口：状态变为负面时沉淀一条提升方向（去重）。
 * 返回是否产生了新的提升方向。
 */
export async function evolveFromApplication(
  app: Pick<Application, 'id' | 'jobTitle' | 'companyName' | 'matchReason' | 'notes'>,
  newStatus: ApplicationStatus,
): Promise<boolean> {
  if (!NEGATIVE_STATUSES.includes(newStatus)) return false
  const insight = extractFeedbackInsight(app)
  if (!insight) return false
  const profile = await getCareerProfile()
  const exists = profile.improvementDirections.some((d) => d.reason === `来自投递反馈：${insight}`)
  if (exists) return false
  await addImprovementDirection({
    skill: app.jobTitle.slice(0, 20),
    reason: `来自投递反馈：${insight}`,
    suggestedAction: '复盘该岗位失败原因，补齐对应项目/经历后再战同类岗位',
  })
  return true
}
