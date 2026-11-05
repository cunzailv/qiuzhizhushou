import {
  CONSERVATIVE_VALUES,
  DEFAULT_SAFETY_PROFILE,
  type SafetyProfileId,
} from './safety-preset'

export interface PluginSettings {
  /**
   * 安全阀档位：conservative / standard / aggressive / custom。
   * 只是「参数来源」的标记，真正生效的仍是下面的具体数值；
   * 用户手改任一项节奏参数后应置为 custom（见 detectSafetyProfile）。
   */
  safetyProfile: SafetyProfileId

  // AI API settings
  modelPreset: string          // 预设模型 ID（内置模型的 key）
  apiBaseUrl: string           // 自定义时覆盖
  apiKey: string
  modelName: string            // 自定义时覆盖
  aiEnabled: boolean

  // Anti-bot settings
  dailyLimit: number
  minDelay: number
  maxDelay: number
  scrollDelay: number

  // 分平台每日配额与延迟配置
  platformQuotas?: Record<string, number>
  platformDelays?: Record<string, { minDelayMs: number; maxDelayMs: number }>
  campaignWindows?: Array<{ start: number; end: number }>

  // 单次扫描（采集）的最大岗位数量。0 表示不限制（扫描到页面无更多为止）。
  maxScanCount: number

  // Apply mode
  applyMode: 'batch' | 'recommend'

  // 悬浮窗统一控制状态（与 AIbot 配置页、页面浮窗双向同步）
  panelState: 'expanded' | 'collapsed' | 'closed'
  liepinResumeMode: boolean

  // Whether AI scoring is used when applying. When false, jobs are sent
  // directly without scoring ("不评分直接投"). Used as the default for the
  // one-click apply (popup + floating panel).
  enableAiMatch: boolean

  // Notification settings
  interviewReminder: boolean
  reminderMinutes: number

  // C4: AI 每日调用预算上限（超限自动回退本地）
  aiDailyBudget: number
}

export const DEFAULT_SETTINGS: PluginSettings = {
  // 节奏参数统一取「保守档」，避免首次安装就以激进参数跑（原默认 dailyLimit 10000 / 2-8s）
  ...CONSERVATIVE_VALUES,
  safetyProfile: DEFAULT_SAFETY_PROFILE,
  modelPreset: 'deepseek',
  apiBaseUrl: 'https://api.deepseek.com/v1',
  apiKey: '',
  modelName: 'deepseek-chat',
  aiEnabled: false,
  panelState: 'expanded',
  liepinResumeMode: false,
  enableAiMatch: true,
  interviewReminder: true,
  reminderMinutes: 30,
}
