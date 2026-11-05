// 声明式自主授权契约 · 运行时判定
// 由用户事前把事实、底线、额度、白名单写进「求职画像与底线」，
// 运行时按分类查表得出 auto / confirm / deny，不再每步弹确认。
//
// 三条不可动摇的原则：
// 1. fail-closed：未启用、未覆盖、超范围、解析失败 → 一律停下问，不默认放行。
// 2. 事实只读：AI 只能引用用户填写的事实，不能改写或新增（防编造）。
// 3. 硬锁不可下放：改简历事实 / 谈 offer / 突破风控，即使配了 auto 也不生效。
import { getCandidatePreferences } from '../db/settings-store'
import type {
  AuthorizationPolicy,
  GrantLevel,
  StrategyTuneKey,
} from '../types/candidate-profile'

export type AuthorizationCategory = 'facts' | 'reply' | 'strategy' | 'locks'

export interface ProposedAction {
  kind: string
  category: AuthorizationCategory
  /** 数值上下文：拟调配额 / 拟调门槛 / 今日已自动应答数 */
  value?: number
  /** 应答话题，用于白名单匹配 */
  topic?: string
}

export interface AuthorizationDecision {
  level: GrantLevel
  reason: string
  /** 引用了哪条配置，供审计留痕与回滚 */
  cited?: string
  updatedAt?: string
}

/** 硬锁：无论用户如何配置，都不提供自动执行 */
export const HARD_LOCKS: Record<string, GrantLevel> = {
  resume_fact_edit: 'deny',
  risk_control_bypass: 'deny',
  offer_decision: 'confirm',
  salary_negotiation: 'confirm',
}

export const POLICY_TTL_DAYS = 14

const TUNE_KIND_MAP: Record<string, StrategyTuneKey> = {
  tune_keywords: 'keywords',
  tune_threshold: 'threshold',
  tune_platform_weights: 'platformWeights',
  tune_greeting: 'greeting',
}

/** 配置过期（或从未确认）时自动降级，避免旧授权卡死策略 */
export function isPolicyStale(
  policy: AuthorizationPolicy,
  now: Date = new Date(),
): boolean {
  if (!policy.updatedAt) return true
  const ts = Date.parse(policy.updatedAt)
  if (Number.isNaN(ts)) return true
  return now.getTime() - ts > POLICY_TTL_DAYS * 86_400_000
}

/**
 * 返回 null 表示「授权契约不适用」，调用方应回退原有权限三档。
 * 这是保持向后兼容的关键：默认关闭时对现有行为零影响。
 */
export function evaluateAuthorization(
  action: ProposedAction,
  policy: AuthorizationPolicy | null | undefined,
  now: Date = new Date(),
): AuthorizationDecision | null {
  if (!policy?.enabled) return null
  // 普通页面浏览不归授权契约管，回退原逻辑
  if (action.kind === 'browse') return null

  const lock = HARD_LOCKS[action.kind]
  if (lock) {
    return {
      level: lock,
      reason: `硬锁：${action.kind} 不可下放为自动执行`,
      cited: `locks.${action.kind}`,
      updatedAt: policy.updatedAt,
    }
  }

  if (isPolicyStale(policy, now)) {
    return {
      level: 'confirm',
      reason: `授权配置超过 ${POLICY_TTL_DAYS} 天未复核，已自动降级为需确认`,
      cited: 'updatedAt',
      updatedAt: policy.updatedAt,
    }
  }

  if (action.category === 'strategy') {
    const s = policy.strategy

    if (action.kind === 'apply') {
      if (s.apply !== 'auto') {
        return { level: s.apply, reason: '投递动作未授权自动执行', cited: 'strategy.apply' }
      }
      if (typeof action.value === 'number' && action.value > s.dailyQuotaMax) {
        return {
          level: 'confirm',
          reason: `今日已投 ${action.value} 个，超出你设定的上限 ${s.dailyQuotaMax}`,
          cited: 'strategy.dailyQuotaMax',
        }
      }
      return {
        level: 'auto',
        reason: '在授权配额区间内自动投递',
        cited: 'strategy.apply',
        updatedAt: policy.updatedAt,
      }
    }

    if (action.kind === 'tune_quota' && typeof action.value === 'number' && action.value > s.dailyQuotaMax) {
      return {
        level: 'confirm',
        reason: `拟调配额 ${action.value} 超出你设定的上限 ${s.dailyQuotaMax}`,
        cited: 'strategy.dailyQuotaMax',
      }
    }
    if (action.kind === 'tune_threshold' && typeof action.value === 'number' && action.value < s.matchThresholdMin) {
      return {
        level: 'confirm',
        reason: `拟调门槛 ${action.value} 低于你设定的下限 ${s.matchThresholdMin}`,
        cited: 'strategy.matchThresholdMin',
      }
    }
    if (action.kind === 'change_direction') {
      if (!s.allowedTitles.length) {
        return { level: 'confirm', reason: '未填写允许的主攻方向白名单，需你确认', cited: 'strategy.allowedTitles' }
      }
      return { level: 'auto', reason: '主攻方向已在白名单内', cited: 'strategy.allowedTitles' }
    }

    const tuneKey = TUNE_KIND_MAP[action.kind]
    if (!tuneKey || !s.mayTune.includes(tuneKey)) {
      return { level: 'confirm', reason: `调参项 ${action.kind} 未授权，需你确认`, cited: 'strategy.mayTune' }
    }
    return {
      level: 'auto',
      reason: `按授权契约自动执行：${action.kind}`,
      cited: `strategy.mayTune.${tuneKey}`,
      updatedAt: policy.updatedAt,
    }
  }

  if (action.category === 'reply') {
    const r = policy.reply
    if (r.mode !== 'safe_auto_reply') {
      return { level: 'confirm', reason: `应答模式为 ${r.mode}，需你确认`, cited: 'reply.mode' }
    }
    if (action.topic && r.forbidTopics.some((t) => action.topic!.includes(t))) {
      return { level: 'deny', reason: '话题在禁用清单内，禁止自动应答', cited: 'reply.forbidTopics' }
    }
    if (action.topic && !r.allowedTopics.some((t) => action.topic!.includes(t))) {
      return { level: 'confirm', reason: '话题不在自动应答白名单内，需你确认', cited: 'reply.allowedTopics' }
    }
    if (typeof action.value === 'number' && action.value >= r.maxPerDay) {
      return { level: 'confirm', reason: `今日自动应答已达上限 ${r.maxPerDay}`, cited: 'reply.maxPerDay' }
    }
    return {
      level: 'auto',
      reason: '白名单内按你填写的标准答案自动应答',
      cited: 'reply.allowedTopics',
      updatedAt: policy.updatedAt,
    }
  }

  if (action.category === 'facts') {
    if (policy.facts.allowRewrite) {
      return { level: 'deny', reason: '禁止改写简历事实', cited: 'facts.allowRewrite' }
    }
    return {
      level: 'auto',
      reason: '只引用你填写的事实，不改写不新增',
      cited: 'facts.source',
      updatedAt: policy.updatedAt,
    }
  }

  return { level: 'confirm', reason: '授权契约未覆盖此动作，需你确认', cited: 'locks' }
}

/** 把执行层上下文映射为待判定的动作 */
export function proposeAction(
  tool: string,
  goal: string,
  payload: Record<string, unknown>,
): ProposedAction {
  const text = typeof payload?.text === 'string' ? payload.text : ''
  if (/投递|申请|立即沟通|投简历/.test(goal)) {
    return { kind: 'apply', category: 'strategy' }
  }
  if (/发送|打招呼/.test(goal) || (text.length > 0 && tool !== 'click')) {
    // 用目标而非消息正文做话题匹配：正文是自由文本，无法与白名单稳定对应
    return { kind: 'send_greeting', category: 'reply', topic: goal || '打招呼' }
  }
  return { kind: 'browse', category: 'facts' }
}

// ─── 运行时读取（带短缓存，避免每次动作都打一次存储）───
let cached: { at: number; policy: AuthorizationPolicy | null } | null = null
const CACHE_TTL_MS = 5_000

export async function loadActivePolicy(): Promise<AuthorizationPolicy | null> {
  const now = Date.now()
  if (cached && now - cached.at < CACHE_TTL_MS) return cached.policy
  try {
    const prefs = await getCandidatePreferences()
    const policy = prefs.authorization?.enabled ? prefs.authorization : null
    cached = { at: now, policy }
    return policy
  } catch {
    cached = { at: now, policy: null }
    return null
  }
}

/** 配置保存后调用，确保下一次动作立即读到新策略 */
export function resetAuthorizationCache(): void {
  cached = null
}
