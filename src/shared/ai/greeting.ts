// AI 个性化打招呼语生成（支持 LLM 定制、超时熔断与模板降级兜底）

import { chatCompletion } from './api-client'
import { isAiBudgetExhausted } from './ai-budget'
import type { Resume } from '../types/resume'
import type { JobCard, MatchResult } from '../types/job'
import type { PlatformAdapter } from '../platform/types'
import { log, logWarn } from '../utils/logger'

const MOD = 'AIGreeting'

export interface GreetingGenerationResult {
  text: string
  tokens: number
  source: 'ai' | 'fallback_template'
}

/** 为指定岗位生成个性化打招呼语 */
export async function generateJobGreeting(
  resume: Resume,
  job: JobCard,
  match: MatchResult,
  adapter: PlatformAdapter,
  timeoutMs = 15_000,
): Promise<GreetingGenerationResult> {
  const candidateName = resume.structuredData?.name || '求职者'
  const fallbackGreeting = adapter.getJobSpecificGreeting(candidateName, job, match)

  // 1. 检查 AI 预算与是否开启
  const budgetExhausted = await isAiBudgetExhausted()
  if (budgetExhausted) {
    log(MOD, 'generateJobGreeting', 'AI budget exhausted, using template fallback')
    return { text: fallbackGreeting, tokens: 0, source: 'fallback_template' }
  }

  // 2. 准备 prompt
  const skills = (resume.structuredData?.skills || []).slice(0, 8).join('、')
  const jobTitle = job.title
  const company = job.companyName
  const jdExcerpt = (job.jobDescription || job.tags?.join(' ') || '').slice(0, 300)
  const matchedPoints = (match.skillMatch || []).slice(0, 3).join('、')

  const systemPrompt = `你是一名专业的职场沟通助手。你需要为求职者生成一段简短、礼貌、专业且打动 HR 的沟通开场白（打招呼语）。
要求：
1. 语言自然亲切，突出候选人与该岗位的核心匹配优势，字数严格控制在 60 到 100 字以内。
2. 严禁使用浮夸、油腻或明显的 AI 模版套话（例如“展信佳”、“惊悉贵司”等）。
3. 只输出开场白正文，不要包含任何多余的解释、标点引号或格式说明。`

  const userPrompt = `【候选人画像】
姓名：${candidateName}
擅长技能：${skills || '专业相关技能'}
匹配亮点：${matchedPoints || '技术背景高度契合'}

【目标岗位】
公司：${company}
职位：${jobTitle}
岗位要求概览：${jdExcerpt || '详见招聘要求'}

请生成一条 60-100 字的高转化求职沟通打招呼语：`

  try {
    // 3. 带超时的 LLM 调用
    const aiCall = chatCompletion(systemPrompt, userPrompt, 0.7)

    const timeoutPromise = new Promise<string>((_, reject) =>
      setTimeout(() => reject(new Error('AI greeting generation timeout')), timeoutMs),
    )

    const response = await Promise.race([aiCall, timeoutPromise])
    const generatedText = (response || '').trim().replace(/^["“]|["”]$/g, '')

    if (generatedText.length >= 20) {
      log(MOD, 'generateJobGreeting', `Generated greeting (${generatedText.length} chars)`)
      return {
        text: generatedText,
        tokens: Math.round(generatedText.length * 1.5),
        source: 'ai',
      }
    }

    logWarn(MOD, 'generateJobGreeting', 'Generated greeting too short, fallback to template')
    return { text: fallbackGreeting, tokens: 0, source: 'fallback_template' }
  } catch (err) {
    logWarn(MOD, 'generateJobGreeting', `AI generation failed: ${err}, fallback to template`)
    return { text: fallbackGreeting, tokens: 0, source: 'fallback_template' }
  }
}
