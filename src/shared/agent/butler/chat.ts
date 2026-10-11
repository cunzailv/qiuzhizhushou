// B3 · 沟通 Agent
// 按公司/BOSS/岗位生成个性化打招呼（AI 优先、模板兜底）；
// 聊天页常见问题自动应答（薪资期望/到岗时间/自我介绍/经验匹配）。
import { chatCompletion } from '../../ai/api-client'
import { getPrompt } from '../../db/prompt-store'
import { getJobSpecificGreeting } from '../../platform/boss/action-simulator'
import type { Resume } from '../../types/resume'
import type { JobCard, MatchResult } from '../../types/job'
import type { CompanyMemory } from '../../types/butler'

const GREETING_SYSTEM = `你是求职沟通专家。根据岗位信息与求职者简历，生成一段自然、真诚、个性化的打招呼语（40-80字）。
要求：
1. 结合岗位职责关键词与求职者技能，说明匹配点
2. 体现对公司的了解（从岗位/公司名合理推断）
3. 语气自然不套话，避免"很高兴认识您"等空话
4. 只输出打招呼正文，不要标题或引号`

/** 个性化打招呼：AI 开启时尝试生成，失败/关闭时回退平台模板（行为与旧版一致） */
export async function generatePersonalizedGreeting(
  resumeName: string,
  job: JobCard,
  match: MatchResult,
  memory?: CompanyMemory,
  aiEnabled = false,
): Promise<string> {
  if (aiEnabled) {
    const userMessage = [
      `【公司】${job.companyName || '未知'}`,
      `【岗位】${job.title}（${job.salary || '薪资未知'}）`,
      `【岗位要求】${(job.jobDescription || '').slice(0, 300)}`,
      `【我的匹配】${match.skillMatch.slice(0, 5).join('、') || '方向匹配'}，匹配分 ${match.score}`,
      memory ? `【该公司过往回复率】${Math.round((memory.replyCount / Math.max(1, memory.touchCount)) * 100)}%` : '',
    ].filter(Boolean).join('\n')
    const raw = await chatCompletion(await getPrompt('butler.greeting', GREETING_SYSTEM), userMessage, 0.7)
    const cleaned = (raw || '').replace(/["“”]+/g, '').trim()
    if (cleaned.length >= 10) return cleaned
  }
  return getJobSpecificGreeting(resumeName, job, match)
}

// ─── 聊天页自动应答 ───

export type QuestionType = 'salary' | 'start_date' | 'self_intro' | 'experience' | 'other'

export interface AutoReply {
  type: QuestionType
  matched: boolean
  answer: string
}

const QUESTION_PATTERNS: Array<{ type: QuestionType; patterns: RegExp[] }> = [
  {
    type: 'salary',
    patterns: [
      /薪资|工资|期望.{0,6}(薪|资)/i,
      /待遇|薪酬/i,
      /你.{0,4}(期望|想要).{0,4}(薪|工资)/i,
    ],
  },
  {
    type: 'start_date',
    patterns: [/到岗|入职|什么时候.{0,4}(能|可以)/i, /最快.{0,4}(到岗|入职)/i, /何时.{0,4}(能|可以).{0,4}(到岗|上班)/i],
  },
  {
    type: 'self_intro',
    patterns: [/介绍.{0,4}(自己|一下)|自我介绍|简单.{0,4}介绍/i],
  },
  {
    type: 'experience',
    patterns: [/经验|做过|项目|技术栈|会不会|熟悉/i],
  },
]

export function matchQuestionType(question: string): QuestionType {
  for (const entry of QUESTION_PATTERNS) {
    if (entry.patterns.some((p) => p.test(question))) return entry.type
  }
  return 'other'
}

/** 生成聊天页自动应答（模板 + 简历事实；AI 可选润色） */
export async function respondToQuestion(
  question: string,
  resume: Resume,
  job?: JobCard,
  aiEnabled = false,
): Promise<AutoReply> {
  const type = matchQuestionType(question)
  const data = resume.structuredData
  const skills = data.skills.slice(0, 5).join('、') || '相关方向'
  const years = resume.profile?.yearsOfExperience ?? data.yearsOfExperience ?? 0
  const education = data.education[0]
  const eduText = education ? `${education.degree}（${education.major}）` : ''

  let answer = ''
  switch (type) {
    case 'salary':
      answer = `您好，我目前的期望薪资在 ${job?.salary || '面议区间'} 左右，具体可以根据岗位职责和公司整体情况再沟通。`
      break
    case 'start_date':
      answer = '我可以在沟通确认后尽快到岗，一般 1-2 周内可入职，具体时间可以协调。'
      break
    case 'self_intro':
      answer = `您好，我${years > 0 ? `有约 ${years} 年` : ''}${skills}相关经验，${eduText ? `学历为${eduText}，` : ''}对${job?.title || '该岗位'}方向很有兴趣，做过不少实战项目，可以详细聊聊。`
      break
    case 'experience':
      answer = `我主要做${skills}，有${years > 0 ? `约 ${years} 年` : '相关'}项目经验，${eduText ? `学历 ${eduText}。` : ''}可以针对岗位要求展开细聊。`
      break
    default:
      answer = `收到，这个问题我需要结合岗位具体情况回答。方便的话您可以再具体一些，我详细回复您。`
  }

  if (aiEnabled && type !== 'other') {
    const raw = await chatCompletion(
      await getPrompt('butler.reply'),
      `【简历】${resume.rawText?.slice(0, 400) || ''}\n【问题】${question}\n【岗位】${job?.title || ''} ${job?.salary || ''}`,
      0.6,
    )
    const cleaned = (raw || '').trim()
    if (cleaned.length >= 5) answer = cleaned
  }

  return { type, matched: type !== 'other', answer }
}
