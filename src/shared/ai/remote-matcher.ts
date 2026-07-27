import { chatCompletion } from './api-client'
import { computeLocalMatch } from './local-matcher'
import type { Resume } from '../types/resume'
import type { JobCard, MatchResult } from '../types/job'
import { getSetting } from '../db/settings-store'

export async function matchResumeToJob(resume: Resume, job: JobCard): Promise<MatchResult> {
  const aiEnabled = await getSetting<boolean>('aiEnabled', false)

  if (aiEnabled) {
    return matchWithAI(resume, job)
  }
  return computeLocalMatch(resume, job)
}

async function matchWithAI(resume: Resume, job: JobCard): Promise<MatchResult> {
  const systemPrompt = `你是一个专业的招聘匹配分析师。你的任务是将求职者的简历与招聘岗位进行匹配分析。

请严格按照以下JSON格式返回分析结果，不要返回任何其他内容：
{
  "score": 0-100的匹配分数,
  "skillMatch": ["匹配的技能1", "匹配的技能2"],
  "skillGap": ["缺失的技能1", "缺失的技能2"],
  "recommendation": "详细的匹配分析和沟通建议（100字以内）",
  "isRecommended": true或false（分数>=70为true）
}`

  const userMessage = `【求职者简历】
姓名: ${resume.structuredData.name || '未知'}
工作经验: ${resume.structuredData.workExperience.map((w) => `${w.position}@${w.company}`).join(', ') || '无'}
技能: ${resume.structuredData.skills.join(', ') || '未识别'}
学历: ${resume.structuredData.education.map((e) => `${e.school} ${e.degree} ${e.major}`).join('; ') || '未知'}
简历概述: ${resume.structuredData.summary.substring(0, 800)}

【招聘岗位】
公司: ${job.companyName}
岗位: ${job.title}
薪资: ${job.salary}
地点: ${job.location}
要求: ${job.experience} / ${job.education}
标签: ${job.tags.join(', ')}
岗位描述: ${job.jobDescription.substring(0, 1000)}

请分析匹配度并返回JSON结果。`

  const result = await chatCompletion(systemPrompt, userMessage, 0.3)

  if (!result) {
    // Fallback to local matching
    return computeLocalMatch(resume, job)
  }

  try {
    // Try to extract JSON from the response
    const jsonMatch = result.match(/\{[\s\S]*\}/)
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0])
      return {
        jobId: job.id,
        score: parsed.score || 50,
        skillMatch: parsed.skillMatch || [],
        skillGap: parsed.skillGap || [],
        recommendation: parsed.recommendation || '请参考匹配分数',
        isRecommended: parsed.isRecommended !== false,
      }
    }
  } catch {
    console.error('Failed to parse AI response')
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

    // Rate limiting for AI mode: 1 request per 2 seconds
    if (aiEnabled && processed < jobs.length) {
      await new Promise((r) => setTimeout(r, 2000))
    }
  }

  return results
}
