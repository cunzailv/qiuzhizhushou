// @vitest-environment jsdom
// 悬浮窗 / AIbot 统一控制状态回归：
// 1) 状态单一真源与防回环  2) 自愈清理不误伤扩展浮窗  3) 浮窗展开/右侧收缩/关闭三态
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_ASSISTANT_STATE,
  getAssistantState,
  patchAssistantState,
  subscribeAssistantState,
  isAssistantTaskCancelled,
  normalizeInitialPanelState,
} from '../src/shared/assistant-state'
import { dismissUnexpectedModals } from '../src/shared/platform/boss/action-simulator'
import { createFloatingPanel, setPanelState } from '../src/content/inject-ui'

type ChangeListener = (changes: Record<string, unknown>, area: string) => void

let store: Record<string, unknown> = {}
let setCalls = 0
const listeners: ChangeListener[] = []

beforeEach(() => {
  store = {}
  setCalls = 0
  listeners.length = 0
  document.body.innerHTML = ''
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    cb(0)
    return 0
  })
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: async (key: string | string[] | null) => {
          if (key === null) return { ...store }
          if (Array.isArray(key)) {
            return Object.fromEntries(key.filter((k) => k in store).map((k) => [k, store[k]]))
          }
          return key in store ? { [key]: store[key] } : {}
        },
        set: async (patch: Record<string, unknown>) => {
          setCalls++
          Object.assign(store, patch)
        },
      },
      onChanged: {
        addListener: (fn: ChangeListener) => listeners.push(fn),
        removeListener: (fn: ChangeListener) => {
          const index = listeners.indexOf(fn)
          if (index >= 0) listeners.splice(index, 1)
        },
      },
    },
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('统一控制状态', () => {
  it('默认展开、批量沟通、启用评分', async () => {
    expect(await getAssistantState()).toEqual(DEFAULT_ASSISTANT_STATE)
  })

  it('写入模式与浮窗形态后可被重新读出', async () => {
    const state = await patchAssistantState({
      applyMode: 'recommend',
      panelState: 'collapsed',
    })
    expect(state.applyMode).toBe('recommend')
    expect(state.panelState).toBe('collapsed')
    expect(store.setting_applyMode).toBe('recommend')
    expect(store.setting_panelState).toBe('collapsed')
  })

  it('相同值不重复写入，避免 storage.onChanged 回环', async () => {
    await patchAssistantState({ applyMode: 'recommend' })
    const before = setCalls
    await patchAssistantState({ applyMode: 'recommend' })
    expect(setCalls).toBe(before)
  })

  it('订阅者能收到状态变化并可取消订阅', async () => {
    const spy = vi.fn()
    const off = subscribeAssistantState(spy)
    expect(listeners).toHaveLength(1)

    await patchAssistantState({ enableAiMatch: false })
    listeners[0]({ setting_enableAiMatch: { oldValue: true, newValue: false } }, 'local')
    await vi.waitFor(() => expect(spy).toHaveBeenCalled())
    expect(spy.mock.calls[0][0].enableAiMatch).toBe(false)

    off()
    expect(listeners).toHaveLength(0)
  })
})

describe('自愈清理白名单', () => {
  it('不隐藏扩展自有浮窗，但仍会隐藏页面高 z-index 遮罩', () => {
    const panel = document.createElement('div')
    panel.id = 'boss-assistant-panel'
    panel.style.cssText = 'position:fixed;z-index:99999;width:320px;height:200px'

    const overlay = document.createElement('div')
    overlay.id = 'page-overlay'
    overlay.style.cssText = 'position:fixed;z-index:2000;width:100px;height:100px'

    document.body.append(panel, overlay)
    for (const el of [panel, overlay]) {
      Object.defineProperty(el, 'offsetWidth', { value: 100, configurable: true })
      Object.defineProperty(el, 'offsetHeight', { value: 100, configurable: true })
      Object.defineProperty(el, 'getClientRects', {
        value: () => [{ width: 100 }],
        configurable: true,
      })
    }

    dismissUnexpectedModals(document)

    expect(panel.style.display).not.toBe('none')
    expect(overlay.style.display).toBe('none')
  })
})

describe('悬浮窗三态', () => {
  it('收缩到右侧、展开、关闭均可切换且保留重新打开入口', () => {
    const host = createFloatingPanel()
    const shadow = host.shadowRoot!
    const panel = shadow.querySelector('.panel') as HTMLElement

    setPanelState(host, 'collapsed')
    const handle = shadow.getElementById('edge-handle') as HTMLElement
    expect(host.style.right).toBe('0px')
    expect(host.style.width).toBe('30px')
    expect(panel.style.display).toBe('none')
    expect(handle.style.display).toBe('flex')

    setPanelState(host, 'expanded')
    expect(panel.style.display).toBe('')
    expect(handle.style.display).toBe('none')

    setPanelState(host, 'closed')
    expect(host.style.display).toBe('none')
    expect(document.getElementById('boss-assistant-trigger')).not.toBeNull()
  })
})

describe('关闭竞态防护', () => {
  it('本地取消标记置位时立即取消任务', () => {
    expect(isAssistantTaskCancelled(DEFAULT_ASSISTANT_STATE, true)).toBe(true)
  })

  it('统一状态为 closed 时，即使新任务重置了本地标记也照样取消', () => {
    const closed = { ...DEFAULT_ASSISTANT_STATE, panelState: 'closed' as const }
    expect(isAssistantTaskCancelled(closed, false)).toBe(true)
  })

  it('展开 / 右侧收缩状态下不误取消正在执行的任务', () => {
    expect(isAssistantTaskCancelled(DEFAULT_ASSISTANT_STATE, false)).toBe(false)
    const collapsed = { ...DEFAULT_ASSISTANT_STATE, panelState: 'collapsed' as const }
    expect(isAssistantTaskCancelled(collapsed, false)).toBe(false)
  })
})

describe('关闭状态不跨页面持久化', () => {
  it('读取到 closed 时恢复为展开，其它形态保持不变', () => {
    const closed = { ...DEFAULT_ASSISTANT_STATE, panelState: 'closed' as const }
    expect(normalizeInitialPanelState(closed).panelState).toBe('expanded')
    expect(normalizeInitialPanelState(DEFAULT_ASSISTANT_STATE).panelState).toBe('expanded')
    const collapsed = { ...DEFAULT_ASSISTANT_STATE, panelState: 'collapsed' as const }
    expect(normalizeInitialPanelState(collapsed).panelState).toBe('collapsed')
  })
})
