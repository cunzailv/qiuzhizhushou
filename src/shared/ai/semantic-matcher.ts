import { chatCompletion } from './api-client'
import { computeLocalMatch } from './local-matcher'
import type { Resume } from '../types/resume'
import type { JobCard, MatchResult, MatchDimensions } from '../types/job'

const SYSTEM_PROMPT = `你是专业的招聘匹配分析师。将求职者简历与招聘岗位做语义匹配分析。

按以下维度打分（满分合计100）：
- skills（0-45）：技能/工具/领域的语义匹配度，包含同义词（如"用户增长"≈"增长"、"React开发"≈"前端"）
- similarity（0-15）：文本/背景整体相似度
- direction（0-20）：求职方向与岗位方向一致性
- experience（0-12）：工作年限与岗位年限要求对齐度
- education（0-8）：学历与岗位学历要求对齐度

判断硬门槛：若学历或年限明显不达标，score 不得超过 45 并说明。

只输出JSON（不要markdown包裹）：
{"score":数字,"dimensions":{"skills":0,"similarity":0,"direction":0,"experience":0,"education":0},"skillMatch":["..."],"skillGap":["..."],"recommendation":"100字内分析","isRecommended":true}`

/**
 * A3: AI 语义精评。
 * 前置：本地初筛（computeLocalMatch）+ 硬门槛检查；硬门槛不过直接返回本地结果，不浪费 AI 调用。
 * 策略：本地打分兜底 + AI 语义评分（含同义词/方向/经验学历对齐），AI 不可用时回退本地。
 */
export async function matchWithSemanticAI(resume: Resume, job: JobCard): Promise<MatchResult> {
  const local = computeLocalMatch(resume, job)

  // 硬门槛不满足：直接用本地结果（含拦截原因），跳过 AI
  if (local.hardGate && !local.hardGate.passed) {
    return local
  }

  const userMessage = `【求职者简历】
姓名: ${resume.structuredData.name || '未知'}
工作年限: ${resume.structuredData.yearsOfExperience || resume.profile?.yearsOfExperience || '未知'}年
工作经验: ${resume.structuredData.workExperience.map((w) => `${w.position}@${w.company}`).join(', ') || '无'}
技能: ${resume.structuredData.skills.join(', ') || '未识别'}
项目: ${resume.structuredData.projects.map((p) => `${p.name}: ${p.description.substring(0, 120)}`).join('; ') || '无'}
学历: ${resume.structuredData.education.map((e) => `${e.school} ${e.degree} ${e.major}`).join('; ') || '未知'}
简历画像: ${resume.profile?.profile || resume.structuredData.summary.substring(0, 300)}

【招聘岗位】
公司: ${job.companyName}
岗位: ${job.title}
薪资: ${job.salary}
地点: ${job.location}
经验要求: ${job.experience}（下限${job.requirements?.experienceYears ?? '未知'}年）
学历要求: ${job.requirements?.education || job.education || '未知'}
标签: ${job.tags.join(', ')}
岗位描述: ${job.jobDescription.substring(0, 1200)}

请按 Agent 思维流程分析匹配度并输出 JSON。`

  const result = await chatCompletion(SYSTEM_PROMPT, userMessage, 0.2)
  if (!result) return local

  try {
    const jsonStr = result.match(/\{[\s\S]*\}/)?.[0]
    if (!jsonStr) return local
    const parsed = JSON.parse(jsonStr)

    const rawScore = Number(parsed.score)
    const score = Number.isFinite(rawScore) ? Math.max(0, Math.min(100, Math.round(rawScore))) : local.score

    let dimensions: MatchDimensions | undefined
    if (parsed.dimensions && typeof parsed.dimensions === 'object') {
      const d = parsed.dimensions
      const num = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)
      dimensions = {
        skills: num(d.skills, local.dimensions?.skills ?? 0),
        similarity: num(d.similarity, local.dimensions?.similarity ?? 0),
        direction: num(d.direction, local.dimensions?.direction ?? 0),
        experience: num(d.experience, local.dimensions?.experience ?? 0),
        education: num(d.education, local.dimensions?.education ?? 0),
      }
    }

    return {
      jobId: job.id,
      score,
      skillMatch: Array.isArray(parsed.skillMatch) ? parsed.skillMatch.filter((s: unknown) => typeof s === 'string').slice(0, 10) : local.skillMatch,
      skillGap: Array.isArray(parsed.skillGap) ? parsed.skillGap.filter((s: unknown) => typeof s === 'string').slice(0, 8) : local.skillGap,
      recommendation: typeof parsed.recommendation === 'string' && parsed.recommendation ? parsed.recommendation.slice(0, 200) : local.recommendation,
      isRecommended: typeof parsed.isRecommended === 'boolean' ? parsed.isRecommended : score >= 60,
      hardGate: local.hardGate,
      dimensions,
    }
  } catch {
    console.error('Failed to parse AI semantic match')
    return local
  }
}
