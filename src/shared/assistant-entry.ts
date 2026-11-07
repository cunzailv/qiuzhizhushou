/**
 * 插件图标 / 管理后台「返回助手」的入口决策（纯函数，便于单测）。
 *
 * 历史 bug 1：点击图标时只要无法注入 content script，旧逻辑就打开管理后台；
 * 后台页是 chrome-extension:// 仍无法注入，再点又开一个后台页 —— 困住用户。
 * 历史 bug 2：把「独立整页面板」当成常规兜底，用户在新标签页 / 任意网页点图标时
 * 会打开一整个标签页面板，而不是期望的「招聘网站右侧整高侧栏」。
 *
 * 现在：只有招聘网站页面才在当前页注入并展开侧栏；其余场景一律去招聘网站
 * 标签页展开右侧整高侧栏。独立面板只作为两条路都失败时的最后兜底。
 */

export type AssistantEntryPlan = 'try-sidebar' | 'job-site-sidebar'
export type AssistantEntryResult = 'sidebar' | 'job-site-sidebar' | 'assistant-panel'

/** 当前标签页是否具备注入 content script 的基本条件 */
export function canHostSidebar(url: string, extensionOrigin: string): boolean {
  if (!url) return false
  // 扩展自己的页面（options / 独立助手面板）不能注入，也不该再开后台
  if (extensionOrigin && url.startsWith(extensionOrigin)) return false
  // chrome:// / about: / edge: / file: 等受限协议不能注入
  return /^https?:/i.test(url)
}

/**
 * 点击图标的第一步决策。
 * 只有「可注入 + 当前就是招聘网站」才在当前页展开侧栏；其他一律去招聘网站展开。
 * isJobSite 默认放行，便于只测协议判定的旧用例。
 */
export function planAssistantEntry(
  url: string,
  extensionOrigin: string,
  isJobSite: (url: string) => boolean = () => true,
): AssistantEntryPlan {
  return canHostSidebar(url, extensionOrigin) && isJobSite(url)
    ? 'try-sidebar'
    : 'job-site-sidebar'
}

export interface AssistantEntryDeps {
  /** 判断 URL 是否属于支持的招聘网站（决定要不要在当前页注入） */
  isJobSite: (url: string) => boolean
  /** 尝试在当前标签页切换/展开侧栏，返回是否成功 */
  tryToggleSidebar: () => Promise<boolean>
  /** 激活已有招聘网站标签页并展开侧栏；没有则新开平台首页 */
  openJobSiteSidebar: () => Promise<boolean>
  /** 最后兜底：复用或新建独立助手面板标签页 */
  openAssistantPanel: () => Promise<void>
}

/**
 * 点击图标的完整编排：
 * 1. 当前是招聘网站 → 注入并展开右侧侧栏；
 * 2. 否则 / 注入失败 → 去招聘网站标签页展开右侧侧栏；
 * 3. 两条路都失败 → 才回独立面板。
 * 依赖里故意不提供「打开后台」入口，从签名上杜绝再次把用户困在管理后台。
 */
export async function runAssistantEntry(
  url: string,
  extensionOrigin: string,
  deps: AssistantEntryDeps,
): Promise<AssistantEntryResult> {
  if (planAssistantEntry(url, extensionOrigin, deps.isJobSite) === 'try-sidebar') {
    if (await deps.tryToggleSidebar()) return 'sidebar'
  }
  if (await deps.openJobSiteSidebar()) return 'job-site-sidebar'
  await deps.openAssistantPanel()
  return 'assistant-panel'
}

/**
 * 侧栏形态决策：点图标是「展开 ⇄ 浮球」的切换，兜底路径要求「确保展开」。
 * 后者不能走 toggle —— background 已写入 expanded，再切一次反而把侧栏收成浮球。
 */
export function resolvePanelPresence(
  current: string,
  ensureExpanded: boolean,
): 'expanded' | 'bubble' {
  if (ensureExpanded) return 'expanded'
  return current === 'expanded' ? 'bubble' : 'expanded'
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
