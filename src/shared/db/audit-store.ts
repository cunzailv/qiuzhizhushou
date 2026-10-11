// E6 · 全链路动作审计（L5 评估与观测）
// 记录每个 Agent 动作：时间/来源/动作/目标/权限/结果/耗时/验证状态/状态机迁移。
// 后台「审计视图」与导出 CSV 消费该表。

import { db } from './index'

export type AuditResult = 'success' | 'failed' | 'confirm_wait' | 'denied'

export interface AuditRecord {
  id: string
  createdAt: string
  source: string            // popup / content / background / butler
  platform?: string         // boss / liepin / 51job / zhaopin / maimai
  goal?: string
  tool?: string             // click / type / ...
  target?: string
  permissionLevel?: 'auto' | 'confirm' | 'denied'
  result: AuditResult
  error?: string
  durationMs?: number
  verified?: boolean        // 是否通过页面状态断言
  stateFrom?: string        // 状态机迁移
  stateTo?: string
}

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
}

export async function logAudit(entry: Omit<AuditRecord, 'id' | 'createdAt'>): Promise<AuditRecord> {
  const record: AuditRecord = {
    ...entry,
    id: generateId(),
    createdAt: new Date().toISOString(),
  }
  try {
    await db.auditLogs.add(record)
  } catch {
    // 审计失败不阻断业务：页面域 DB 可能不可写，静默降级
  }
  return record
}

export async function getAuditLogs(
  options: { limit?: number; source?: string; result?: AuditResult; platform?: string } = {},
): Promise<AuditRecord[]> {
  let query = db.auditLogs.orderBy('createdAt').reverse()
  let rows = await query.limit(options.limit ?? 200).toArray()
  if (options.source) rows = rows.filter((r) => r.source === options.source)
  if (options.result) rows = rows.filter((r) => r.result === options.result)
  if (options.platform) rows = rows.filter((r) => r.platform === options.platform)
  return rows
}

export async function countAuditByResult(): Promise<Record<AuditResult, number>> {
  const rows = await db.auditLogs.toArray()
  const count: Record<AuditResult, number> = { success: 0, failed: 0, confirm_wait: 0, denied: 0 }
  for (const r of rows) count[r.result] = (count[r.result] ?? 0) + 1
  return count
}

/** 导出 CSV 文本（后台导出中心复用） */
export function auditToCsv(rows: AuditRecord[]): string {
  const header = '时间,来源,平台,目标,动作,权限,结果,耗时ms,验证,错误,状态迁移'
  const lines = rows.map((r) => [
    r.createdAt,
    r.source,
    r.platform || '',
    r.goal || '',
    r.tool || '',
    r.permissionLevel || '',
    r.result,
    r.durationMs ?? '',
    r.verified === undefined ? '' : String(r.verified),
    (r.error || '').replace(/[,\n]/g, ' '),
    r.stateFrom ? `${r.stateFrom}->${r.stateTo}` : '',
  ].join(','))
  return [header, ...lines].join('\n')
}
