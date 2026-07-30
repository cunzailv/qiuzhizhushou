import type { PageState, ButtonInfo, InputInfo, DialogInfo } from './types'

const MAX_BUTTONS = 30
const MAX_INPUTS = 10
const MAX_DIALOGS = 5
const MAX_KEYTEXT_CHARS = 500

function isVisible(el: Element): boolean {
  if (!el || !(el instanceof HTMLElement)) return false
  return el.offsetParent !== null
    && getComputedStyle(el).display !== 'none'
    && getComputedStyle(el).visibility !== 'hidden'
    && getComputedStyle(el).opacity !== '0'
}

/** 采集页面状态，压缩后发给 AI */
export function capturePageState(platform: string, goal: string, pageType: string): PageState {
  const buttons: ButtonInfo[] = []
  const seenTexts = new Set<string>()

  // 收集所有可点击元素
  const clickables = document.querySelectorAll(
    'button, [role="button"], a[class*="btn"], a.btn, a[href*="job_detail"], span[class*="btn"]'
  )
  clickables.forEach((el, i) => {
    if (buttons.length >= MAX_BUTTONS) return
    const text = (el.textContent || '').replace(/\s+/g, ' ').trim()
    if (!text || text.length > 30 || seenTexts.has(text)) return
    seenTexts.add(text)
    buttons.push({
      index: buttons.length,
      text,
      tag: el.tagName.toLowerCase(),
      visible: isVisible(el),
      enabled: !(el as HTMLButtonElement).disabled,
    })
  })

  // 收集输入框
  const inputs: InputInfo[] = []
  const inputEls = document.querySelectorAll('textarea, input[type="text"], input[type="search"], [contenteditable="true"]')
  inputEls.forEach((el, i) => {
    if (inputs.length >= MAX_INPUTS) return
    inputs.push({
      index: inputs.length,
      tag: el.tagName.toLowerCase(),
      placeholder: (el as HTMLInputElement).placeholder || (el.getAttribute('aria-label') || '').slice(0, 30),
      visible: isVisible(el),
    })
  })

  // 收集弹窗
  const dialogs: DialogInfo[] = []
  const dialogEls = document.querySelectorAll(
    '[role="dialog"], [class*="dialog-wrap"], [class*="dialog-container"], [class*="modal"], [class*="drawer"]'
  )
  dialogEls.forEach((el) => {
    if (dialogs.length >= MAX_DIALOGS) return
    if (!isVisible(el)) return
    dialogs.push({
      index: dialogs.length,
      textSample: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 150),
      classes: (el.className?.toString?.() || '').slice(0, 60),
    })
  })

  // 收集关键文本（错误提示、成功消息、页面标题）
  const keyTexts: string[] = []
  const textEls = document.querySelectorAll(
    '[class*="error"], [class*="toast"], [class*="tip"], [class*="message"], [class*="notice"], h1, h2'
  )
  let totalChars = 0
  for (const el of textEls) {
    if (totalChars >= MAX_KEYTEXT_CHARS) break
    const t = (el.textContent || '').replace(/\s+/g, ' ').trim()
    if (t && t.length >= 2 && t.length <= 100) {
      keyTexts.push(t)
      totalChars += t.length
    }
  }

  return {
    platform,
    pageType,
    goal,
    buttons,
    inputs,
    dialogs,
    keyTexts,
    url: window.location.href,
  }
}
