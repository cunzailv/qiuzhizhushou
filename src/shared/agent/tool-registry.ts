// E1 · 声明式工具注册表（Harness 工具系统）
// 把 DOM 操作抽象为「名称 + 入参校验 + 执行 + 结果回传」的统一协议。
// 与 action-executor 的旧 7 类动作兼容，返回结构化结果供 ReAct 循环与审计使用。

import type { ActionTarget, AgentAction, ActionType } from './types'

export interface ToolResult<T = unknown> {
  ok: boolean
  result?: T
  error?: string
  durationMs: number
  needsConfirm?: boolean
}

export interface ToolContext {
  /** 平台标识，如 boss / liepin / 51job */
  platform: string
  pageType: string
  goal: string
}

export interface ToolDefinition<TPayload = Record<string, unknown>> {
  name: string
  description: string
  /** 参数校验：返回 null 表示通过，否则返回错误信息 */
  validate?: (payload: unknown) => string | null
  execute: (payload: TPayload, ctx: ToolContext) => Promise<Omit<ToolResult, 'durationMs'>>
}

// ─── 内置工具注册表 ───

const registry = new Map<string, ToolDefinition>()

export function registerTool(def: ToolDefinition): void {
  registry.set(def.name, def)
}

export function getTool(name: string): ToolDefinition | undefined {
  return registry.get(name)
}

export function listTools(): string[] {
  return [...registry.keys()]
}

// ─── 基础工具：与 action-executor 7 类动作对应 ───

function findByText(text: string): Element | null {
  const all = document.querySelectorAll('button, [role="button"], a, span[class*="btn"]')
  for (const el of all) {
    if ((el.textContent || '').replace(/\s+/g, ' ').trim() === text) return el
  }
  for (const el of all) {
    if ((el.textContent || '').replace(/\s+/g, ' ').trim().includes(text)) return el
  }
  return null
}

function findByIndex(index: number): Element | null {
  const all = document.querySelectorAll('button, [role="button"], a[class*="btn"], a.btn')
  return all[index] || null
}

function findByCss(selector: string): Element | null {
  try {
    return document.querySelector(selector)
  } catch {
    return null
  }
}

function resolveTarget(target: ActionTarget): Element | null {
  switch (target.kind) {
    case 'button_text': return findByText(target.value)
    case 'button_index': return findByIndex(parseInt(target.value, 10))
    case 'css_selector': return findByCss(target.value)
    default: return null
  }
}

function getClickable(el: Element): HTMLElement {
  if (el instanceof HTMLElement && ['BUTTON', 'A'].includes(el.tagName)) return el
  const parent = el.closest('button, a, [role="button"]') as HTMLElement | null
  return parent || (el as HTMLElement)
}

async function clickElement(target: ActionTarget): Promise<boolean> {
  const el = resolveTarget(target)
  if (!el) return false
  const clickable = getClickable(el)
  clickable.scrollIntoView({ block: 'center', behavior: 'instant' })
  await new Promise((r) => setTimeout(r, 300))
  try {
    clickable.click()
    clickable.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
    return true
  } catch {
    return false
  }
}

async function typeText(target: ActionTarget, text: string): Promise<boolean> {
  const el = resolveTarget(target)
  if (!el || !(el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement)) return false
  el.scrollIntoView({ block: 'center' })
  el.focus()
  await new Promise((r) => setTimeout(r, 200))
  const proto = Object.getPrototypeOf(el)
  const setter = (Object.getOwnPropertyDescriptor(proto, 'value')?.set
    || Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set) as ((v: string) => void) | undefined
  if (setter) {
    setter.call(el, text)
  } else {
    ;(el as HTMLInputElement).value = text
  }
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
  await new Promise((r) => setTimeout(r, 300))
  return true
}

// 工具实现：click / type / wait / scroll / press_enter / press_escape / done
function normalizeTarget(payload: unknown): ActionTarget | null {
  const p = payload as { kind?: string; value?: string }
  if (!p || typeof p.value !== 'string') return null
  const kind = p.kind || 'button_text'
  if (!['button_text', 'button_index', 'input_index', 'css_selector'].includes(kind)) return null
  return { kind: kind as ActionTarget['kind'], value: p.value }
}

registerTool({
  name: 'click',
  description: '点击按钮/链接（按文本、索引或 CSS 选择器）',
  validate: (payload) => {
    if (!normalizeTarget(payload)) return 'click 缺少合法 target（需要 kind + value）'
    return null
  },
  execute: async (payload) => {
    const target = normalizeTarget(payload)!
    const ok = await clickElement(target)
    return ok
      ? { ok: true, result: { clicked: target.value } }
      : { ok: false, error: `未找到目标元素: ${target.value}` }
  },
})

registerTool({
  name: 'type',
  description: '向输入框输入文本（含 React 合成事件兼容）',
  validate: (payload) => {
    const p = payload as { target?: unknown; text?: string }
    if (!normalizeTarget(p.target)) return 'type 缺少合法 target'
    if (typeof p.text !== 'string' || p.text.length === 0) return 'type 缺少 text'
    return null
  },
  execute: async (payload) => {
    const p = payload as { target: unknown; text: string }
    const target = normalizeTarget(p.target)!
    const ok = await typeText(target, p.text)
    return ok
      ? { ok: true, result: { typedLength: p.text.length } }
      : { ok: false, error: `未找到输入框: ${target.value}` }
  },
})

registerTool({
  name: 'wait',
  description: '等待指定时长（毫秒），用于页面加载/动画',
  validate: (payload) => {
    const p = payload as { duration?: number }
    if (typeof p.duration !== 'number' || p.duration <= 0) return 'wait 缺少合法 duration(ms)'
    return null
  },
  execute: async (payload) => {
    const p = payload as { duration: number }
    await new Promise((r) => setTimeout(r, p.duration))
    return { ok: true, result: { waitedMs: p.duration } }
  },
})

registerTool({
  name: 'scroll',
  description: '滚动到页面顶部或底部',
  validate: (payload) => {
    const p = payload as { scrollTo?: string }
    if (!['top', 'bottom'].includes(p.scrollTo || '')) return 'scroll 缺少合法 scrollTo(top|bottom)'
    return null
  },
  execute: async (payload) => {
    const p = payload as { scrollTo: 'top' | 'bottom' }
    window.scrollTo({ top: p.scrollTo === 'top' ? 0 : document.documentElement.scrollHeight, behavior: 'instant' })
    await new Promise((r) => setTimeout(r, 500))
    return { ok: true, result: { scrollTo: p.scrollTo } }
  },
})

registerTool({
  name: 'press_enter',
  description: '按下回车键（发送消息场景）',
  execute: async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await new Promise((r) => setTimeout(r, 500))
    return { ok: true, result: { pressed: 'Enter' } }
  },
})

registerTool({
  name: 'press_escape',
  description: '按下 Esc 键（关闭弹窗场景）',
  execute: async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await new Promise((r) => setTimeout(r, 500))
    return { ok: true, result: { pressed: 'Escape' } }
  },
})

registerTool({
  name: 'done',
  description: '任务完成标记（不产生页面动作）',
  execute: async () => ({ ok: true, result: { done: true } }),
})

// ─── 兼容层：AgentAction → Tool 调用 ───

export function actionToToolCall(action: AgentAction): { tool: string; payload: Record<string, unknown> } | null {
  const base: Record<string, unknown> = {}
  switch (action.type) {
    case 'click':
      if (!action.target) return null
      return { tool: 'click', payload: { kind: action.target.kind, value: action.target.value } }
    case 'type':
      if (!action.target) return null
      return { tool: 'type', payload: { kind: action.target.kind, value: action.target.value, text: action.text } }
    case 'wait':
      return { tool: 'wait', payload: { duration: action.duration || 2000 } }
    case 'scroll':
      return { tool: 'scroll', payload: { scrollTo: action.scrollTo || 'bottom' } }
    case 'press_enter':
      return { tool: 'press_enter', payload: base }
    case 'press_escape':
      return { tool: 'press_escape', payload: base }
    case 'done':
      return { tool: 'done', payload: base }
    default:
      return null
  }
}

export const ACTION_TO_GOAL_HINT: Record<ActionType, string> = {
  click: 'click',
  type: 'type',
  wait: 'wait',
  scroll: 'scroll',
  press_enter: 'press_enter',
  press_escape: 'press_escape',
  done: 'done',
}
