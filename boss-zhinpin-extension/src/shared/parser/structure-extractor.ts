import type { Resume } from '../types/resume'

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

  // Extract degree
  const degreePattern = /(?:本科|硕士|博士|大专|学士|Bachelor|Master|PhD|MBA)/
  const degreeMatch = text.match(degreePattern)
  if (degreeMatch && education.length > 0) {
    const degree = degreeMatch[0]
    if (degree === '本科' || degree === 'Bachelor') education[0].degree = '本科'
    else if (degree === '硕士' || degree === 'Master' || degree === 'MBA') education[0].degree = '硕士'
    else if (degree === '博士' || degree === 'PhD') education[0].degree = '博士'
    else education[0].degree = degree
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
      const items = section.split(/(?:\n\s*\n)|(?:\n\s*(?:●|·|•|-|\d+\.))/).slice(1)

      for (const item of items) {
        if (item.trim().length < 10) continue
        const companyPattern = /([^\n]{2,40}(?:公司|科技|集团|有限|Tech|Inc|Corp|Ltd))/
        const companyMatch = item.match(companyPattern)
        const positionPattern = /((?:高级|资深|实习|Senior|Junior|Lead|Staff)?[^\n]{2,20}(?:工程师|经理|设计师|开发|Engineer|Manager|Designer|Developer))/
        const positionMatch = item.match(positionPattern)

        if (companyMatch || positionMatch) {
          experience.push({
            company: companyMatch?.[1]?.trim() || '',
            position: positionMatch?.[1]?.trim() || '',
            startDate: '',
            endDate: '',
            description: item.trim().substring(0, 500),
          })
        }
      }
    }
  }

  return experience
}

export function extractStructuredData(text: string): Resume['structuredData'] {
  return {
    name: extractName(text),
    phone: extractPhone(text),
    email: extractEmail(text),
    city: extractCity(text),
    yearsOfExperience: 0,
    education: extractEducation(text),
    workExperience: extractWorkExperience(text),
    projects: [],
    skills: extractSkills(text),
    summary: text.substring(0, 500),
  }
}
