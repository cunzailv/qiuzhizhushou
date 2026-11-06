// H5 · 本地错误日志：全局捕获 + AI/链路失败点记录
//
// 跨上下文说明：content script 的 IndexedDB 属于「网页域」（如 zhipin.com），
// 与 popup / options / background 的「扩展域」不是同一个库。早期各调用方直接
// recordError() 时，页面里发生的异常写进了网页域 DB，管家「异常留痕」永远看不到。
// 这里增加 chrome.storage.local 共享队列作为跨上下文真源，读写都做合并，
// 配合 error-report.ts 的统一上报入口，保证任何上下文的异常都能被诊断中心读到。
import { db, type ErrorRecord } from './index'

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substring(2)
}

/** 跨上下文共享的兜底错误队列（chrome.storage.local 全上下文可见） */
export const SHARED_ERROR_KEY = 'shared_error_queue_v1'
export const MAX_SHARED_ERRORS = 200

function isValidRecord(row: unknown): row is ErrorRecord {
  if (!row || typeof row !== 'object') return false
  const r = row as Partial<ErrorRecord>
  return typeof r.id === 'string' && typeof r.source === 'string'
    && typeof r.message === 'string' && typeof r.createdAt === 'string'
}

// get-modify-set 不是原子操作：同一次降级会并发触发多条留痕，
// 若三条同时读到同一个旧数组再各自覆盖，最终只剩最后一条 —— 页面上看就是「异常丢了」。
// 用进程内串行链把写入排队，保证同一上下文里的并发上报一条不丢。
let sharedWriteChain: Promise<unknown> = Promise.resolve()

/** 写入共享队列；返回是否写入成功（供上报层决定是否回退本地 Dexie） */
export function appendSharedError(params: {
  source: string
  message: string
  stack?: string
  context?: string
}): Promise<boolean> {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) return Promise.resolve(false)
  const record: ErrorRecord = {
    id: generateId(),
    createdAt: new Date().toISOString(),
    source: params.source.slice(0, 40),
    message: params.message.slice(0, 500),
    stack: params.stack?.slice(0, 1000),
    context: params.context?.slice(0, 1000),
  }
  const task = sharedWriteChain.then(async () => {
    const res = await chrome.storage.local.get(SHARED_ERROR_KEY)
    const prev = Array.isArray(res?.[SHARED_ERROR_KEY]) ? res[SHARED_ERROR_KEY] as ErrorRecord[] : []
    const next = [...prev.filter(isValidRecord), record].slice(-MAX_SHARED_ERRORS)
    await chrome.storage.local.set({ [SHARED_ERROR_KEY]: next })
    return true
  }).catch(() => false)
  sharedWriteChain = task
  return task
}

/** 读取共享队列（无效数据一律跳过，绝不因为脏数据让诊断中心白屏） */
export async function readSharedErrors(): Promise<ErrorRecord[]> {
  try {
    if (typeof chrome === 'undefined' || !chrome.storage?.local) return []
    const res = await chrome.storage.local.get(SHARED_ERROR_KEY)
    const list = res?.[SHARED_ERROR_KEY]
    if (!Array.isArray(list)) return []
    return list.filter(isValidRecord)
  } catch {
    return []
  }
}

export async function clearSharedErrors(): Promise<void> {
  // 先等在途写入落地，否则清空后又被并发上报写回一条「残影」
  await sharedWriteChain.catch(() => undefined)
  try {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      await chrome.storage.local.remove(SHARED_ERROR_KEY)
    }
  } catch {
    // ignore
  }
}

/** 合并扩展域 Dexie + 共享队列，按 id 去重、按时间倒序 */
async function mergedErrors(): Promise<ErrorRecord[]> {
  let local: ErrorRecord[] = []
  try {
    local = await db.errors.toArray()
  } catch {
    local = []
  }
  const shared = await readSharedErrors()
  const seen = new Set<string>()
  const all = [...local, ...shared].filter((r) => {
    if (!isValidRecord(r) || seen.has(r.id)) return false
    seen.add(r.id)
    return true
  })
  // 与 Dexie 的 orderBy('createdAt').reverse() 语义一致：
  // 时间倒序；同一毫秒内按主键倒序（新写入的记录排在前面），
  // 否则 listErrors(10) 会把刚发生的异常挤出诊断中心首页。
  return all.sort((a, b) => {
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0
  })
}

/**
 * 同一错误的去重窗口。
 * 注意：不能对所有调用方默认去重 —— 管家的「待修清单」依赖同一事件被记录多次
 * 来统计出现频次（occurrences）。只对 AI 这类高频噪音来源按调用方开启。
 */
const DEFAULT_DEDUPE_WINDOW_MS = 60_000
const recentErrorSigs = new Map<string, number>()

/** 测试用：清空进程内去重状态，避免用例之间互相干扰 */
export function resetErrorDedupeState(): void {
  recentErrorSigs.clear()
}

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

/** 全部错误日志（倒序）：扩展域 Dexie + 各上下文共享队列 */
export async function listErrors(limit = 100): Promise<ErrorRecord[]> {
  const all = await mergedErrors()
  return all.slice(0, limit)
}

export async function getErrorCount(): Promise<number> {
  const all = await mergedErrors()
  return all.length
}

export async function clearErrors(): Promise<void> {
  try {
    await db.errors.clear()
  } catch {
    // ignore
  }
  await clearSharedErrors()
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
