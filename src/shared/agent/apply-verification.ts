/**
 * 投递确认层：把「点了按钮」和「平台确认收到」严格分开。
 *
 * 历史 bug：`clickApplyButton()` 返回 true 就写 done + 落盘 + 加入去重，
 * 日志输出「投递成功」，但平台聊天列表 / 投递记录里根本没有这条。
 * 自愈点击的 Tier 3（LLM 感知）/ Tier 4（本地兜底）还可能点中相似按钮，
 * 或弹窗被风控/登录态拦截，DOM 层面却依旧「点击成功」。
 * 半自动链路更宽松：连招呼语输入框没出现也照样记成功。
 *
 * 现在只有拿到平台侧的状态变化证据才允许记成功；拿不到就诚实标为
 * 「未确认」，不落盘、不去重、不计入配额，并提示用户去平台核对。
 *
 * 证据优先级：平台阻断 > 平台状态变化 > 仅点击（不算证据）。
 */

export type ApplyConfirmationLevel = 'confirmed' | 'unverified' | 'blocked'

export interface ApplyVerification {
  level: ApplyConfirmationLevel
  /** 命中的确认依据，写进日志让用户能核对 */
  signals: string[]
  /** 命中的平台阻断提示 */
  blockers: string[]
  reason: string
}

/** 平台明确表示「已经沟通 / 已经投递」的文案 */
export const CONFIRMATION_MARKERS = [
  '继续沟通', '已沟通', '沟通中', '已投递', '投递成功',
  '简历已投递', '沟通成功', '发送成功', '已发送', '打招呼成功',
  '附件简历已发送', '简历已发送', '已发起沟通',
] as const

/** 平台明确表示「这次没成」的文案，优先级高于确认信号 */
export const BLOCKING_MARKERS = [
  '请先登录', '登录已失效', '请重新登录', '登录过期', '请先登录后操作',
  '账号异常', '账号受限', '账号被封',
  '操作过于频繁', '今日沟通次数已用完', '沟通次数已达上限', '今日沟通已达上限',
  '该职位已下线', '职位已关闭', '已停止招聘', '岗位已下线',
  '请完成安全验证', '请进行安全验证', '验证失败',
] as const

function matchMarkers(texts: string[], markers: readonly string[]): string[] {
  const hits = new Set<string>()
  for (const text of texts) {
    const clean = (text || '').replace(/\s+/g, ' ').trim()
    if (!clean) continue
    for (const marker of markers) {
      if (clean.includes(marker)) hits.add(marker)
    }
  }
  return [...hits]
}

export function detectConfirmationSignals(texts: string[]): string[] {
  return matchMarkers(texts, CONFIRMATION_MARKERS)
}

export function detectBlockingSignals(texts: string[]): string[] {
  return matchMarkers(texts, BLOCKING_MARKERS)
}

/** 平台沟通页 / 聊天页 URL 特征；点击后跳过去本身就是强确认 */
export function isChatPageUrl(url: string): boolean {
  if (!url) return false
  return /\/(?:chat|im|message|messages|conversation)(?:\/|\?|#|$)/i.test(url)
    || /[?&](?:from|to)=?(?:chat|message)/i.test(url)
}

export interface ApplyAttemptEvidence {
  /** 是否点到了沟通/投递按钮。注意：点击本身不算任何确认证据 */
  clicked: boolean
  /** 是否确实出现了新的招呼语输入框并点了发送（fillGreetingMessage 的返回值） */
  greetingSent: boolean
  /** 点击前页面上已存在的可见文案（基线，用于排除「这个岗位之前就投过」的旧状态） */
  baselineTexts?: string[]
  /** 点击后、发送话术前采集的可见文案 */
  postClickTexts?: string[]
  /** 发送话术后采集的可见文案 */
  pageTexts: string[]
  /** 点击后是否出现了新的沟通窗口 / 输入框（相对点击前的 UI 快照） */
  communicationUiChanged?: boolean
  /** 点击后是否跳进了平台沟通 / 聊天页 */
  navigatedToChat?: boolean
}

/**
 * 合成最终判定。纯函数，方便用真实页面样本做回归。
 *
 * 只有「平台侧状态变化」才算证据：新增的确认文案、新的沟通窗口、
 * 发送了话术、跳到聊天页。仅仅 `clicked === true` 一律 unverified。
 */
export function decideApplyVerification(evidence: ApplyAttemptEvidence): ApplyVerification {
  if (!evidence.clicked) {
    return {
      level: 'blocked',
      signals: [],
      blockers: [],
      reason: '未找到并点击沟通/投递按钮',
    }
  }

  const observed = [...new Set([
    ...(evidence.postClickTexts ?? []),
    ...evidence.pageTexts,
  ])]

  // 阻断文案不做 baseline 过滤：登录态失效 / 风控提示即便常驻也确实意味着投递不会成立
  const blockers = detectBlockingSignals(observed)
  if (blockers.length > 0) {
    return {
      level: 'blocked',
      signals: [],
      blockers,
      reason: `平台提示「${blockers.join('、')}」，本次沟通未成立`,
    }
  }

  const baseline = new Set(evidence.baselineTexts ?? [])
  const freshTexts = observed.filter((text) => !baseline.has(text))
  const newSignals = detectConfirmationSignals(freshTexts)

  const signals: string[] = [...newSignals]
  if (evidence.navigatedToChat) signals.push('页面已进入平台沟通/聊天页')
  if (evidence.communicationUiChanged) signals.push('点击后出现新的沟通窗口/输入框')
  if (evidence.greetingSent) signals.push('已在新的招呼语窗口中填入话术并点击发送')

  const hasPlatformEvidence =
    newSignals.length > 0 ||
    !!evidence.navigatedToChat ||
    !!evidence.communicationUiChanged ||
    !!evidence.greetingSent

  if (!hasPlatformEvidence) {
    return {
      level: 'unverified',
      signals: [],
      blockers: [],
      reason: '已点击按钮，但页面没有任何平台确认（未登录 / 风控拦截 / 弹窗被关 / 点错按钮都可能）。本次不计入投递数、不写投递记录、不加入去重，请到平台聊天列表核对',
    }
  }

  return {
    level: 'confirmed',
    signals,
    blockers: [],
    reason: `平台确认依据：${signals.join('、')}`,
  }
}

const BUTTON_SELECTOR = 'button, [role="button"], a.btn, a[class*="btn"]'
const NOTICE_SELECTOR = [
  '[role="alert"]',
  '[class*="toast"]',
  '[class*="notice"]',
  '[class*="message"]',
  '[class*="dialog"]',
  '[class*="popover"]',
  '[class*="tip"]',
].join(', ')

/** 只排除「明确隐藏」的节点；用尺寸判断在 jsdom / 阴影 DOM 里会误伤可见元素 */
function isHiddenElement(el: HTMLElement): boolean {
  if (el.hasAttribute('hidden') || el.getAttribute('aria-hidden') === 'true') return true
  if (el.closest('[hidden], [aria-hidden="true"]')) return true
  try {
    const style = typeof window !== 'undefined' && window.getComputedStyle
      ? window.getComputedStyle(el)
      : null
    if (style && (style.display === 'none' || style.visibility === 'hidden')) return true
  } catch {
    // 拿不到 computed style 时按可见处理，交由 baseline 对比兜底
  }
  return false
}

function visibleTexts(root: ParentNode, selector: string, maxLength = 100): string[] {
  const out: string[] = []
  let nodes: Element[]
  try {
    nodes = Array.from(root.querySelectorAll(selector))
  } catch {
    return out
  }
  for (const node of nodes) {
    const el = node as HTMLElement
    if (isHiddenElement(el)) continue
    const text = (el.textContent || '').replace(/\s+/g, ' ').trim()
    if (!text || text.length > maxLength) continue
    out.push(text)
  }
  return out
}

/**
 * 采集点击前后页面上的确认 / 阻断文案。
 * 岗位详情容器内优先（避免把列表里别的岗位「继续沟通」误判成当前岗位的确认），
 * 再补充全局可见的 toast / 弹窗提示。
 */
export function collectApplyPageTexts(detailRoot?: ParentNode | null): string[] {
  const texts: string[] = []
  if (detailRoot) {
    texts.push(...visibleTexts(detailRoot, BUTTON_SELECTOR))
    texts.push(...visibleTexts(detailRoot, NOTICE_SELECTOR))
  }
  if (typeof document !== 'undefined') {
    texts.push(...visibleTexts(document, NOTICE_SELECTOR))
  }
  return [...new Set(texts)]
}

/** UI 快照对比：点击后是否真的多出了沟通输入框或沟通弹窗 */
export function hasNewCommunicationUi(
  before: { inputs?: Iterable<Element>; visibleDialogs?: Iterable<Element> } | null | undefined,
  after: { inputs?: Iterable<Element>; visibleDialogs?: Iterable<Element> } | null | undefined,
): boolean {
  const countNew = (
    prev: Iterable<Element> | undefined,
    next: Iterable<Element> | undefined,
  ): number => {
    if (!next) return 0
    const known = new Set<Element>(prev ?? [])
    return [...next].filter((el) => !known.has(el)).length
  }
  return countNew(before?.inputs, after?.inputs) > 0
    || countNew(before?.visibleDialogs, after?.visibleDialogs) > 0
}
