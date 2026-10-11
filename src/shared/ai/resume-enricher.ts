import { chatCompletion } from './api-client'
import { getPrompt } from '../db/prompt-store'
import { extractSkillLevels } from '../parser/structure-extractor'
import type { Resume, ResumeProfile, SkillLevelEntry } from '../types/resume'

const SYSTEM_PROMPT = `你是资深HR和职业顾问Agent。基于求职者的简历文本，生成"简历画像"。

请按以下方式推理：
1. 推断真实工作年限 yearsOfExperience（只算正式全职工作，实习打对折；简历中有明确日期用日期，无日期按描述保守估计，范围取中值）
2. 生成一句话画像 profile："X年Y方向经验 + 核心技能 + 代表成果"，20-60字，中文
3. 技能分级 skillLevels：从简历中提取技能并按熟练度分级（expert=精通，proficient=熟练/掌握，familiar=熟悉，basic=了解/入门）
4. 成果亮点 achievementHighlights：提取3-5条含数字量化的成果；若没有数字，用"提升了什么/解决了什么"表述

只输出 JSON（不要 markdown 包裹）：
{"yearsOfExperience": 数字, "profile": "一句话画像", "skillLevels": [{"skill":"技能名","level":"expert|proficient|familiar|basic"}], "achievementHighlights": ["成果1"]}`

/** 本地生成一句话画像（无 AI 时的兜底） */
export function buildLocalProfile(structured: Resume['structuredData']): string {
  const parts: string[] = []
  const firstPosition = structured.workExperience.find((w) => w.position)?.position || ''
  if (structured.yearsOfExperience > 0) {
    const direction = firstPosition
      .replace(/工程师$|开发$|经理$|设计师$|专员$|助理$/g, '')
      .trim()
    parts.push(`${structured.yearsOfExperience}年${direction || '相关'}经验`)
  }
  const topSkills = structured.skills.slice(0, 5).join('、')
  if (topSkills) parts.push(`熟悉${topSkills}`)
  if (parts.length === 0) return structured.summary.substring(0, 50)
  return parts.join('，')
}

/** 合并本地与 AI 的技能分级：本地优先，AI 补充本地没有的技能 */
export function mergeSkillLevels(
  local: SkillLevelEntry[],
  ai: SkillLevelEntry[]
): SkillLevelEntry[] {
  const merged = new Map<string, SkillLevelEntry>()
  for (const entry of local) merged.set(entry.skill.toLowerCase(), entry)
  for (const entry of ai) {
    const key = entry.skill.toLowerCase()
    if (!merged.has(key)) merged.set(key, entry)
  }
  return Array.from(merged.values())
}

/** 从结构化数据提取量化成果（本地启发式：含数字的描述行） */
function extractLocalHighlights(structured: Resume['structuredData']): string[] {
  const highlights: string[] = []
  const numberPattern = /\d+[%万千百kK+]/
  const pool = [
    ...structured.workExperience.map((w) => w.description),
    ...structured.projects.map((p) => p.description),
  ]
  for (const desc of pool) {
    if (!desc || highlights.length >= 5) continue
    if (numberPattern.test(desc)) highlights.push(desc.substring(0, 80))
  }
  return highlights
}

async function tryAIEnrich(
  resume: Resume,
  rawText: string
): Promise<Pick<ResumeProfile, 'yearsOfExperience' | 'profile' | 'skillLevels' | 'achievementHighlights'> | null> {
  const structured = resume.structuredData
  const userMessage = `【求职者简历】
姓名: ${structured.name || '未填写'}
教育: ${JSON.stringify(structured.education)}
工作经历: ${JSON.stringify(structured.workExperience)}
项目: ${JSON.stringify(structured.projects)}
技能: ${structured.skills.join('、')}
概述: ${structured.summary.substring(0, 1500)}

【原始简历文本（前3000字）】
${rawText.substring(0, 3000)}

请按 Agent 思维流程生成简历画像 JSON。`

  const result = await chatCompletion(await getPrompt('ai.resumeEnrich', SYSTEM_PROMPT), userMessage, 0.3)
  if (!result) return null

  try {
    const jsonStr = result.match(/\{[\s\S]*\}/)?.[0]
    if (!jsonStr) return null
    const parsed = JSON.parse(jsonStr)
    const skillLevels: SkillLevelEntry[] = Array.isArray(parsed.skillLevels)
      ? parsed.skillLevels
          .filter((s: { skill?: unknown; level?: unknown }) => typeof s?.skill === 'string')
          .map((s: { skill: string; level?: string }) => ({
            skill: s.skill.trim(),
            level: ['expert', 'proficient', 'familiar', 'basic'].includes(s.level || '') ? (s.level as SkillLevelEntry['level']) : 'unknown',
          }))
      : []
    return {
      yearsOfExperience: typeof parsed.yearsOfExperience === 'number' ? Math.max(0, parsed.yearsOfExperience) : 0,
      profile: typeof parsed.profile === 'string' ? parsed.profile.trim() : '',
      skillLevels,
      achievementHighlights: Array.isArray(parsed.achievementHighlights)
        ? parsed.achievementHighlights.filter((a: unknown) => typeof a === 'string').slice(0, 5)
        : [],
    }
  } catch {
    console.error('Failed to parse AI resume profile')
    return null
  }
}

/**
 * A1: 生成 AI 简历画像。
 * 策略：本地优先（日期推算年限 + 技能分级 + 量化成果），
 * 本地年限缺失时用 AI 推断并补全一句话画像；AI 不可用时纯本地兜底。
 */
export async function enrichResumeProfile(resume: Resume, rawText: string): Promise<ResumeProfile> {
  const structured = resume.structuredData
  const generatedAt = new Date().toISOString()
  const localSkillLevels = extractSkillLevels(rawText)
  const localProfile = buildLocalProfile(structured)
  const localHighlights = extractLocalHighlights(structured)
  const hasLocalYears = structured.yearsOfExperience > 0

  // 本地已有可靠年限：融合本地技能分级/成果，画像为空时才求助 AI
  if (hasLocalYears) {
    if (localProfile && localSkillLevels.length > 0) {
      return {
        yearsOfExperience: structured.yearsOfExperience,
        skillLevels: localSkillLevels,
        profile: localProfile,
        achievementHighlights: localHighlights,
        source: 'local',
        generatedAt,
      }
    }
    const ai = await tryAIEnrich(resume, rawText)
    return {
      yearsOfExperience: structured.yearsOfExperience,
      skillLevels: mergeSkillLevels(localSkillLevels, ai?.skillLevels || []),
      profile: ai?.profile || localProfile,
      achievementHighlights: ai?.achievementHighlights?.length ? ai.achievementHighlights : localHighlights,
      source: 'hybrid',
      generatedAt,
    }
  }

  // 本地年限缺失：AI 推断补全
  const ai = await tryAIEnrich(resume, rawText)
  if (!ai) {
    return {
      yearsOfExperience: 0,
      skillLevels: localSkillLevels,
      profile: localProfile,
      achievementHighlights: localHighlights,
      source: 'local',
      generatedAt,
    }
  }
  return {
    yearsOfExperience: ai.yearsOfExperience,
    skillLevels: mergeSkillLevels(localSkillLevels, ai.skillLevels),
    profile: ai.profile || localProfile,
    achievementHighlights: ai.achievementHighlights,
    source: 'ai',
    generatedAt,
  }
}
