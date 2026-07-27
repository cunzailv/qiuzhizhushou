export interface PluginSettings {
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

  // 单次扫描（采集）的最大岗位数量。0 表示不限制（扫描到页面无更多为止）。
  maxScanCount: number

  // Apply mode
  applyMode: 'batch' | 'recommend'

  // Whether AI scoring is used when applying. When false, jobs are sent
  // directly without scoring ("不评分直接投"). Used as the default for the
  // one-click apply (popup + floating panel).
  enableAiMatch: boolean

  // Notification settings
  interviewReminder: boolean
  reminderMinutes: number
}

export const DEFAULT_SETTINGS: PluginSettings = {
  modelPreset: 'deepseek',
  apiBaseUrl: 'https://api.deepseek.com/v1',
  apiKey: '',
  modelName: 'deepseek-chat',
  aiEnabled: false,
  dailyLimit: 10000,
  minDelay: 2000,
  maxDelay: 8000,
  scrollDelay: 1500,
  maxScanCount: 50,
  applyMode: 'recommend',
  enableAiMatch: true,
  interviewReminder: true,
  reminderMinutes: 30,
}
