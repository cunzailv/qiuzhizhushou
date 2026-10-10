// 脉脉平台适配器（保守策略）
// 说明：脉脉岗位列表需登录（2026-10 调研时登录被跳过，未实采 DOM）。
// 因此本适配器采用：URL/页面识别 + 多候选通用选择器 + 文本兜底提取；
// 待用户在登录态实测后，可依据真实结构微调顶部 SELECTORS 常量。
// 投递模式：脉脉为社交招聘，岗位通过「沟通/打招呼」展开，走 fillGreetingMessage 半自动确认。
import { collectJobCards as collectJobCardsGeneric } from '../boss/action-simulator'
import type { PlatformAdapter, PlatformRiskConfig, PageType } from '../types'
import type { JobCard } from '../../types/job'
import type { CommunicationUiSnapshot } from '../types'

// ===== 选择器常量（多候选，登录态实测后校准） =====
export const SELECTORS = {
  card: '[class*="job-card"], [class*="jobCard"], [class*="position-card"], [class*="rec-card"]',
  title: '[class*="job-title"], [class*="jobName"], [class*="position-name"], h3, [class*="title"]',
  salary: '[class*="salary"], [class*="money"], [class*="pay"]',
  company: '[class*="company"], [class*="corp"], [class*="org"]',
  tags: '[class*="tag"], [class*="label"]',
  // 详情/沟通面板
  detailPanel: '[class*="job-detail"], [class*="jobDetail"], [class*="position-detail"]',
  desc: '[class*="description"], [class*="desc"], [class*="requirement"], [class*="content"]',
  applyButton: '[class*="apply"], [class*="deliver"]',
  chatInput: 'textarea, [contenteditable="true"]',
  sendButton: 'button[class*="send"], [class*="发送"], button[class*="submit"]',
}

function textOf(root: ParentNode | null, selector: string): string {
  if (!root) return ''
  const el = root.querySelector(selector)
  return el ? (el.textContent || '').trim() : ''
}

const salaryPattern = /(\d+(?:\.\d+)?\s*[-~]\s*\d+(?:\.\d+)?\s*(?:万|千|k|K)|面议|[\d]+-[\d]+\s*[kK万])/i

// ===== 页面类型 =====
function detectPageType(): PageType {
  const url = window.location.href
  if (/search_center.*type=job|maimai\.cn\/job/i.test(url)) return 'search'
  if (/maimai\.cn\/(web\/)?(job|jobs)\//i.test(url)) return 'detail'
  if (/maimai\.cn\/(chat|web\/chat)/i.test(url)) return 'chat'
  return 'other'
}

// ===== 通用文本兜底提取 =====
function extractJobFromElement(el: HTMLElement): JobCard | null {
  const text = (el.textContent || '').replace(/\s+/g, ' ').trim()
  if (text.length < 10) return null

  const title = textOf(el, SELECTORS.title) || (text.match(/(?:招聘|职位|岗位)[:：]?\s*([\u4e00-\u9fffA-Za-z0-9（）()·-]{2,20})/) || [])[1] || ''
  if (!title) return null

  const salaryMatch = (textOf(el, SELECTORS.salary) || text).match(salaryPattern)
  const companyMatch = text.match(/(?:公司|企业)[:：]?\s*([\u4e00-\u9fffA-Za-z0-9（）()·]{2,30})/)
  const locationMatch = text.match(/[\u4e00-\u9fff]+·[\u4e00-\u9fff]+/)

  const tags: string[] = []
  el.querySelectorAll(SELECTORS.tags).forEach((tagEl) => {
    const t = (tagEl.textContent || '').trim()
    if (t && t.length <= 16 && !tags.includes(t) && !/关注|沟通|投递|薪资/.test(t)) tags.push(t)
  })

  const link = el.querySelector<HTMLAnchorElement>('a[href]')
  return {
    id: link?.href || text.slice(0, 24),
    title,
    companyName: companyMatch ? companyMatch[1] : textOf(el, SELECTORS.company),
    companyLogo: '',
    salary: salaryMatch ? salaryMatch[1] : '',
    location: locationMatch ? locationMatch[0] : '',
    experience: '',
    education: '',
    tags: tags.slice(0, 6),
    jobDescription: '',
    bossName: '',
    bossTitle: '',
    bossOnline: false,
    publishedAt: '',
    url: link?.href || '',
    platformId: 'maimai',
  }
}

// ===== 列表解析（多候选 + 兜底） =====
function parseJobCardsFromSearchPage(): JobCard[] {
  const cards: JobCard[] = []
  const candidates = document.querySelectorAll<HTMLElement>(SELECTORS.card)
  const seen = new Set<string>()

  if (candidates.length > 0) {
    candidates.forEach((el) => {
      const job = extractJobFromElement(el)
      if (job && !seen.has(job.title + job.companyName)) {
        seen.add(job.title + job.companyName)
        cards.push(job)
      }
    })
  }

  // 兜底：无卡片容器时，从列表区文本块提取
  if (cards.length === 0) {
    const blocks = Array.from(document.querySelectorAll<HTMLElement>('li, article, [class*="item"]'))
    blocks.forEach((el) => {
      const job = extractJobFromElement(el)
      if (job && !seen.has(job.title + job.companyName)) {
        seen.add(job.title + job.companyName)
        cards.push(job)
      }
    })
  }

  return cards.slice(0, 100)
}

// ===== 详情解析（保守） =====
function parseJobDetailFromPage(): JobCard | null {
  const panel = document.querySelector(SELECTORS.detailPanel) as HTMLElement | null
  return extractJobFromElement(panel || document.body)
}

function extractJobDescriptionFromDetail(root?: ParentNode): string {
  const target = root || document
  const candidates: HTMLElement[] = []
  target.querySelectorAll<HTMLElement>(SELECTORS.desc).forEach((el) => {
    const text = (el.textContent || '').trim()
    if (text.length > 30 && text.length < 8000) candidates.push(el)
  })
  if (candidates.length === 0) return ''
  const best = candidates.sort((a, b) => (b.textContent || '').length - (a.textContent || '').length)[0]
  return (best.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 4000)
}

// ===== 动作 =====
async function activateJobCard(jobUrl: string, _jobId: string): Promise<HTMLElement | null> {
  if (jobUrl) {
    window.open(jobUrl, '_blank')
    return document.querySelector(SELECTORS.detailPanel) as HTMLElement | null
  }
  const card = document.querySelector<HTMLElement>(SELECTORS.card)
  card?.click()
  await new Promise((resolve) => setTimeout(resolve, 300))
  return document.querySelector(SELECTORS.detailPanel) as HTMLElement | null
}

async function clickApplyButton(_jobCard: HTMLElement): Promise<boolean> {
  const btn = Array.from(document.querySelectorAll<HTMLElement>('button, a, div')).find((el) => {
    const t = (el.textContent || '').trim()
    return (t === '沟通' || t === '投递' || t === '立即沟通') && el.children.length <= 1
  })
  if (btn) {
    btn.click()
    return true
  }
  return false
}

async function fillGreetingMessage(
  message: string,
  _snapshot?: CommunicationUiSnapshot,
): Promise<boolean> {
  // 脉脉沟通式投递：找到输入框填写招呼语，然后返回（发送由用户在「建议+确认」护栏下操作）
  const input = document.querySelector<HTMLTextAreaElement | HTMLElement>(SELECTORS.chatInput)
  if (input) {
    if ('value' in input) {
      input.value = message
      input.dispatchEvent(new Event('input', { bubbles: true }))
    } else {
      input.textContent = message
      input.dispatchEvent(new Event('input', { bubbles: true }))
    }
    return true
  }
  return false
}

function getJobSpecificGreeting(resumeName: string, job: JobCard, _match: unknown): string {
  return `您好，我是${resumeName}，在脉脉看到贵司「${job.title}」岗位，背景与岗位要求匹配度高，方便聊聊吗？`
}

function snapshotCommunicationUi(): CommunicationUiSnapshot {
  return {
    inputs: new Set(document.querySelectorAll(SELECTORS.chatInput)),
    visibleDialogs: new Set(),
    hasInput: !!document.querySelector(SELECTORS.chatInput),
    inputSelector: SELECTORS.chatInput,
    sendButton: '',
    applyButtons: Array.from(document.querySelectorAll('button')).filter((el) =>
      /沟通|投递/.test(el.textContent || ''),
    ).length,
  }
}

// ===== 风控配置 =====
const riskConfig: PlatformRiskConfig = {
  id: 'maimai',
  name: '脉脉',
  dailyLimitMarkers: ['已达上限', '沟通次数已达上限', '今日沟通', '次数已用完'],
  rateLimitMarkers: ['操作太频繁', '操作频繁', '请稍后再试'],
  blockMarkers: ['账号异常', '账号已被限制', '需要验证'],
  captchaMarkers: ['验证码', '安全验证', '滑动验证'],
}

export const maimaiAdapter: PlatformAdapter = {
  id: 'maimai',
  name: '脉脉',
  icon: '🧭',
  homeUrl: 'https://maimai.cn/web/search_center?type=job',
  matchesUrl: (url) => /(?:^|[/.])maimai\.cn/i.test(url),
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
