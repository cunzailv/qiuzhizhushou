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
