import { chatCompletionStream } from './api-client'

export interface JobMatchAnalysis {
  overallScore: number
  skillMatch: string[]
  skillGap: string[]
  strengths: string[]
  weaknesses: string[]
  improvementSuggestions: string[]
  recommendation: string
}

const SYSTEM_PROMPT = `你是资深职业规划Agent。请像专业顾问一样，逐步分析候选人与岗位的匹配度。

请按以下思维流程逐步输出：

**第一步：技能映射**
快速对比 JD 要求的技术栈 vs 简历技能，列出精确匹配和明显缺失。

**第二步：经验评估**
对比工作年限、行业背景、项目复杂度与 JD 要求，判断经验是否够用。

**第三步：潜力判断**
评估候选人的学习路径、技术广度、项目多样性——即使某些技能缺失，是否具备快速上手能力。

**第四步：综合评分与建议**
给出 0-100 分，并针对不足之处给出具体学习路径（如"花2周学React官方教程+做1个demo项目"），而非笼统说"建议学习XX"。

最后在文末附 JSON 代码块：
\`\`\`json
{
  "overallScore": 综合评分0-100,
  "skillMatch": ["匹配技能"],
  "skillGap": ["缺失技能"],
  "strengths": ["核心优势"],
  "weaknesses": ["主要不足"],
  "improvementSuggestions": ["具体可行的提升路径"],
  "recommendation": "100字内综合推荐语"
}
\`\`\`

评分标准：
90-100：高度匹配 | 75-89：良好 | 60-74：基本匹配 | 40-59：偏低 | 0-39：不推荐`

/**
 * 流式分析职位匹配度。
 * @param resumeText 简历全文本（含技能、经验、教育等）
 * @param resumeSkills 简历中提取的技能列表
 * @param jobDescription 用户输入的职位描述
 * @param onChunk 流式文本回调，每收到一个 AI 输出块就调用
 * @param signal AbortSignal 用于取消请求
 * @returns 结构化的匹配分析结果
 */
export async function analyzeJobMatch(
  resumeText: string,
  resumeSkills: string[],
  jobDescription: string,
  onChunk: (text: string) => void,
  signal?: AbortSignal
): Promise<JobMatchAnalysis> {
  const userMessage = `【候选人简历】
${resumeSkills.length > 0 ? `技能标签：${resumeSkills.join('、')}` : ''}
简历内容：
${resumeText.slice(0, 2000)}

【职位描述】
${jobDescription.slice(0, 2000)}

请按照要求的 JSON 格式输出职位匹配分析结果。`

  const fullText = await chatCompletionStream(SYSTEM_PROMPT, userMessage, onChunk, 0.3, signal)

  // 从流式响应中解析 JSON（优先 ```json 代码块，其次裸 {...}）
  try {
    let jsonStr = ''
    const fenced = fullText.match(/```json\s*\n?([\s\S]*?)```/)
    if (fenced) {
      jsonStr = fenced[1].trim()
    } else {
      const bare = fullText.match(/\{[\s\S]*\}/)
      if (bare) jsonStr = bare[0]
    }
    if (jsonStr) {
      const parsed = JSON.parse(jsonStr) as JobMatchAnalysis
      return {
        overallScore: parsed.overallScore ?? 0,
        skillMatch: Array.isArray(parsed.skillMatch) ? parsed.skillMatch : [],
        skillGap: Array.isArray(parsed.skillGap) ? parsed.skillGap : [],
        strengths: Array.isArray(parsed.strengths) ? parsed.strengths : [],
        weaknesses: Array.isArray(parsed.weaknesses) ? parsed.weaknesses : [],
        improvementSuggestions: Array.isArray(parsed.improvementSuggestions) ? parsed.improvementSuggestions : [],
        recommendation: parsed.recommendation || '分析完成，请查看详细结果',
      }
    }
  } catch {
    // 解析失败，返回默认结构
  }

  return {
    overallScore: 0,
    skillMatch: [],
    skillGap: [],
    strengths: ['AI 响应格式异常，请重新分析'],
    weaknesses: [],
    improvementSuggestions: [],
    recommendation: fullText.slice(0, 200) || '分析结果解析失败，请重试',
  }
}
