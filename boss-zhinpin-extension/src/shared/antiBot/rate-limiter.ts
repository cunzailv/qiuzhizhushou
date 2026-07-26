let todayCount = 0

// 每日投递已改为无限制。以下辅助函数保留以保证接口兼容，
// 但不再对投递循环进行拦截或中断。
export async function checkDailyLimit(): Promise<{ allowed: boolean; remaining: number }> {
  return {
    allowed: true,
    remaining: Number.MAX_SAFE_INTEGER,
  }
}

export async function incrementCounter(): Promise<void> {
  todayCount++
}

export function isLimitReached(): boolean {
  return false
}

export function resetDailyCounter(): void {
  todayCount = 0
}
