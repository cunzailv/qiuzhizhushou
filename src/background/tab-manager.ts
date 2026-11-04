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

/** 构造带有目标职业检索词的精准搜索页面 URL */
export function getPlatformSearchUrl(platform: PlatformId, query?: string): string {
  if (!query || !query.trim()) {
    return PLATFORM_HOME_URLS[platform] || 'https://www.zhipin.com/web/geek/job-recommend'
  }
  const q = encodeURIComponent(query.trim())
  switch (platform) {
    case 'boss':
      return `https://www.zhipin.com/web/geek/job?query=${q}`
    case 'liepin':
      return `https://www.liepin.com/zhaopin/?key=${q}`
    case 'zhaopin':
      return `https://sou.zhaopin.com/?kw=${q}`
    case '51job':
      return `https://we.51job.com/pc/search?keyword=${q}`
    case 'maimai':
      return 'https://maimai.cn/jobs'
    default:
      return PLATFORM_HOME_URLS[platform]
  }
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

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

/** 确保目标平台有可用的标签页（优先复用已有 Tab，没有则新建） */
export async function ensurePlatformTab(platform: PlatformId, query?: string): Promise<chrome.tabs.Tab | null> {
  const adapter = getPlatformById(platform)
  if (!adapter) {
    logError(MOD, 'ensurePlatformTab', `Unknown platform: ${platform}`)
    return null
  }

  // 1. 优先复用当前窗口中的活跃标签页（用户正在看的页面）
  try {
    const [currentActive] = await chrome.tabs.query({ active: true, currentWindow: true })
    if (currentActive && currentActive.id && currentActive.url && adapter.matchesUrl(currentActive.url)) {
      log(MOD, 'ensurePlatformTab', `Reusing current active tab for ${platform}: id=${currentActive.id}`)
      return currentActive
    }
  } catch {
    // 忽略查询失败
  }

  // 2. 查询所有浏览器窗口中的 tab，检查 matchesUrl
  const allTabs = await chrome.tabs.query({})
  const matchedTab = allTabs.find((tab) => tab.url && adapter.matchesUrl(tab.url))

  if (matchedTab && matchedTab.id) {
    log(MOD, 'ensurePlatformTab', `Reusing existing tab for ${platform}: id=${matchedTab.id}`)
    try {
      await chrome.tabs.update(matchedTab.id, { active: true })
      if (matchedTab.windowId) {
        await chrome.windows.update(matchedTab.windowId, { focused: true })
      }
    } catch {
      // 忽略激活异常
    }
    return matchedTab
  }

  // 3. 没有匹配的 Tab，根据目标职业搜索关键词或默认首页新创建一个
  const targetUrl = getPlatformSearchUrl(platform, query) || PLATFORM_HOME_URLS[platform] || adapter.homeUrl
  log(MOD, 'ensurePlatformTab', `Creating new tab for ${platform}: ${targetUrl}`)

  try {
    const created = await chrome.tabs.create({
      url: targetUrl,
      active: true, // 激活前台打开，确保页面获得渲染焦点，防止后台睡眠节流
    })

    if (!created.id) return null

    // 等待页面初次加载完成
    await waitForTabLoaded(created.id, 15_000)
    // 稍微等待 content scripts 注入并完成挂载
    await wait(1500)

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

      // 尝试主动注入 content script（应对热加载后 content script 丢失）
      try {
        const manifest = chrome.runtime.getManifest()
        const scripts = manifest.content_scripts?.[0]?.js ?? []
        if (scripts.length > 0) {
          await chrome.scripting.executeScript({
            target: { tabId },
            files: scripts,
          })
        }
      } catch {
        // 忽略注入失败，继续重试
      }

      await wait(500 * (attempt + 1))
    }
  }

  throw lastError
}
