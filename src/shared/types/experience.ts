// L3 经验记忆：从投递日志中提炼出的、可带证据检索的判断。
// 与 L1 事实记忆的区别：事实由用户编写、AI 只读；经验由 AI 归纳、必须带证据、会过期、用户可驳回。

export type ExperienceVerdict = 'prefer' | 'avoid'
export type ExperienceSource = 'review' | 'reflection' | 'user'

export interface Experience {
  id: string
  /** 可匹配的特征，如「JD 含外包驻场」「岗位名含 AI 全栈」 */
  pattern: string
  verdict: ExperienceVerdict
  /** 样本量；低于门槛不许写成结论，防止「投 1 个没回就否定一类岗位」 */
  sampleSize: number
  /** 该特征下的历史回复率（0-100） */
  replyRate: number
  /** 支撑该结论的投递记录 ID，供追溯与驳回 */
  evidenceIds: string[]
  source: ExperienceSource
  reason: string
  createdAt: string
  /** 过期时间；岗位方向变更或超期后不再参与规划 */
  expiresAt: string
  enabled: boolean
  /** 用户手工改过的条目，AI 归纳时不得覆盖 */
  userOverride?: boolean
}

/** 样本不足时不下结论 */
export const MIN_EXPERIENCE_SAMPLE = 5
/** 经验默认有效期（天） */
export const EXPERIENCE_TTL_DAYS = 30
