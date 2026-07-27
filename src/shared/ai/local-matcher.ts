import { ALL_SKILLS } from '../parser/skills-dict'
import type { MatchResult, JobCard } from '../types/job'
import type { Resume } from '../types/resume'

const ROLE_KEYWORDS = [
  '人工智能', 'AI', '前端', '后端', '全栈', '算法', '数据', '测试', '运维',
  '产品', '设计', '财务', '会计', '销售', '运营', '市场', '人力', '行政',
  'Java', 'PHP', 'Python', 'Golang', 'Node.js', 'React', 'Vue',
  'TypeScript', 'JavaScript', '开发',
]

// Simple TF-IDF style keyword matching
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

  // Calculate score
  let score = 0

  // Skill match: up to 50 points
  if (resumeSkills.length > 0 && job.jobDescription.length > 0) {
    const requiredSkillsCount = [...new Set(
      ALL_SKILLS.filter((skill) => containsSkill(job.jobDescription, skill))
    )].length
    if (requiredSkillsCount > 0) {
      score += Math.min(50, (skillMatch.length / Math.max(requiredSkillsCount, 1)) * 50)
    }
  }

  // Text similarity: up to 30 points
  const similarity = textSimilarity(resumeText, job.jobDescription)
  score += Math.round(similarity * 30)

  // Career direction: up to 30 points. List cards often omit the full job
  // description, while the title still carries strong role intent.
  score += Math.round(roleAlignment(resumeText, job.title) * 30)

  // Experience bonus: up to 10 points
  if (resumeData.workExperience.length > 0) {
    score += Math.min(10, resumeData.workExperience.length * 3)
  }

  // Education bonus: up to 5 points
  if (resumeData.education.length > 0) {
    const highest = resumeData.education[0]
    if (highest.degree === '硕士' || highest.degree === '博士') score += 5
    else if (highest.degree === '本科') score += 3
    else score += 1
  }

  // Skills count bonus: up to 5 points
  score += Math.min(5, resumeSkills.length)

  score = Math.min(100, score)
  const isRecommended = score >= 60

  let recommendation = ''
  if (score >= 80) {
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
  }
}
