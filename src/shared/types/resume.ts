// Resume types
export interface Education {
  school: string
  degree: string
  major: string
  startDate: string
  endDate: string
}

export interface WorkExperience {
  company: string
  position: string
  startDate: string
  endDate: string
  description: string
}

export interface Project {
  name: string
  role: string
  startDate: string
  endDate: string
  description: string
  technologies: string[]
}

// ─── A1: AI 简历画像（Resume Profile） ───

export type SkillLevel = 'expert' | 'proficient' | 'familiar' | 'basic' | 'unknown'

export interface SkillLevelEntry {
  skill: string
  level: SkillLevel
}

export interface ResumeProfile {
  /** 真实工作年限（本地日期推算 + AI 补全） */
  yearsOfExperience: number
  /** 技能分级清单（精通/熟练/熟悉/了解） */
  skillLevels: SkillLevelEntry[]
  /** 一句话画像：X年Y方向经验 + 核心技能 + 代表成果 */
  profile: string
  /** 成果亮点（优先量化数字） */
  achievementHighlights: string[]
  /** 数据来源：local=纯本地解析，ai=AI 补全，hybrid=本地+AI 融合 */
  source: 'local' | 'ai' | 'hybrid'
  generatedAt: string
}

export interface Resume {
  id: string
  name: string
  fileName: string
  fileType: 'pdf' | 'docx' | 'doc'
  fileData: ArrayBuffer
  rawText: string
  structuredData: {
    name: string
    phone: string
    email: string
    city: string
    yearsOfExperience: number
    education: Education[]
    workExperience: WorkExperience[]
    projects: Project[]
    skills: string[]
    summary: string
  }
  aiAnalysis: ResumeAnalysis | null
  /** A1: AI 简历画像（由 enrichResumeProfile 生成） */
  profile?: ResumeProfile | null
  isDefault: boolean
  createdAt: string
  updatedAt: string
}

export interface ResumeAnalysis {
  overallScore: number
  strengths: string[]
  weaknesses: string[]
  suggestions: string[]
  sectionScores: {
    education: number
    experience: number
    skills: number
    format: number
  }
  analyzedAt: string
}

export interface ParsedResume {
  rawText: string
  structuredData: Resume['structuredData']
}
