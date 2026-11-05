// @vitest-environment jsdom
// 第 4 点「沟通筛选条件是否两边通用」的回归：
// 概览半自动与 AIbot 全自动通过同一个 loader 读同一批 setting_ 键。
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AI_MATCH_KEY,
  LEGACY_AI_MATCH_KEY,
  MIN_MATCH_SCORE_KEY,
  loadSharedApplyFilters,
  persistSharedFilters,
} from '../src/shared/agent/filter-config'
import { DEFAULT_FILTERS } from '../src/shared/types/filters'

let store: Record<string, unknown> = {}

beforeEach(() => {
  // 预置所有键，避免 settings-store 回退到跨用例共享的 Dexie 造成串数据
  store = {
    setting_filterJobTitles: '',
    setting_filterLocations: '',
    setting_filterSalaryMin: null,
    setting_filterSalaryMax: null,
    setting_filterExperience: '',
    setting_filterEducation: '',
    setting_filterExcludeKeywords: '',
    setting_filterPublishTime: 'week',
    setting_filterEnableAiMatch: true,
    setting_enableAiMatch: true,
    setting_filterMinMatchScore: 60,
  }
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
        set: async (patch: Record<string, unknown>) => { Object.assign(store, patch) },
      },
    },
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('共享筛选配置读取', () => {
  it('无自定义配置时与 DEFAULT_FILTERS 一致', async () => {
    expect(await loadSharedApplyFilters()).toEqual(DEFAULT_FILTERS)
  })

  it('读齐全部基础字段（岗位/地点/薪资/经验/学历/排除词/发布时间）', async () => {
    Object.assign(store, {
      setting_filterJobTitles: 'PHP 后端',
      setting_filterLocations: '深圳',
      setting_filterSalaryMin: 20,
      setting_filterSalaryMax: 35,
      setting_filterExperience: '3-5年',
      setting_filterEducation: '本科',
      setting_filterExcludeKeywords: '外包',
      setting_filterPublishTime: '3days',
    })
    const f = await loadSharedApplyFilters()
    expect(f).toMatchObject({
      jobTitles: 'PHP 后端',
      locations: '深圳',
      salaryMin: 20,
      salaryMax: 35,
      experience: '3-5年',
      education: '本科',
      excludeKeywords: '外包',
      publishTime: '3days',
    })
  })

  it('AI 评分开关以 enableAiMatch 单一真源为准，不再硬编码 true', async () => {
    store.setting_enableAiMatch = false
    store.setting_filterEnableAiMatch = true
    expect((await loadSharedApplyFilters()).enableAiMatch).toBe(false)
  })

  it('最低匹配分读 filterMinMatchScore，不再硬编码 60', async () => {
    store.setting_filterMinMatchScore = 85
    expect((await loadSharedApplyFilters()).minMatchScore).toBe(85)
  })

  it('单一真源缺失时回退到旧版 filterEnableAiMatch（老数据兼容）', async () => {
    delete store.setting_enableAiMatch
    store.setting_filterEnableAiMatch = false
    expect((await loadSharedApplyFilters()).enableAiMatch).toBe(false)
  })
})

describe('共享筛选配置写入', () => {
  it('只写变化的字段，AI 评分开关双写两个键', async () => {
    await persistSharedFilters({ enableAiMatch: false, minMatchScore: 75 })
    expect(store.setting_enableAiMatch).toBe(false)
    expect(store.setting_filterEnableAiMatch).toBe(false)
    expect(store.setting_filterMinMatchScore).toBe(75)
    expect(store.setting_filterJobTitles).toBe('')
  })

  it('写后立刻读回，概览与 AIbot 拿到同一份配置', async () => {
    await persistSharedFilters({ enableAiMatch: false, minMatchScore: 42, jobTitles: 'Laravel' })
    const f = await loadSharedApplyFilters()
    expect(f.enableAiMatch).toBe(false)
    expect(f.minMatchScore).toBe(42)
    expect(f.jobTitles).toBe('Laravel')
  })

  it('导出键名与 assistant-state / campaign-service 使用的键一致', () => {
    expect(AI_MATCH_KEY).toBe('enableAiMatch')
    expect(LEGACY_AI_MATCH_KEY).toBe('filterEnableAiMatch')
    expect(MIN_MATCH_SCORE_KEY).toBe('filterMinMatchScore')
  })
})
