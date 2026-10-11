// H2 · LLM 降级兜底：瞬时错误重试 + HTTP 错误不重试 + 失败返回空串
import { describe, it, expect, beforeAll, vi } from 'vitest'
import 'fake-indexeddb/auto'
import { db } from '../src/shared/db/index'
import { chatCompletion } from '../src/shared/ai/api-client'

beforeAll(async () => {
  await db.open()
  await db.errors.clear()
})

// 让 resolveAISettings 返回一个固定的可调用配置
vi.mock('../src/shared/db/settings-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/shared/db/settings-store')>()
  return {
    ...actual,
    getSetting: vi.fn(async (key: string) => {
      if (key === 'apiKey') return 'test-key'
      if (key === 'modelPreset') return 'deepseek'
      return ''
    }),
  }
})

// 预算护栏：默认放行
vi.mock('../src/shared/ai/ai-budget', () => ({
  consumeAiCall: vi.fn(async () => 10),
}))

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('H2 LLM 降级兜底', () => {
  it('瞬时网络错误后重试成功并返回内容', async () => {
    let calls = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls++
      if (calls === 1) throw new TypeError('Failed to fetch')
      return jsonResponse({ choices: [{ message: { content: 'ok-after-retry' } }] })
    }))
    const result = await chatCompletion('sys', 'user')
    expect(calls).toBe(2)
    expect(result).toBe('ok-after-retry')
    vi.unstubAllGlobals()
  })

  it('HTTP 500 不重试，返回空串并记录错误', async () => {
    let calls = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls++
      return new Response('boom', { status: 500 })
    }))
    const result = await chatCompletion('sys', 'user')
    expect(calls).toBe(1)
    expect(result).toBe('')
    const errors = await listErrorsFromDb()
    expect(errors.some((e) => e.message.includes('500'))).toBe(true)
    vi.unstubAllGlobals()
  })

  it('持续瞬时错误重试 3 次后返回空串', async () => {
    let calls = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls++
      throw new TypeError('Failed to fetch')
    }))
    const result = await chatCompletion('sys', 'user')
    expect(calls).toBe(3)
    expect(result).toBe('')
    vi.unstubAllGlobals()
  })
})

async function listErrorsFromDb() {
  const all = await db.errors.toArray()
  return all
}
