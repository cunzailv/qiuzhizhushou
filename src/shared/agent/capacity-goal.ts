/**
 * 目标产能：「N 小时内投满 M 份简历」，默认开启**必达模式**。
 *
 * 必达模式是产品承诺，不是「尽力而为的节奏建议」：
 *  1. 设定目标即自动接管所有可控参数（切海投、抬配额、开全平台、放行工作时段、
 *     关闭模拟休息、压缩间隔但守住防风控下限）；
 *  2. 目标未达成前**不允许自行停机**：不计超时、不因队列空 / 配额满 / 日限而宣告完成；
 *     换页、换词、换平台、回收历史跳过岗位，一直跑到平台确认投递数达标；
 *  3. 只有平台侧物理挡死（登录失效 / 风控 / 全平台日限）才会进入「受阻但持续重试」，
 *     并明确报出卡在哪一步，绝不虚报成功；
 *  4. 达成后明确停机 + 通知。
 *
 * 倒计时从**本轮 campaign 启动**开始，参数不变则重启 / 暂停后沿用同一个 startedAt。
 * 超过设定时限只作为进度参考，不再作为终止条件。
 */
import type { RestPolicy } from './rest-policy'
import { estimateRemainingMs } from './rest-policy'

export const CAPACITY_GOAL_KEY = 'aibotCapacityGoal'

export interface CapacityGoal {
  enabled: boolean
  /** 时限（小时）；必达模式下超时不终止，只作进度参考 */
  hours: number
  /** 目标份数（平台已确认投递数） */
  targetJobs: number
  /**
   * 必达模式：目标未达成前自动接管策略 / 配额 / 平台 / 时段 / 休息，且不允许自行停机。
   * 可选字段是为了兼容老数据；**不写就按 true 处理** —— 「设定了目标」本身就意味着要达成。
   * 只有用户显式关掉（false）才回到「尽力而为的节奏建议」语义。
   */
  mustAchieve?: boolean
}

export const DEFAULT_CAPACITY_GOAL: CapacityGoal = {
  enabled: false,
  hours: 8,
  targetJobs: 80,
  mustAchieve: true,
}

export const MIN_CAPACITY_HOURS = 1
export const MAX_CAPACITY_HOURS = 24
export const MIN_CAPACITY_TARGET = 1
export const MAX_CAPACITY_TARGET = 500

/** 为了赶进度也不能把间隔压到 0，否则等于秒投，必然触发平台风控 */
export const MIN_PACING_INTERVAL_MS = 8_000

/**
 * 目标产能落后时，已通过采集层「方向 / 技术栈 / 语义 / 活跃度」硬筛的岗位，
 * 不再被本地评分量纲误杀的最低分。
 *
 * 现场案例：用户 PHP 方向，岗位「高级php工程师」本地评分只有 30 分
 * （本地规则分常见 20~45，而门槛按 60*0.55=33 折算），结果对口岗位被跳过、
 * 目标产能一个都投不出去。采集层已经证明这个岗位是同栈且语义对口的，
 * 此时匹配分只该用于排序，不该再当否决闸门。
 * 保留 20 分下限是为了仍拦住「评分极低、明显是脏数据」的卡片。
 */
export const CAPACITY_PRIORITY_THRESHOLD = 20

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
    mustAchieve: source.mustAchieve !== false,
  }
}

/** 当前是否处于「未达成就不许停」的必达模式 */
export function isMustAchieve(goal: CapacityGoal | null | undefined): boolean {
  return !!goal?.enabled && goal.mustAchieve !== false
}

/** 只认平台已确认投递数，绝不把「点了按钮但没确认」算进目标 */
export function isGoalAchieved(goal: CapacityGoal, applied: number): boolean {
  return Math.max(0, applied) >= goal.targetJobs
}

/** 一行说明自动接管了什么，UI / 日志 / 通知共用，避免文案漂移 */
export function describeMustAchieveTakeover(): string {
  return '自动切海投 · 自动抬配额 · 开启全部平台 · 放行工作时段 · 关闭模拟休息 · 放宽评分门槛（技术栈硬约束仍保留） · 达成前不停机'
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
  /** 目标窗口内实际允许投递的分钟数（由 countUsableMinutesUntil 算）；不给则按墙钟时间 */
  usableMinutes?: number
  /** 必达模式：超过时限继续加速，不返回 missed */
  mustAchieve?: boolean
}

/** blocked = 目标窗口与工作时段完全错开，墙钟上「还有时间」其实一分钟都投不了 */
export type CapacityStatus = 'off' | 'on-track' | 'at-risk' | 'blocked' | 'achieved' | 'missed'

export interface CapacityEvaluation {
  status: CapacityStatus
  deadlineAt: number
  elapsedMs: number
  remainingMs: number
  /** 目标窗口内真正可投的分钟数（扣除时段外时间） */
  usableMinutes: number
  /** 可投时长折算成毫秒，所有可达性判断都基于它，而不是墙钟剩余时间 */
  effectiveRemainingMs: number
  targetJobs: number
  remainingJobs: number
  /** 可投时间平摊到剩余份数，每份最多能花多久 */
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
  const wallMinutes = Math.ceil(remainingMs / 60_000)
  const usableMinutes = Math.min(
    wallMinutes,
    Math.max(0, Math.floor(input.usableMinutes ?? wallMinutes)),
  )
  const effectiveRemainingMs = usableMinutes * 60_000
  const requiredIntervalMs = remainingJobs > 0 ? effectiveRemainingMs / remainingJobs : 0
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
    usableMinutes,
    effectiveRemainingMs,
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
    if (input.mustAchieve) {
      return {
        ...base,
        // 必达模式没有「到点放弃」这个状态：超时只作为进度参考，
        // 继续按 at-risk 压缩间隔、跳过休息，直到平台确认投递数达标。
        status: 'at-risk',
        shouldSkipRest: true,
        advice: `已超过 ${goal.hours} 小时时限，当前 ${applied}/${targetJobs}，还差 ${remainingJobs} 份；必达模式不会自行停机，继续换词 / 翻页 / 换平台投递直到达成`,
      }
    }
    return {
      ...base,
      status: 'missed',
      advice: `截止只完成 ${applied}/${targetJobs}，还差 ${remainingJobs} 份；请查看日志里的「未记为投递成功」「没有发现新岗位」与登录态提示`,
    }
  }

  const quotaShort = totalQuota > 0 && targetJobs > totalQuota
    ? `目标 ${targetJobs} 份超过当前已开启平台配额合计 ${totalQuota}，请先在「平台与配额」调高数量；`
    : ''
  const windowShort = usableMinutes < wallMinutes
    ? `墙钟还剩 ${wallMinutes} 分钟，但工作时段内只有 ${usableMinutes} 分钟可投；`
    : ''

  // 目标窗口与工作时段完全错开：例如 21:15 设「2 小时投满 80 份」，
  // 而允许时段是 09:00-21:00 —— 不点破的话 AIbot 会静默休眠到第二天早上。
  if (effectiveRemainingMs <= 0) {
    return {
      ...base,
      status: 'blocked',
      advice: `${quotaShort}${windowShort}目标窗口内没有任何允许投递的时间，无法按时达成。请到【工作时段】设为「24小时不限」，或把目标时限改到下一个工作时段内`,
    }
  }

  if (projectedDurationMs > effectiveRemainingMs) {
    const projectedHours = (projectedDurationMs / HOUR_MS).toFixed(1)
    return {
      ...base,
      status: 'at-risk',
      shouldSkipRest: true,
      advice: `${quotaShort}${windowShort}按当前节奏预计还要 ${projectedHours} 小时，赶不上 ${goal.hours} 小时目标；已自动压缩间隔并跳过模拟休息，建议放宽「岗位名称」、开启更多平台、切到海投或下调目标`,
    }
  }

  return {
    ...base,
    status: 'on-track',
    advice: quotaShort || windowShort
      ? `${quotaShort}${windowShort}按当前节奏仍可在截止前完成，剩余 ${remainingJobs} 份`
      : `按当前节奏可在截止前完成，剩余约 ${wallMinutes} 分钟 / ${remainingJobs} 份`,
  }
}

/** 把随机拟人间隔压缩到目标允许的范围，永远不低于防风控下限 */
export function resolvePacingInterval(baseIntervalMs: number, evaluation: CapacityEvaluation): number {
  if (
    evaluation.status === 'off' ||
    evaluation.status === 'achieved' ||
    evaluation.status === 'missed' ||
    evaluation.status === 'blocked' ||
    evaluation.remainingJobs <= 0
  ) {
    return baseIntervalMs
  }
  return Math.max(MIN_PACING_INTERVAL_MS, Math.min(baseIntervalMs, evaluation.suggestedIntervalMs))
}

/** 目标产能是否需要「产能优先」调度：落后或窗口冲突都要接管补仓与门槛 */
export function isCapacityUrgent(status: CapacityStatus | null | undefined): boolean {
  return status === 'at-risk' || status === 'blocked'
}

/** 目标窗口里有多少分钟被工作时段挡住；UI / 后台 / 预检共用同一套判断 */
export function hasWindowConflict(evaluation: CapacityEvaluation): boolean {
  const wallMinutes = Math.ceil(evaluation.remainingMs / 60_000)
  return evaluation.usableMinutes < wallMinutes
}

/**
 * 设定目标时的前置可达性检查：把「墙钟 2 小时，实际只能投 105 分钟」这类
 * 冲突在用户点保存的那一刻就说清楚，而不是等 21:00 静默休眠后才发现。
 */
export function checkCapacityWindowFit(params: {
  hours: number
  usableMinutes: number
  now: number
}): { wallMinutes: number; usableMinutes: number; conflict: boolean; advice: string } {
  const wallMinutes = Math.max(0, Math.round(params.hours * 60))
  const usableMinutes = Math.min(wallMinutes, Math.max(0, Math.floor(params.usableMinutes)))
  const conflict = usableMinutes < wallMinutes
  const advice = conflict
    ? usableMinutes <= 0
      ? '⚠️ 目标时限完全落在非投递时段，AIbot 会一直休眠，无法达成目标。请先把【工作时段】设为「24小时不限」或改到下一个工作时段'
      : `⚠️ 目标 ${params.hours} 小时里只有 ${usableMinutes} 分钟落在当前【工作时段】内，其余 ${wallMinutes - usableMinutes} 分钟 AIbot 会休眠；要按时达标请解除时段限制或延长目标时限`
    : ''
  return { wallMinutes, usableMinutes, conflict, advice }
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
    case 'blocked':
      return '目标与工作时段冲突 · 当前无法投递'
    case 'at-risk':
      return evaluation.remainingMs <= 0
        ? `已超时 ${evaluation.targetJobs - evaluation.remainingJobs}/${evaluation.targetJobs} · 必达模式继续投递`
        : `进度落后 ${evaluation.targetJobs - evaluation.remainingJobs}/${evaluation.targetJobs} · 已自动加速`
    default:
      return `${evaluation.targetJobs - evaluation.remainingJobs}/${evaluation.targetJobs} 份 · ${goal.hours} 小时内`
  }
}
