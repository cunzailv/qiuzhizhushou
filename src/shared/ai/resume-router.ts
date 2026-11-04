// 一人多面「多版本简历智能动态路由 (Dynamic Resume Routing)」
import type { Resume } from '../types/resume'
import type { JobCard } from '../types/job'
import { getAllResumes, getDefaultResume } from '../db/resume-store'
import { log } from '../utils/logger'

const MOD = 'ResumeRouter'

export interface ResumeScoreBreakdown {
  resumeId: string
  resumeName: string
  score: number
  titleScore: number
  skillsScore: number
  experienceScore: number
  reason: string
}

export interface ResumeRoutingResult {
  selectedResume: Resume
  score: number
  routingReason: string
  candidatesCount: number
  allScores: ResumeScoreBreakdown[]
}

/** 清理职位名称中的辅助修饰词，获取核心关键词 */
function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/(高级|资深|初级|专家|中级|实习生|实习|负责人|总监|组长|leader)/g, '')
    .replace(/[（(].*?[)）]/g, '')
    .replace(/[/\\_-]/g, ' ')
    .trim()
}

/**
 * 提取岗位中的技术栈或领域关键词
 */
function extractJobKeywords(job: {
  title: string
  jobDescription?: string
  tags?: string[]
}): string[] {
  const text = `${job.title} ${(job.tags || []).join(' ')} ${job.jobDescription || ''}`.toLowerCase()
  const techKeywords = [
    'react',
    'vue',
    'angular',
    'node',
    'nodejs',
    'python',
    'java',
    'golang',
    'go',
    'rust',
    'typescript',
    'javascript',
    'next.js',
    'nuxt',
    'docker',
    'kubernetes',
    'k8s',
    'ai',
    'llm',
    'agent',
    '智能体',
    '大模型',
    'langchain',
    '全栈',
    '前端',
    '后端',
    '架构',
    '微服务',
    '小程序',
    'flutter',
    'react native',
    'ios',
    'android',
    'devops',
    '大数据',
    '数据分析',
    '运维',
    '测试',
    'qa',
    'ui',
    '产品经理',
    '算法',
  ]

  return techKeywords.filter((kw) => text.includes(kw))
}

/**
 * 计算单份简历与目标岗位的匹配契合度 (0 - 100)
 */
export function calculateResumeJobAffinity(
  resume: Resume,
  job: { title: string; jobDescription?: string; tags?: string[] },
): ResumeScoreBreakdown {
  const cleanJobTitle = normalizeTitle(job.title)
  const resumeNameClean = normalizeTitle(resume.name || '')

  // 1. 标题与方向对齐度 (满分 40)
  let titleScore = 15 // 基准分
  if (cleanJobTitle && resumeNameClean && (cleanJobTitle.includes(resumeNameClean) || resumeNameClean.includes(cleanJobTitle))) {
    titleScore = 40
  } else {
    // 检查历史工作经历中的职位名称
    const positions = (resume.structuredData?.workExperience || []).map((w) =>
      normalizeTitle(w.position || ''),
    )
    const matchPos = positions.find(
      (p) => p && (cleanJobTitle.includes(p) || p.includes(cleanJobTitle)),
    )
    if (matchPos) {
      titleScore = 32
    } else {
      // 检查简历画像
      const profileText = (resume.profile?.profile || resume.structuredData?.summary || '').toLowerCase()
      if (cleanJobTitle && profileText.includes(cleanJobTitle)) {
        titleScore = 28
      }
    }
  }

  // 2. 技能重合度 (满分 40)
  const jobKeywords = extractJobKeywords(job)
  const resumeSkills = (resume.structuredData?.skills || []).map((s) => s.toLowerCase())
  const resumeFullText = (resume.rawText || '').toLowerCase()

  let matchedSkillsCount = 0
  if (jobKeywords.length > 0) {
    for (const kw of jobKeywords) {
      if (resumeSkills.some((s) => s.includes(kw) || kw.includes(s)) || resumeFullText.includes(kw)) {
        matchedSkillsCount++
      }
    }
  }

  const skillsScore =
    jobKeywords.length > 0
      ? Math.round((matchedSkillsCount / jobKeywords.length) * 40)
      : 25 // 岗位未提取出特有关键词时给默认分

  // 3. 项目与经验丰富度 (满分 20)
  const projectsCount = resume.structuredData?.projects?.length || 0
  const expYears = resume.structuredData?.yearsOfExperience || resume.profile?.yearsOfExperience || 3
  const experienceScore = Math.min(20, Math.round(Math.min(projectsCount * 3, 10) + Math.min(expYears * 2, 10)))

  const totalScore = Math.min(100, Math.max(0, titleScore + skillsScore + experienceScore))

  const reason = `方向契合度 ${titleScore}/40，核心技能重合 ${matchedSkillsCount}/${jobKeywords.length || '无要求'}，经验分 ${experienceScore}/20`

  return {
    resumeId: resume.id,
    resumeName: resume.name,
    score: totalScore,
    titleScore,
    skillsScore,
    experienceScore,
    reason,
  }
}

/**
 * 从候选简历列表中挑选最适合目标岗位的简历 (Dynamic Router)
 */
export function selectBestResumeForJob(
  job: { title: string; jobDescription?: string; tags?: string[] },
  resumes: Resume[],
): ResumeRoutingResult {
  if (!resumes || resumes.length === 0) {
    throw new Error('未提供任何候选简历')
  }

  if (resumes.length === 1) {
    const single = resumes[0]
    const breakdown = calculateResumeJobAffinity(single, job)
    return {
      selectedResume: single,
      score: breakdown.score,
      routingReason: `仅配置单份简历【${single.name}】，直接采用。`,
      candidatesCount: 1,
      allScores: [breakdown],
    }
  }

  // 计算多份简历的契合度得分
  const breakdowns: ResumeScoreBreakdown[] = resumes.map((r) => calculateResumeJobAffinity(r, job))

  // 按得分由高到低排序，同分则优先 default 简历
  breakdowns.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    const resA = resumes.find((r) => r.id === a.resumeId)
    const resB = resumes.find((r) => r.id === b.resumeId)
    if (resA?.isDefault) return -1
    if (resB?.isDefault) return 1
    return 0
  })

  const winnerBreakdown = breakdowns[0]
  const winnerResume = resumes.find((r) => r.id === winnerBreakdown.resumeId) || resumes[0]
  const runnerUp = breakdowns[1]

  const routingReason =
    runnerUp && runnerUp.score < winnerBreakdown.score
      ? `针对岗位【${job.title}】，动态路由命中更贴合的简历【${winnerBreakdown.resumeName}】(${winnerBreakdown.score} 分 > 【${runnerUp.resumeName}】${runnerUp.score} 分)。`
      : `针对岗位【${job.title}】，优先选用综合契合度最高的简历【${winnerBreakdown.resumeName}】(${winnerBreakdown.score} 分)。`

  log(MOD, 'selectBestResumeForJob', `Routed "${job.title}" to "${winnerResume.name}" (${winnerBreakdown.score}pts)`)

  return {
    selectedResume: winnerResume,
    score: winnerBreakdown.score,
    routingReason,
    candidatesCount: resumes.length,
    allScores: breakdowns,
  }
}

/**
 * 自动从数据库获取全部可用简历并为指定岗位动态路由最优简历
 */
export async function getOptimalResumeForJob(
  job: { title: string; jobDescription?: string; tags?: string[] },
): Promise<ResumeRoutingResult | null> {
  const all = await getAllResumes()
  if (all.length > 0) {
    return selectBestResumeForJob(job, all)
  }

  const def = await getDefaultResume()
  if (def) {
    return selectBestResumeForJob(job, [def])
  }

  return null
}
