// 前程无忧（51Job）平台适配器
// 基于 2026-10 实测的列表结构：.joblist > .joblist-item（标题/薪资/地点/标签/公司/投递按钮）。
// 详情页存在反爬验证，选择器采用多候选回退（登录态用户通常可正常访问）。
// 所有选择器均为"多候选 + 兜底"，站点改版时优先调整这里的选择器常量。
import { collectJobCards as collectJobCardsGeneric } from '../boss/action-simulator'
import type { PlatformAdapter, PlatformRiskConfig, PageType } from '../types'
import type { JobCard } from '../../types/job'
import type { CommunicationUiSnapshot } from '../types'

// ===== 选择器常量（集中维护，便于站点改版时调整） =====
export const SELECTORS = {
  listContainer: '.joblist',
  card: '.joblist-item',
  title: '.joblist-item-jobname, .job-info.text-cut',
  info: '.joblist-item-jobinfo, .joblist-item-jobinfo.text-cut',
  area: '.area',
  tags: '.joblist-item-tags .tags, .joblist-item-tags',
  company: '.joblist-item-right .company_name, .joblist-item-right',
  applyButton: '.joblist-item button, .joblist-item [class*="apply"]',
  // 详情页（多候选回退）
  detailTitle: '.job-title, .tJobName, [class*="job-name"] h1, h1',
  detailSalary: '.job-money, .sal, [class*="salary"], .joblist-item-jobinfo',
  detailCompany: '.company-name, .cname, [class*="company-name"]',
  detailDesc: '.job_msg, .bmsg, #jobdesc, [class*="job-description"], [class*="jobDescription"], [class*="job-desc"]',
  detailApply: 'button[class*="apply"]',
}

// ===== 工具函数 =====
function textOf(root: ParentNode | null, selector: string): string {
  if (!root) return ''
  const el = root.querySelector(selector)
  return el ? (el.textContent || '').trim() : ''
}

function extractIdFromUrl(url: string): string {
  // jobs.51job.com/{city}/{jobId}.html
  const m = url.match(/jobs\.51job\.com\/[^/]+\/(\d+)\.html/)
  return m ? m[1] : url
}

const salaryPattern = /(\d+(?:\.\d+)?\s*[-~]\s*\d+(?:\.\d+)?\s*(?:万|千|k|K)|[0-9]+-?[0-9]*\s*(?:万|千|K|k)\/?[0-9]*\s*(?:薪|万)?)/

// ===== 页面类型 =====
function detectPageType(): PageType {
  const url = window.location.href
  if (/jobs\.51job\.com\//.test(url) && !/search/i.test(url)) {
    // 详情页：jobs.51job.com/{city}/{id}.html（排除带 search 的列表入口）
    if (/jobs\.51job\.com\/[a-z-]+\/\d+\.html/.test(url)) return 'detail'
  }
  if (/we\.51job\.com\/pc\/search|search\.51job\.com|51job\.com\/jobs/i.test(url)) return 'search'
  return 'other'
}

// ===== 列表解析 =====
function parseJobCardsFromSearchPage(): JobCard[] {
  const container = document.querySelector(SELECTORS.listContainer)
  if (!container) return []
  const cards: JobCard[] = []

  container.querySelectorAll<HTMLElement>(SELECTORS.card).forEach((cardEl) => {
    const titleEl = cardEl.querySelector(SELECTORS.title)
    const title = titleEl ? (titleEl.textContent || '').trim() : ''
    if (!title) return

    // 详情链接：优先 jobs.51job.com 岗位链接，其次卡片 data 属性，最后公司页链接
    const detailLink = cardEl.querySelector<HTMLAnchorElement>('a[href*="jobs.51job.com"]')
    const jobUrl = detailLink?.href
      || (cardEl.getAttribute('data-url') || '')
      || (cardEl.querySelector('a')?.href || '')
    const id = detailLink?.href ? extractIdFromUrl(detailLink.href) : (cardEl.getAttribute('data-jobid') || String(Date.now()))

    const infoText = textOf(cardEl, SELECTORS.info)
    const areaText = textOf(cardEl, SELECTORS.area)
    // 薪资在 info 中通常位于 area 之前
    let salary = ''
    const infoMatch = infoText.match(salaryPattern)
    if (infoMatch) salary = infoMatch[1]
    if (!salary) {
      // 详情面板式：薪资可能在 title 行
      const titleRow = cardEl.textContent || ''
      const m = titleRow.match(salaryPattern)
      if (m) salary = m[1]
    }

    const tags: string[] = []
    cardEl.querySelectorAll(`${SELECTORS.tags} span, ${SELECTORS.tags} .tag, ${SELECTORS.tags}`).forEach((el) => {
      const tagText = (el.textContent || '').trim()
      if (tagText && tagText.length <= 20 && !tags.includes(tagText) && !/五险一金|绩效奖金|员工旅游|带薪年假|节日福利|定期体检/.test(tagText)) {
        tags.push(tagText)
      }
    })

    cards.push({
      id,
      title,
      companyName: textOf(cardEl, SELECTORS.company),
      companyLogo: '',
      salary,
      location: areaText || extractLocation(infoText),
      experience: '',
      education: '',
      tags: tags.slice(0, 8),
      jobDescription: '',
      bossName: '',
      bossTitle: '',
      bossOnline: false,
      publishedAt: '',
      url: jobUrl,
      platformId: '51job',
    })
  })

  return cards
}

function extractLocation(infoText: string): string {
  const m = infoText.match(/([\u4e00-\u9fff]+·[\u4e00-\u9fff]+)/)
  return m ? m[1] : ''
}

// ===== 详情解析（多候选回退） =====
function parseJobDetailFromPage(): JobCard | null {
  const url = window.location.href
  const id = extractIdFromUrl(url)
  const title = textOf(document, SELECTORS.detailTitle) || document.title.replace(/_前程无忧|招聘/g, '').trim()
  const salaryText = textOf(document, SELECTORS.detailSalary)
  const company = textOf(document, SELECTORS.detailCompany)
  const desc = extractJobDescriptionFromDetail()

  const salaryMatch = salaryText.match(salaryPattern)
  return {
    id,
    title,
    companyName: company,
    companyLogo: '',
    salary: salaryMatch ? salaryMatch[1] : '',
    location: extractLocation(salaryText),
    experience: '',
    education: '',
    tags: [],
    jobDescription: desc,
    bossName: '',
    bossTitle: '',
    bossOnline: false,
    publishedAt: '',
    url,
    platformId: '51job',
  }
}

function extractJobDescriptionFromDetail(root?: ParentNode): string {
  // 多候选：经典容器优先；root 找不到时回退到 document（详情可能挂在 body 下）
  const scopes: Array<ParentNode | null> = [root ?? null, document]
  for (const scope of scopes) {
    if (!scope) continue
    for (const selector of [SELECTORS.detailDesc, '.j_joblist', '.tCompanyPage', '#jobDetail', '.job-detail']) {
      const el = scope.querySelector(selector)
      if (el && (el.textContent || '').trim().length > 30) {
        return (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 4000)
      }
    }
  }
  return ''
}

// ===== 动作 =====
async function activateJobCard(jobUrl: string, jobId: string): Promise<HTMLElement | null> {
  if (jobUrl && /jobs\.51job\.com/.test(jobUrl)) {
    window.open(jobUrl, '_blank')
    // 新详情页加载前，返回当前页面候选详情容器
    return document.querySelector<HTMLElement>(SELECTORS.detailDesc) as HTMLElement | null
  }
  // 无详情链接时：点击卡片所在行（51job 新版点击行跳详情/展开详情）
  const card = document.querySelector<HTMLElement>(`${SELECTORS.card}[data-jobid="${jobId}"]`) ||
    Array.from(document.querySelectorAll<HTMLElement>(SELECTORS.card)).find((el) =>
      (el.textContent || '').includes(jobId),
    )
  card?.click()
  await new Promise((resolve) => setTimeout(resolve, 300))
  // 优先返回页面上的详情描述容器（可能由点击展开）；否则返回卡片行
  return (document.querySelector<HTMLElement>(SELECTORS.detailDesc) ||
    document.querySelector<HTMLElement>(SELECTORS.card)) as HTMLElement | null
}

async function clickApplyButton(_jobCard: HTMLElement): Promise<boolean> {
  // 列表卡片内的投递按钮
  const btn = _jobCard.querySelector<HTMLElement>('button, [class*="apply"], [class*="deliver"]')
  if (btn) {
    btn.click()
    return true
  }
  // 详情页投递按钮
  const detailBtn = Array.from(document.querySelectorAll<HTMLElement>('button, a')).find((el) =>
    (el.textContent || '').trim().includes('投递'),
  )
  if (detailBtn) {
    detailBtn.click()
    return true
  }
  return false
}

async function fillGreetingMessage(
  _message: string,
  _snapshot?: CommunicationUiSnapshot,
): Promise<boolean> {
  // 51job 投递简历模式：无招呼语输入框；如出现简历选择弹窗则点确定
  const confirmBtn = Array.from(document.querySelectorAll<HTMLElement>('button')).find((el) =>
    /确定|确认|投递/.test((el.textContent || '').trim()),
  )
  if (confirmBtn) {
    confirmBtn.click()
    return true
  }
  return true
}

function getJobSpecificGreeting(_resumeName: string, job: JobCard, _match: unknown): string {
  return `您好，我在前程无忧看到贵司的「${job.title}」岗位，我的经历与岗位要求比较匹配，方便进一步沟通吗？`
}

function snapshotCommunicationUi(): CommunicationUiSnapshot {
  return {
    inputs: new Set(document.querySelectorAll('textarea, input[type="text"]')),
    visibleDialogs: new Set(),
    hasInput: !!document.querySelector('textarea, input[type="text"]'),
    inputSelector: 'textarea, input[type="text"]',
    sendButton: '',
    applyButtons: Array.from(document.querySelectorAll('button')).filter((el) =>
      (el.textContent || '').includes('投递'),
    ).length,
  }
}

// ===== 风控配置 =====
const riskConfig: PlatformRiskConfig = {
  id: '51job',
  name: '前程无忧',
  dailyLimitMarkers: ['已达上限', '投递次数已达上限', '今日投递', '次数已用完', '明天再来'],
  rateLimitMarkers: ['操作太频繁', '操作频繁', '请稍后再试'],
  blockMarkers: ['账号异常', '账号已被限制', '验证失败', '访问验证'],
  captchaMarkers: ['滑动验证', '访问验证', '请进行验证', '安全验证'],
}

export const job51Adapter: PlatformAdapter = {
  id: '51job',
  name: '前程无忧',
  icon: '📮',
  homeUrl: 'https://we.51job.com/pc/search',
  matchesUrl: (url) => /(?:^|[/.])51job\.com/i.test(url),
  detectPageType,
  parseJobCardsFromSearchPage,
  parseJobDetailFromPage,
  extractJobDescriptionFromDetail,
  collectJobCards: collectJobCardsGeneric,
  activateJobCard,
  clickApplyButton,
  fillGreetingMessage,
  getJobSpecificGreeting,
  snapshotCommunicationUi,
  getRiskConfig: () => riskConfig,
}
