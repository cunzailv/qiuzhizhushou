// @vitest-environment jsdom
/**
 * 2026-11-09 第六轮真实账号现场日志（用户重载扩展之后）：
 *
 *   1、猎聘不投递  获取列表信息一直报错
 *   2、❌ 任务执行通信异常: Error: Could not establish connection. Receiving end does not exist.
 *
 * 两个现象是同一个根因：chrome://extensions 里「重新加载」会销毁旧 service worker，
 * 已打开页面里的旧 content script 变成 invalidated context，消息端口被拆除；
 * 但 DEDICATED_TABS_KEY 存在 chrome.storage.local、重载不清，
 * ensurePlatformTab() 仍复用这个 status=complete、URL 也对的「僵死」后台 tab。
 *
 * 旧兜底是 executeScript 再注入一次 manifest 的 content script，可构建产物是
 * 动态 import loader：
 *   await import(chrome.runtime.getURL("assets/index.ts-XXXX.js"))
 * 同一 isolated world 里同一模块 URL 已被 import 过，ES module 缓存让模块体不会
 * 二次执行，模块顶层的 onMessage.addListener 也就永远不会重新注册。
 * 于是采集侧和执行侧都连着报「通信异常」，猎聘看起来像「不投递」。
 *
 * 本文件锁死三层修复：
 *  1) 只有 reload 才能重建 isolated world，且绝不 reload 用户正在看的活跃页；
 *  2) 扩展重载/浏览器启动时主动刷新专用后台 tab，不等第一次失败；
 *  3) 通信异常是环境故障，任务必须保留（skipped）而不是判死刑（failed）。
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  isStaleConnectionError,
  shouldReloadStaleTab,
  sendTabMessageWithRetry,
  reviveDedicatedTabs,
} from '../src/background/tab-manager'
import { DEDICATED_TABS_KEY } from '../src/shared/agent/stealth-mode'

const ROOT = process.cwd()
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf-8')

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('识别「扩展重载导致 content script 失联」', () => {
  it('命中现场原始报错', () => {
    expect(isStaleConnectionError(
      new Error('Could not establish connection. Receiving end does not exist.'),
    )).toBe(true)
  })

  it('字符串形态的报错也能命中', () => {
    expect(isStaleConnectionError('Error: Could not establish connection. Receiving end does not exist.')).toBe(true)
  })

  it('扩展上下文失效 / 消息端口关闭都算失联', () => {
    expect(isStaleConnectionError(new Error('Extension context invalidated.'))).toBe(true)
    expect(isStaleConnectionError(new Error('The message port closed before a response was received.'))).toBe(true)
  })

  it('普通业务错误不误判为失联', () => {
    expect(isStaleConnectionError(new Error('页面中未找到对应岗位卡片'))).toBe(false)
    expect(isStaleConnectionError(new Error('network timeout'))).toBe(false)
    expect(isStaleConnectionError(undefined)).toBe(false)
    expect(isStaleConnectionError(null)).toBe(false)
  })
})

describe('只允许 reload 非活跃的招聘站后台 tab', () => {
  it('五大平台的后台 tab 都允许刷新', () => {
    expect(shouldReloadStaleTab({ active: false, url: 'https://www.liepin.com/zhaopin/?key=PHP' })).toBe(true)
    expect(shouldReloadStaleTab({ active: false, url: 'https://we.51job.com/pc/search?keyword=PHP' })).toBe(true)
    expect(shouldReloadStaleTab({ active: false, url: 'https://www.zhipin.com/web/geek/job?query=PHP' })).toBe(true)
    expect(shouldReloadStaleTab({ active: false, url: 'https://sou.zhaopin.com/?kw=PHP' })).toBe(true)
    expect(shouldReloadStaleTab({ active: false, url: 'https://maimai.cn/jobs?query=PHP' })).toBe(true)
  })

  it('用户正在看的活跃页绝不 reload', () => {
    expect(shouldReloadStaleTab({ active: true, url: 'https://www.liepin.com/zhaopin/' })).toBe(false)
  })

  it('非招聘站、扩展页、Chrome 内部页一律不碰', () => {
    expect(shouldReloadStaleTab({ active: false, url: 'https://example.com/jobs' })).toBe(false)
    expect(shouldReloadStaleTab({ active: false, url: 'chrome://extensions/' })).toBe(false)
    expect(shouldReloadStaleTab({ active: false, url: 'chrome-extension://abc/popup.html' })).toBe(false)
    expect(shouldReloadStaleTab({ active: false, url: 'https://liepin.com.evil.com/zhaopin/' })).toBe(false)
  })

  it('空输入 / 无 URL / 非法 URL 安全返回 false', () => {
    expect(shouldReloadStaleTab(null)).toBe(false)
    expect(shouldReloadStaleTab(undefined)).toBe(false)
    expect(shouldReloadStaleTab({ active: false })).toBe(false)
    expect(shouldReloadStaleTab({ active: false, url: 'not a url' })).toBe(false)
  })
})

describe('通信层自愈：reload 一次后重试成功', () => {
  it('僵死的猎聘后台页：刷新一次即恢复，不做无效注入', async () => {
    vi.useFakeTimers()
    let sends = 0
    const reload = vi.fn(async () => {})
    const executeScript = vi.fn(async () => {})
    vi.stubGlobal('chrome', {
      tabs: {
        sendMessage: vi.fn(async () => {
          sends++
          if (sends === 1) {
            throw new Error('Could not establish connection. Receiving end does not exist.')
          }
          return { collected: 12, added: 3, success: true }
        }),
        get: vi.fn(async () => ({
          id: 7,
          active: false,
          url: 'https://www.liepin.com/zhaopin/?key=PHP',
          status: 'complete',
        })),
        reload,
      },
      scripting: { executeScript },
      runtime: { getManifest: () => ({ content_scripts: [{ js: ['assets/loader.js'] }] }) },
    })

    const pending = sendTabMessageWithRetry<{ collected: number }>(
      7,
      { type: 'COLLECT_PLATFORM_JOBS' },
      3,
    )
    await vi.advanceTimersByTimeAsync(5000)
    const res = await pending

    expect(res.collected).toBe(12)
    expect(sends).toBe(2)
    expect(reload).toHaveBeenCalledTimes(1)
    // 扩展重载造成的僵死 context 重复注入 loader 无效，不该白做
    expect(executeScript).not.toHaveBeenCalled()
  })

  it('活跃页不可刷新：保留注入兜底，最终如实抛出失联错误', async () => {
    vi.useFakeTimers()
    const reload = vi.fn(async () => {})
    const executeScript = vi.fn(async () => {})
    vi.stubGlobal('chrome', {
      tabs: {
        sendMessage: vi.fn(async () => {
          throw new Error('Could not establish connection. Receiving end does not exist.')
        }),
        get: vi.fn(async () => ({
          id: 8,
          active: true,
          url: 'https://www.liepin.com/zhaopin/',
          status: 'complete',
        })),
        reload,
      },
      scripting: { executeScript },
      runtime: { getManifest: () => ({ content_scripts: [{ js: ['assets/loader.js'] }] }) },
    })

    const pending = sendTabMessageWithRetry(8, { type: 'EXECUTE_CAMPAIGN_TASK' }, 2)
    // 断言必须挂在 promise 上，否则 fake timers 推进时未处理的 rejection 会炸测试
    const assertion = expect(pending).rejects.toThrow(/自动刷新未执行/)
    await vi.advanceTimersByTimeAsync(15_000)
    await assertion

    // 没刷成就不能谎报「已自动刷新」，必须把「请手动刷新」如实带给上层日志
    const finalErr = await pending.catch((e: Error) => e)
    expect(finalErr.message).toContain('Could not establish connection')
    expect(finalErr.message).toContain('请手动刷新此页面')
    expect(reload).not.toHaveBeenCalled()
    expect(executeScript).toHaveBeenCalled()
  })

  it('普通错误（非失联）不触发 reload', async () => {
    vi.useFakeTimers()
    const reload = vi.fn(async () => {})
    vi.stubGlobal('chrome', {
      tabs: {
        sendMessage: vi.fn(async () => {
          throw new Error('tab is still loading')
        }),
        get: vi.fn(async () => ({
          id: 9,
          active: false,
          url: 'https://we.51job.com/pc/search',
          status: 'complete',
        })),
        reload,
      },
      scripting: { executeScript: vi.fn(async () => {}) },
      runtime: { getManifest: () => ({ content_scripts: [{ js: ['assets/loader.js'] }] }) },
    })

    const pending = sendTabMessageWithRetry(9, { type: 'X' }, 2)
    const assertion = expect(pending).rejects.toThrow(/tab is still loading/)
    await vi.advanceTimersByTimeAsync(15_000)
    await assertion

    expect(reload).not.toHaveBeenCalled()
  })
})

describe('扩展启动时主动复活专用后台 tab', () => {
  it('只刷新非活跃的招聘站 tab，跳过活跃页与非招聘站', async () => {
    vi.useFakeTimers()
    const reload = vi.fn(async () => {})
    vi.stubGlobal('chrome', {
      storage: {
        local: {
          get: vi.fn(async () => ({
            [DEDICATED_TABS_KEY]: { liepin: 11, '51job': 12, boss: 13, maimai: 14 },
          })),
        },
      },
      tabs: {
        get: vi.fn(async (id: number) => {
          if (id === 13) return { id, active: true, url: 'https://www.zhipin.com/web/geek/job', status: 'complete' }
          if (id === 14) return { id, active: false, url: 'https://example.com/', status: 'complete' }
          return {
            id,
            active: false,
            url: id === 11 ? 'https://www.liepin.com/zhaopin/' : 'https://we.51job.com/pc/search',
            status: 'complete',
          }
        }),
        reload,
      },
    })

    const pending = reviveDedicatedTabs()
    await vi.advanceTimersByTimeAsync(20_000)
    expect(await pending).toBe(2)
    expect(reload).toHaveBeenCalledTimes(2)
    expect(reload).toHaveBeenCalledWith(11)
    expect(reload).toHaveBeenCalledWith(12)
  })
})

describe('接线契约：通信异常不能判岗位死刑', () => {
  const BG = read('src/background/index.ts')
  const TM = read('src/background/tab-manager.ts')
  const SVC = read('src/background/campaign-service.ts')

  it('通信层真的调用 tabs.reload，且每次发消息最多刷新一次', () => {
    expect(TM).toContain('await chrome.tabs.reload(tabId)')
    expect(TM).toContain('await chrome.tabs.reload(id)')
    expect(TM).toContain('let revived = false')
    expect(TM).toContain('if (stale && !revived)')
    expect(TM).toContain('shouldReloadStaleTab(tab)')
  })

  it('onInstalled 与 onStartup 都走带用户意图闸的统一恢复入口', () => {
    expect((BG.match(/void resumeAutomationIfAllowed\(\)/g) || []).length).toBe(2)
    const helper = BG.slice(
      BG.indexOf('async function resumeAutomationIfAllowed'),
      BG.indexOf('// Listen for installation'),
    )
    // 用户主动关闭 AIbot 后：不注册看门狗、不刷 tab、不恢复调度
    expect(helper).toContain('if (await readUserStopped()) return')
    expect(helper).toContain('await ensureWatchdogAlarm()')
    expect(helper).toContain('await reviveDedicatedTabs().catch(() => 0)')
    expect(helper).toContain('await resumeSchedulerIfNeeded()')
  })

  it('执行侧通信异常标 skipped 保留任务，并清掉连续未定位计数', () => {
    const from = SVC.indexOf('Failed to execute task on tab')
    const block = SVC.slice(from, from + 2200)
    expect(block).toContain('isStaleConnectionError(err)')
    expect(block).toContain("status: 'skipped'")
    expect(block).not.toContain("status: 'failed'")
    expect(block).toContain('consecutiveNotFoundMap[task.platform] = 0')
    expect(block).toContain('已尝试刷新后台页面，待下轮重试')
    expect(block).toContain('任务保留、下轮自动重试')
  })

  it('采集侧失联错误不计入连续失败，不再弹「平台页面改版」误导告警', () => {
    expect(SVC).toContain('页面脚本失联（扩展重载导致），已尝试自动刷新后台页面')
    expect(SVC).toMatch(
      /if \(stale\) \{[\s\S]{0,220}collectErrorStreak\[platform\] = 0[\s\S]{0,120}continue/,
    )
    expect(SVC).toContain('staleConnection: stale')
  })
})
