import { chatCompletion } from './api-client'
import type { Resume, ResumeAnalysis } from '../types/resume'

export async function analyzeResumeQuality(resume: Resume): Promise<ResumeAnalysis> {
  // First do a local analysis
  const localAnalysis = analyzeLocally(resume)

  // Try AI analysis if enabled
  const aiAnalysis = await tryAIAnalysis(resume)

  return aiAnalysis || localAnalysis
}

function analyzeLocally(resume: Resume): ResumeAnalysis {
  const data = resume.structuredData
  const strengths: string[] = []
  const weaknesses: string[] = []
  const suggestions: string[] = []

  // Experience analysis
  if (data.workExperience.length === 0) {
    weaknesses.push('缺少工作经历描述，建议补充实习或项目经验')
    suggestions.push('如果没有正式工作经历，可以突出实习经历、课程项目或开源贡献')
  } else if (data.workExperience.length >= 3) {
    strengths.push(`具有${data.workExperience.length}段工作经历，经验丰富`)
  }

  // Skills analysis
  if (data.skills.length < 5) {
    weaknesses.push('技能描述偏少，建议补充更多专业技能')
    suggestions.push('列出5-10项核心技能，包括技术工具、编程语言、软技能等')
  } else {
    strengths.push(`具备${data.skills.length}项技能，技能范围较全面`)
  }

  // Education analysis
  if (data.education.length === 0) {
    weaknesses.push('缺少教育背景信息')
  } else if (data.education[0].degree && data.education[0].school) {
    strengths.push(`教育背景明确：${data.education[0].school} ${data.education[0].degree}`)
  }

  // Contact info
  if (!data.email && !data.phone) {
    weaknesses.push('缺少联系方式（手机/邮箱），HR无法联系到你')
  } else {
    strengths.push('联系方式完整')
  }

  // Experience quantification
  const hasNumbers = /\d+[万千百万kK]/.test(data.summary)
  if (!hasNumbers) {
    suggestions.push('建议使用具体数字量化工作成果（如"提升系统性能30%"）')
  }

  // Summary
  if (data.summary.length < 100) {
    weaknesses.push('简历内容偏少，建议丰富各板块描述')
  }

  // Calculate scores
  const eduScore = data.education.length > 0 ? 80 : 20
  const expScore = data.workExperience.length >= 2 ? 85 : data.workExperience.length === 1 ? 60 : 30
  const skillsScore = data.skills.length >= 8 ? 85 : data.skills.length >= 4 ? 60 : 30
  const formatScore = data.email && data.phone ? 85 : 50

  return {
    overallScore: Math.round((eduScore + expScore + skillsScore + formatScore) / 4),
    strengths,
    weaknesses,
    suggestions,
    sectionScores: {
      education: eduScore,
      experience: expScore,
      skills: skillsScore,
      format: formatScore,
    },
    analyzedAt: new Date().toISOString(),
  }
}

async function tryAIAnalysis(resume: Resume): Promise<ResumeAnalysis | null> {
  const systemPrompt = `你是资深HR和职业顾问Agent。请像专业顾问一样，逐步分析求职者简历，输出分析报告。

请按以下思维流程分析：
1. 先快速浏览整体结构（格式、完整性、篇幅）
2. 逐一审视各维度：教育背景 → 工作经历 → 技能 → 成果量化
3. 找出3-5个最突出的优势
4. 找出3-5个最关键的不足（按重要性排序）
5. 给出3-5条具体可操作的改进建议（不说空话，每条建议带具体做法）

评分维度：
- education: 学历层次、专业匹配度（知名大学/硕士以上加分）
- experience: 工作年限、公司知名度、职责描述质量、成果量化
- skills: 技能数量、深度、是否与目标岗位匹配、是否有稀缺技能
- format: 排版逻辑、信息密度、联系方式完整性、是否有明显错误

最后，在分析文本末尾附上 JSON 代码块：
\`\`\`json
{
  "overallScore": 综合评分0-100,
  "strengths": ["优势"],
  "weaknesses": ["不足"],
  "suggestions": ["建议"],
  "sectionScores": { "education": 分数, "experience": 分数, "skills": 分数, "format": 分数 }
}
\`\`\``

  const userMessage = `【求职者简历】
姓名: ${resume.structuredData.name || '未填写'}
教育: ${JSON.stringify(resume.structuredData.education)}
工作经历: ${JSON.stringify(resume.structuredData.workExperience)}
技能: ${resume.structuredData.skills.join('、')}
项目: ${JSON.stringify(resume.structuredData.projects)}
概述: ${resume.structuredData.summary.substring(0, 1500)}

请按 Agent 思维流程逐步分析。`

  const result = await chatCompletion(systemPrompt, userMessage, 0.5)
  if (!result) return null

  try {
    const fenced = result.match(/```json\s*\n?([\s\S]*?)```/)
    const jsonStr = fenced ? fenced[1].trim() : result.match(/\{[\s\S]*\}/)?.[0]
    if (jsonStr) {
      const parsed = JSON.parse(jsonStr)
      return {
        overallScore: parsed.overallScore || 60,
        strengths: parsed.strengths || [],
        weaknesses: parsed.weaknesses || [],
        suggestions: parsed.suggestions || [],
        sectionScores: parsed.sectionScores || { education: 60, experience: 60, skills: 60, format: 60 },
        analyzedAt: new Date().toISOString(),
      }
    }
  } catch {
    console.error('Failed to parse AI analysis')
  }
  return null
}
