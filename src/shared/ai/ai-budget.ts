// C4 · AI 调用成本护栏：每日调用预算上限，超限自动回退本地（返回空串由调用方兜底）。
// 无 chrome.storage 的环境（单测）使用内存回退计数。
import { getSetting, setSetting } from '../db/settings-store'

const DEFAULT_DAILY_BUDGET = 50

let memoryDate = ''
let memoryCount = 0

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

export async function getAiBudgetLimit(): Promise<number> {
  const limit = await getSetting<number>('aiDailyBudget', DEFAULT_DAILY_BUDGET)
  return limit > 0 ? limit : DEFAULT_DAILY_BUDGET
}

/** 今日已用 AI 调用次数（跨上下文共享：chrome.storage.local） */
export async function getAiUsageToday(): Promise<number> {
  const date = today()
  try {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      const stored = await chrome.storage.local.get(['ai_budget_date', 'ai_budget_count'])
      if (stored.ai_budget_date !== date) return 0
      return Number(stored.ai_budget_count ?? 0)
    }
  } catch {
    // ignore
  }
  if (memoryDate !== date) {
    memoryDate = date
    memoryCount = 0
  }
  return memoryCount
}

/** 记录一次 AI 调用；返回剩余次数（<0 表示已超限） */
export async function consumeAiCall(): Promise<number> {
  const limit = await getAiBudgetLimit()
  const used = await getAiUsageToday()
  const next = used + 1
  const date = today()
  try {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      await chrome.storage.local.set({
        ai_budget_date: date,
        ai_budget_count: next,
      })
    }
  } catch {
    // ignore
  }
  memoryDate = date
  memoryCount = next
  return limit - next
}

/** 预算是否耗尽（true 时调用方应回退本地逻辑） */
export async function isAiBudgetExhausted(): Promise<boolean> {
  return (await getAiUsageToday()) >= (await getAiBudgetLimit())
}

/** 重置今日预算计数（测试/用户手动重置用） */
export async function resetAiBudget(): Promise<void> {
  const date = today()
  try {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      await chrome.storage.local.set({ ai_budget_date: date, ai_budget_count: 0 })
    }
  } catch {
    // ignore
  }
  memoryDate = date
  memoryCount = 0
}

export { DEFAULT_DAILY_BUDGET }
