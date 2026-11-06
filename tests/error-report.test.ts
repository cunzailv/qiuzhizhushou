// @vitest-environment jsdom
// 跨上下文统一异常留痕：转发 / 兜底 / 合并 / 去重 / 脏数据
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { db } from '../src/shared/db/index'
import {
  recordError, listErrors, getErrorCount, clearErrors,
  appendSharedError, resetErrorDedupeState, SHARED_ERROR_KEY,
} from '../src/shared/db/error-store'
import { reportError } from '../src/shared/db/error-report'

let store: Record<string, any> = {}
let sendMessage: ReturnType<typeof vi.fn>

beforeEach(async () => {
  store = {}
  resetErrorDedupeState()
  sendMessage = vi.fn(async () => ({ success: true }))
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: vi.fn(async (keys: string | string[]) => {
          if (typeof keys === 'string') return { [keys]: store[keys] }
          const res: Record<string, any> = {}
          for (const k of keys) res[k] = store[k]
          return res
        }),
        set: vi.fn(async (obj: Record<string, any>) => { Object.assign(store, obj) }),
        remove: vi.fn(async (keys: string | string[]) => {
          for (const k of Array.isArray(keys) ? keys : [keys]) delete store[k]
        }),
      },
    },
    runtime: { sendMessage: (...args: any[]) => sendMessage(...args) },
  })
  await db.open()
  await clearErrors()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('统一上报入口 reportError', () => {
  it('转发到 background 成功时不重复写本地，避免一条错误记两次', async () => {
    await reportError({ source: 'butler.agent', message: '主路径失败' })
    expect(sendMessage).toHaveBeenCalledWith({
      type: 'RECORD_ERROR',
      payload: expect.objectContaining({ source: 'butler.agent', message: '主路径失败' }),
    })
    expect(store[SHARED_ERROR_KEY]).toBeUndefined()
    expect(await getErrorCount()).toBe(0)
  })

  it('background 休眠 / 转发抛错时，写入共享队列且诊断中心能读到', async () => {
    sendMessage = vi.fn(async () => { throw new Error('no receiver') })
    await reportError({ source: 'butler.agent', message: '页面域异常也要看得见' })
    expect(store[SHARED_ERROR_KEY]).toHaveLength(1)
    const list = await listErrors()
    expect(list).toHaveLength(1)
    expect(list[0].source).toBe('butler.agent')
    expect(list[0].message).toContain('页面域异常')
    expect(await getErrorCount()).toBe(1)
  })

  it('转发返回 success:false 时同样兜底，不留黑洞', async () => {
    sendMessage = vi.fn(async () => ({ success: false }))
    await reportError({ source: 'butler.tool', message: '工具不存在' })
    expect(store[SHARED_ERROR_KEY]).toHaveLength(1)
  })

  it('chrome.storage 也不可用时退回本地 Dexie，绝不丢异常', async () => {
    vi.stubGlobal('chrome', {
      runtime: { sendMessage: vi.fn(async () => { throw new Error('no receiver') }) },
    })
    await reportError({ source: 'butler.ui', message: '最后一道兜底' })
    const list = await listErrors()
    expect(list).toHaveLength(1)
    expect(list[0].source).toBe('butler.ui')
  })

  it('相同错误在去重窗口内只留一条，防止 AI 失败刷屏', async () => {
    sendMessage = vi.fn(async () => { throw new Error('no receiver') })
    await reportError({ source: 'ai.api', message: 'HTTP 401', dedupeWindowMs: 60_000 })
    await reportError({ source: 'ai.api', message: 'HTTP 401', dedupeWindowMs: 60_000 })
    expect(store[SHARED_ERROR_KEY]).toHaveLength(1)
  })

  it('同一轮降级并发触发多条留痕时互不覆盖，一条都不丢', async () => {
    sendMessage = vi.fn(async () => { throw new Error('no receiver') })
    await Promise.all([
      reportError({ source: 'butler.agent', message: 'agent_call_failed' }),
      reportError({ source: 'butler.agent', message: 'json_fallback_failed' }),
      reportError({ source: 'butler.agent', message: 'offline_fallback_used' }),
    ])
    expect(store[SHARED_ERROR_KEY]).toHaveLength(3)
    expect((await listErrors()).map((r) => r.message).sort()).toEqual([
      'agent_call_failed', 'json_fallback_failed', 'offline_fallback_used',
    ])
  })

  it('缺少 source / message 的脏上报被直接忽略', async () => {
    await reportError({ source: '', message: 'x' })
    await reportError({ source: 'x', message: '' })
    expect(await getErrorCount()).toBe(0)
  })
})

describe('诊断中心读取与清理', () => {
  it('扩展域 Dexie 与共享队列合并读取、按 id 去重、按时间倒序', async () => {
    await recordError({ source: 'dexie', message: '来自后台' })
    await appendSharedError({ source: 'shared', message: '来自页面' })
    const list = await listErrors()
    expect(list).toHaveLength(2)
    expect(new Set(list.map((r) => r.source))).toEqual(new Set(['dexie', 'shared']))
    expect(await getErrorCount()).toBe(2)
  })

  it('清空同时清掉 Dexie 与共享队列，不留残影', async () => {
    await recordError({ source: 'dexie', message: 'a' })
    await appendSharedError({ source: 'shared', message: 'b' })
    await clearErrors()
    expect(await getErrorCount()).toBe(0)
    expect(store[SHARED_ERROR_KEY]).toBeUndefined()
  })

  it('共享队列里有脏数据时跳过坏记录，不让诊断中心白屏', async () => {
    store[SHARED_ERROR_KEY] = [
      { bad: 1 }, null, 'oops',
      { id: 'ok-1', createdAt: new Date().toISOString(), source: 'butler.agent', message: '正常记录' },
    ]
    const list = await listErrors()
    expect(list).toHaveLength(1)
    expect(list[0].id).toBe('ok-1')
  })
})
