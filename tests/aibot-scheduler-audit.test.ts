// @vitest-environment jsdom
// 第二轮审计：调度可靠性（休眠切片 / alarm 兜底）、采集页导航判定
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { isOnTargetSearchUrl, getPlatformSearchUrl } from '../src/background/tab-manager'

const mockStorage: Record<string, any> = {}
const alarmCreate = vi.fn()

function stubChrome() {
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: vi.fn(async (keys: string | string[]) => {
          if (typeof keys === 'string') return { [keys]: mockStorage[keys] }
          const res: Record<string, any> = {}
          for (const k of keys) res[k] = mockStorage[k]
          return res
        }),
        set: vi.fn(async (obj: Record<string, any>) => Object.assign(mockStorage, obj)),
        remove: vi.fn(async () => {}),
      },
    },
    alarms: {
      create: alarmCreate,
      clear: vi.fn(async () => true),
      get: vi.fn(async () => undefined),
    },
    tabs: {
      query: vi.fn(async () => []),
      update: vi.fn(async () => ({})),
      create: vi.fn(async () => ({ id: 1 })),
      get: vi.fn(async () => ({ status: 'complete' })),
      sendMessage: vi.fn(async () => ({})),
    },
    windows: { update: vi.fn(async () => ({})) },
    runtime: { getManifest: vi.fn(() => ({ content_scripts: [{ js: ['a.js'] }] })) },
    scripting: { executeScript: vi.fn(async () => []) },
  })
}

beforeEach(() => {
  for (const k of Object.keys(mockStorage)) delete mockStorage[k]
  alarmCreate.mockClear()
  stubChrome()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('采集页导航判定 isOnTargetSearchUrl', () => {
  it('同一关键词同一页码不重复导航', () => {
    const url = getPlatformSearchUrl('boss', 'PHP开发', 1)
    expect(isOnTargetSearchUrl(url, 'PHP开发', 1)).toBe(true)
  })

  it('关键词变了必须重新导航', () => {
    const url = getPlatformSearchUrl('boss', 'PHP开发', 1)
    expect(isOnTargetSearchUrl(url, 'Java开发', 1)).toBe(false)
  })

  it('页码变了必须重新导航', () => {
    const url = getPlatformSearchUrl('boss', 'PHP开发', 1)
    expect(isOnTargetSearchUrl(url, 'PHP开发', 2)).toBe(false)
  })

  it('已停在第 2 页时不再重复导航', () => {
    const url = getPlatformSearchUrl('boss', 'PHP开发', 2)
    expect(url).toContain('page=2')
    expect(isOnTargetSearchUrl(url, 'PHP开发', 2)).toBe(true)
  })

  it('空 URL 一律视为不在目标页', () => {
    expect(isOnTargetSearchUrl(undefined, 'PHP开发', 1)).toBe(false)
  })

  it('各平台搜索 URL 都带上编码后的关键词', () => {
    expect(getPlatformSearchUrl('boss', 'PHP开发')).toContain(encodeURIComponent('PHP开发'))
    expect(getPlatformSearchUrl('liepin', 'PHP开发', 3)).toContain('currentPage=3')
    expect(getPlatformSearchUrl('zhaopin', 'PHP开发', 2)).toContain('p=2')
  })
})

describe('调度休眠切片 scheduleNextTick', () => {
  it('长等待必须切成不超过 5 分钟的 alarm，避免 alarm 丢失后永久静默', async () => {
    const { scheduleNextTick } = await import('../src/background/campaign-service')
    vi.useFakeTimers()
    scheduleNextTick(5 * 60 * 60 * 1000) // 请求睡 5 小时

    const call = alarmCreate.mock.calls.at(-1)
    expect(call?.[0]).toBe('apply-tick')
    expect(call?.[1].delayInMinutes).toBeLessThanOrEqual(5)
    expect(call?.[1].delayInMinutes).toBeGreaterThan(0)
  })

  it('短等待按实际分钟数向上取整，不会退化成 0 分钟', async () => {
    const { scheduleNextTick } = await import('../src/background/campaign-service')
    vi.useFakeTimers()
    scheduleNextTick(30_000)

    const call = alarmCreate.mock.calls.at(-1)
    expect(call?.[1].delayInMinutes).toBeGreaterThanOrEqual(1)
    expect(call?.[1].delayInMinutes).toBeLessThanOrEqual(5)
  })
})

describe('搜索页码游标持久化', () => {
  it('写入后可以读回（Service Worker 重启不丢）', async () => {
    const { setSearchPageCursor, getSearchPageCursor } = await import('../src/background/campaign-service')
    await setSearchPageCursor('boss:PHP开发', 3)
    expect(await getSearchPageCursor('boss:PHP开发')).toBe(3)
  })

  it('没有记录时默认为第 1 页', async () => {
    const { getSearchPageCursor } = await import('../src/background/campaign-service')
    expect(await getSearchPageCursor('liepin:从未采集过')).toBe(1)
  })

  it('超过 12 小时的旧游标作废，回到第 1 页', async () => {
    const { getSearchPageCursor } = await import('../src/background/campaign-service')
    mockStorage['aibot_search_page_cursor'] = {
      'boss:过期关键词': { page: 4, at: Date.now() - 13 * 60 * 60 * 1000 },
    }
    expect(await getSearchPageCursor('boss:过期关键词')).toBe(1)
  })

  it('游标不会越界到第 6 页', async () => {
    const { getSearchPageCursor } = await import('../src/background/campaign-service')
    mockStorage['aibot_search_page_cursor'] = {
      'boss:越界关键词': { page: 99, at: Date.now() },
    }
    expect(await getSearchPageCursor('boss:越界关键词')).toBe(5)
  })
})
