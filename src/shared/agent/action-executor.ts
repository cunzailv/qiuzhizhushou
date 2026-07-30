import type { AgentAction, ActionTarget } from './types'

function findByText(text: string): Element | null {
  // Exact match first, then includes
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
  await new Promise(r => setTimeout(r, 300))

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
  await new Promise(r => setTimeout(r, 200))

  // React synthetic event bypass
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
  await new Promise(r => setTimeout(r, 300))
  return true
}

/** 执行一个 AI 返回的动作 */
export async function executeAction(action: AgentAction): Promise<{ ok: boolean; error?: string }> {
  try {
    switch (action.type) {
      case 'click': {
        if (!action.target) return { ok: false, error: 'click 缺少 target' }
        const ok = await clickElement(action.target)
        if (!ok) return { ok: false, error: `未找到目标元素: ${action.target.value}` }
        return { ok: true }
      }
      case 'type': {
        if (!action.target || !action.text) return { ok: false, error: 'type 缺少 target 或 text' }
        const ok = await typeText(action.target, action.text)
        if (!ok) return { ok: false, error: `未找到输入框: ${action.target.value}` }
        return { ok: true }
      }
      case 'wait': {
        await new Promise(r => setTimeout(r, action.duration || 2000))
        return { ok: true }
      }
      case 'scroll': {
        window.scrollTo({ top: action.scrollTo === 'top' ? 0 : document.documentElement.scrollHeight, behavior: 'instant' })
        await new Promise(r => setTimeout(r, 500))
        return { ok: true }
      }
      case 'press_enter': {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
        await new Promise(r => setTimeout(r, 500))
        return { ok: true }
      }
      case 'press_escape': {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
        await new Promise(r => setTimeout(r, 500))
        return { ok: true }
      }
      case 'done': {
        return { ok: true }
      }
      default:
        return { ok: false, error: `未知动作类型: ${(action as any).type}` }
    }
  } catch (err: any) {
    return { ok: false, error: err?.message || '执行失败' }
  }
}
