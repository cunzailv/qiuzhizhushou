// @vitest-environment jsdom
/**
 * 用户反馈：「为什么我们的侧边栏是浮窗呢，我看别人的侧边栏是直接把内容顶过去左边的」。
 *
 * 根因不是 UI 没写好，而是 `inject-ui.tsx` 的侧栏是 `position: fixed` + 高 z-index
 * 的浮层，脱离文档流，宿主页面感知不到它。这里做增量版「挤压模式」开关：
 * 默认关闭保持原浮层；打开后给 html 注入 padding-right，让网页内容把右侧宽度让出来。
 *
 * 本文件锁死：① 默认不侵入宿主页面；② 只有「开关开 + 侧栏展开 + 未停机 + 视口够宽」
 * 才挤压；③ 收起 / 关闭立刻撤销，不留空白带；④ SPA 重写 class / 删 style 能自愈。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  buildPushLayoutCss,
  shouldApplyPushLayout,
  applyPushLayout,
  isPushLayoutActive,
  readPushLayoutSetting,
  writePushLayoutSetting,
  subscribePushLayout,
  PUSH_LAYOUT_HTML_CLASS,
  PUSH_LAYOUT_STYLE_ID,
  PUSH_RESERVED_PX,
  PUSH_MIN_VIEWPORT_PX,
  PUSH_LAYOUT_KEY,
} from '../src/shared/sidebar-layout'

const ROOT = process.cwd()
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf-8')
const CONTENT = 'src/content/index.ts'
const UI = 'src/content/inject-ui.tsx'

const store: Record<string, unknown> = {}
const changeListeners: Array<(...args: any[]) => void> = []

beforeEach(() => {
  for (const k of Object.keys(store)) delete store[k]
  changeListeners.length = 0
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: vi.fn(async (key: string) => ({ [key]: store[key] })),
        set: vi.fn(async (obj: Record<string, unknown>) => { Object.assign(store, obj) }),
      },
      onChanged: {
        addListener: vi.fn((fn: (...args: any[]) => void) => { changeListeners.push(fn) }),
        removeListener: vi.fn((fn: (...args: any[]) => void) => {
          const i = changeListeners.indexOf(fn)
          if (i >= 0) changeListeners.splice(i, 1)
        }),
      },
    },
  })
  applyPushLayout(false)
  document.documentElement.className = ''
  document.getElementById(PUSH_LAYOUT_STYLE_ID)?.remove()
})
afterEach(() => vi.unstubAllGlobals())

const base = (over: Partial<Parameters<typeof shouldApplyPushLayout>[0]> = {}) => ({
  enabled: true,
  panelState: 'expanded',
  userStopped: false,
  viewportWidth: 1600,
  ...over,
})

describe('挤压开关的纯决策 shouldApplyPushLayout', () => {
  it('默认（开关关闭）不侵入宿主页面，保持原有浮层', () => {
    expect(shouldApplyPushLayout(base({ enabled: false }))).toBe(false)
  })

  it('开关开 + 侧栏展开 + 视口够宽 → 挤压', () => {
    expect(shouldApplyPushLayout(base())).toBe(true)
  })

  it.each(['bubble', 'collapsed', 'closed'])('侧栏形态 %s 不挤压，避免网页留空白带', (panelState) => {
    expect(shouldApplyPushLayout(base({ panelState }))).toBe(false)
  })

  it('用户已关闭 AIbot 时不挤压（沿用停机总闸语义）', () => {
    expect(shouldApplyPushLayout(base({ userStopped: true }))).toBe(false)
  })

  it('视口过窄时退回浮层，不把岗位列表压成一条', () => {
    expect(shouldApplyPushLayout(base({ viewportWidth: PUSH_MIN_VIEWPORT_PX - 1 }))).toBe(false)
    expect(shouldApplyPushLayout(base({ viewportWidth: PUSH_MIN_VIEWPORT_PX }))).toBe(true)
  })
})

describe('注入样式 buildPushLayoutCss', () => {
  const css = buildPushLayoutCss(PUSH_RESERVED_PX)

  it('用 html 的 padding-right + border-box 收窄内容区', () => {
    expect(css).toContain(`padding-right: ${PUSH_RESERVED_PX}px !important`)
    expect(css).toContain('box-sizing: border-box !important')
    expect(css).toContain(`html.${PUSH_LAYOUT_HTML_CLASS}`)
  })

  it('不用 margin-right / overflow-x，避免 100vw 元素撑出横向滚动条或裁掉浮层', () => {
    expect(css).not.toContain('margin-right')
    expect(css).not.toContain('overflow-x')
  })

  it('窄屏媒体查询把挤压关掉，且不引入渐变 / 发光 / 动效', () => {
    expect(css).toContain(`@media (max-width: ${PUSH_MIN_VIEWPORT_PX - 1}px)`)
    expect(css).not.toMatch(/linear-gradient|drop-shadow|@keyframes/)
  })

  it('宽度是纯计算，负数与小数都被规整', () => {
    expect(buildPushLayoutCss(0)).toContain('padding-right: 0px')
    expect(buildPushLayoutCss(-10)).toContain('padding-right: 0px')
    expect(buildPushLayoutCss(455.6)).toContain('padding-right: 456px')
  })
})

describe('DOM 效果与自愈', () => {
  it('开启时加 class 与 style；关闭时两个都清干净', () => {
    applyPushLayout(true)
    expect(document.documentElement.classList.contains(PUSH_LAYOUT_HTML_CLASS)).toBe(true)
    expect(document.getElementById(PUSH_LAYOUT_STYLE_ID)?.textContent).toContain('padding-right')
    expect(isPushLayoutActive()).toBe(true)

    applyPushLayout(false)
    expect(document.documentElement.classList.contains(PUSH_LAYOUT_HTML_CLASS)).toBe(false)
    expect(document.getElementById(PUSH_LAYOUT_STYLE_ID)).toBeNull()
    expect(isPushLayoutActive()).toBe(false)
  })

  it('SPA 重写 html class 后自动补回', async () => {
    applyPushLayout(true)
    document.documentElement.className = 'site-router-active'
    await new Promise((r) => setTimeout(r, 0))
    expect(document.documentElement.classList.contains(PUSH_LAYOUT_HTML_CLASS)).toBe(true)
  })

  it('站点清掉注入的 style 后自动补回', async () => {
    applyPushLayout(true)
    document.getElementById(PUSH_LAYOUT_STYLE_ID)?.remove()
    await new Promise((r) => setTimeout(r, 0))
    expect(document.getElementById(PUSH_LAYOUT_STYLE_ID)).not.toBeNull()
  })

  it('关闭后自愈观察器停掉，站点改 class 不会自己又把挤压打开', async () => {
    applyPushLayout(true)
    applyPushLayout(false)
    document.documentElement.className = ''
    await new Promise((r) => setTimeout(r, 0))
    expect(document.documentElement.classList.contains(PUSH_LAYOUT_HTML_CLASS)).toBe(false)
    expect(document.getElementById(PUSH_LAYOUT_STYLE_ID)).toBeNull()
  })
})

describe('设置持久化与跨标签页同步', () => {
  it('未设置时默认关闭；写入后能读回', async () => {
    expect(await readPushLayoutSetting()).toBe(false)
    await writePushLayoutSetting(true)
    expect(store[`setting_${PUSH_LAYOUT_KEY}`]).toBe(true)
    expect(await readPushLayoutSetting()).toBe(true)
  })

  it('订阅只响应本设置的 local 变更', async () => {
    const listener = vi.fn()
    const off = subscribePushLayout(listener)
    expect(changeListeners).toHaveLength(1)

    // onChanged 触发时 storage 里已经是新值；订阅实现读的是 storage 真源而非 payload
    await writePushLayoutSetting(true)
    changeListeners[0]({ [`setting_${PUSH_LAYOUT_KEY}`]: { newValue: true } }, 'local')
    await new Promise((r) => setTimeout(r, 0))
    expect(listener).toHaveBeenCalledWith(true)

    listener.mockClear()
    changeListeners[0]({ setting_somethingElse: { newValue: 1 } }, 'local')
    changeListeners[0]({ [`setting_${PUSH_LAYOUT_KEY}`]: { newValue: false } }, 'sync')
    await new Promise((r) => setTimeout(r, 0))
    expect(listener).not.toHaveBeenCalled()

    off()
    expect(changeListeners).toHaveLength(0)
  })
})

describe('界面接线静态契约', () => {
  it('侧栏头部有可见开关，点击会发消息（不是只停在配置层）', () => {
    const ui = read(UI)
    expect(ui).toContain('id="btn-push"')
    expect(ui).toContain('BOSS_ASSISTANT_TOGGLE_PUSH_LAYOUT')
    expect(ui).toContain('export function setPushLayoutActive')
    expect(ui.indexOf('id="btn-push"')).toBeLessThan(ui.indexOf('class="btn-header btn-header-stop"'))
  })

  it('content 在形态变化 / 关机 / 开关切换 / resize 时都重算挤压', () => {
    const c = read(CONTENT)
    expect(c).toContain('async function refreshPushLayout(panelStateOverride?: PanelState)')
    expect(c).toContain('void refreshPushLayout().catch(() => {})')
    expect(c).toContain('subscribePushLayout(')
    expect(c).toContain("window.addEventListener('resize'")
    expect(c).toContain('BOSS_ASSISTANT_TOGGLE_PUSH_LAYOUT')
    expect(c).toContain('writePushLayoutSetting(next)')
    expect(c).toContain('setPushLayoutActive(panelHost, enabled)')
    // 停机路径也要撤销挤压
    const shutdown = c.slice(c.indexOf('function markAssistantShutdown()'), c.indexOf('function shutdownAssistantFromPanel()'))
    expect(shutdown).toContain('refreshPushLayout()')
  })

  it('默认关闭时不改变宿主页面布局（原有浮层语义）', () => {
    expect(read('src/shared/sidebar-layout.ts')).toContain('PUSH_LAYOUT_DEFAULT = false')
  })
})
