// 前程无忧（51Job）平台适配器
//
// 2026-11 真实页面调试结论（用户 Chrome 现场）：
//  搜索页 https://we.51job.com/pc/search?keyword=... 的卡片里同时存在两类链接：
//    · 公司页  https://jobs.51job.com/all/coUzxRPVA2VmkAYQdlVjY.html      ← 不是岗位！
//    · 岗位页  https://jobs.51job.com/shenzhen/173992381.html?s=pchome...  ← 数字 ID 才是岗位
//  旧版用 `a[href*="jobs.51job.com"]` 取第一个，抓到的是**公司页**，
//  再在 activateJobCard 里 window.open 它，然后在原搜索页找详情容器 → 必然 null，
//  报「页面中未找到对应岗位卡片或详情无法展开」，还给用户开了一堆公司页标签。
//
// 现在：岗位识别一律以「数字 ID 详情链接」为准，公司页链接永不作为 jobUrl；
// 激活岗位只在**当前标签页**完成，绝不 window.open，绝不兜底点第一个卡片（防投错岗位）。
import { collectJobCards as collectJobCardsGeneric } from '../boss/action-simulator'
import { generateJobId } from '../boss/parser'
import type { PlatformAdapter, PlatformRiskConfig, PageType } from '../types'
import type { JobCard } from '../../types/job'
import type { CommunicationUiSnapshot } from '../types'

// ===== 选择器常量（集中维护，便于站点改版时调整） =====
export const SELECTORS = {
  listContainer: '.joblist, [class*="joblist"], [class*="job-list"]',
  card: '.joblist-item, [class*="joblist-item"], [class*="job-card"], [class*="job-item"]',
  title: '.joblist-item-jobname, .job-info.text-cut, [class*="jobname"], [class*="job-name"]',
  info: '.joblist-item-jobinfo, .joblist-item-jobinfo.text-cut, [class*="jobinfo"]',
  area: '.area',
  tags: '.joblist-item-tags .tags, .joblist-item-tags, [class*="job-tag"]',
  company: '.joblist-item-right .company_name, .joblist-item-right, [class*="company-name"], [class*="companyName"]',
  applyButton: 'button, [role="button"], [class*="btn"]',
  /** 公司页链接：只用来取公司名，绝不当岗位 URL */
  companyLink: 'a[href*="jobs.51job.com/all/co"], a[href*="/all/co"]',
  // 详情页（多候选回退）
  detailTitle: '.job-title, .tJobName, [class*="job-name"] h1, h1',
  detailSalary: '.job-money, .sal, [class*="salary"], .joblist-item-jobinfo',
  detailCompany: '.company-name, .cname, [class*="company-name"]',
  detailDesc: '.job_msg, .bmsg, #jobdesc, [class*="job-description"], [class*="jobDescription"], [class*="job-desc"]',
  detailApply: 'button[class*="apply"]',
  /** 投递确认弹窗（供 UI 快照与确认层判定） */
  dialog: '[role="dialog"], [class*="dialog"], [class*="modal"], [class*="popup"]',
}

/** 岗位详情链接：jobs.51job.com/{city}/{数字ID}.html（city 可带连字符，如 shenzhen-ftq） */
const JOB_DETAIL_RE = /jobs\.51job\.com\/[^/]+\/(\d+)\.html/i
/** 公司页链接：jobs.51job.com/all/coXXXX.html */
const COMPANY_PAGE_RE = /jobs\.51job\.com\/[^/]*\/co[A-Za-z0-9]+\.html/i
/** 新版 we.51job 站内岗位链接（query 里带 jobid） */
const JOB_QUERY_RE = /[?&](?:jobid|jobId|job_id)=(\d+)/i

/** 只认岗位详情 URL；公司页 / 城市聚合页一律返回 false */
export function isJobDetailUrl(url: string): boolean {
  if (!url) return false
  return JOB_DETAIL_RE.test(url) || (JOB_QUERY_RE.test(url) && /51job\.com/i.test(url))
}

/** 公司页链接识别，采集时用于排除 */
export function isCompanyPageUrl(url: string): boolean {
  if (!url) return false
  return COMPANY_PAGE_RE.test(url) || /jobs\.51job\.com\/all\//i.test(url)
}

function extractIdFromUrl(url: string): string {
  const m = url.match(JOB_DETAIL_RE)
  if (m) return m[1]
  const q = url.match(JOB_QUERY_RE)
  if (q) return q[1]
  // 旧版这里返回整个 URL，导致公司页链接被当成 jobId，定位必然失败
  return ''
}

const salaryPattern = /(\d+(?:\.\d+)?\s*[-~]\s*\d+(?:\.\d+)?\s*(?:万|千|k|K)|[0-9]+-?[0-9]*\s*(?:万|千|K|k)\/?[0-9]*\s*(?:薪|万)?)/
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function textOf(root: ParentNode | null, selector: string): string {
  if (!root) return ''
  const el = root.querySelector(selector)
  return el ? (el.textContent || '').trim() : ''
}

function isVisible(el: Element): boolean {
  const html = el as HTMLElement
  if (html.hidden || html.getAttribute('aria-hidden') === 'true') return false
  const inline = (html.getAttribute('style') || '').replace(/\s/g, '')
  if (/display:none|visibility:hidden/.test(inline)) return false
  const style = typeof window !== 'undefined' ? window.getComputedStyle(html) : null
  if (style && (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0')) {
    return false
  }
  // 不用 offsetParent / getClientRects：jsdom 无布局，会误判所有弹窗为不可见，
  // 导致投递成功弹窗进不了 UI 快照，确认层永远拿不到这条平台侧证据。
  return true
}

/** 从「岗位链接文本」里切出职位名：薪资之前的片段即为标题 */
function titleFromLinkText(text: string): string {
  const clean = (text || '').replace(/\s+/g, ' ').trim()
  const hit = clean.match(salaryPattern)
  let title = hit?.index && hit.index > 0 ? clean.slice(0, hit.index).trim() : clean
  if (title.length > 30) title = title.slice(0, 30)
  return title
}

/** 归一化 href：去掉 query / hash，只用于「是不是同一个岗位」的精确比较 */
function normalizeJobUrl(url: string): string {
  try {
    const u = new URL(url)
    return `${u.host}${u.pathname}`
  } catch {
    return url.split(/[?#]/)[0]
  }
}

// ===== 页面类型 =====
function detectPageType(): PageType {
  const url = window.location.href
  if (isJobDetailUrl(url)) return 'detail'
  if (/we\.51job\.com\/pc\/search|search\.51job\.com|51job\.com\/jobs/i.test(url)) return 'search'
  if (isCompanyPageUrl(url)) return 'other'
  return 'other'
}

/**
 * 列表卡片根容器：宽泛的 `[class*="joblist-item"]` 也会命中
 * `.joblist-item-jobname` / `.joblist-item-jobinfo` 等子元素，只保留最外层，
 * 否则一个岗位会被拆成好几张卡重复入队、激活时也可能点错层。
 */
function listCardRoots(): HTMLElement[] {
  if (typeof document === 'undefined') return []
  const container = document.querySelector(SELECTORS.listContainer)
  const candidates = Array.from((container || document).querySelectorAll<HTMLElement>(SELECTORS.card))
  return candidates.filter(
    (el) => !candidates.some((other) => other !== el && other.contains(el)),
  )
}

/**
 * 岗位卡片根容器：从命中的岗位链接向上找，优先选「含投递按钮 / 公司链接」的那一层，
 * 这样 clickApplyButton 能在同一个卡片内点到正确的投递按钮，不会误点别的岗位。
 */
function findCardRoot(anchor: HTMLElement): HTMLElement {
  let cur: HTMLElement | null = anchor
  for (let depth = 0; depth < 6 && cur; depth++, cur = cur.parentElement) {
    const buttons = Array.from(cur.querySelectorAll<HTMLElement>('button, [role="button"]'))
    if (buttons.some((b) => /^(立即)?投递(简历)?$|^(立即)?申请(职位)?$/.test((b.textContent || '').trim()))) {
      return cur
    }
  }
  return anchor.closest<HTMLElement>(SELECTORS.card) || anchor.parentElement || anchor
}

/** 公司名：优先取公司页链接文本的第一段（去掉行业/规模后缀），再退到 class 选择器 */
function companyFromCard(card: ParentNode | null): string {
  const companyLink = card?.querySelector<HTMLAnchorElement>(SELECTORS.companyLink)
  if (companyLink) {
    const raw = (companyLink.textContent || '').replace(/\s+/g, ' ').trim()
    // 公司页链接文本常把「公司名 + 行业 + 规模」连在一起，
    // 只取到公司主体后缀，避免把「外资（欧美）少于50人」当成公司名。
    const m = raw.match(/^(.*?(?:有限公司|股份公司|集团公司|公司|研究院|事务所|中心)(?:[^\s]*?(?:分公司|子公司))?)/)
    if (m) return m[1].trim()
    const first = raw.split(/\s{2,}/)[0].trim()
    if (first) return first
  }
  return textOf(card, SELECTORS.company)
}

function buildCardFromAnchor(anchor: HTMLAnchorElement): JobCard | null {
  const jobUrl = anchor.href
  if (!isJobDetailUrl(jobUrl)) return null
  const linkText = (anchor.textContent || '').trim()
  const titleEl = anchor.querySelector(SELECTORS.title)
  const title = titleEl ? (titleEl.textContent || '').trim() : titleFromLinkText(linkText)
  if (!title) return null

  const card = findCardRoot(anchor)
  const companyName = companyFromCard(card)
  const id = extractIdFromUrl(jobUrl) || generateJobId(jobUrl, `${companyName}:${title}`)
  const infoText = textOf(card, SELECTORS.info) || linkText
  const salaryMatch = infoText.match(salaryPattern)
  const tags: string[] = []
  card.querySelectorAll(`${SELECTORS.tags} span, ${SELECTORS.tags} .tag`).forEach((el) => {
    const t = (el.textContent || '').trim()
    if (t && t.length <= 20 && !tags.includes(t)) tags.push(t)
  })

  return {
    id,
    title,
    companyName,
    companyLogo: '',
    salary: salaryMatch ? salaryMatch[1] : '',
    location: textOf(card, SELECTORS.area) || extractLocation(infoText),
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
  }
}

// ===== 列表解析 =====
/**
 * 双路径采集：
 *  1) 锚点路径：以「数字 ID 岗位详情链接」为准，完全不依赖 class 名，天然排除公司页；
 *  2) 经典 .joblist-item 路径：兼容旧版页面与模拟页面 E2E。
 * 两条路径按岗位 ID 去重，锚点路径优先。
 */
function parseJobCardsFromSearchPage(): JobCard[] {
  const byId = new Map<string, JobCard>()

  if (typeof document !== 'undefined') {
    for (const anchor of Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]'))) {
      if (!isJobDetailUrl(anchor.href)) continue
      const card = buildCardFromAnchor(anchor)
      if (card && !byId.has(card.id)) byId.set(card.id, card)
    }
  }

  const cardEls = listCardRoots()
  if (cardEls.length > 0) {
    cardEls.forEach((cardEl) => {
      const titleEl = cardEl.querySelector(SELECTORS.title)
      const title = titleEl ? (titleEl.textContent || '').trim() : ''
      if (!title) return
      const detailAnchor = Array.from(cardEl.querySelectorAll<HTMLAnchorElement>('a[href]'))
        .find((a) => isJobDetailUrl(a.href))
      // 公司页链接绝不能当 jobUrl：宁可留空，让执行层按标题/公司定位，
      // 也不要 window.open 到公司页后找不到详情容器。
      const jobUrl = detailAnchor?.href || cardEl.getAttribute('data-url') || ''
      const companyName = companyFromCard(cardEl)
      const id = (detailAnchor && extractIdFromUrl(detailAnchor.href))
        || cardEl.getAttribute('data-jobid')
        || generateJobId(jobUrl, `${companyName}:${title}`)
      if (byId.has(id)) return

      const infoText = textOf(cardEl, SELECTORS.info)
      const salaryMatch = (infoText || cardEl.textContent || '').match(salaryPattern)
      const tags: string[] = []
      cardEl.querySelectorAll(`${SELECTORS.tags} span, ${SELECTORS.tags} .tag, ${SELECTORS.tags}`).forEach((el) => {
        const t = (el.textContent || '').trim()
        if (t && t.length <= 20 && !tags.includes(t) && !/五险一金|绩效奖金|员工旅游|带薪年假|节日福利|定期体检/.test(t)) {
          tags.push(t)
        }
      })
      byId.set(id, {
        id,
        title,
        companyName,
        companyLogo: '',
        salary: salaryMatch ? salaryMatch[1] : '',
        location: textOf(cardEl, SELECTORS.area) || extractLocation(infoText),
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
  }

  return Array.from(byId.values())
}

function extractLocation(infoText: string): string {
  const m = infoText.match(/([\u4e00-\u9fff]+·[\u4e00-\u9fff]+)/)
  return m ? m[1] : ''
}

// ===== 详情解析（多候选回退） =====
function parseJobDetailFromPage(): JobCard | null {
  const url = window.location.href
  const id = extractIdFromUrl(url) || url
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
  const scopes: Array<ParentNode | null> = [root ?? null, document]
  for (const scope of scopes) {
    if (!scope) continue
    for (const selector of [SELECTORS.detailDesc, '.j_joblist', '.tCompanyPage', '#jobDetail', '.job-detail', 'main']) {
      const el = scope.querySelector(selector)
      if (el && (el.textContent || '').trim().length > 30) {
        return (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 4000)
      }
    }
  }
  return ''
}

// ===== 动作 =====
function findDetailContainer(): HTMLElement | null {
  for (const selector of [SELECTORS.detailDesc, '.job_msg', '.bmsg', '#jobdesc', '[class*="job-detail"], main, article']) {
    const el = document.querySelector<HTMLElement>(selector)
    if (el && (el.textContent || '').trim().length > 30) return el
  }
  return null
}

/**
 * 在当前页面里找目标岗位：
 *  精确 ID → 精确 URL → 标题 → 公司名。找不到就返回 null，
 *  绝不像旧版那样退回到「第一个 .joblist-item」——那会投错岗位。
 */
function findTargetCard(
  jobUrl: string,
  jobId: string,
  expectedTitle: string,
  expectedCompany: string,
): HTMLElement | null {
  // 1) 真实搜索页：以「数字 ID 岗位详情链接」做精确匹配（公司页链接不参与）
  const anchors = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]'))
    .filter((a) => isJobDetailUrl(a.href))
  let hit = anchors.find((a) => !!jobId && a.href.includes(`/${jobId}.html`))
  if (!hit && jobUrl) {
    const target = normalizeJobUrl(jobUrl)
    hit = anchors.find((a) => normalizeJobUrl(a.href) === target)
  }
  if (!hit && expectedTitle) {
    hit = anchors.find((a) => (a.textContent || '').includes(expectedTitle))
  }
  if (!hit && expectedCompany) {
    hit = anchors.find((a) => (a.textContent || '').includes(expectedCompany))
  }
  if (hit) return findCardRoot(hit)

  // 2) 老结构 / we.51job.com 内联展开：卡片本身就是根，页面上没有任何岗位详情链接。
  //    这里曾有一句 `if (anchors.length === 0) return null`，会让整条 legacy 路径变成死代码，
  //    模拟页 E2E 稳定失败（「无法打开详情」）。只能按 data-jobid / 标题 / 公司精确命中，
  //    绝不退回第一张卡片 —— 那会投错岗位。
  const cards = listCardRoots()
  const byId = jobId
    ? cards.find((el) => el.getAttribute('data-jobid') === jobId)
    : undefined
  if (byId) return byId
  if (expectedTitle) {
    const byTitle = cards.find((el) => (el.textContent || '').includes(expectedTitle))
    if (byTitle) return byTitle
  }
  if (expectedCompany) {
    const byCompany = cards.find((el) => (el.textContent || '').includes(expectedCompany))
    if (byCompany) return byCompany
  }
  return null
}

function findApplyButton(scope: ParentNode | null): HTMLElement | null {
  if (!scope) return null
  const candidates = Array.from(scope.querySelectorAll<HTMLElement>('button, a, [role="button"], [class*="btn"]'))
  return candidates.find((el) => {
    const text = (el.textContent || '').trim()
    return /^(立即)?投递(简历)?$|^(立即)?申请(职位)?$|投个简历|马上投递|投简历/.test(text)
  }) || null
}

/**
 * 激活岗位详情：全程在**当前标签页**完成，绝不 window.open。
 * 旧版对任何 jobs.51job.com 链接都 window.open（实际是公司页），
 * 然后回原搜索页找详情容器 → 必然失败，还刷出一堆垃圾标签页。
 */
async function activateJobCard(
  jobUrl: string,
  jobId: string,
  expectedTitle = '',
  expectedCompany = '',
): Promise<HTMLElement | null> {
  // 1. 当前页面已经是这个岗位的详情页
  const currentUrl = window.location.href
  if (isJobDetailUrl(currentUrl) && (!jobId || currentUrl.includes(`/${jobId}.html`))) {
    return findDetailContainer() || document.body
  }

  // 2. 列表页：定位目标卡片（精确 ID / URL / 标题 / 公司）
  const card = findTargetCard(jobUrl, jobId, expectedTitle, expectedCompany)
  if (!card) return null
  card.scrollIntoView?.({ block: 'center' })

  // 3. 真实搜索页（页面上存在岗位详情链接）且卡片自带「投递」按钮：
  //    直接返回卡片，交给 clickApplyButton 精确点它，不需要跳详情页。
  //    判断放在这里而不是无条件短路，是因为老结构页面没有详情链接，
  //    需要先点卡片行展开内联 JD —— batch 模式的评分依赖完整 JD，
  //    跳过这步会让岗位因「描述为空」被判不匹配，整条投递链路走不到。
  const hasDetailAnchors = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]'))
    .some((a) => isJobDetailUrl(a.href))
  if (hasDetailAnchors && findApplyButton(card)) return card

  // 4. 有岗位详情链接但卡片没有投递按钮：同标签页点进详情（去掉 target=_blank）
  const link = Array.from(card.querySelectorAll<HTMLAnchorElement>('a[href]'))
    .find((a) => isJobDetailUrl(a.href))
  if (link) {
    link.removeAttribute('target')
    link.click()
    for (let i = 0; i < 12; i++) {
      await wait(250)
      const detail = findDetailContainer()
      if (detail) return detail
      if (findApplyButton(document.body)) return document.body
    }
    return findDetailContainer() || document.body
  }

  // 5. 老结构 / 内联展开：点卡片行让 JD 面板出现，再返回含投递按钮的卡片。
  //    extractJobDescriptionFromDetail 会回退到 document 找展开的 .job_msg，
  //    所以返回卡片既不丢 JD，也不会让 clickApplyButton 去 body 上误点别的岗位。
  if (!findDetailContainer()) {
    card.click()
    await wait(300)
  }
  return findApplyButton(card) ? card : findDetailContainer()
}

async function clickApplyButton(jobCard: HTMLElement): Promise<boolean> {
  const btn = findApplyButton(jobCard) || findApplyButton(document.body)
  if (!btn) return false
  btn.click()
  return true
}

/**
 * 51job 是「投递简历」模式，没有 Boss 那种招呼语输入框。
 * 只在出现明确的「确认投递」弹窗时点确定；绝不无脑点任何含「投递」的按钮，
 * 否则会重复投递或误点「+ 关注」。返回 false 表示没有招呼语可发（不属于失败）。
 */
async function fillGreetingMessage(
  _message: string,
  _snapshot?: CommunicationUiSnapshot,
): Promise<boolean> {
  const dialogs = Array.from(document.querySelectorAll<HTMLElement>(SELECTORS.dialog)).filter(isVisible)
  for (const dialog of dialogs) {
    const confirm = Array.from(dialog.querySelectorAll<HTMLElement>('button, a, [role="button"]'))
      .find((el) => /^(确定|确认|确认投递|立即投递|继续投递)$/.test((el.textContent || '').trim()))
    if (confirm) {
      confirm.click()
      return true
    }
  }
  return false
}

function getJobSpecificGreeting(_resumeName: string, job: JobCard, _match: unknown): string {
  return `您好，我在前程无忧看到贵司的「${job.title}」岗位，我的经历与岗位要求比较匹配，方便进一步沟通吗？`
}

function snapshotCommunicationUi(): CommunicationUiSnapshot {
  // 投递成功 / 简历确认弹窗是 51job 最重要的平台侧确认信号，必须进 UI 快照，
  // 否则 communicationUiChanged 恒为 false，确认层会漏判。
  const visibleDialogs = new Set<Element>(
    Array.from(document.querySelectorAll<HTMLElement>(SELECTORS.dialog)).filter(isVisible),
  )
  return {
    inputs: new Set(document.querySelectorAll('textarea, input[type="text"]')),
    visibleDialogs,
    hasInput: !!document.querySelector('textarea, input[type="text"]'),
    inputSelector: 'textarea, input[type="text"]',
    sendButton: '',
    applyButtons: findApplyButton(document.body) ? 1 : 0,
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
