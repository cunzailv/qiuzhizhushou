/**
 * 模拟真人作息休息：可测的纯函数状态机。
 *
 * 历史 bug（「投了一天还没投满 80」的直接原因）：
 *  1. 休息分支只在内存里写 `campaign.restUntil = …` / `consecutiveRestCounter = 0`，
 *     紧接着 `appendCampaignLog()` 会 `getCampaign()` 从 storage 读旧副本并 `saveCampaign()`
 *     写回 —— 内存修改被整份覆盖，`restUntil` 从未落盘、连投计数从未清零。
 *     结果每个 5 分钟切片 tick 都「重新触发一次休息」，AIbot 永久卡在休息循环里。
 *  2. `restThreshold = 15 + random()*10` 写在 tick 里，每轮重新随机，行为不可复现。
 *  3. 休息节奏与「精投 / 海投」完全脱钩：海投 15-45 秒投一个，投 20 个只要 10 分钟，
 *     却照样休息 8-20 分钟 —— 休息比干活还久。
 *
 * 现在：阈值与休息到期时间都由调用方**原子持久化**；策略决定批次与时长；
 * 休息中不再每 5 分钟刷一条日志；休息结束立即恢复投递（不再空跑一整轮）。
 */
import type { DeliveryStrategy } from './delivery-strategy'

/** 是否启用模拟真人作息休息；默认开启（防风控），用户可在 AIbot 维护工具里关闭 */
export const REST_ENABLED_KEY = 'aibotRestEnabled'
export const DEFAULT_REST_ENABLED = true

/** 休息中日志的最小间隔，避免 5 分钟切片轮询刷屏 */
export const REST_NOTICE_INTERVAL_MS = 10 * 60_000

export interface RestPolicy {
  /** 本批连续投递多少份后休息（闭区间） */
  batchMin: number
  batchMax: number
  /** 休息时长（闭区间，毫秒） */
  restMinMs: number
  restMaxMs: number
  label: string
}

/** 精投：AI 逐岗判断本来就慢，保持较保守的防风控节奏 */
export const PRECISION_REST_POLICY: RestPolicy = {
  batchMin: 15,
  batchMax: 25,
  restMinMs: 8 * 60_000,
  restMaxMs: 20 * 60_000,
  label: '精投',
}

/** 海投：铺量优先，批次更大、休息更短，避免「休息比干活久」把产能吃掉 */
export const VOLUME_REST_POLICY: RestPolicy = {
  batchMin: 30,
  batchMax: 45,
  restMinMs: 3 * 60_000,
  restMaxMs: 6 * 60_000,
  label: '海投',
}

export function resolveRestPolicy(strategy: DeliveryStrategy | null | undefined): RestPolicy {
  return strategy === 'volume' ? VOLUME_REST_POLICY : PRECISION_REST_POLICY
}

/** 本批随机阈值（闭区间整数）；显式传 random 便于单测复现 */
export function pickRestThreshold(policy: RestPolicy, random: () => number = Math.random): number {
  const span = Math.max(0, policy.batchMax - policy.batchMin)
  return policy.batchMin + Math.floor(clamp01(random()) * (span + 1))
}

/** 本次随机休息时长（毫秒） */
export function pickRestDurationMs(policy: RestPolicy, random: () => number = Math.random): number {
  const span = Math.max(0, policy.restMaxMs - policy.restMinMs)
  return policy.restMinMs + Math.floor(clamp01(random()) * (span + 1))
}

export function pickInitialRestThreshold(
  policy: RestPolicy,
  random: () => number = Math.random,
): number {
  return pickRestThreshold(policy, random)
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(0.999999, Math.max(0, value))
}

export type RestDecision =
  | { kind: 'continue'; restThreshold?: number }
  | { kind: 'waiting'; remainingMs: number; shouldLog: boolean }
  | { kind: 'start-rest'; durationMs: number; threshold: number; nextThreshold: number }
  | { kind: 'resume' }

export interface RestState {
  now: number
  restUntil?: number
  consecutiveRestCounter: number
  /** 本批阈值；未落盘的旧 campaign 没有这个字段，需要补写一次 */
  restThreshold?: number
  lastRestNoticeAt?: number
  policy: RestPolicy
  enabled: boolean
  random?: () => number
}

/**
 * 判定本次 tick 该对「休息」做什么。
 * 纯函数：不读写 storage，所有需要持久化的结果显式返回给调用方。
 */
export function decideRest(state: RestState): RestDecision {
  const random = state.random ?? Math.random
  const policy = state.policy

  // 用户关掉休息：若正卡在休息里，立即恢复，不再白等
  if (!state.enabled) {
    return state.restUntil ? { kind: 'resume' } : { kind: 'continue' }
  }

  // 休息到期：清状态并**本轮就继续投递**，不再只 schedule 一轮空跑
  if (state.restUntil && state.restUntil <= state.now) {
    return { kind: 'resume' }
  }

  if (state.restUntil && state.restUntil > state.now) {
    const lastNotice = state.lastRestNoticeAt ?? 0
    return {
      kind: 'waiting',
      remainingMs: state.restUntil - state.now,
      shouldLog: state.now - lastNotice >= REST_NOTICE_INTERVAL_MS,
    }
  }

  // 旧 campaign 没有持久化阈值：补一个固定阈值，避免每 tick 重随机
  if (!state.restThreshold || !Number.isFinite(state.restThreshold)) {
    return { kind: 'continue', restThreshold: pickInitialRestThreshold(policy, random) }
  }

  if (state.consecutiveRestCounter >= state.restThreshold) {
    return {
      kind: 'start-rest',
      durationMs: pickRestDurationMs(policy, random),
      threshold: state.restThreshold,
      // 下一批阈值提前算好并一起落盘，保证行为可复现
      nextThreshold: pickRestThreshold(policy, random),
    }
  }

  return { kind: 'continue' }
}

/** 估算按当前节奏投满剩余配额需要多久（毫秒），只用于给用户可见的进度说明 */
export function estimateRemainingMs(
  remainingJobs: number,
  intervalMs: number,
  policy: RestPolicy,
  enabled: boolean,
): number {
  if (remainingJobs <= 0) return 0
  const base = remainingJobs * Math.max(1, intervalMs)
  if (!enabled) return base
  const batch = Math.max(1, Math.round((policy.batchMin + policy.batchMax) / 2))
  const avgRest = (policy.restMinMs + policy.restMaxMs) / 2
  return Math.round(base + Math.floor(remainingJobs / batch) * avgRest)
}
