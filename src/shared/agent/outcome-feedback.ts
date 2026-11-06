// L3 结果复盘 · 把真实投递结果变成可执行的策略依据
//
// 输入：outcome-store 里的真实事件（AIbot 投递、聊天页 HR 回复、状态变更）。
// 输出：按「搜索方向」聚合的回复率、零回复方向、有效方向、HR 原话样本与数据可信度。
//
// 关键原则：**不编数字**。没有结果信号就明确标 confidence='none'，
// 摘要里只写观察到的事件数；不让 LLM 自由发挥产生「样本量为 175」这类幻觉。

import type { OutcomeEvent } from '../db/outcome-store'
import { getOutcomeEvents } from '../db/outcome-store'

export interface DirectionOutcome {
  direction: string
  applied: number
  replied: number
  interviews: number
  rejects: number
  replyRate: number
}

export type OutcomeConfidence = 'none' | 'low' | 'medium' | 'high'

export interface OutcomeFeedback {
  windowDays: number
  /** AIbot 记录的投递事件数（不是 applications 全量） */
  trackedApplications: number
  hrReplies: number
  interviews: number
  rejects: number
  byDirection: DirectionOutcome[]
  /** 投递 ≥3 次、零 HR 回复、零面试的方向 */
  staleDirections: string[]
  /** 投递 ≥3 次、回复率 ≥30% 的方向 */
  healthyDirections: string[]
  /** 最近 3 条 HR 原话，交给策略层看真实反馈而不是猜 */
  recentHrSnippets: string[]
  confidence: OutcomeConfidence
  /** 是否拿到了「投递之后」的真实结果，而不只是「投出去了」 */
  hasFreshSignal: boolean
  summary: string
}

export const STALE_DIRECTION_MIN_SAMPLES = 3
export const HEALTHY_DIRECTION_MIN_SAMPLES = 3
export const HEALTHY_REPLY_RATE = 30

const UNCLASSIFIED = '未归类'
const STATUS_REPLY_KINDS = new Set(['read', 'communicating', 'interview', 'hired'])
const INTERVIEW_KINDS = new Set(['interview', 'hired'])

function identityOf(event: OutcomeEvent): string {
  return (event.jobId || `${(event.jobTitle || '').trim()}|${(event.company || '').trim()}`).trim()
}

function titleIdentityOf(event: OutcomeEvent): string {
  return `${(event.jobTitle || '').trim()}|${(event.company || '').trim()}`
}

function emptyFeedback(days: number): OutcomeFeedback {
  return {
    windowDays: days,
    trackedApplications: 0,
    hrReplies: 0,
    interviews: 0,
    rejects: 0,
    byDirection: [],
    staleDirections: [],
    healthyDirections: [],
    recentHrSnippets: [],
    confidence: 'none',
    hasFreshSignal: false,
    summary: `L3 结果复盘（近 ${days} 天）：暂无 AIbot 投递结果记录，本轮不做任何基于回复率的策略调整。`,
  }
}

/**
 * 纯函数聚合，便于单测覆盖时间窗、去重、方向归因。
 * 方向归因：applied 事件自带 searchKeyword；HR 回复 / 状态变更通过
 * jobId → jobTitle|company 反查 applied 事件，反查不到归入「未归类」，绝不瞎猜。
 */
export function summarizeOutcomes(
  events: OutcomeEvent[],
  opts: { days?: number; now?: number } = {},
): OutcomeFeedback {
  const days = opts.days ?? 7
  const now = opts.now ?? Date.now()
  const cutoff = now - days * 86_400_000
  const recent = (events || []).filter((e) => e && typeof e.at === 'number' && e.at >= cutoff)
  if (recent.length === 0) return emptyFeedback(days)

  const appliedEvents = recent.filter((e) => e.kind === 'applied')
  if (appliedEvents.length === 0) return emptyFeedback(days)

  // 方向索引 + 身份归一化。
  // 同一岗位在不同来源里可能只有 jobId（状态变更）、也可能只有「标题+公司」（聊天页 HR 消息），
  // 不归一化就会把一条 HR 回复算成 2~3 次，回复率虚高。
  const directionByIdentity = new Map<string, string>()
  const appliedIds = new Set<string>()
  const canonicalByTitle = new Map<string, string>()
  for (const e of appliedEvents) {
    const dir = (e.direction || '').trim() || UNCLASSIFIED
    const canonical = identityOf(e)
    appliedIds.add(canonical)
    if (e.jobId) appliedIds.add(e.jobId)
    directionByIdentity.set(canonical, dir)
    if (e.jobId) directionByIdentity.set(e.jobId, dir)
    if (e.jobTitle) {
      directionByIdentity.set(titleIdentityOf(e), dir)
      canonicalByTitle.set(titleIdentityOf(e), canonical)
    }
  }

  const canonicalId = (e: OutcomeEvent): string => {
    if (e.jobId) {
      if (appliedIds.has(e.jobId)) return e.jobId
      const mapped = canonicalByTitle.get(titleIdentityOf(e))
      return mapped || e.jobId
    }
    return canonicalByTitle.get(titleIdentityOf(e)) || titleIdentityOf(e)
  }

  const resolveDirection = (e: OutcomeEvent): string => {
    if (e.direction) return e.direction.trim()
    return directionByIdentity.get(identityOf(e))
      || directionByIdentity.get(titleIdentityOf(e))
      || (e.jobId ? directionByIdentity.get(e.jobId) : undefined)
      || UNCLASSIFIED
  }

  const stats = new Map<string, DirectionOutcome>()
  const ensure = (dir: string): DirectionOutcome => {
    let s = stats.get(dir)
    if (!s) {
      s = { direction: dir, applied: 0, replied: 0, interviews: 0, rejects: 0, replyRate: 0 }
      stats.set(dir, s)
    }
    return s
  }

  // 每条投递只计一次（outcome-store 已按 key 去重，这里再按身份兜底）
  const countedApplied = new Set<string>()
  for (const e of appliedEvents) {
    const id = canonicalId(e)
    if (countedApplied.has(id)) continue
    countedApplied.add(id)
    ensure(resolveDirection(e)).applied += 1
  }

  // 每个岗位只计一次「收到回复」，避免 read + hr_reply + communicating 重复累加
  const countedReplies = new Set<string>()
  const countedInterviews = new Set<string>()
  const countedRejects = new Set<string>()
  const hrReplyEvents: OutcomeEvent[] = []

  for (const e of recent) {
    const dir = resolveDirection(e)
    const id = canonicalId(e)
    if (e.kind === 'hr_reply') {
      hrReplyEvents.push(e)
      if (!countedReplies.has(id)) {
        countedReplies.add(id)
        ensure(dir).replied += 1
      }
      continue
    }
    if (STATUS_REPLY_KINDS.has(e.kind) && !countedReplies.has(id)) {
      countedReplies.add(id)
      ensure(dir).replied += 1
    }
    if (INTERVIEW_KINDS.has(e.kind) && !countedInterviews.has(id)) {
      countedInterviews.add(id)
      ensure(dir).interviews += 1
    }
    if (e.kind === 'rejected' && !countedRejects.has(id)) {
      countedRejects.add(id)
      ensure(dir).rejects += 1
    }
  }

  const byDirection = Array.from(stats.values())
    .map((s) => ({ ...s, replyRate: s.applied > 0 ? Math.round((s.replied / s.applied) * 100) : 0 }))
    .sort((a, b) => b.applied - a.applied)

  const staleDirections = byDirection
    .filter((s) => s.applied >= STALE_DIRECTION_MIN_SAMPLES && s.replied === 0 && s.interviews === 0)
    .map((s) => s.direction)
  const healthyDirections = byDirection
    .filter((s) => s.applied >= HEALTHY_DIRECTION_MIN_SAMPLES && s.replyRate >= HEALTHY_REPLY_RATE)
    .map((s) => s.direction)

  const recentHrSnippets = hrReplyEvents
    .sort((a, b) => b.at - a.at)
    .map((e) => (e.snippet || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .slice(0, 3)

  const tracked = countedApplied.size
  const hrReplies = hrReplyEvents.length
  const interviews = countedInterviews.size
  const rejects = countedRejects.size
  const confidence: OutcomeConfidence =
    tracked >= 30 ? 'high' : tracked >= 10 ? 'medium' : tracked > 0 ? 'low' : 'none'
  const confidenceLabel = { none: '无', low: '低', medium: '中', high: '高' }[confidence]

  const parts = [
    `L3 结果复盘（近 ${days} 天）：AIbot 记录 ${tracked} 次投递，HR 回复 ${hrReplies} 条、面试邀约 ${interviews} 个、明确不合适 ${rejects} 个，数据可信度${confidenceLabel}`,
  ]
  if (staleDirections.length > 0) {
    parts.push(`零回复方向：${staleDirections.slice(0, 3).join('、')}（建议降权）`)
  }
  if (healthyDirections.length > 0) {
    parts.push(`有效方向：${healthyDirections.slice(0, 3).join('、')}（建议加权）`)
  }
  if (confidence === 'none' || confidence === 'low') {
    parts.push('样本不足，本轮不据此自动改参数')
  }

  return {
    windowDays: days,
    trackedApplications: tracked,
    hrReplies,
    interviews,
    rejects,
    byDirection,
    staleDirections,
    healthyDirections,
    recentHrSnippets,
    confidence,
    hasFreshSignal: hrReplies > 0 || interviews > 0 || rejects > 0,
    summary: `${parts.join('；')}。`,
  }
}

/** 读取持久化的真实事件并产出复盘结论 */
export async function buildOutcomeFeedback(
  days = 7,
  now = Date.now(),
): Promise<OutcomeFeedback> {
  const events = await getOutcomeEvents()
  return summarizeOutcomes(events, { days, now })
}
