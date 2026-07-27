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

export function detectCaptcha(markers?: string[]): boolean {
  const captchaElements = document.querySelectorAll(
    '[class*="captcha"], [class*="verify"], [id*="captcha"], [id*="verify"], .geetest_panel, .captcha-box'
  )
  if (captchaElements.length > 0) return true
  if (containsAny(document.body?.innerText || '', markers)) return true
  return false
}

export function detectRateLimit(markers?: string[]): boolean {
  const errorElements = document.querySelectorAll(
    '[class*="limit"], [class*="too-many"], [class*="频繁"], .error-tips'
  )
  for (const el of errorElements) {
    const text = (el as HTMLElement).innerText || ''
    if (text.includes('操作过于频繁') || text.includes('请稍后再试') || text.includes('limit')) {
      return true
    }
  }
  if (containsAny(document.body?.innerText || '', markers)) return true
  return false
}

export function detectBlock(markers?: string[]): boolean {
  const pageText = document.body?.innerText || ''
  if (pageText.includes('账号异常') || pageText.includes('已被限制')) return true
  if (containsAny(pageText, markers)) return true
  return false
}

// BOSS enforces a hard daily communication cap. When this pops up the session
// can't send any more messages today, so the auto-apply must stop entirely.
export function detectDailyCommunicationLimit(markers?: string[]): string | null {
  const bossCheck = (text: string): boolean =>
    text.includes('沟通上限') ||
    (text.includes('位BOSS沟通') && (text.includes('今天') || text.includes('已与')))
  const pageText = document.body?.innerText || ''
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
    const t = (el as HTMLElement).innerText || ''
    if (bossCheck(t)) return '今日沟通已达上限，已自动停止，请明天再来'
    if (containsAny(t, markers)) return '今日沟通/投递已达上限，已自动停止'
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
