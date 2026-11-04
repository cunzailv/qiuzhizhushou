import { ALL_SKILLS } from '../parser/skills-dict'
import { semanticSimilarity } from './semantic-refine'
import { ROLE_KEYWORDS } from './role-keywords'
import type { MatchResult, JobCard, MatchDimensions, JdRequirements } from '../types/job'
import { getJobScoringText } from '../types/job'
import type { Resume } from '../types/resume'

// 维度满分：skills 45 / similarity 15 / direction 20 / experience 12 / education 8 = 100
const DIM_SCORE = { skills: 45, similarity: 15, direction: 20, experience: 12, education: 8 } as const

// ─── A3: 硬门槛（学历/年限一票否决，仅双方数据都已知时才拦截） ───

const DEGREE_RANK: Record<string, number> = { 大专: 1, 本科: 2, 硕士: 3, 博士: 4 }

export interface HardGateResult {
  passed: boolean
  reasons: string[]
}

// 语言家族：简历/岗位的编程语言能力归一。框架技能（Gin/Spring 等）不视为语言经验。
// "Golang" 归一为 go；JS/TS 视为同族（TS 是 JS 超集，避免前端岗被误伤）。
const LANGUAGE_FAMILIES: Record<string, string[]> = {
  go: ['go', 'golang'],
  java: ['java'],
  python: ['python'],
  php: ['php'],
  'js/ts': ['javascript', 'typescript', 'js', 'ts'],
  'c/c++': ['c++', 'cpp'],
  'c#': ['c#', 'csharp'],
  node: ['node', 'node.js', 'nodejs'],
  ruby: ['ruby'],
  rust: ['rust'],
  swift: ['swift'],
  kotlin: ['kotlin'],
  dart: ['dart'],
  scala: ['scala'],
  shell: ['shell', 'bash'],
}

export function extractLanguageFamilies(text: string): string[] {
  const found = new Set<string>()
  for (const [family, aliases] of Object.entries(LANGUAGE_FAMILIES)) {
    if (aliases.some((alias) => containsSkill(text, alias))) found.add(family)
  }
  return Array.from(found)
}

export function extractResumeLanguageFamilies(resumeSkills: string[]): string[] {
  const lower = new Set(resumeSkills.map((s) => s.toLowerCase()))
  const found = new Set<string>()
  for (const [family, aliases] of Object.entries(LANGUAGE_FAMILIES)) {
    if (aliases.some((alias) => lower.has(alias.toLowerCase()))) found.add(family)
  }
  return Array.from(found)
}

export function checkHardGates(job: JobCard, resume: Resume): HardGateResult {
  const reasons: string[] = []
  const req = job.requirements
  // 评分/分析统一用评分文本（真实 JD 优先，列表页拼凑文本兜底）
  const jdText = getJobScoringText(job)

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

  // 核心技能门槛（A4）：JD 要求的核心技能与简历技能零交集 → 一票否决。
  // 解决"简历没写 Java 却投 Java 岗"：经验维度只比年限数字，不比经验的技术方向，
  // 因此必须用技能交集兜底，防止 3 年前端经验被当成 3 年 Java 经验。
  const resumeSkills = (resume.structuredData.skills || []).map((s) => s.toLowerCase())
  if (resumeSkills.length > 0) {
    let jdSkills: string[] = []
    if (req?.skills && req.skills.length > 0) {
      // 优先用 JD 结构化标注的"必须技能"；JD 未区分必须/加分时全部按核心技能处理
      const required = req.skills.filter((s) => s.required).map((s) => s.skill)
      jdSkills = required.length > 0 ? required : req.skills.map((s) => s.skill)
    } else {
      // 回退：从岗位匹配文本用技能词典扫描（列表页描述缺失时也能兜底）
      jdSkills = Array.from(new Set(ALL_SKILLS.filter((skill) => containsSkill(jdText, skill))))
    }
    if (jdSkills.length > 0) {
      const missingAll = jdSkills.every((skill) => !resumeSkills.includes(skill.toLowerCase()))
      if (missingAll) {
        reasons.push(`核心技能门槛：岗位要求${jdSkills.slice(0, 6).join('、')}等，简历技能均未涉及`)
      }
    }
  }

  // 语言硬门槛（A5）：岗位只要求单一语言家族，而简历不含该语言 → 一票否决。
  // 修复"简历没写 Go/Java 却被投 Go/Java 岗"：框架（Gin/Spring）不等于语言经验；
  // 简历有 TypeScript 视为具备 js/ts 家族能力；多语言岗位（≥2 家族）不触发，交给技能交集兜底。
  const jdLangSource = [
    job.title,
    jdText,
    ...(job.tags || []),
    ...(req?.skills?.map((s) => s.skill) || []),
  ].filter(Boolean).join(' ')
  const jdLanguageFamilies = extractLanguageFamilies(jdLangSource)
  const resumeLanguageFamilies = extractResumeLanguageFamilies(resumeSkills)
  if (
    jdLanguageFamilies.length === 1 &&
    resumeLanguageFamilies.length > 0 &&
    !resumeLanguageFamilies.includes(jdLanguageFamilies[0])
  ) {
    reasons.push(`语言门槛：岗位要求${jdLanguageFamilies[0]}语言经验，简历技能未包含`)
  }

  return { passed: reasons.length === 0, reasons }
}

export function getHighestDegree(resume: Resume): { degree: string; rank: number } | null {
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

function textSimilarity(text1: string, text2: string): number {
  // C1：语义精筛（别名归一 + 词元 Jaccard + 方向词强化）
  return semanticSimilarity(text1, text2)
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
  // 评分文本：真实 JD 优先（详情提取后），列表页拼凑文本兜底
  const jdText = getJobScoringText(job)
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

  const skillMatch = computeSkillOverlap(resumeSkills, jdText)
  const skillGap = computeMissingSkills(resumeSkills, jdText)

  // 硬门槛（A3）：学历/年限不达标直接压分
  const gate = checkHardGates(job, resume)

  // 技能分：必须技能覆盖度
  const reqCount = requiredSkillCount(jdText, job.requirements)
  const skillsScore = reqCount > 0
    ? Math.min(DIM_SCORE.skills, (skillMatch.length / reqCount) * DIM_SCORE.skills)
    : 0

  const similarityScore = Math.round(textSimilarity(resumeText, jdText) * DIM_SCORE.similarity)
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
