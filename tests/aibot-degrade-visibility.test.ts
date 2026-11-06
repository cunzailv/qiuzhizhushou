// @vitest-environment jsdom
// 第三轮：AI 降级可见化、错误记录节流
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { chatCompletion, AI_FAILURE_KEY } from '../src/shared/ai/api-client'
import { shouldSkipDuplicate } from '../src/shared/db/error-store'

const mockStorage: Record<string, any> = {}

beforeEach(() => {
  for (const k of Object.keys(mockStorage)) delete mockStorage[k]
  mockStorage['setting_apiKey'] = 'sk-test'
  mockStorage['setting_modelPreset'] = 'deepseek'
  mockStorage['setting_modelName'] = 'deepseek-flash'

  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: vi.fn(async (keys: string | string[]) => {
          if (typeof keys === 'string') return { [keys]: mockStorage[keys] }
          if (!Array.isArray(keys)) return { ...mockStorage }
          const res: Record<string, any> = {}
          for (const k of keys) res[k] = mockStorage[k]
          return res
        }),
        set: vi.fn(async (obj: Record<string, any>) => Object.assign(mockStorage, obj)),
        remove: vi.fn(async (keys: string | string[]) => {
          const list = Array.isArray(keys) ? keys : [keys]
          for (const k of list) delete mockStorage[k]
        }),
      },
    },
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const flush = () => new Promise((r) => setTimeout(r, 0))

describe('AI 降级可见化', () => {
  it('模型名无效（400 Model Not Exist）时落 kind=model 的失败标记', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 400,
        text: async () => '{"error":{"message":"Model Not Exist"}}',
      })),
    )

    const out = await chatCompletion('sys', 'hello', 0.3, { bypassBudget: true })
    expect(out).toBe('')
    await flush()

    const mark = mockStorage[AI_FAILURE_KEY]
    expect(mark).toBeTruthy()
    expect(mark.kind).toBe('model')
    expect(mark.model).toBe('deepseek-flash')
  })

  it('普通 5xx 标记为 http 而不是 model', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 503, text: async () => 'service unavailable' })),
    )

    await chatCompletion('sys', 'hello', 0.3, { bypassBudget: true })
    await flush()

    expect(mockStorage[AI_FAILURE_KEY]?.kind).toBe('http')
  })

  it('网络异常标记为 network', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch')
      }),
    )

    await chatCompletion('sys', 'hello', 0.3, { bypassBudget: true })
    await flush()

    expect(mockStorage[AI_FAILURE_KEY]?.kind).toBe('network')
  })

  it('后续调用成功后必须清除失败标记', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 400, text: async () => 'Model Not Exist' })),
    )
    await chatCompletion('sys', 'hello', 0.3, { bypassBudget: true })
    await flush()
    expect(mockStorage[AI_FAILURE_KEY]).toBeTruthy()

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: '正常回复' } }] }),
      })),
    )
    const ok = await chatCompletion('sys', 'hello', 0.3, { bypassBudget: true })
    await flush()

    expect(ok).toBe('正常回复')
    expect(mockStorage[AI_FAILURE_KEY]).toBeUndefined()
  })

  it('未配置 API Key 时直接返回空串且不产生失败标记', async () => {
    delete mockStorage['setting_apiKey']
    const out = await chatCompletion('sys', 'hello', 0.3, { bypassBudget: true })
    await flush()
    expect(out).toBe('')
    expect(mockStorage[AI_FAILURE_KEY]).toBeUndefined()
  })
})

describe('错误记录节流 shouldSkipDuplicate', () => {
  it('同一来源同一消息在窗口内只放行一次', () => {
    const sig = `unit-test-${Date.now()}-${Math.random()}`
    const msg = `重复错误 ${sig}`
    expect(shouldSkipDuplicate('dedupe-test', msg)).toBe(false)
    expect(shouldSkipDuplicate('dedupe-test', msg)).toBe(true)
    expect(shouldSkipDuplicate('dedupe-test', msg)).toBe(true)
  })

  it('不同消息各自放行', () => {
    const sig = `unit-test-${Date.now()}-${Math.random()}`
    expect(shouldSkipDuplicate('dedupe-test', `错误A ${sig}`)).toBe(false)
    expect(shouldSkipDuplicate('dedupe-test', `错误B ${sig}`)).toBe(false)
  })

  it('不同来源互不影响', () => {
    const msg = `跨来源错误 ${Date.now()}-${Math.random()}`
    expect(shouldSkipDuplicate('src-a', msg)).toBe(false)
    expect(shouldSkipDuplicate('src-b', msg)).toBe(false)
  })
})
