// 针对简历职业画像与筛选偏好的高精度岗位过滤器

import type { JobCard } from '../types/job'
import type { Resume } from '../types/resume'
import type { ApplyFilters } from '../types/filters'
import { parseSalaryRange } from '../types/filters'

/**
 * 从简历或筛选设置中提取期望的岗位职业名称清单
 */
export function extractTargetCareers(
  resume?: Resume | null,
  filters?: ApplyFilters | null,
): string[] {
  const result: string[] = []

  // 1. 优先取用户在筛选器中明确填写的岗位名称
  if (filters?.jobTitles && filters.jobTitles.trim()) {
    const list = filters.jobTitles
      .trim()
      .split(/[,;\s|]+/)
      .map((s) => s.trim())
      .filter((s) => s.length >= 2)
    result.push(...list)
  }

  // 2. 若未手动设置，从简历解析的意向或最近一段工作职务中提取
  if (result.length === 0 && resume) {
    // 2.1 结构化工作经历中的最近一段职位
    const latestPos = resume.structuredData?.workExperience?.[0]?.position
    if (latestPos && latestPos.trim()) {
      result.push(latestPos.trim())
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

/**
 * 校验岗位标题是否与用户的目标职业方向对齐
 */
export function isJobMatchingCareer(jobTitle: string, targetCareers: string[]): boolean {
  if (!targetCareers || targetCareers.length === 0) return true
  if (!jobTitle) return false

  const rawTitle = jobTitle.toLowerCase().trim()
  const cleanTitle = rawTitle.replace(/[（(].*?[）)]/g, '').replace(/[\s\-_/\\|]/g, '')

  // 1. 无关职业负向硬拦截（除非用户目标职位本身包含这些词）
  const UNRELATED_CAREER_RE =
    /(销售|电销|地推|招商|电话客服|在线客服|前台|行政|人事|招聘顾问|财务|出纳|会计|保安|保洁|房产中介|置业顾问|店员|导购|外卖骑手|司机|兼职刷单)/
  const isTargetUnrelated = targetCareers.some((t) => UNRELATED_CAREER_RE.test(t))
  if (!isTargetUnrelated && UNRELATED_CAREER_RE.test(cleanTitle)) {
    return false
  }

  // 2. 正向多方向判定
  for (const rawTarget of targetCareers) {
    const target = rawTarget.toLowerCase().replace(/[\s\-_/\\|（）()]/g, '')
    if (!target) continue

    // 2.1 包含或被包含
    if (cleanTitle.includes(target) || target.includes(cleanTitle)) {
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

    // 后端族谱
    if (
      (target.includes('后端') || target.includes('backend') || target.includes('服务端')) &&
      (cleanTitle.includes('后端') ||
        cleanTitle.includes('backend') ||
        cleanTitle.includes('服务端') ||
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
    blacklist?: Set<string>
  },
): { pass: boolean; reason?: string } {
  const { filters, targetCareers = [], blacklist = new Set() } = options

  // 1. 黑名单公司检查
  if (job.companyName && blacklist.has(job.companyName.trim())) {
    return { pass: false, reason: `命中企业黑名单（${job.companyName}）` }
  }

  // 2. 职业方向检查
  if (targetCareers.length > 0 && !isJobMatchingCareer(job.title, targetCareers)) {
    return {
      pass: false,
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
