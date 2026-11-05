// L3 经验记忆存储（Dexie v9）
// 只做 CRUD 与检索；所有 DB 异常静默降级，绝不阻断投递流水线。
import { db } from './index'
import {
  EXPERIENCE_TTL_DAYS,
  MIN_EXPERIENCE_SAMPLE,
  type Experience,
  type ExperienceSource,
  type ExperienceVerdict,
} from '../types/experience'

export interface ExperienceInput {
  pattern: string
  verdict: ExperienceVerdict
  sampleSize: number
  replyRate: number
  evidenceIds: string[]
  reason: string
  source?: ExperienceSource
}

function newExpiry(): string {
  return new Date(Date.now() + EXPERIENCE_TTL_DAYS * 86_400_000).toISOString()
}

/** 列出未过期且启用的经验 */
export async function listExperiences(includeDisabled = false): Promise<Experience[]> {
  try {
    const now = new Date().toISOString()
    const rows = await db.experiences.toArray()
    return rows.filter((e) => e.expiresAt > now && (includeDisabled || e.enabled))
  } catch {
    return []
  }
}

/** 结构化关键词匹配，单用户几百条数据无需向量检索 */
function matchScore(pattern: string, text: string): number {
  const tokens = pattern.split(/[\s、,，/]+/).filter((t) => t.length >= 2)
  if (!tokens.length) return 0
  return tokens.filter((t) => text.includes(t)).length
}

/** 规划时取与当前局面最相关的 top-N 经验 */
export async function getRelevantExperiences(
  contextText: string,
  limit = 5,
): Promise<Experience[]> {
  const all = await listExperiences()
  return all
    .map((e) => ({ e, score: matchScore(e.pattern, contextText) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || b.e.sampleSize - a.e.sampleSize)
    .slice(0, limit)
    .map((x) => x.e)
}

/** 归纳一条经验：样本不足不下结论；用户手工改过的条目不覆盖 */
export async function recordExperience(input: ExperienceInput): Promise<Experience | null> {
  if (input.sampleSize < MIN_EXPERIENCE_SAMPLE) return null
  try {
    const existing = await db.experiences.where('pattern').equals(input.pattern).first()
    if (existing?.userOverride) return null
    const now = new Date().toISOString()
    const exp: Experience = {
      id: existing?.id ?? `exp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      pattern: input.pattern,
      verdict: input.verdict,
      sampleSize: input.sampleSize,
      replyRate: input.replyRate,
      evidenceIds: input.evidenceIds,
      source: input.source ?? 'review',
      reason: input.reason,
      createdAt: existing?.createdAt ?? now,
      expiresAt: newExpiry(),
      enabled: existing?.enabled ?? true,
      userOverride: existing?.userOverride,
    }
    await db.experiences.put(exp)
    return exp
  } catch {
    return null
  }
}

/** 用户在记忆中心驳回一条经验 */
export async function setExperienceEnabled(
  id: string,
  enabled: boolean,
): Promise<boolean> {
  try {
    const row = await db.experiences.get(id)
    if (!row) return false
    await db.experiences.put({ ...row, enabled, userOverride: true })
    return true
  } catch {
    return false
  }
}

export async function deleteExperience(id: string): Promise<void> {
  try {
    await db.experiences.delete(id)
  } catch {
    // ignore
  }
}

export async function purgeExpiredExperiences(): Promise<number> {
  try {
    const now = new Date().toISOString()
    const expired = await db.experiences.filter((e) => e.expiresAt <= now).primaryKeys()
    await db.experiences.bulkDelete(expired)
    return expired.length
  } catch {
    return 0
  }
}
