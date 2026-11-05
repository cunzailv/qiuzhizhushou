// M4 · 事后归因：自愈事件存储、聚合与开发者待修建议
//
// 设计约束：
// 1. 复用现有 `db.auditLogs` 表（source 固定为 'self_healing'），不新增 Dexie 版本号，
//    避免触发用户端的强制数据库迁移。事件完整载荷序列化在 error 字段中。
// 2. 所有 DB 交互均为「尽力而为」：诊断链路的任何失败都必须静默降级，
//    绝不向投递主链路抛出异常（Mission-First）。
// 3. 事件总量上限 500 条，超出按 createdAt 淘汰最老记录。

import { db } from './index'
import type {
  SelfHealingEvent,
  DeveloperFixSuggestion,
  SelfHealingCategory,
  FixPriority,
} from '../types/diagnostics'
import { CATEGORY_FIX_TEMPLATES } from '../types/diagnostics'

const SOURCE = 'self_healing'
export const MAX_SELF_HEALING_EVENTS = 500

const PRIORITY_ORDER: Record<FixPriority, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
}

/** 兜底模板：防止运行时出现未知 category 导致聚合抛错 */
const FALLBACK_TEMPLATE = {
  title: '排查未知自愈类别',
  description: '检测到未登记的自愈类别，建议检查埋点调用与 CATEGORY_FIX_TEMPLATES 映射是否同步。',
  priority: 'low' as FixPriority,
}

let seq = 0
function generateId(): string {
  // 递增序号保证同一毫秒内高频写入也不会主键碰撞；
  // padStart 使其字典序与写入顺序一致，作为 createdAt 相同时的稳定排序依据。
  seq = (seq + 1) % 0xffffff
  return `${Date.now().toString(36)}-${seq.toString(36).padStart(4, '0')}-${Math.random().toString(36).slice(2, 6)}`
}

function parseRow(row: { error?: string }): SelfHealingEvent | null {
  try {
    if (!row?.error) return null
    const parsed = JSON.parse(row.error) as Partial<SelfHealingEvent>
    if (!parsed || typeof parsed !== 'object' || !parsed.id || !parsed.category) return null
    return parsed as SelfHealingEvent
  } catch {
    return null
  }
}

async function readAllEvents(): Promise<SelfHealingEvent[]> {
  const rows = await db.auditLogs.where('source').equals(SOURCE).toArray()
  return rows
    .map(parseRow)
    .filter((e): e is SelfHealingEvent => e !== null)
}

/** 超过 500 条时淘汰最老记录（仅保留最近 MAX_SELF_HEALING_EVENTS 条） */
async function pruneIfNeeded(): Promise<void> {
  const count = await db.auditLogs.where('source').equals(SOURCE).count()
  if (count <= MAX_SELF_HEALING_EVENTS) return

  const rows = await db.auditLogs.where('source').equals(SOURCE).toArray()
  rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
  const ids = rows.slice(0, count - MAX_SELF_HEALING_EVENTS).map((r) => r.id)
  if (ids.length === 0) return

  if (typeof db.auditLogs.bulkDelete === 'function') {
    await db.auditLogs.bulkDelete(ids)
  } else {
    for (const id of ids) await db.auditLogs.delete(id)
  }
}

/**
 * 写入一条自愈事件。
 * 无论 DB 是否可写，始终 resolve 并返回完整事件对象（不抛异常）。
 */
export async function recordSelfHealingEvent(
  event: Omit<SelfHealingEvent, 'id' | 'createdAt'>,
): Promise<SelfHealingEvent> {
  const record: SelfHealingEvent = {
    ...event,
    id: generateId(),
    createdAt: new Date().toISOString(),
  }

  try {
    await db.auditLogs.add({
      id: record.id,
      createdAt: record.createdAt,
      source: SOURCE,
      platform: event.platform,
      goal: event.category,
      result: event.success ? 'success' : 'failed',
      error: JSON.stringify(record),
    })
    await pruneIfNeeded()
  } catch {
    // 诊断失败不阻断业务：页面域 IndexedDB 可能不可写，静默降级
  }

  return record
}

/** 查询最近 N 条自愈事件（按时间倒序） */
export async function listSelfHealingEvents(limit = 100): Promise<SelfHealingEvent[]> {
  try {
    const events = await readAllEvents()
    events.sort(
      (a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
    )
    return limit > 0 ? events.slice(0, limit) : []
  } catch {
    return []
  }
}

/** 按 platform + category 聚合，生成结构化开发者待修建议（按优先级/次数排序） */
export async function getDeveloperFixSuggestions(): Promise<DeveloperFixSuggestion[]> {
  const events = await listSelfHealingEvents(MAX_SELF_HEALING_EVENTS)
  const map = new Map<string, DeveloperFixSuggestion>()

  for (const e of events) {
    if (!e.platform || !e.category) continue
    const key = `${e.platform}::${e.category}`
    const tmpl = CATEGORY_FIX_TEMPLATES[e.category as SelfHealingCategory] ?? FALLBACK_TEMPLATE
    const existing = map.get(key)

    if (!existing) {
      map.set(key, {
        key,
        platform: e.platform,
        category: e.category,
        occurrences: 1,
        lastOccurredAt: e.createdAt,
        fixTitle: tmpl.title,
        fixDescription: tmpl.description,
        priority: tmpl.priority,
        failedSelectors: e.failedSelector ? [e.failedSelector] : [],
        buttonTexts: e.buttonText ? [e.buttonText] : [],
        eventIds: [e.id],
      })
      continue
    }

    existing.occurrences++
    if (e.createdAt > existing.lastOccurredAt) existing.lastOccurredAt = e.createdAt
    if (e.failedSelector && !existing.failedSelectors.includes(e.failedSelector)) {
      existing.failedSelectors.push(e.failedSelector)
    }
    if (e.buttonText && !existing.buttonTexts.includes(e.buttonText)) {
      existing.buttonTexts.push(e.buttonText)
    }
    if (existing.eventIds.length < 10) existing.eventIds.push(e.id)
  }

  return Array.from(map.values()).sort((a, b) => {
    const byPriority = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]
    if (byPriority !== 0) return byPriority
    return b.occurrences - a.occurrences
  })
}

/** PROJECT.md 接口契约兼容别名 */
export const getDiagnosticFixRecommendations = getDeveloperFixSuggestions

/** 清空所有自愈诊断事件 */
export async function clearSelfHealingEvents(): Promise<void> {
  try {
    await db.auditLogs.where('source').equals(SOURCE).delete()
  } catch {
    // ignore
  }
}
