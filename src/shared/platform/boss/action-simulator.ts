// Boss 直聘专属的页面操作逻辑（已从 content/action-simulator 下沉至此）。
// 该模块只服务于 Boss 平台，不依赖任何 content 层代码。
import { randomDelay } from '../../antiBot'
import type { JobCard, MatchResult } from '../../types/job'
import type { CollectOptions } from '../types'

export interface CommunicationUiSnapshot {
  inputs: Set<Element>
  visibleDialogs: Set<Element>
  // 扩展字段（新平台适配器使用；Boss 保留默认空值）
  hasInput?: boolean
  inputSelector?: string
  sendButton?: string
  applyButtons?: number
}

export const BOSS_APPLY_SELECTORS = [
  '.btn-startchat',
  '[class*="btn-startchat"]',
  '[class*="startchat"]',
  '[class*="start-chat"]',
  '[class*="btn-chat"]',
  '[class*="chat-btn"]',
  '[ka*="startchat"]',
  '[ka*="start_chat"]',
  '[ka="job_detail_start_chat"]',
  '[ka="job_card_start_chat"]',
  'a.btn-startchat',
  'button.btn-startchat',
]

export const APPLY_SELECTOR = BOSS_APPLY_SELECTORS.join(', ')

/**
 * 负向黑名单判断：是否属于“不合适/不感兴趣/屏蔽/举报/收藏/关闭”等负向或非投递操作按钮
 */
export function isNegativeButton(el: Element): boolean {
  const text = (el.textContent || '').trim().replace(/\s+/g, '')
  const title = (el.getAttribute('title') || '').trim()
  const ariaLabel = (el.getAttribute('aria-label') || '').trim()
  const ka = (el.getAttribute('ka') || '').toLowerCase()
  const className = (typeof el.className === 'string' ? el.className : '').toLowerCase()

  const negativeKeywords = [
    '不合适',
    '不感兴趣',
    '不喜欢',
    '屏蔽',
    '举报',
    '投诉',
    '收藏',
    '已收藏',
    '分享',
    '点赞',
    '关闭',
    '取消',
    '停止招聘',
    '已停止招聘',
    '职位已关闭',
    '职位已下线',
    '已下架',
    '减少此类推荐',
    '不想看',
  ]

  for (const kw of negativeKeywords) {
    if (text.includes(kw) || title.includes(kw) || ariaLabel.includes(kw)) {
      return true
    }
  }

  // 属性维度的负向过滤（如 dislike, shield, collect, share 等）
  if (
    ka.includes('dislike') ||
    ka.includes('shield') ||
    ka.includes('report') ||
    ka.includes('collect') ||
    ka.includes('share') ||
    className.includes('dislike') ||
    className.includes('op-btn-dislike')
  ) {
    return true
  }

  return false
}

/**
 * 正向投递/沟通按钮判定：文案或特征必须为正向立即沟通，且严禁负向属性
 */
export function isPositiveApplyButton(el: Element): boolean {
  if (isNegativeButton(el)) {
    return false
  }

  const text = (el.textContent || '').trim().replace(/\s+/g, '')
  const lowerText = text.toLowerCase()
  const positiveTexts = [
    '立即沟通',
    '继续沟通',
    '立即投递',
    '聊一聊',
    '发消息',
    '与Boss沟通',
    '开聊',
    '去开聊',
    '打招呼',
    'apply',
  ]

  for (const pos of positiveTexts) {
    if (text.includes(pos) || lowerText.includes(pos)) {
      return true
    }
  }

  // 类名与属性正向特征
  const ka = (el.getAttribute('ka') || '').toLowerCase()
  const className = (typeof el.className === 'string' ? el.className : '').toLowerCase()

  if (
    className.includes('btn-startchat') ||
    className.includes('startchat') ||
    className.includes('btn-chat') ||
    className.includes('chat-btn') ||
    ka.includes('startchat') ||
    ka.includes('start_chat')
  ) {
    return true
  }

  return false
}

/**
 * 自动识别并关闭页面上的意外阻塞性弹窗（例如“请选择不合适的原因”、“减少此类推荐”、“求职反馈”等）
 * 解除页面遮罩锁定，保证自动化与用户操作不被卡死。
 */
export function dismissUnexpectedModals(doc: Document = document): boolean {
  let dismissed = false

  try {
    // 1. 查找可能包含不合适/反馈/干扰选项的模态弹窗
    const dialogs = Array.from(
      doc.querySelectorAll<HTMLElement>(
        '.dialog-wrap, [role="dialog"], .boss-dialog, [class*="dialog-box"], [class*="dialog-container"], .dialog-lib-box, .chat-dialog, .boss-popup'
      )
    )

    for (const dialog of dialogs) {
      if (dialog.offsetWidth === 0 && dialog.offsetHeight === 0 && dialog.getClientRects().length === 0) {
        continue
      }

      const text = dialog.textContent || ''
      // 判断是否属于干扰类或不合适原因弹窗（注意不要误关正常的开聊打招呼输入弹窗）
      const isDislikeModal =
        text.includes('不合适的原因') ||
        text.includes('为什么不合适') ||
        text.includes('减少此类推荐') ||
        text.includes('选择原因') ||
        text.includes('不感兴趣') ||
        text.includes('不想看该')

      if (isDislikeModal) {
        // 优先点击“取消”按钮
        const cancelBtn = Array.from(
          dialog.querySelectorAll<HTMLElement>('button, a, span, [role="button"]')
        ).find((el) => {
          const t = el.textContent?.trim() || ''
          return t === '取消' || t === '放弃' || t === '暂不' || el.classList.contains('btn-cancel')
        })

        if (cancelBtn) {
          cancelBtn.click()
          dismissed = true
        } else {
          // 点击右上角关闭图标
          const closeBtn = dialog.querySelector<HTMLElement>(
            '.icon-close, .dialog-close, .iboss-close, [aria-label="Close"], .close, [class*="close"]'
          )
          if (closeBtn) {
            closeBtn.click()
            dismissed = true
          }
        }

        // 发送 ESC 键兜底
        try {
          window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }))
          doc.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }))
        } catch {}

        // 如果弹窗依然没有关闭，强行隐藏该异常弹窗及其背景遮罩，彻底解除页面卡死
        if (
          dialog.isConnected &&
          (dialog.offsetWidth > 0 || dialog.offsetHeight > 0 || dialog.getClientRects().length > 0)
        ) {
          dialog.style.display = 'none'
          dismissed = true
        }
      }
    }

    // 2. 清理遗留的孤立遮罩层（如果弹窗已经隐藏但遮罩还在）
    const masks = doc.querySelectorAll<HTMLElement>('.dialog-mask, .modal-backdrop, .v-modal')
    for (const mask of Array.from(masks)) {
      if (mask.offsetWidth > 0 || mask.offsetHeight > 0 || mask.getClientRects().length > 0) {
        // 检查页面上是否还有正在展示的正向弹窗（如聊天窗口）
        const hasActiveChatDialog = Array.from(doc.querySelectorAll<HTMLElement>('.chat-dialog, .dialog-wrap')).some(
          d => (d.offsetWidth > 0 || d.offsetHeight > 0 || d.getClientRects().length > 0) && (d.textContent || '').includes('打招呼')
        )
        if (!hasActiveChatDialog) {
          mask.style.display = 'none'
          dismissed = true
        }
      }
    }
  } catch {
    // 忽略异常
  }

  return dismissed
}

/**
 * 健壮查找所有可见的沟通/投递按钮（选择器 + 文案启发式双重探测，且严格排除任何负向/不合适按钮）
 */
export function findApplyButtons(root: Document | Element = document): HTMLElement[] {
  const elements = Array.from(root.querySelectorAll<HTMLElement>(APPLY_SELECTOR))
  const set = new Set<HTMLElement>()

  for (const el of elements) {
    if (isPositiveApplyButton(el)) {
      set.add(el)
    }
  }

  // 兜底：通过常见沟通文案（立即沟通、继续沟通、聊一聊、立即投递等）查找交互按钮
  const clickableCandidates = Array.from(
    root.querySelectorAll<HTMLElement>('a, button, [role="button"], span.btn, div.btn, [class*="btn"]')
  )
  for (const el of clickableCandidates) {
    if (isPositiveApplyButton(el)) {
      set.add(el)
    }
  }

  const validButtons = Array.from(set).filter((el) => {
    // 严禁负向按钮
    if (isNegativeButton(el)) return false
    // 必须符合正向沟通按钮标准
    if (!isPositiveApplyButton(el)) return false
    // 过滤掉不可见或未渲染元素
    return el.offsetWidth > 0 || el.offsetHeight > 0 || el.getClientRects().length > 0
  })

  // 排序：含有“立即沟通”或具有明确 .btn-startchat 主类名的按钮排在最前
  validButtons.sort((a, b) => {
    const textA = (a.textContent || '').trim()
    const textB = (b.textContent || '').trim()
    const isPrimaryA = textA.includes('立即沟通') || a.classList.contains('btn-startchat')
    const isPrimaryB = textB.includes('立即沟通') || b.classList.contains('btn-startchat')
    if (isPrimaryA && !isPrimaryB) return -1
    if (!isPrimaryA && isPrimaryB) return 1
    return 0
  })

  return validButtons
}

const GREETING_INPUT_SELECTOR = [
  '[class*="greet-message"]',
  '[class*="chat-input"]',
  'textarea',
  '[class*="message-area"]',
].join(', ')

const COMMUNICATION_DIALOG_SELECTOR = [
  '[role="dialog"]',
  '.dialog-wrap',
  '[class*="boss-dialog"]',
  '[class*="dialog-container"]',
  '[class*="dialog-wrapper"]',
  '[class*="modal"]',
  '[class*="popup"]',
  '.chat-dialog',
].join(', ')

export async function clickElement(
  selector: string,
  options?: { all?: boolean; index?: number }
): Promise<{ success: boolean; count: number }> {
  await randomDelay()

  if (options?.all) {
    const elements = document.querySelectorAll(selector)
    let count = 0
    for (const el of elements) {
      ;(el as HTMLElement).click()
      count++
      await randomDelay(500, 1500)
    }
    return { success: count > 0, count }
  }

  if (options?.index !== undefined) {
    const elements = document.querySelectorAll(selector)
    if (elements.length > options.index) {
      ;(elements[options.index] as HTMLElement).click()
      return { success: true, count: 1 }
    }
    return { success: false, count: 0 }
  }

  const element = document.querySelector(selector) as HTMLElement | null
  if (element) {
    element.click()
    return { success: true, count: 1 }
  }
  return { success: false, count: 0 }
}

export async function clickApplyButton(jobCard: HTMLElement): Promise<boolean> {
  // 0. 先行清理任何意外遮罩或干扰弹窗
  dismissUnexpectedModals()

  // 1. 优先在目标卡片/详情面板内部寻找沟通按钮
  const cardButtons = findApplyButtons(jobCard)
  for (const btn of cardButtons) {
    if (isPositiveApplyButton(btn) && !isNegativeButton(btn)) {
      await randomDelay(500, 1500)
      btn.click()
      await randomDelay(300, 600)
      dismissUnexpectedModals()
      return true
    }
  }

  // 2. 兜底：若 jobCard 容器判定过窄，在整个 document 中查找沟通按钮
  const docButtons = findApplyButtons(document)
  for (const btn of docButtons) {
    if (isPositiveApplyButton(btn) && !isNegativeButton(btn)) {
      await randomDelay(500, 1500)
      btn.click()
      await randomDelay(300, 600)
      dismissUnexpectedModals()
      return true
    }
  }

  return false
}

function getActionRoot(action: Element): HTMLElement {
  return (
    action.closest(
      '.job-detail-box, .job-detail-container, .job-detail-content, .job-detail-wrapper, [class*="job-detail"], .job-detail-section, .job-box',
    )
    || action.parentElement?.closest('[class*="detail"]')
    || action.parentElement
    || document.body
  ) as HTMLElement
}

export function cleanTitle(text: string): string {
  return text
    .toLowerCase()
    .replace(/[（(【\[].*?[）)】\]]/g, '') // 去除括号内容如（AI 智能体方向），得到核心岗位如 "全栈工程师"
    .replace(/[\s\-_/\\（）()【】\[\]·•/]/g, '')
    .trim()
}

export function cleanFullText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[（【]/g, '(')
    .replace(/[）】]/g, ')')
    .replace(/[\s\-_/\\·•/]/g, '')
    .trim()
}

/** 清理并提取公司主体核心词（去除地名、有限公司、科技有限公司等通用行政后缀与括号说明） */
export function cleanCompanyName(name: string): string {
  return cleanFullText(name)
    .replace(/[(（].*?[)）]/g, '')
    .replace(/(深圳|广州|北京|上海|杭州|成都|武汉|南京|苏州|西安|长沙|东莞|重庆)(市)?/g, '')
    .replace(/(有限责任公司|股份有限公司|科技有限责任公司|网络技术服务有限公司|技术服务有限公司|网络科技有限公司|信息科技有限公司|科技有限公司|网络科技|信息科技|技术服务|服务有限公司|发展有限公司|网络技术|软件技术|集团有限公司|有限公司|分公司|集团|科技)/g, '')
    .trim()
}

/** 双向智能公司名匹配：处理全称与简称不对称（如预期“深圳市方圆宝科技有限公司” vs 页面卡片“方圆宝”） */
export function isCompanyMatch(text: string, expectedCompany: string): boolean {
  if (!expectedCompany) return true
  const normExpected = cleanFullText(expectedCompany)
  const coreExpected = cleanCompanyName(expectedCompany)
  const normText = cleanFullText(text)
  const coreText = cleanCompanyName(text)

  if (normText.includes(normExpected)) return true
  if (coreExpected.length >= 2 && normText.includes(coreExpected)) return true
  if (coreText.length >= 2 && normExpected.includes(coreText)) return true
  if (coreExpected.length >= 2 && coreText.includes(coreExpected)) return true
  return false
}

/** 双向智能职位名匹配：处理带括号或前缀后缀不对称 */
export function isTitleMatch(text: string, expectedTitle: string): boolean {
  if (!expectedTitle) return true
  const normExpected = cleanFullText(expectedTitle)
  const coreExpected = cleanTitle(expectedTitle)
  const normText = cleanFullText(text)
  const coreText = cleanTitle(text)

  if (normText.includes(normExpected)) return true
  if (coreExpected && normText.includes(coreExpected)) return true
  if (coreText.length >= 2 && normExpected.includes(coreText)) return true
  if (coreExpected && coreText.includes(coreExpected)) return true

  // 针对带斜杠 / 分隔符的复合职位（如 "全栈产品工程师 / 独立开发者"、"技术经理/架构师"）
  const subParts = expectedTitle
    .split(/[/、|]+/)
    .map((s) => cleanTitle(s))
    .filter((s) => s.length >= 2)
  if (subParts.length > 1 && subParts.some((p) => normText.includes(p) || coreText.includes(p))) {
    return true
  }

  return false
}

function getDetailContainers(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(
    '.job-detail-box, .job-detail-container, .job-detail-content, .job-detail-wrapper, [class*="job-detail"], [class*="detail-box"], #main, .main-container'
  )).filter((c) => c.offsetWidth > 0 || c.offsetHeight > 0 || c.getClientRects().length > 0)
}

export function checkDetailPanelOffline(root: HTMLElement): boolean {
  const text = root.innerText || root.textContent || ''
  return (
    text.includes('该职位已关闭') ||
    text.includes('职位已关闭') ||
    text.includes('该职位已停止招聘') ||
    text.includes('停止招聘') ||
    text.includes('已停止招聘') ||
    text.includes('该职位已下线') ||
    text.includes('职位已下线') ||
    text.includes('职位已下架') ||
    text.includes('已下架') ||
    text.includes('已暂停招聘') ||
    text.includes('该职位已暂停沟通') ||
    text.includes('停止接受新沟通') ||
    !!root.querySelector('.job-status-closed, [class*="closed"], [class*="offline"], .btn-disabled, [class*="disabled"]')
  )
}

function findMatchingDetailPanel(
  normTitle: string,
  coreTitle: string,
  normCompany: string,
  expectedTitle = '',
  expectedCompany = '',
): HTMLElement | null {
  const containers = getDetailContainers()

  // 1. 优先从详情外层容器中校验
  for (const c of containers) {
    const text = c.innerText || c.textContent || ''
    const titleHit = isTitleMatch(text, expectedTitle)
    const companyHit = !expectedCompany || isCompanyMatch(text, expectedCompany)

    if (titleHit) {
      if (checkDetailPanelOffline(c)) {
        c.setAttribute('data-job-offline', 'true')
        return c
      }
      if (companyHit && findApplyButtons(c).length > 0) {
        return c
      }
    }
  }

  // 2. 遍历所有沟通按钮所在容器
  const actions = findApplyButtons(document)
  for (const action of actions) {
    const root = getActionRoot(action)
    const text = root.innerText || root.textContent || ''
    const titleHit = isTitleMatch(text, expectedTitle)
    const companyHit = !expectedCompany || isCompanyMatch(text, expectedCompany)
    if (titleHit && (companyHit || !expectedCompany)) {
      return root
    }
  }

  // 3. 兜底：若标题强匹配，只要包含沟通按钮或职位描述特征即可认定为对应详情
  for (const c of containers) {
    const text = c.innerText || c.textContent || ''
    if (isTitleMatch(text, expectedTitle)) {
      if (checkDetailPanelOffline(c)) {
        c.setAttribute('data-job-offline', 'true')
        return c
      }
      if (findApplyButtons(c).length > 0 || text.includes('职位描述') || text.includes('岗位职责')) {
        return c
      }
    }
  }

  return null
}

function findAnyActiveDetail(): HTMLElement | null {
  const containers = getDetailContainers()
  for (const c of containers) {
    if (checkDetailPanelOffline(c)) {
      c.setAttribute('data-job-offline', 'true')
      return c
    }
    const text = c.innerText || c.textContent || ''
    if (
      (text.includes('职位描述') || text.includes('岗位职责') || text.includes('任职要求')) &&
      (findApplyButtons(c).length > 0 || text.includes('立即沟通') || text.includes('继续沟通'))
    ) {
      return c
    }
  }

  const actions = findApplyButtons(document)
  for (const action of actions) {
    const root = getActionRoot(action)
    const text = root.innerText || root.textContent || ''
    if (
      text.includes('职位描述') ||
      text.includes('岗位职责') ||
      text.includes('任职要求') ||
      text.includes('立即沟通') ||
      text.includes('继续沟通')
    ) {
      return root
    }
  }
  return null
}

export async function activateJobCard(
  jobUrl: string,
  jobId: string,
  expectedTitle = '',
  expectedCompany = '',
): Promise<HTMLElement | null> {
  const normTitle = cleanFullText(expectedTitle)
  const coreTitle = cleanTitle(expectedTitle)
  const normCompany = cleanFullText(expectedCompany)

  // 0. 特殊情况：若当前页面本身就是独立详情页（/job_detail/xxx.html）
  if (
    typeof window !== 'undefined' &&
    (window.location.href.includes('/job_detail/') || window.location.href.includes('job-detail'))
  ) {
    const pageText = document.body.innerText || document.body.textContent || ''
    const tHit = !expectedTitle || isTitleMatch(pageText, expectedTitle)
    const cHit = !expectedCompany || isCompanyMatch(pageText, expectedCompany)
    if (tHit || cHit) {
      const detailContainer = document.querySelector<HTMLElement>(
        '.job-detail-box, .job-detail-container, .job-detail-content, .job-detail-wrapper, [class*="job-detail"], #main, .main-container',
      ) || document.body
      if (checkDetailPanelOffline(detailContainer)) {
        detailContainer.setAttribute('data-job-offline', 'true')
      }
      return detailContainer
    }
  }

  // 1. 如果当前右侧详情面板已展示此岗位且有立即沟通按钮或已下线，直接复用
  const existingDetail = findMatchingDetailPanel(normTitle, coreTitle, normCompany, expectedTitle, expectedCompany)
  if (existingDetail) {
    return existingDetail
  }

  // 2. 在左侧列表中定位目标卡片（支持双向微滚、自适应顶底复位，解决虚拟列表下卡片被回收问题）
  let cardEl: HTMLElement | null = null
  let titleLink: HTMLAnchorElement | null = null

  const getScrollContainer = (): HTMLElement | null => {
    return document.querySelector<HTMLElement>(
      '.job-list-box, .recommend-list, [class*="job-list"], [class*="result-list"], [class*="geek-list"], ul.job-list-box, .rec-job-list'
    )
  }

  const findCardInDom = (): { card: HTMLElement | null; link: HTMLAnchorElement | null } => {
    // 策略 A: URL / JobId 查找 (含 data- 属性)
    const candidateLinks = Array.from(document.querySelectorAll<HTMLAnchorElement>(
      'a[href*="job_detail"], a[ka*="job"], [class*="job-card"] a, [class*="job-name"], .job-card-box a'
    ))
    for (const link of candidateLinks) {
      if (jobId && link.href.includes(jobId)) {
        const foundCard = (link.closest('li.job-card-box, .job-card-wrapper, .recommend-job-card, li, [class*="job-card"]') || link) as HTMLElement
        return { card: foundCard, link }
      }
      try {
        if (jobUrl && new URL(link.href, window.location.href).pathname === new URL(jobUrl, window.location.href).pathname) {
          const foundCard = (link.closest('li.job-card-box, .job-card-wrapper, .recommend-job-card, li, [class*="job-card"]') || link) as HTMLElement
          return { card: foundCard, link }
        }
      } catch {}
    }

    // 尝试 data-jobid / data-jid 属性定位
    if (jobId) {
      const dataCard = document.querySelector<HTMLElement>(`[data-jobid*="${jobId}"], [data-jid*="${jobId}"], [data-itemid*="${jobId}"]`)
      if (dataCard) {
        const link = dataCard.querySelector<HTMLAnchorElement>('a[href*="job_detail"], a[class*="job-name"], a[class*="title"]')
        return { card: dataCard, link }
      }
    }

    // 策略 B: 标题 + 公司分级模糊匹配
    const allCards = Array.from(document.querySelectorAll<HTMLElement>(
      'li.job-card-box, .job-card-wrapper, .recommend-job-card, .job-list-box > li, [class*="job-card"], [class*="jobCard"]'
    ))

    let fallbackCard: HTMLElement | null = null
    let fallbackLink: HTMLAnchorElement | null = null

    for (const el of allCards) {
      const elText = el.innerText || el.textContent || ''
      const titleHit = isTitleMatch(elText, expectedTitle)
      const companyHit = expectedCompany ? isCompanyMatch(elText, expectedCompany) : true

      if (titleHit && companyHit) {
        const link = el.querySelector<HTMLAnchorElement>('a[href*="job_detail"], a[class*="job-name"], a[class*="title"]')
        return { card: el, link }
      }

      // 如果标题强匹配，先作为保底候选，防公司名因缩写/LOGO缺失而漏配
      if (titleHit && !fallbackCard) {
        fallbackCard = el
        fallbackLink = el.querySelector<HTMLAnchorElement>('a[href*="job_detail"], a[class*="job-name"], a[class*="title"]')
      }
    }

    if (fallbackCard) {
      return { card: fallbackCard, link: fallbackLink }
    }

    return { card: null, link: null }
  }

  // 首次快速探测当前视口 DOM
  const initial = findCardInDom()
  if (initial.card) {
    cardEl = initial.card
    titleLink = initial.link
  } else {
    // 关键优化：若当前视口未命中，极可能是之前采集滚动到底部导致首屏顶部卡片被虚拟列表回收！
    // 立即复位回顶部重新扫描
    const scrollContainer = getScrollContainer()
    if (scrollContainer && scrollContainer.scrollTop > 50) {
      scrollContainer.scrollTop = 0
      scrollContainer.dispatchEvent(new Event('scroll', { bubbles: true }))
    }
    if (window.scrollY > 50) {
      window.scrollTo(0, 0)
      window.dispatchEvent(new Event('scroll'))
    }
    await new Promise((r) => setTimeout(r, 250))

    // 顶部复位后重新寻找
    const topScan = findCardInDom()
    if (topScan.card) {
      cardEl = topScan.card
      titleLink = topScan.link
    } else {
      // 循序向下滚动扫描（从顶部向底部逐步步进，兼顾虚拟列表按需挂载）
      for (let attempt = 0; attempt < 8; attempt++) {
        if (scrollContainer && scrollContainer.scrollHeight > scrollContainer.clientHeight) {
          scrollContainer.scrollTop += 450
          scrollContainer.dispatchEvent(new Event('scroll', { bubbles: true }))
        }
        window.scrollBy(0, 400)
        await new Promise((r) => setTimeout(r, 200))

        const stepScan = findCardInDom()
        if (stepScan.card) {
          cardEl = stepScan.card
          titleLink = stepScan.link
          break
        }
      }
    }
  }

  if (!cardEl && !titleLink) {
    return null
  }

  const target = cardEl || titleLink!

  // 3. 滚动卡片居中可视
  target.scrollIntoView({ behavior: 'smooth', block: 'center' })
  await new Promise((r) => setTimeout(r, 200))

  // 4. 清理 target="_blank"，优先点击卡片内部的交互区域（如 .job-card-left / .job-card-body）
  if (titleLink && titleLink.getAttribute('target') === '_blank') {
    titleLink.removeAttribute('target')
  }

  const clickTarget =
    cardEl?.querySelector<HTMLElement>(
      '.job-card-left, .job-card-body, .job-title, [class*="job-name"], [class*="job-info"]'
    ) || target

  const evtOpts = { bubbles: true, cancelable: true, view: window }
  try {
    clickTarget.dispatchEvent(new PointerEvent('pointerdown', evtOpts))
    clickTarget.dispatchEvent(new MouseEvent('mousedown', evtOpts))
    clickTarget.dispatchEvent(new PointerEvent('pointerup', evtOpts))
    clickTarget.dispatchEvent(new MouseEvent('mouseup', evtOpts))
  } catch {}
  clickTarget.click()

  // 5. 循环等待详情面板展开与更新（增加下线状态识别）
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    const detail = findMatchingDetailPanel(normTitle, coreTitle, normCompany, expectedTitle, expectedCompany)
    if (detail) return detail
    await new Promise((resolve) => setTimeout(resolve, 150))
  }

  // 兜底：如果右侧有任意详情面板或下线提示，直接返回
  const anyDetail = findAnyActiveDetail()
  if (anyDetail) return anyDetail

  return null
}

export async function navigateToNextPage(): Promise<boolean> {
  const nextButton = document.querySelector(
    '[class*="next"], [class*="page-next"], .next-page, button:last-child[class*="page"]'
  ) as HTMLElement | null

  if (nextButton && !nextButton.classList.contains('disabled') && !nextButton.hasAttribute('disabled')) {
    await randomDelay(1000, 3000)
    nextButton.click()
    return true
  }

  // Alternative: click page numbers
  const currentActive = document.querySelector('[class*="active"][class*="page"]')
  if (currentActive) {
    const nextSibling = currentActive.nextElementSibling as HTMLElement | null
    if (nextSibling && nextSibling.textContent?.match(/^\d+$/)) {
      await randomDelay(1000, 3000)
      nextSibling.click()
      return true
    }
  }

  return false
}

function jobKey(job: JobCard): string {
  return job.id || job.url || `${job.companyName}:${job.title}`
}

export async function collectJobCards(
  readCurrentCards: () => JobCard[],
  options?: CollectOptions & {
    stableRounds?: number
  },
): Promise<JobCard[]> {
  const maxJobs = options?.maxJobs ?? Infinity
  const requiredStableRounds = options?.stableRounds ?? 5
  const shouldCancel = options?.shouldCancel
  const jobs = new Map<string, JobCard>()
  let unchangedRounds = 0

  const collectCurrent = () => {
    const before = jobs.size
    for (const job of readCurrentCards()) {
      const key = jobKey(job)
      // 若已被排除（已在任务队列中），跳过以便继续向下滚动采集全新岗位
      if (
        options?.excludeJobIds?.has(key) ||
        options?.excludeJobIds?.has(job.id) ||
        options?.excludeJobIds?.has(`boss:${job.id}`) ||
        options?.excludeJobIds?.has(`${job.companyName}:${job.title}`) ||
        options?.excludeJobIds?.has(`boss:${job.companyName}:${job.title}`)
      ) {
        continue
      }
      jobs.set(key, job)
      if (jobs.size >= maxJobs) break
    }
    if (jobs.size !== before) options?.onCountChange?.(jobs.size)
    return jobs.size !== before
  }

  // Scroll every candidate scroll container AND the window to the very bottom,
  // then dispatch scroll events. This reliably triggers the page's
  // infinite-scroll / lazy-loading so more job cards get rendered.
  const scrollToBottom = () => {
    const containers = Array.from(document.querySelectorAll<HTMLElement>(
      '.job-list-box, [class*="job-list"], [class*="result-list"], .recommend-list, [class*="job-board"], [class*="rec-job"], [class*="geek-list"]',
    )).filter((c) => c.scrollHeight > c.clientHeight + 8)

    for (const c of containers) {
      c.scrollTop = c.scrollHeight
      c.dispatchEvent(new Event('scroll', { bubbles: true }))
    }
    // Fallback: many feeds listen on the document/window scroll.
    window.scrollTo(0, document.documentElement.scrollHeight)
    window.dispatchEvent(new Event('scroll', { bubbles: true }))
  }

  collectCurrent()
  while (jobs.size < maxJobs && unchangedRounds < requiredStableRounds) {
    if (shouldCancel?.()) break
    scrollToBottom()
    // Give the feed enough time to fetch & render the next batch of cards.
    await randomDelay(1200, 2000)
    if (shouldCancel?.()) break
    unchangedRounds = collectCurrent() ? 0 : unchangedRounds + 1
  }

  return Array.from(jobs.values())
}

function isVisible(element: Element): boolean {
  const style = window.getComputedStyle(element)
  return style.display !== 'none'
    && style.visibility !== 'hidden'
    && style.opacity !== '0'
}

export function snapshotCommunicationUi(): CommunicationUiSnapshot {
  return {
    inputs: new Set(document.querySelectorAll(GREETING_INPUT_SELECTOR)),
    visibleDialogs: new Set(
      Array.from(document.querySelectorAll(COMMUNICATION_DIALOG_SELECTOR))
        .filter(isVisible),
    ),
  }
}

async function closeGreetingDialog(dialog: Element): Promise<boolean> {
  if (!dialog.isConnected) return true

  const closeSelector = [
    '[aria-label*="关闭"]',
    '[aria-label="Close"]',
    '[title*="关闭"]',
    '[class*="dialog-close"]',
    '[class*="modal-close"]',
    '[class*="popup-close"]',
    '[class*="icon-close"]',
    'button[class*="close"]',
  ].join(', ')
  const closeButton = (
    dialog.querySelector(closeSelector)
    || Array.from(dialog.querySelectorAll<HTMLElement>('button, [role="button"], i, span'))
      .find((candidate) => ['×', '✕', '✖'].includes(candidate.textContent?.trim() || ''))
  ) as HTMLElement | null

  if (closeButton) {
    await randomDelay(200, 500)
    closeButton.click()
    return true
  }
  return false
}

export async function fillGreetingMessage(
  message: string,
  snapshot: CommunicationUiSnapshot = {
    inputs: new Set(),
    visibleDialogs: new Set(),
  },
): Promise<boolean> {
  // Wait for either a greeting editor or a standalone communication modal.
  const deadline = Date.now() + 5000
  let textarea: HTMLTextAreaElement | null = null
  while (Date.now() < deadline && !textarea) {
    const candidates = Array.from(
      document.querySelectorAll<HTMLTextAreaElement>(GREETING_INPUT_SELECTOR),
    )
    textarea = candidates.reverse().find((candidate) => !snapshot.inputs.has(candidate)) || null
    if (textarea) break

    const newDialogs = Array.from(
      document.querySelectorAll(COMMUNICATION_DIALOG_SELECTOR),
    ).filter((dialog) => isVisible(dialog) && !snapshot.visibleDialogs.has(dialog))
    for (const dialog of newDialogs.reverse()) {
      // Close pre-existing dialogs (stale from previous interactions) so
      // they don't block the greeting flow, but do NOT return true — we
      // haven't sent a greeting yet. Continue waiting for the textarea.
      await closeGreetingDialog(dialog)
      // Don't return — continue the while loop to find the textarea
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }

  if (textarea) {
    textarea.value = message
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    textarea.dispatchEvent(new Event('change', { bubbles: true }))
    await randomDelay(300, 800)

    // Find and click send button
    const dialog = textarea.closest(
      `${COMMUNICATION_DIALOG_SELECTOR}, [class*="popover"], [class*="greeting"]`,
    ) || textarea.parentElement || document.body
    const sendBtn = dialog.querySelector(
      '[class*="send"], button[type="submit"], [class*="submit"]'
    ) as HTMLElement | null

    if (sendBtn) {
      await randomDelay(500, 1500)
      sendBtn.click()
      if (dialog !== document.body) await closeGreetingDialog(dialog)
      return true
    }
  }

  return false
}

export function getJobSpecificGreeting(
  resumeName: string,
  job: JobCard,
  match: MatchResult,
): string {
  const relevantSkills = match.skillMatch
    .filter(Boolean)
    .slice(0, 3)
    .join('、')
  const experience = relevantSkills
    ? `我有${relevantSkills}相关经验，`
    : '我的经历与该岗位方向较匹配，'
  return `您好，我是${resumeName}，看到${job.companyName}正在招聘“${job.title}”。${experience}希望能进一步沟通。`
}

// ─── 聊天页操作（/web/geek/chat）───

export interface ChatContact {
  id: string
  name: string
  company: string
  element: HTMLElement
}

/** 获取聊天页左侧联系人列表 */
export function getChatContacts(): ChatContact[] {
  const contacts: ChatContact[] = []

  // Boss 聊天页联系人容器：DIV.chat-user.v2
  const container = document.querySelector('[class*="chat-user"]')
  if (!container) return contacts

  // 联系人项是容器内的直接子 DIV
  const items = container.querySelectorAll(':scope > div, :scope > a, :scope > li')
  items.forEach((el, i) => {
    const text = (el.textContent || '').trim()
    if (!text || text.length < 5) return

    // 排除非联系人的 UI 元素（过滤栏、标签页等）
    const excludeWords = ['全部未读', '全部', '未读', '新招呼', '仅沟通', '有交换', '有面试', '不感兴趣', 'AI筛选', '提交', '更多', '已读', '筛选']
    if (excludeWords.some(w => text.startsWith(w) || text === w)) return

    // 必须有时间戳格式（HH:MM）或名称格式才是联系人
    const hasTime = /\d{1,2}:\d{2}/.test(text.slice(0, 6))
    if (!hasTime && text.length < 15) return

    // 提取名称（时间戳后面的中文字符）
    const cleanText = text.replace(/^\d{1,2}:\d{2}/, '').trim()
    const nameMatch = cleanText.match(/^([一-龥]{2,4})/)
    const name = nameMatch ? nameMatch[1] : cleanText.slice(0, 5)
    const company = cleanText.slice(name.length, name.length + 15).trim()

    contacts.push({
      id: el.getAttribute('data-id') || el.getAttribute('data-uid') || `chat-${i}`,
      name,
      company,
      element: el as HTMLElement,
    })
  })

  return contacts
}

/** 点击联系人打开对话 */
export async function clickContact(contact: ChatContact): Promise<boolean> {
  contact.element.scrollIntoView({ behavior: 'smooth', block: 'center' })
  await new Promise((r) => setTimeout(r, 600))

  // 尝试多种点击方式
  const el = contact.element
  el.click()
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
  el.dispatchEvent(new PointerEvent('click', { bubbles: true, cancelable: true, view: window }))

  // 也尝试点击元素内的第一个链接或可交互子元素
  const inner = el.querySelector('a, button, [class*="name"], [class*="title"]') as HTMLElement | null
  if (inner) {
    inner.click()
    inner.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
  }

  await new Promise((r) => setTimeout(r, 1000))
  return true
}

/**
 * 检查当前对话是否已发过简历。
 * 在聊天记录中搜索已发送标记文本。
 */
export function hasResumeSentInChat(): boolean {
  const markers = ['附件简历请求已发送', '简历已发送', '已发送简历', '附件简历已投递', '简历请求已发送']
  const chatArea = document.querySelector('[class*="chat-content"], [class*="chat-message"], [class*="message-list"], [class*="chat-dialog"]')
  const body = (chatArea?.textContent || document.body.textContent || '')
  return markers.some((m) => body.includes(m))
}

/** 在对话工具栏中找「发简历」按钮并点击 */
export async function clickSendResume(): Promise<boolean> {
  await new Promise((r) => setTimeout(r, 1000))

  // 只搜 button，且文本精确等于「发简历」
  let btn: HTMLElement | null = null
  const allBtnTexts: string[] = []
  for (const b of document.querySelectorAll<HTMLElement>('button')) {
    const t = (b.textContent || '').trim()
    if (t.length >= 2 && t.length <= 15) allBtnTexts.push(t)
    if (t === '发简历') { btn = b; break }
  }
  console.log('[clickSendResume] All buttons:', allBtnTexts.join(', '))
  console.log('[clickSendResume] Found btn:', btn ? (btn.textContent || '').trim() : 'NULL')

  if (!btn) return false

  btn.scrollIntoView({ block: 'center' })
  await new Promise((r) => setTimeout(r, 300))
  btn.click()
  await new Promise((r) => setTimeout(r, 1500))
  return true
}

/** 在简历弹窗中选简历并点发送 */
export async function selectAndSendResume(): Promise<boolean> {
  // 等待弹窗出现
  await new Promise((r) => setTimeout(r, 1000))

  // 收集弹窗内所有按钮文字供调试
  const allBtns = document.querySelectorAll('button, [role="button"], [class*="btn"]')
  const btnList = Array.from(allBtns).map(b => (b.textContent || '').trim()).filter(t => t.length >= 2 && t.length <= 10).join(',')
  console.log('[selectAndSendResume] Buttons in dialog:', btnList || 'none')

  // 找并点击「发送」或「确定」按钮
  const keywords = ['发送', '确定', '确认发送', '立刻投递', '立即投递', '投递']
  let sendBtn: HTMLElement | null = null

  // 优先在弹窗/modal 内搜索
  const dialog = document.querySelector('[class*="dialog"], [class*="modal"], [class*="drawer"], [class*="popup"], .dialog-wrap')
  const root = (dialog as ParentNode) || document
  const all = root.querySelectorAll<HTMLElement>('button, span, a, div')
  for (const el of all) {
    const text = (el.textContent || '').trim()
    if (keywords.includes(text)) {
      sendBtn = el.closest('button') as HTMLElement | null || el
      break
    }
  }

  // 全局兜底
  if (!sendBtn) {
    for (const el of document.querySelectorAll<HTMLElement>('button')) {
      if (keywords.includes((el.textContent || '').trim())) {
        sendBtn = el; break
      }
    }
  }

  if (!sendBtn) return false

  sendBtn.click()
  await new Promise((r) => setTimeout(r, 1500))
  return true
}

/** 关闭详情侧边面板（非推荐岗位释放资源，并清理意外遮罩） */
export async function closeDetailPanel(): Promise<void> {
  dismissUnexpectedModals()

  // Boss 详情面板关闭方式多样：点 X 按钮 / 点遮罩 / ESC
  const closeBtn = document.querySelector(
    '.job-detail-container [class*="close"], .job-detail-box [class*="close"], [class*="detail-close"]'
  ) as HTMLElement | null
  if (closeBtn && closeBtn.offsetParent !== null) {
    closeBtn.click()
    await new Promise((r) => setTimeout(r, 300))
    dismissUnexpectedModals()
    return
  }
  // 兜底：ESC
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  await new Promise((r) => setTimeout(r, 300))
  dismissUnexpectedModals()
}

/** 从 Boss 聊天会话中提取最后一条由对方（HR/面试官）发出的提问或消息 */
export function getLastHrMessageFromChat(): {
  text: string
  sender?: string
  time?: string
} | null {
  // Boss 直聘聊天面板消息项选择器：通常由 .item-friend / [class*="friend"] 标识对方消息
  const chatMessages = Array.from(
    document.querySelectorAll<HTMLElement>(
      '.chat-message .item-friend, [class*="message-list"] [class*="friend"], [class*="chat-item"][class*="friend"], .chat-record .item-friend',
    ),
  )

  if (chatMessages.length === 0) {
    const allItems = Array.from(
      document.querySelectorAll<HTMLElement>(
        '.chat-message [class*="item"], [class*="message-item"], [class*="chat-record"] > div',
      ),
    )
    for (let i = allItems.length - 1; i >= 0; i--) {
      const el = allItems[i]
      const cls = (el.className || '').toLowerCase()
      if (!cls.includes('myself') && !cls.includes('system') && !cls.includes('time')) {
        chatMessages.push(el)
        break
      }
    }
  }

  if (chatMessages.length === 0) return null
  const lastItem = chatMessages[chatMessages.length - 1]

  const textEl =
    lastItem.querySelector<HTMLElement>(
      '.text, [class*="text"], .chat-text, [class*="message-content"]',
    ) || lastItem
  const rawText = (textEl.textContent || '').replace(/\s+/g, ' ').trim()
  if (!rawText) return null

  const nameEl = lastItem.querySelector<HTMLElement>('[class*="name"]')
  const timeEl = lastItem.querySelector<HTMLElement>('[class*="time"]')

  return {
    text: rawText,
    sender: nameEl?.textContent?.trim() || 'HR',
    time: timeEl?.textContent?.trim(),
  }
}

/** 将生成的建议话术自动填入聊天输入框，并支持模拟点击发送 */
export async function fillChatInputAndSend(
  text: string,
  sendImmediately = false,
): Promise<boolean> {
  const inputEl = document.querySelector<HTMLElement>(
    '#chat-input, [contenteditable="true"], .chat-input, textarea[class*="input"], [class*="chat-input"] [contenteditable]',
  )

  if (!inputEl) {
    console.warn('[fillChatInputAndSend] Chat input not found')
    return false
  }

  inputEl.scrollIntoView({ block: 'center' })
  inputEl.focus()
  await new Promise((r) => setTimeout(r, 100))

  if (inputEl.isContentEditable) {
    inputEl.innerHTML = ''
    document.execCommand('insertText', false, text)
    inputEl.dispatchEvent(new Event('input', { bubbles: true }))
    inputEl.dispatchEvent(new Event('change', { bubbles: true }))
  } else {
    ;(inputEl as HTMLInputElement | HTMLTextAreaElement).value = text
    inputEl.dispatchEvent(new Event('input', { bubbles: true }))
    inputEl.dispatchEvent(new Event('change', { bubbles: true }))
  }

  await new Promise((r) => setTimeout(r, 200))

  if (sendImmediately) {
    const sendBtn = document.querySelector<HTMLElement>(
      'button.btn-send, [class*="btn-send"], button[class*="send"], [class*="op-btn-send"], button:has-text("发送")',
    )
    if (sendBtn && sendBtn.offsetParent !== null) {
      sendBtn.click()
    } else {
      inputEl.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          code: 'Enter',
          keyCode: 13,
          bubbles: true,
        }),
      )
    }
  }

  return true
}

/** 关闭当前弹窗 */
export async function closeChatDialog(): Promise<void> {
  const closeSelectors = [
    '[class*="dialog"] [class*="close"]',
    '[class*="modal"] [class*="close"]',
    '.dialog-container [class*="close"]',
    '[class*="dialog"] .icon-close',
    '.ant-modal-close',
  ]
  for (const sel of closeSelectors) {
    const btn = document.querySelector(sel) as HTMLElement | null
    if (btn && btn.offsetParent !== null) {
      btn.click()
      await new Promise((r) => setTimeout(r, 300))
      return
    }
  }
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  await new Promise((r) => setTimeout(r, 300))
}

