// @vitest-environment jsdom
// L2 过程自检：岗位语义相关性判定（本地族谱 / AI 批量复核 / 降级 / 缓存）
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const { mockChatCompletion } = vi.hoisted(() => ({
  mockChatCompletion: vi.fn(async (_sys: string, _user: string) => ''),
}))

vi.mock('../src/shared/ai/api-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/shared/ai/api-client')>()
  return { ...actual, chatCompletion: mockChatCompletion }
})

import {
  assessJobRelevance,
  computeLocalRelevance,
  parseRelevanceResponse,
  buildRelevanceSignature,
  MAX_AI_REVIEW_JOBS,
  type JobRelevanceInput,
  type RelevanceJob,
} from '../src/shared/ai/job-relevance'

const mockStorage: Record<string, any> = {}

beforeEach(() => {
  for (const k of Object.keys(mockStorage)) delete mockStorage[k]
  mockChatCompletion.mockReset()
  mockChatCompletion.mockResolvedValue('')
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
})

const devInput: JobRelevanceInput = {
  keyword: '后端开发',
  targetCareers: ['PHP开发工程师', '全栈独立开发'],
  platform: 'boss',
  jobs: [],
}

function job(id: string, title: string, tags: string[] = []): RelevanceJob {
  return { id, title, tags }
}

describe('本地语义相关性 computeLocalRelevance', () => {
  it('同义不同字也算相关：后端开发 ↔ PHP开发工程师 / Java后端', () => {
    expect(computeLocalRelevance(job('1', 'PHP开发工程师'), devInput)).toBe(true)
    expect(computeLocalRelevance(job('2', '兼职Java后端开发工程师'), devInput)).toBe(true)
    expect(computeLocalRelevance(job('3', '服务端研发工程师（Go）'), devInput)).toBe(true)
  })

  it('含关键词但岗位性质不对 → 不相关（修复旧的 includes 假阳性）', () => {
    expect(computeLocalRelevance(job('4', 'PHP技术支持'), devInput)).toBe(false)
    expect(computeLocalRelevance(job('5', 'PHP课程顾问'), devInput)).toBe(false)
    expect(computeLocalRelevance(job('6', '招聘PHP培训讲师'), devInput)).toBe(false)
  })

  it('推荐流里的杂乱岗位全部判为不相关', () => {
    const noise = ['空间设计师', '心理咨询院长', 'WMS 产品经理', '销售经理', '电话客服', '行政专员']
    for (const title of noise) {
      expect(computeLocalRelevance(job(`n-${title}`, title), devInput)).toBe(false)
    }
  })

  it('用户主动找非开发职能时按职能词放行，不被负向词误杀', () => {
    const pm: JobRelevanceInput = { keyword: '产品经理', targetCareers: ['产品经理'], jobs: [] }
    expect(computeLocalRelevance(job('p1', '高级产品经理'), pm)).toBe(true)
    expect(computeLocalRelevance(job('p2', 'PHP开发工程师'), pm)).toBe(false)
  })

  it('没有可用方向时不擅自否决整页', () => {
    expect(computeLocalRelevance(job('x', '某个岗位'), { keyword: '', targetCareers: [], jobs: [] })).toBe(true)
  })
})

describe('AI 返回解析 parseRelevanceResponse', () => {
  it('标准 JSON', () => {
    expect(parseRelevanceResponse('{"relevant":[1,3],"confidence":0.9,"reason":"两个后端岗"}', 5)).toEqual({
      relevant: [1, 3], confidence: 0.9, reason: '两个后端岗',
    })
  })

  it('兼容 markdown 代码块、前后废话、字符串编号、重复与越界编号', () => {
    const raw = '好的，结果如下：\n```json\n{"relevant":["1",1,9,0,3],"reason":"ok"}\n```\n以上'
    expect(parseRelevanceResponse(raw, 4)).toEqual({
      relevant: [1, 3], confidence: 0.7, reason: 'ok',
    })
  })

  it('空数组是合法结论（整页都不相关），不能当成解析失败', () => {
    const parsed = parseRelevanceResponse('{"relevant":[],"confidence":0.95,"reason":"全是设计岗"}', 10)
    expect(parsed).not.toBeNull()
    expect(parsed?.relevant).toEqual([])
  })

  it('空串 / 非 JSON / 缺 relevant 字段一律返回 null', () => {
    expect(parseRelevanceResponse('', 5)).toBeNull()
    expect(parseRelevanceResponse('模型拒绝回答', 5)).toBeNull()
    expect(parseRelevanceResponse('{"confidence":0.9}', 5)).toBeNull()
    expect(parseRelevanceResponse('{broken', 5)).toBeNull()
  })
})

describe('指纹与成本护栏 buildRelevanceSignature', () => {
  const jobs = [job('1', 'PHP开发工程师'), job('2', '空间设计师')]
  it('同一页岗位指纹稳定，换关键词/换岗位就变', () => {
    const a = buildRelevanceSignature({ ...devInput, jobs }, jobs)
    const b = buildRelevanceSignature({ ...devInput, jobs }, jobs)
    const c = buildRelevanceSignature({ ...devInput, keyword: '前端开发', jobs }, jobs)
    const d = buildRelevanceSignature({ ...devInput, jobs }, [...jobs, job('3', '后端工程师')])
    expect(a).toBe(b)
    expect(a).not.toBe(c)
    expect(a).not.toBe(d)
  })
})

describe('assessJobRelevance 主流程', () => {
  const jobs = [
    job('1', 'PHP开发工程师'),
    job('2', 'PHP技术支持'),
    job('3', 'Java后端开发工程师'),
    job('4', '空间设计师'),
  ]

  it('useAi=false 时只跑本地语义，明确标注 source=local', async () => {
    const res = await assessJobRelevance({ ...devInput, jobs }, { useAi: false })
    expect(res.source).toBe('local')
    expect(res.hits).toBe(2)
    expect(res.relevantJobIds).toEqual(['1', '3'])
    expect(mockChatCompletion).not.toHaveBeenCalled()
  })

  it('AI 判定覆盖本地结论：字符串命中 2 个，AI 只认 1 个真正对口', async () => {
    mockChatCompletion.mockResolvedValue(
      '{"relevant":[1],"confidence":0.92,"reason":"第二个是技术支持不是开发岗"}',
    )
    const res = await assessJobRelevance({ ...devInput, jobs }, { useAi: true })
    expect(res.source).toBe('ai')
    expect(res.hits).toBe(1)
    expect(res.relevantJobIds).toEqual(['1'])
    expect(res.irrelevantJobIds).toEqual(['2', '3', '4'])
    expect(res.confidence).toBe(0.92)
    expect(res.reason).toContain('技术支持')
    expect(res.aiReviewed).toBe(4)
  })

  it('AI 未配置/失败返回空串 → 回退本地，绝不伪装成 AI 结论', async () => {
    mockChatCompletion.mockResolvedValue('')
    const res = await assessJobRelevance({ ...devInput, jobs }, { useAi: true })
    expect(res.source).toBe('local')
    expect(res.hits).toBe(2)
  })

  it('同一页重复扫描命中 30 分钟缓存，不重复花 AI 预算', async () => {
    mockChatCompletion.mockResolvedValue('{"relevant":[1,3],"confidence":0.8,"reason":"两个后端岗"}')
    const input = { ...devInput, jobs }
    const first = await assessJobRelevance(input, { useAi: true, now: 1_700_000_000_000 })
    expect(first.cached).toBeFalsy()
    const second = await assessJobRelevance(input, { useAi: true, now: 1_700_000_000_000 + 60_000 })
    expect(second.cached).toBe(true)
    expect(second.source).toBe('ai')
    expect(second.relevantJobIds).toEqual(first.relevantJobIds)
    expect(mockChatCompletion).toHaveBeenCalledTimes(1)

    // 超过 TTL 后重新判定
    await assessJobRelevance(input, { useAi: true, now: 1_700_000_000_000 + 31 * 60_000 })
    expect(mockChatCompletion).toHaveBeenCalledTimes(2)
  })

  it('超过 30 个岗位时只送前 30 个给 AI，其余沿用本地结论', async () => {
    const many = Array.from({ length: 35 }, (_, i) =>
      job(`j${i}`, i < 30 ? '空间设计师' : 'PHP开发工程师'))
    mockChatCompletion.mockResolvedValue('{"relevant":[],"confidence":0.9,"reason":"全是设计岗"}')
    const res = await assessJobRelevance(
      { ...devInput, jobs: many },
      { useAi: true },
    )
    expect(res.aiReviewed).toBe(MAX_AI_REVIEW_JOBS)
    expect(res.relevantJobIds).toEqual(['j30', 'j31', 'j32', 'j33', 'j34'])
  })

  it('空岗位列表不发起 AI 调用', async () => {
    const res = await assessJobRelevance({ ...devInput, jobs: [] }, { useAi: true })
    expect(res.hits).toBe(0)
    expect(res.source).toBe('local')
    expect(mockChatCompletion).not.toHaveBeenCalled()
  })
})
