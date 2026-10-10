import type { Resume } from '../types/resume'
import type { Project, SkillLevel } from '../types/resume'

// Common skill keywords by category
const SKILL_KEYWORDS = [
  // Programming languages
  'JavaScript', 'TypeScript', 'Python', 'Java', 'Go', 'Rust', 'C++', 'C#', 'PHP', 'Ruby',
  'Swift', 'Kotlin', 'Dart', 'Scala', 'Shell', 'Bash',
  // Frontend
  'React', 'Vue', 'Angular', 'Next.js', 'Nuxt', 'Svelte', 'HTML', 'CSS', 'Sass', 'Less',
  'Webpack', 'Vite', 'Babel', 'ESLint', 'TailwindCSS', 'Bootstrap', 'jQuery',
  // Backend
  'Node.js', 'Express', 'Koa', 'NestJS', 'Spring', 'Spring Boot', 'Django', 'Flask',
  'FastAPI', 'Gin', 'Rails', 'Laravel', '.NET', 'GraphQL', 'RESTful',
  // Database
  'MySQL', 'PostgreSQL', 'MongoDB', 'Redis', 'Elasticsearch', 'Oracle', 'SQLite',
  'Cassandra', 'DynamoDB', 'ClickHouse',
  // DevOps
  'Docker', 'Kubernetes', 'Jenkins', 'GitLab CI', 'GitHub Actions', 'Nginx', 'Linux',
  'AWS', 'Azure', 'GCP', 'Terraform', 'Ansible', 'Prometheus', 'Grafana',
  // AI/ML
  'Machine Learning', 'Deep Learning', 'NLP', 'Computer Vision', 'TensorFlow', 'PyTorch',
  'Keras', 'Scikit-learn', 'Pandas', 'NumPy', 'LLM', 'LangChain',
  // Design
  'Figma', 'Sketch', 'Adobe XD', 'Photoshop', 'Illustrator', 'After Effects',
  // Languages
  'English', '英语', 'CET-6', 'CET-4', 'TEM-8', '日语', '韩语',
  // General
  '项目管理', '团队管理', '敏捷开发', 'Scrum', '产品设计', '数据分析', 'PPT', 'Excel',
  '需求分析', '测试', '自动化测试', '性能优化', '微服务', '系统架构',
] as const

// ─── 日期与年限解析（A1：真实工作年限） ───

interface DatePoint {
  year: number
  month: number
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

function parseDatePoint(str: string): DatePoint | null {
  const m = str.match(/(\d{4})[.\-/年](\d{1,2})?/)
  if (!m) return null
  return { year: Number(m[1]), month: m[2] ? Number(m[2]) : 1 }
}

function diffYears(a: DatePoint, b: DatePoint): number {
  const months = (b.year - a.year) * 12 + (b.month - a.month)
  return Math.max(0, Math.round((months / 12) * 10) / 10)
}

/**
 * 从一段文本中解析起止日期。
 * 支持：2020.06-2023.05 / 2020/6至2023/5 / 2020.06 - 至今 / 2019.7～现在 等。
 * 返回格式化的 startDate/endDate（YYYY-MM，至今为空串）与推算年限。
 */
export function parseDateRange(text: string): { startDate: string; endDate: string; years: number } | null {
  const pair = text.match(
    /(\d{4})[.\-/年](\d{1,2})?[.\-/月]?\s*(?:-|至|—|–|~|到|－)\s*(\d{4})[.\-/年](\d{1,2})?[.\-/月]?/
  )
  if (pair) {
    const start = parseDatePoint(`${pair[1]}-${pair[2] ?? 1}`)
    const end = parseDatePoint(`${pair[3]}-${pair[4] ?? 1}`)
    if (start && end) {
      return {
        startDate: `${start.year}-${pad2(start.month)}`,
        endDate: `${end.year}-${pad2(end.month)}`,
        years: diffYears(start, end),
      }
    }
  }
  // 开放区间：2020.06 - 至今
  const open = text.match(/(\d{4})[.\-/年](\d{1,2})?[.\-/月]?\s*(?:-|至|—|–|~|到)\s*(?:至今|现在|今|present)/i)
  if (open) {
    const start = parseDatePoint(`${open[1]}-${open[2] ?? 1}`)
    const now = new Date()
    if (start) {
      return {
        startDate: `${start.year}-${pad2(start.month)}`,
        endDate: '',
        years: diffYears(start, { year: now.getFullYear(), month: now.getMonth() + 1 }),
      }
    }
  }
  return null
}

/** 根据工作经历起止日期累计年限（实习按 0.5 计；无日期段不贡献） */
export function computeYearsOfExperience(
  items: Array<{ startDate: string; endDate: string; position: string }>
): number {
  let total = 0
  for (const item of items) {
    if (!item.startDate) continue
    const start = parseDatePoint(item.startDate)
    if (!start) continue
    const end = item.endDate ? parseDatePoint(item.endDate) : { year: new Date().getFullYear(), month: new Date().getMonth() + 1 }
    if (!end) continue
    let years = diffYears(start, end)
    if (/实习|intern/i.test(item.position)) years *= 0.5
    total += years
  }
  return Math.min(40, Math.round(total * 10) / 10)
}

// ─── 技能分级（A1） ───

const SKILL_LEVEL_PATTERNS: Array<{ level: SkillLevel; pattern: RegExp }> = [
  { level: 'expert', pattern: /精通\s*([\w+#.·\-]+(?:\s[\w+#.·\-]+)*|[\u4e00-\u9fa5]{2,12})/g },
  { level: 'proficient', pattern: /(?:熟练掌握|熟练运用|熟练|掌握)\s*([\w+#.·\-]+(?:\s[\w+#.·\-]+)*|[\u4e00-\u9fa5]{2,12})/g },
  { level: 'familiar', pattern: /熟悉\s*([\w+#.·\-]+(?:\s[\w+#.·\-]+)*|[\u4e00-\u9fa5]{2,12})/g },
  { level: 'basic', pattern: /(?:了解|入门)\s*([\w+#.·\-]+(?:\s[\w+#.·\-]+)*|[\u4e00-\u9fa5]{2,12})/g },
]

/** 从简历文本中提取"技能 + 熟练度"（精通/熟练/熟悉/了解） */
export function extractSkillLevels(text: string): Array<{ skill: string; level: SkillLevel }> {
  const entries: Array<{ skill: string; level: SkillLevel }> = []
  const seen = new Set<string>()
  for (const { level, pattern } of SKILL_LEVEL_PATTERNS) {
    pattern.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = pattern.exec(text)) !== null) {
      const skill = match[1].trim().replace(/[，。；、,;。\s]+$/, '')
      if (skill.length >= 2 && !seen.has(`${level}:${skill}`)) {
        seen.add(`${level}:${skill}`)
        entries.push({ skill, level })
      }
    }
  }
  return entries
}

function extractName(text: string): string {
  const namePattern = /(?:姓名|名字)[\s:：]*[（(]?[^\s\n]{2,4}[）)]?/i
  const match = text.match(namePattern)
  if (match) {
    return match[0].replace(/(?:姓名|名字)[\s:：]*/, '').replace(/[（()]/g, '').trim()
  }
  // Try first line
  const lines = text.split('\n').filter((l) => l.trim())
  if (lines.length > 0 && lines[0].trim().length <= 4) {
    return lines[0].trim()
  }
  return ''
}

function extractEmail(text: string): string {
  const emailPattern = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/
  const match = text.match(emailPattern)
  return match ? match[0] : ''
}

function extractPhone(text: string): string {
  const phonePattern = /1[3-9]\d{1}[-\s]?\d{4}[-\s]?\d{4}/
  const match = text.match(phonePattern)
  if (match) return match[0].replace(/[-\s]/g, '')
  // International format
  const intlPattern = /(?:\+86[-\s]?)?1[3-9]\d{9}/
  const intlMatch = text.match(intlPattern)
  return intlMatch ? intlMatch[0].replace(/[-\s+86]/g, '').replace(/^1/, '1') : ''
}

function extractCity(text: string): string {
  const cities = [
    '北京', '上海', '深圳', '广州', '杭州', '成都', '南京', '武汉', '西安',
    '苏州', '重庆', '天津', '长沙', '郑州', '东莞', '青岛', '厦门', '合肥',
    '佛山', '大连', '福州', '无锡', '宁波', '济南', '沈阳', '昆明', '南昌',
  ]
  for (const city of cities) {
    if (text.includes(city)) return city
  }
  return ''
}

function extractSkills(text: string): string[] {
  const skills = new Set<string>()
  const lowerText = text.toLowerCase()

  for (const keyword of SKILL_KEYWORDS) {
    if (lowerText.includes(keyword.toLowerCase())) {
      skills.add(keyword)
    }
  }

  return Array.from(skills)
}

function extractEducation(text: string): Resume['structuredData']['education'] {
  const education: Resume['structuredData']['education'] = []
  const schoolPatterns = [
    /(?:学校|院校|毕业院校)[\s：:]*([^\n]{2,30})/g,
    /([^\n]{2,20}(?:大学|学院|University|College))/g,
  ]

  const foundSchools = new Set<string>()
  for (const pattern of schoolPatterns) {
    let match: RegExpExecArray | null
    while ((match = pattern.exec(text)) !== null) {
      const school = match[1].trim()
      if (school && !foundSchools.has(school)) {
        foundSchools.add(school)
        education.push({
          school,
          degree: '',
          major: '',
          startDate: '',
          endDate: '',
        })
      }
    }
  }

  // Extract degree for every education entry (A1: 多段教育不再只填第一条)
  const degreePattern = /(?:本科|硕士|博士|大专|学士|Bachelor|Master|PhD|MBA)/
  const degreeMatch = text.match(degreePattern)
  if (degreeMatch && education.length > 0) {
    const degree = degreeMatch[0]
    for (const entry of education) {
      if (entry.degree) continue
      if (degree === '本科' || degree === 'Bachelor') entry.degree = '本科'
      else if (degree === '硕士' || degree === 'Master' || degree === 'MBA') entry.degree = '硕士'
      else if (degree === '博士' || degree === 'PhD') entry.degree = '博士'
      else entry.degree = degree
    }
  }

  // Extract major
  const majorPattern = /(?:专业|major)[\s：:]*([^\n,，]{2,20})/i
  const majorMatch = text.match(majorPattern)
  if (majorMatch && education.length > 0) {
    education[0].major = majorMatch[1].trim()
  }

  return education
}

function extractWorkExperience(text: string): Resume['structuredData']['workExperience'] {
  const experience: Resume['structuredData']['workExperience'] = []

  // Try to find work experience section
  const sectionPatterns = [
    /(?:工作经历|工作经验|实习经历|WORK EXPERIENCE|PROFESSIONAL EXPERIENCE)[\s\S]*?(?=(?:教育经历|项目经历|技能|EDUCATION|PROJECTS|SKILLS|$))/i,
  ]

  for (const pattern of sectionPatterns) {
    const match = text.match(pattern)
    if (match) {
      const section = match[0]
      // 剥离标题行，再按空行/项目符号/编号（"数字+点+空格"，避免误切日期）切分条目
      const body = section
        .replace(/^(?:工作经历|工作经验|实习经历|WORK EXPERIENCE|PROFESSIONAL EXPERIENCE)\s*[:：]?\s*\n?/i, '')
        .trim()
      const items = body.split(/(?:\n\s*\n)|(?:\n\s*(?:●|·|•|-|\d+\.\s))/)

      for (const item of items) {
        if (item.trim().length < 10) continue
        const companyPattern = /([^\n]{2,40}(?:公司|科技|集团|有限|Tech|Inc|Corp|Ltd))/
        const companyMatch = item.match(companyPattern)
        const positionPattern = /((?:高级|资深|实习|Senior|Junior|Lead|Staff)?[^\n]{2,20}(?:工程师|经理|设计师|开发|Engineer|Manager|Designer|Developer))/
        const positionMatch = item.match(positionPattern)

        if (companyMatch || positionMatch) {
          // A1: 解析起止日期
          const range = parseDateRange(item)
          experience.push({
            company: companyMatch?.[1]?.trim() || '',
            position: positionMatch?.[1]?.trim() || '',
            startDate: range?.startDate || '',
            endDate: range?.endDate || '',
            description: item.trim().substring(0, 500),
          })
        }
      }
    }
  }

  return experience
}

/** A1: 项目经历提取（名称/角色/日期/技术栈） */
export function extractProjects(text: string): Project[] {
  const projects: Project[] = []
  const sectionPatterns = [
    /(?:项目经历|项目经验|项目成果|PROJECTS|PROJECT EXPERIENCE)[\s\S]*?(?=(?:工作经历|工作经验|教育经历|技能|荣誉|WORK EXPERIENCE|EDUCATION|SKILLS|$))/i,
  ]

  for (const pattern of sectionPatterns) {
    const match = text.match(pattern)
    if (!match) continue
    const section = match[0]
    // 剥离标题行，再按空行/项目符号/编号切分条目
    const body = section
      .replace(/^(?:项目经历|项目经验|项目成果|PROJECTS|PROJECT EXPERIENCE)\s*[:：]?\s*\n?/i, '')
      .trim()
    const items = body.split(/(?:\n\s*\n)|(?:\n\s*(?:●|·|•|-|\d+\.\s))/)

    for (const item of items) {
      if (item.trim().length < 10) continue
      const namePattern = /(?:项目名|项目名称)[\s：:]*([^\n]{2,40})/
      const rolePattern = /(?:角色|职责|担任|负责)[\s：:]*([^\n，,]{2,20})/
      const nameMatch = item.match(namePattern)
      const roleMatch = item.match(rolePattern)
      const range = parseDateRange(item)
      const firstLine = item.trim().split('\n')[0]?.trim() || ''
      projects.push({
        name: nameMatch?.[1]?.trim() || firstLine.substring(0, 30),
        role: roleMatch?.[1]?.trim() || '',
        startDate: range?.startDate || '',
        endDate: range?.endDate || '',
        description: item.trim().substring(0, 500),
        technologies: extractSkills(item),
      })
    }
  }

  return projects
}

export function extractStructuredData(text: string): Resume['structuredData'] {
  const workExperience = extractWorkExperience(text)
  return {
    name: extractName(text),
    phone: extractPhone(text),
    email: extractEmail(text),
    city: extractCity(text),
    // A1: 由工作经历起止日期推算真实年限（不再是恒 0）
    yearsOfExperience: computeYearsOfExperience(workExperience),
    education: extractEducation(text),
    workExperience,
    // A1: 项目经历提取（不再是恒空）
    projects: extractProjects(text),
    skills: extractSkills(text),
    summary: text.substring(0, 500),
  }
}
