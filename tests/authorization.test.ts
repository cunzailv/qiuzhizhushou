// 声明式授权契约单测：默认关闭 / fail-closed / 硬锁 / 过期降级 / 分类查表
import { describe, it, expect } from 'vitest'
import {
  evaluateAuthorization,
  isPolicyStale,
  proposeAction,
  POLICY_TTL_DAYS,
} from '../src/shared/agent/authorization'
import {
  DEFAULT_AUTHORIZATION_POLICY,
  type AuthorizationPolicy,
} from '../src/shared/types/candidate-profile'

function fresh(patch: Partial<AuthorizationPolicy> = {}): AuthorizationPolicy {
  return {
    ...DEFAULT_AUTHORIZATION_POLICY,
    enabled: true,
    updatedAt: new Date().toISOString(),
    ...patch,
  }
}

describe('授权契约 · 向后兼容与 fail-closed', () => {
  it('默认关闭时返回 null，调用方应回退原有权限三档', () => {
    expect(evaluateAuthorization({ kind: 'apply', category: 'strategy' }, DEFAULT_AUTHORIZATION_POLICY)).toBeNull()
    expect(evaluateAuthorization({ kind: 'apply', category: 'strategy' }, null)).toBeNull()
  })

  it('普通页面浏览不受契约管辖，回退原逻辑', () => {
    expect(evaluateAuthorization({ kind: 'browse', category: 'facts' }, fresh())).toBeNull()
  })

  it('配置从未确认或超过 14 天自动降级为需确认', () => {
    expect(isPolicyStale({ ...fresh(), updatedAt: '' })).toBe(true)
    const old = new Date(Date.now() - (POLICY_TTL_DAYS + 1) * 86_400_000).toISOString()
    const decision = evaluateAuthorization(
      { kind: 'apply', category: 'strategy' },
      fresh({ updatedAt: old }),
    )
    expect(decision?.level).toBe('confirm')
    expect(decision?.reason).toContain('未复核')
  })

  it('未覆盖的分类一律停下问，不默认放行', () => {
    const decision = evaluateAuthorization(
      { kind: 'mystery_action', category: 'locks' },
      fresh(),
    )
    expect(decision?.level).toBe('confirm')
  })
})

describe('授权契约 · 硬锁不可下放', () => {
  it('改简历事实与突破风控永远禁止', () => {
    expect(evaluateAuthorization({ kind: 'resume_fact_edit', category: 'facts' }, fresh())?.level).toBe('deny')
    expect(evaluateAuthorization({ kind: 'risk_control_bypass', category: 'strategy' }, fresh())?.level).toBe('deny')
  })

  it('offer 与薪资谈判永远需人确认', () => {
    expect(evaluateAuthorization({ kind: 'offer_decision', category: 'locks' }, fresh())?.level).toBe('confirm')
    expect(evaluateAuthorization({ kind: 'salary_negotiation', category: 'locks' }, fresh())?.level).toBe('confirm')
  })

  it('硬锁优先于过期检查，也优先于任何 auto 配置', () => {
    const policy = fresh({
      updatedAt: new Date(Date.now() - 60 * 86_400_000).toISOString(),
      strategy: { ...DEFAULT_AUTHORIZATION_POLICY.strategy, apply: 'auto' },
    })
    expect(evaluateAuthorization({ kind: 'resume_fact_edit', category: 'facts' }, policy)?.level).toBe('deny')
  })
})

describe('授权契约 · 策略与额度', () => {
  it('默认不自动投递；显式授权后在配额内自动执行', () => {
    expect(evaluateAuthorization({ kind: 'apply', category: 'strategy' }, fresh())?.level).toBe('confirm')
    const allowed = fresh({
      strategy: { ...DEFAULT_AUTHORIZATION_POLICY.strategy, apply: 'auto' },
    })
    const decision = evaluateAuthorization({ kind: 'apply', category: 'strategy', value: 12 }, allowed)
    expect(decision?.level).toBe('auto')
    expect(decision?.cited).toBe('strategy.apply')
  })

  it('超出每日配额上限时停下问', () => {
    const policy = fresh({
      strategy: { ...DEFAULT_AUTHORIZATION_POLICY.strategy, apply: 'auto', dailyQuotaMax: 10 },
    })
    expect(evaluateAuthorization({ kind: 'apply', category: 'strategy', value: 11 }, policy)?.level).toBe('confirm')
  })

  it('调门槛低于下限、调参项未授权都要确认', () => {
    const policy = fresh({
      strategy: { ...DEFAULT_AUTHORIZATION_POLICY.strategy, matchThresholdMin: 60, mayTune: ['keywords'] },
    })
    expect(evaluateAuthorization({ kind: 'tune_threshold', category: 'strategy', value: 50 }, policy)?.level).toBe('confirm')
    expect(evaluateAuthorization({ kind: 'tune_platform_weights', category: 'strategy' }, policy)?.level).toBe('confirm')
    expect(evaluateAuthorization({ kind: 'tune_keywords', category: 'strategy' }, policy)?.level).toBe('auto')
  })
})

describe('授权契约 · 应答白名单', () => {
  const autoReply = fresh({
    reply: { ...DEFAULT_AUTHORIZATION_POLICY.reply, mode: 'safe_auto_reply' },
  })

  it('非自动应答模式需确认', () => {
    expect(evaluateAuthorization({ kind: 'send_greeting', category: 'reply', topic: '最快到岗' }, fresh())?.level).toBe('confirm')
  })

  it('白名单话题自动应答，禁用话题直接拒绝', () => {
    expect(evaluateAuthorization({ kind: 'send_greeting', category: 'reply', topic: '最快到岗时间' }, autoReply)?.level).toBe('auto')
    expect(evaluateAuthorization({ kind: 'send_greeting', category: 'reply', topic: '薪资流水' }, autoReply)?.level).toBe('deny')
  })

  it('白名单外话题与超次数都要确认', () => {
    expect(evaluateAuthorization({ kind: 'send_greeting', category: 'reply', topic: '家庭情况' }, autoReply)?.level).toBe('deny')
    expect(evaluateAuthorization({ kind: 'send_greeting', category: 'reply', topic: '婚育计划', value: 3 }, autoReply)?.level).toBe('confirm')
    expect(evaluateAuthorization({ kind: 'send_greeting', category: 'reply', topic: '最快到岗', value: 10 }, autoReply)?.level).toBe('confirm')
  })

  it('事实只允许只读引用，脏配置想改写即拒绝', () => {
    expect(evaluateAuthorization({ kind: 'quote_fact', category: 'facts' }, fresh())?.level).toBe('auto')
    const tampered = fresh({
      facts: { source: 'resume_only', allowRewrite: true as unknown as false },
    })
    expect(evaluateAuthorization({ kind: 'quote_fact', category: 'facts' }, tampered)?.level).toBe('deny')
  })
})

describe('上下文到动作的映射', () => {
  it('投递 / 发送 / 浏览分别落到对应分类', () => {
    expect(proposeAction('click', '投递简历', {})).toMatchObject({ kind: 'apply', category: 'strategy' })
    expect(proposeAction('press_enter', '发送打招呼', { text: '您好' })).toMatchObject({ kind: 'send_greeting', category: 'reply' })
    expect(proposeAction('click', 'open_detail', {})).toMatchObject({ kind: 'browse', category: 'facts' })
  })
})
