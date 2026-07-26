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
  const systemPrompt = `你是一个资深HR和简历优化专家。分析求职者的简历并给出具体优化建议。

请严格按照以下JSON格式返回：
{
  "overallScore": 0-100综合评分,
  "strengths": ["优势1", "优势2", "优势3"],
  "weaknesses": ["不足1", "不足2", "不足3"],
  "suggestions": ["建议1", "建议2", "建议3"],
  "sectionScores": {
    "education": 教育背景0-100分,
    "experience": 工作经历0-100分,
    "skills": 技能0-100分,
    "format": 格式规范0-100分
  }
}`

  const userMessage = JSON.stringify({
    name: resume.structuredData.name,
    education: resume.structuredData.education,
    experience: resume.structuredData.workExperience,
    skills: resume.structuredData.skills,
    summary: resume.structuredData.summary.substring(0, 1500),
  })

  const result = await chatCompletion(systemPrompt, userMessage, 0.5)
  if (!result) return null

  try {
    const jsonMatch = result.match(/\{[\s\S]*\}/)
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0])
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
