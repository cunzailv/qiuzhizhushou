/**
 * 「沟通筛选条件」的单一真源。
 *
 * 概览半自动（EXECUTE_APPLY）与 AIbot 全自动（campaign-service 的自动补仓）都必须
 * 通过这里读写同一批 setting_ 键，避免某一侧硬编码或写进另一套键导致配置不同步。
 *
 * 历史遗留：早期版本把 AI 评分开关写成 filterEnableAiMatch，而 assistant-state /
 * content / AIbot 页读的是 enableAiMatch。读取时以 enableAiMatch 为准，
 * 仅在它缺失时回退到旧键；写入时两个键都写，保证老版本也能读到。
 */
import { getSetting, setSetting } from '../db/settings-store'
import type { ApplyFilters } from '../types/filters'
import { DEFAULT_FILTERS } from '../types/filters'

export const AI_MATCH_KEY = 'enableAiMatch'
export const LEGACY_AI_MATCH_KEY = 'filterEnableAiMatch'
export const MIN_MATCH_SCORE_KEY = 'filterMinMatchScore'

/** 读取全部共享筛选配置；任何一侧（popup / content / background）调用结果一致 */
export async function loadSharedApplyFilters(): Promise<ApplyFilters> {
  const [
    jobTitles,
    locations,
    salaryMin,
    salaryMax,
    experience,
    education,
    excludeKeywords,
    publishTime,
    legacyEnableAiMatch,
    storedEnableAiMatch,
    minMatchScore,
  ] = await Promise.all([
    getSetting<string>('filterJobTitles', DEFAULT_FILTERS.jobTitles),
    getSetting<string>('filterLocations', DEFAULT_FILTERS.locations),
    getSetting<number | null>('filterSalaryMin', DEFAULT_FILTERS.salaryMin),
    getSetting<number | null>('filterSalaryMax', DEFAULT_FILTERS.salaryMax),
    getSetting<string>('filterExperience', DEFAULT_FILTERS.experience),
    getSetting<string>('filterEducation', DEFAULT_FILTERS.education),
    getSetting<string>('filterExcludeKeywords', DEFAULT_FILTERS.excludeKeywords),
    getSetting<string>('filterPublishTime', DEFAULT_FILTERS.publishTime ?? 'week'),
    getSetting<boolean>(LEGACY_AI_MATCH_KEY, DEFAULT_FILTERS.enableAiMatch),
    getSetting<boolean | null>(AI_MATCH_KEY, null),
    getSetting<number>(MIN_MATCH_SCORE_KEY, DEFAULT_FILTERS.minMatchScore),
  ])

  return {
    jobTitles,
    locations,
    salaryMin,
    salaryMax,
    experience,
    education,
    excludeKeywords,
    publishTime,
    enableAiMatch: storedEnableAiMatch ?? legacyEnableAiMatch,
    minMatchScore,
  }
}

/** 只持久化真正变化的字段；AI 评分开关双写以兼容旧版本读者 */
export async function persistSharedFilters(updates: Partial<ApplyFilters>): Promise<void> {
  const tasks: Array<Promise<void>> = []
  const push = (key: string, value: unknown) => { tasks.push(setSetting(key, value)) }

  if (updates.jobTitles !== undefined) push('filterJobTitles', updates.jobTitles)
  if (updates.locations !== undefined) push('filterLocations', updates.locations)
  if (updates.salaryMin !== undefined) push('filterSalaryMin', updates.salaryMin)
  if (updates.salaryMax !== undefined) push('filterSalaryMax', updates.salaryMax)
  if (updates.experience !== undefined) push('filterExperience', updates.experience)
  if (updates.education !== undefined) push('filterEducation', updates.education)
  if (updates.excludeKeywords !== undefined) push('filterExcludeKeywords', updates.excludeKeywords)
  if (updates.publishTime !== undefined) push('filterPublishTime', updates.publishTime)
  if (updates.minMatchScore !== undefined) push(MIN_MATCH_SCORE_KEY, updates.minMatchScore)
  if (updates.enableAiMatch !== undefined) {
    push(AI_MATCH_KEY, updates.enableAiMatch)
    push(LEGACY_AI_MATCH_KEY, updates.enableAiMatch)
  }

  await Promise.all(tasks)
}
