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

/** 单个搜索词的最大长度：超过即认为是“一段描述”而不是“一个职位名”，直接丢弃 */
const MAX_KEYWORD_LEN = 12
/** 关键词矩阵最多保留数量（轮转巡检用） */
const MAX_KEYWORDS = 8

/**
 * 把用户填写的期望职位等文本切成一个个可用的搜索词。
 * 支持逗号 / 顿号 / 分号 / 竖线 / 斜杠 / 换行，
 * 避免「商城后台维护、BUG 修复与新增功能开发」这类整句被当成一个搜索词。
 */
function splitKeywordTokens(raw: string): string[] {
  return raw
    .split(/[,，、;；\n|/\\]+/)
    .map(sanitizeKeyword)
    .filter(Boolean)
}

/** 是否是可直接用于平台搜索的干净短词 */
function isUsableKeyword(token: string): boolean {
  if (token.length < 2 || token.length > MAX_KEYWORD_LEN) return false
  return /[\u4e00-\u9fa5a-zA-Z]/.test(token)
}

/**
 * 公司名 / 项目名 / 简历字段噪音。
 * 简历里的「项目角色」常写成「某某科技网站 全栈独立开发」，
 * 一旦被当搜索词扔给招聘平台，搜出来的结果基本是空的——必须硬拦。
 */
const COMPANY_NOISE_RE = /(有限公司|公司|集团|科技|网络|信息技术|智创|工作室|网站|平台|系统|项目|简历|求职|负责|参与|主导)/

/** 职位语义词：从简历等自由文本抽词时的强校验，避免把公司名当职位 */
const ROLE_SEMANTIC_RE =
  /(开发|工程师|前端|后端|服务端|后台|全栈|架构|技术经理|技术主管|研发|测试|运维|算法|数据|产品经理|AI|智能体|PHP|Java|Go|Python|Node|React|Vue|Laravel|小程序)/

/**
 * 提取自主搜索关键词。
 *
 * 设计原则：**只使用可信的职位名来源**，宁可少也不能脏。
 *  - 用户明确填写的「期望职位」→ 直接用
 *  - 简历里的「工作经历-职位」（如「PHP开发工程师」）→ 通过职位语义校验后使用
 *  - 简历姓名 / 个人简介长句 / 项目名称 / 求职底线 → **一律不参与**，
 *    这些自由文本抽出来的几乎都是公司名或非职位词，会直接污染搜索结果。
 */
export function extractSearchKeywords(
  resume?: Resume | null,
  _preferences?: CandidateProfilePreferences,
  filters?: ApplyFilters,
): string[] {
  const keywordSet = new Set<string>()

  // 1. 用户明确填写的期望职位（按顿号等多分隔符拆分，仅剔除公司名噪音）
  if (filters?.jobTitles) {
    for (const t of splitKeywordTokens(filters.jobTitles)) {
      if (isUsableKeyword(t) && !COMPANY_NOISE_RE.test(t)) keywordSet.add(t)
    }
  }

  // 2. 简历工作经历中的职位名称——招聘流程里的标准职位名，最可靠的第二来源
  for (const w of resume?.structuredData?.workExperience || []) {
    for (const t of splitKeywordTokens(w.position || '')) {
      if (
        isUsableKeyword(t) &&
        ROLE_SEMANTIC_RE.test(t) &&
        !COMPANY_NOISE_RE.test(t)
      ) {
        keywordSet.add(t)
      }
    }
  }

  // 3. 简历名称 / 文件名：只在「含职位语义」时采用
  //    「全栈架构师」「张三-全栈开发-6年」→ 取出职位；「张三」这种人名直接丢弃，
  //    绝不能用求职者姓名去搜岗位。
  if (resume?.name) {
    const nameParts = resume.name
      .replace(/\.[a-zA-Z0-9]+$/, '')
      .replace(/[（(].*?[)）]/g, ' ')
      .split(/[\s\-_—]+/)
      .map(sanitizeKeyword)
      .filter(Boolean)
    for (const t of nameParts) {
      if (isUsableKeyword(t) && ROLE_SEMANTIC_RE.test(t) && !COMPANY_NOISE_RE.test(t)) {
        keywordSet.add(t)
      }
    }
  }

  const usable = Array.from(keywordSet).filter(isUsableKeyword).slice(0, MAX_KEYWORDS)

  // 3. 若提取结果为空，提供行业通用主流兜底词库
  if (usable.length === 0) {
    return ['全栈工程师', '前端开发工程师', '后端开发工程师', '技术经理']
  }

  return usable
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
