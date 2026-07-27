// Boss 直聘专属的页面操作逻辑（已从 content/action-simulator 下沉至此）。
// 该模块只服务于 Boss 平台，不依赖任何 content 层代码。
import { randomDelay } from '../../antiBot'
import type { JobCard, MatchResult } from '../../types/job'

export interface CommunicationUiSnapshot {
  inputs: Set<Element>
  visibleDialogs: Set<Element>
}

const APPLY_SELECTOR = [
  '[class*="btn-chat"]',
  '[class*="apply"]',
  '[class*="start-chat"]',
  '[class*="greet"]',
  'button:has([class*="chat"])',
].join(', ')

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
  // Look for the apply/chat button inside the job card
  const applyButton = jobCard.querySelector(APPLY_SELECTOR) as HTMLElement | null

  if (applyButton) {
    await randomDelay(500, 2000)
    applyButton.click()
    return true
  }

  // Fallback: find any button that looks like apply
  const buttons = jobCard.querySelectorAll('button, [role="button"], a.btn')
  for (const btn of buttons) {
    const text = btn.textContent?.trim() || ''
    if (text.includes('沟通') || text.includes('立即沟通') || text.includes('投递') || text.includes('聊一聊')) {
      await randomDelay(500, 2000)
      ;(btn as HTMLElement).click()
      return true
    }
  }

  return false
}

function getActionRoot(action: Element): HTMLElement {
  return (
    action.closest(
      '.job-detail-content, [class*="job-detail-container"], [class*="job-detail-box"], [class*="job-detail-wrapper"]',
    )
    || action.parentElement
    || document.body
  ) as HTMLElement
}

export async function activateJobCard(
  jobUrl: string,
  jobId: string,
  expectedTitle = '',
  expectedCompany = '',
): Promise<HTMLElement | null> {
  const links = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href*="job_detail"]'))
  const link = links.find((candidate) => {
    if (jobId && candidate.href.includes(jobId)) return true
    try {
      return new URL(candidate.href, window.location.href).pathname
        === new URL(jobUrl, window.location.href).pathname
    } catch {
      return false
    }
  })

  if (!link) return null

  const previousActions = new Set(document.querySelectorAll(APPLY_SELECTOR))
  link.click()

  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    const actions = Array.from(document.querySelectorAll(APPLY_SELECTOR))
    const expectedTexts = [expectedTitle, expectedCompany]
      .map((value) => value.replace(/\s+/g, '').toLowerCase())
      .filter(Boolean)

    for (const action of actions.reverse()) {
      const root = getActionRoot(action)
      const rootText = (root.innerText || root.textContent || '')
        .replace(/\s+/g, '')
        .toLowerCase()
      const identityMatches = expectedTexts.some((text) => rootText.includes(text))
      if (!previousActions.has(action) || identityMatches) return root
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }

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
  options?: {
    maxJobs?: number
    stableRounds?: number
    onCountChange?: (count: number) => void
    shouldCancel?: () => boolean
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
      if (jobs.size >= maxJobs) break
      jobs.set(jobKey(job), job)
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
      if (await closeGreetingDialog(dialog)) return true
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

  // 只搜 button，且文本精确等于「发简历」，排除「请求电话」等
  let btn: HTMLElement | null = null
  for (const b of document.querySelectorAll<HTMLElement>('button')) {
    const t = (b.textContent || '').trim()
    if (t === '发简历' || t.startsWith('发简历')) {
      if (!t.includes('请求') && !t.includes('电话')) { btn = b; break }
    }
  }

  if (!btn) return false

  btn.scrollIntoView({ block: 'center' })
  await new Promise((r) => setTimeout(r, 300))

  const rect = btn.getBoundingClientRect()
  const cx = rect.left + rect.width / 2
  const cy = rect.top + rect.height / 2
  const init: MouseEventInit = {
    bubbles: true, cancelable: true, view: window,
    clientX: cx, clientY: cy, screenX: cx, screenY: cy, button: 0,
  }

  btn.dispatchEvent(new PointerEvent('pointerdown', init))
  btn.dispatchEvent(new MouseEvent('mousedown', init))
  btn.dispatchEvent(new PointerEvent('pointerup', init))
  btn.dispatchEvent(new MouseEvent('mouseup', init))
  btn.dispatchEvent(new PointerEvent('click', init))
  btn.dispatchEvent(new MouseEvent('click', init))
  btn.click()

  await new Promise((r) => setTimeout(r, 1500))
  return true
}
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

  const rect = sendBtn.getBoundingClientRect()
  const cx = rect.left + rect.width / 2
  const cy = rect.top + rect.height / 2
  const init: MouseEventInit = {
    bubbles: true, cancelable: true, view: window,
    clientX: cx, clientY: cy, screenX: cx, screenY: cy, button: 0,
  }
  sendBtn.dispatchEvent(new PointerEvent('pointerdown', init))
  sendBtn.dispatchEvent(new MouseEvent('mousedown', init))
  sendBtn.dispatchEvent(new PointerEvent('pointerup', init))
  sendBtn.dispatchEvent(new MouseEvent('mouseup', init))
  sendBtn.dispatchEvent(new PointerEvent('click', init))
  sendBtn.dispatchEvent(new MouseEvent('click', init))
  sendBtn.click()
  await new Promise((r) => setTimeout(r, 1500))
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
