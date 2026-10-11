// E2+E5 单测：投递状态机（迁移表/降级策略/终态/事件归一化）
import { describe, it, expect } from 'vitest'
import { transition, isTerminal, isSuccess, goalResultToEvent } from '../src/shared/agent/apply-state-machine'

describe('E5 投递状态机', () => {
  it('主流程合法迁移链：matched → applied', () => {
    let s = transition('matched', { type: 'START' })
    expect(s).toBe('opening_detail')
    s = transition(s!, { type: 'DETAIL_OPENED' })
    expect(s).toBe('detail_open')
    s = transition(s!, { type: 'CHAT_CLICKED' })
    expect(s).toBe('chat_started')
    s = transition(s!, { type: 'GREETING_SENT' })
    expect(s).toBe('applied')
    expect(isSuccess(s!)).toBe(true)
    expect(isTerminal(s!)).toBe(true)
  })

  it('detail 失败且有降级路径 → 直接进入发起沟通', () => {
    const s = transition('opening_detail', { type: 'DETAIL_FAILED', reason: 'x', fallbackAvailable: true })
    expect(s).toBe('clicking_chat')
  })

  it('detail 失败且无降级路径 → failed', () => {
    const s = transition('opening_detail', { type: 'DETAIL_FAILED', reason: 'x', fallbackAvailable: false })
    expect(s).toBe('failed')
    expect(isTerminal(s!)).toBe(true)
  })

  it('chat 失败有降级 → 直接发问候；无降级 → failed', () => {
    expect(transition('clicking_chat', { type: 'CHAT_FAILED', reason: 'x', fallbackAvailable: true })).toBe('sending_greeting')
    expect(transition('clicking_chat', { type: 'CHAT_FAILED', reason: 'x', fallbackAvailable: false })).toBe('failed')
    expect(transition('detail_open', { type: 'CHAT_FAILED', reason: 'x', fallbackAvailable: true })).toBe('sending_greeting')
  })

  it('greeting 未完成（自动发送/无输入框）也算 applied', () => {
    expect(transition('chat_started', { type: 'GREETING_SKIPPED', reason: 'no textarea' })).toBe('applied')
  })

  it('用户拒绝 → denied；跳过 → skipped；风控 → blocked', () => {
    expect(transition('opening_detail', { type: 'USER_DENIED', reason: 'no' })).toBe('denied')
    expect(transition('matched', { type: 'USER_SKIPPED', reason: 'busy' })).toBe('skipped')
    expect(transition('chat_started', { type: 'RISK_BLOCKED', reason: 'rate limit' })).toBe('blocked')
    expect(isTerminal('denied')).toBe(true)
    expect(isTerminal('skipped')).toBe(true)
    expect(isTerminal('blocked')).toBe(true)
  })

  it('非法迁移返回 undefined，终态不再迁移', () => {
    expect(transition('applied', { type: 'START' })).toBeUndefined()
    expect(transition('failed', { type: 'GREETING_SENT' })).toBeUndefined()
    expect(transition('matched', { type: 'DETAIL_OPENED' })).toBeUndefined()
    expect(transition('detail_open', { type: 'START' })).toBeUndefined()
  })

  it('goalResultToEvent 正确归一化 reactLoop 结果', () => {
    expect(goalResultToEvent({ success: true, goal: 'open_detail', steps: [], attempts: 1 }, true)).toEqual({ type: 'DETAIL_OPENED' })
    expect(goalResultToEvent({ success: false, goal: 'open_detail', steps: [], attempts: 5, error: 'boom' }, false)).toEqual({
      type: 'DETAIL_FAILED', reason: 'boom', fallbackAvailable: false,
    })
    expect(goalResultToEvent({ success: true, goal: 'click_chat', steps: [], attempts: 1 }, false)).toEqual({ type: 'CHAT_CLICKED' })
    expect(goalResultToEvent({ success: true, goal: 'send_greeting', steps: [], attempts: 1 }, false)).toEqual({ type: 'GREETING_SENT' })
    expect(goalResultToEvent({ success: false, goal: 'send_greeting', steps: [], attempts: 5, error: 'x' }, false)).toEqual({
      type: 'GREETING_SKIPPED', reason: 'x',
    })
  })
})
