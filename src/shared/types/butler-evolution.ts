// 结构化管家日报与高级感知进化策略类型定义

/** 结构化管家日报 */
export interface ButlerDailyReport {
  id: string // "report_YYYY-MM-DD"
  date: string // "2026-11-03"
  createdAt: string
  trigger: 'scheduled' | 'campaign_finished' | 'manual'
  summary: string // 一句话宏观战报与态势总结
  funnel: {
    scanned: number // 扫描发现总岗位数
    filtered: number // AI 筛除/跳过不合适岗位
    applied: number // 发起打招呼沟通数
    read: number // HR 已读数
    communicating: number // 深入沟通中数
    interview: number // 面试邀请数
    replyRate: number // 今日回复转化率 (%)
  }
  platformBreakdown: Record<string, {
    applied: number
    replied: number
    quotaUsed: number
    quotaTotal: number
  }>
  guardrailStatus: {
    safetyScore: number // 安全运行评分 (满分 100)
    intervalRange: string // 拟人间歇范围 (如 "45-180s")
    captchaEncounters: number // 遭遇验证码次数
    rateLimitTrips: number // 触发频率告警次数
    riskAborts: number // 异常熔断次数
    safeStatusText: string // "未触发任何风控，拟人隐蔽运行 100%"
  }
  highlights: string[] // 今日高光战报（高分岗位、标杆公司回复）
  diagnostics: string[] // 问题诊断与归因分析
  nextDayActionPlan: {
    focusTitles: string[] // 建议重点聚焦岗位
    recommendedHours: string // 建议主攻时间段
    suggestedQuota: number // 明日建议配额
    keyTips: string[] // 策略优化提醒
  }
}

/** 管家日报自动生成时机配置 */
export interface DailyReportConfig {
  autoGenerate: boolean // 是否开启全自动生成
  scheduledTime: string // 每日定时生成时间，默认 "18:00"
  triggerOnCampaignFinished: boolean // 当天 AIbot 投递活动跑完后是否立即自动生成
  lastGeneratedDate?: string // 最近一次生成的日期 YYYY-MM-DD
}

/** 默认日报定时配置 */
export const DEFAULT_DAILY_REPORT_CONFIG: DailyReportConfig = {
  autoGenerate: true,
  scheduledTime: '18:00',
  triggerOnCampaignFinished: true,
}

/** 策略进化提案类型 */
export type EvolutionProposalType =
  | 'skill_keyword' // 技术词学习（如加入特定关键词后回复率提高 40%）
  | 'strategic_pivot' // 战略方向跃迁（如建议从纯后端转向全栈）
  | 'greeting_upgrade' // 打招呼话术进化（如针对特定行业突出项目闭环）
  | 'platform_weight' // 平台权重再平衡（根据各平台反馈调整侧重点）

/** 进化提案 */
export interface EvolutionProposal {
  id: string
  type: EvolutionProposalType
  title: string
  categoryBadge: string // "技术词学习" | "方向跃迁" | "话术进化" | "平台策略"
  insight: string // 归纳感知的数据支撑证据（如收集 500 个岗位 JD，发现添加该技术词后回复率提高 40%）
  evidenceStats: {
    sampleSize: number // 样本数（如 500 个岗位 JD）
    metricName: string // 指标名称（如 "沟通回复率"）
    beforeValue: string // 优化前表现（如 "16.5%"）
    afterValue: string // 优化后预期表现（如 "38.2%"）
    liftRate: string // 提升幅度（如 "+40%"）
  }
  recommendation: string // 建议策略细节
  diff: {
    before: string // 变更前
    after: string // 变更后
    targetField: 'skills' | 'targetTitles' | 'greetingTemplate' | 'searchKeywords'
  }
  guardrails: string[] // 必须遵守的安全护栏（保持拟人间歇、单平台每日配额上限、工作时段限制等）
  status: 'pending' | 'accepted' | 'rejected'
  createdAt: string
  respondedAt?: string
  humanDecisionNote?: string // 人的决策备注
}
