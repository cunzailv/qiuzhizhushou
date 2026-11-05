// 求职者预设画像与底线配置类型定义

// ─── 声明式自主授权契约 ───
// 由用户事前编写，运行时查表判定；未启用时完全不干预既有权限逻辑。
// 规则：fail-closed（不确定一律停下问）、事实只读、硬锁不可下放。
export type GrantLevel = 'auto' | 'confirm' | 'deny'

export type StrategyTuneKey = 'keywords' | 'threshold' | 'platformWeights' | 'greeting'

export interface AuthorizationPolicy {
  /** 总开关：默认 false，用户主动开启后才接管权限判定 */
  enabled: boolean
  /** 用户最后确认时间；超过 14 天自动降级为需确认 */
  updatedAt: string
  facts: {
    source: 'resume_only'
    /** 恒为 false：AI 只能引用用户填写的事实，不能改写或新增 */
    allowRewrite: false
  }
  reply: {
    mode: 'suggest' | 'auto_fill' | 'safe_auto_reply'
    allowedTopics: string[]
    forbidTopics: string[]
    maxPerDay: number
  }
  strategy: {
    /** 区间内是否自动投递 */
    apply: GrantLevel
    dailyQuotaMax: number
    matchThresholdMin: number
    allowedTitles: string[]
    mayTune: StrategyTuneKey[]
  }
  /** 硬锁：UI 只读展示，不提供 auto 选项 */
  locks: {
    resumeFactEdit: 'deny'
    offerDecision: 'confirm'
    salaryNegotiation: 'confirm'
    riskControlBypass: 'deny'
  }
}

export const DEFAULT_AUTHORIZATION_POLICY: AuthorizationPolicy = {
  enabled: false,
  updatedAt: '',
  facts: { source: 'resume_only', allowRewrite: false },
  reply: {
    mode: 'suggest',
    allowedTopics: ['在职状态', '最快到岗', '期望薪资', '项目概述', '打招呼', '发送'],
    forbidTopics: ['薪资流水', '离职原因细节', '家庭情况'],
    maxPerDay: 10,
  },
  strategy: {
    apply: 'confirm',
    dailyQuotaMax: 20,
    matchThresholdMin: 60,
    allowedTitles: [],
    mayTune: ['keywords', 'greeting'],
  },
  locks: {
    resumeFactEdit: 'deny',
    offerDecision: 'confirm',
    salaryNegotiation: 'confirm',
    riskControlBypass: 'deny',
  },
}

export type EmploymentStatus =
  | 'unemployed_immediate' // 离职-随时到岗
  | 'unemployed_week' // 离职-1周内到岗
  | 'employed_month' // 在职-月内到岗
  | 'employed_exploring' // 在职-考虑机会
  | 'other' // 其它

export type AvailableDaysOption =
  | '随时到岗'
  | '3天内到岗'
  | '1周内到岗'
  | '2周内到岗'
  | '1个月内到岗'
  | '待协商'

export interface BottomLineOption {
  id: string
  label: string
  description?: string
  keywords: string[]
}

export const PRESET_BOTTOM_LINES: BottomLineOption[] = [
  {
    id: 'no_outsourcing',
    label: '不接受外包/人力派遣',
    description: '非甲方自研、劳务派遣、驻场外包等岗位一律婉拒',
    keywords: ['外包', '派遣', '驻场', '人力外包', '项目外包'],
  },
  {
    id: 'no_single_rest',
    label: '不接受单休/大小周/996',
    description: '严格要求双休，拒绝单休及严重加班制度',
    keywords: ['单休', '大小周', '996', '隔周休', '无调休'],
  },
  {
    id: 'need_social_fund',
    label: '必须缴纳全额五险一金',
    description: '试用期不交社保、按最低基数交或无公积金者婉拒',
    keywords: ['无社保', '无公积金', '转正后交', '试用期不交'],
  },
  {
    id: 'no_pure_commission',
    label: '不接受纯提成/无底薪',
    description: '必须具备合理的基础月薪保障',
    keywords: ['纯提成', '无底薪', '合伙人提成', '全提成'],
  },
  {
    id: 'no_long_business_trip',
    label: '不接受长期外地出差',
    description: '要求常驻本地工作，拒绝常年异地外派',
    keywords: ['长期出差', '常驻外地', '全国出差', '外派异地'],
  },
]

export interface CandidateProfilePreferences {
  /** 当前求职状态 */
  employmentStatus: EmploymentStatus
  /** 最快到岗周期 */
  availableDays: AvailableDaysOption
  /** 期望最低月薪（K，如 15） */
  expectedSalaryMin: number | null
  /** 期望最高月薪（K，如 20） */
  expectedSalaryMax: number | null
  /** 当前或上一份月薪（K，可选） */
  currentSalary?: number | null
  /** 勾选的底线标签 ID 清单 */
  bottomLines: string[]
  /** 自定义补充底线要求（自由文本） */
  customBottomLines: string
  /** 应答辅助模式：'suggest' 建议气泡 / 'auto_fill' 填入输入框 / 'safe_auto_reply' 安全自动发送 */
  copilotMode: 'suggest' | 'auto_fill' | 'safe_auto_reply'
  /** 面试应约联系方式（手机号/微信号） */
  contactInfo: string
  /** 可选：声明式自主授权契约（仅在 enabled=true 时生效） */
  authorization?: AuthorizationPolicy
}

export const DEFAULT_CANDIDATE_PREFERENCES: CandidateProfilePreferences = {
  employmentStatus: 'unemployed_immediate',
  availableDays: '1周内到岗',
  expectedSalaryMin: 15,
  expectedSalaryMax: 20,
  currentSalary: null,
  bottomLines: ['no_outsourcing', 'no_single_rest'],
  customBottomLines: '',
  copilotMode: 'suggest',
  contactInfo: '',
}
