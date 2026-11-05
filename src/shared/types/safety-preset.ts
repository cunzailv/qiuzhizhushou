// 安全阀档位（Safety Preset）
// 目的：把「每日上限 / 操作延迟 / 单次扫描 / 沟通模式 / AI 预算」这 5 项节奏参数
// 打包成 3 个可直接选的档位，避免首次使用时逐项调数字，也避免默认值过于激进。
// 单一真源：任何地方需要这些参数的默认值，都从这里取，不要再写魔法数字。

export type SafetyProfileId = 'conservative' | 'standard' | 'aggressive' | 'custom'

/** 一个档位包含的全部节奏参数（与 PluginSettings 中的同名字段一一对应） */
export interface SafetyPresetValues {
  /** 每日沟通/投递总上限（次） */
  dailyLimit: number
  /** 单次操作最小间隔（ms） */
  minDelay: number
  /** 单次操作最大间隔（ms） */
  maxDelay: number
  /** 列表滚动间隔（ms） */
  scrollDelay: number
  /** 单次扫描采集的最大岗位数，0 = 不限制 */
  maxScanCount: number
  /** AI 每日调用预算（次） */
  aiDailyBudget: number
  /** 沟通模式：batch = 一键批量，recommend = AI 推荐后确认 */
  applyMode: 'batch' | 'recommend'
}

export interface SafetyPreset {
  id: Exclude<SafetyProfileId, 'custom'>
  label: string
  tagline: string
  description: string
  /** 风险提示，UI 上以警示色展示 */
  warning?: string
  values: SafetyPresetValues
}

export const SAFETY_PRESETS: Record<Exclude<SafetyProfileId, 'custom'>, SafetyPreset> = {
  conservative: {
    id: 'conservative',
    label: '保守',
    tagline: '默认 · 新号/正式号首选',
    description: '每天 30 次以内，间隔 5-15 秒，先只扫描 20 个岗位，沟通前需你确认。跑一周没有异常再考虑上调。',
    values: {
      dailyLimit: 30,
      minDelay: 5000,
      maxDelay: 15000,
      scrollDelay: 2000,
      maxScanCount: 20,
      aiDailyBudget: 30,
      applyMode: 'recommend',
    },
  },
  standard: {
    id: 'standard',
    label: '标准',
    tagline: '已稳定使用 2 周以上',
    description: '每天 60 次以内，间隔 3-10 秒，单次扫描 50 个，一键批量沟通。适合已确认账号无风控提示的用户。',
    values: {
      dailyLimit: 60,
      minDelay: 3000,
      maxDelay: 10000,
      scrollDelay: 1500,
      maxScanCount: 50,
      aiDailyBudget: 50,
      applyMode: 'batch',
    },
  },
  aggressive: {
    id: 'aggressive',
    label: '激进',
    tagline: '不建议 · 有封号风险',
    description: '每天 100 次以内，间隔 2-8 秒，单次扫描 100 个。仅建议小号/测试账号使用。',
    warning: '此档位会显著提高平台风控命中概率，出现验证码或"操作频繁"提示请立即降级到保守档。',
    values: {
      dailyLimit: 100,
      minDelay: 2000,
      maxDelay: 8000,
      scrollDelay: 1500,
      maxScanCount: 100,
      aiDailyBudget: 100,
      applyMode: 'batch',
    },
  },
}

/** 默认档位：保守。首次安装、以及所有兜底默认值都以它为准。 */
export const DEFAULT_SAFETY_PROFILE: SafetyProfileId = 'conservative'

/** 保守档参数，作为全项目节奏参数的兜底常量 */
export const CONSERVATIVE_VALUES: SafetyPresetValues = SAFETY_PRESETS.conservative.values

export const SAFETY_PROFILE_LABELS: Record<SafetyProfileId, string> = {
  conservative: '保守',
  standard: '标准',
  aggressive: '激进',
  custom: '自定义',
}

export function getSafetyPreset(id: string | undefined | null): SafetyPreset | undefined {
  if (!id || id === 'custom') return undefined
  return SAFETY_PRESETS[id as Exclude<SafetyProfileId, 'custom'>]
}

/** 节奏参数命中哪一档？完全一致返回档位 id，否则 custom */
export function detectSafetyProfile(values: Partial<SafetyPresetValues>): SafetyProfileId {
  for (const preset of Object.values(SAFETY_PRESETS)) {
    const hit = (Object.keys(preset.values) as Array<keyof SafetyPresetValues>).every(
      (k) => values[k] === undefined || values[k] === preset.values[k],
    )
    if (hit) return preset.id
  }
  return 'custom'
}
