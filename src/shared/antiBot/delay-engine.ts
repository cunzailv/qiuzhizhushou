import { getSetting } from '../db/settings-store'
import { CONSERVATIVE_VALUES } from '../types/safety-preset'

export async function randomDelay(min?: number, max?: number): Promise<void> {
  // 兜底值统一取保守档，避免设置未写入时按激进间隔跑
  const minDelay = min ?? (await getSetting<number>('minDelay', CONSERVATIVE_VALUES.minDelay))
  const maxDelay = max ?? (await getSetting<number>('maxDelay', CONSERVATIVE_VALUES.maxDelay))
  const delay = Math.floor(Math.random() * (maxDelay - minDelay + 1)) + minDelay
  await new Promise((resolve) => setTimeout(resolve, delay))
}

export async function getScrollDelay(): Promise<number> {
  const base = await getSetting<number>('scrollDelay', CONSERVATIVE_VALUES.scrollDelay)
  return base + Math.random() * 1000
}

export async function shouldThrottle(actionCount: number): Promise<boolean> {
  // 无限制模式：投递数量不再触发节流
  void actionCount
  return false
}
