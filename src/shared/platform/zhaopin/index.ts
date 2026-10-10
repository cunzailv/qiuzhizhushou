// 智联招聘平台适配器
// 基于 2026-10 实测：列表页 www.zhaopin.com/jobs 使用 .job-card 卡片；
// 点击卡片在右侧内联详情面板（.job-detail-panel / .job-detail-summary）展示，投递按钮 .job-detail-summary__apply。
// 选择器多候选回退，站点改版优先调整本文件顶部常量。
import { collectJobCards as collectJobCardsGeneric } from '../boss/action-simulator'
import type { PlatformAdapter, PlatformRiskConfig, PageType } from '../types'
import type { JobCard } from '../../types/job'
import type { CommunicationUiSnapshot } from '../types'

// ===== 选择器常量 =====
export const SELECTORS = {
  card: '.job-card',
  title: '.job-card__title-main, .job-card__title-row',
  salary: '.job-card__salary',
  skillTags: '.job-card__skill-tags .job-card__skill-tag, .job-card__skill-tags',
  company: '.job-card__company-row, .job-card__company',
  // 详情面板
  detailPanel: '.job-detail-panel, .job-detail-modules',
  detailTitle: '.job-detail-summary__title-text',
  detailSalary: '.job-detail-summary__salary',
  detailInfo: '.job-detail-summary__main, .job-detail-summary__info',
  detailCompany: '.job-detail-summary__company, [class*="company-name"]',
  detailDesc: '.job-detail-modules__detail [class*="description"], .job-detail-modules__detail [class*="desc"], [class*="job-description"], .job-detail-modules__detail',
  applyButton: '.job-detail-summary__apply, button[class*="apply"]',
}

function textOf(root: ParentNode | null, selector: string): string {
  if (!root) return ''
  const el = root.querySelector(selector)
  return el ? (el.textContent || '').trim() : ''
}

const salaryPattern = /(\d+(?:\.\d+)?\s*[-~]\s*\d+(?:\.\d+)?\s*(?:万|千|k|K)|\d+[-~]\d+\s*(?:元|万|千))/i

function extractId(url: string): string {
  // 智联岗位 ID 常见形如 J19189 / CC 开头编码
  const m = url.match(/[?&]jobId=([^&]+)|jobs\/([A-Za-z0-9]+)|jobid=([^&]+)/i)
  if (m) return (m[1] || m[2] || m[3] || '').toString()
  const cardMatch = url.match(/zhaopin\.com\/job\/(\d+)/)
  return cardMatch ? cardMatch[1] : url
}

// ===== 页面类型 =====
function detectPageType(): PageType {
  const url = window.location.href
  if (/sou\.zhaopin\.com|zhaopin\.com\/jobs/i.test(url)) return 'search'
  if (/zhaopin\.com\/(job|jobs)\/\d+/i.test(url) || /zhaopin\.com\/job/i.test(url)) return 'detail'
  return 'other'
}

// ===== 列表解析 =====
function parseJobCardsFromSearchPage(): JobCard[] {
  const cards: JobCard[] = []
  document.querySelectorAll<HTMLElement>(SELECTORS.card).forEach((cardEl) => {
    const title = textOf(cardEl, SELECTORS.title)
    if (!title) return

    const salary = textOf(cardEl, SELECTORS.salary)
    const company = textOf(cardEl, SELECTORS.company)

    const skillTags: string[] = []
    cardEl.querySelectorAll('.job-card__skill-tag').forEach((el) => {
      const t = (el.textContent || '').trim()
      if (t && t.length <= 24 && !skillTags.includes(t)) skillTags.push(t)
    })

    // 岗位链接：卡片内 a 或 data 属性
    const link = cardEl.querySelector<HTMLAnchorElement>('a[href]')
    const jobUrl = link?.href || cardEl.getAttribute('data-url') || ''
    const id = extractId(jobUrl) || cardEl.getAttribute('data-jobid') || String(Date.now())

    // 地点/经验/学历在卡片文本中
    const cardText = (cardEl.textContent || '').replace(/\s+/g, ' ')
    const locationMatch = cardText.match(/[\u4e00-\u9fff]+·[\u4e00-\u9fff]+/)
    const expMatch = cardText.match(/(经验不限|[\d]+年经验|[\d]+-[\d]+年经验|在校生\/应届生)/)
    const eduMatch = cardText.match(/(学历不限|大专|本科|硕士|博士)/)

    cards.push({
      id,
      title,
      companyName: company,
      companyLogo: '',
      salary,
      location: locationMatch ? locationMatch[0] : '',
      experience: expMatch ? expMatch[1] : '',
      education: eduMatch ? eduMatch[1] : '',
      tags: skillTags.slice(0, 8),
      jobDescription: '',
      bossName: '',
      bossTitle: '',
      bossOnline: false,
      publishedAt: '',
      url: jobUrl,
      platformId: 'zhaopin',
    })
  })
  return cards
}

// ===== 详情面板解析 =====
function parseJobDetailFromPage(): JobCard | null {
  const panel = document.querySelector(SELECTORS.detailPanel) as HTMLElement | null
  if (!panel) return null

  const title = textOf(panel, SELECTORS.detailTitle)
  if (!title) return null

  const infoText = textOf(panel, SELECTORS.detailInfo)
  const locationMatch = infoText.match(/[\u4e00-\u9fff]+·[\u4e00-\u9fff]+/)
  const expMatch = infoText.match(/(经验不限|[\d]+年经验|[\d]+-[\d]+年经验)/)
  const eduMatch = infoText.match(/(学历不限|大专|本科|硕士|博士)/)

  const salaryText = textOf(panel, SELECTORS.detailSalary)
  const salaryMatch = salaryText.match(salaryPattern)

  return {
    id: extractId(window.location.href),
    title,
    companyName: textOf(panel, SELECTORS.detailCompany) || textOf(document, '.job-detail-summary__main'),
    companyLogo: '',
    salary: salaryMatch ? salaryMatch[1] : '',
    location: locationMatch ? locationMatch[0] : '',
    experience: expMatch ? expMatch[1] : '',
    education: eduMatch ? eduMatch[1] : '',
    tags: [],
    jobDescription: extractJobDescriptionFromDetail(panel),
    bossName: '',
    bossTitle: '',
    bossOnline: false,
    publishedAt: '',
    url: window.location.href,
    platformId: 'zhaopin',
  }
}

function extractJobDescriptionFromDetail(root?: ParentNode): string {
  const target = root || document
  // 描述区：详情面板中文本量最大的容器（职责/要求）
  const candidates: HTMLElement[] = []
  target.querySelectorAll<HTMLElement>('[class*="description"], [class*="desc"], [class*="content"], [class*="detail"]').forEach((el) => {
    const text = (el.textContent || '').trim()
    if (text.length > 30 && text.length < 8000) candidates.push(el)
  })
  if (candidates.length === 0) return ''
  // 取文本最长的候选（最接近完整岗位描述）
  const best = candidates.sort((a, b) => (b.textContent || '').length - (a.textContent || '').length)[0]
  return (best.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 4000)
}

// ===== 动作 =====
async function activateJobCard(jobUrl: string, _jobId: string): Promise<HTMLElement | null> {
  if (jobUrl) {
    window.open(jobUrl, '_blank')
    return document.querySelector(SELECTORS.detailPanel) as HTMLElement | null
  }
  // 无链接时点击卡片（智联点击卡片展开右侧详情面板）
  const card = document.querySelector<HTMLElement>(SELECTORS.card)
  card?.click()
  // 等待面板出现
  await new Promise((resolve) => setTimeout(resolve, 300))
  return document.querySelector(SELECTORS.detailPanel) as HTMLElement | null
}

async function clickApplyButton(_jobCard: HTMLElement): Promise<boolean> {
  // 详情面板投递按钮
  const btn = document.querySelector<HTMLElement>(SELECTORS.applyButton)
  if (btn) {
    btn.click()
    return true
  }
  // 列表卡片兜底
  const cardBtn = _jobCard.querySelector<HTMLElement>('button')
  if (cardBtn && /投递/.test(cardBtn.textContent || '')) {
    cardBtn.click()
    return true
  }
  return false
}

async function fillGreetingMessage(
  _message: string,
  _snapshot?: CommunicationUiSnapshot,
): Promise<boolean> {
  // 智联为投递简历模式：无招呼语输入框；处理可能出现的确认弹窗
  const confirmBtn = Array.from(document.querySelectorAll<HTMLElement>('button, a')).find((el) =>
    /确认投递|确认|确定/.test((el.textContent || '').trim()),
  )
  if (confirmBtn) {
    confirmBtn.click()
    return true
  }
  return true
}

function getJobSpecificGreeting(_resumeName: string, job: JobCard, _match: unknown): string {
  return `您好，我在智联招聘看到贵司的「${job.title}」岗位，与我的经历高度匹配，希望能进一步沟通，谢谢！`
}

function snapshotCommunicationUi(): CommunicationUiSnapshot {
  return {
    inputs: new Set(document.querySelectorAll('textarea, input[type="text"]')),
    visibleDialogs: new Set(),
    hasInput: !!document.querySelector('textarea, input[type="text"]'),
    inputSelector: 'textarea, input[type="text"]',
    sendButton: '',
    applyButtons: Array.from(document.querySelectorAll('button')).filter((el) =>
      /投递/.test(el.textContent || ''),
    ).length,
  }
}

// ===== 风控配置 =====
const riskConfig: PlatformRiskConfig = {
  id: 'zhaopin',
  name: '智联招聘',
  dailyLimitMarkers: ['已达上限', '投递次数已达上限', '今日投递次数', '次数已用完'],
  rateLimitMarkers: ['操作太频繁', '操作频繁', '请稍后再试'],
  blockMarkers: ['账号异常', '账号已被限制', '验证码错误'],
  captchaMarkers: ['滑动验证', '验证码', '安全验证', '请完成验证'],
}

export const zhaopinAdapter: PlatformAdapter = {
  id: 'zhaopin',
  name: '智联招聘',
  icon: '🧩',
  homeUrl: 'https://sou.zhaopin.com/',
  matchesUrl: (url) => /(?:^|[/.])zhaopin\.com/i.test(url),
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
