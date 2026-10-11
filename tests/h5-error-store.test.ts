// H5 · 错误上报：记录/列表/清空/上限 + 全局捕获安装
import { describe, it, expect, beforeAll } from 'vitest'
import 'fake-indexeddb/auto'
import { db } from '../src/shared/db/index'
import { recordError, listErrors, getErrorCount, clearErrors, installGlobalErrorCapture } from '../src/shared/db/error-store'

beforeAll(async () => {
  await db.open()
  await db.errors.clear()
})

describe('H5 错误上报', () => {
  it('recordError 落库并可读取', async () => {
    await recordError({ source: 'ai.api', message: 'chatCompletion 请求失败: NetworkError', stack: 'at fetch' })
    const errors = await listErrors()
    expect(errors.length).toBe(1)
    expect(errors[0].source).toBe('ai.api')
    expect(errors[0].message).toContain('NetworkError')
  })

  it('getErrorCount 计数', async () => {
    await recordError({ source: 'window', message: 'boom' })
    expect(await getErrorCount()).toBe(2)
  })

  it('超过 200 条只保留最近 200 条', async () => {
    for (let i = 0; i < 210; i++) {
      await recordError({ source: 'stress', message: `err-${i}` })
    }
    expect(await getErrorCount()).toBe(200)
    const errors = await listErrors(200)
    // 倒序：最新的是 err-209
    expect(errors[0].message).toBe('err-209')
  })

  it('clearErrors 清空', async () => {
    await clearErrors()
    expect(await getErrorCount()).toBe(0)
  })

  it('installGlobalErrorCapture 幂等', async () => {
    const fakeWindow = new EventTarget() as unknown as Window & Record<string, unknown>
    const originalWindow = (globalThis as Record<string, unknown>).window
    ;(globalThis as Record<string, unknown>).window = fakeWindow
    try {
      installGlobalErrorCapture()
      installGlobalErrorCapture()
      expect(fakeWindow.__qzErrorInstalled).toBe(true)
    } finally {
      if (originalWindow === undefined) delete (globalThis as Record<string, unknown>).window
      else (globalThis as Record<string, unknown>).window = originalWindow
    }
  })
})
