// 猎聘（求职者端）平台适配器。
//
// 重要说明：猎聘的「聊一聊」按钮默认隐藏，需要鼠标 hover 到卡片容器上
// 才会出现在头像下方。因此 activateJobCard / clickApplyButton 都必须
// 先触发 hover 事件再查找按钮。
//
// 以下选择器基于猎聘求职者端（www.liepin.com）的页面结构编写，
// 真实 DOM 会随官方改版而变化。标注 [待校准] 的地方需在真实页面上验证。
import type { JobCard, MatchResult } from '../../types/job'
import type { PlatformAdapter, PlatformRiskConfig, CollectOptions, PageType, CommunicationUiSnapshot } from '../types'
import { log } from '../../utils/logger'

// 猎聘 PC 端 class 使用 CSS Modules（带随机后缀如 --ZWExZ），
// 因此所有选择器用 [class*="..."] 做子串匹配。
const JOB_CARD_SELECTOR = '[class*="job-list-item"]'
const TITLE_SELECTOR = '[class*="job-title-box"] [class*="ellipsis-1"]'
const COMPANY_SELECTOR = '[class*="company-name"]'
const SALARY_SELECTOR = '[class*="job-salary"]'
const CITY_SELECTOR = '[class*="job-dq-box"] [class*="ellipsis-1"]'
const DETAIL_LINK_SELECTOR = 'a[data-nick="job-detail-job-info"]'
const LABELS_SELECTOR = '[class*="labels-tag"]'
const RECRUITER_NAME_SELECTOR = '[class*="recruiter-name"]'
const RECRUITER_TITLE_SELECTOR = '[class*="recruiter-title"]'
const DESC_SELECTOR = '[class*="job-description"], [class*="job-detail"]'
// 猎聘求职端与 HR 沟通的主按钮为「聊一聊」（hover 卡片后出现在头像下方）。
const APPLY_TEXTS = ['聊一聊', '立即沟通', '沟通', '投递简历', '投递', '立即投递', '申请']

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

/**
 * 在元素上触发 hover 事件序列，使猎聘卡片中隐藏的「聊一聊」按钮出现。
 * 猎聘通过 JS 事件（而非 CSS :hover）控制按钮显隐，因此需要触发真实的
 * mouseenter / mouseover 事件。
 */
function triggerHover(el: HTMLElement): void {
  const events: Array<{ type: string; bubbles: boolean }> = [
    { type: 'mouseenter', bubbles: false },
    { type: 'mouseover', bubbles: true },
    { type: 'mousemove', bubbles: true },
  ]
  for (const { type, bubbles } of events) {
    el.dispatchEvent(new MouseEvent(type, { bubbles, cancelable: true, view: window }))
  }
}

function extractId(url: string): string {
  // 猎聘 URL 格式：/a/77558891.shtml 或 /job/xxxxx
  return url.match(/\/a\/(\d+)\.shtml/)?.[1]
    || url.match(/job\/([\w-]+)/)?.[1]
    || url
}

function detectPageType(): PageType {
  const url = location.href
  // 猎聘求职端 URL 模式
  if (url.includes('/job/') || url.includes('jobdetail')) return 'detail'
  // 聊天/消息页：URL 路径中包含 /chat/、/msg/、/im/ 或页面参数含 chat 路由
  if (/\/chat\b|\/msg\b|\/im\b|chatRoom|chatPage/i.test(url)) return 'chat'
  // 猎聘列表/推荐页：zhaopin、so、search、recommend
  if (url.includes('zhaopin') || url.includes('/so/') || url.includes('search') || url.includes('recommend')) return 'search'
  // c.liepin.com / www.liepin.com 首页（可能带 ?time= 参数）视为推荐流
  if (/liepin\.com\/?(\?.*)?$/.test(url)) return 'recommend'
  // 其他 liepin 页面，页面上有卡片就视为搜索页
  if (qa(JOB_CARD_SELECTOR).length > 0) return 'search'
  // 兜底：猎聘域名上的页面默认视为推荐页
  return 'recommend'
}

function parseJobCardsFromSearchPage(): JobCard[] {
  const cards = qa(JOB_CARD_SELECTOR)
  const result: JobCard[] = []
  for (const card of cards) {
    const titleEl = q(TITLE_SELECTOR, card)
    const title = (titleEl?.textContent || '').trim()
    if (!title) continue

    const linkEl = q<HTMLAnchorElement>(DETAIL_LINK_SELECTOR, card)
    const url = linkEl?.href || ''

    // 城市：从 [class*="job-dq-box"] 中提取，格式如 "深圳-南山区"
    const cityRaw = (q(CITY_SELECTOR, card)?.textContent || '').trim()
    const city = cityRaw.split('-')[0] || cityRaw

    // 经验 & 学历：从 labels-tag 中提取
    const labels = qa(LABELS_SELECTOR, card)
    let experience = ''
    let education = ''
    for (const label of labels) {
      const t = (label.textContent || '').trim()
      if (t.includes('经验') || t.includes('年')) {
        experience = t
      } else if (t.includes('大专') || t.includes('本科') || t.includes('硕士') || t.includes('博士') || t.includes('学历')) {
        education = t
      }
    }

    // 公司 logo
    const logoImg = q<HTMLImageElement>('img', card)
    const companyLogo = logoImg?.src || ''

    // 招聘者信息
    const bossName = (q(RECRUITER_NAME_SELECTOR, card)?.textContent || '').trim()
    const bossTitle = (q(RECRUITER_TITLE_SELECTOR, card)?.textContent || '').trim()
    const bossOnline = bossTitle.includes('在线') || bossTitle.includes('刚刚')

    // 公司标签
    const tagEls = qa('[class*="company-tags-box"] span', card)
    const tags = tagEls.map((el) => (el.textContent || '').trim()).filter(Boolean)

    result.push({
      id: extractId(url),
      title,
      companyName: (q(COMPANY_SELECTOR, card)?.textContent || '').trim(),
      companyLogo,
      salary: (q(SALARY_SELECTOR, card)?.textContent || '').trim(),
      location: city,
      experience,
      education,
      tags,
      jobDescription: '',
      bossName,
      bossTitle,
      bossOnline,
      publishedAt: '',
      url: url || location.href,
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
  expectedCompany?: string,
): Promise<HTMLElement | null> {
  // 先按 data 属性匹配，再按标题+公司名模糊匹配
  let card: Element | null =
    q(`[data-job-id="${jobId}"]`) ||
    q(`[data-id="${jobId}"]`)

  if (!card) {
    card =
      qa(JOB_CARD_SELECTOR).find((el) => {
        const title = (q(TITLE_SELECTOR, el)?.textContent || '').trim()
        const company = (q(COMPANY_SELECTOR, el)?.textContent || '').trim()
        if (expectedTitle && expectedCompany) {
          return title === expectedTitle && company === expectedCompany
        }
        if (expectedTitle) return title === expectedTitle
        return false
      }) ?? null
  }

  if (!card) {
    log('[liepin]', 'activateJobCard', `Card not found: ${expectedTitle} @ ${expectedCompany}`)
    return null
  }

  // 关键：hover 卡片以触发「聊一聊」按钮出现
  triggerHover(card as HTMLElement)

  // 等待按钮渲染（猎聘有 hover → React 状态更新 → 按钮出现的延迟）
  const start = Date.now()
  while (Date.now() - start < 3000) {
    const btn = findButtonByText(card, APPLY_TEXTS) || findButtonByText(document, APPLY_TEXTS)
    if (btn) {
      log('[liepin]', 'activateJobCard', 'Button appeared after hover')
      return card as HTMLElement
    }
    await new Promise((r) => setTimeout(r, 200))
  }

  log('[liepin]', 'activateJobCard', 'Button did not appear after hover, returning card anyway')
  return card as HTMLElement
}

async function clickApplyButton(jobCard: HTMLElement): Promise<boolean> {
  // 再次触发 hover 确保按钮可见（可能因 DOM 更新丢失 hover 状态）
  triggerHover(jobCard)

  // 等待按钮出现
  let btn: HTMLElement | null = null
  const start = Date.now()
  while (Date.now() - start < 3000) {
    btn = findButtonByText(document, APPLY_TEXTS)
    if (btn) break
    await new Promise((r) => setTimeout(r, 200))
  }

  if (!btn) {
    log('[liepin]', 'clickApplyButton', 'Apply button not found')
    return false
  }

  btn.click()
  await new Promise((r) => setTimeout(r, 800))

  // 检查是否弹出了沟通对话框
  const dialog = q('.chat-dialog, .greeting-dialog, .im-dialog, [class*="chat"], [class*="dialog"]')
  if (dialog) {
    log('[liepin]', 'clickApplyButton', 'Chat dialog opened')
  }

  return true
}

async function fillGreetingMessage(
  message: string,
  _snapshot?: CommunicationUiSnapshot, // eslint-disable-line @typescript-eslint/no-unused-vars
): Promise<boolean> {
  // 猎聘点击「聊一聊」后会弹出沟通对话框，输入框在对话框内。
  // 选择器覆盖常见 class 名称。
  const textareaSelectors = [
    'textarea.greeting-input',
    'textarea.chat-input',
    'textarea.message-input',
    '.chat-dialog textarea',
    '.im-dialog textarea',
    '[class*="chat"] textarea',
    '[class*="dialog"] textarea',
    'textarea',
  ]

  let input: HTMLTextAreaElement | HTMLInputElement | null = null
  const start = Date.now()
  while (Date.now() - start < 5000) {
    for (const sel of textareaSelectors) {
      const el = q<HTMLTextAreaElement>(sel) as HTMLTextAreaElement | null
      if (el && el.offsetParent !== null) {
        input = el
        break
      }
    }
    if (input) break
    await new Promise((r) => setTimeout(r, 300))
  }

  if (!input) {
    log('[liepin]', 'fillGreetingMessage', 'Greeting textarea not found in dialog')
    return false
  }

  // 使用 React value setter 确保框架感知到值变化
  const proto = Object.getPrototypeOf(input)
  const valueSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set ??
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set ??
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
  if (valueSetter) {
    valueSetter.call(input, message)
  } else {
    ;(input as unknown as { value: string }).value = message
  }

  input.dispatchEvent(new Event('input', { bubbles: true }))
  input.dispatchEvent(new Event('change', { bubbles: true }))

  // 查找并点击发送按钮
  await new Promise((r) => setTimeout(r, 500))
  const sendBtn = findButtonByText(document, ['发送', 'Send'])
  if (sendBtn) {
    sendBtn.click()
    log('[liepin]', 'fillGreetingMessage', 'Send button clicked')
  }

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
  // 收集页面上已存在的沟通输入框（可能之前已经打开了对话框）
  const inputs = new Set<Element>()
  const inputSelectors = ['textarea', 'input[type="text"]', '.chat-input', '.message-input']
  for (const sel of inputSelectors) {
    qa(sel).forEach((el) => {
      if ((el as HTMLElement).offsetParent !== null) inputs.add(el)
    })
  }
  // 收集可见的对话框
  const visibleDialogs = new Set<Element>()
  qa('[class*="chat"], [class*="dialog"], [class*="im"]').forEach((el) => {
    if ((el as HTMLElement).offsetParent !== null) visibleDialogs.add(el)
  })
  return { inputs, visibleDialogs }
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
  // 匹配所有猎聘求职端域名（www / m / c / 裸域 / 其他子域）。
  matchesUrl: (url) => /liepin\.com/i.test(url),
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
