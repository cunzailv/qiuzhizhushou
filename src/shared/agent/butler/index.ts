// B 层 · 求职管家 Agent 总入口
// butlerRunDaily：B1 策略 → B4 跟进扫描 → B6 记忆回流 → 决策留痕 → 汇总。
import { getAllApplications } from '../../db/application-store'
import { getCompanyMemory, logDecision, saveFollowUps, clearFollowUpsFor } from '../../db/butler-store'
import { buildStrategy, buildDailyReport, DEFAULT_DAILY_QUOTA } from './butler-planner'
import { buildFollowUpSuggestions } from './followup-planner'
import type { ButlerScanResult, UserJobProfile } from '../../types/butler'
import type { CompanyMemory } from '../../types/butler'

/** 每日管家扫描（background 定时任务 / popup 手动触发共用） */
export async function butlerRunDaily(
  profile: UserJobProfile = {},
  options: { days?: number; now?: number } = {},
): Promise<ButlerScanResult> {
  const strategy = buildStrategy({ ...profile, dailyQuota: profile.dailyQuota ?? DEFAULT_DAILY_QUOTA })
  const applications = await getAllApplications()

  // B6：记忆加载（公司→记忆）
  const memories = new Map<string, CompanyMemory>()
  for (const app of applications) {
    if (!app.companyName) continue
    const memory = await getCompanyMemory(app.companyName, app.jobTitle)
    if (memory) memories.set(app.companyName, memory)
  }

  // B4：跟进扫描 → 入库（同岗位历史建议先清理，避免堆积）
  const suggestions = buildFollowUpSuggestions(applications, memories, options)
  for (const suggestion of suggestions) {
    await clearFollowUpsFor(suggestion.applicationId)
  }
  const saved = suggestions.length > 0 ? await saveFollowUps(suggestions) : []

  // B1：日报
  const report = buildDailyReport(applications, saved, strategy)

  // 留痕
  await logDecision({
    source: 'butler',
    subject: '每日管家扫描',
    context: `应用 ${applications.length} 条，跟进候选 ${suggestions.length} 条`,
    thinking: '规则扫描：投递状态未推进且超时 → 生成跟进建议；日报统计漏斗与建议',
    decision: JSON.stringify({ reportSummary: report.summary, followUps: saved.length }),
  })

  return {
    scannedAt: new Date().toISOString(),
    followUps: saved,
    reportSummary: report.summary,
    decisionLogged: true,
  }
}

export { buildStrategy, planDailySchedule, buildDailyReport } from './butler-planner'
export { evaluateJobWorth, selectTopJobs, TIER_LABELS, SELECTOR_WEIGHTS, TIER_THRESHOLDS } from './job-selector'
export { generatePersonalizedGreeting, respondToQuestion, matchQuestionType } from './chat'
export { scanFollowUps, generateFollowUpMessage, daysSinceApplied } from './followup-planner'
export { learnFromApplication, logDecision, getActiveFollowUps, dismissFollowUp, getRecentDecisions } from '../../db/butler-store'
export { getCompanyMemory } from '../../db/butler-store'
export type { ButlerScanResult, ButlerStrategy, JobEvaluation, FollowUpSuggestion, UserJobProfile } from '../../types/butler'
