// 针对简历职业画像与筛选偏好的高精度岗位过滤器

import type { JobCard } from '../types/job'
import type { Resume } from '../types/resume'
import type { ApplyFilters } from '../types/filters'
import { parseSalaryRange } from '../types/filters'
import {
  isCrossStackJob,
  describeCrossStackReason,
  type TechStack,
} from './stack-guard'
import {
  NON_DEV_ROLE_RE,
  STRONG_DEV_ROLE_RE,
  DEV_SEMANTIC_RE,
  isGenericCareerToken,
  isJobTitleAllowed,
  isCareerGateActive,
} from './career-gate'

/**
 * 从简历或筛选设置中提取期望的岗位职业名称清单
 */
/** 单个目标职业词的最大长度，超长即视为“描述句”而非职位名 */
const MAX_CAREER_LEN = 12
/** 明显不属于职业方向的公司/项目/职责噪音 */
const CAREER_NOISE_RE = /(有限公司|公司|科技|集团|网站|平台|系统|项目|独立开发项目|负责|参与|主导|简历)/

/** 职位语义片段（从长描述中提取真正的职业方向用） */
const CAREER_SEMANTIC_SRC =
  '[\\u4e00-\\u9fa5A-Za-z]{0,4}(?:全栈|前端|后端|服务端|后台|小程序|架构|技术经理|技术主管|算法|数据开发|测试|运维|开发|工程师|PHP|Java|Go|Python|Node)[\\u4e00-\\u9fa5A-Za-z]{0,4}'

/** 把单个片段清洗为可用的职业方向短词 */
function pushCareerToken(raw: string, out: string[]): void {
  const clean = raw
    .replace(/[（(].*?[)）]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!clean) return

  // 含空格的多词串先按空格拆开分别校验
  // 例「全栈工程师 技术经理」→ 两个独立方向；「某某网站 全栈独立开发」→ 前者含噪音被丢弃
  if (/\s/.test(clean)) {
    const spaceParts = clean.split(/\s+/).filter(Boolean)
    if (spaceParts.length > 1) {
      for (const sp of spaceParts) pushCareerToken(sp, out)
      return
    }
  }

  // 干净短词，直接采用
  if (clean.length >= 2 && clean.length <= MAX_CAREER_LEN && !CAREER_NOISE_RE.test(clean)) {
    out.push(clean)
    return
  }

  // 超长/含噪音且无法再拆：从描述中抽取职位语义片段
  const semantic = clean.match(new RegExp(`(${CAREER_SEMANTIC_SRC})`, 'i'))
  if (semantic?.[1]) {
    const token = semantic[1].replace(/\s+/g, ' ').trim()
    if (token.length >= 2 && token.length <= MAX_CAREER_LEN) out.push(token)
  }
}

/**
 * 把一段“期望职位 / 项目角色”文本清洗成可直接用于岗位方向匹配的短词列表。
 * 兼容三处历史遗留：用户手动粘贴的整句、AI 进化提案写入的长句、
 * 以及简历里「公司名 + 岗位描述」的工作/项目经历字段。
 * 例：「刚刚好智创网站 全栈独立开发 / AI全栈:后台开发」→「全栈独立开发 / AI全栈 / 后台开发」
 */
export function normalizeCareerTokens(raw: string): string[] {
  const out: string[] = []
  const parts = raw
    .split(/[,，、;；\n|/\\:：]+/)
    .map((s) => s.trim())
    .filter(Boolean)

  for (const part of parts) pushCareerToken(part, out)

  return Array.from(new Set(out))
}

/**
 * 诊断一段方向文本：返回清洗后保留的词与被剔除的词。
 * 用于在日志里明确告知“哪个公司名/长句被丢掉了”，避免用户困惑词从哪来。
 */
export function diagnoseCareerTokens(raw: string): { kept: string[]; dropped: string[] } {
  const kept = normalizeCareerTokens(raw)
  const keptSet = new Set(kept)
  const dropped: string[] = []

  const parts = raw
    .split(/[,，、;；\n|/\\:：]+/)
    .map((s) => s.trim())
    .filter(Boolean)

  for (const part of parts) {
    const clean = part.replace(/[（(].*?[)）]/g, '').replace(/\s+/g, ' ').trim()
    if (!clean) continue

    const subParts = clean.split(/\s+/).filter(Boolean)
    if (subParts.length > 1) {
      // 多词混串：逐个子片段报告，否则「公司名 + 岗位」这种只会报“部分保留”，
      // 用户永远看不到哪个公司名被丢掉了
      for (const sp of subParts) {
        if (!keptSet.has(sp)) dropped.push(sp)
      }
      continue
    }

    // 单词片段：被语义抽取改写过（本身不在 kept 里但存在包含关系）不算丢弃
    const rewritten = kept.some((k) => clean.includes(k) || k.includes(clean))
    if (!rewritten && !keptSet.has(clean)) dropped.push(clean)
  }

  return { kept, dropped: Array.from(new Set(dropped)) }
}

export function extractTargetCareers(
  resume?: Resume | null,
  filters?: ApplyFilters | null,
): string[] {
  const result: string[] = []

  // 1. 优先取用户在筛选器中明确填写的岗位名称（先清洗成干净短词）
  if (filters?.jobTitles && filters.jobTitles.trim()) {
    result.push(...normalizeCareerTokens(filters.jobTitles))
  }

  // 2. 未设置或清洗后为空时，从简历解析的意向或最近一段工作职务中提取
  if (result.length === 0 && resume) {
    // 2.1 结构化工作经历中的最近一段职位
    const latestPos = resume.structuredData?.workExperience?.[0]?.position
    if (latestPos && latestPos.trim()) {
      result.push(...normalizeCareerTokens(latestPos))
    }

    // 2.2 简历名称中的职位（例如 "张三-全栈开发-6年.pdf"）
    if (resume.name) {
      const nameTokens = resume.name
        .replace(/\.[a-zA-Z0-9]+$/, '')
        .split(/[-_—\s]+/)
      for (const tok of nameTokens) {
        if (
          /(全栈|前端|后端|开发|工程师|架构师|技术经理|主管|总监|算法|AI|智能体|运维|测试|产品)/i.test(
            tok,
          ) &&
          !/(\d+年|简历|求职|本科|硕士|大专)/.test(tok)
        ) {
          result.push(tok.trim())
        }
      }
    }

    // 2.3 简历画像中的一句话简介提及的职位
    const profileText = resume.profile?.profile || resume.structuredData?.summary || ''
    const matchRole = profileText.match(
      /(全栈[开发工程师]*|技术经理|架构师|前端[开发工程师]*|后端[开发工程师]*|AI[开发工程师]*)/,
    )
    if (matchRole && matchRole[1]) {
      result.push(matchRole[1])
    }
  }

  // 去重返回
  return Array.from(new Set(result.filter(Boolean)))
}

/** 与技术人员明确无关的行业/职能（销售、客服、行政等） */
const UNRELATED_CAREER_RE =
  /(销售|电销|地推|招商|电话客服|在线客服|前台|行政|人事|招聘顾问|财务|出纳|会计|保安|保洁|房产中介|置业顾问|店员|导购|外卖骑手|司机|兼职刷单)/

/**
 * 岗位是否属于与目标方向无关的行业。
 * 独立导出是因为「方向放宽」时 targetCareers 会变成空数组，
 * 此时原来的硬拦截会被跳过，导致销售/客服岗被大量灌进投递队列。
 */
export function isUnrelatedCareer(jobTitle: string, targetCareers: string[] = []): boolean {
  if (!jobTitle) return false
  const cleanTitle = jobTitle
    .toLowerCase()
    .replace(/[（(].*?[)）)]/g, '')
    .replace(/[\s\-_/\\|]/g, '')
  if (!UNRELATED_CAREER_RE.test(cleanTitle)) return false
  // 「前台开发工程师」「销售系统开发工程师」是开发岗，别被行政/销售字样误杀
  if (STRONG_DEV_ROLE_RE.test(cleanTitle)) return false
  // 用户目标方向本身就包含这类词时放行（例如他就是要找销售岗）
  return !targetCareers.some((t) => UNRELATED_CAREER_RE.test(t))
}

/**
 * 校验岗位标题是否与用户的目标职业方向对齐
 */
export function isJobMatchingCareer(jobTitle: string, targetCareers: string[]): boolean {
  if (!targetCareers || targetCareers.length === 0) return true
  if (!jobTitle) return false

  const rawTitle = jobTitle.toLowerCase().trim()
  const cleanTitle = rawTitle.replace(/[（(].*?[）)]/g, '').replace(/[\s\-_/\\|]/g, '')

  // 1. 无关职业负向硬拦截（除非用户目标职位本身包含这些词）
  if (isUnrelatedCareer(jobTitle, targetCareers)) {
    return false
  }

  // 1.2 岗位名称硬闸门的负向职能否决：
  // 「AI产品经理」含 ai、「销售工程师」含工程师，旧版靠包含规则会被判成方向匹配。
  // 只有标题主部确实是开发岗（「XX系统开发工程师」）才继续走族谱判定。
  const nonDevHit = cleanTitle.match(NON_DEV_ROLE_RE)?.[0] || ''
  if (nonDevHit) {
    const userWantsIt = targetCareers.some((c) =>
      c.toLowerCase().includes(nonDevHit.toLowerCase()),
    )
    if (!userWantsIt && !STRONG_DEV_ROLE_RE.test(cleanTitle)) return false
  }

  // 2. 正向多方向判定
  for (const rawTarget of targetCareers) {
    const target = rawTarget.toLowerCase().replace(/[\s\-_/\\|（）()]/g, '')
    if (!target) continue

    // 2.1 包含或被包含：泛词（AI / 大模型 / 数据 …）不能单独证明岗位对口，
    //     必须同时具备技术岗语义，否则「AI产品经理」会因为含 ai 被误判为相关。
    if (cleanTitle.includes(target) || target.includes(cleanTitle)) {
      if (isGenericCareerToken(rawTarget) && !DEV_SEMANTIC_RE.test(cleanTitle)) continue
      return true
    }

    // 2.2 职业同义族谱对齐
    // 全栈族谱
    if (
      (target.includes('全栈') || target.includes('fullstack')) &&
      (cleanTitle.includes('全栈') ||
        cleanTitle.includes('fullstack') ||
        cleanTitle.includes('前后端'))
    ) {
      return true
    }

    // 技术管理与架构族谱
    if (
      (target.includes('技术经理') ||
        target.includes('技术主管') ||
        target.includes('研发经理') ||
        target.includes('架构师')) &&
      (cleanTitle.includes('技术经理') ||
        cleanTitle.includes('技术主管') ||
        cleanTitle.includes('研发主管') ||
        cleanTitle.includes('研发经理') ||
        cleanTitle.includes('架构师') ||
        cleanTitle.includes('技术负责人') ||
        cleanTitle.includes('techlead') ||
        cleanTitle.includes('teamleader') ||
        cleanTitle.includes('cto'))
    ) {
      return true
    }

    // 前端族谱
    if (
      (target.includes('前端') || target.includes('frontend')) &&
      (cleanTitle.includes('前端') || cleanTitle.includes('frontend') || cleanTitle.includes('web开发'))
    ) {
      return true
    }

    // 后端族谱（“后台”是招聘平台对后端的常见写法，必须同等对待）
    if (
      (target.includes('后端') ||
        target.includes('backend') ||
        target.includes('服务端') ||
        target.includes('后台')) &&
      (cleanTitle.includes('后端') ||
        cleanTitle.includes('backend') ||
        cleanTitle.includes('服务端') ||
        cleanTitle.includes('后台') ||
        cleanTitle.includes('server'))
    ) {
      return true
    }

    // AI 与智能体族谱
    if (
      (target.includes('ai') ||
        target.includes('智能体') ||
        target.includes('agent') ||
        target.includes('大模型')) &&
      (cleanTitle.includes('ai') ||
        cleanTitle.includes('智能体') ||
        cleanTitle.includes('agent') ||
        cleanTitle.includes('大模型') ||
        cleanTitle.includes('算法') ||
        cleanTitle.includes('llm') ||
        cleanTitle.includes('aigc'))
    ) {
      // 泛 AI 方向同样要求岗位本身是技术岗，别把「AI产品经理」算成 AI 开发岗
      if (isGenericCareerToken(rawTarget) && !DEV_SEMANTIC_RE.test(cleanTitle)) continue
      return true
    }

    // 语言技术栈族谱
    for (const lang of ['java', 'python', 'golang', 'php', 'rust', 'c++', 'node']) {
      if (target.includes(lang) && cleanTitle.includes(lang)) return true
    }
  }

  return false
}

/**
 * 校验岗位活跃时间/发布时间的新鲜度
 */
export function isJobMatchingFreshness(publishedAt?: string, freshness = 'week'): boolean {
  if (!freshness || freshness === 'all') {
    // 即便不限，默认也排除"半年前活跃"此类常年无人打理的废弃岗位
    if (publishedAt && /(半年前|超1个月|2月前|3月前)/.test(publishedAt)) {
      return false
    }
    return true
  }

  // 页面卡片未渲染出时间标签时放行兜底
  if (!publishedAt || !publishedAt.trim()) return true

  const text = publishedAt.trim()

  switch (freshness) {
    case 'today':
      return /(刚刚|今日|今天|\d+分钟前|\d+小时前)/.test(text)
    case '3days':
      return /(刚刚|今日|今天|\d+分钟前|\d+小时前|昨天|昨日|1天前|2天前|3天前|3日内)/.test(text)
    case 'week':
      return (
        /(刚刚|今日|今天|\d+分钟前|\d+小时前|昨天|昨日|[1-7]天前|3日内|本周|周内)/.test(text) ||
        !/(半年前|超1个月|2月前|3月前|4月前|5月前|6月前|本月)/.test(text)
      )
    case 'month':
      return !/(半年前|超1个月|2月前|3月前|4月前|5月前|6月前)/.test(text)
    default:
      return true
  }
}

/**
 * 全方位评估候选岗位卡片，判定是否通过所有筛选并准入待投队列
 */
export function evaluateJobCandidate(
  job: JobCard,
  options: {
    filters?: ApplyFilters | null
    targetCareers?: string[]
    /** 用户方向里明确的技术栈（PHP / Java / 前端…），用于硬否决跨栈岗位 */
    targetStacks?: TechStack[]
    blacklist?: Set<string>
    /**
     * 采集层已用 career-gate 做过岗位名称硬闸门时置 true，
     * 跳过下面这条族谱白名单（同义不同字会被它误杀），但硬闸门本身仍会再跑一次兜底。
     */
    careerGateChecked?: boolean
  },
): { pass: boolean; reason?: string; soft?: boolean } {
  const {
    filters,
    targetCareers = [],
    targetStacks = [],
    blacklist = new Set(),
    careerGateChecked = false,
  } = options

  // 1. 黑名单公司检查
  if (job.companyName && blacklist.has(job.companyName.trim())) {
    return { pass: false, reason: `命中企业黑名单（${job.companyName}）` }
  }

  // 1.5 无关行业硬拦截：必须在方向列表为空（放宽模式）时同样生效，
  //     否则一旦放宽方向，销售/客服/行政岗会直接灌进投递队列。
  if (isUnrelatedCareer(job.title, targetCareers)) {
    return { pass: false, reason: `职业方向不匹配（无关行业：${job.title}）` }
  }

  // 1.6 技术栈硬拦截：目标方向明确写了 PHP 时，「Java开发」「前端开发」不能进队列，
  //     也绝不允许被后面的软过滤补足名额塞回来（所以不设 soft）。
  //     通用词「后端开发工程师」不带具体栈，照常放行交给匹配分。
  if (targetStacks.length > 0 && isCrossStackJob(job.title, targetStacks)) {
    return {
      pass: false,
      reason: `技术栈不符（${describeCrossStackReason(job.title, targetStacks)}）`,
    }
  }

  // 1.7 岗位名称硬闸门：任何模式（精投 / 海投 / 极速 / 必达 / 放宽）都不可绕过。
  //     采集层会前置跑一次以便单独统计，这里再兜底一次防止其它调用方漏掉。
  //     注意：这里绝不返回 soft —— 方向不匹配的岗位不允许被软补足偷偷塞回队列。
  if (isCareerGateActive(targetCareers)) {
    const verdict = isJobTitleAllowed(job.title, targetCareers)
    if (!verdict.allowed) {
      return { pass: false, reason: `职业方向（岗位名称硬闸门）：${verdict.reason}` }
    }
  }

  // 2. 职业方向检查（软过滤：不匹配不等于不可投，交由 AI 匹配分最终把关）
  //    采集层已启用硬闸门时跳过：族谱白名单会把「后台开发」搜到的「PHP开发工程师」
  //    误判为不匹配，重复过滤只会砍掉供给，方向正确性已由 1.7 保证。
  if (!careerGateChecked && targetCareers.length > 0 && !isJobMatchingCareer(job.title, targetCareers)) {
    return {
      pass: false,
      soft: true,
      reason: `职业方向不匹配（目标: ${targetCareers.join(' / ')}，岗位: ${job.title}）`,
    }
  }

  // 3. 发布时间/活跃度新鲜度检查
  const freshness = filters?.publishTime || 'week'
  if (!isJobMatchingFreshness(job.publishedAt, freshness)) {
    return {
      pass: false,
      reason: `岗位活跃度不符（要求: ${freshness}，当前: ${job.publishedAt || '未知'}）`,
    }
  }

  // 4. 用户基础筛选器规则校验（薪资、城市、学历、年限、排除词）
  if (filters) {
    // 4.1 排除关键词（公司名、岗位标题、标签等）
    if (filters.excludeKeywords && filters.excludeKeywords.trim()) {
      const exList = filters.excludeKeywords.trim().toLowerCase().split(/\s+/).filter(Boolean)
      const targets = [job.companyName, job.title, job.jobDescription, ...(job.tags || [])]
        .join(' ')
        .toLowerCase()
      if (exList.some((kw) => targets.includes(kw))) {
        return { pass: false, reason: '包含用户设置的排除关键词' }
      }
    }

    // 4.2 薪资范围匹配
    if (filters.salaryMin !== null || filters.salaryMax !== null) {
      const range = parseSalaryRange(job.salary)
      if (range) {
        const [jMin, jMax] = range
        if (filters.salaryMin !== null && jMax < filters.salaryMin) {
          return { pass: false, reason: `岗位薪资（${job.salary}）低于最低要求（${filters.salaryMin}K）` }
        }
        if (filters.salaryMax !== null && jMin > filters.salaryMax) {
          return { pass: false, reason: `岗位薪资（${job.salary}）高于最高要求（${filters.salaryMax}K）` }
        }
      }
    }

    // 4.3 地点匹配
    if (filters.locations && filters.locations.trim()) {
      const locKeywords = filters.locations.trim().toLowerCase().split(/\s+/).filter(Boolean)
      const locLower = (job.location || '').toLowerCase()
      if (locKeywords.length > 0 && !locKeywords.some((kw) => locLower.includes(kw))) {
        return { pass: false, reason: `工作地点（${job.location}）不符合要求` }
      }
    }

    // 4.4 经验要求匹配
    if (filters.experience && filters.experience.trim()) {
      const expLower = (job.experience || '').toLowerCase()
      if (!expLower.includes(filters.experience.toLowerCase())) {
        return { pass: false, reason: `经验要求（${job.experience}）不符合（要求: ${filters.experience}）` }
      }
    }

    // 4.5 学历要求匹配
    if (filters.education && filters.education.trim()) {
      const eduLower = (job.education || '').toLowerCase()
      if (!eduLower.includes(filters.education.toLowerCase())) {
        return { pass: false, reason: `学历要求（${job.education}）不符合（要求: ${filters.education}）` }
      }
    }
  }

  return { pass: true }
}
