/**
 * 必达模式的「可控参数自动接管」纯函数底座。
 *
 * 设定目标后，系统不能再拿「配额不够 / 只开了一个平台 / 平台被标日限」当停机理有：
 * 这些全是插件自己能改的参数。这里只算**该改成什么**，实际写盘由后台服务负责，
 * 保证策略可单测、可复现，不夹杂 storage 副作用。
 *
 * 但「可控参数」有硬边界：**用户手动关闭的 bot / 平台不是可控参数**。
 * 现场反馈「关了又自动打开」就是旧版把这些也一并接管了；现在 `userStopped`
 * 与 `protectedPlatforms` 是最高优先级，任何必达规则都不得越过。
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
  /** 用户手动关闭、本轮明确跳过接管的平台 */
  protectedPlatforms: PlatformId[]
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
 *  - 除「用户手动关闭」的平台外一律全开（后者是硬约束，见 protectedPlatforms）；
 *  - 配额只升不降，平均分摊到所有平台，单平台不超过 500；
 *  - 已投数未达新上限的 exhausted 平台解除耗尽标记，继续参与调度。
 *
 * 旧注释写的是「用户仍可在面板手动关，但下一次规划会重新拉起」—— 这正是
 * 现场「平台关闭了总是自动打开，一开启投递又自动打开」的根因，已改掉。
 */
export function planMustAchieveQuotas(
  quotas: MustAchieveQuotaMap,
  targetJobs: number,
  opts: {
    maxPerPlatform?: number
    headroomRatio?: number
    /** 全平台日限冷却期内置 false：只重新规划配额，不立刻复活被限流的平台 */
    allowRevive?: boolean
    /** 用户手动关闭的平台：不改配额、不开启、不解除日限，完全不碰 */
    protectedPlatforms?: readonly PlatformId[]
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
  const protectedPlatforms: PlatformId[] = []
  const reasons: string[] = []
  let plannedTotalQuota = 0
  const protectedSet = new Set<PlatformId>(opts.protectedPlatforms ?? [])

  for (const pid of ids) {
    const state = quotas[pid]
    if (!state) continue
    const current = Number.isFinite(state.quota) ? state.quota : 0
    // 用户手动关闭 = 硬约束。连配额都不抬，否则下一轮「已启用平台」的合计
    // 会被这个永远不参与投递的平台虚增，进度判断跟着失真。
    if (protectedSet.has(pid)) {
      protectedPlatforms.push(pid)
      plannedTotalQuota += current
      continue
    }
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
    protectedPlatforms,
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
 * 语义闸门是否允许被运行模式绕过 —— 永远不允许。
 *
 * 历史实现返回 mustAchieve：必达 / 海投时把本地语义硬闸门降级为「只统计不否决」，
 * 结果用户填了「php 后台 AI 全栈开发」，bot 却把「AI产品经理」「销售」整页灌进队列。
 * 岗位名称属于用户真实意愿，不是系统可自动接管的可控参数：必达模式能放宽的只有
 * 配额、活跃时间、匹配分、页码和巡检频次，方向本身一律不放宽。
 *
 * 保留这个导出是为了让旧调用点与静态契约测试显式看到「不再绕过」这个决定，
 * 而不是悄悄删掉函数导致后来有人再加回来。
 */
export function shouldBypassRelevanceGate(_mustAchieve: boolean): boolean {
  void _mustAchieve
  return false
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

/* -------------------------------------------------------------------------- *
 * 目标必达看门狗
 *
 * 现场问题：用户设了「2 小时投满 80 份」，跑到 16/80 就再也不动。
 * 根因不是「节奏慢」，而是调度链断了 —— `runCampaignTick()` 只要发现
 * campaign.status !== 'running' 就直接 return，而 `apply-tick` 是**一次性**
 * alarm，触发完就没了。任何一次内部自动挂起（验证码 / 无岗位来源 / 日限 /
 * 平台被标 exhausted 后误判完成）都会让整条流水线永久静默，
 * 「未达成不停机」的代码全都变成不可达分支。
 *
 * 因此必达模式不能只靠 tick 自己续命，必须有一条独立的周期看门狗：
 * 只要目标没达成，无论流水线被写成什么状态，都要按安全规则把它拉回 running。
 * -------------------------------------------------------------------------- */

/** 独立于 apply-tick 的周期 alarm 名称；一次性 tick alarm 丢了也能兜底 */
export const MUST_ACHIEVE_WATCHDOG_ALARM = 'must-achieve-watchdog'
/** Chrome MV3 alarm 最小周期为 1 分钟 */
export const MUST_ACHIEVE_WATCHDOG_PERIOD_MINUTES = 1
/** 账号受限熔断后的安全冷却：到点自动恢复，且由服务层绕开该平台 */
export const MUST_ACHIEVE_BLOCK_COOLDOWN_MS = 15 * 60_000
/** 用户手动暂停后的宽限期：到期仍回来完成目标（想彻底停就关掉必达模式） */
export const MUST_ACHIEVE_MANUAL_PAUSE_MS = 5 * 60_000
/** 全平台被标日限时的重试间隔：必达模式不空等 10 分钟 */
export const MUST_ACHIEVE_EXHAUSTED_RETRY_MS = 30_000

export interface MustAchieveWatchdogInput {
  status: 'running' | 'paused' | 'done' | 'aborted'
  pausedReason?: 'captcha' | 'user' | 'rate' | 'blocked' | 'no_source'
  /** 用户主动关闭了 AIbot：最高优先级，任何必达规则都不许复活 */
  userStopped?: boolean
  /** 最近一次挂起时间戳；0 / 缺失代表历史脏数据，按「已挂起足够久」处理 */
  pausedAt: number
  mustAchieve: boolean
  achieved: boolean
  applied: number
  targetJobs: number
  now: number
}

export type MustAchieveWatchdogAction =
  | { kind: 'idle' }
  | { kind: 'resume'; reason: string }
  | { kind: 'wait'; reason: string; retryMs: number }

/**
 * 判断本轮看门狗该做什么。纯函数，不碰 storage / alarm，便于单测穷举状态组合。
 *
 * 安全边界：
 *  - **用户主动关闭 AIbot → 一律 idle**，绝不与「目标必达」对抗；
 *  - 目标已达成 / 未启用必达 → 完全不干预，用户想停就停；
 *  - 账号受限 → 冷却 15 分钟（继续猛点会加重账号处罚），到点自动恢复；
 *  - 人工暂停 / 被误判 done → 宽限 5 分钟后自动回来，并明确留痕；
 *  - 验证码 / 无来源 / 日限等系统自己造成的挂起 → **立即恢复**，一刻不等。
 */
export function decideMustAchieveWatchdog(
  input: MustAchieveWatchdogInput,
): MustAchieveWatchdogAction {
  // 旧版只认「暂停 / 挂起」，用户点了关闭也会被当成 15 分钟冷却的 aborted，
  // 时间一到自动 resume → 后台重新下发任务 → 浮窗又冒出来。用户关了就是关了。
  if (input.userStopped) return { kind: 'idle' }
  if (!input.mustAchieve || input.achieved) return { kind: 'idle' }
  if (input.status === 'running') return { kind: 'idle' }

  const progress = `已确认 ${input.applied}/${input.targetJobs}`
  // pausedAt 缺失时不能算「刚暂停」，否则历史脏数据会把目标永久卡在 wait
  const elapsed = input.pausedAt > 0
    ? Math.max(0, input.now - input.pausedAt)
    : Number.POSITIVE_INFINITY

  if (input.pausedReason === 'blocked' || input.status === 'aborted') {
    if (elapsed < MUST_ACHIEVE_BLOCK_COOLDOWN_MS) {
      return {
        kind: 'wait',
        reason: `账号安全熔断冷却中（${progress}）`,
        retryMs: Math.max(1_000, MUST_ACHIEVE_BLOCK_COOLDOWN_MS - elapsed),
      }
    }
    return { kind: 'resume', reason: `账号安全冷却结束，继续冲刺目标（${progress}）` }
  }

  if (input.pausedReason === 'user' || input.status === 'done') {
    if (elapsed < MUST_ACHIEVE_MANUAL_PAUSE_MS) {
      return {
        kind: 'wait',
        reason: `人工暂停宽限中（${progress}）`,
        retryMs: Math.max(1_000, MUST_ACHIEVE_MANUAL_PAUSE_MS - elapsed),
      }
    }
    return {
      kind: 'resume',
      reason: `人工暂停宽限结束，目标仍未达成，自动恢复投递（${progress}）`,
    }
  }

  // captcha / no_source / rate / 未知原因：都是系统自己设的出口，必达模式不认
  return {
    kind: 'resume',
    reason: `流水线被挂起（${input.pausedReason || input.status}），${progress}，必达目标未达成，立即恢复`,
  }
}
