// Risk detection for Boss Zhipin anti-bot measures

export interface RiskSignal {
  type: 'captcha' | 'rate_limit' | 'block' | 'warning'
  message: string
  detectedAt: string
}

const riskSignals: RiskSignal[] = []

export function detectCaptcha(): boolean {
  const captchaElements = document.querySelectorAll(
    '[class*="captcha"], [class*="verify"], [id*="captcha"], [id*="verify"], .geetest_panel, .captcha-box'
  )
  return captchaElements.length > 0
}

export function detectRateLimit(): boolean {
  const errorElements = document.querySelectorAll(
    '[class*="limit"], [class*="too-many"], [class*="频繁"], .error-tips'
  )
  for (const el of errorElements) {
    const text = (el as HTMLElement).innerText || ''
    if (text.includes('操作过于频繁') || text.includes('请稍后再试') || text.includes('limit')) {
      return true
    }
  }
  return false
}

export function detectBlock(): boolean {
  const pageText = document.body.innerText || ''
  return pageText.includes('账号异常') || pageText.includes('已被限制')
}

// BOSS enforces a hard daily communication cap (e.g. "您已与150位BOSS沟通").
// When this pops up the session can't send any more messages today, so the
// auto-apply must stop entirely (and resume tomorrow) instead of burning
// requests against a wall.
export function detectDailyCommunicationLimit(): string | null {
  const markers = ['已达到沟通上限', '沟通上限', '位BOSS沟通', '今天已与', '明天再来']
  const check = (text: string): boolean =>
    text.includes('沟通上限') ||
    (text.includes('位BOSS沟通') && (text.includes('今天') || text.includes('已与')))
  if (check(document.body.innerText || '')) {
    return '今日沟通已达上限，已自动停止，请明天再来'
  }
  const overlays = document.querySelectorAll(
    '[class*="dialog"], [class*="modal"], [class*="toast"], [class*="dialog-box"], [class*="limit"], [class*="tip"], .dialog-con',
  )
  for (const el of overlays) {
    const t = (el as HTMLElement).innerText || ''
    if (markers.some((m) => t.includes(m)) || check(t)) {
      return '今日沟通已达上限，已自动停止，请明天再来'
    }
  }
  return null
}

export function scanRisk(): RiskSignal | null {
  if (detectBlock()) {
    const signal: RiskSignal = {
      type: 'block',
      message: '检测到账号异常，已自动暂停操作',
      detectedAt: new Date().toISOString(),
    }
    riskSignals.push(signal)
    return signal
  }

  // Daily communication cap is a hard stop — same severity as a block.
  const dailyLimit = detectDailyCommunicationLimit()
  if (dailyLimit) {
    const signal: RiskSignal = {
      type: 'block',
      message: dailyLimit,
      detectedAt: new Date().toISOString(),
    }
    riskSignals.push(signal)
    return signal
  }

  if (detectRateLimit()) {
    const signal: RiskSignal = {
      type: 'rate_limit',
      message: '检测到操作频率限制，请等待一段时间后再试',
      detectedAt: new Date().toISOString(),
    }
    riskSignals.push(signal)
    return signal
  }

  if (detectCaptcha()) {
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
