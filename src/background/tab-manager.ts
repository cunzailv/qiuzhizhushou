// 跨平台标签页管理器（复用、自动打开、页面加载握手与健康检查）

import { getPlatformById } from '../shared/platform'
import type { PlatformId } from '../shared/agent/quota'
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

/**
 * 打开平台登录页。
 * 仅在检测到登录失效时主动拉起一次，避免用户还要自己去面板里翻“去登录”。
 */
export async function openPlatformLoginTab(platform: PlatformId): Promise<boolean> {
  const url = PLATFORM_LOGIN_PAGE[platform]
  if (!url) return false
  try {
    const allTabs = await chrome.tabs.query({})
    const existing = allTabs.find((t) => t.url && t.url.startsWith(url.split('?')[0]))
    if (existing?.id) {
      await chrome.tabs.update(existing.id, { active: true })
      if (existing.windowId) await chrome.windows.update(existing.windowId, { focused: true })
      return true
    }
    await chrome.tabs.create({ url, active: true })
    return true
  } catch (err) {
    logWarn(MOD, 'openPlatformLoginTab', `Failed to open login page for ${platform}: ${String(err)}`)
    return false
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

/** 确保目标平台有可用的标签页（优先复用已有 Tab，没有则新建） */
export async function ensurePlatformTab(
  platform: PlatformId,
  query?: string,
  page = 1,
): Promise<chrome.tabs.Tab | null> {
  const adapter = getPlatformById(platform)
  if (!adapter) {
    logError(MOD, 'ensurePlatformTab', `Unknown platform: ${platform}`)
    return null
  }

  // 1. 先找可复用的标签页（当前活跃窗口优先，其次任意窗口）
  let reusable: chrome.tabs.Tab | undefined
  try {
    const [currentActive] = await chrome.tabs.query({ active: true, currentWindow: true })
    if (currentActive?.id && currentActive.url && adapter.matchesUrl(currentActive.url)) {
      reusable = currentActive
    }
  } catch {
    // 忽略查询失败
  }

  if (!reusable) {
    const allTabs = await chrome.tabs.query({})
    reusable = allTabs.find((tab) => tab.url && adapter.matchesUrl(tab.url))
  }

  // 2. 复用标签页：必要时导航到本次目标关键词搜索页，并确保 content script 已就绪
  if (reusable?.id) {
    const tabId = reusable.id
    log(MOD, 'ensurePlatformTab', `Reusing tab for ${platform}: id=${tabId}, url=${reusable.url}`)

    try {
      await chrome.tabs.update(tabId, { active: true })
      if (reusable.windowId) await chrome.windows.update(reusable.windowId, { focused: true })
    } catch {
      // 忽略激活异常
    }

    // 停留在首页 / 上一轮关键词 / 上一页时，导航到本次目标搜索页，否则会一直解析同一批旧卡片
    const hasTarget = Boolean(query && query.trim()) || page > 1
    if (hasTarget && !isOnTargetSearchUrl(reusable.url, query, page)) {
      const targetUrl = getPlatformSearchUrl(platform, query, page)
      log(MOD, 'ensurePlatformTab', `Navigating reused tab to target search url: ${targetUrl}`)
      try {
        await chrome.tabs.update(tabId, { url: targetUrl })
        const loaded = await waitForTabLoaded(tabId, 25_000)
        // 页面完成加载后再留一点时间给 content script 注入与首屏卡片渲染
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

  // 3. 没有匹配的 Tab，根据目标职业搜索关键词或默认首页新创建一个
  const targetUrl = getPlatformSearchUrl(platform, query, page) || PLATFORM_HOME_URLS[platform] || adapter.homeUrl
  log(MOD, 'ensurePlatformTab', `Creating new tab for ${platform}: ${targetUrl}`)

  try {
    const created = await chrome.tabs.create({
      url: targetUrl,
      active: true, // 激活前台打开，确保页面获得渲染焦点，防止后台睡眠节流
    })

    if (!created.id) return null

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

/** 向 Tab 发送消息，带有 Content Script 注入恢复与重试机制 */
export async function sendTabMessageWithRetry<T = unknown>(
  tabId: number,
  message: unknown,
  maxAttempts = 5,
): Promise<T> {
  let lastError: unknown

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const response = await chrome.tabs.sendMessage(tabId, message)
      return response as T
    } catch (err) {
      lastError = err
      logWarn(MOD, 'sendTabMessageWithRetry', `Attempt ${attempt + 1}/${maxAttempts} failed, injecting fallback script...`)

      // 页面尚未加载完成时注入必然失败，先等它 complete 再兜底注入
      try {
        await waitForTabLoaded(tabId, 8_000)
      } catch {
        // 忽略等待失败
      }

      // 尝试主动注入 content script（应对热加载后 content script 丢失）
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

  throw lastError
}
