/**
 * 投递策略：让用户在启动前明确选择「精投」还是「海投」，
 * 而不是由系统替用户决定。两者在节奏、评分方式、话术生成与门槛上成套切换，
 * 避免出现「参数互相打架」的中间状态（例如海投的间隔配精投的门槛）。
 */
import type { IntervalConfig } from './quota'
import { saveIntervalConfig } from './quota'
import { getSetting, setSetting } from '../db/settings-store'
import { persistSharedFilters } from './filter-config'
import { AI_MATCH_KEY, LEGACY_AI_MATCH_KEY } from './filter-config'

export type DeliveryStrategy = 'precision' | 'volume'

export interface StrategyProfile {
  id: DeliveryStrategy
  label: string
  tagline: string
  description: string
  /** 单岗位间隔（秒） */
  minSeconds: number
  maxSeconds: number
  /** true = 跳过 AI 语义评分与 AI 话术，用本地评分 + 平台模板 */
  fastMode: boolean
  /** 最低匹配分 */
  minMatchScore: number
  /** 是否启用 AI 语义评分 */
  useAiMatch: boolean
}

export const STRATEGY_STORAGE_KEY = 'aibot_delivery_strategy'

export const STRATEGY_PROFILES: Record<DeliveryStrategy, StrategyProfile> = {
  precision: {
    id: 'precision',
    label: '精投',
    tagline: 'AI 逐岗判断，宁缺毋滥',
    description: '每个岗位都让 AI 打分并生成个性化开场白，只投匹配度高的；节奏慢，适合回复率优先。',
    minSeconds: 45,
    maxSeconds: 180,
    fastMode: false,
    minMatchScore: 60,
    useAiMatch: true,
  },
  volume: {
    id: 'volume',
    label: '海投',
    tagline: '先把量铺开，快速连投',
    description: '本地规则快速评分 + 平台模板开场白，门槛降到 25，15-45 秒投一个；适合尽快拿到面试机会。',
    minSeconds: 15,
    maxSeconds: 45,
    fastMode: true,
    minMatchScore: 25,
    useAiMatch: false,
  },
}

/** 读取用户已选择的策略；null 表示还没做过选择，需要引导 */
export async function getDeliveryStrategy(): Promise<DeliveryStrategy | null> {
  const saved = await getSetting<string>(STRATEGY_STORAGE_KEY, '')
  return saved === 'precision' || saved === 'volume' ? saved : null
}

/** 把策略成套写入配置（间隔 / 门槛 / 极速开关 / AI 评分），保证参数一致 */
export async function applyDeliveryStrategy(strategy: DeliveryStrategy): Promise<StrategyProfile> {
  const profile = STRATEGY_PROFILES[strategy]
  const interval: IntervalConfig = { minSeconds: profile.minSeconds, maxSeconds: profile.maxSeconds }

  await saveIntervalConfig(interval)
  await setSetting(STRATEGY_STORAGE_KEY, strategy)
  await setSetting('aibotFastMode', profile.fastMode)
  await persistSharedFilters({ minMatchScore: profile.minMatchScore })
  await setSetting(AI_MATCH_KEY, profile.useAiMatch)
  await setSetting(LEGACY_AI_MATCH_KEY, profile.useAiMatch)

  return profile
}

/** 当前策略展示用（未选择时回退到精投的描述，但不会真的写入） */
export function describeStrategy(strategy: DeliveryStrategy | null): string {
  if (!strategy) return '尚未选择投递方式'
  return `${STRATEGY_PROFILES[strategy].label} · ${STRATEGY_PROFILES[strategy].tagline}`
}
