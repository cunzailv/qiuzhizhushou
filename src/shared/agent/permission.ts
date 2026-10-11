// E3 · 动作权限三档（Harness 权限与安全）
// 把动作分为：auto（自动执行）/ confirm（需用户确认）/ denied（禁止）。
// 默认：读取类=auto；投递/发送类=confirm（可在设置中改为自动）；越权/高频=denied。
// 设置存储于 chrome.storage.local（setting_permission_apply / setting_permission_send），
// 供 content script（网页域）与 popup/options（扩展域）共用。

import { getSetting } from '../db/settings-store'

export type PermissionLevel = 'auto' | 'confirm' | 'denied'

export interface PermissionDecision {
  level: PermissionLevel
  reason: string
  /** confirm 时供浮窗展示的动作说明 */
  message?: string
}

/** 高风险动作集合：投递 / 发送消息 / 提交表单 */
const HIGH_RISK_TOOLS = new Set(['click', 'type', 'press_enter'])

/** 绝对禁止的动作（越权/无意义高频触发） */
const DENIED_TOOLS = new Set<string>([])

/**
 * 判断一个动作的权限级别。
 * @param tool 工具名（click/type/...）
 * @param ctx 执行上下文（平台/目标/文本）
 * @param overrides 可选：测试或调用方显式传入配置
 */
export async function decidePermission(
  tool: string,
  ctx: { goal: string; text?: string; targetValue?: string },
  overrides?: { apply?: PermissionLevel; send?: PermissionLevel },
): Promise<PermissionDecision> {
  // 1) 绝对禁止
  if (DENIED_TOOLS.has(tool)) {
    return { level: 'denied', reason: `工具 ${tool} 被策略禁止` }
  }

  // 2) 纯读取/等待类 → 自动
  if (['wait', 'scroll', 'done', 'press_escape'].includes(tool)) {
    return { level: 'auto', reason: '读取/等待类动作自动执行' }
  }

  // 3) 高风险动作 → 按配置分档
  if (HIGH_RISK_TOOLS.has(tool)) {
    const isApply = /投递|申请|立即沟通|投简历/.test(ctx.goal)
    const isSend = /发送|打招呼|发送消息/.test(ctx.goal) || (ctx.text && ctx.text.length > 0)

    if (isApply) {
      const level = overrides?.apply ?? (await getSetting<PermissionLevel>('permission_apply', 'confirm'))
      return {
        level,
        reason: level === 'confirm' ? '投递动作需用户确认' : '投递动作按配置自动执行',
        message: '即将执行投递/申请动作，请确认是否继续',
      }
    }
    if (isSend) {
      const level = overrides?.send ?? (await getSetting<PermissionLevel>('permission_send', 'confirm'))
      return {
        level,
        reason: level === 'confirm' ? '发送消息需用户确认' : '发送消息按配置自动执行',
        message: '即将发送消息，请确认内容后再继续',
      }
    }

    // 普通点击（打开详情等）→ 自动
    return { level: 'auto', reason: '普通点击自动执行' }
  }

  return { level: 'auto', reason: '默认自动' }
}

/** 把权限决策转成可审计的日志片段 */
export function permissionToAudit(d: PermissionDecision): { level: PermissionLevel; reason: string } {
  return { level: d.level, reason: d.reason }
}
