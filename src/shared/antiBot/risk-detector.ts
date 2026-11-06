// Risk detection for anti-bot measures (multi-platform aware).
// 各平台的风控文案通过 PlatformRiskConfig 传入；不传时回退到 Boss 直聘的
// 原生判定逻辑，保证 Boss 端行为完全不变。
import type { PlatformRiskConfig } from '../platform/types'

export interface RiskSignal {
  type: 'captcha' | 'rate_limit' | 'block' | 'warning'
  message: string
  detectedAt: string
}

const riskSignals: RiskSignal[] = []

function containsAny(text: string, markers?: string[]): boolean {
  if (!markers || markers.length === 0) return false
  return markers.some((m) => text.includes(m))
}

/** 元素是否真实可见（隐藏的预加载验证码容器不应触发暂停） */
function isVisibleElement(el: HTMLElement, minWidth = 40, minHeight = 20): boolean {
  const style = window.getComputedStyle(el)
  if (style.display === 'none' || style.visibility === 'hidden') return false
  // 注意：opacity 未设置时是空字符串，Number('') === 0 会把可见元素误判成全透明
  if (style.opacity && Number(style.opacity) === 0) return false
  const rect = el.getBoundingClientRect()
  // jsdom 等无布局环境 rect 全 0，此时不据尺寸排除
  if (rect.width > 0 || rect.height > 0) {
    if (rect.width < minWidth || rect.height < minHeight) return false
  }
  return true
}

/**
 * 收集页面上「真实可见」的浮层文本。
 * 验证码、封号、限流提示都以弹层/浮层形式出现，
 * 整页扫描会把岗位描述、帮助链接里的同名字样当成风控信号（历史误报源）。
 */
function getVisibleOverlayText(): string {
  const overlays = document.querySelectorAll(
    [
      '[role="dialog"]',
      '[class*="dialog"]',
      '[class*="modal"]',
      '[class*="popup"]',
      '[class*="layer"]',
      '[class*="geetest"]',
      '[class*="captcha"]',
      '[class*="verify"]',
      '[class*="risk"]',
      '[class*="toast"]',
      '.error-tips',
    ].join(', '),
  )

  let text = ''
  for (const el of overlays) {
    if (!(el instanceof HTMLElement)) continue
    if (!isVisibleElement(el)) continue
    const t = el.innerText || el.textContent || ''
    if (t.trim()) text += ` ${t}`
  }
  return text
}

/**
 * 页面是否已经被错误提示整页替换。
 * 真正封号/拦截时页面几乎只剩错误文案；正常列表页文本量很大，
 * 据此可避免「岗位描述里写了账号异常」被误判成账号被封。
 */
function readPageText(): string {
  if (typeof document === 'undefined' || !document.body) return ''
  return document.body.innerText || document.body.textContent || ''
}

function isLikelyBlockedPage(pageText: string): boolean {
  const t = pageText.trim()
  return t.length > 0 && t.length < 600
}

export function detectCaptcha(markers?: string[]): boolean {
  // 1. 真实显示的验证码容器
  const captchaElements = document.querySelectorAll(
    '[class*="captcha"], [class*="verify"], [id*="captcha"], [id*="verify"], .geetest_panel, .captcha-box'
  )
  for (const el of captchaElements) {
    if (!(el instanceof HTMLElement)) continue
    if (!isVisibleElement(el, 20, 20)) continue
    return true
  }

  // 2. 文本标记：只扫「可见浮层」。
  //    历史实现扫的是 document.body.innerText，导致岗位描述里出现「验证码」、
  //    页脚出现「安全验证」就判定为命中验证码，用户被挂起却看不到任何验证码。
  const overlayText = getVisibleOverlayText()
  if (overlayText && containsAny(overlayText, markers)) return true

  return false
}

export function detectRateLimit(markers?: string[]): boolean {
  const errorElements = document.querySelectorAll(
    '[class*="limit"], [class*="too-many"], [class*="频繁"], .error-tips'
  )
  for (const el of errorElements) {
    const text = (el as HTMLElement).innerText || el.textContent || ''
    if (text.includes('操作过于频繁') || text.includes('请稍后再试') || text.includes('limit')) {
      return true
    }
  }

  // 限定在可见浮层内匹配，避免整页文本误报
  const overlayText = getVisibleOverlayText()
  if (overlayText && containsAny(overlayText, markers)) return true
  return false
}

export function detectBlock(markers?: string[]): boolean {
  const pageText = readPageText()
  const hit = (t: string): boolean =>
    t.includes('账号异常') || t.includes('已被限制') || containsAny(t, markers)

  // 1. 浮层里明确出现封号文案
  const overlayText = getVisibleOverlayText()
  if (overlayText && hit(overlayText)) return true

  // 2. 整页已被错误提示替换时才按全页文本判定
  if (isLikelyBlockedPage(pageText) && hit(pageText)) return true

  return false
}

// BOSS enforces a hard daily communication cap. When this pops up the session
// can't send any more messages today, so the auto-apply must stop entirely.
export function detectDailyCommunicationLimit(markers?: string[]): string | null {
  // Only match when the LIMIT is actually REACHED — NOT the informational
  // counter "今天已与N位BOSS沟通" that Boss shows after every communication.
  const bossCheck = (text: string): boolean =>
    text.includes('沟通上限') ||
    text.includes('沟通次数已达上限') ||
    text.includes('已达沟通上限') ||
    (text.includes('已达上限') && text.includes('沟通'))
  const pageText = readPageText()
  if (bossCheck(pageText)) {
    return '今日沟通已达上限，已自动停止，请明天再来'
  }
  if (containsAny(pageText, markers)) {
    const found = markers?.find((m) => pageText.includes(m)) ?? ''
    return `检测到达到每日沟通上限相关提示：${found}`
  }
  const overlays = document.querySelectorAll(
    '[class*="dialog"], [class*="modal"], [class*="toast"], [class*="dialog-box"], [class*="limit"], [class*="tip"], .dialog-con'
  )
  for (const el of overlays) {
    const t = (el as HTMLElement).innerText || el.textContent || ''
    if (bossCheck(t)) return '今日沟通已达上限，已自动停止，请明天再来'
    if (containsAny(t, markers)) return '今日沟通次数已达上限，已自动停止'
  }
  return null
}

export function scanRisk(platform?: PlatformRiskConfig): RiskSignal | null {
  if (detectBlock(platform?.blockMarkers)) {
    const signal: RiskSignal = {
      type: 'block',
      message: '检测到账号异常或风控限制，已自动暂停操作',
      detectedAt: new Date().toISOString(),
    }
    riskSignals.push(signal)
    return signal
  }

  // Daily communication cap is a hard stop — same severity as a block.
  const dailyLimit = detectDailyCommunicationLimit(platform?.dailyLimitMarkers)
  if (dailyLimit) {
    const signal: RiskSignal = {
      type: 'block',
      message: dailyLimit,
      detectedAt: new Date().toISOString(),
    }
    riskSignals.push(signal)
    return signal
  }

  if (detectRateLimit(platform?.rateLimitMarkers)) {
    const signal: RiskSignal = {
      type: 'rate_limit',
      message: '检测到操作频率限制，请等待一段时间后再试',
      detectedAt: new Date().toISOString(),
    }
    riskSignals.push(signal)
    return signal
  }

  if (detectCaptcha(platform?.captchaMarkers)) {
    const signal: RiskSignal = {
      type: 'captcha',
      message: '检测到验证码，请手动完成验证后继续',
      detectedAt: new Date().toISOString(),
    }
    riskSignals.push(signal)
    return signal
  }

  return null
}

export function getRiskHistory(): RiskSignal[] {
  return riskSignals
}

export function clearRiskHistory(): void {
  riskSignals.length = 0
}
