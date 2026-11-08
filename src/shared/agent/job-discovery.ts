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
 * 单独拿去平台搜索会命中大量非目标岗位的「泛技术修饰词」。
 *
 * 用户按界面提示用空格填「php开发 后端开发 AI 全栈开发」时，按空格拆出的
 * 孤立「AI」会占用一轮轮转，去 5 个平台搜回 AI 产品经理 / 算法 / 数据标注岗，
 * 正是 PHP 后端方向反复反馈的「乱投递」来源。这类词只有和后面的职位词
 * 组成「AI 全栈开发」才是用户真正想要的岗位名。
 */
const GENERIC_MODIFIER_RE = /^(ai|人工智能|大模型|智能体|agent|aigc|llm)$/i

/** 职位语义词：用来识别「泛修饰词 + 职位词」的组合 */
const ROLE_WORD_RE = /(开发|工程师|全栈|前端|后端|后台|服务端|架构|研发|测试|运维|算法|产品)/

/** 是否是不能单独当搜索词的泛词（含职位语义的组合词 / 职位词都不算） */
export function isGenericNoiseKeyword(token: string): boolean {
  return GENERIC_MODIFIER_RE.test(token.trim()) && !ROLE_WORD_RE.test(token)
}

/**
 * 把用户填写的期望职位等文本切成一个个可用的搜索词。
 * 支持逗号 / 顿号 / 分号 / 竖线 / 斜杠 / 换行 / **空格**。
 *
 * 空格必须切：「php 后台开发」「AI 全栈开发」如果整串扔给招聘平台，
 * 基本搜不到结果，平台会降级成推荐流，随后什么岗位都采进来。
 * 但纯拆也有代价：「AI 全栈开发」会掉出孤立的「AI」这个泛词，
 * 所以额外把「泛修饰词 + 职位词」补成一个组合词放队尾，
 * 孤立泛词再由 extractSearchKeywords 统一过滤。
 * 原始短词组同样保留在队尾，作为一次更精准的尝试。
 */
function splitKeywordTokens(raw: string): string[] {
  const out: string[] = []
  for (const part of raw.split(/[,，、;；\n|/\\]+/)) {
    const original = sanitizeKeyword(part)
    if (!original) continue

    const words = original.split(/\s+/).map(sanitizeKeyword).filter(Boolean)
    const combos: string[] = []
    for (let i = 0; i < words.length; i++) {
      const word = words[i]
      if (word && !out.includes(word)) out.push(word)

      // 「AI 全栈开发」这类：泛修饰词后面紧跟职位词时，补一次更精准的组合尝试。
      // 连续泛词串（如「AI Agent 架构师」）由原始短词组整体保留，不造半截词。
      const prev = words[i - 1]
      const next = words[i + 1]
      const prevIsGeneric = prev ? GENERIC_MODIFIER_RE.test(prev) : false
      if (
        word && next &&
        GENERIC_MODIFIER_RE.test(word) &&
        ROLE_WORD_RE.test(next) &&
        !prevIsGeneric
      ) {
        const combo = `${word} ${next}`
        if (combo.length <= MAX_KEYWORD_LEN && !combos.includes(combo)) combos.push(combo)
      }
    }
    if (original.length <= MAX_KEYWORD_LEN && !out.includes(original)) out.push(original)
    for (const combo of combos) {
      if (!out.includes(combo)) out.push(combo)
    }
  }
  return out
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
 * 简历技能 / 项目技术栈里能直接拿去平台搜索的词。
 * 用户反馈「简历里明明有 AI 开发、PHP、全栈，为什么不拿去搜」——
 * 旧版只读了「期望职位 / 工作经历职位 / 文件名」，技能清单完全没参与。
 */
const SKILL_KEYWORD_RE =
  /^(php|laravel|thinkphp|java|golang|go语言|python|node\.?js|\.net|c\+\+|rust|全栈|后端|后台|服务端|前端|ai|人工智能|大模型|智能体|agent|react|vue|小程序|架构师|技术经理|数据分析|算法)/i

/** 一句话画像里常见的标准职位名，补成可直接搜索的组合词 */
const PROFILE_ROLE_RE =
  /(PHP开发|全栈开发|AI开发|后端开发|后台开发|服务端开发|前端开发|人工智能开发|大模型开发|架构师|技术经理)/gi

function collectResumeSkillKeywords(resume?: Resume | null): string[] {
  if (!resume) return []
  const out: string[] = []
  const rawSkills: string[] = [
    ...(resume.structuredData?.skills || []).slice(0, 24),
    ...(resume.structuredData?.projects || []).flatMap((p) => p.technologies || []).slice(0, 16),
    ...(resume.profile?.skillLevels || [])
      .filter((s) => s.level === 'expert' || s.level === 'proficient')
      .map((s) => s.skill),
  ]
  for (const raw of rawSkills) {
    const token = sanitizeKeyword(String(raw || ''))
    if (!isUsableKeyword(token) || COMPANY_NOISE_RE.test(token)) continue
    if (!SKILL_KEYWORD_RE.test(token)) continue
    out.push(token)
  }

  const profileText = `${resume.profile?.profile || ''} ${resume.structuredData?.summary || ''}`
  for (const m of profileText.matchAll(PROFILE_ROLE_RE)) {
    if (m[1]) out.push(m[1])
  }
  return out
}

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

  // 4. 简历技能 / 项目技术栈 / 画像职位名：用户没填期望职位时的主要来源
  for (const t of collectResumeSkillKeywords(resume)) {
    if (isUsableKeyword(t) && !COMPANY_NOISE_RE.test(t)) keywordSet.add(t)
  }

  // 所有来源（岗位名称 / 工作经历 / 简历技能）统一清掉孤立泛词：
  // ROLE_SEMANTIC_RE 里含「AI」，工作经历字段拆出的「AI」原本会漏过语义校验。
  const usable = Array.from(keywordSet)
    .filter((t) => isUsableKeyword(t) && !isGenericNoiseKeyword(t))
    .slice(0, MAX_KEYWORDS)

  // 不再提供「全栈工程师 / 前端开发工程师 …」这类与用户无关的硬编码兜底词：
  // 那会让 PHP 后端用户真的去搜前端岗位并投递，是「乱投递」的直接来源。
  // 一个可信关键词都没有时返回空，由调度层明确提示用户去填期望职位，而不是替他猜。
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
  excludeKeywords?: string[],
): Promise<{
  keyword: string
  index: number
  total: number
  allKeywords: string[]
  /** true 表示所有关键词都已被排除（都搜不到相关岗位），需要人工介入 */
  exhausted: boolean
  /** 暂停原因：没有可用词 / 全部被标无效，供界面给出不同的提示 */
  reason: 'ok' | 'no_keywords' | 'all_invalid'
}> {
  const allKeywords = extractSearchKeywords(resume, preferences, filters)
  const excludedSet = new Set((excludeKeywords || []).map((k) => k.trim()).filter(Boolean))
  const candidates = allKeywords.filter((k) => !excludedSet.has(k))

  if (candidates.length === 0) {
    log(MOD, 'getNextSearchKeyword', `No usable keyword (total=${allKeywords.length})`)
    return {
      keyword: '',
      index: -1,
      total: allKeywords.length,
      allKeywords,
      exhausted: true,
      reason: allKeywords.length === 0 ? 'no_keywords' : 'all_invalid',
    }
  }

  const currentIndex = await getDiscoveryKeywordRotationIndex()
  const safeIndex = currentIndex % candidates.length
  const keyword = candidates[safeIndex]

  // 自动推进游标至下一个关键词，供下一次巡检使用
  await advanceDiscoveryKeywordRotationIndex(candidates.length)

  log(MOD, 'getNextSearchKeyword', `Selected keyword: "${keyword}" (${safeIndex + 1}/${candidates.length})`)

  return {
    keyword,
    index: safeIndex,
    total: candidates.length,
    allKeywords,
    exhausted: false,
    reason: 'ok',
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
