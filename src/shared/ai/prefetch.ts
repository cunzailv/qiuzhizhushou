// 任务队列 AI 产出预取模块（筛岗 + 话术异步预取与队列缓存）

import { getCampaign, saveCampaign } from '../agent/queue-store'
import { matchResumeToJob } from './remote-matcher'
import { generateJobGreeting } from './greeting'
import type { Resume } from '../types/resume'
import type { JobCard } from '../types/job'
import { getPlatformById } from '../platform'
import { log, logWarn } from '../utils/logger'

const MOD = 'AIPrefetch'

let isPrefetching = false

/** 预取队列中接下来的 N 个任务的 AI 评分与个性化问候语 */
export async function prefetchNextTasksAI(resume: Resume, limit = 3): Promise<number> {
  if (isPrefetching) return 0
  isPrefetching = true

  try {
    const campaign = await getCampaign()
    if (!campaign || campaign.status !== 'running') return 0

    // 寻找需要预取 AI 产出的 pending 任务（未完成筛岗或未生成话术的）
    const candidates = campaign.tasks
      .filter((t) => t.status === 'pending' && (t.matchScore === undefined || !t.greeting))
      .slice(0, limit)

    if (candidates.length === 0) return 0

    let prefetchedCount = 0

    for (const task of candidates) {
      const adapter = getPlatformById(task.platform)
      if (!adapter) continue

      const mockJob: JobCard = {
        id: task.jobId,
        title: task.jobTitle,
        companyName: task.company,
        companyLogo: '',
        url: task.jobUrl,
        salary: task.salary || '',
        jobDescription: '',
        platformId: task.platform,
        location: '',
        experience: '',
        education: '',
        tags: [],
        bossName: '',
        bossTitle: '',
        bossOnline: false,
        publishedAt: '',
      }

      // 1. 如果尚未评分，进行 AI 匹配评分
      let matchResult: {
        score: number
        recommendation: string
        skillMatch: string[]
        skillGap: string[]
        isRecommended: boolean
      } = {
        score: task.matchScore ?? 75,
        recommendation: task.matchReason ?? '自动初筛符合',
        skillMatch: [],
        skillGap: [],
        isRecommended: true,
      }

      if (task.matchScore === undefined) {
        try {
          const match = await matchResumeToJob(resume, mockJob)
          task.matchScore = match.score
          task.matchReason = match.recommendation
          matchResult = match
        } catch (e) {
          logWarn(MOD, 'prefetchNextTasksAI', `Score failed for ${task.id}: ${e}`)
          task.matchScore = 65
          task.matchReason = '预评网络波动默认放行'
        }
      }

      // 2. 如果尚未生成话术，生成个性化问候语
      if (!task.greeting) {
        try {
          const greetingRes = await generateJobGreeting(resume, mockJob, matchResult as any, adapter)
          task.greeting = greetingRes.text
          task.aiCostTokens = (task.aiCostTokens || 0) + greetingRes.tokens
        } catch (e) {
          logWarn(MOD, 'prefetchNextTasksAI', `Greeting failed for ${task.id}: ${e}`)
          const candidateName = resume.structuredData?.name || '求职者'
          task.greeting = adapter.getJobSpecificGreeting(candidateName, mockJob, matchResult as any)
        }
      }

      prefetchedCount++
    }

    if (prefetchedCount > 0) {
      await saveCampaign(campaign)
      log(MOD, 'prefetchNextTasksAI', `Prefetched AI results for ${prefetchedCount} tasks`)
    }

    return prefetchedCount
  } finally {
    isPrefetching = false
  }
}
