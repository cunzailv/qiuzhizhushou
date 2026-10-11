// E1+E3 · 工具执行入口（Harness 工具系统 + 权限三档 + 审计）
// 兼容旧签名 executeAction(action)，内部升级为：
//   注册表校验 → 权限分档（auto/confirm/denied）→ 执行计时 → 审计落库。
// confirm 级别不执行，返回 needsConfirm，由 UI 层（浮窗确认卡片）接管。

import { actionToToolCall, getTool } from './tool-registry'
import { decidePermission } from './permission'
import { logAudit } from '../db/audit-store'
import type { AgentAction } from './types'

export interface ExecuteActionOptions {
  platform?: string
  goal?: string
  pageType?: string
  /** true 时跳过权限检查（内部/缓存回放场景），默认 false */
  skipPermission?: boolean
  /** 权限覆盖（测试或调用方显式指定） */
  permissionOverrides?: { apply?: 'auto' | 'confirm' | 'denied'; send?: 'auto' | 'confirm' | 'denied' }
  /** 确认回调：confirm 级别动作由调用方确认后以 true 重放 */
  confirmed?: boolean
  /** 是否落审计，默认 true */
  audit?: boolean
}

/**
 * 执行一个 AI 返回的动作。
 * 返回 needsConfirm=true 表示动作被权限层拦截，等待用户确认。
 */
export async function executeAction(
  action: AgentAction,
  options: ExecuteActionOptions = {},
): Promise<{ ok: boolean; error?: string; needsConfirm?: boolean; durationMs?: number }> {
  const started = Date.now()
  const ctx = {
    platform: options.platform || '',
    goal: options.goal || '',
    pageType: options.pageType || '',
  }

  // 1) 兼容层：AgentAction → 工具调用
  const call = actionToToolCall(action)
  if (!call) {
    const msg = `未知动作类型: ${(action as any).type}`
    if (options.audit !== false) {
      await logAudit({ source: 'agent', platform: ctx.platform, goal: ctx.goal, result: 'failed', error: msg })
    }
    return { ok: false, error: msg }
  }

  const tool = getTool(call.tool)
  if (!tool) {
    const msg = `工具未注册: ${call.tool}`
    if (options.audit !== false) {
      await logAudit({ source: 'agent', platform: ctx.platform, goal: ctx.goal, result: 'failed', error: msg })
    }
    return { ok: false, error: msg }
  }

  // 2) 参数校验
  if (tool.validate) {
    const err = tool.validate(call.payload)
    if (err) {
      const msg = `参数校验失败[${call.tool}]: ${err}`
      if (options.audit !== false) {
        await logAudit({ source: 'agent', platform: ctx.platform, goal: ctx.goal, tool: call.tool, result: 'failed', error: msg })
      }
      return { ok: false, error: msg, durationMs: Date.now() - started }
    }
  }

  // 3) 权限分档
  if (!options.skipPermission) {
    const decision = await decidePermission(
      call.tool,
      {
        goal: ctx.goal,
        text: typeof call.payload.text === 'string' ? call.payload.text : undefined,
        targetValue: typeof call.payload.value === 'string' ? call.payload.value : undefined,
      },
      options.permissionOverrides,
    )

    if (decision.level === 'denied') {
      if (options.audit !== false) {
        await logAudit({
          source: 'agent', platform: ctx.platform, goal: ctx.goal,
          tool: call.tool, permissionLevel: 'denied', result: 'denied',
          error: decision.reason, durationMs: Date.now() - started,
        })
      }
      return { ok: false, error: `动作被禁止: ${decision.reason}`, durationMs: Date.now() - started }
    }

    if (decision.level === 'confirm' && !options.confirmed) {
      if (options.audit !== false) {
        await logAudit({
          source: 'agent', platform: ctx.platform, goal: ctx.goal,
          tool: call.tool, permissionLevel: 'confirm', result: 'confirm_wait',
          error: decision.message, durationMs: Date.now() - started,
        })
      }
      return { ok: false, error: decision.message || '需要用户确认', needsConfirm: true, durationMs: Date.now() - started }
    }
  }

  // 4) 执行（计时 + 审计）
  try {
    const result = await tool.execute(call.payload, ctx)
    const durationMs = Date.now() - started
    if (options.audit !== false) {
      await logAudit({
        source: 'agent', platform: ctx.platform, goal: ctx.goal,
        tool: call.tool, permissionLevel: options.skipPermission ? undefined : 'auto',
        result: result.ok ? 'success' : 'failed',
        error: result.error, durationMs,
      })
    }
    return { ok: result.ok, error: result.error, durationMs }
  } catch (err: any) {
    const durationMs = Date.now() - started
    const msg = err?.message || '执行失败'
    if (options.audit !== false) {
      await logAudit({
        source: 'agent', platform: ctx.platform, goal: ctx.goal,
        tool: call.tool, result: 'failed', error: msg, durationMs,
      })
    }
    return { ok: false, error: msg, durationMs }
  }
}
