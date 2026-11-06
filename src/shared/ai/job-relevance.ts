// L2 过程自检 · 岗位语义相关性判定
//
// 之前 content 采集链路用 `title.includes(keyword)` 判断「这批岗位是否与搜索词相关」，
// 有两个致命误判：
//   - 假阴性：「PHP开发工程师」搜「后端开发」→ 字符串不含，被当成不相关，好词被误杀；
//   - 假阳性：「PHP技术支持」「PHP课程顾问」含 PHP，被当成相关，推荐流垃圾数据一直不被发现。
// 结果是 bot 只会数字符串，不会判断对错，抓到一堆无关岗位还继续原地空转。
//
// 本模块做两件事：
//  1. 本地语义判定：复用 job-filter 的职业族谱 + 技术栈同义词 + 非目标职能否决，零成本兜底；
//  2. AI 批量判定：一次请求把整页岗位标题交给模型，让它判断「是不是真的在招这个方向的人」，
//     返回相关编号、置信度、一句话理由。AI 不可用 / 超额 / 返回脏数据一律回退本地，且明确标注来源。
//
// 成本护栏：AI 结果按「平台+关键词+本页岗位指纹」缓存 30 分钟，重复扫同一页不重复付费；
// 每次最多送 30 个标题，超出部分沿用本地判定；海投（极速）模式默认只用本地，不花 AI 预算。
import { chatCompletion } from './api-client'
import { isJobMatchingCareer, isUnrelatedCareer } from '../agent/job-filter'

export interface RelevanceJob {
  id: string
  title: string
  tags?: string[]
  companyName?: string
}

export interface JobRelevanceInput {
  /** 本轮实际下发给平台的搜索关键词，可能为空 */
  keyword: string
  /** 从简历 / 筛选设置提取的目标职业方向 */
  targetCareers?: string[]
  jobs: RelevanceJob[]
  platform?: string
}

export type RelevanceSource = 'ai' | 'local'

export interface JobRelevanceResult {
  relevantJobIds: string[]
  irrelevantJobIds: string[]
  /** 判定为真正对口的岗位数 */
  hits: number
  source: RelevanceSource
  confidence: number
  /** 给用户看的判定理由（AI 返回或本地规则说明） */
  reason: string
  cached?: boolean
  /** 本轮真正交给 AI 审阅的岗位数 */
  aiReviewed?: number
}

/** 单次 AI 审阅的岗位上限，控制 prompt / max_tokens 体积 */
export const MAX_AI_REVIEW_JOBS = 30

const RELEVANCE_CACHE_KEY = 'aibot_relevance_cache'
const RELEVANCE_CACHE_TTL_MS = 30 * 60_000
const MAX_CACHE_ENTRIES = 40

/** 明显不是「在招这个技术方向的人」的岗位性质，含关键词字样也要否决 */
const NON_TARGET_ROLE_RE =
  /(技术支持|售后支持|售前|客服|销售|课程顾问|讲师|培训|咨询|行政|人事|招聘专员|猎头|心理咨询|空间设计|平面设计|ui设计|视觉设计|院长|主播|地推|外卖|司机|普工|操作工|保安|保洁|理财|保险经纪)/

/** 真正的技术岗语义词，用于兜底「字符串命中但岗位性质不对」 */
const DEV_ROLE_RE =
  /(开发|工程师|研发|程序员|架构|全栈|后端|前端|服务端|后台|技术负责人|技术经理|技术主管|cto|程序)/

/** 后端 / 全栈方向的常见技术栈同义词 */
const BACKEND_STACK_RE =
  /(php|laravel|thinkphp|symfony|java|spring|golang|go语言|python|django|flask|node|nestjs|\.net|c#|ruby|rust)/

/** 非开发类但用户可能主动求职的职能词，动态放行 */
const GENERIC_ROLE_WORDS = ['产品经理', '产品', '设计师', '设计', '测试', '运维', '算法', '数据', '分析师', '运营']

function cleanText(raw: string): string {
  return (raw || '')
    .toLowerCase()
    .replace(/[（(].*?[)）]/g, '')
    .replace(/[\s\-_/\\|·、,，]/g, '')
    .trim()
}

/**
 * 单个岗位的本地语义判定（导出以便单测覆盖）。
 * 与 job-filter 的「能不能入队」不同：这里只回答「这批卡片是不是这个搜索词该搜出来的」。
 */
export function computeLocalRelevance(job: RelevanceJob, input: JobRelevanceInput): boolean {
  const dirs = [input.keyword || '', ...(input.targetCareers || [])]
    .map(cleanText)
    .filter(Boolean)
  // 没有可用方向时不擅自否决，避免把「全量采集」整页判死
  if (dirs.length === 0) return true

  const title = cleanText(job.title || '')
  if (!title) return false
  const dirText = dirs.join('')

  // 用户自己就在找这类职能时不启用负向词（例如目标方向就是「产品经理」）
  const antiApplies = !NON_TARGET_ROLE_RE.test(dirText)
  if (antiApplies && NON_TARGET_ROLE_RE.test(title)) return false
  if (isUnrelatedCareer(job.title || '', dirs)) return false

  // 职业族谱 / 同义词 / 语言栈由现有过滤器统一处理
  if (isJobMatchingCareer(job.title || '', dirs)) return true

  // 「后端开发」搜出「PHP开发工程师」这类同义但不同字的命中
  const techTarget = dirs.some((d) => /后端|服务端|后台|backend|全栈|fullstack|server/i.test(d))
  if (techTarget && BACKEND_STACK_RE.test(title) && DEV_ROLE_RE.test(title)) return true

  // 用户主动找产品 / 设计 / 测试等非开发职能时，按职能词对齐
  const extraRole = GENERIC_ROLE_WORDS.find((w) => dirText.includes(w))
  if (extraRole && title.includes(extraRole)) return true

  // 字符串兜底：必须同时具备技术岗语义，挡住「PHP技术支持」
  if (dirs.some((d) => d.length >= 2 && title.includes(d)) && DEV_ROLE_RE.test(title)) return true

  return false
}

function makeResult(
  jobs: RelevanceJob[],
  flags: boolean[],
  source: RelevanceSource,
  confidence: number,
  reason: string,
  extra?: Partial<JobRelevanceResult>,
): JobRelevanceResult {
  const relevantJobIds: string[] = []
  const irrelevantJobIds: string[] = []
  jobs.forEach((j, i) => {
    if (flags[i]) relevantJobIds.push(j.id)
    else irrelevantJobIds.push(j.id)
  })
  return {
    relevantJobIds,
    irrelevantJobIds,
    hits: relevantJobIds.length,
    source,
    confidence,
    reason,
    ...extra,
  }
}

const AI_SYSTEM_PROMPT = [
  '你是招聘搜索结果的相关性审核员。判断「搜索结果里的岗位」是否真的在招目标方向的求职者。',
  '判定标准：职业性质一致才算相关，技术栈/近义词可以不同（如「后端开发」↔「PHP开发工程师 / 服务端研发 / Java 后台」）。',
  '以下一律判为不相关：只含关键词字样但岗位性质不同（如「PHP技术支持」「PHP课程顾问」「招聘PHP培训讲师」）、销售/客服/行政/设计/产品/咨询/心理等其他职能、推荐流里的杂乱岗位、实习生转正文案里的岗位名。',
  '只输出一个 JSON 对象，不要输出任何解释文字或 markdown 代码块：',
  '{"relevant":[相关岗位的编号数组，编号从 1 开始],"confidence":0到1的小数,"reason":"一句话说明本页整体情况"}',
].join('')

function buildAiUserPrompt(input: JobRelevanceInput, reviewed: RelevanceJob[]): string {
  const dirs = [input.keyword || '', ...(input.targetCareers || [])].filter(Boolean)
  const lines = reviewed.map((j, i) => {
    const tags = (j.tags || []).slice(0, 4).join('/')
    return `${i + 1}. ${j.title}${tags ? `｜标签:${tags}` : ''}`
  })
  return [
    `平台：${input.platform || '未知'}`,
    `本轮搜索关键词：${input.keyword || '（未指定）'}`,
    `目标职业方向：${dirs.join('、') || '（未指定）'}`,
    `本页共 ${reviewed.length} 个岗位：`,
    ...lines,
    '请给出 relevant 编号数组（只列真正对口的，不相关的一个都不要列）。',
  ].join('\n')
}

/** 稳健解析 AI 返回：兼容 markdown 代码块、前后废话、字符串编号、越界编号 */
export function parseRelevanceResponse(
  raw: string,
  jobCount: number,
): { relevant: number[]; confidence: number; reason: string } | null {
  if (!raw || !raw.trim()) return null
  let text = raw.trim()
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) text = fence[1].trim()
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null

  try {
    const obj = JSON.parse(text.slice(start, end + 1)) as {
      relevant?: unknown
      confidence?: unknown
      reason?: unknown
    }
    if (!Array.isArray(obj.relevant)) return null
    const nums = obj.relevant
      .map((n) => Number(n))
      .filter((n) => Number.isInteger(n) && n >= 1 && n <= jobCount)
    const relevant = Array.from(new Set(nums))
    const rawConfidence = Number(obj.confidence ?? 0.7)
    const confidence = Number.isFinite(rawConfidence)
      ? Math.min(1, Math.max(0, rawConfidence))
      : 0.7
    const reason = typeof obj.reason === 'string' ? obj.reason.slice(0, 160) : ''
    return { relevant, confidence, reason }
  } catch {
    return null
  }
}

/** djb2 字符串指纹，用于「同一页岗位」命中缓存 */
export function buildRelevanceSignature(input: JobRelevanceInput, reviewed: RelevanceJob[]): string {
  const raw = [
    input.platform || '',
    input.keyword || '',
    (input.targetCareers || []).join(','),
    reviewed.map((j) => `${j.id}:${j.title}`).join(';'),
  ].join('|')
  let hash = 5381
  for (let i = 0; i < raw.length; i++) hash = ((hash << 5) + hash + raw.charCodeAt(i)) | 0
  return `r${(hash >>> 0).toString(36)}`
}

interface CacheEntry {
  at: number
  relevant: number[]
  confidence: number
  reason: string
}

type CacheMap = Record<string, CacheEntry>

async function readRelevanceCache(key: string, now: number): Promise<CacheEntry | null> {
  try {
    if (typeof chrome === 'undefined' || !chrome.storage?.local) return null
    const res = await chrome.storage.local.get(RELEVANCE_CACHE_KEY)
    const map = (res?.[RELEVANCE_CACHE_KEY] || {}) as CacheMap
    const entry = map[key]
    if (!entry || !Array.isArray(entry.relevant)) return null
    if (now - (entry.at || 0) > RELEVANCE_CACHE_TTL_MS) return null
    return entry
  } catch {
    return null
  }
}

async function writeRelevanceCache(key: string, entry: CacheEntry): Promise<void> {
  try {
    if (typeof chrome === 'undefined' || !chrome.storage?.local) return
    const res = await chrome.storage.local.get(RELEVANCE_CACHE_KEY)
    const map = (res?.[RELEVANCE_CACHE_KEY] || {}) as CacheMap
    const entries = Object.entries(map)
      .filter(([, v]) => v && entry.at - (v.at || 0) < RELEVANCE_CACHE_TTL_MS)
      .sort((a, b) => (b[1].at || 0) - (a[1].at || 0))
      .slice(0, MAX_CACHE_ENTRIES - 1)
    const next: CacheMap = Object.fromEntries(entries)
    next[key] = entry
    await chrome.storage.local.set({ [RELEVANCE_CACHE_KEY]: next })
  } catch {
    // 缓存写失败只影响成本，不影响判定
  }
}

/**
 * 判定整页岗位与当前搜索方向的真实相关性。
 * useAi=false（海投 / 未启用 AI）时只跑本地语义；AI 失败时返回 source='local'，绝不假装是 AI 判的。
 */
export async function assessJobRelevance(
  input: JobRelevanceInput,
  opts: { useAi?: boolean; now?: number } = {},
): Promise<JobRelevanceResult> {
  const now = opts.now ?? Date.now()
  const jobs = (input.jobs || []).filter((j) => j && j.id && j.title)
  const localFlags = jobs.map((j) => computeLocalRelevance(j, input))
  const localReason = jobs.length === 0
    ? '本页未解析到岗位卡片'
    : '按职业族谱 / 技术栈同义词本地判定（AI 未参与）'
  const localResult = () => makeResult(jobs, localFlags, 'local', 0.5, localReason)

  if (!opts.useAi || jobs.length === 0) return localResult()

  const reviewed = jobs.slice(0, MAX_AI_REVIEW_JOBS)
  const signature = buildRelevanceSignature(input, reviewed)
  let parsed: { relevant: number[]; confidence: number; reason: string } | null = null
  let cached = false

  const hit = await readRelevanceCache(signature, now)
  if (hit) {
    parsed = { relevant: hit.relevant, confidence: hit.confidence, reason: hit.reason }
    cached = true
  } else {
    // chatCompletion 内部已有每日预算护栏 / 重试 / 失败标记，失败返回空串
    const raw = await chatCompletion(AI_SYSTEM_PROMPT, buildAiUserPrompt(input, reviewed), 0.1)
    parsed = parseRelevanceResponse(raw, reviewed.length)
    if (parsed) {
      await writeRelevanceCache(signature, {
        at: now,
        relevant: parsed.relevant,
        confidence: parsed.confidence,
        reason: parsed.reason,
      })
    }
  }

  // AI 未配置 / 超额 / 返回脏 JSON → 明确回退本地语义，不伪装 AI 结论
  if (!parsed) return localResult()

  const relevantSet = new Set(parsed.relevant)
  const aiFlags = jobs.map((_, i) => (i < reviewed.length ? relevantSet.has(i + 1) : localFlags[i]))
  return makeResult(
    jobs,
    aiFlags,
    'ai',
    parsed.confidence,
    parsed.reason || 'AI 已完成本页岗位语义复核',
    { cached, aiReviewed: reviewed.length },
  )
}
