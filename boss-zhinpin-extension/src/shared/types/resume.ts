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
