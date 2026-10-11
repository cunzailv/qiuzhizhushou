// E4 · 职业状态记忆（L3，「职业镜子」数据地基）
// 维护一份长期职业画像快照：当前角色/年限/技能/教育、职业状态、
// 长期目标、提升方向（由差距报告与复盘沉淀），以及最近一次匹配快照。
// 后台「职业状态看板」消费该表；投递/面试结果回流时自动更新。

import { db } from './index'
import { encryptText, decryptText } from '../security/vault'

export interface CareerSkill {
  name: string
  level: '精通' | '熟练' | '了解'
}

export interface ImprovementDirection {
  skill: string
  reason: string
  suggestedAction: string
  addedAt: string
}

export interface CareerMatchSnapshot {
  overallScore: number
  recommendation: string
  jobTitle: string
  jobCompany: string
  matchedAt: string
}

export type CareerStatus = 'seeking' | 'working' | 'interviewing' | 'onboarded'

export interface CareerProfile {
  id: 'default'
  updatedAt: string
  // ── 画像快照 ──
  currentRole?: string
  yearsOfExperience?: number
  education?: string
  skills: CareerSkill[]
  targetDirection?: string
  // ── 职业状态 ──
  status: CareerStatus
  // ── 长期目标 ──
  longTermGoals: string[]
  // ── 提升方向（差距报告/复盘沉淀） ──
  improvementDirections: ImprovementDirection[]
  // ── 最近匹配快照 ──
  lastMatch?: CareerMatchSnapshot
}

const DEFAULT_PROFILE: CareerProfile = {
  id: 'default',
  updatedAt: new Date().toISOString(),
  skills: [],
  status: 'seeking',
  longTermGoals: [],
  improvementDirections: [],
}

export async function getCareerProfile(): Promise<CareerProfile> {
  try {
    const existing = await db.careerProfiles.get('default')
    if (!existing) {
      await db.careerProfiles.put(DEFAULT_PROFILE)
      return DEFAULT_PROFILE
    }
    // H1：画像整体加密存 payload；旧数据（无 payload）透传
    const stored = existing as CareerProfile & { payload?: string }
    if (stored.payload) {
      const plain = await decryptText(stored.payload)
      const parsed = JSON.parse(plain)
      if (parsed && typeof parsed === 'object' && Array.isArray(parsed.skills)) {
        return { ...DEFAULT_PROFILE, ...parsed, id: 'default', updatedAt: existing.updatedAt ?? parsed.updatedAt }
      }
    }
    return existing
  } catch {
    // 页面域 DB 不可用（content script）时返回默认快照
    return DEFAULT_PROFILE
  }
}

export async function updateCareerProfile(patch: Partial<Omit<CareerProfile, 'id'>>): Promise<CareerProfile> {
  const current = await getCareerProfile()
  const next: CareerProfile = {
    ...current,
    ...patch,
    id: 'default',
    updatedAt: new Date().toISOString(),
  }
  try {
    // H1：整体 JSON 加密后写入 payload 字段（旧字段不再维护，读取统一走解密）
    const payload = await encryptText(JSON.stringify(next))
    await db.careerProfiles.put({ id: 'default', updatedAt: next.updatedAt, payload } as unknown as CareerProfile)
  } catch {
    // 忽略页面域写入失败
  }
  return next
}

/** 追加一条提升方向（去重：同技能同建议视为重复） */
export async function addImprovementDirection(dir: Omit<ImprovementDirection, 'addedAt'>): Promise<CareerProfile> {
  const current = await getCareerProfile()
  const exists = current.improvementDirections.some(
    (d) => d.skill === dir.skill && d.suggestedAction === dir.suggestedAction,
  )
  if (exists) return current
  return updateCareerProfile({
    improvementDirections: [...current.improvementDirections, { ...dir, addedAt: new Date().toISOString() }].slice(-20),
  })
}

/** 写入最近匹配快照（匹配评估完成后调用） */
export async function recordCareerMatch(snapshot: Omit<CareerMatchSnapshot, 'matchedAt'>): Promise<CareerProfile> {
  return updateCareerProfile({ lastMatch: { ...snapshot, matchedAt: new Date().toISOString() } })
}

/** 从差距报告沉淀提升方向（job-match-analyzer 输出后调用） */
export async function absorbGapSuggestions(suggestions: string[]): Promise<CareerProfile> {
  for (const s of suggestions.slice(0, 5)) {
    await addImprovementDirection({
      skill: s,
      reason: '来自匹配差距报告',
      suggestedAction: `围绕「${s}」补充项目与面试素材`,
    })
  }
  return getCareerProfile()
}

// ─── G1 · 记忆中心：职业画像清理 ───

/** 清除职业画像记忆（恢复空画像） */
export async function clearCareerProfile(): Promise<void> {
  await db.careerProfiles.delete('default')
}

/** 获取最近一次画像写入时间（记忆中心总览用） */
export async function getCareerUpdatedAt(): Promise<string | undefined> {
  const profile = await db.careerProfiles.get('default')
  return profile?.updatedAt
}
