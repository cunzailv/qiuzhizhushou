// 招聘平台登录与授权状态探测器
import type { PlatformId } from '../agent/quota'

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

    return {
      platform,
      name,
      isLoggedIn: hasAuthCookie,
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
