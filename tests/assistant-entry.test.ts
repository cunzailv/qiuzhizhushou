// @vitest-environment jsdom
// 回归两个历史 bug：
// 1) 点图标跳到管理后台、到后台回不来；
// 2) 点图标弹出独立整页面板，而不是招聘网站右侧的整高侧栏。
import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  canHostSidebar,
  findAssistantTabId,
  findJobSiteTabId,
  planAssistantEntry,
  resolvePanelPresence,
  runAssistantEntry,
} from '../src/shared/assistant-entry'

const read = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf-8')

const ORIGIN = 'chrome-extension://abcdefghijklmnop'
const JOB_URL = 'https://www.zhipin.com/web/geek/job-recommend'
const isJobSite = (url: string) => /zhipin\.com|liepin\.com|51job\.com|zhaopin\.com|maimai\.cn/.test(url)

describe('可注入侧栏的页面判定', () => {
  it('招聘网站页面可以注入', () => {
    expect(canHostSidebar(JOB_URL, ORIGIN)).toBe(true)
    expect(canHostSidebar('https://www.liepin.com/zhaopin/', ORIGIN)).toBe(true)
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

describe('点击图标决策：只有招聘网站才在当前页展开侧栏', () => {
  it('招聘网站 → 当前页尝试展开', () => {
    expect(planAssistantEntry(JOB_URL, ORIGIN, isJobSite)).toBe('try-sidebar')
  })

  it('普通网页 → 去招聘网站展开，不在当前页注入', () => {
    expect(planAssistantEntry('https://example.com/', ORIGIN, isJobSite)).toBe('job-site-sidebar')
    expect(planAssistantEntry('http://localhost:5173/', ORIGIN, isJobSite)).toBe('job-site-sidebar')
  })

  it('新标签页 / 后台页 / 独立面板 → 去招聘网站展开（不再弹独立整页面板）', () => {
    for (const url of [
      'chrome://newtab/',
      '',
      `${ORIGIN}/src/options/index.html`,
      `${ORIGIN}/src/popup/index.html?standalone=1`,
    ]) {
      expect(planAssistantEntry(url, ORIGIN, isJobSite), url).toBe('job-site-sidebar')
    }
  })

  it('不传 isJobSite 时沿用「可注入就尝试」的宽松判定', () => {
    expect(planAssistantEntry('https://example.com/', ORIGIN)).toBe('try-sidebar')
  })
})

describe('侧栏形态：切换 vs 确保展开', () => {
  it('点图标是切换：展开 → 浮球，浮球/关闭 → 展开', () => {
    expect(resolvePanelPresence('expanded', false)).toBe('bubble')
    expect(resolvePanelPresence('bubble', false)).toBe('expanded')
    expect(resolvePanelPresence('closed', false)).toBe('expanded')
  })

  it('兜底路径只展开，不把已经展开的侧栏收成浮球', () => {
    expect(resolvePanelPresence('expanded', true)).toBe('expanded')
    expect(resolvePanelPresence('bubble', true)).toBe('expanded')
    expect(resolvePanelPresence('closed', true)).toBe('expanded')
  })
})

describe('标签页复用', () => {
  const tabs = [
    { id: 1, url: 'https://example.com/' },
    { id: 2, url: `${ORIGIN}/src/options/index.html` },
    { id: 3, url: JOB_URL },
    { id: 4, url: `${ORIGIN}/src/popup/index.html?standalone=1` },
  ]

  it('能找到已打开的招聘网站标签页（优先复用而不是新开）', () => {
    expect(findJobSiteTabId(tabs, isJobSite)).toBe(3)
  })

  it('没有招聘网站标签页时返回 null，由调用方新开', () => {
    expect(findJobSiteTabId(tabs.slice(0, 2), isJobSite)).toBeNull()
  })

  it('能找到已打开的独立助手面板，避免反复点图标开一堆标签', () => {
    expect(findAssistantTabId(tabs, `${ORIGIN}/src/popup/index.html`)).toBe(4)
    expect(findAssistantTabId(tabs.slice(0, 3), `${ORIGIN}/src/popup/index.html`)).toBeNull()
  })

  it('忽略没有 id 的标签页', () => {
    expect(findAssistantTabId([{ url: `${ORIGIN}/src/popup/index.html` }], `${ORIGIN}/src/popup/index.html`)).toBeNull()
  })
})

describe('点击图标编排（绝不跳后台、优先右侧整高侧栏）', () => {
  const makeDeps = (toggleResult: boolean, jobSiteResult = true) => ({
    isJobSite,
    tryToggleSidebar: vi.fn(async () => toggleResult),
    openJobSiteSidebar: vi.fn(async () => jobSiteResult),
    openAssistantPanel: vi.fn(async () => {}),
  })

  it('招聘网站且注入成功 → 当前页展开侧栏，不打开任何面板', async () => {
    const deps = makeDeps(true)
    const result = await runAssistantEntry(JOB_URL, ORIGIN, deps)
    expect(result).toBe('sidebar')
    expect(deps.tryToggleSidebar).toHaveBeenCalledTimes(1)
    expect(deps.openJobSiteSidebar).not.toHaveBeenCalled()
    expect(deps.openAssistantPanel).not.toHaveBeenCalled()
  })

  it('招聘网站注入失败 → 去招聘网站展开侧栏，不弹独立面板', async () => {
    const deps = makeDeps(false)
    const result = await runAssistantEntry(JOB_URL, ORIGIN, deps)
    expect(result).toBe('job-site-sidebar')
    expect(deps.tryToggleSidebar).toHaveBeenCalledTimes(1)
    expect(deps.openJobSiteSidebar).toHaveBeenCalledTimes(1)
    expect(deps.openAssistantPanel).not.toHaveBeenCalled()
  })

  it('新标签页 / 普通网页 / 后台页：连注入都不尝试，直接去招聘网站展开', async () => {
    for (const url of ['chrome://newtab/', '', 'https://example.com/', `${ORIGIN}/src/options/index.html`]) {
      const deps = makeDeps(false)
      expect(await runAssistantEntry(url, ORIGIN, deps), url).toBe('job-site-sidebar')
      expect(deps.tryToggleSidebar, url).not.toHaveBeenCalled()
      expect(deps.openJobSiteSidebar, url).toHaveBeenCalledTimes(1)
      expect(deps.openAssistantPanel, url).not.toHaveBeenCalled()
    }
  })

  it('独立整页面板只作为两条路都失败时的最后兜底', async () => {
    const deps = makeDeps(false, false)
    const result = await runAssistantEntry('chrome://newtab/', ORIGIN, deps)
    expect(result).toBe('assistant-panel')
    expect(deps.openJobSiteSidebar).toHaveBeenCalledTimes(1)
    expect(deps.openAssistantPanel).toHaveBeenCalledTimes(1)
  })

  it('编排依赖里不存在「打开后台」入口，从签名上杜绝再次困住用户', async () => {
    const deps = makeDeps(false)
    expect(Object.keys(deps)).toEqual([
      'isJobSite',
      'tryToggleSidebar',
      'openJobSiteSidebar',
      'openAssistantPanel',
    ])
  })
})

describe('静态链路契约：图标点击必须落到右侧整高侧栏', () => {
  const background = read('src/background/index.ts')
  const content = read('src/content/index.ts')
  const manifest = read('public/manifest.json')

  it('action 没有 default_popup，点击图标走 onClicked 而不是弹小窗', () => {
    expect(manifest).not.toContain('default_popup')
    expect(background).toContain('chrome.action.onClicked.addListener')
  })

  it('onClicked 把「去招聘网站展开侧栏」接成兜底，独立面板只排最后', () => {
    expect(background).toContain('openJobSiteSidebar: openJobSiteWithSidebar')
    expect(background).toContain('openAssistantPanel: focusOrCreateAssistantPanel')
    const jobSiteIdx = background.indexOf('openJobSiteSidebar: openJobSiteWithSidebar')
    const panelIdx = background.indexOf('openAssistantPanel: focusOrCreateAssistantPanel')
    expect(jobSiteIdx).toBeGreaterThan(0)
    expect(jobSiteIdx).toBeLessThan(panelIdx)
  })

  it('兜底路径写 expanded 并补发「确保展开」，不会被 toggle 收成浮球', () => {
    expect(background).toContain("patchAssistantState({ panelState: 'expanded' })")
    expect(background).toContain('ensureSidebarInTab(existingId)')
    expect(background).toContain('payload: { ensureExpanded }')
    expect(content).toContain('resolvePanelPresence(assistantState.panelState, ensureExpanded)')
  })

  it('动态注入改为轮询等待，不再用固定 300ms 误判失败', () => {
    expect(background).toContain('for (let attempt = 0; attempt < 5')
    expect(background).not.toContain('setTimeout(resolve, 300)')
  })
})
