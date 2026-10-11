// E5 · 编排状态机（投递流程 L2/L6）
// 把一次「匹配 → 打开详情 → 发起沟通 → 发送问候 → 完成」的投递编排为
// 显式状态机：每个阶段迁移都落审计（stateFrom → stateTo + verified），
// 失败按降级策略分流（detail 失败 → 有兜底则直投，否则 failed；
// 用户拒绝 → denied；风控 → blocked）。
// 状态机本身是纯函数，可单测；content 层负责真实执行与事件上报。

import { logAudit } from '../db/audit-store'
import type { AgentGoalResult } from './types'

export type ApplyState =
  | 'matched'
  | 'opening_detail'
  | 'detail_open'
  | 'clicking_chat'
  | 'chat_started'
  | 'sending_greeting'
  | 'applied'
  | 'denied'
  | 'skipped'
  | 'failed'
  | 'blocked'

export type ApplyEvent =
  | { type: 'START' }
  | { type: 'DETAIL_OPENED' }
  | { type: 'DETAIL_FAILED'; reason: string; fallbackAvailable: boolean }
  | { type: 'CHAT_CLICKED' }
  | { type: 'CHAT_FAILED'; reason: string; fallbackAvailable: boolean }
  | { type: 'GREETING_SENT' }
  | { type: 'GREETING_SKIPPED'; reason: string }
  | { type: 'USER_DENIED'; reason: string }
  | { type: 'USER_SKIPPED'; reason: string }
  | { type: 'GIVE_UP'; reason: string }
  | { type: 'RISK_BLOCKED'; reason: string }

const TERMINAL: readonly ApplyState[] = ['applied', 'denied', 'skipped', 'failed', 'blocked']

export function isTerminal(state: ApplyState): boolean {
  return TERMINAL.includes(state)
}

export function isSuccess(state: ApplyState): boolean {
  return state === 'applied'
}

/** 状态迁移表：当前状态 × 事件 → 下一状态；undefined 表示非法迁移 */
export function transition(state: ApplyState, event: ApplyEvent): ApplyState | undefined {
  switch (state) {
    case 'matched':
      if (event.type === 'START') return 'opening_detail'
      if (event.type === 'USER_SKIPPED') return 'skipped'
      if (event.type === 'RISK_BLOCKED') return 'blocked'
      return undefined
    case 'opening_detail':
      if (event.type === 'DETAIL_OPENED') return 'detail_open'
      if (event.type === 'DETAIL_FAILED') {
        // 降级策略：列表页仍有直投路径 → 直接进入发起沟通；否则失败
        return event.fallbackAvailable ? 'clicking_chat' : 'failed'
      }
      if (event.type === 'USER_DENIED') return 'denied'
      if (event.type === 'USER_SKIPPED') return 'skipped'
      if (event.type === 'RISK_BLOCKED') return 'blocked'
      return undefined
    case 'detail_open':
      if (event.type === 'CHAT_CLICKED') return 'chat_started'
      if (event.type === 'CHAT_FAILED') {
        return event.fallbackAvailable ? 'sending_greeting' : 'failed'
      }
      if (event.type === 'USER_DENIED') return 'denied'
      if (event.type === 'USER_SKIPPED') return 'skipped'
      if (event.type === 'GIVE_UP') return 'failed'
      if (event.type === 'RISK_BLOCKED') return 'blocked'
      return undefined
    case 'clicking_chat':
      if (event.type === 'CHAT_CLICKED') return 'chat_started'
      if (event.type === 'CHAT_FAILED') {
        return event.fallbackAvailable ? 'sending_greeting' : 'failed'
      }
      if (event.type === 'USER_DENIED') return 'denied'
      if (event.type === 'USER_SKIPPED') return 'skipped'
      if (event.type === 'GIVE_UP') return 'failed'
      if (event.type === 'RISK_BLOCKED') return 'blocked'
      return undefined
    case 'chat_started':
      if (event.type === 'GREETING_SENT') return 'applied'
      if (event.type === 'GREETING_SKIPPED') return 'applied' // 无输入框（已自动发送）也算完成
      if (event.type === 'USER_DENIED') return 'denied'
      if (event.type === 'GIVE_UP') return 'failed'
      if (event.type === 'RISK_BLOCKED') return 'blocked'
      return undefined
    case 'sending_greeting':
      if (event.type === 'GREETING_SENT') return 'applied'
      if (event.type === 'GREETING_SKIPPED') return 'applied'
      if (event.type === 'USER_DENIED') return 'denied'
      if (event.type === 'GIVE_UP') return 'failed'
      if (event.type === 'RISK_BLOCKED') return 'blocked'
      return undefined
    default:
      // 终态不再迁移
      return undefined
  }
}

export interface MachineRecord {
  jobTitle: string
  jobCompany: string
  platform: string
  stateFrom: ApplyState
  stateTo: ApplyState
  eventType: string
  verified?: boolean
  error?: string
  durationMs?: number
}

/** 落一条状态机审计（E6：verified + 状态迁移可追溯） */
export async function recordMachineTransition(rec: MachineRecord): Promise<void> {
  await logAudit({
    source: 'machine',
    platform: rec.platform,
    goal: rec.jobTitle,
    tool: `state:${rec.stateFrom}->${rec.stateTo}`,
    permissionLevel: undefined,
    result: rec.stateTo === 'applied' ? 'success' : rec.stateTo === 'failed' || rec.stateTo === 'denied' || rec.stateTo === 'blocked' ? 'failed' : 'skipped',
    error: rec.error,
    durationMs: rec.durationMs,
    verified: rec.verified,
    stateFrom: rec.stateFrom,
    stateTo: rec.stateTo,
  })
}

/** 把 reactLoop 的 goal 结果归一化为状态机事件与状态 */
export function goalResultToEvent(result: AgentGoalResult, fallbackAvailable: boolean): ApplyEvent {
  switch (result.goal) {
    case 'open_detail':
      return result.success
        ? { type: 'DETAIL_OPENED' }
        : { type: 'DETAIL_FAILED', reason: result.error || 'AI 无法打开详情', fallbackAvailable }
    case 'click_chat':
      return result.success
        ? { type: 'CHAT_CLICKED' }
        : { type: 'CHAT_FAILED', reason: result.error || 'AI 无法发起沟通', fallbackAvailable }
    case 'send_greeting':
      return result.success
        ? { type: 'GREETING_SENT' }
        : { type: 'GREETING_SKIPPED', reason: result.error || '问候发送未完成' }
    default:
      return result.success
        ? { type: 'GREETING_SENT' }
        : { type: 'GIVE_UP', reason: result.error || '目标未达成' }
  }
}
