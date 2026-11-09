// 跨平台标签页管理器（复用、自动打开、页面加载握手与健康检查）

import { getPlatformById } from '../shared/platform'
import type { PlatformId } from '../shared/agent/quota'
import { getSetting } from '../shared/db/settings-store'
import {
  DEDICATED_TABS_KEY,
  DEFAULT_FOREGROUND_MODE,
  FOREGROUND_MODE_KEY,
  pickForegroundTab,
  pickStealthTab,
  shouldActivateTab,
  type EnsureTabOptions,
} from '../shared/agent/stealth-mode'
import { log, logWarn, logError } from '../shared/utils/logger'

const MOD = 'TabManager'

// 平台默认工作台 / 推荐页 / 搜索页入口
const PLATFORM_HOME_URLS: Record<PlatformId, string> = {
  boss: 'https://www.zhipin.com/web/geek/job-recommend',
  liepin: 'https://www.liepin.com/zhaopin/',
  zhaopin: 'https://sou.zhaopin.com/',
  '51job': 'https://we.51job.com/pc/search',
  maimai: 'https://maimai.cn/jobs',
}

/** 构造带有目标职业检索词与页码的精准搜索页面 URL */
export function getPlatformSearchUrl(platform: PlatformId, query?: string, page = 1): string {
  if (!query || !query.trim()) {
    return PLATFORM_HOME_URLS[platform] || 'https://www.zhipin.com/web/geek/job-recommend'
  }
  const q = encodeURIComponent(query.trim())
  const pageParam = page > 1 ? page : 0
  switch (platform) {
    case 'boss':
      return `https://www.zhipin.com/web/geek/job?query=${q}${pageParam ? `&page=${pageParam}` : ''}`
    case 'liepin':
      return `https://www.liepin.com/zhaopin/?key=${q}${pageParam ? `&currentPage=${pageParam}` : ''}`
    case 'zhaopin':
      return `https://sou.zhaopin.com/?kw=${q}${pageParam ? `&p=${pageParam}` : ''}`
    case '51job':
      return `https://we.51job.com/pc/search?keyword=${q}${pageParam ? `&pageNum=${pageParam}` : ''}`
    case 'maimai':
      // 旧版忽略 query，脉脉永远停在推荐流，采回来的全是无关岗位
      return `https://maimai.cn/jobs?query=${q}${pageParam ? `&page=${pageParam}` : ''}`
    default:
      return PLATFORM_HOME_URLS[platform]
  }
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** 平台登录页地址（用于登录失效时自动引导，省得用户到处找入口） */
const PLATFORM_LOGIN_PAGE: Record<PlatformId, string> = {
  boss: 'https://www.zhipin.com/web/user/?ka=header-login',
  liepin: 'https://passport.liepin.com/account/login',
  zhaopin: 'https://passport.zhaopin.com/login',
  '51job': 'https://login.51job.com/login.php',
  maimai: 'https://maimai.cn/login',
}

/** 是否打开「前台可见模式」（默认关闭，AIbot 后台静默运行） */
export async function isForegroundMode(): Promise<boolean> {
  try {
    return (await getSetting<boolean>(FOREGROUND_MODE_KEY, DEFAULT_FOREGROUND_MODE)) === true
  } catch {
    return DEFAULT_FOREGROUND_MODE
  }
}

/** 读取该平台的专用后台标签页 id */
async function getDedicatedTabId(platform: PlatformId): Promise<number | null> {
  try {
    const res = await chrome.storage.local.get(DEDICATED_TABS_KEY)
    const map = (res?.[DEDICATED_TABS_KEY] || {}) as Record<string, number>
    const id = map[platform]
    return typeof id === 'number' ? id : null
  } catch {
    return null
  }
}

/** 记住专用后台标签页，避免每轮采集都新建标签页 */
async function rememberDedicatedTab(platform: PlatformId, tabId: number): Promise<void> {
  try {
    const res = await chrome.storage.local.get(DEDICATED_TABS_KEY)
    const map = (res?.[DEDICATED_TABS_KEY] || {}) as Record<string, number>
    await chrome.storage.local.set({
      [DEDICATED_TABS_KEY]: { ...map, [platform]: tabId },
    })
  } catch {
    // 记不住就下轮重新挑一个，不影响业务
  }
}

/**
 * 打开平台登录页。
 * 仅在检测到登录失效时拉起一次；静默模式下以后台标签页打开 + 通知提醒，
 * 不把整个 Chrome 窗口抢回前台打断用户手上的事。
 */
export async function openPlatformLoginTab(platform: PlatformId): Promise<boolean> {
  const url = PLATFORM_LOGIN_PAGE[platform]
  if (!url) return false
  const foreground = await isForegroundMode()
  try {
    const allTabs = await chrome.tabs.query({})
    const existing = allTabs.find((t) => t.url && t.url.startsWith(url.split('?')[0]))
    if (existing?.id) {
      if (foreground) {
        await chrome.tabs.update(existing.id, { active: true })
        if (existing.windowId) await chrome.windows.update(existing.windowId, { focused: true })
      }
      return true
    }
    await chrome.tabs.create({ url, active: foreground })
    return true
  } catch (err) {
    logWarn(MOD, 'openPlatformLoginTab', `Failed to open login page for ${platform}: ${String(err)}`)
    return false
  }
}

/**
 * 终止 AIbot 时回收专用后台标签页。
 * 只关「仍是非活跃」的专用页；一旦用户点开了那个标签页，就把它交还给用户，绝不替他关掉。
 */
export async function releaseDedicatedTabs(): Promise<number> {
  try {
    const res = await chrome.storage.local.get(DEDICATED_TABS_KEY)
    const map = (res?.[DEDICATED_TABS_KEY] || {}) as Record<string, number>
    const ids = Array.from(new Set(Object.values(map).filter((id) => typeof id === 'number')))
    if (ids.length === 0) return 0

    const activeTabs = await chrome.tabs.query({ active: true })
    const protectedIds = new Set(
      activeTabs.map((t) => t.id).filter((id): id is number => typeof id === 'number'),
    )
    const closable = ids.filter((id) => !protectedIds.has(id))
    if (closable.length > 0) {
      try {
        await chrome.tabs.remove(closable)
      } catch {
        // 某些标签页可能已被用户关掉，忽略即可
      }
    }
    await chrome.storage.local.remove(DEDICATED_TABS_KEY)
    return closable.length
  } catch {
    return 0
  }
}

/** 等待 Tab 达到 complete 状态 */
async function waitForTabLoaded(tabId: number, timeoutMs = 20_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const tab = await chrome.tabs.get(tabId)
      if (tab.status === 'complete') return true
    } catch {
      return false
    }
    await wait(300)
  }
  return false
}

/**
 * 导航后等「URL 真的变成目标页」且 status=complete。
 *
 * 旧版只看 status 有个真实竞态：`chrome.tabs.update({url})` 是异步的，紧接着查询时
 * tab 可能还停在旧页面、且旧页面 status 恰好是 'complete'，于是等待瞬间返回，
 * 任务被下发到旧页面。现场表现就是后台 tab 停在 applysuccess.php 投递成功页，
 * 执行器却在那儿找岗位卡片 → 0 张 → 失败 → 清空队列自愈。
 *
 * 只比 origin + pathname：51job 等 SPA 会自行改写 query，不能用整串 URL 比对。
 */
async function waitForTabNavigation(
  tabId: number,
  targetUrl: string,
  timeoutMs = 25_000,
): Promise<boolean> {
  let expected = ''
  try {
    const u = new URL(targetUrl)
    expected = `${u.origin}${u.pathname}`
  } catch {
    expected = targetUrl.split('?')[0]
  }
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const tab = await chrome.tabs.get(tabId)
      const current = tab.url || tab.pendingUrl || ''
      if (current.startsWith(expected) && tab.status === 'complete') return true
    } catch {
      return false
    }
    await wait(300)
  }
  return false
}

/**
 * URL 是否落在「能定位岗位卡片」的列表页。
 *
 * `isOnTargetSearchUrl()` 只比对关键词与页码，整页导航到详情页 / 公司页后
 * 仍可能返回 true（尤其 query 为空时只比页码）。51job 点岗位链接是整页跳转，
 * 上一个任务结束后专用后台 tab 就停在那里，下一个任务再执行必然找不到卡片。
 * 执行任务前用它复核，非列表页一律导航回搜索页。
 */
export function isPlatformListPageUrl(platform: PlatformId, url?: string | null): boolean {
  if (!url) return false
  if (/login|passport|signin/i.test(url)) return false
  switch (platform) {
    case '51job':
      // jobs.51job.com 下是公司页 / 岗位详情页 / 城市聚合页，都没有可激活的列表卡片；
      // 只有 we.51job.com 搜索页与 search.51job.com 是列表页。
      if (/jobs\.51job\.com/i.test(url)) return false
      return /we\.51job\.com|search\.51job\.com|51job\.com\/jobs/i.test(url)
    case 'boss':
      return !/\/job_detail\/|\/web\/chat\/|\/user\//i.test(url)
    case 'liepin':
      return !/\/job\/\d+|\/a\/\d+|\/chat\//i.test(url)
    case 'zhaopin':
      return !/\/job\/\d+|position\.html/i.test(url)
    case 'maimai':
      return !/\/jobdetail\/|\/im\//i.test(url)
    default:
      return true
  }
}

/** 标签页是否已经停留在本次目标关键词/页码的搜索页（避免重复导航刷新；导出以便单测） */
export function isOnTargetSearchUrl(url: string | undefined, query?: string, page = 1): boolean {
  if (!url) return false
  if (query && query.trim()) {
    const q = query.trim()
    try {
      if (!url.includes(encodeURIComponent(q)) && !decodeURIComponent(url).includes(q)) return false
    } catch {
      if (!url.includes(encodeURIComponent(q))) return false
    }
  }
  const matched = url.match(/[?&](?:page|currentPage|pageNum|p)=(\d+)/)
  const currentPage = matched ? parseInt(matched[1], 10) : 1
  return currentPage === Math.max(1, page)
}

/**
 * 确保目标平台有可用的标签页。
 *
 * 默认「后台静默」：只在专用后台标签页里采集 / 投递，
 * **不激活标签页、不聚焦窗口、不导航用户当前正在看的页面**。
 * 旧版每个任务都 `tabs.update(active:true)` + `windows.update(focused:true)`，
 * 用户切到别的软件或在别的标签页下滑都会被硬拉回来。
 *
 * 打开「前台可见模式」后恢复旧行为（用于后台标签页被浏览器节流、采不到岗位时）。
 */
export async function ensurePlatformTab(
  platform: PlatformId,
  query?: string,
  page = 1,
  opts: EnsureTabOptions = {},
): Promise<chrome.tabs.Tab | null> {
  const adapter = getPlatformById(platform)
  if (!adapter) {
    logError(MOD, 'ensurePlatformTab', `Unknown platform: ${platform}`)
    return null
  }

  const foreground = shouldActivateTab(await isForegroundMode(), opts)
  const matches = (url: string) => adapter.matchesUrl(url)

  let activeTabId: number | undefined
  let protectedTabIds: number[] = []
  let allTabs: chrome.tabs.Tab[] = []
  try {
    const [currentActive] = await chrome.tabs.query({ active: true, currentWindow: true })
    activeTabId = currentActive?.id
    // 至少把当前窗口的活跃页保护起来，后续查询失败也不会误挑到它
    if (activeTabId) protectedTabIds = [activeTabId]
    // 每个 Chrome 窗口各有一个 active tab，全部排除；否则会把另一个窗口里
    // 用户正在看的招聘网站页面导航到搜索 URL。
    try {
      const activeInEveryWindow = await chrome.tabs.query({ active: true })
      protectedTabIds = Array.from(
        new Set([
          ...protectedTabIds,
          ...activeInEveryWindow
            .map((t) => t.id)
            .filter((id): id is number => typeof id === 'number'),
        ]),
      )
    } catch {
      // 退化为只保护当前窗口活跃页
    }
    allTabs = await chrome.tabs.query({})
  } catch {
    // 查询失败时按「没有可用 tab」处理，走下面新建分支
  }

  const dedicatedTabId = foreground ? null : await getDedicatedTabId(platform)
  const reusable = foreground
    ? pickForegroundTab(allTabs, activeTabId, matches)
    : pickStealthTab(allTabs, protectedTabIds, matches, dedicatedTabId)

  // 2. 复用标签页：必要时导航到本次目标关键词搜索页，并确保 content script 已就绪
  if (reusable?.id) {
    const tabId = reusable.id
    log(MOD, 'ensurePlatformTab', `Reusing ${foreground ? 'foreground' : 'background'} tab for ${platform}: id=${tabId}, url=${reusable.url}`)

    if (foreground) {
      try {
        await chrome.tabs.update(tabId, { active: true })
        if (reusable.windowId) await chrome.windows.update(reusable.windowId, { focused: true })
      } catch {
        // 忽略激活异常
      }
    } else {
      await rememberDedicatedTab(platform, tabId)
    }

    // 停留在首页 / 上一轮关键词 / 上一页时，导航到本次目标搜索页，否则会一直解析同一批旧卡片。
    // 静默模式下 reusable 已排除用户当前活跃页，所以这里的导航不会改掉用户正在看的内容。
    const hasTarget = Boolean(query && query.trim()) || page > 1
    // 执行投递（requireListPage）时，即使关键词/页码都对，只要页面已经整页跳到
    // 详情页 / 公司页也必须导航回列表页，否则执行器拿不到任何岗位卡片。
    const offListPage = opts.requireListPage === true && !isPlatformListPageUrl(platform, reusable.url)
    if ((hasTarget && !isOnTargetSearchUrl(reusable.url, query, page)) || offListPage) {
      const targetUrl = getPlatformSearchUrl(platform, query, page)
      log(MOD, 'ensurePlatformTab', `Navigating reused tab to target search url: ${targetUrl}`)
      try {
        await chrome.tabs.update(tabId, { url: targetUrl })
        const loaded = await waitForTabNavigation(tabId, targetUrl, 25_000)
        // 页面完成加载后再留一点时间给 content script 注入与首屏卡片渲染；
        // SPA 的岗位列表可能更晚才出，由 content 侧 waitForJobListReady() 兜底。
        await wait(loaded ? 1200 : 2000)
      } catch (err) {
        logWarn(MOD, 'ensurePlatformTab', `Navigate failed for ${platform}: ${String(err)}`)
      }
    } else if (reusable.status !== 'complete') {
      // 复用但仍在加载：等它完成，避免消息发送时 content script 还没挂上
      await waitForTabLoaded(tabId, 15_000)
    }

    return reusable
  }

  // 3. 没有安全的后台 Tab，新建一个**非激活**的专用标签页
  const targetUrl = getPlatformSearchUrl(platform, query, page) || PLATFORM_HOME_URLS[platform] || adapter.homeUrl
  log(MOD, 'ensurePlatformTab', `Creating ${foreground ? 'foreground' : 'background'} tab for ${platform}: ${targetUrl}`)

  try {
    const created = await chrome.tabs.create({
      url: targetUrl,
      // 静默模式后台打开；content script 在非活跃标签页同样会注入并响应消息，
      // 采集与 DOM 交互都不需要抢用户焦点。
      active: foreground,
    })

    if (!created.id) return null
    if (!foreground) await rememberDedicatedTab(platform, created.id)

    // 等待页面初次加载完成
    const loaded = await waitForTabLoaded(created.id, 20_000)
    // 稍微等待 content scripts 注入并完成挂载
    await wait(loaded ? 1500 : 2500)

    return created
  } catch (err) {
    logError(MOD, 'ensurePlatformTab', err, `Failed to create tab for ${platform}`)
    return null
  }
}

/**
 * 是不是「扩展重载导致 content script 失联」。
 *
 * 现场日志：
 *   ❌ 任务执行通信异常: Error: Could not establish connection. Receiving end does not exist.
 *   ⚠️ 【猎聘】自动扫描通信异常: Error: Could not establish connection. Receiving end does not exist.
 *
 * 用户在 chrome://extensions 重新加载扩展后，已打开页面里旧 content script 的
 * extension context 会被 Chrome 置为 invalidated，消息端口被拆除，但页面本身完好。
 * DEDICATED_TABS_KEY 存在 chrome.storage.local 里、重载不清，于是 ensurePlatformTab()
 * 仍会复用这个 status=complete、URL 也对的「僵死」tab，直接发消息就抛上面那句。
 *
 * 注意：这跟「页面没加载完 / 平台改版」是完全不同的故障，后者靠注入兜底，前者必须 reload。
 */
export function isStaleConnectionError(err: unknown): boolean {
  const text = String(err instanceof Error ? err.message : err ?? '')
  return /could not establish connection|receiving end does not exist|extension context invalidated|message port closed/i.test(
    text,
  )
}

/** 只有「非活跃 + 五大招聘站」的专用后台 tab 允许 reload，绝不碰用户正在看的页面 */
const JOB_SITE_HOST_RE = /(?:^|\.)(zhipin\.com|liepin\.com|51job\.com|zhaopin\.com|maimai\.cn)$/i

export function shouldReloadStaleTab(
  tab: { active?: boolean; url?: string } | null | undefined,
): boolean {
  if (!tab || tab.active === true) return false
  const url = tab.url || ''
  if (!/^https?:\/\//i.test(url)) return false
  try {
    return JOB_SITE_HOST_RE.test(new URL(url).hostname)
  } catch {
    return false
  }
}

/**
 * reload 一个僵死的后台 tab，让 MV3 按 manifest 全新注入 content script。
 *
 * 为什么不能只靠 chrome.scripting.executeScript 再注入一次：构建产物里的
 * content script 是动态 import loader：
 *   await import(chrome.runtime.getURL("assets/index.ts-XXXX.js"))
 * 同一个 isolated world 里同一模块 URL 已被 import 过，ES module 缓存让模块体
 * 不会二次执行，模块顶层的 chrome.runtime.onMessage.addListener 自然也不会重新注册。
 * 注入多少次都救不回来 —— 只有 reload 才会重建 isolated world 与模块缓存。
 */
async function reloadStaleTab(tabId: number): Promise<boolean> {
  try {
    const tab = await chrome.tabs.get(tabId)
    if (!shouldReloadStaleTab(tab)) {
      logWarn(
        MOD,
        'reloadStaleTab',
        `Skip reload for tab ${tabId}: it is the user's active tab or not a job site — ask for a manual refresh instead`,
      )
      return false
    }
    await chrome.tabs.reload(tabId)
    // reload 是异步的，返回瞬间 tab.status 往往还是旧页面的 'complete'，
    // 先留一个短窗口让导航真正开始，再等 complete，避免「假 complete」。
    await wait(400)
    const loaded = await waitForTabLoaded(tabId, 20_000)
    // document_end 注入 → 动态 import → onMessage 注册 → SPA 首屏卡片渲染
    await wait(loaded ? 1500 : 2500)
    return loaded
  } catch (err) {
    logWarn(MOD, 'reloadStaleTab', `Failed to reload tab ${tabId}: ${String(err)}`)
    return false
  }
}

/**
 * 扩展重载 / 浏览器启动时，主动复活存量的专用后台 tab。
 *
 * 不这样做的话，要等第一次采集或投递真的失败一次才触发自愈，用户会先在日志里
 * 看到一轮「通信异常」。这里在恢复调度之前先把它们刷新好。
 * 只处理非活跃、五大招聘站的 tab；用户正在看的页面一律不动。
 */
export async function reviveDedicatedTabs(): Promise<number> {
  let ids: number[] = []
  try {
    const res = await chrome.storage.local.get(DEDICATED_TABS_KEY)
    const map = (res?.[DEDICATED_TABS_KEY] || {}) as Record<string, number>
    ids = Array.from(new Set(Object.values(map).filter((id) => typeof id === 'number')))
  } catch {
    return 0
  }
  if (ids.length === 0) return 0

  const targets: number[] = []
  for (const id of ids) {
    try {
      const tab = await chrome.tabs.get(id)
      if (shouldReloadStaleTab(tab)) targets.push(id)
    } catch {
      // tab 已被用户关掉，忽略
    }
  }
  if (targets.length === 0) return 0

  await Promise.all(
    targets.map(async (id) => {
      try {
        await chrome.tabs.reload(id)
      } catch {
        // 单页刷新失败不影响其它平台
      }
    }),
  )
  await wait(500)
  await Promise.all(targets.map((id) => waitForTabLoaded(id, 15_000)))
  await wait(1200)
  log(MOD, 'reviveDedicatedTabs', `Reloaded ${targets.length} dedicated tab(s) after extension restart`)
  return targets.length
}

/**
 * 向 Tab 发送消息，带 Content Script 注入恢复、僵死页面 reload 自愈与重试机制。
 */
export async function sendTabMessageWithRetry<T = unknown>(
  tabId: number,
  message: unknown,
  maxAttempts = 5,
): Promise<T> {
  let lastError: unknown
  // 每次调用最多 reload 一次，避免页面本身有问题时陷入无限刷新
  let revived = false
  // 记录自愈的真实结果，最终抛错时如实附加，供上层行为日志展示
  let reviveOutcome: 'none' | 'reloaded' | 'skipped' = 'none'

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const response = await chrome.tabs.sendMessage(tabId, message)
      return response as T
    } catch (err) {
      lastError = err
      const stale = isStaleConnectionError(err)
      logWarn(
        MOD,
        'sendTabMessageWithRetry',
        `Attempt ${attempt + 1}/${maxAttempts} failed${stale ? ' (stale content script)' : ''}: ${String(err)}`,
      )

      // 扩展重载后的僵死 context：重复注入 loader 无效，直接 reload 复活。
      // 成功后立刻重试发消息，不消耗无意义的退避等待。
      if (stale && !revived) {
        revived = true
        if (await reloadStaleTab(tabId)) {
          reviveOutcome = 'reloaded'
          log(MOD, 'sendTabMessageWithRetry', `Revived stale content script on tab ${tabId}`)
          continue
        }
        // 活跃页 / 非招聘站不能替用户刷新。记下真实结果，最终抛错时附加，
        // 上层日志才不会谎报「已自动刷新」，用户也才知道该手动刷一次页面。
        reviveOutcome = 'skipped'
      }

      // 页面尚未加载完成时注入必然失败，先等它 complete 再兜底注入
      try {
        await waitForTabLoaded(tabId, 8_000)
      } catch {
        // 忽略等待失败
      }

      // 非僵死场景（新 tab 首屏还没注入完）仍保留主动注入兜底
      try {
        const manifest = chrome.runtime.getManifest()
        const scripts = manifest.content_scripts?.[0]?.js ?? []
        if (scripts.length > 0) {
          await chrome.scripting.executeScript({
            target: { tabId },
            files: scripts,
          })
          // loader 是动态 import 的，注入后需要给模块加载与消息监听注册留出时间
          await wait(900)
        }
      } catch {
        // 忽略注入失败，继续重试
      }

      await wait(500 * (attempt + 1))
    }
  }

  // 后续重试会把 lastError 覆盖回原始错误，所以自愈结论在这里统一附加一次。
  // 不虚构结果：刷新过就写「刷新后仍失败」，没刷成就写「请手动刷新」。
  if (reviveOutcome !== 'none' && lastError != null) {
    const suffix = reviveOutcome === 'reloaded'
      ? '（已自动刷新后台页面并重试，仍无法通信，请检查该平台是否需要重新登录）'
      : '（自动刷新未执行：该页面处于活跃状态或不是招聘站，请手动刷新此页面后继续）'
    throw new Error(`${String(lastError)}${suffix}`)
  }
  throw lastError
}
