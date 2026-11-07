/**
 * 回归「打开别的软件 / 切换标签页 / 下滑，Chrome 都被硬拉回招聘网站页面」。
 *
 * 根因：每个投递任务与每轮补仓都会调 ensurePlatformTab()，旧实现无条件
 * `tabs.update({active:true})` + `windows.update({focused:true})`，并且优先复用
 * 「当前活跃标签页」再导航到搜索 URL —— 用户正在看的页面被直接改掉。
 *
 * 修复方向：默认后台静默运行，AIbot 只在专用非活跃标签页里工作；
 * 前台可见模式作为排查兜底，必须由用户显式打开。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  DEFAULT_FOREGROUND_MODE,
  FOREGROUND_MODE_KEY,
  DEDICATED_TABS_KEY,
  isProtectedTab,
  pickForegroundTab,
  pickStealthTab,
  shouldActivateTab,
} from '../src/shared/agent/stealth-mode'

const ROOT = process.cwd()
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf-8')

const TAB_MANAGER = 'src/background/tab-manager.ts'
const CAMPAIGN_SERVICE = 'src/background/campaign-service.ts'
const CAMPAIGN_PANEL = 'src/popup/components/CampaignPanel.tsx'

interface FakeTab {
  id?: number
  url?: string
  windowId?: number
}

const isBoss = (url: string) => url.includes('zhipin.com')

describe('运行模式决策 · 默认静默', () => {
  it('默认常量与设置键保持向后兼容', () => {
    expect(DEFAULT_FOREGROUND_MODE).toBe(false)
    expect(FOREGROUND_MODE_KEY).toBe('aibotForegroundMode')
    expect(DEDICATED_TABS_KEY).toBe('aibot_dedicated_tabs')
  })

  it('未显式指定时，是否激活完全跟随前台可见模式', () => {
    expect(shouldActivateTab(false)).toBe(false)
    expect(shouldActivateTab(true)).toBe(true)
  })

  it('显式参数覆盖设置：用户主动点入口仍可激活，后台调度可强制静默', () => {
    expect(shouldActivateTab(false, { activate: true })).toBe(true)
    expect(shouldActivateTab(true, { activate: false })).toBe(false)
    expect(shouldActivateTab(false, {})).toBe(false)
  })
})

describe('静默选 tab · 绝不碰用户正在看的页面', () => {
  const tabs: FakeTab[] = [
    { id: 1, url: 'https://www.zhipin.com/web/geek/job-recommend', windowId: 10 },
    { id: 2, url: 'https://www.zhipin.com/web/geek/job?query=php', windowId: 10 },
    { id: 3, url: 'https://example.com/docs', windowId: 10 },
    { id: 4, url: 'https://www.liepin.com/zhaopin/', windowId: 11 },
  ]

  it('排除当前活跃标签页，挑另一个同平台后台页', () => {
    const picked = pickStealthTab(tabs, 1, isBoss)
    expect(picked?.id).toBe(2)
  })

  it('多窗口时排除所有窗口的活跃标签页', () => {
    // 窗口 10 的活跃页 1、窗口 11 的活跃页 4 都不能被导航
    const withTwoWindows: FakeTab[] = [
      ...tabs,
      { id: 5, url: 'https://www.zhipin.com/web/geek/job?query=php', windowId: 11 },
    ]
    const picked = pickStealthTab(withTwoWindows, [1, 4], isBoss)
    expect(picked?.id).toBe(2)
    expect(isProtectedTab(4, [1, 4])).toBe(true)
    expect(isProtectedTab(2, [1, 4])).toBe(false)
  })

  it('优先复用该平台的专用后台标签页', () => {
    const picked = pickStealthTab(tabs, 1, isBoss, 2)
    expect(picked?.id).toBe(2)
    const other = pickStealthTab(
      [...tabs, { id: 6, url: 'https://www.zhipin.com/web/geek/job?query=go', windowId: 12 }],
      1,
      isBoss,
      6,
    )
    expect(other?.id).toBe(6)
  })

  it('专用标签页已被用户激活时必须让位，绝不抢回来', () => {
    const picked = pickStealthTab(tabs, 2, isBoss, 2)
    expect(picked?.id).toBe(1)
  })

  it('专用标签页已关闭（id 不存在）时安全降级', () => {
    expect(pickStealthTab(tabs, 1, isBoss, 999)?.id).toBe(2)
  })

  it('只剩一个活跃页可用时返回 undefined，强制新建后台标签页', () => {
    const onlyActive: FakeTab[] = [
      { id: 1, url: 'https://www.zhipin.com/web/geek/job-recommend' },
    ]
    expect(pickStealthTab(onlyActive, 1, isBoss)).toBeUndefined()
  })

  it('不匹配平台 / 缺 id / 缺 url 的标签页一律忽略', () => {
    const messy: FakeTab[] = [
      { id: 1, url: 'https://www.zhipin.com/web/geek/job-recommend' },
      { id: 2, url: 'https://www.liepin.com/zhaopin/' },
      { id: 3 },
      { url: 'https://www.zhipin.com/web/geek/job' },
    ]
    expect(pickStealthTab(messy, 1, isBoss)).toBeUndefined()
  })

  it('没有活跃页信息时也只返回合法候选', () => {
    expect(pickStealthTab(tabs, undefined, isBoss)?.id).toBe(1)
    expect(pickStealthTab(tabs, null, isBoss)?.id).toBe(1)
  })
})

describe('前台模式 · 兼容旧行为', () => {
  const tabs: FakeTab[] = [
    { id: 1, url: 'https://example.com/docs' },
    { id: 2, url: 'https://www.zhipin.com/web/geek/job' },
    { id: 3, url: 'https://www.zhipin.com/web/geek/job-recommend' },
  ]

  it('活跃页就是目标平台时优先复用它', () => {
    expect(pickForegroundTab(tabs, 3, isBoss)?.id).toBe(3)
  })

  it('活跃页不是目标平台时退而求其次', () => {
    expect(pickForegroundTab(tabs, 1, isBoss)?.id).toBe(2)
  })

  it('没有可用目标平台页时返回 undefined', () => {
    expect(pickForegroundTab([{ id: 1, url: 'https://example.com' }], 1, isBoss)).toBeUndefined()
  })
})

describe('调用链静态契约 · 抢焦点代码必须被模式开关包住', () => {
  const src = read(TAB_MANAGER)

  it('新建标签页只按模式决定 active，不再硬编码 active: true', () => {
    expect(src).toContain('active: foreground')
    expect(src).not.toContain('url: targetUrl,\n      active: true')
    expect(src).not.toContain('url,\n      active: true')
  })

  it('激活标签页与聚焦窗口都只在前台分支里执行', () => {
    const activateBlock = src.indexOf('if (foreground) {')
    const reuseBlock = src.indexOf('if (reusable?.id)')
    expect(activateBlock).toBeGreaterThan(-1)
    expect(reuseBlock).toBeGreaterThan(-1)
    // 复用分支的激活调用必须写在 foreground 判断内部，而不是分支外
    const reuseSection = src.slice(reuseBlock, src.indexOf('// 3. 没有安全的后台 Tab'))
    const guardInReuse = reuseSection.indexOf('if (foreground) {')
    const activateInReuse = reuseSection.indexOf('chrome.tabs.update(tabId, { active: true })')
    expect(guardInReuse).toBeGreaterThan(-1)
    expect(activateInReuse).toBeGreaterThan(guardInReuse)
    expect(reuseSection.indexOf('chrome.windows.update')).toBeGreaterThan(guardInReuse)
  })

  it('登录页打开也遵守静默模式', () => {
    const loginBody = src.slice(
      src.indexOf('export async function openPlatformLoginTab'),
      src.indexOf('/** 等待 Tab 达到 complete 状态 */'),
    )
    expect(loginBody).toContain('active: foreground')
    expect(loginBody).toContain('if (foreground) {')
    expect(loginBody.indexOf('chrome.tabs.update(existing.id, { active: true })')).toBeGreaterThan(
      loginBody.indexOf('if (foreground) {'),
    )
  })

  it('静默模式排除全部窗口活跃页，并使用专用后台 tab 记忆', () => {
    expect(src).toContain('chrome.tabs.query({ active: true })')
    expect(src).toContain('protectedTabIds')
    expect(src).toContain('pickStealthTab(allTabs, protectedTabIds, matches, dedicatedTabId)')
    expect(src).toContain('rememberDedicatedTab(platform, created.id)')
  })

  it('导航只会发生在已排除用户活跃页的复用 tab 上', () => {
    expect(src).toContain('chrome.tabs.update(tabId, { url: targetUrl })')
    expect(src).toContain('静默模式下 reusable 已排除用户当前活跃页')
  })

  it('默认与设置读取使用同一个常量，且查询失败时仍保护当前活跃页', () => {
    expect(src).toContain('DEFAULT_FOREGROUND_MODE')
    expect(src).toContain('if (activeTabId) protectedTabIds = [activeTabId]')
  })

  it('回收专用标签页时跳过所有窗口的活跃页，不替用户关正在看的页面', () => {
    const body = src.slice(
      src.indexOf('export async function releaseDedicatedTabs'),
      src.indexOf('/** 等待 Tab 达到 complete 状态 */'),
    )
    expect(body).toContain('chrome.tabs.query({ active: true })')
    expect(body).toContain('!protectedIds.has(id)')
    expect(body).toContain('chrome.storage.local.remove(DEDICATED_TABS_KEY)')
  })
})

describe('UI 与调度层契约 · 用户看得见、后台不越权', () => {
  const panel = read(CAMPAIGN_PANEL)
  const service = read(CAMPAIGN_SERVICE)

  it('面板提供显式开关，默认关闭且写入统一设置键', () => {
    expect(panel).toContain('FOREGROUND_MODE_KEY')
    expect(panel).toContain('useState(DEFAULT_FOREGROUND_MODE)')
    expect(panel).toContain('setSetting(FOREGROUND_MODE_KEY, enabled)')
    expect(panel).toContain('前台可见模式（会抢焦点）')
    expect(panel).toContain('后台静默运行，不抢焦点')
  })

  it('开关收在低频折叠组里，不把首屏重新堆满控件', () => {
    const disclosure = panel.indexOf('<Disclosure label="复盘与维护工具"')
    const end = panel.indexOf('</Disclosure>', disclosure)
    expect(disclosure).toBeGreaterThan(-1)
    expect(panel.slice(disclosure, end)).toContain('handleForegroundModeChange')
  })

  it('启动日志明确告知运行模式，登录失效提示区分前后台', () => {
    expect(service).toContain('isForegroundMode')
    expect(service).toContain('后台静默运行：AIbot 只在专用后台标签页工作')
    expect(service).toContain('已在后台标签页打开登录页')
  })

  it('后台调度不给 ensurePlatformTab 传强制激活参数', () => {
    expect(service).not.toMatch(/ensurePlatformTab\([^)]*activate:\s*true/)
  })

  it('终止时回收专用后台标签页并留痕', () => {
    expect(service).toContain('releaseDedicatedTabs')
    expect(service).toContain('已回收 ${closed} 个 AIbot 专用后台标签页')
  })
})
