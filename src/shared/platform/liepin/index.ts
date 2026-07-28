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

// 猎聘专属：投简历模式开关（由 content script 在收到浮窗消息后调用）
let resumeMode = false
export function setLiepinResumeMode(enabled: boolean): void {
  resumeMode = enabled
  log('[liepin]', 'setLiepinResumeMode', enabled ? '投简历模式' : '仅沟通模式')
}

// 猎聘 PC 端 class 使用 CSS Modules（带随机后缀如 --ZWExZ），
// 因此所有选择器用 [class*="..."] 做子串匹配。
// zhaopin 搜索页和旧版列表页使用不同的 CSS 类名，需要兼容两种。
// data-nick 属性在两个版本中保持稳定，用作解析锚点。

// 卡片容器：兼容旧版 job-list-item 和新版 zhaopin 页 job-card-pc-container
const JOB_CARD_SELECTOR = '[class*="job-list-item"], [class*="job-card-pc-container"]'

// 职位详情链接 — data-nick 属性在所有猎聘搜索页稳定
const DETAIL_LINK_SELECTOR = 'a[data-nick="job-detail-job-info"]'

// 职位描述（详情页）
const DESC_SELECTOR = '[class*="job-description"], [class*="job-detail"]'

// 招聘者信息容器 — recruiter-info-box 类名在新旧页面均存在
const RECRUITER_BOX_SELECTOR = '[class*="recruiter-info-box"]'

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
 * 猎聘使用 React 合成事件，需要 PointerEvent + MouseEvent 双管齐下，
 * 并包含正确的坐标信息（clientX/Y 基于元素 bounding rect）。
 */
function triggerHover(el: HTMLElement): void {
  const rect = el.getBoundingClientRect()
  const x = rect.left + rect.width / 2
  const y = rect.top + rect.height / 2

  const eventInit: MouseEventInit = {
    bubbles: true,
    cancelable: true,
    view: window,
    clientX: x,
    clientY: y,
    screenX: x,
    screenY: y,
    relatedTarget: document.body,
  }

  // 先触发 pointer 事件（React 17+ 优先监听指针事件）
  el.dispatchEvent(new PointerEvent('pointerover', eventInit))
  el.dispatchEvent(new PointerEvent('pointerenter', { ...eventInit, bubbles: false }))
  el.dispatchEvent(new PointerEvent('pointermove', eventInit))

  // 再触发 mouse 事件（兼容传统监听）
  el.dispatchEvent(new MouseEvent('mouseover', eventInit))
  el.dispatchEvent(new MouseEvent('mouseenter', { ...eventInit, bubbles: false }))
  el.dispatchEvent(new MouseEvent('mousemove', eventInit))
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
    const linkEl = q<HTMLAnchorElement>(DETAIL_LINK_SELECTOR, card)
    const url = linkEl?.href || ''

    // --- Title: first .ellipsis-1 with a title attr inside the detail link ---
    // 新版 zhaopin 页：a[data-nick] > div > div > div.ellipsis-1[title]
    // 旧版列表页：[class*="job-title-box"] [class*="ellipsis-1"]
    let title = ''
    const oldTitleEl = q('[class*="job-title-box"] [class*="ellipsis-1"]', card)
    if (oldTitleEl) {
      title = (oldTitleEl.textContent || '').trim()
    } else if (linkEl) {
      const ellipsisEls = qa('.ellipsis-1', linkEl)
      const titled = ellipsisEls.find(el => el.hasAttribute('title'))
      title = (titled?.getAttribute('title') || titled?.textContent || ellipsisEls[0]?.textContent || '').trim()
    }
    if (!title) continue

    // --- Salary: span with digit+k pattern ---
    // 新版 zhaopin 页：a[data-nick] 内的 span，文本含数字+k
    // 旧版列表页：[class*="job-salary"]
    let salary = (q('[class*="job-salary"]', card)?.textContent || '').trim()
    if (!salary && linkEl) {
      const spans = qa('span', linkEl)
      for (const s of spans) {
        const t = (s.textContent || '').trim()
        if (/\d/.test(t) && /[kK年月]/.test(t)) { salary = t; break }
      }
    }

    // --- City ---
    // 旧版：[class*="job-dq-box"] [class*="ellipsis-1"]
    // 新版：a[data-nick] 内的第二个 .ellipsis-1（在【 】之间）
    let city = (q('[class*="job-dq-box"] [class*="ellipsis-1"]', card)?.textContent || '').trim()
    if (!city && linkEl) {
      const ellipsisEls = qa('.ellipsis-1', linkEl)
      // 新版 zhaopin：第一个 ellipsis-1 是 title，第二个是城市
      if (ellipsisEls.length >= 2) {
        city = (ellipsisEls[1].textContent || '').trim()
      }
    }
    // 从旧版 city 格式 "深圳-南山区" 提取城市名
    if (city) city = city.split('-')[0]

    // --- Experience & Education ---
    // 旧版：[class*="labels-tag"]
    // 新版：a[data-nick] 内或相邻 div 内的 span，文本含"年"或学历关键词
    let experience = ''
    let education = ''
    const labelEls = qa('[class*="labels-tag"]', card)
    for (const el of labelEls) {
      const t = (el.textContent || '').trim()
      if (t.includes('经验') || t.includes('年')) experience = t
      else if (t.includes('大专') || t.includes('本科') || t.includes('硕士') || t.includes('博士') || t.includes('学历') || t.includes('统招')) education = t
    }
    // 新版 zhaopin：在卡片内搜索所有 span，按内容模式匹配
    if (!experience || !education) {
      // 新版页面的 span 在 detail link 相邻的 div（如 ._40108KeJJy）中
      const allSpans = qa('span', card)
      for (const s of allSpans) {
        const t = (s.textContent || '').trim()
        // 跳过纯数字、薪资、城市
        if (!t || /\d+-\d+k/i.test(t) || t.startsWith('【') || t.length > 12) continue
        if (!experience && (/^\d+[-\s]*\d*年|经验不限|应届/.test(t) || /经验/.test(t))) {
          experience = t
        } else if (!education && /大专|本科|硕士|博士|中专|高中|学历|统招|MBA/.test(t)) {
          education = t
        }
      }
    }

    // --- Company name ---
    // 旧版：[class*="company-name"]
    // 新版：[data-nick="job-detail-company-info"] 内的第一个 span.ellipsis-1
    let companyName = (q('[class*="company-name"]', card)?.textContent || '').trim()
    if (!companyName) {
      const companySection = q('[data-nick="job-detail-company-info"]', card)
      if (companySection) {
        companyName = (q('span.ellipsis-1', companySection)?.textContent || '').trim()
      }
    }

    // --- Company logo ---
    const logoImg = q<HTMLImageElement>('img[class*="logo"], .company-logo-white-bg', card)
    const companyLogo = logoImg?.src || ''

    // --- Recruiter info ---
    // recruiter-info-box 类名在新旧页面均存在，但内部结构不同
    let bossName = ''
    let bossTitle = ''
    let bossOnline = false
    const recruiterBox = q(RECRUITER_BOX_SELECTOR, card)
    if (recruiterBox) {
      // 旧版：recruiter-name / recruiter-title 类名
      bossName = (q('[class*="recruiter-name"]', recruiterBox)?.textContent || '').trim()
      bossTitle = (q('[class*="recruiter-title"]', recruiterBox)?.textContent || '').trim()
      // 新版：recruiter-info-box 内的 ellipsis-1 div
      if (!bossName) {
        const ellipsisDivs = qa('.ellipsis-1', recruiterBox)
        bossName = (ellipsisDivs[0]?.textContent || '').trim() // 第一个是名字
        bossTitle = (ellipsisDivs[1]?.textContent || '').trim() // 第二个是在线状态
      }
      bossOnline = !!bossTitle && (bossTitle.includes('在线') || bossTitle.includes('刚刚'))
    }

    // --- Tags (company industry/size from zhaopin page) ---
    let tags: string[] = []
    const companySection = q('[data-nick="job-detail-company-info"]', card)
    if (companySection) {
      const tagEls = qa('div.ellipsis-1 span, span', companySection)
      tags = tagEls.map(el => (el.textContent || '').trim()).filter(t => t.length >= 2 && t.length <= 20)
    }
    // 也收集旧版的标签
    const oldTagEls = qa('[class*="company-tags-box"] span', card)
    if (oldTagEls.length > 0) {
      tags = oldTagEls.map(el => (el.textContent || '').trim()).filter(Boolean)
    }

    result.push({
      id: extractId(url),
      title,
      companyName,
      companyLogo,
      salary,
      location: city,
      experience,
      education,
      tags,
      jobDescription: '', // JD 在详情页才填充
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
  // 详情页：兼容新旧选择器
  const titleEl = q('[class*="job-title-box"] [class*="ellipsis-1"]')
    || q('.ellipsis-1[title]')
    || q('h1')
  if (!titleEl) return null
  const title = (titleEl.textContent || '').trim()
  const url = location.href
  const cityRaw = (q('[class*="job-dq-box"] [class*="ellipsis-1"]')?.textContent || '').trim()
  const city = cityRaw.split('-')[0] || cityRaw
  return {
    id: extractId(url),
    title,
    companyName: (q('[class*="company-name"]')?.textContent || '').trim(),
    companyLogo: '',
    salary: (q('[class*="job-salary"]')?.textContent || '').trim(),
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
  const maxJobs = options?.maxJobs && options.maxJobs > 0 ? options.maxJobs : Infinity
  const delayBetweenPages = options?.delayBetweenPages ?? 2000
  const onCountChange = options?.onCountChange
  const shouldCancel = options?.shouldCancel
  const collected: JobCard[] = []
  const seen = new Set<string>()

  // zhaopin 页每页约 40 条，maxJobs（用户设置的「单次扫描数量」）控制总量即可
  const isZhaopinPage = location.href.includes('zhaopin')
  const maxPages = options?.maxPages ?? (isZhaopinPage ? 3 : 5)
  const nextSelector = isZhaopinPage
    ? '.ant-pagination-next:not(.ant-pagination-disabled) button'
    : '.pagination .next:not(.disabled), a.next:not(.disabled), .sojob-pagination .next:not(.disabled)'

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
    if (page >= maxPages - 1) break

    // 点击下一页
    const next = q<HTMLElement>(nextSelector)
    if (!next) {
      // zhaopin 页兜底：尝试 Ant Design 分页的 li 元素
      const nextLi = q<HTMLElement>('.ant-pagination-next:not(.ant-pagination-disabled)')
      if (nextLi) {
        // Ant Design 分页：点击 li 内的 button 或 a
        const innerBtn = nextLi.querySelector('button, a') as HTMLElement | null
        if (innerBtn) {
          innerBtn.click()
          await new Promise((r) => setTimeout(r, delayBetweenPages))
          if (shouldCancel?.()) break
          continue
        }
      }
      log('[liepin]', 'collect', '分页按钮未找到，结束采集')
      break
    }

    next.click()
    await new Promise((r) => setTimeout(r, delayBetweenPages))
    if (shouldCancel?.()) break
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
  // 在当前页面找到对应卡片（不跳转！猎聘所有操作都在当前页完成）
  let card: Element | null = null

  const cards = qa(JOB_CARD_SELECTOR)
  for (const el of cards) {
    // 提取标题：兼容新旧页面
    let title = ''
    const oldTitleEl = q('[class*="job-title-box"] [class*="ellipsis-1"]', el)
    if (oldTitleEl) {
      title = (oldTitleEl.textContent || '').trim()
    } else {
      const linkEl = q(DETAIL_LINK_SELECTOR, el)
      if (linkEl) {
        const ellipsisEls = qa('.ellipsis-1', linkEl)
        const titled = ellipsisEls.find(e => e.hasAttribute('title'))
        title = (titled?.getAttribute('title') || titled?.textContent || ellipsisEls[0]?.textContent || '').trim()
      }
    }

    // 提取公司名：兼容新旧页面
    let company = (q('[class*="company-name"]', el)?.textContent || '').trim()
    if (!company) {
      const companySection = q('[data-nick="job-detail-company-info"]', el)
      if (companySection) {
        company = (q('span.ellipsis-1', companySection)?.textContent || '').trim()
      }
    }

    if (expectedTitle && expectedCompany && title === expectedTitle && company === expectedCompany) {
      card = el; break
    }
    if (expectedTitle && title === expectedTitle) {
      card = el; break
    }
    if (expectedTitle && title.includes(expectedTitle)) {
      card = el; break
    }
  }

  if (!card) {
    log('[liepin]', 'activateJobCard', `Card not found: ${expectedTitle}`)
    return null
  }

  // 滚动卡片到可视区域
  ;(card as HTMLElement).scrollIntoView({ behavior: 'smooth', block: 'center' })
  await new Promise((r) => setTimeout(r, 600))

  // hover 招聘者区域（右侧头像+姓名，聊一聊按钮出现在这里）
  const rightBox = q('[class*="job-card-right-box"]', card)
    || q('[class*="recruiter-info-box"]', card)
    || q('[class*="recruiter-photo"]', card)
  if (rightBox) {
    triggerHover(rightBox as HTMLElement)
  }
  // 也 hover 整个卡片
  triggerHover(card as HTMLElement)
  await new Promise((r) => setTimeout(r, 1000))

  // 在卡片内查找「聊一聊」按钮
  // 策略：先找 button/a，再用文字匹配 span/div，找不到就把所有元素检查一遍
  let btn: HTMLElement | null = null

  // 优先：button / a 标签 + 文字匹配
  btn = findButtonByText(card, ['聊一聊'])
  if (!btn) {
    // 次选：搜索所有 span/div 的文字精确等于「聊一聊」
    const allEls = qa<HTMLElement>('span, div, button, a', card)
    for (const el of allEls) {
      const text = (el.textContent || '').replace(/\s+/g, '')
      if (text === '聊一聊') {
        btn = el; break
      }
    }
  }

  if (!btn) {
    log('[liepin]', 'activateJobCard', '聊一聊 not found after hover')
    return null
  }

  // 强制显示
  ;(btn as HTMLElement).style.setProperty('display', 'inline-flex', 'important')
  ;(btn as HTMLElement).style.setProperty('visibility', 'visible', 'important')
  ;(btn as HTMLElement).style.setProperty('opacity', '1', 'important')
  ;(btn as HTMLElement).style.setProperty('pointer-events', 'auto', 'important')

  // 如果找到的是 span/div，往上找最近的 button/a
  let clickTarget: HTMLElement = btn
  if (!['BUTTON', 'A'].includes(btn.tagName)) {
    const parentBtn = btn.closest('button') as HTMLElement | null
    const parentA = btn.closest('a') as HTMLElement | null
    clickTarget = parentBtn || parentA || btn
  }

  // 多种方式触发点击
  clickTarget.click()
  clickTarget.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
  clickTarget.dispatchEvent(new PointerEvent('click', { bubbles: true, cancelable: true, view: window }))

  log('[liepin]', 'activateJobCard', `Clicked 聊一聊 (tag=${clickTarget.tagName}): ${expectedTitle}`)
  await new Promise((r) => setTimeout(r, 1500))

  return card as HTMLElement
}

async function clickApplyButton(_jobCard: HTMLElement): Promise<boolean> {
  // 猎聘的「聊一聊」已在 activateJobCard 中点击，这里不需要重复操作
  return true
}

async function fillGreetingMessage(
  message: string,
  _snapshot?: CommunicationUiSnapshot, // eslint-disable-line @typescript-eslint/no-unused-vars
): Promise<boolean> {
  // 猎聘点击「聊一聊」后弹出模态框，输入框在模态框内。
  // 填入招呼语后，关闭模态框（不发送），继续下一个。
  const textareaSelectors = [
    'textarea',
    '[class*="chat"] textarea',
    '[class*="dialog"] textarea',
    '[class*="message"] textarea',
    '[class*="greeting"] textarea',
  ]

  // 等待模态框中的 textarea 出现
  let input: HTMLTextAreaElement | null = null
  const start = Date.now()
  while (Date.now() - start < 5000) {
    for (const sel of textareaSelectors) {
      const el = q<HTMLTextAreaElement>(sel) as HTMLTextAreaElement | null
      if (el && el.offsetParent !== null && el.offsetWidth > 0) {
        input = el
        break
      }
    }
    if (input) break
    await new Promise((r) => setTimeout(r, 300))
  }

  if (!input) {
    log('[liepin]', 'fillGreetingMessage', 'Greeting textarea not found, trying to close modal anyway')
    await closeAnyModal()
    return true // 找不到输入框不算失败，关闭弹窗继续
  }

  // 填入招呼语
  input.focus()
  const proto = Object.getPrototypeOf(input)
  const valueSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set ??
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set
  if (valueSetter) {
    valueSetter.call(input, message)
  } else {
    input.value = message
  }
  input.dispatchEvent(new Event('input', { bubbles: true }))
  input.dispatchEvent(new Event('change', { bubbles: true }))
  await new Promise((r) => setTimeout(r, 500))

  // 投简历模式：点「发简历」→ 点「立即投递」→ 关闭弹窗
  if (resumeMode) {
    // 限定在弹窗内搜索（避免点到页面外同名元素导致跳转到 wow.liepin.com）
    const modal = q('.ant-im-modal, [class*="im-dialog"], [class*="chat-modal"], [class*="ant-modal"]')
    const searchRoot = (modal as ParentNode) || document

    // 1. 找「发简历」— 必须在弹窗范围内
    let sendBtn: HTMLElement | null = null
    for (const el of qa<HTMLElement>('span', searchRoot)) {
      if ((el.textContent || '').trim() === '发简历') {
        sendBtn = el.closest('[class*="action"]') as HTMLElement | null || el
        break
      }
    }

    if (sendBtn) {
      // beforeunload 拦截所有页面跳转
      const preventNav = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = '' }
      window.addEventListener('beforeunload', preventNav)

      sendBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
      log('[liepin]', 'fillGreetingMessage', 'Clicked 发简历')
      await new Promise((r) => setTimeout(r, 2000))
      window.removeEventListener('beforeunload', preventNav)

      // 2. 找「立即投递」button
      let confirmBtn: HTMLElement | null = null
      for (const el of qa<HTMLElement>('button', document)) {
        if ((el.textContent || '').trim() === '立即投递') { confirmBtn = el; break }
      }

      if (confirmBtn) {
        window.addEventListener('beforeunload', preventNav)
        confirmBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
        log('[liepin]', 'fillGreetingMessage', 'Clicked 立即投递')
        await new Promise((r) => setTimeout(r, 1500))
        window.removeEventListener('beforeunload', preventNav)
      } else {
        log('[liepin]', 'fillGreetingMessage', '立即投递 not found')
      }
    } else {
      log('[liepin]', 'fillGreetingMessage', '发简历 not found in modal')
    }
  }

  // 关闭所有弹窗
  await closeAnyModal()
  log('[liepin]', 'fillGreetingMessage', resumeMode ? 'Resume submitted and modal closed' : 'Greeting filled and modal closed')
  return true
}

/** 查找并点击模态框的关闭按钮（右上角 X 或取消按钮） */
async function closeAnyModal(): Promise<void> {
  // 尝试各种关闭方式
  const closeSelectors = [
    '[class*="modal"] [class*="close"]',
    '[class*="dialog"] [class*="close"]',
    '[class*="modal"] .anticon-close',
    '[class*="dialog"] .anticon-close',
    '[class*="drawer"] [class*="close"]',
    'button[class*="close"]',
    '[aria-label="close"]',
    '[aria-label="关闭"]',
    '.ant-modal-close',
  ]
  for (const sel of closeSelectors) {
    const closeBtn = q<HTMLElement>(sel)
    if (closeBtn && closeBtn.offsetParent !== null) {
      closeBtn.click()
      await new Promise((r) => setTimeout(r, 500))
      return
    }
  }
  // 用 ESC 键兜底
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  await new Promise((r) => setTimeout(r, 300))
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
