export interface JobCard {
  id: string
  title: string
  companyName: string
  companyLogo: string
  salary: string
  location: string
  experience: string
  education: string
  tags: string[]
  jobDescription: string
  // 评分/分析用文本（列表页卡片场景下为标题+薪资+标签的拼凑文本，用于匹配兜底；
  // 详情页或投递时提取到真实 JD 后，评分统一优先使用 jobDescription）
  matchingText?: string
  bossName: string
  bossTitle: string
  bossOnline: boolean
  publishedAt: string
  url: string
  // 所属平台 id（如 boss / liepin），用于多平台区分
  platformId?: string
  // A2: AI JD 理解产物（职责/硬性要求/加分项/技能分级/薪资年限学历）
  requirements?: JdRequirements
}

/**
 * 评分/分析用的岗位文本：
 * 优先真实 JD（jobDescription，详情页提取后通常比拼凑文本长），
 * 否则回退列表页拼凑的匹配文本（matchingText），保证搜索卡片场景评分不退化。
 */
export function getJobScoringText(job: Pick<JobCard, 'jobDescription' | 'matchingText'>): string {
  const raw = (job.jobDescription || '').trim()
  const fallback = (job.matchingText || '').trim()
  if (!raw) return fallback
  if (!fallback) return raw
  return raw.length >= fallback.length ? raw : fallback
}

// ─── A2: AI JD 理解（结构化岗位要求） ───

export interface JdSkill {
  skill: string
  /** true=必须（must-have），false=加分项（nice-to-have） */
  required: boolean
}

export interface JdRequirements {
  /** 岗位职责 */
  responsibilities: string[]
  /** 硬性要求（学历/年限/证书/工具等任职资格） */
  hardRequirements: string[]
  /** 加分项（优先条件） */
  niceToHave: string[]
  /** 学历下限（如 本科/硕士/不限） */
  education: string
  /** 年限下限（年） */
  experienceYears: number
  /** 薪资下限（元/月，null=未标注） */
  salaryMin: number | null
  /** 薪资上限（元/月，null=未标注） */
  salaryMax: number | null
  /** 技能清单 + 是否必须 */
  skills: JdSkill[]
  /** 解析来源：local / ai / hybrid */
  source: 'local' | 'ai' | 'hybrid'
  parsedAt: string
}

// ─── A3: 可解释匹配结果 ───

export interface MatchDimensions {
  /** 技能匹配 0-45 */
  skills: number
  /** 文本相似度 0-15 */
  similarity: number
  /** 方向对齐（岗位标题 vs 简历方向） 0-20 */
  direction: number
  /** 经验对齐（简历年限 vs 岗位年限下限） 0-12 */
  experience: number
  /** 学历对齐（简历最高学历 vs 岗位学历下限） 0-8 */
  education: number
}

export interface MatchResult {
  jobId: string
  score: number
  scoreBypassed?: boolean
  skillMatch: string[]
  skillGap: string[]
  recommendation: string
  isRecommended: boolean
  /** A3: 硬门槛拦截结果（学历/年限不达标） */
  hardGate?: { passed: boolean; reasons: string[] }
  /** A3: 可解释分维度得分 */
  dimensions?: MatchDimensions
}
