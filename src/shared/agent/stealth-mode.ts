/**
 * AIbot 后台静默运行：不抢标签页、不抢窗口焦点、不导航用户正在看的页面。
 *
 * 历史 bug：`ensurePlatformTab()` 每个投递任务 / 每轮采集都执行
 * `chrome.tabs.update({active:true})` + `chrome.windows.update({focused:true})`，
 * 还会优先复用「当前活跃标签页」并导航到搜索 URL。结果是用户切到别的软件、
 * 或在别的标签页下滑，都会被强行拉回招聘网站页面，完全没法做别的事。
 *
 * 现在默认使用「专用后台标签页」：AIbot 只在那个非活跃 tab 里采集和投递，
 * 用户当前页面永远不动。前台可见模式作为兼容开关保留（后台 tab 被浏览器
 * 节流导致采不到岗位时可打开）。
 */

/** 设置键；true = 允许抢焦点（旧行为），默认 false = 后台静默 */
export const FOREGROUND_MODE_KEY = 'aibotForegroundMode'

/** 默认值：AIbot 一律后台静默，绝不抢焦点 */
export const DEFAULT_FOREGROUND_MODE = false

/** 记录每个平台的专用后台 tab，避免每轮新建一堆标签页 */
export const DEDICATED_TABS_KEY = 'aibot_dedicated_tabs'

export interface TabLike {
  id?: number
  url?: string
}

/**
 * 活跃标签页可能是多个（用户开了多个 Chrome 窗口，每个窗口各有一个 active tab）。
 * 静默模式下这些 tab 全都不能碰，否则虽不聚焦窗口，仍会把用户正在看的页面导航掉。
 */
export type ActiveTabIds = number | number[] | undefined | null

function toActiveIdSet(activeTabIds: ActiveTabIds): Set<number> {
  const ids = Array.isArray(activeTabIds)
    ? activeTabIds
    : activeTabIds == null
      ? []
      : [activeTabIds]
  return new Set(ids.filter((id): id is number => typeof id === 'number'))
}

export interface EnsureTabOptions {
  /** 显式指定是否激活标签页；不传则跟随前台可见模式设置 */
  activate?: boolean
}

/** 显式参数优先，否则由设置决定 */
export function shouldActivateTab(
  foregroundMode: boolean,
  opts?: EnsureTabOptions,
): boolean {
  return opts?.activate ?? foregroundMode
}

/**
 * 在静默模式下挑一个可以安全操作的后台标签页。
 * 绝不返回任何窗口的活跃标签页，避免导航 / 抢焦点打扰用户。
 */
export function pickStealthTab<T extends TabLike>(
  tabs: T[],
  activeTabIds: ActiveTabIds,
  matches: (url: string) => boolean,
  dedicatedTabId?: number | null,
): T | undefined {
  const protectedIds = toActiveIdSet(activeTabIds)
  const isUsable = (t: T): boolean =>
    !!t.id &&
    !protectedIds.has(t.id) &&
    !!t.url &&
    matches(t.url)

  if (dedicatedTabId) {
    const dedicated = tabs.find((t) => t.id === dedicatedTabId && isUsable(t))
    if (dedicated) return dedicated
  }
  return tabs.find(isUsable)
}

/** 判断某个 tab 是否会被静默模式保护（用于单测与调用链自检） */
export function isProtectedTab(tabId: number | undefined, activeTabIds: ActiveTabIds): boolean {
  if (!tabId) return false
  return toActiveIdSet(activeTabIds).has(tabId)
}

/** 前台模式：优先当前活跃标签页，其次任意该平台标签页 */
export function pickForegroundTab<T extends TabLike>(
  tabs: T[],
  activeTabId: number | undefined,
  matches: (url: string) => boolean,
): T | undefined {
  const active = tabs.find((t) => t.id === activeTabId && !!t.url && matches(t.url))
  if (active) return active
  return tabs.find((t) => !!t.id && !!t.url && matches(t.url))
}
