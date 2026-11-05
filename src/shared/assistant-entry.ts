/**
 * 插件图标 / 管理后台「返回助手」的入口决策（纯函数，便于单测）。
 *
 * 历史 bug：点击图标时只要无法注入 content script（chrome:// 页面、非招聘网站、
 * 或扩展自己的 options 页），旧逻辑就打开管理后台；而后台页 URL 是
 * chrome-extension://，仍然无法注入，于是再点图标又开一个后台页 ——
 * 用户「一点击跳到后台，到了后台回不来了」。
 *
 * 现在：**任何不可注入的场景都统一回到助手面板，绝不再跳后台**。
 */

export type AssistantEntryPlan = 'try-sidebar' | 'assistant-panel'

/** 当前标签页是否值得尝试注入右侧侧栏 */
export function canHostSidebar(url: string, extensionOrigin: string): boolean {
  if (!url) return false
  // 扩展自己的页面（options / 独立助手面板）不能注入，也不该再开后台
  if (extensionOrigin && url.startsWith(extensionOrigin)) return false
  // chrome:// / about: / edge: / file: 等受限协议不能注入
  return /^https?:/i.test(url)
}

/** 点击图标的第一步决策；try-sidebar 失败后由调用方回退到 assistant-panel */
export function planAssistantEntry(url: string, extensionOrigin: string): AssistantEntryPlan {
  return canHostSidebar(url, extensionOrigin) ? 'try-sidebar' : 'assistant-panel'
}

export interface AssistantEntryDeps {
  /** 尝试在当前标签页切换/展开侧栏，返回是否成功 */
  tryToggleSidebar: () => Promise<boolean>
  /** 复用或新建独立助手面板标签页 */
  openAssistantPanel: () => Promise<void>
}

/**
 * 点击图标的完整编排：能注入就展开侧栏；不能注入（含注入失败、扩展自身页面、
 * chrome:// 受限页）一律回到助手面板。依赖里故意不提供「打开后台」选项，
 * 从签名上杜绝再次把用户困在管理后台。
 */
export async function runAssistantEntry(
  url: string,
  extensionOrigin: string,
  deps: AssistantEntryDeps,
): Promise<'sidebar' | 'assistant-panel'> {
  if (planAssistantEntry(url, extensionOrigin) === 'try-sidebar') {
    if (await deps.tryToggleSidebar()) return 'sidebar'
  }
  await deps.openAssistantPanel()
  return 'assistant-panel'
}

export interface TabLike {
  id?: number
  url?: string
}

/** 在标签页列表里找已打开的招聘网站页面（用于「返回助手侧栏」时复用） */
export function findJobSiteTabId(
  tabs: TabLike[],
  isJobSite: (url: string) => boolean,
): number | null {
  for (const tab of tabs) {
    if (tab.id !== undefined && tab.url && isJobSite(tab.url)) return tab.id
  }
  return null
}

/** 找已打开的独立助手面板标签页，避免反复点击图标开出一大堆标签 */
export function findAssistantTabId(tabs: TabLike[], panelUrl: string): number | null {
  for (const tab of tabs) {
    if (tab.id !== undefined && tab.url?.startsWith(panelUrl)) return tab.id
  }
  return null
}
