// 自主规划器 (Planner) · 单一主脑
// 读：用户写的授权契约 (L1) + 真实复盘统计 (L2) + 带证据的经验 (L3)
// 想：根据「昨天有没有效果」推导「今天该改什么」
// 写：仅在授权契约明确 auto 时、在有界范围内回写 campaign 参数；其余只留痕
//
// 设计约束：
// - 策略由确定性规则 + 真实数据产生，LLM 只负责把结论说成人话；未配置/失败一律降级。
// - 每条建议都过一次 evaluateAuthorization，未授权的一律不应用。
// - 全流程 try/catch 静默降级，绝不阻断原有投递流水线。
import { getAllApplications } from '../db/application-store'
import { getRelevantExperiences } from '../db/experience-store'
import { getSetting, setSetting } from '../db/settings-store'
import { chatCompletion } from '../ai/api-client'
import { buildReview, type ReviewResult } from './butler/review-planner'
import { buildOutcomeFeedback, type OutcomeFeedback } from './outcome-feedback'
import { evaluateAuthorization, loadActivePolicy } from './authorization'
import { MIN_PLATFORM_QUOTA } from './quota'
import { appendCampaignLog, saveCampaign, type Campaign } from './queue-store'
import { logWarn } from '../utils/logger'
import type { AuthorizationPolicy, GrantLevel } from '../types/candidate-profile'
import type { Experience } from '../types/experience'

const MOD = 'Planner'
const LOW_REPLY_RATE = 20
const MIN_SAMPLE_FOR_ADJUST = 10
const SETTINGS_KEY = 'planner_last_decision'

export type PlanKind =
  | 'tune_keywords'
  | 'tune_threshold'
  | 'tune_platform_weights'
  | 'tune_greeting'
  | 'change_direction'

export interface PlanProposal {
  kind: PlanKind
  detail: string
  level: GrantLevel
  cited?: string
}

export interface PlanningContext {
  sampleSize: number
  replyRate: number
  review: ReviewResult
  experiences: Experience[]
  policy: AuthorizationPolicy | null
  campaign: Campaign
  /** L3 真实结果复盘；可选以兼容旧调用方与单测 */
  outcome?: OutcomeFeedback
}

export interface PlannerDecision {
  createdAt: string
  replyRate: number
  sampleSize: number
  /** 确定性摘要：只含真实统计数字，LLM 不得改写 */
  summary: string
  /** LLM 定性解读（不含任何数字），与 summary 分开存放，杜绝数字幻觉 */
  narrative?: string
  proposals: PlanProposal[]
  applied: string[]
  skipped: string[]
  /** 决策来源，便于审计：本地规则 or LLM 解释 */
  source: 'local_rules' | 'llm_assisted'
  /** L3 结果数据可信度；'none' 时不允许自动改参数 */
  outcomeConfidence?: OutcomeFeedback['confidence']
  hasOutcomeSignal?: boolean
}

/** 汇总当前局面：只取真实记录，不编造样本 */
export async function buildPlanningContext(
  campaign: Campaign,
): Promise<PlanningContext> {
  const apps = await getAllApplications()
  const review = buildReview(apps, { days: 7 })
  const [policy, outcome] = await Promise.all([
    loadActivePolicy(),
    // L3：读真实结果事件（AIbot 投递、HR 回复、面试/不合适状态变更），
    // 而不是只看用户手动改过的 applications.status。
    buildOutcomeFeedback(7),
  ])
  const contextText = [
    review.suggestions.join(' '),
    review.byTitle.map((t) => t.title).join(' '),
    outcome.summary,
  ].join(' ')
  const experiences = await getRelevantExperiences(contextText, 5)
  return {
    sampleSize: review.total,
    replyRate: review.replyRate,
    review,
    experiences,
    policy,
    campaign,
    outcome,
  }
}

/** 根据真实统计推导今日策略，每条建议都过授权判定 */
export function deriveProposals(ctx: PlanningContext): PlanProposal[] {
  const raw: Array<{ kind: PlanKind; detail: string }> = []
  if (ctx.replyRate < LOW_REPLY_RATE && ctx.sampleSize >= MIN_SAMPLE_FOR_ADJUST) {
    raw.push({
      kind: 'tune_greeting',
      detail: `近 7 天 ${ctx.sampleSize} 次投递回复率仅 ${ctx.replyRate}%，建议改写招呼语首句`,
    })
    raw.push({
      kind: 'tune_keywords',
      detail: '回复率偏低，建议收窄关键词、聚焦历史回复率较高的岗位方向',
    })
  }
  for (const stat of ctx.review.byTitle.filter((t) => t.count >= 3 && t.replyRate === 0)) {
    raw.push({
      kind: 'tune_keywords',
      detail: `方向「${stat.title}」投递 ${stat.count} 次零回复，建议降权`,
    })
  }
  for (const exp of ctx.experiences.filter((e) => e.verdict === 'avoid')) {
    raw.push({ kind: 'tune_keywords', detail: `经验记忆：${exp.reason}（样本 ${exp.sampleSize}）` })
  }

  // L3 结果复盘：只有拿到真实投递事件 + 真实结果，才允许产出「按方向调权」的建议。
  // 每条都带可核对的事件数，不允许出现凭空推算的样本量。
  const outcome = ctx.outcome
  if (outcome && outcome.trackedApplications > 0) {
    for (const dir of outcome.staleDirections.slice(0, 2)) {
      const stat = outcome.byDirection.find((d) => d.direction === dir)
      raw.push({
        kind: 'tune_keywords',
        detail: `L3 结果复盘：方向「${dir}」AIbot 投递 ${stat?.applied ?? 0} 次、HR 回复 0 条、面试 0 个，建议降权或改写搜索词`,
      })
    }
    for (const dir of outcome.healthyDirections.slice(0, 2)) {
      const stat = outcome.byDirection.find((d) => d.direction === dir)
      raw.push({
        kind: 'tune_platform_weights',
        detail: `L3 结果复盘：方向「${dir}」回复率 ${stat?.replyRate ?? 0}%（${stat?.replied ?? 0}/${stat?.applied ?? 0}），建议加权`,
      })
    }
    if (outcome.hrReplies > 0) {
      raw.push({
        kind: 'tune_greeting',
        detail: `L3 结果复盘：已收到 ${outcome.hrReplies} 条真实 HR 回复，可据原话调整招呼语首句`,
      })
    }
  }
  if (raw.length === 0) {
    raw.push({ kind: 'tune_keywords', detail: '当前数据无明确改进信号，维持原策略' })
  }

  return raw.map((item) => {
    const decision = ctx.policy
      ? evaluateAuthorization({ kind: item.kind, category: 'strategy' }, ctx.policy)
      : null
    return {
      kind: item.kind,
      detail: item.detail,
      level: decision?.level ?? 'confirm',
      cited: decision?.cited,
    }
  })
}

function fallbackSummary(ctx: PlanningContext, proposals: PlanProposal[]): string {
  const autoCount = proposals.filter((p) => p.level === 'auto').length
  const base = `近 7 天 ${ctx.sampleSize} 次投递，回复率 ${ctx.replyRate}%；产生 ${proposals.length} 条策略建议，其中 ${autoCount} 条在授权范围内可自动执行。`
  // L3 结论单独拼接，所有数字都来自真实事件，不经过 LLM
  return ctx.outcome && ctx.outcome.trackedApplications > 0
    ? `${base} ${ctx.outcome.summary}`
    : base
}

/**
 * 产出决策；LLM 只做「定性解读」，不参与决策、不许输出任何数字。
 * 之前让 LLM 复述统计结论，结果它编出「样本量为 175、回复率为 1」这种无来源数字，
 * 用户看到的就是一个会一本正经胡说的 bot。现在 summary 由确定性函数产出，
 * LLM 输出单独放 narrative，且一旦含数字就整条丢弃。
 */
export async function planNextCycle(ctx: PlanningContext): Promise<PlannerDecision> {
  const proposals = deriveProposals(ctx)
  const summary = fallbackSummary(ctx, proposals)
  let source: PlannerDecision['source'] = 'local_rules'
  let narrative: string | undefined
  try {
    const text = await chatCompletion(
      [
        '你是求职策略助手。只用一句中文给出定性建议，不要复述统计数字。',
        '硬性规则：回答中禁止出现任何阿拉伯数字、百分比、日期；不得编造事实；不得提出输入之外的建议。',
      ].join(''),
      JSON.stringify({
        suggestions: ctx.review.suggestions,
        outcomeSignals: ctx.outcome
          ? {
              hasFreshSignal: ctx.outcome.hasFreshSignal,
              confidence: ctx.outcome.confidence,
              staleDirections: ctx.outcome.staleDirections.slice(0, 3),
              healthyDirections: ctx.outcome.healthyDirections.slice(0, 3),
              hrSnippets: ctx.outcome.recentHrSnippets,
            }
          : null,
      }),
      0.1,
    )
    const clean = text.trim().replace(/^["'「]|["'」]$/g, '')
    if (clean.length > 0 && clean.length < 160 && !/\d/.test(clean)) {
      narrative = clean
      source = 'llm_assisted'
    }
  } catch {
    // 未配置 API Key / 超额 / 网络异常 → 保持本地结论
  }
  return {
    createdAt: new Date().toISOString(),
    replyRate: ctx.replyRate,
    sampleSize: ctx.sampleSize,
    summary,
    narrative,
    proposals,
    applied: [],
    skipped: [],
    source,
    outcomeConfidence: ctx.outcome?.confidence,
    hasOutcomeSignal: ctx.outcome?.hasFreshSignal,
  }
}

/** 有界回写：只在授权 auto 且回复率低迷时保守下调本轮配额，不低于平台最低配额 */
async function applyDecision(
  decision: PlannerDecision,
  campaign: Campaign,
): Promise<void> {
  const hasAuto = decision.proposals.some((p) => p.level === 'auto')
  if (!hasAuto) {
    decision.skipped.push('授权契约未启用或未授权自动调参，本轮仅记录建议')
    return
  }
  if (decision.replyRate >= LOW_REPLY_RATE || decision.sampleSize < MIN_SAMPLE_FOR_ADJUST) {
    decision.skipped.push('未达到「回复率低迷」触发条件，参数保持不变')
    return
  }
  // L3 护栏：没有真实「投递之后的结果」事件时，不拿一堆 stale 的「已投递」当依据自动改配额
  if (decision.outcomeConfidence && (decision.outcomeConfidence === 'none' || decision.outcomeConfidence === 'low')) {
    decision.skipped.push('L3 真实结果样本不足，本轮只记录建议、不自动改参数')
    return
  }
  let changed = false
  for (const q of Object.values(campaign.quotas)) {
    if (!q.enabled || q.exhausted) continue
    const next = Math.max(MIN_PLATFORM_QUOTA, Math.round(q.quota * 0.9))
    if (next !== q.quota) {
      q.quota = next
      changed = true
    }
  }
  if (changed) {
    await saveCampaign(campaign)
    decision.applied.push('保守下调本轮各启用平台配额 10%（不低于平台最低配额，仅影响当前 campaign）')
  }
}

// 触发节流：每天首次 + 每完成 10 个任务最多重规划一次
let lastReplanKey = ''
export function resetPlannerState(): void {
  lastReplanKey = ''
}

function shouldReplan(campaign: Campaign): boolean {
  const done = campaign.tasks.filter((t) => t.status === 'done').length
  const key = `${new Date().toISOString().slice(0, 10)}:${Math.floor(done / 10)}`
  if (key === lastReplanKey) return false
  lastReplanKey = key
  return true
}

/**
 * Campaign tick 前置钩子。任何异常都静默吞掉，原流水线照常执行。
 * 决策写入 settings 供管家日报/记忆中心查看，便于审计与回滚。
 */
export async function replanIfNeeded(campaign: Campaign): Promise<PlannerDecision | null> {
  try {
    if (!shouldReplan(campaign)) return null
    const ctx = await buildPlanningContext(campaign)
    const decision = await planNextCycle(ctx)
    await applyDecision(decision, campaign)
    await setSetting(SETTINGS_KEY, {
      createdAt: decision.createdAt,
      summary: decision.summary,
      narrative: decision.narrative,
      replyRate: decision.replyRate,
      sampleSize: decision.sampleSize,
      proposals: decision.proposals,
      applied: decision.applied,
      skipped: decision.skipped,
      source: decision.source,
      outcomeConfidence: decision.outcomeConfidence,
      hasOutcomeSignal: decision.hasOutcomeSignal,
    })
    const narrativePart = decision.narrative ? `｜AI 解读：${decision.narrative}` : ''
    await appendCampaignLog(
      `🧠 自主重规划：${decision.summary}${narrativePart}${decision.applied.length ? `｜已应用：${decision.applied.join('；')}` : `｜本轮未改动参数${decision.skipped.length ? `（${decision.skipped.join('；')}）` : ''}`}`,
      'info',
    )
    return decision
  } catch (err) {
    logWarn(MOD, 'replanIfNeeded', err)
    return null
  }
}

/** 供 UI 读取最近一次决策 */
export async function getLastPlannerDecision(): Promise<Partial<PlannerDecision> | null> {
  try {
    return await getSetting<Partial<PlannerDecision> | null>(SETTINGS_KEY, null)
  } catch {
    return null
  }
}
