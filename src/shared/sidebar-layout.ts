/**
 * 挤压式侧栏布局（push layout）—— 让网页内容把右侧宽度让出来，而不是被浮层盖住。
 *
 * 背景：`src/content/inject-ui.tsx` 的侧栏是一个 `position: fixed` + `z-index: 99999`
 * 的浮层，脱离文档流，宿主页面完全感知不到它，所以右侧岗位卡片会被遮住。
 * 用户问「为什么别人的侧边栏是直接把内容顶过去左边的」，答案是别人要么用
 * Chrome 原生 Side Panel（浏览器自动收窄视口），要么往宿主页面注入 CSS 挤压。
 *
 * 这里走注入 CSS 的增量路线，并刻意保留浮层本体不动：
 *  - 默认关闭，5 个招聘站零影响；用户自己打开开关才生效；
 *  - 只在侧栏 `expanded`、用户没停机、视口够宽时挤压；收起 / 浮球 / 关闭立刻撤销，
 *    不会留下一条 456px 的空白；
 *  - 用 html 的 `padding-right + border-box` 让 body 自然收窄，不改宿主 DOM 结构、
 *    不改元素坐标，bot 点岗位卡片 / 读 DOM 的链路完全不变；
 *  - SPA 会重写 html class 或清掉注入的 style，用 MutationObserver 幂等补回。
 *
 * 已知边界（不藏着）：宿主页面自己的 `position: fixed` 顶栏 / 右侧悬浮客服不受
 * html margin 影响，仍可能与侧栏重叠；用 `100vw` 的组件也按视口算宽度。
 * 逐平台验证后再考虑是否给这几类元素做定点兼容。
 */
import { getSetting, setSetting } from './db/settings-store'

export const PUSH_LAYOUT_KEY = 'sidebarPushLayout'
export const PUSH_LAYOUT_DEFAULT = false
export const PUSH_LAYOUT_STYLE_ID = 'boss-assistant-push-layout'
export const PUSH_LAYOUT_HTML_CLASS = 'boss-assistant-push'

/** 与 inject-ui.tsx 的 SIDEBAR_WIDTH / VIEWPORT_MARGIN 保持一致 */
export const SIDEBAR_WIDTH_PX = 440
export const SIDEBAR_VIEWPORT_MARGIN_PX = 8
/** 让出的宽度 = 侧栏宽 + 左右各留一点间隙，避免内容贴死侧栏边缘 */
export const PUSH_RESERVED_PX = SIDEBAR_WIDTH_PX + SIDEBAR_VIEWPORT_MARGIN_PX * 2

/** 视口太窄时挤压会把岗位列表压成一条，直接退回浮层 */
export const PUSH_MIN_VIEWPORT_PX = 1180

/** 注入到宿主页面的样式。纯函数，便于单测逐条断言。 */
export function buildPushLayoutCss(reservedPx: number): string {
  const w = Math.max(0, Math.round(reservedPx))
  // 用 padding 而不是 margin：html 盒子仍是整个视口宽，只是内容区收窄，
  // 页面里 `width: 100vw` 的组件不会撑出横向滚动条；fixed 定位仍相对视口，
  // 侧栏与站点自己的悬浮元素都不受影响。
  return `
html.${PUSH_LAYOUT_HTML_CLASS} {
  box-sizing: border-box !important;
  padding-right: ${w}px !important;
}
html.${PUSH_LAYOUT_HTML_CLASS} body {
  width: auto !important;
  max-width: 100% !important;
  min-width: 0 !important;
}
@media (max-width: ${PUSH_MIN_VIEWPORT_PX - 1}px) {
  html.${PUSH_LAYOUT_HTML_CLASS} {
    padding-right: 0 !important;
  }
}
`.trim()
}

export interface PushLayoutContext {
  /** 用户是否打开了挤压模式 */
  enabled: boolean
  /** 当前面板形态：只有真正展开的整高侧栏才占住右侧宽度 */
  panelState: string
  /** 用户已关闭 AIbot 时不挤压（上一轮停机总闸的语义） */
  userStopped: boolean
  viewportWidth: number
}

/** 是否真的应该挤压。纯函数：收起 / 浮球 / 关闭 / 停机 / 窄屏一律退回浮层。 */
export function shouldApplyPushLayout(ctx: PushLayoutContext): boolean {
  if (!ctx.enabled || ctx.userStopped) return false
  if (ctx.panelState !== 'expanded') return false
  if (ctx.viewportWidth < PUSH_MIN_VIEWPORT_PX) return false
  return true
}

export async function readPushLayoutSetting(): Promise<boolean> {
  return (await getSetting<boolean>(PUSH_LAYOUT_KEY, PUSH_LAYOUT_DEFAULT)) === true
}

export async function writePushLayoutSetting(enabled: boolean): Promise<void> {
  await setSetting(PUSH_LAYOUT_KEY, enabled)
}

/** 跨标签页同步开关；返回取消订阅函数 */
export function subscribePushLayout(listener: (enabled: boolean) => void): () => void {
  try {
    if (typeof chrome === 'undefined' || !chrome.storage?.onChanged) return () => {}
    const watched = `setting_${PUSH_LAYOUT_KEY}`
    const handler = (
      changes: Record<string, chrome.storage.StorageChange>,
      areaName: string,
    ) => {
      if (areaName !== 'local' || !changes[watched]) return
      readPushLayoutSetting().then(listener).catch(() => {})
    }
    chrome.storage.onChanged.addListener(handler)
    return () => chrome.storage.onChanged.removeListener(handler)
  } catch {
    return () => {}
  }
}

let desired = false
let observer: MutationObserver | null = null

function syncDom(): void {
  if (!desired || typeof document === 'undefined') return
  const root = document.documentElement
  if (!root) return
  if (!root.classList.contains(PUSH_LAYOUT_HTML_CLASS)) {
    root.classList.add(PUSH_LAYOUT_HTML_CLASS)
  }
  if (!document.getElementById(PUSH_LAYOUT_STYLE_ID)) {
    const style = document.createElement('style')
    style.id = PUSH_LAYOUT_STYLE_ID
    style.textContent = buildPushLayoutCss(PUSH_RESERVED_PX)
    ;(document.head || root).appendChild(style)
  }
}

function stopObserver(): void {
  if (observer) {
    observer.disconnect()
    observer = null
  }
}

/** 幂等地开启 / 关闭挤压。关闭时必须把 class 与 style 一起清干净。 */
export function applyPushLayout(active: boolean): void {
  desired = active
  if (!active || typeof document === 'undefined') {
    stopObserver()
    document.documentElement?.classList.remove(PUSH_LAYOUT_HTML_CLASS)
    document.getElementById(PUSH_LAYOUT_STYLE_ID)?.remove()
    return
  }
  syncDom()
  if (!observer && typeof MutationObserver !== 'undefined') {
    observer = new MutationObserver(() => syncDom())
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    })
    if (document.head) observer.observe(document.head, { childList: true })
  }
}

export function isPushLayoutActive(): boolean {
  return desired
}
