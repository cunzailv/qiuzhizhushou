import { getSetting } from '../db/settings-store'

export async function randomDelay(min?: number, max?: number): Promise<void> {
  const minDelay = min ?? (await getSetting<number>('minDelay', 2000))
  const maxDelay = max ?? (await getSetting<number>('maxDelay', 8000))
  const delay = Math.floor(Math.random() * (maxDelay - minDelay + 1)) + minDelay
  await new Promise((resolve) => setTimeout(resolve, delay))
}

export async function getScrollDelay(): Promise<number> {
  const base = await getSetting<number>('scrollDelay', 1500)
  return base + Math.random() * 1000
}

export async function shouldThrottle(actionCount: number): Promise<boolean> {
  // 无限制模式：投递数量不再触发节流
  void actionCount
  return false
}
