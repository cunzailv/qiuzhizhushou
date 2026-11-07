/**
 * 必达模式的「可控参数自动接管」纯函数底座。
 *
 * 设定目标后，系统不能再拿「配额不够 / 只开了一个平台 / 平台被标日限」当停机理有：
 * 这些全是插件自己能改的参数。这里只算**该改成什么**，实际写盘由后台服务负责，
 * 保证策略可单测、可复现，不夹杂 storage 副作用。
 */
import type { PlatformId } from './quota'
import type { ApplyFilters } from '../types/filters'
import { MAX_PLATFORM_QUOTA, MIN_PLATFORM_QUOTA } from './quota'

/** 目标之外预留的余量，避免「刚好 80 份配额，中途跳过几个就卡死」 */
export const MUST_ACHIEVE_HEADROOM_RATIO = 0.25
export const MUST_ACHIEVE_MIN_HEADROOM = 10

/** 必达模式每轮每平台采集上限（常规 35），供给不足时先把池子放大 */
export const MUST_ACHIEVE_MAX_JOBS = 50

/**
 * 必达模式下本地匹配分只用于排序，**不再当否决闸门**（0 分也照投）。
 * 采集层的方向 / 技术栈 / 黑名单硬约束仍然生效，所以这不是「乱投」，
 * 只是不再让「本地规则分量纲偏低」这一可控参数挡住目标。
 */
export const MUST_ACHIEVE_MATCH_THRESHOLD = 0

export interface MustAchieveQuotaState {
  quota: number
  applied: number
  exhausted: boolean
  enabled: boolean
}

export type MustAchieveQuotaMap = Partial<Record<PlatformId, MustAchieveQuotaState>>

export interface MustAchievePlan {
  /** 是否需要写盘（幂等：条件已满足时返回 false，避免每 tick 刷日志） */
  changed: boolean
  /** 只含有变化的平台配额 */
  quotas: Partial<Record<PlatformId, number>>
  /** 需要额外开启的平台 */
  enablePlatforms: PlatformId[]
  /** 需要解除「日限耗尽」标记的平台 */
  revivePlatforms: PlatformId[]
  /** 规划后的已启用配额合计 */
  plannedTotalQuota: number
  /** 人类可读的接管说明，直接写进行为日志 */
  reasons: string[]
}

/**
 * 规划「必达」所需的配额与平台开关。
 *
 * 规则：
 *  - 目标之外留 25%（至少 10 份）余量，覆盖跳过 / 未确认 / 重复岗位；
 *  - 平台一律全开（用户仍可在面板手动关，但下一次规划会重新拉起，因为目标必须达成）；
 *  - 配额只升不降，平均分摊到所有平台，单平台不超过 500；
 *  - 已投数未达新上限的 exhausted 平台解除耗尽标记，继续参与调度。
 */
export function planMustAchieveQuotas(
  quotas: MustAchieveQuotaMap,
  targetJobs: number,
  opts: {
    maxPerPlatform?: number
    headroomRatio?: number
    /** 全平台日限冷却期内置 false：只重新规划配额，不立刻复活被限流的平台 */
    allowRevive?: boolean
  } = {},
): MustAchievePlan {
  const ids = Object.keys(quotas) as PlatformId[]
  const maxPerPlatform = Math.max(MIN_PLATFORM_QUOTA, opts.maxPerPlatform ?? MAX_PLATFORM_QUOTA)
  const ratio = Math.max(0, opts.headroomRatio ?? MUST_ACHIEVE_HEADROOM_RATIO)
  const headroom = Math.max(
    MUST_ACHIEVE_MIN_HEADROOM,
    Math.ceil(Math.max(0, targetJobs) * ratio),
  )
  const desiredTotal = Math.max(0, targetJobs) + headroom
  const perPlatform = ids.length > 0
    ? Math.min(maxPerPlatform, Math.max(MIN_PLATFORM_QUOTA, Math.ceil(desiredTotal / ids.length)))
    : 0

  const nextQuotas: Partial<Record<PlatformId, number>> = {}
  const enablePlatforms: PlatformId[] = []
  const revivePlatforms: PlatformId[] = []
  const reasons: string[] = []
  let plannedTotalQuota = 0

  for (const pid of ids) {
    const state = quotas[pid]
    if (!state) continue
    const current = Number.isFinite(state.quota) ? state.quota : 0
    // 上限只约束「新规划出来的分摊值」，不能把用户已设的更高配额压小：
    // 必达模式是接管加码，不是覆盖用户配置。
    const next = Math.max(current, Math.min(maxPerPlatform, perPlatform))
    if (next !== current) nextQuotas[pid] = next
    if (state.enabled === false) enablePlatforms.push(pid)
    if (opts.allowRevive !== false && state.exhausted && (Number(state.applied) || 0) < next) {
      revivePlatforms.push(pid)
    }
    plannedTotalQuota += next
  }

  if (Object.keys(nextQuotas).length > 0) {
    reasons.push(`配额抬到合计 ${plannedTotalQuota}（目标 ${targetJobs} + 余量 ${headroom}）`)
  }
  if (enablePlatforms.length > 0) reasons.push(`开启 ${enablePlatforms.length} 个未启用平台`)
  if (revivePlatforms.length > 0) reasons.push(`解除 ${revivePlatforms.length} 个平台的日限标记`)

  return {
    changed:
      Object.keys(nextQuotas).length > 0 ||
      enablePlatforms.length > 0 ||
      revivePlatforms.length > 0,
    quotas: nextQuotas,
    enablePlatforms,
    revivePlatforms,
    plannedTotalQuota,
    reasons,
  }
}

/** 目标未达成时，是否应该忽略用户设置的工作时段（必达模式自动放行） */
export function shouldBypassWorkWindow(mustAchieve: boolean, achieved: boolean): boolean {
  return mustAchieve && !achieved
}

/** 必达模式下「平台日限全部耗尽」的重试冷却，避免每 30 秒狂点同一个被限流的平台 */
export const MUST_ACHIEVE_EXHAUSTED_COOLDOWN_MS = 10 * 60_000

/**
 * 只放宽**下发给采集层**的筛选副本，绝不改写用户保存在设置里的原始偏好。
 * 活跃时间是典型可控参数：用户设「本周活跃」，供给不够时系统自己放宽到「不限时间」，
 * 薪资 / 地点 / 学历 / 经验 / 黑名单属于用户真实意愿，不动。
 */
export function relaxFiltersForMustAchieve<T extends ApplyFilters>(
  filters: T,
  mustAchieve: boolean,
): { filters: T; relaxed: string[] } {
  if (!mustAchieve) return { filters, relaxed: [] }
  const relaxed: string[] = []
  let next: T = filters
  if (filters.publishTime && filters.publishTime !== 'all') {
    next = { ...filters, publishTime: 'all' }
    relaxed.push(`活跃时间 ${filters.publishTime} → 不限时间`)
  }
  return { filters: next, relaxed }
}

/** 必达模式下匹配分不再否决；常规 / 产能优先仍走各自门槛 */
export function resolveMustAchieveMatchThreshold(
  baseThreshold: number,
  mustAchieve: boolean,
): number {
  return mustAchieve ? MUST_ACHIEVE_MATCH_THRESHOLD : Math.max(0, baseThreshold)
}

/**
 * 精投的本地语义硬闸门在必达模式下降级为「只统计不否决」。
 * 注意：技术栈硬约束在 evaluateJobCandidate 里独立生效，Java / 前端岗位依然被拦，
 * 所以放宽语义闸门不会退回「精投乱投前端 / Java」的老问题。
 */
export function shouldBypassRelevanceGate(mustAchieve: boolean): boolean {
  return mustAchieve
}

/** 「所有关键词都搜不到」时是否停机：必达模式永不停机，清掉无效标记继续换词 */
export function shouldKeepCollectingOnNoSource(mustAchieve: boolean): boolean {
  return mustAchieve
}

/** 必达模式不写 24 小时无效词标记，否则当天再怎么换词都被自己锁死 */
export function shouldMarkKeywordInvalid(mustAchieve: boolean): boolean {
  return !mustAchieve
}

/** 每轮采集上限：必达模式把候选池放大 */
export function resolveCollectMaxJobs(base: number, mustAchieve: boolean): number {
  return mustAchieve ? Math.max(base, MUST_ACHIEVE_MAX_JOBS) : base
}
