// 猎聘（求职者端）平台适配器。
//
// 重要说明：以下选择器基于猎聘求职者端（www.liepin.com / m.liepin.com）的
// 常见页面结构编写，真实 DOM 会随官方改版而变化。所有标注 [待校准] 的地方
// 都需要在真实求职端页面上验证后微调。当前实现保证「可编译、可运行、不报错」，
// 实际投递前请逐项核对选择器命中情况。
import type { JobCard, MatchResult } from '../../types/job'
import type { PlatformAdapter, PlatformRiskConfig, CollectOptions, PageType, CommunicationUiSnapshot } from '../types'
import { log } from '../../utils/logger'

const JOB_CARD_SELECTOR = '.sojob-list .job-card, .job-list-box .job-item, .job-card' // [待校准]
const TITLE_SELECTOR = '.job-title, .title' // [待校准]
const COMPANY_SELECTOR = '.company-name, .company' // [待校准]
const SALARY_SELECTOR = '.salary, .job-salary' // [待校准]
const CITY_SELECTOR = '.city, .job-location' // [待校准]
const DETAIL_LINK_SELECTOR = 'a.job-title, a.title' // [待校准]
const DESC_SELECTOR = '.job-description, #job-description, .description' // [待校准]
// 猎聘求职端与 HR 沟通的入口按钮文案为「聊一聊」，其次才是投递类文案。
const APPLY_TEXTS = ['聊一聊', '立即沟通', '沟通', '投递', '立即投递', '投简历', '申请'] // [待校准]

function q<T extends Element = HTMLElement>(sel: string, root: ParentNode = document): T | null {
  return root.querySelector<T>(sel)
}

function qa<T extends Element = HTMLElement>(sel: string, root: ParentNode = document): T[] {
  return Array.from(root.querySelectorAll<T>(sel))
}

function findButtonByText(root: ParentNode, texts: string[]): HTMLElement | null {
  const candidates = qa<HTMLElement>('button, a', root)
  // 按 texts 的优先级顺序查找：先找命中「聊一聊」的按钮，找不到再依次退回其它文案，
  // 避免误点到页面上其它含「沟通」等字样的无关按钮。
  for (const t of texts) {
    const hit = candidates.find((b) => (b.textContent || '').includes(t))
    if (hit) return hit
  }
  return null
}

function extractId(url: string): string {
  return url.match(/job\/([\w-]+)/)?.[1] || url
}

function detectPageType(): PageType {
  const url = location.href
  if (url.includes('/job/') || url.includes('jobdetail')) return 'detail'
  if (url.includes('zhaopin') || url.includes('/so/') || url.includes('search')) return 'search'
  if (url.includes('msg') || url.includes('chat') || url.includes('im')) return 'chat'
  return 'other'
}

function parseJobCardsFromSearchPage(): JobCard[] {
  const cards = qa(JOB_CARD_SELECTOR)
  const result: JobCard[] = []
  for (const card of cards) {
    const titleEl = q(TITLE_SELECTOR, card)
    const title = (titleEl?.textContent || '').trim()
    if (!title) continue
    const linkEl = q<HTMLAnchorElement>(DETAIL_LINK_SELECTOR, card)
    const url = linkEl?.href || location.href
    const city = (q(CITY_SELECTOR, card)?.textContent || '').trim()
    result.push({
      id: extractId(url),
      title,
      companyName: (q(COMPANY_SELECTOR, card)?.textContent || '').trim(),
      companyLogo: '',
      salary: (q(SALARY_SELECTOR, card)?.textContent || '').trim(),
      location: city,
      experience: '',
      education: '',
      tags: [],
      jobDescription: '',
      bossName: '',
      bossTitle: '',
      bossOnline: false,
      publishedAt: '',
      url,
      platformId: 'liepin',
    })
  }
  return result
}

function parseJobDetailFromPage(): JobCard | null {
  const titleEl = q(TITLE_SELECTOR)
  if (!titleEl) return null
  const title = (titleEl.textContent || '').trim()
  const url = location.href
  const city = (q(CITY_SELECTOR)?.textContent || '').trim()
  return {
    id: extractId(url),
    title,
    companyName: (q(COMPANY_SELECTOR)?.textContent || '').trim(),
    companyLogo: '',
    salary: (q(SALARY_SELECTOR)?.textContent || '').trim(),
    location: city,
    experience: '',
    education: '',
    tags: [],
    jobDescription: '',
    bossName: '',
    bossTitle: '',
    bossOnline: false,
    publishedAt: '',
    url,
    platformId: 'liepin',
  }
}

function extractJobDescriptionFromDetail(root: ParentNode = document): string {
  const descEl = q(DESC_SELECTOR, root)
  return (descEl?.textContent || '').replace(/\s+/g, ' ').trim()
}

async function collectJobCards(
  readCurrentCards: () => JobCard[],
  options?: CollectOptions,
): Promise<JobCard[]> {
  const maxPages = options?.maxPages ?? 5
  const maxJobs = options?.maxJobs && options.maxJobs > 0 ? options.maxJobs : Infinity
  const delayBetweenPages = options?.delayBetweenPages ?? 2000
  const onCountChange = options?.onCountChange
  const shouldCancel = options?.shouldCancel
  const collected: JobCard[] = []
  const seen = new Set<string>()
  for (let page = 0; page < maxPages; page++) {
    if (shouldCancel?.()) break
    if (collected.length >= maxJobs) break
    const cards = readCurrentCards()
    for (const c of cards) {
      if (collected.length >= maxJobs) break
      if (c.url && !seen.has(c.url)) {
        seen.add(c.url)
        collected.push(c)
      }
    }
    onCountChange?.(collected.length)
    if (collected.length >= maxJobs) break
    if (page < maxPages - 1) {
      const next = q('.pagination .next, a.next, .sojob-pagination .next') // [待校准]
      if (next && !(next as HTMLElement).classList.contains('disabled')) {
        ;(next as HTMLElement).click()
      } else {
        window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' })
      }
      await new Promise((r) => setTimeout(r, delayBetweenPages))
      if (shouldCancel?.()) break
    }
  }
  log('[liepin]', 'collect', `已收集 ${collected.length} 个职位`)
  return collected
}

async function activateJobCard(
  _jobUrl: string,
  jobId: string,
  expectedTitle?: string,
): Promise<HTMLElement | null> {
  // [待校准] 猎聘职位卡片常以 <a> 形式直接跳转详情页；以下为合理实现，需按真实结构核对。
  const card =
    q(`[data-job-id="${jobId}"]`) ||
    qa(JOB_CARD_SELECTOR).find(
      (el) => (q(TITLE_SELECTOR, el)?.textContent || '').trim() === (expectedTitle || ''),
    )
  if (!card) return null

  const link = q<HTMLAnchorElement>(DETAIL_LINK_SELECTOR, card)
  if (link?.href) {
    window.open(link.href, '_blank')
  } else {
    card.click()
  }

  // 轮询等待详情容器出现（[待校准]：根据实际详情容器调整）
  const start = Date.now()
  while (Date.now() - start < 15000) {
    const detail = q(DESC_SELECTOR) || q('.job-detail')
    if (detail) return detail
    await new Promise((r) => setTimeout(r, 500))
  }
  return document.body
}

async function clickApplyButton(jobCard: HTMLElement): Promise<boolean> {
  const btn = findButtonByText(jobCard, APPLY_TEXTS) || findButtonByText(document, APPLY_TEXTS)
  if (!btn) return false
  btn.click()
  await new Promise((r) => setTimeout(r, 800))
  return true
}

async function fillGreetingMessage(
  message: string,
): Promise<boolean> {
  // [待校准] 猎聘招呼输入框选择器
  const input =
    (q<HTMLTextAreaElement>('textarea.greeting-input') as HTMLTextAreaElement | null) ||
    (q<HTMLInputElement>('input.greeting-input') as HTMLInputElement | null)
  if (!input) return false
  const valueSetter =
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set ??
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
  if (valueSetter) valueSetter.call(input, message)
  else (input as HTMLInputElement).value = message
  input.dispatchEvent(new Event('input', { bubbles: true }))
  input.dispatchEvent(new Event('change', { bubbles: true }))
  return true
}

function getJobSpecificGreeting(resumeName: string, job: JobCard, match: MatchResult): string {
  const relevantSkills = match.skillMatch.filter(Boolean).slice(0, 3).join('、')
  const experience = relevantSkills
    ? `我有${relevantSkills}相关经验，`
    : '我的经历与该岗位方向较匹配，'
  return `您好，我是${resumeName}，看到${job.companyName}正在招聘“${job.title}”。${experience}希望能进一步沟通。`
}

function snapshotCommunicationUi(): CommunicationUiSnapshot {
  // [待校准] 当前返回空快照；猎聘输入框定位在 fillGreetingMessage 中按选择器处理。
  return { inputs: new Set(), visibleDialogs: new Set() }
}

const riskConfig: PlatformRiskConfig = {
  id: 'liepin',
  name: '猎聘',
  dailyLimitMarkers: ['今日已投递', '投递上限', '次数已达上限', '今日投递次数', '沟通上限', '今日沟通'],
  rateLimitMarkers: ['操作频繁', '操作太频繁', '稍后再试', '请稍后', '重试'],
  blockMarkers: ['账号异常', '账号被封', '检测到异常', '账号已被', '暂时无法', '被限制'],
  captchaMarkers: ['安全验证', '滑动验证', '验证码', '请完成验证'],
}

export const liepinAdapter: PlatformAdapter = {
  id: 'liepin',
  name: '猎聘',
  icon: '🦁',
  homeUrl: 'https://www.liepin.com/',
  // 求职者端主要为 www / m 子域；c.liepin.com 为企业 H 端，不在此匹配。
  matchesUrl: (url) => /(www|m)\.liepin\.com/i.test(url),
  detectPageType,
  parseJobCardsFromSearchPage,
  parseJobDetailFromPage,
  extractJobDescriptionFromDetail,
  collectJobCards,
  activateJobCard,
  clickApplyButton,
  fillGreetingMessage,
  getJobSpecificGreeting,
  snapshotCommunicationUi,
  getRiskConfig: () => riskConfig,
}
