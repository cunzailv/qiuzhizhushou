import { ALL_SKILLS } from '../parser/skills-dict'
import type { MatchResult, JobCard, MatchDimensions, JdRequirements } from '../types/job'
import type { Resume } from '../types/resume'

const ROLE_KEYWORDS = [
  '人工智能', 'AI', '前端', '后端', '全栈', '算法', '数据', '测试', '运维',
  '产品', '设计', '财务', '会计', '销售', '运营', '市场', '人力', '行政',
  'Java', 'PHP', 'Python', 'Golang', 'Node.js', 'React', 'Vue',
  'TypeScript', 'JavaScript', '开发',
]

// 维度满分：skills 45 / similarity 15 / direction 20 / experience 12 / education 8 = 100
const DIM_SCORE = { skills: 45, similarity: 15, direction: 20, experience: 12, education: 8 } as const

// ─── A3: 硬门槛（学历/年限一票否决，仅双方数据都已知时才拦截） ───

const DEGREE_RANK: Record<string, number> = { 大专: 1, 本科: 2, 硕士: 3, 博士: 4 }

export interface HardGateResult {
  passed: boolean
  reasons: string[]
}

export function checkHardGates(job: JobCard, resume: Resume): HardGateResult {
  const reasons: string[] = []
  const req = job.requirements

  // 学历门槛
  if (req?.education && req.education !== '不限') {
    const requiredRank = DEGREE_RANK[req.education]
    const highest = getHighestDegree(resume)
    if (requiredRank && highest) {
      if (highest.rank < requiredRank) {
        reasons.push(`学历门槛：要求${req.education}及以上，简历为${highest.degree}`)
      }
    }
  }

  // 年限门槛（简历年限未知时不拦截）
  if (req && req.experienceYears > 0) {
    const resumeYears = resume.structuredData.yearsOfExperience || resume.profile?.yearsOfExperience || 0
    if (resumeYears > 0 && resumeYears < req.experienceYears) {
      reasons.push(`年限门槛：要求${req.experienceYears}年以上，简历约${resumeYears}年`)
    }
  }

  return { passed: reasons.length === 0, reasons }
}

function getHighestDegree(resume: Resume): { degree: string; rank: number } | null {
  let best: { degree: string; rank: number } | null = null
  for (const edu of resume.structuredData.education) {
    const rank = DEGREE_RANK[edu.degree]
    if (rank && (!best || rank > best.rank)) best = { degree: edu.degree, rank }
  }
  return best
}

// ─── 初筛工具（保留原有：技能重合/文本相似/方向对齐） ───

function containsSkill(text: string, skill: string): boolean {
  const normalizedText = text.toLowerCase()
  const normalizedSkill = skill.toLowerCase().trim()
  if (!normalizedSkill) return false

  if (/[\u3400-\u9fff]/.test(normalizedSkill)) {
    return normalizedText.includes(normalizedSkill)
  }

  const escaped = normalizedSkill.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|[^a-z0-9])${escaped}(?=$|[^a-z0-9])`, 'i').test(normalizedText)
}

function computeSkillOverlap(resumeSkills: string[], jobDescription: string): string[] {
  const matched: string[] = []
  for (const skill of resumeSkills) {
    if (containsSkill(jobDescription, skill)) {
      matched.push(skill)
    }
  }
  return matched
}

function computeMissingSkills(resumeSkills: string[], jobDescription: string): string[] {
  const missing: string[] = []
  const lowerResumeSkills = resumeSkills.map((s) => s.toLowerCase())
  for (const skill of ALL_SKILLS) {
    if (containsSkill(jobDescription, skill) && !lowerResumeSkills.includes(skill.toLowerCase())) {
      missing.push(skill)
    }
  }
  return missing.slice(0, 8)
}

function tokenize(text: string): Set<string> {
  const tokens = new Set<string>()
  const normalized = text.toLowerCase()

  for (const match of normalized.matchAll(/[a-z0-9]+(?:[.+#/-][a-z0-9+#]+)*/g)) {
    if (match[0].length > 1) tokens.add(match[0])
  }

  for (const match of normalized.matchAll(/[\u3400-\u9fff]+/g)) {
    const sequence = match[0]
    if (sequence.length === 1) {
      tokens.add(sequence)
      continue
    }
    for (let index = 0; index < sequence.length - 1; index++) {
      tokens.add(sequence.slice(index, index + 2))
    }
  }

  return tokens
}

function textSimilarity(text1: string, text2: string): number {
  const words1 = tokenize(text1)
  const words2 = tokenize(text2)
  if (words1.size === 0 && words2.size === 0) return 0

  let intersection = 0
  for (const w of words1) {
    if (words2.has(w)) intersection++
  }

  const union = words1.size + words2.size - intersection
  if (union === 0) return 0
  return intersection / union
}

function roleAlignment(resumeText: string, jobTitle: string): number {
  const titleRoles = ROLE_KEYWORDS.filter((keyword) => containsSkill(jobTitle, keyword))
  if (titleRoles.length === 0) return 0

  const matchedRoles = titleRoles.filter((keyword) => containsSkill(resumeText, keyword))
  return matchedRoles.length / titleRoles.length
}

// ─── A3: 对齐式维度打分（修掉"简历自身分"虚高） ───

/** JD 中"必须技能"数量：优先用 A2 结构化的 required 技能，缺省回退词典扫描 */
function requiredSkillCount(jobDescription: string, requirements?: JdRequirements): number {
  if (requirements && requirements.skills.length > 0) {
    const required = requirements.skills.filter((s) => s.required).length
    // JD 未标注"必须/加分"区分（常见于搜索卡片文本）时全部按加分项识别，
    // 此时以识别出的技能总数作为基准，避免技能维度被算成 0。
    return required > 0 ? required : requirements.skills.length
  }
  return new Set(ALL_SKILLS.filter((skill) => containsSkill(jobDescription, skill))).size
}

function scoreExperience(resumeYears: number, requiredYears: number): number {
  if (requiredYears > 0 && resumeYears > 0) {
    return Math.min(DIM_SCORE.experience, Math.round((resumeYears / requiredYears) * DIM_SCORE.experience))
  }
  // 岗位未标注年限或简历年限未知：给中性分
  return resumeYears > 0 ? Math.round(DIM_SCORE.experience * 0.5) : 0
}

function scoreEducation(resume: Resume, requirements?: JdRequirements): number {
  const highest = getHighestDegree(resume)
  const requiredRank = requirements?.education ? DEGREE_RANK[requirements.education] : undefined
  if (!highest) return 0
  if (!requiredRank || requirements?.education === '不限') {
    return Math.round(DIM_SCORE.education * 0.5)
  }
  if (highest.rank >= requiredRank) return DIM_SCORE.education
  if (highest.rank === requiredRank - 1) return Math.round(DIM_SCORE.education * 0.4)
  return 0
}

export function computeLocalMatch(resume: Resume, job: JobCard): MatchResult {
  const resumeData = resume.structuredData
  const resumeSkills = resumeData.skills
  const resumeText = [
    resume.rawText,
    resumeData.summary,
    ...resumeSkills,
    ...resumeData.workExperience.flatMap((work) => [work.position, work.description]),
    ...resumeData.education.flatMap((education) => [education.degree, education.major]),
    ...resumeData.projects.flatMap((project) => [
      project.name,
      project.role,
      project.description,
      ...(project.technologies || []),
    ]),
  ].filter(Boolean).join(' ')

  const skillMatch = computeSkillOverlap(resumeSkills, job.jobDescription)
  const skillGap = computeMissingSkills(resumeSkills, job.jobDescription)

  // 硬门槛（A3）：学历/年限不达标直接压分
  const gate = checkHardGates(job, resume)

  // 技能分：必须技能覆盖度
  const reqCount = requiredSkillCount(job.jobDescription, job.requirements)
  const skillsScore = reqCount > 0
    ? Math.min(DIM_SCORE.skills, (skillMatch.length / reqCount) * DIM_SCORE.skills)
    : 0

  const similarityScore = Math.round(textSimilarity(resumeText, job.jobDescription) * DIM_SCORE.similarity)
  const directionScore = Math.round(roleAlignment(resumeText, job.title) * DIM_SCORE.direction)

  const resumeYears = resumeData.yearsOfExperience || resume.profile?.yearsOfExperience || 0
  const experienceScore = scoreExperience(resumeYears, job.requirements?.experienceYears || 0)
  const educationScore = scoreEducation(resume, job.requirements)

  const dimensions: MatchDimensions = {
    skills: Math.round(skillsScore),
    similarity: similarityScore,
    direction: directionScore,
    experience: experienceScore,
    education: educationScore,
  }

  let score = skillsScore + similarityScore + directionScore + experienceScore + educationScore
  if (!gate.passed) score = Math.min(score, 45)
  score = Math.min(100, score)

  const isRecommended = score >= 60

  let recommendation = ''
  if (!gate.passed) {
    recommendation = `硬性要求未满足：${gate.reasons.join('；')}。建议确认是否可放宽条件，否则投递成功率较低。`
  } else if (score >= 80) {
    recommendation = '高度匹配！您的技能和经验与岗位要求非常吻合，强烈建议沟通。'
  } else if (score >= 60) {
    recommendation = '匹配度良好。主要技能符合要求，部分技能可以后续补充。'
  } else if (score >= 40) {
    recommendation = '匹配度一般。建议提升以下技能再沟通。'
  } else {
    recommendation = '匹配度较低。该岗位与您的技能背景差异较大。'
  }

  return {
    jobId: job.id,
    score: Math.round(score),
    skillMatch,
    skillGap: skillGap.filter((s) => !skillMatch.includes(s)).slice(0, 5),
    recommendation,
    isRecommended,
    hardGate: { passed: gate.passed, reasons: gate.reasons },
    dimensions,
  }
}
