// @vitest-environment jsdom
// 半自动 / 全自动互斥锁回归：全局单一真源、冲突仲裁、陈旧锁抢占、进度上报与订阅。
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_RUNTIME_STATE,
  RUNTIME_STALE_MS,
  acquireRunMode,
  getRuntimeState,
  isRuntimeLockStale,
  patchRuntimeState,
  releaseRunMode,
  reportBatchProgress,
  subscribeRuntimeState,
} from '../src/shared/runtime-state'

type ChangeListener = (changes: Record<string, unknown>, area: string) => void

let store: Record<string, unknown> = {}
let setCalls = 0
const listeners: ChangeListener[] = []

beforeEach(() => {
  // 预置默认值：避免 settings-store 在 chrome.storage 缺键时回退到 Dexie
  // （fake-indexeddb 是跨用例共享的，会串数据并触发迁移写入）。
  store = { setting_runtimeState: {} }
  setCalls = 0
  listeners.length = 0
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: async (key: string | string[] | null) => {
          if (key === null) return { ...store }
          if (Array.isArray(key)) {
            return Object.fromEntries(key.filter((k) => k in store).map((k) => [k, store[k]]))
          }
          return key in store ? { [key]: store[key] } : {}
        },
        set: async (patch: Record<string, unknown>) => {
          setCalls++
          Object.assign(store, patch)
        },
      },
      onChanged: {
        addListener: (fn: ChangeListener) => listeners.push(fn),
        removeListener: (fn: ChangeListener) => {
          const index = listeners.indexOf(fn)
          if (index >= 0) listeners.splice(index, 1)
        },
      },
    },
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('运行状态默认值与读取', () => {
  it('默认是 idle 且字段完整', async () => {
    expect(await getRuntimeState()).toEqual(DEFAULT_RUNTIME_STATE)
    expect((await getRuntimeState()).recentMatches).toEqual([])
  })

  it('合并残缺的历史数据并补齐默认值', async () => {
    store.setting_runtimeState = { mode: 'autopilot', stats: { processed: 3 } }
    const state = await getRuntimeState()
    expect(state.mode).toBe('autopilot')
    expect(state.stats).toEqual({ processed: 3, total: 0, matched: 0 })
    expect(state.recentMatches).toEqual([])
    expect(state.startedAt).toBeNull()
  })

  it('recentMatches 最多保留 3 条，超出会被截断', async () => {
    const items = [1, 2, 3, 4, 5].map((n) => ({
      title: `岗位${n}`, companyName: '公司', score: n, recommended: true,
    }))
    store.setting_runtimeState = { recentMatches: items }
    expect((await getRuntimeState()).recentMatches).toHaveLength(3)
  })
})

describe('互斥锁申请与释放', () => {
  it('空闲时可申请 manual，写入 scanning 状态并清空上一轮结果', async () => {
    store.setting_runtimeState = {
      ...DEFAULT_RUNTIME_STATE,
      recentMatches: [{ title: '旧岗位', companyName: '旧公司', score: 80, recommended: true }],
    }
    const result = await acquireRunMode('manual')
    expect(result.ok).toBe(true)
    expect(result.state.mode).toBe('manual')
    expect(result.state.status).toBe('scanning')
    expect(result.state.recentMatches).toEqual([])
    expect(result.state.startedAt).toBeTypeOf('number')
  })

  it('半自动持锁时，全自动申请被拒并返回 conflict', async () => {
    await acquireRunMode('manual')
    const result = await acquireRunMode('autopilot')
    expect(result.ok).toBe(false)
    expect(result.conflict).toBe('manual')
    expect((await getRuntimeState()).mode).toBe('manual')
  })

  it('全自动持锁时，半自动申请被拒并返回 conflict', async () => {
    await acquireRunMode('autopilot')
    const result = await acquireRunMode('manual')
    expect(result.ok).toBe(false)
    expect(result.conflict).toBe('autopilot')
  })

  it('同一模式重复申请是幂等的', async () => {
    await acquireRunMode('manual')
    const result = await acquireRunMode('manual')
    expect(result.ok).toBe(true)
    expect(result.conflict).toBeUndefined()
  })

  it('不是自己的锁不允许释放，避免误清对方状态', async () => {
    await acquireRunMode('manual')
    const state = await releaseRunMode('autopilot')
    expect(state.mode).toBe('manual')
  })

  it('自己的锁可以释放，status 落到 done', async () => {
    await acquireRunMode('manual')
    const state = await releaseRunMode('manual')
    expect(state.mode).toBe('idle')
    expect(state.status).toBe('done')
    expect(state.startedAt).toBeNull()
  })

  it('releaseRunMode("idle") 是全局强制释放', async () => {
    await acquireRunMode('autopilot')
    const state = await releaseRunMode('idle')
    expect(state.mode).toBe('idle')
  })

  it('释放后可被另一种模式重新申请', async () => {
    await acquireRunMode('manual')
    await releaseRunMode('manual')
    const result = await acquireRunMode('autopilot')
    expect(result.ok).toBe(true)
    expect(result.state.mode).toBe('autopilot')
  })
})

describe('陈旧锁兜底', () => {
  it('idle / 无 startedAt 不算陈旧', () => {
    expect(isRuntimeLockStale(DEFAULT_RUNTIME_STATE)).toBe(false)
    expect(isRuntimeLockStale({ ...DEFAULT_RUNTIME_STATE, mode: 'manual' })).toBe(false)
  })

  it('超过 2 小时的锁视为陈旧', async () => {
    const stale = {
      ...DEFAULT_RUNTIME_STATE,
      mode: 'manual' as const,
      startedAt: Date.now() - RUNTIME_STALE_MS - 1000,
    }
    expect(isRuntimeLockStale(stale)).toBe(true)
    store.setting_runtimeState = stale
    const result = await acquireRunMode('autopilot')
    expect(result.ok).toBe(true)
    expect(result.staleTakenOver).toBe(true)
    expect(result.state.mode).toBe('autopilot')
  })

  it('未超时的锁不会被抢占', async () => {
    store.setting_runtimeState = {
      ...DEFAULT_RUNTIME_STATE,
      mode: 'manual',
      startedAt: Date.now() - 1000,
    }
    const result = await acquireRunMode('autopilot')
    expect(result.ok).toBe(false)
  })
})

describe('进度上报与订阅', () => {
  it('patchRuntimeState 只写变化的字段', async () => {
    await patchRuntimeState({})
    expect(setCalls).toBe(0)
    await patchRuntimeState({ message: '扫描中' })
    expect(setCalls).toBe(1)
    await patchRuntimeState({ message: '扫描中' })
    expect(setCalls).toBe(1)
  })

  it('reportBatchProgress 在半自动下写入进度与最近匹配', async () => {
    await acquireRunMode('manual')
    await reportBatchProgress({
      status: 'matching',
      stats: { total: 10, processed: 2, matched: 1 },
      recentMatches: [{ title: '前端', companyName: 'A', score: 88, recommended: true }],
      message: '分析：前端',
    })
    const state = await getRuntimeState()
    expect(state.status).toBe('matching')
    expect(state.stats).toEqual({ total: 10, processed: 2, matched: 1 })
    expect(state.recentMatches[0].title).toBe('前端')
    expect(state.mode).toBe('manual') // 上报不会改动互斥锁
  })

  it('全自动运行时批量进度上报被忽略，不干扰 AIbot 状态', async () => {
    await acquireRunMode('autopilot')
    const before = await getRuntimeState()
    await reportBatchProgress({ status: 'matching', message: '不该写入' })
    expect(await getRuntimeState()).toEqual(before)
  })

  it('订阅只在 setting_runtimeState 变化时触发，取消订阅后不再触发', async () => {
    const seen: string[] = []
    const unsubscribe = subscribeRuntimeState((state) => seen.push(state.status))

    listeners.forEach((fn) => fn({ setting_otherKey: {} }, 'local'))
    expect(seen).toHaveLength(0)

    await patchRuntimeState({ status: 'scanning' })
    listeners.forEach((fn) => fn({ setting_runtimeState: {} }, 'local'))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(seen).toContain('scanning')

    unsubscribe()
    expect(listeners).toHaveLength(0)
  })
})
