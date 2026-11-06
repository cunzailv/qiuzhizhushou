// H5 · 本地错误日志：全局捕获 + AI/链路失败点记录
import { db, type ErrorRecord } from './index'

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substring(2)
}

/**
 * 同一错误的去重窗口。
 * 注意：不能对所有调用方默认去重 —— 管家的「待修清单」依赖同一事件被记录多次
 * 来统计出现频次（occurrences）。只对 AI 这类高频噪音来源按调用方开启。
 */
const DEFAULT_DEDUPE_WINDOW_MS = 60_000
const recentErrorSigs = new Map<string, number>()

/** 判断该错误是否落在去重窗口内（导出以便单测，纯内存不触碰存储） */
export function shouldSkipDuplicate(
  source: string,
  message: string,
  windowMs = DEFAULT_DEDUPE_WINDOW_MS,
): boolean {
  const now = Date.now()
  if (recentErrorSigs.size > 200) {
    for (const [k, at] of recentErrorSigs) {
      if (now - at > windowMs) recentErrorSigs.delete(k)
    }
  }
  const sig = `${source}|${message.slice(0, 120)}`
  const last = recentErrorSigs.get(sig)
  if (last !== undefined && now - last < windowMs) return true
  recentErrorSigs.set(sig, now)
  return false
}

/** 记录一条错误（供全局捕获与业务失败点调用） */
export async function recordError(params: {
  source: string
  message: string
  stack?: string
  context?: string
  /** 传入即启用去重：窗口内相同 source+message 只落库一次（用于 AI 降级等高频噪音） */
  dedupeWindowMs?: number
}): Promise<void> {
  if (params.dedupeWindowMs && shouldSkipDuplicate(params.source, params.message, params.dedupeWindowMs)) {
    return
  }
  try {
    const record: ErrorRecord = {
      id: generateId(),
      createdAt: new Date().toISOString(),
      source: params.source.slice(0, 40),
      message: params.message.slice(0, 500),
      stack: params.stack?.slice(0, 1000),
      context: params.context?.slice(0, 1000),
    }
    await db.errors.add(record)
    // 只保留最近 200 条，防止无限增长
    const all = await db.errors.orderBy('createdAt').reverse().toArray()
    if (all.length > 200) {
      const toDelete = all.slice(200)
      for (const r of toDelete) await db.errors.delete(r.id)
    }
  } catch {
    // 错误日志本身失败不影响主链路
  }
}

/** 全部错误日志（倒序） */
export async function listErrors(limit = 100): Promise<ErrorRecord[]> {
  try {
    const all = await db.errors.orderBy('createdAt').reverse().toArray()
    return all.slice(0, limit)
  } catch {
    return []
  }
}

export async function getErrorCount(): Promise<number> {
  try {
    return await db.errors.count()
  } catch {
    return 0
  }
}

export async function clearErrors(): Promise<void> {
  try {
    await db.errors.clear()
  } catch {
    // ignore
  }
}

/** 安装全局错误捕获（window error / unhandledrejection），幂等 */
export function installGlobalErrorCapture(): void {
  if (typeof window === 'undefined') return
  const installed = (window as unknown as Record<string, unknown>).__qzErrorInstalled
  if (installed) return
  ;(window as unknown as Record<string, unknown>).__qzErrorInstalled = true

  window.addEventListener('error', (e) => {
    void recordError({
      source: 'window',
      message: e.message || String(e.error?.message ?? e.error ?? 'unknown'),
      stack: e.error?.stack,
    })
  })

  window.addEventListener('unhandledrejection', (e) => {
    const reason = e.reason
    void recordError({
      source: 'promise',
      message: reason?.message || String(reason),
      stack: reason?.stack,
    })
  })
}
