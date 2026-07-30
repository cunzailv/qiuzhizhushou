import { db } from '../db'
import type { AgentSkill, AgentStep } from './types'

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
}

/** 计算页面结构指纹（按钮文本的简单 hash） */
export function computeSignature(state: { buttons: { text: string }[] }): string {
  return state.buttons.slice(0, 10).map(b => b.text).join('|')
}

/** 查找匹配的缓存 Skill */
export async function findBestSkill(
  platform: string,
  pageType: string,
  goal: string
): Promise<AgentSkill | null> {
  const now = Date.now()
  const skills = await db.agentSkills
    .where('[platform+pageType+goal]')
    .equals([platform, pageType, goal])
    .filter(s => s.expiresAt > now && s.failCount < 3)
    .sortBy('successCount')

  return skills.reverse()[0] || null
}

/** 保存或更新 Skill */
export async function upsertSkill(params: {
  platform: string
  pageType: string
  goal: string
  steps: AgentStep[]
  selectorSignature: string
}): Promise<void> {
  const existing = await db.agentSkills
    .where('[platform+pageType+goal]')
    .equals([params.platform, params.pageType, params.goal])
    .first()

  if (existing) {
    // 新步骤更少 → 替换；否则保持旧的并增加计数
    if (params.steps.length < existing.steps.length) {
      await db.agentSkills.update(existing.id, {
        steps: params.steps,
        successCount: existing.successCount + 1,
        lastUsedAt: Date.now(),
        expiresAt: Date.now() + 14 * 86400000,
        selectorSignature: params.selectorSignature,
      })
    } else {
      await db.agentSkills.update(existing.id, {
        successCount: existing.successCount + 1,
        lastUsedAt: Date.now(),
      })
    }
  } else {
    await db.agentSkills.put({
      id: generateId(),
      platform: params.platform,
      pageType: params.pageType,
      goal: params.goal,
      steps: params.steps,
      successCount: 1,
      failCount: 0,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      expiresAt: Date.now() + 14 * 86400000,
      selectorSignature: params.selectorSignature,
    })
  }
}

/** 记录 Skill 失败 */
export async function recordSkillFail(skill: AgentSkill): Promise<void> {
  await db.agentSkills.update(skill.id, {
    failCount: skill.failCount + 1,
    lastUsedAt: Date.now(),
  })
}
