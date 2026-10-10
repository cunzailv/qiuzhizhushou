// B 层 · 记忆/画像与决策留痕存储（B6 + 留痕）
// 说明：content script 的 IndexedDB 属于网页域，popup/background 属于扩展域；
// 记忆库只由 popup/background（扩展域）读写，跨域数据经 chrome.storage 或消息传递。
import { db } from './index'
import type { Application } from '../types/application'
import type { CompanyMemory, DecisionLog, FollowUpSuggestion } from '../types/butler'

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
}

// ─── 公司记忆（B6） ───

export async function getCompanyMemory(companyName: string, jobTitle?: string): Promise<CompanyMemory | undefined> {
  const key = companyKey(companyName, jobTitle)
  return db.companyMemories.get(key)
}

/** 公司记忆主键：公司 + 岗位（缺省岗位时只按公司聚合） */
function companyKey(companyName: string, jobTitle?: string): string {
  return jobTitle ? `${companyName}::${jobTitle}` : companyName
}

export async function touchCompany(
  companyName: string,
  jobTitle: string,
  outcome: Application['status'],
  notes?: string,
): Promise<CompanyMemory> {
  const id = companyKey(companyName, jobTitle)
  const now = new Date().toISOString()
  const existing = await db.companyMemories.get(id)
  const replyStatuses: Application['status'][] = ['read', 'communicating', 'interview', 'hired']
  const memory: CompanyMemory = existing
    ? {
        ...existing,
        touchCount: existing.touchCount + 1,
        replyCount: existing.replyCount + (replyStatuses.includes(outcome) ? 1 : 0),
        lastOutcome: outcome,
        updatedAt: now,
        notes: notes !== undefined ? notes : existing.notes,
      }
    : {
        id,
        companyName,
        jobTitle,
        touchCount: 1,
        replyCount: replyStatuses.includes(outcome) ? 1 : 0,
        lastOutcome: outcome,
        updatedAt: now,
        notes,
      }
  await db.companyMemories.put(memory)
  return memory
}

/** 投递结果回流学习：从一条投递记录更新公司记忆（B6 记忆回流入口） */
export async function learnFromApplication(app: Application): Promise<void> {
  if (!app.companyName) return
  await touchCompany(app.companyName, app.jobTitle, app.status)
}

/** 公司回复率（0-1）：可用于 B2 选岗的「回复概率」因子 */
export function memoryReplyRate(memory?: CompanyMemory): number {
  if (!memory || memory.touchCount === 0) return 0.5
  return memory.replyCount / memory.touchCount
}

// ─── AI/Agent 决策留痕 ───

export async function logDecision(entry: Omit<DecisionLog, 'id' | 'createdAt'>): Promise<DecisionLog> {
  const record: DecisionLog = {
    ...entry,
    id: generateId(),
    createdAt: new Date().toISOString(),
  }
  await db.decisionLogs.add(record)
  return record
}

export async function getRecentDecisions(limit = 10): Promise<DecisionLog[]> {
  return db.decisionLogs.orderBy('createdAt').reverse().limit(limit).toArray()
}

// ─── 跟进建议（B4） ───

export async function saveFollowUps(suggestions: Omit<FollowUpSuggestion, 'id' | 'createdAt' | 'dismissed'>[]): Promise<FollowUpSuggestion[]> {
  const records: FollowUpSuggestion[] = suggestions.map((s) => ({
    ...s,
    id: generateId(),
    createdAt: new Date().toISOString(),
    dismissed: false,
  }))
  await db.followUps.bulkAdd(records)
  return records
}

export async function getActiveFollowUps(): Promise<FollowUpSuggestion[]> {
  const all = await db.followUps.orderBy('createdAt').reverse().toArray()
  return all.filter((f) => !f.dismissed)
}

export async function dismissFollowUp(id: string): Promise<void> {
  await db.followUps.update(id, { dismissed: true })
}

/** 清理同公司同岗位的历史建议，避免重复堆积 */
export async function clearFollowUpsFor(applicationId: string): Promise<void> {
  const existing = await db.followUps.where('applicationId').equals(applicationId).toArray()
  for (const item of existing) await db.followUps.delete(item.id)
}
