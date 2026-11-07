/**
 * 目标产能：「N 小时内必须投满 M 份简历」。
 *
 * 诚实边界：系统不能凭空变出岗位，也无法绕过平台登录态 / 风控 / 岗位供给，
 * 所以这里做的是**可达性预判 + 自动调速 + 到点诊断**，而不是虚假的「保证达标」：
 *  1. 按剩余时间 / 剩余份数算出「每份最多能花多久」，压缩拟人间歇（有防风控下限）；
 *  2. 进度落后时自动跳过模拟真人休息，把时间还给投递；
 *  3. 按当前节奏预测完成时刻，赶不上就明确预警并给出可操作的建议；
 *  4. 到点没完成一次性给诊断，不静默、不刷屏。
 *
 * 倒计时从**本轮 campaign 启动**开始，参数不变则重启 / 暂停后沿用同一个 startedAt。
 */
import type { RestPolicy } from './rest-policy'
import { estimateRemainingMs } from './rest-policy'

export const CAPACITY_GOAL_KEY = 'aibotCapacityGoal'

export interface CapacityGoal {
  enabled: boolean
  /** 时限（小时） */
  hours: number
  /** 目标份数（平台已确认投递数） */
  targetJobs: number
}

export const DEFAULT_CAPACITY_GOAL: CapacityGoal = {
  enabled: false,
  hours: 8,
  targetJobs: 80,
}

export const MIN_CAPACITY_HOURS = 1
export const MAX_CAPACITY_HOURS = 24
export const MIN_CAPACITY_TARGET = 1
export const MAX_CAPACITY_TARGET = 500

/** 为了赶进度也不能把间隔压到 0，否则等于秒投，必然触发平台风控 */
export const MIN_PACING_INTERVAL_MS = 8_000

/** 脏数据 / 旧版本值统一收敛，避免 NaN 把调度算成 Infinity */
export function normalizeCapacityGoal(raw: unknown): CapacityGoal {
  const source = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const rawHours = Number(source.hours)
  const rawTarget = Number(source.targetJobs)
  return {
    enabled: source.enabled === true,
    hours: Number.isFinite(rawHours)
      ? Math.min(MAX_CAPACITY_HOURS, Math.max(MIN_CAPACITY_HOURS, Math.round(rawHours * 2) / 2))
      : DEFAULT_CAPACITY_GOAL.hours,
    targetJobs: Number.isFinite(rawTarget)
      ? Math.min(MAX_CAPACITY_TARGET, Math.max(MIN_CAPACITY_TARGET, Math.round(rawTarget)))
      : DEFAULT_CAPACITY_GOAL.targetJobs,
  }
}

export interface CapacityContext {
  goal: CapacityGoal
  now: number
  /** 本轮目标开始计时时刻 */
  startedAt: number
  /** 平台已确认投递数（只算 done） */
  applied: number
  /** 已启用平台配额合计；用于判断目标是否根本不可达 */
  totalQuota: number
  /** 当前策略下两份之间的平均间隔（毫秒） */
  baseIntervalMs: number
  policy: RestPolicy
  restEnabled: boolean
}

export type CapacityStatus = 'off' | 'on-track' | 'at-risk' | 'achieved' | 'missed'

export interface CapacityEvaluation {
  status: CapacityStatus
  deadlineAt: number
  elapsedMs: number
  remainingMs: number
  targetJobs: number
  remainingJobs: number
  /** 剩余时间平摊到剩余份数，每份最多能花多久 */
  requiredIntervalMs: number
  /** 留 15% 余量后的建议间隔，且不低于防风控下限 */
  suggestedIntervalMs: number
  /** 按当前节奏（含休息）预计完成时刻 */
  projectedFinishAt: number
  shouldSkipRest: boolean
  progressPercent: number
  advice: string
}

const HOUR_MS = 60 * 60_000

export function evaluateCapacityGoal(input: CapacityContext): CapacityEvaluation {
  const { goal, now, startedAt, applied, totalQuota, baseIntervalMs, policy, restEnabled } = input
  const deadlineAt = startedAt + goal.hours * HOUR_MS
  const elapsedMs = Math.max(0, now - startedAt)
  const remainingMs = Math.max(0, deadlineAt - now)
  const targetJobs = goal.targetJobs
  const remainingJobs = Math.max(0, targetJobs - Math.max(0, applied))
  const progressPercent = Math.min(100, Math.round((Math.max(0, applied) / Math.max(1, targetJobs)) * 100))
  const requiredIntervalMs = remainingJobs > 0 ? remainingMs / remainingJobs : 0
  const suggestedIntervalMs = Math.max(
    MIN_PACING_INTERVAL_MS,
    Math.min(baseIntervalMs, Math.round(requiredIntervalMs * 0.85)),
  )
  const projectedDurationMs = estimateRemainingMs(
    remainingJobs,
    Math.max(1, baseIntervalMs),
    policy,
    restEnabled,
  )
  const projectedFinishAt = now + projectedDurationMs

  const base: CapacityEvaluation = {
    status: 'off',
    deadlineAt,
    elapsedMs,
    remainingMs,
    targetJobs,
    remainingJobs,
    requiredIntervalMs,
    suggestedIntervalMs,
    projectedFinishAt,
    shouldSkipRest: false,
    progressPercent,
    advice: '',
  }

  if (!goal.enabled) return base

  if (remainingJobs === 0) {
    const aheadMins = Math.round(remainingMs / 60_000)
    return {
      ...base,
      status: 'achieved',
      advice: aheadMins > 0 ? `已达成目标，比截止提前约 ${aheadMins} 分钟` : '已达成目标',
    }
  }

  if (remainingMs <= 0) {
    return {
      ...base,
      status: 'missed',
      advice: `截止只完成 ${applied}/${targetJobs}，还差 ${remainingJobs} 份；请查看日志里的「未记为投递成功」「没有发现新岗位」与登录态提示`,
    }
  }

  const quotaShort = totalQuota > 0 && targetJobs > totalQuota
    ? `目标 ${targetJobs} 份超过当前已开启平台配额合计 ${totalQuota}，请先在「平台与配额」调高数量；`
    : ''

  if (projectedFinishAt > deadlineAt) {
    const projectedHours = (projectedDurationMs / HOUR_MS).toFixed(1)
    return {
      ...base,
      status: 'at-risk',
      shouldSkipRest: true,
      advice: `${quotaShort}按当前节奏预计还要 ${projectedHours} 小时，赶不上 ${goal.hours} 小时目标；已自动压缩间隔并跳过模拟休息，建议放宽「岗位名称」、开启更多平台或下调目标`,
    }
  }

  return {
    ...base,
    status: 'on-track',
    advice: quotaShort
      ? quotaShort
      : `按当前节奏可在截止前完成，剩余约 ${Math.round(remainingMs / 60_000)} 分钟 / ${remainingJobs} 份`,
  }
}

/** 把随机拟人间隔压缩到目标允许的范围，永远不低于防风控下限 */
export function resolvePacingInterval(baseIntervalMs: number, evaluation: CapacityEvaluation): number {
  if (
    evaluation.status === 'off' ||
    evaluation.status === 'achieved' ||
    evaluation.status === 'missed' ||
    evaluation.remainingJobs <= 0
  ) {
    return baseIntervalMs
  }
  return Math.max(MIN_PACING_INTERVAL_MS, Math.min(baseIntervalMs, evaluation.suggestedIntervalMs))
}

/** 一行状态摘要，UI 与日志共用，避免两处文案漂移 */
export function describeCapacityStatus(evaluation: CapacityEvaluation, goal: CapacityGoal): string {
  switch (evaluation.status) {
    case 'off':
      return '未设定目标产能'
    case 'achieved':
      return `已投满 ${evaluation.targetJobs} 份，目标达成`
    case 'missed':
      return `未达成：${evaluation.targetJobs - evaluation.remainingJobs}/${evaluation.targetJobs} 份`
    case 'at-risk':
      return `进度落后 ${evaluation.targetJobs - evaluation.remainingJobs}/${evaluation.targetJobs} · 已自动加速`
    default:
      return `${evaluation.targetJobs - evaluation.remainingJobs}/${evaluation.targetJobs} 份 · ${goal.hours} 小时内`
  }
}
