import { computeLocalMatch } from './local-matcher'
import { matchWithSemanticAI } from './semantic-matcher'
import type { Resume } from '../types/resume'
import type { JobCard, MatchResult } from '../types/job'
import { getSetting } from '../db/settings-store'

/**
 * A3: 匹配入口 = 本地初筛（含硬门槛）→ AI 语义精评（可选）。
 * aiEnabled 时：本地先跑（快），硬门槛不满足直接返回本地结果；达标再交给 AI 语义精评。
 */
export async function matchResumeToJob(resume: Resume, job: JobCard): Promise<MatchResult> {
  const aiEnabled = await getSetting<boolean>('aiEnabled', false)

  if (aiEnabled) {
    return matchWithSemanticAI(resume, job)
  }
  return computeLocalMatch(resume, job)
}

export async function batchMatchJobs(resume: Resume, jobs: JobCard[]): Promise<Map<string, MatchResult>> {
  const results = new Map<string, MatchResult>()
  const aiEnabled = await getSetting<boolean>('aiEnabled', false)

  let processed = 0
  for (const job of jobs) {
    const result = await matchResumeToJob(resume, job)
    results.set(job.id, result)
    processed++

    // AI 模式限速：每请求间隔 2s（防风控）
    if (aiEnabled && processed < jobs.length) {
      await new Promise((r) => setTimeout(r, 2000))
    }
  }

  return results
}
