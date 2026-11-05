// @vitest-environment jsdom
// 回归「一点击跳到后台、到了后台回不来」：入口决策必须永远回到助手，绝不跳后台。
import { describe, expect, it, vi } from 'vitest'
import {
  canHostSidebar,
  findAssistantTabId,
  findJobSiteTabId,
  planAssistantEntry,
  runAssistantEntry,
} from '../src/shared/assistant-entry'

const ORIGIN = 'chrome-extension://abcdefghijklmnop'

describe('可注入侧栏的页面判定', () => {
  it('招聘网站页面可以注入', () => {
    expect(canHostSidebar('https://www.zhipin.com/web/geek/job-recommend', ORIGIN)).toBe(true)
    expect(canHostSidebar('https://www.liepin.com/zhaopin/', ORIGIN)).toBe(true)
  })

  it('普通 http(s) 页面仍先尝试注入，失败后再回退', () => {
    expect(canHostSidebar('https://example.com/', ORIGIN)).toBe(true)
    expect(canHostSidebar('http://localhost:5173/', ORIGIN)).toBe(true)
  })

  it('扩展自己的 options / 独立助手页面不可注入', () => {
    expect(canHostSidebar(`${ORIGIN}/src/options/index.html`, ORIGIN)).toBe(false)
    expect(canHostSidebar(`${ORIGIN}/src/popup/index.html?standalone=1`, ORIGIN)).toBe(false)
  })

  it('受限协议与空 URL 不可注入', () => {
    expect(canHostSidebar('chrome://extensions/', ORIGIN)).toBe(false)
    expect(canHostSidebar('about:blank', ORIGIN)).toBe(false)
    expect(canHostSidebar('file:///tmp/index.html', ORIGIN)).toBe(false)
    expect(canHostSidebar('', ORIGIN)).toBe(false)
  })
})

describe('点击图标决策', () => {
  it('招聘网站 → 尝试展开侧栏', () => {
    expect(planAssistantEntry('https://www.zhipin.com/web/geek/jobs', ORIGIN)).toBe('try-sidebar')
  })

  it('后台页 → 回到助手面板（不再打开第二个后台页）', () => {
    expect(planAssistantEntry(`${ORIGIN}/src/options/index.html`, ORIGIN)).toBe('assistant-panel')
  })

  it('chrome:// 与空白页 → 回到助手面板', () => {
    expect(planAssistantEntry('chrome://newtab/', ORIGIN)).toBe('assistant-panel')
    expect(planAssistantEntry('', ORIGIN)).toBe('assistant-panel')
  })
})

describe('标签页复用', () => {
  const tabs = [
    { id: 1, url: 'https://example.com/' },
    { id: 2, url: `${ORIGIN}/src/options/index.html` },
    { id: 3, url: 'https://www.zhipin.com/web/geek/job-recommend' },
    { id: 4, url: `${ORIGIN}/src/popup/index.html?standalone=1` },
  ]

  it('能找到已打开的招聘网站标签页（优先复用而不是新开）', () => {
    expect(findJobSiteTabId(tabs, (url) => url.includes('zhipin.com'))).toBe(3)
  })

  it('没有招聘网站标签页时返回 null，由调用方新开', () => {
    expect(findJobSiteTabId(tabs.slice(0, 2), (url) => url.includes('zhipin.com'))).toBeNull()
  })

  it('能找到已打开的独立助手面板，避免反复点图标开一堆标签', () => {
    expect(findAssistantTabId(tabs, `${ORIGIN}/src/popup/index.html`)).toBe(4)
    expect(findAssistantTabId(tabs.slice(0, 3), `${ORIGIN}/src/popup/index.html`)).toBeNull()
  })

  it('忽略没有 id 的标签页', () => {
    expect(findAssistantTabId([{ url: `${ORIGIN}/src/popup/index.html` }], `${ORIGIN}/src/popup/index.html`)).toBeNull()
  })
})

describe('点击图标编排（绝不跳后台）', () => {
  const makeDeps = (toggleResult: boolean) => ({
    tryToggleSidebar: vi.fn(async () => toggleResult),
    openAssistantPanel: vi.fn(async () => {}),
  })

  it('招聘网站且注入成功 → 展开侧栏，不打开任何面板', async () => {
    const deps = makeDeps(true)
    const result = await runAssistantEntry('https://www.zhipin.com/web/geek/jobs', ORIGIN, deps)
    expect(result).toBe('sidebar')
    expect(deps.tryToggleSidebar).toHaveBeenCalledTimes(1)
    expect(deps.openAssistantPanel).not.toHaveBeenCalled()
  })

  it('普通网页注入失败 → 回到助手面板（旧逻辑会误开后台）', async () => {
    const deps = makeDeps(false)
    const result = await runAssistantEntry('https://example.com/', ORIGIN, deps)
    expect(result).toBe('assistant-panel')
    expect(deps.tryToggleSidebar).toHaveBeenCalledTimes(1)
    expect(deps.openAssistantPanel).toHaveBeenCalledTimes(1)
  })

  it('后台页：连注入都不尝试，直接回助手面板（打破死循环）', async () => {
    const deps = makeDeps(false)
    const result = await runAssistantEntry(`${ORIGIN}/src/options/index.html`, ORIGIN, deps)
    expect(result).toBe('assistant-panel')
    expect(deps.tryToggleSidebar).not.toHaveBeenCalled()
    expect(deps.openAssistantPanel).toHaveBeenCalledTimes(1)
  })

  it('chrome:// 受限页与空 URL 同样只回助手面板', async () => {
    for (const url of ['chrome://extensions/', '']) {
      const deps = makeDeps(false)
      expect(await runAssistantEntry(url, ORIGIN, deps)).toBe('assistant-panel')
      expect(deps.tryToggleSidebar).not.toHaveBeenCalled()
      expect(deps.openAssistantPanel).toHaveBeenCalledTimes(1)
    }
  })

  it('编排依赖里不存在「打开后台」入口，从签名上杜绝再次困住用户', async () => {
    const deps = makeDeps(false)
    expect(Object.keys(deps)).toEqual(['tryToggleSidebar', 'openAssistantPanel'])
  })
})
