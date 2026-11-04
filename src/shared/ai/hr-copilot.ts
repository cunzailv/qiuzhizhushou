// HR 经典追问库智能应答 Copilot 核心引擎

import type { Resume } from '../types/resume'
import type { CandidateProfilePreferences } from '../types/candidate-profile'
import { PRESET_BOTTOM_LINES } from '../types/candidate-profile'
import { chatCompletion } from './api-client'
import { sanitizeJobText } from '../utils/text-sanitizer'

export type HrQuestionIntent =
  | 'status_and_onboard' // 问求职状态/到岗时间
  | 'salary_inquiry' // 问期望薪资/目前薪资
  | 'bottom_line_check' // 提及单休/外包/加班等底线问题
  | 'architecture_and_tech' // 技术深挖/架构/项目实践
  | 'interview_invitation' // 约面试/电话聊/索要联系方式
  | 'general_chitchat' // 常见问候/一般确认

export interface HrReplyResult {
  /** 推荐生成的得体回复文本 */
  replyText: string
  /** 识别出的意图类别 */
  intent: HrQuestionIntent
  /** 命中的简历事实摘要（证明依据） */
  matchedFact?: string
  /** 若命中底线则给出警示说明 */
  bottomLineAlert?: string
  /** 置信度 0 - 1 */
  confidence: number
}

export interface GenerateHrReplyOptions {
  hrMessage: string
  jobTitle?: string
  companyName?: string
  resume?: Resume | null
  preferences: CandidateProfilePreferences
}

/**
 * 识别 HR 提问的核心意图分类
 */
export function classifyHrIntent(
  hrMessage: string,
  preferences?: CandidateProfilePreferences,
): HrQuestionIntent {
  const msg = (hrMessage || '').toLowerCase().trim()

  // 1. 底线探测优先拦截（单休、外包、996、无社保等）
  const bottomLineKeywords = ['单休', '大小周', '996', '外包', '派遣', '驻场', '无社保', '无公积金', '纯提成', '常驻外地']
  if (preferences?.customBottomLines) {
    bottomLineKeywords.push(...preferences.customBottomLines.split(/[,;\s|]+/).filter(Boolean))
  }
  if (bottomLineKeywords.some((kw) => msg.includes(kw.toLowerCase()))) {
    return 'bottom_line_check'
  }

  // 2. 问在职状态与到岗时间
  if (
    /(在职|离职|到岗|最快什么时候|什么时候能到岗|离职手续|入职时间|看新机会|多久能到岗|什么时候可以上班|能立刻上班吗)/.test(
      msg,
    )
  ) {
    return 'status_and_onboard'
  }

  // 3. 问薪资待遇
  if (/(期望薪资|薪资要求|多少k|薪资期望|待遇要求|期望待遇|薪酬|目前薪资|上一份薪资|期望月薪|薪资预算)/.test(msg)) {
    return 'salary_inquiry'
  }

  // 4. 约面试 / 索要电话微信
  if (/(面试|约个时间|电话聊|方便电话|腾讯会议|飞书会议|来公司|线上聊聊|聊一聊|微信|发一份简历|发送简历|电话沟通|明天下午|今天下午|上午有空吗)/.test(msg)) {
    return 'interview_invitation'
  }

  // 5. 技术架构与项目深挖
  if (
    /(做过.*架构|做过.*开发|微服务|高并发|分布式|大模型|智能体|agent|视频生成|架构设计|next|react|vue|node|python|golang|go语言|php|java|mysql|redis|kafka|docker|k8s|性能优化|从0到1)/.test(
      msg,
    )
  ) {
    return 'architecture_and_tech'
  }

  return 'general_chitchat'
}

/**
 * 针对 HR 提问关键词，从简历中高精度检索真实项目经验事实
 */
export function extractRelevantResumeFacts(
  resume?: Resume | null,
  hrMessage = '',
): string[] {
  if (!resume || !resume.structuredData) return []
  const facts: string[] = []
  const msg = hrMessage.toLowerCase()

  // 提取提问中的核心技术词
  const techTokens = (
    msg.match(
      /(全栈|前端|后端|微服务|高并发|分布式|大模型|ai|智能体|agent|视频生成|react|vue|next\.js|next|node|python|golang|go|php|java|mysql|redis|kafka|docker|k8s|架构)/gi,
    ) || []
  ).map((t) => t.toLowerCase())

  // 1. 扫描项目经历
  const projects = resume.structuredData.projects || []
  for (const p of projects) {
    const pText = [p.name, p.role, ...(p.technologies || []), p.description]
      .join(' ')
      .toLowerCase()
    const hit = techTokens.some((tok) => pText.includes(tok))
    if (hit || techTokens.length === 0) {
      const summary = `在【${p.name}】担任【${p.role || '核心开发'}】，运用 ${
        (p.technologies || []).slice(0, 4).join('、') || '核心技术栈'
      }：${sanitizeJobText(p.description).slice(0, 90)}`
      facts.push(summary)
    }
  }

  // 2. 扫描工作经历
  const works = resume.structuredData.workExperience || []
  for (const w of works) {
    const wText = [w.company, w.position, w.description].join(' ').toLowerCase()
    const hit = techTokens.some((tok) => wText.includes(tok))
    if (hit) {
      facts.push(
        `在【${w.company}】担任【${w.position}】：${sanitizeJobText(w.description).slice(0, 80)}`,
      )
    }
  }

  // 3. 兜底取画像一句话与成果亮点
  if (facts.length === 0) {
    if (resume.profile?.profile) {
      facts.push(resume.profile.profile)
    }
    if (resume.structuredData.summary) {
      facts.push(resume.structuredData.summary.slice(0, 100))
    }
  }

  return facts.slice(0, 3)
}

/**
 * 生成得体专业的高情商 HR 智能应答（支持底线拦截、高情商报价、真实简历论证）
 */
export async function generateHrReplyCopilot(
  options: GenerateHrReplyOptions,
): Promise<HrReplyResult> {
  const { hrMessage, jobTitle = '目标岗位', companyName = '贵司', resume, preferences } = options
  const intent = classifyHrIntent(hrMessage, preferences)
  const facts = extractRelevantResumeFacts(resume, hrMessage)
  const matchedFact = facts[0] || ''

  // ─── 场景 1：底线冲突拦截（单休 / 外包 / 无社保等） ───
  if (intent === 'bottom_line_check') {
    // 找出触发的具体底线
    const violated = PRESET_BOTTOM_LINES.filter((b) =>
      preferences.bottomLines.includes(b.id) &&
      b.keywords.some((kw) => hrMessage.includes(kw)),
    )
    const reasonLabel = violated.map((v) => v.label).join('、') || '非外包双休自研岗位'

    return {
      intent,
      confidence: 0.95,
      bottomLineAlert: `⚠️ 检测到该提问可能涉及您的底线要求（${reasonLabel}）`,
      replyText: `您好，非常感谢 ${companyName} 的关注与邀请！我目前求职主要考虑自研业务及双休规范的发展机会。若该岗位属于相关工作模式，可能与我现阶段的职业规划不太契合。为避免耽误贵司团队的宝贵时间，在此向您坦诚说明，祝团队招聘顺利！`,
    }
  }

  // ─── 场景 2：求职状态与最快到岗时间 ───
  if (intent === 'status_and_onboard') {
    let statusText = '目前已离职，处于全职求职状态'
    if (preferences.employmentStatus === 'employed_month') {
      statusText = '目前在职，已进入离职交接阶段'
    } else if (preferences.employmentStatus === 'employed_exploring') {
      statusText = '目前在职看新机会，对优质团队持开放态度'
    }

    const reply = `您好！我${statusText}，最快【${preferences.availableDays}】即可到岗入职。如果团队有需要，我随时可以配合参加入职前流程与技术交流。`
    return {
      intent,
      confidence: 0.92,
      replyText: reply,
      matchedFact: `求职状态: ${statusText} | 到岗周期: ${preferences.availableDays}`,
    }
  }

  // ─── 场景 3：期望薪资与待遇核算 ───
  if (intent === 'salary_inquiry') {
    const min = preferences.expectedSalaryMin
    const max = preferences.expectedSalaryMax

    let salaryPhrase = '15-20K'
    if (min !== null && max !== null) {
      salaryPhrase = `${min}-${max}K`
    } else if (min !== null) {
      salaryPhrase = `${min}K左右`
    }

    const reply = `您好！我的期望月薪在【${salaryPhrase}】左右（可根据业务核心复杂度与团队综合定薪空间弹性沟通）。我更看重能在团队中发挥实际业务价值与技术闭环，具体待遇欢迎在后续沟通中结合定级详谈。`
    return {
      intent,
      confidence: 0.9,
      replyText: reply,
      matchedFact: `期望薪资区间: ${salaryPhrase}`,
    }
  }

  // ─── 场景 4：面试邀请与索要联系方式 ───
  if (intent === 'interview_invitation') {
    const contact = preferences.contactInfo
      ? `我的电话/微信是：${preferences.contactInfo}`
      : '您可以随时通过当前平台发送会议链接或致电'
    const reply = `您好，非常期待能与 ${companyName} 团队深入交流！我近期工作日均可协调时间参加沟通。${contact}，期待与您的进一步详谈！`
    return {
      intent,
      confidence: 0.95,
      replyText: reply,
      matchedFact: preferences.contactInfo ? `已预置联系方式: ${preferences.contactInfo}` : undefined,
    }
  }

  // ─── 场景 5：技术深挖与架构实践追问 ───
  if (intent === 'architecture_and_tech') {
    // 尝试调用大模型生成更有温度且紧扣简历的定制答案
    try {
      const prompt = `你是一名求职全栈/技术工程师，HR 正在向你提问关于技术/架构的问题。
【HR提问】：${hrMessage}
【应聘岗位】：${jobTitle} @ ${companyName}
【求职者简历事实】：
${facts.join('\n')}

请结合上述简历真实事实，生成一段 2-3 句话、专业、谦逊且有说服力的回复。
要求：
1. 必须基于简历给出的真实项目与技术经验，严禁虚构未提及的成果。
2. 语言高情商、表达清晰，体现出动手能力与项目落地闭环。
3. 直接输出回复正文，不要有任何前缀或解释。`

      const systemPrompt = '你是高情商求职助手，回答技术追问需紧扣简历事实、谦逊专业。'
      const aiReply = await chatCompletion(systemPrompt, prompt, 0.3)

      if (aiReply && aiReply.trim().length >= 15) {
        return {
          intent,
          confidence: 0.88,
          replyText: sanitizeJobText(aiReply.trim()),
          matchedFact: facts[0],
        }
      }
    } catch {
      // AI 失败回退确定性模板
    }

    // 确定性降级回复（严密引用简历项目事实）
    const factSnippet = facts[0] || '负责核心技术开发与落地'
    const reply = `您好！关于这块技术实践，我此前有实际落地经验：${factSnippet}。在方案设计、性能优化与生产交付上积累了成套实践，很契合贵司 ${jobTitle} 的方向，非常乐意在面试中与团队深入探讨具体架构！`
    return {
      intent,
      confidence: 0.85,
      replyText: reply,
      matchedFact: facts[0],
    }
  }

  // ─── 场景 6：通用问候/跟进 ───
  const genericReply = `您好！非常感谢您的回复，我对 ${companyName} 的【${jobTitle}】岗位非常感兴趣，期待有机会能与团队做进一步技术交流！`
  return {
    intent: 'general_chitchat',
    confidence: 0.7,
    replyText: genericReply,
  }
}
