// 待投队列全自主搜寻采集中枢 (Auto Job Discovery & Queue Feeder)
import type { Resume } from '../types/resume'
import type { CandidateProfilePreferences } from '../types/candidate-profile'
import type { ApplyFilters } from '../types/filters'
import type { Campaign } from './queue-store'
import { getSetting, setSetting } from '../db/settings-store'
import { log } from '../utils/logger'

const MOD = 'JobDiscovery'
const KEYWORD_INDEX_KEY = 'autonomous_discovery_keyword_index'

/** 清洗并提取干净的关键词 */
function sanitizeKeyword(raw: string): string {
  return raw
    .trim()
    .replace(/[（(].*?[)）]/g, '')
    .replace(/[/\\_-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 从简历、求职偏好及筛选器中智能归纳并提取多维自主搜索关键词矩阵
 */
export function extractSearchKeywords(
  resume?: Resume | null,
  preferences?: CandidateProfilePreferences,
  filters?: ApplyFilters,
): string[] {
  const keywordSet = new Set<string>()

  // 1. 优先来自用户手动设定的搜索期望职位
  if (filters?.jobTitles) {
    const customTitles = filters.jobTitles
      .split(/[,，;\n|]+/)
      .map(sanitizeKeyword)
      .filter((k) => k.length >= 2)
    for (const t of customTitles) {
      keywordSet.add(t)
    }
  }

  // 2. 从简历结构化数据中提取职位与核心角色
  if (resume) {
    if (resume.name) {
      const cleanName = sanitizeKeyword(resume.name)
      if (cleanName.length >= 2) keywordSet.add(cleanName)
    }

    // 历史工作经历的职位名称
    const workPositions = (resume.structuredData?.workExperience || [])
      .map((w) => sanitizeKeyword(w.position || ''))
      .filter((p) => p.length >= 2)
    for (const pos of workPositions) {
      keywordSet.add(pos)
    }

    // 简历画像或摘要中的核心方向
    if (resume.profile?.profile) {
      const match = resume.profile.profile.match(/(\d+年)?(.*?)(经验|方向|架构|全栈|开发)/)
      if (match && match[2]) {
        const clean = sanitizeKeyword(match[2])
        if (clean.length >= 2 && clean.length <= 15) keywordSet.add(clean)
      }
    }

    // 项目经历角色
    const projectRoles = (resume.structuredData?.projects || [])
      .map((p) => sanitizeKeyword(p.role || ''))
      .filter((r) => r.length >= 2 && r.length <= 12)
    for (const r of projectRoles) {
      keywordSet.add(r)
    }
  }

  // 3. 从求职偏好中提取目标方向
  if (preferences?.customBottomLines) {
    const customMatches = preferences.customBottomLines.match(/[a-zA-Z0-9\u4e00-\u9fa5]{2,10}/g) || []
    for (const m of customMatches.slice(0, 3)) {
      if (!['不接受', '不考虑', '拒绝', '必须'].includes(m)) {
        keywordSet.add(sanitizeKeyword(m))
      }
    }
  }

  // 4. 若提取结果为空，提供行业通用主流兜底词库
  if (keywordSet.size === 0) {
    return ['全栈工程师', '前端开发工程师', '后端开发工程师', '技术经理']
  }

  return Array.from(keywordSet).slice(0, 8)
}

/** 获取当前自主搜索轮转关键词游标 */
export async function getDiscoveryKeywordRotationIndex(): Promise<number> {
  return getSetting<number>(KEYWORD_INDEX_KEY, 0)
}

/** 推进关键词轮转游标 */
export async function advanceDiscoveryKeywordRotationIndex(total: number): Promise<number> {
  if (total <= 0) return 0
  const current = await getDiscoveryKeywordRotationIndex()
  const next = (current + 1) % total
  await setSetting(KEYWORD_INDEX_KEY, next)
  return next
}

/**
 * 依据当前游标获取下一轮巡检的目标搜索关键词
 */
export async function getNextSearchKeyword(
  resume?: Resume | null,
  preferences?: CandidateProfilePreferences,
  filters?: ApplyFilters,
): Promise<{
  keyword: string
  index: number
  total: number
  allKeywords: string[]
}> {
  const allKeywords = extractSearchKeywords(resume, preferences, filters)
  const currentIndex = await getDiscoveryKeywordRotationIndex()
  const safeIndex = currentIndex % allKeywords.length
  const keyword = allKeywords[safeIndex]

  // 自动推进游标至下一个关键词，供下一次巡检使用
  await advanceDiscoveryKeywordRotationIndex(allKeywords.length)

  log(MOD, 'getNextSearchKeyword', `Selected keyword: "${keyword}" (${safeIndex + 1}/${allKeywords.length})`)

  return {
    keyword,
    index: safeIndex,
    total: allKeywords.length,
    allKeywords,
  }
}

/**
 * 判断当前待投队列是否低于自动补仓水位线 (默认 < 5)
 */
export function isQueueBelowThreshold(campaign: Campaign, threshold = 5): boolean {
  const pendingCount = (campaign.tasks || []).filter((t) => t.status === 'pending').length
  return pendingCount < threshold
}

/**
 * 生成全自主搜寻补仓成果日志文案
 */
export function formatDiscoveryLogMessage(params: {
  keyword: string
  platform: string
  discovered: number
  added: number
  pendingCount: number
}): string {
  if (params.added > 0) {
    return `📥 [全自主采集中枢] 针对关键词【${params.keyword}】在【${params.platform}】自主发现 ${params.discovered} 个岗位，精准过滤并新增入队 ${params.added} 个优质岗位！当前待投队列增至 ${params.pendingCount + params.added} 个。`
  }
  return `ℹ️ [全自主采集中枢] 针对关键词【${params.keyword}】在【${params.platform}】扫描完成，暂无更多未投递新增岗位，自动轮转至下一关键词。`
}
