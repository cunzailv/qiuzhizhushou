// 招聘平台登录与授权状态探测器
import type { PlatformId } from '../agent/quota'
import type { PageLoginState } from './login-detect'

export interface PlatformAuthInfo {
  platform: PlatformId
  name: string
  isLoggedIn: boolean
  loginUrl: string
  accountName?: string
  lastCheckedAt: number
}

export const PLATFORM_LOGIN_URLS: Record<PlatformId, string> = {
  boss: 'https://www.zhipin.com/web/user/?ka=header-login',
  liepin: 'https://passport.liepin.com/account/login',
  zhaopin: 'https://passport.zhaopin.com/login',
  '51job': 'https://login.51job.com/login.php',
  maimai: 'https://maimai.cn/login',
}

const PLATFORM_DOMAINS: Record<PlatformId, { url: string; domain: string; cookieNames: string[] }> = {
  boss: {
    url: 'https://www.zhipin.com/',
    domain: '.zhipin.com',
    cookieNames: ['wt2', 'geek_zp_token', 'bst'],
  },
  liepin: {
    url: 'https://www.liepin.com/',
    domain: '.liepin.com',
    cookieNames: ['lt_auth', 'user_id', 'user_kind'],
  },
  zhaopin: {
    url: 'https://www.zhaopin.com/',
    domain: '.zhaopin.com',
    cookieNames: ['at', 'rt', 'zp_token', 'zp_user_id'],
  },
  '51job': {
    url: 'https://we.51job.com/',
    domain: '.51job.com',
    cookieNames: ['guid', 'm_guid', 'accountid', 'ps_guid'],
  },
  maimai: {
    url: 'https://maimai.cn/',
    domain: '.maimai.cn',
    cookieNames: ['u', 'access_token', 'session'],
  },
}

const PLATFORM_DISPLAY_NAMES: Record<PlatformId, string> = {
  boss: 'Boss直聘',
  liepin: '猎聘',
  zhaopin: '智联招聘',
  '51job': '前程无忧',
  maimai: '脉脉',
}

/** DOM 探测结果缓存（避免每轮巡检都发消息） */
const pageAuthCache: Partial<Record<PlatformId, { state: PageLoginState; at: number }>> = {}
const PAGE_AUTH_CACHE_MS = 5 * 60_000

/**
 * 当 cookie 判定为「未登录」时，用页面真实渲染结果复核一次。
 * 平台改了 cookie 名 / 换用新登录机制时，只靠 cookie 会把已登录误判成未登录，
 * 导致整个平台被跳过。
 */
async function detectLoginStateByPage(platform: PlatformId): Promise<PageLoginState> {
  const cached = pageAuthCache[platform]
  if (cached && Date.now() - cached.at < PAGE_AUTH_CACHE_MS) return cached.state

  let state: PageLoginState = 'unknown'
  try {
    const cfg = PLATFORM_DOMAINS[platform]
    const host = cfg.domain.replace(/^\./, '')
    const tabs = await chrome.tabs.query({})
    const tab = tabs.find((t) => t.url && t.url.includes(host))
    if (tab?.id) {
      const res = (await chrome.tabs.sendMessage(tab.id, { type: 'CHECK_PLATFORM_LOGIN' })) as
        | { state?: PageLoginState }
        | undefined
      if (res?.state === 'logged-in' || res?.state === 'logged-out') state = res.state
    }
  } catch {
    // content script 未注入 / 标签页已关闭：保持 unknown，沿用 cookie 判定
  }

  pageAuthCache[platform] = { state, at: Date.now() }
  return state
}

/** 探测指定平台的登录授权状态 */
export async function checkPlatformAuth(platform: PlatformId): Promise<PlatformAuthInfo> {
  const cfg = PLATFORM_DOMAINS[platform]
  const loginUrl = PLATFORM_LOGIN_URLS[platform]
  const name = PLATFORM_DISPLAY_NAMES[platform]

  if (typeof chrome === 'undefined' || !chrome.cookies) {
    return {
      platform,
      name,
      isLoggedIn: true, // 非扩展环境（如单元测试）默认放行
      loginUrl,
      lastCheckedAt: Date.now(),
    }
  }

  try {
    // 1. 通过 chrome.cookies 查询关键鉴权 Cookie
    for (const cookieName of cfg.cookieNames) {
      const cookie = await chrome.cookies.get({ url: cfg.url, name: cookieName })
      if (cookie && cookie.value && cookie.value.trim().length > 0) {
        return {
          platform,
          name,
          isLoggedIn: true,
          loginUrl,
          accountName: cookieName === 'user_id' ? cookie.value : undefined,
          lastCheckedAt: Date.now(),
        }
      }
    }

    // 2. 检查 domain 下所有匹配的 cookies
    const allDomainCookies = await chrome.cookies.getAll({ domain: cfg.domain })
    const hasAuthCookie = allDomainCookies.some((c) =>
      cfg.cookieNames.includes(c.name) && !!c.value && c.value.trim().length > 0,
    )

    if (hasAuthCookie) {
      return {
        platform,
        name,
        isLoggedIn: true,
        loginUrl,
        lastCheckedAt: Date.now(),
      }
    }

    // 3. cookie 判定为未登录 → 用页面实际渲染结果复核一次，
    //    防止平台改了 cookie 名或改用新登录机制时把已登录误判成未登录
    const pageState = await detectLoginStateByPage(platform)
    return {
      platform,
      name,
      isLoggedIn: pageState === 'logged-in',
      loginUrl,
      lastCheckedAt: Date.now(),
    }
  } catch {
    return {
      platform,
      name,
      isLoggedIn: false,
      loginUrl,
      lastCheckedAt: Date.now(),
    }
  }
}

/** 探测所有平台的授权状态 */
export async function checkAllPlatformsAuth(): Promise<Record<PlatformId, PlatformAuthInfo>> {
  const platforms: PlatformId[] = ['boss', 'liepin', 'zhaopin', '51job', 'maimai']
  const results: Partial<Record<PlatformId, PlatformAuthInfo>> = {}

  for (const p of platforms) {
    results[p] = await checkPlatformAuth(p)
  }

  return results as Record<PlatformId, PlatformAuthInfo>
}
