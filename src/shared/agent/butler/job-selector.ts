// B2 · 选岗 Agent
// 综合「匹配分 × 薪资适配 × 公司记忆回复率 × 用户偏好」判断值不值得投，
// 输出 recommend / watch / mismatch 三层 + 可解释理由（替代 60 分一刀切）。
// 本地规则确定性计算（可单测）；AI 只做补充解释，不决定硬性分层。
import type { JobCard, MatchResult } from '../../types/job'
import type { CompanyMemory, JobEvaluation, JobTier, UserJobProfile } from '../../types/butler'

/** 各因子权重（合计 1.0） */
export const SELECTOR_WEIGHTS = {
  match: 0.6,
  salary: 0.15,
  memory: 0.15,
  preference: 0.1,
} as const

/** 分层阈值 */
export const TIER_THRESHOLDS = {
  recommend: 70,
  watch: 45,
} as const

export const TIER_LABELS: Record<JobTier, string> = {
  recommend: '推荐投递',
  watch: '观望',
  mismatch: '错位不投',
}

/** 解析薪资字符串（K/月）→ [min,max]，解析失败返回 null */
export function parseSalaryK(salaryText: string): { min: number; max: number } | null {
  if (!salaryText) return null
  const match = salaryText.match(/(\d+(?:\.\d+)?)\s*[-~—–至]\s*(\d+(?:\.\d+)?)/)
  if (match) return { min: Number(match[1]), max: Number(match[2]) }
  const single = salaryText.match(/(\d+(?:\.\d+)?)K/)
  if (single) return { min: Number(single[1]), max: Number(single[1]) }
  return null
}

/** 薪资适配分（0-1）：期望区间与岗位薪资区间重叠度 */
export function salaryFit(jobSalary: string | undefined, profileSalaryMin?: number, profileSalaryMax?: number): number {
  const parsed = parseSalaryK(jobSalary || '')
  if (!parsed) return 0.5
  if (!profileSalaryMin && !profileSalaryMax) return 0.6
  const jobMin = parsed.min
  const jobMax = parsed.max
  // 期望上限低于岗位下限 → 明显低估，反而更可能成（0.9）
  if (profileSalaryMax !== undefined && profileSalaryMax > 0 && profileSalaryMax < jobMin) return 0.9
  // 期望下限高于岗位上限 → 不匹配
  if (profileSalaryMin !== undefined && profileSalaryMin > jobMax) return 0.15
  // 有重叠
  return 0.75
}

/** 偏好匹配分（0-1）：目标岗位/城市命中 */
export function preferenceFit(job: JobCard, profile: UserJobProfile): number {
  const targetTitles = profile.targetTitles ?? []
  const targetCities = profile.targetCities ?? []
  let hits = 0
  let total = 0
  if (targetTitles.length > 0) {
    total += 1
    const text = `${job.title} ${job.jobDescription || ''}`.toLowerCase()
    if (targetTitles.some((t) => t && text.includes(t.toLowerCase()))) hits += 1
  }
  if (targetCities.length > 0) {
    total += 1
    if (targetCities.some((c) => c && (job.location || '').includes(c))) hits += 1
  }
  return total === 0 ? 0.5 : hits / total
}

/** 选岗 Agent：评估单个岗位是否值得投 */
export function evaluateJobWorth(
  job: JobCard,
  match: MatchResult,
  profile: UserJobProfile,
  memory?: CompanyMemory,
): JobEvaluation {
  const reasons: string[] = []

  // 硬门槛不过 → 直接错位
  if (match.hardGate && !match.hardGate.passed) {
    const gateReasons = (match.hardGate.reasons || []).slice(0, 2)
    reasons.push(`硬门槛未过：${gateReasons.join('、') || '学历/年限不符'}`)
    return {
      jobId: job.id,
      jobTitle: job.title,
      companyName: job.companyName,
      worthScore: 0,
      tier: 'mismatch',
      reasons,
      matchScore: match.score,
    }
  }

  const matchNorm = Math.min(100, match.score) / 100
  const salary = salaryFit(job.salary, profile.salaryMin, profile.salaryMax)
  const memoryRate = memoryReplyRateLocal(memory)
  const pref = preferenceFit(job, profile)

  const worthScore = Math.round(
    (matchNorm * SELECTOR_WEIGHTS.match +
      salary * SELECTOR_WEIGHTS.salary +
      memoryRate * SELECTOR_WEIGHTS.memory +
      pref * SELECTOR_WEIGHTS.preference) * 100,
  )

  // 可解释理由
  if (match.score >= 80) reasons.push(`匹配分高（${match.score}）`)
  else if (match.score >= 60) reasons.push(`匹配分达标（${match.score}）`)
  else reasons.push(`匹配分偏低（${match.score}）`)

  if (salary >= 0.85) reasons.push('薪资契合期望')
  else if (salary <= 0.2) reasons.push('薪资低于期望区间')
  else reasons.push('薪资区间基本覆盖')

  if (memory) {
    const rateText = Math.round(memoryRate * 100)
    if (memoryRate >= 0.6) reasons.push(`该公司历史回复率高（${rateText}%）`)
    else if (memoryRate <= 0.25) reasons.push(`该公司历史回复率低（${rateText}%）`)
    else reasons.push(`该公司历史回复率中等（${rateText}%）`)
  }

  if (pref >= 0.8) reasons.push('命中目标岗位/城市')
  else if (pref <= 0.25 && (profile.targetTitles ?? []).length + (profile.targetCities ?? []).length > 0) reasons.push('与目标岗位/城市偏差较大')

  let tier: JobTier
  if (worthScore >= TIER_THRESHOLDS.recommend) tier = 'recommend'
  else if (worthScore >= TIER_THRESHOLDS.watch) tier = 'watch'
  else tier = 'mismatch'

  return {
    jobId: job.id,
    jobTitle: job.title,
    companyName: job.companyName,
    worthScore,
    tier,
    reasons,
    matchScore: match.score,
  }
}

/** 内部复用记忆回复率（避免循环依赖） */
function memoryReplyRateLocal(memory?: CompanyMemory): number {
  if (!memory || memory.touchCount === 0) return 0.5
  return memory.replyCount / memory.touchCount
}

/** 选岗 Agent：批量筛选 TOP-N 值得投岗位（B1 调度入口） */
export function selectTopJobs(
  jobs: JobCard[],
  matches: Map<string, MatchResult>,
  profile: UserJobProfile,
  memories: Map<string, CompanyMemory>,
  topN = 10,
): JobEvaluation[] {
  const evaluations = jobs
    .map((job) => evaluateJobWorth(job, matches.get(job.id)!, profile, memories.get(job.companyName)))
    .filter((e) => e.tier !== 'mismatch')
    .sort((a, b) => b.worthScore - a.worthScore)
  return evaluations.slice(0, topN)
}
