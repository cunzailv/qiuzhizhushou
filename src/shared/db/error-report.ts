// 统一异常留痕入口 · 任何扩展上下文都调这里
//
// 背景：content script（网页域）、popup / options / iframe 侧栏（扩展域）、
// background service worker 各自持有不同的 IndexedDB。直接写 db.errors 会让
// 页面里发生的异常「留了但看不见」。这里把上报收敛成一条链路：
//
//   业务代码 → reportError() → runtime.sendMessage(RECORD_ERROR) → background 写扩展域 Dexie
//                            └→ 无接收方 / 转发失败 → chrome.storage.local 共享队列兜底
//                                                  └→ storage 也不可用 → 本地 Dexie 兜底
//
// 诊断中心（管家「异常留痕」Tab）通过 error-store.listErrors() 合并读取两者，
// 因此无论错误发生在哪个上下文、background 是否在休眠，都不会丢。
//
// 约束：留痕链路绝不向业务主链路抛异常；所有失败都是尽力而为。

import { recordError, appendSharedError, shouldSkipDuplicate } from './error-store'

export interface ErrorReportParams {
  source: string
  message: string
  stack?: string
  /** 现场上下文，序列化后的字符串；严禁写入 API Key / token 等敏感值 */
  context?: string
  /** 传入即启用去重：窗口内相同 source+message 只留一条，避免 AI 失败刷屏 */
  dedupeWindowMs?: number
}

/** 统一上报一条异常/降级事件，永不抛错 */
export async function reportError(params: ErrorReportParams): Promise<void> {
  try {
    if (!params?.source || !params?.message) return
    if (params.dedupeWindowMs
      && shouldSkipDuplicate(params.source, params.message, params.dedupeWindowMs)) return

    // 去重已在上面做过一次：本地 recordError 不能再带 dedupeWindowMs，
    // 否则它会二次命中同一签名、把整条错误吞掉（曾导致 AI 500 错误一条都查不到）。
    const local = {
      source: params.source,
      message: params.message,
      stack: params.stack,
      context: params.context,
    }

    // 无扩展 API（单测 / Node 环境）：直接写本地库，不插入多余的异步层，
    // 保证「调用方返回后立刻查库能查到」，与旧 recordError 的时序一致。
    if (typeof chrome === 'undefined') {
      await recordError(local)
      return
    }

    let delivered = false
    try {
      if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
        const res = await chrome.runtime.sendMessage({
          type: 'RECORD_ERROR',
          payload: {
            source: params.source,
            message: params.message,
            stack: params.stack,
            context: params.context,
            dedupeWindowMs: params.dedupeWindowMs,
          },
        })
        delivered = !!res?.success
      }
    } catch {
      // background 休眠 / 无接收方：走共享队列兜底
      delivered = false
    }
    if (delivered) return

    const stored = await appendSharedError(params)
    if (!stored) await recordError(local)
  } catch {
    // 留痕本身失败不影响业务
  }
}

/** 不阻塞主链路的 fire-and-forget 版本 */
export function reportErrorAsync(params: ErrorReportParams): void {
  void reportError(params)
}
