// @vitest-environment jsdom
// 登录态 DOM 兜底：cookie 名变更时用页面实际渲染结果复核
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { detectLoginStateFromDom } from '../src/shared/platform/login-detect'
import { checkPlatformAuth } from '../src/shared/platform/auth-checker'

beforeEach(() => {
  document.body.innerHTML = ''
})

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('页面登录态判定 detectLoginStateFromDom', () => {
  it('存在头像区域判定为已登录', () => {
    document.body.innerHTML = '<div class="header-user">我的</div><img class="user-avatar" />'
    expect(detectLoginStateFromDom()).toBe('logged-in')
  })

  it('只有登录入口判定为未登录', () => {
    document.body.innerHTML = '<a href="https://passport.liepin.com/account/login">登录</a>'
    expect(detectLoginStateFromDom()).toBe('logged-out')
  })

  it('纯文案为「立即登录」的按钮判定为未登录', () => {
    document.body.innerHTML = '<button>立即登录</button>'
    expect(detectLoginStateFromDom()).toBe('logged-out')
  })

  it('被 display:none 隐藏的登录入口不参与判定', () => {
    document.body.innerHTML = '<a href="/login" style="display:none">登录</a><div>职位列表</div>'
    expect(detectLoginStateFromDom()).toBe('unknown')
  })

  it('既无头像也无登录入口时返回 unknown，交由 cookie 判定', () => {
    document.body.innerHTML = '<div class="job-list"><div>PHP开发工程师</div></div>'
    expect(detectLoginStateFromDom()).toBe('unknown')
  })
})

describe('checkPlatformAuth 的 DOM 兜底', () => {
  it('cookie 缺失但页面显示已登录时，判为已登录', async () => {
    vi.stubGlobal('chrome', {
      cookies: { get: vi.fn(async () => null), getAll: vi.fn(async () => []) },
      tabs: {
        query: vi.fn(async () => [{ id: 1, url: 'https://www.liepin.com/zhaopin/' }]),
        sendMessage: vi.fn(async () => ({ state: 'logged-in' })),
      },
    })

    const info = await checkPlatformAuth('liepin')
    expect(info.isLoggedIn).toBe(true)
  })

  it('页面明确显示未登录时判为未登录', async () => {
    vi.stubGlobal('chrome', {
      cookies: { get: vi.fn(async () => null), getAll: vi.fn(async () => []) },
      tabs: {
        query: vi.fn(async () => [{ id: 2, url: 'https://www.zhipin.com/web/geek/job' }]),
        sendMessage: vi.fn(async () => ({ state: 'logged-out' })),
      },
    })

    const info = await checkPlatformAuth('boss')
    expect(info.isLoggedIn).toBe(false)
  })

  it('没有该平台标签页时维持 cookie 判定（未登录）', async () => {
    vi.stubGlobal('chrome', {
      cookies: { get: vi.fn(async () => null), getAll: vi.fn(async () => []) },
      tabs: {
        query: vi.fn(async () => [{ id: 3, url: 'https://example.com/' }]),
        sendMessage: vi.fn(async () => ({ state: 'logged-in' })),
      },
    })

    const info = await checkPlatformAuth('zhaopin')
    expect(info.isLoggedIn).toBe(false)
  })

  it('页面探测失败时不误判为已登录', async () => {
    vi.stubGlobal('chrome', {
      cookies: { get: vi.fn(async () => null), getAll: vi.fn(async () => []) },
      tabs: {
        query: vi.fn(async () => [{ id: 4, url: 'https://we.51job.com/pc/search' }]),
        sendMessage: vi.fn(async () => {
          throw new Error('Could not establish connection')
        }),
      },
    })

    const info = await checkPlatformAuth('51job')
    expect(info.isLoggedIn).toBe(false)
  })
})
