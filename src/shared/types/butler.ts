// ─── B 层 · 多角色求职管家 Agent 共享类型 ───

/** 用户求职目标画像（B1 管家的输入） */
export interface UserJobProfile {
  /** 目标岗位关键词，如 ["前端开发", "React"] */
  targetTitles?: string[]
  /** 目标城市，如 ["深圳", "北京"] */
  targetCities?: string[]
  /** 期望月薪下限（K） */
  salaryMin?: number
  /** 期望月薪上限（K） */
  salaryMax?: number
  /** 每日建议沟通配额 */
  dailyQuota?: number
  /** 附加偏好说明（AI 理解用） */
  notes?: string
}

/** 岗位值得投的分层（B2 选岗 Agent 产出，替代 60 分一刀切） */
export type JobTier = 'recommend' | 'watch' | 'mismatch'

export interface JobEvaluation {
  jobId: string
  jobTitle: string
  companyName: string
  /** 0-100 综合值得投分数 */
  worthScore: number
  tier: JobTier
  /** 分层理由（可解释、留痕） */
  reasons: string[]
  matchScore: number
}

/** 管家今日策略（B1 总协调产出） */
export interface ButlerStrategy {
  dailyQuota: number
  targetTitles: string[]
  targetCities: string[]
  /** 策略要点：配额分配、岗位/平台优先级 */
  priorities: string[]
  /** 一句话策略描述 */
  summary: string
  createdAt: string
}

/** 跟进建议（B4 跟进 Agent 产出） */
export interface FollowUpSuggestion {
  id: string
  applicationId: string
  companyName: string
  jobTitle: string
  /** 距投递天数 */
  daysSince: number
  status: string
  /** 跟进话术草稿（建议+确认，不自动发送） */
  draftMessage: string
  createdAt: string
  dismissed: boolean
}

/** 公司记忆（B6 记忆/画像 Agent 沉淀） */
export interface CompanyMemory {
  id: string
  companyName: string
  jobTitle?: string
  /** 接触次数 */
  touchCount: number
  /** 回复次数（有读/沟通/面试/Offer 状态推进计 1） */
  replyCount: number
  /** 最近结果标签：applied / read / communicating / interview / rejected / hired */
  lastOutcome?: string
  /** 上次更新时间 */
  updatedAt: string
  /** 经验性备注（AI 或用户补充） */
  notes?: string
}

/** AI/Agent 决策留痕（可复盘、可追溯） */
export interface DecisionLog {
  id: string
  /** 来源：selector / butler / chat / followup / apply-run */
  source: string
  /** 目标对象：岗位标题、公司名或场景描述 */
  subject: string
  /** 决策输入摘要 */
  context: string
  /** AI 思考 / 规则依据 */
  thinking: string
  /** 决策结果（JSON 字符串或摘要） */
  decision: string
  createdAt: string
}

/** 管家每日扫描结果（background BUTLER_SCAN 返回） */
export interface ButlerScanResult {
  scannedAt: string
  followUps: FollowUpSuggestion[]
  reportSummary: string
  decisionLogged: boolean
}
