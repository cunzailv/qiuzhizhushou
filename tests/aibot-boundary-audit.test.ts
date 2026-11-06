// @vitest-environment jsdom
// AIbot 关键路径边界审计：职业方向清洗、关键词提取、时间窗、完成判定、模型迁移、多模态组装
import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  normalizeCareerTokens,
  diagnoseCareerTokens,
  extractTargetCareers,
  isJobMatchingCareer,
  isJobMatchingFreshness,
  evaluateJobCandidate,
} from '../src/shared/agent/job-filter'
import { extractSearchKeywords } from '../src/shared/agent/job-discovery'
import { isWithinWindow, getDelayUntilNextWindow, formatTimeWindows } from '../src/shared/agent/quota'
import { buildUserContent, isVisionCapableModel } from '../src/shared/ai/api-client'
import { migrateDefaultModelName } from '../src/shared/db/settings-store'
import {
  createNewCampaign,
  appendTasksToCampaign,
  claimNextTask,
  updateTaskResult,
  getCampaign,
  markPlatformExhausted,
} from '../src/shared/agent/queue-store'
import { isCampaignFinished } from '../src/shared/agent/campaign'

const mockStorage: Record<string, any> = {}

beforeEach(() => {
  for (const k of Object.keys(mockStorage)) delete mockStorage[k]

  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: vi.fn(async (keys: string | string[]) => {
          if (typeof keys === 'string') return { [keys]: mockStorage[keys] }
          if (keys === null || keys === undefined) return { ...mockStorage }
          const res: Record<string, any> = {}
          for (const k of keys) res[k] = mockStorage[k]
          return res
        }),
        set: vi.fn(async (obj: Record<string, any>) => {
          Object.assign(mockStorage, obj)
        }),
        remove: vi.fn(async (keys: string | string[]) => {
          const list = Array.isArray(keys) ? keys : [keys]
          for (const k of list) delete mockStorage[k]
        }),
      },
    },
    runtime: { sendMessage: vi.fn(async () => ({ success: true })) },
    cookies: { get: vi.fn(async () => null), getAll: vi.fn(async () => []) },
  })
})

// ─────────────────────────── 1. 职业方向清洗 ───────────────────────────

describe('职业方向清洗 normalizeCareerTokens', () => {
  it('把「公司名 + 岗位描述」清洗成纯职位词', () => {
    expect(normalizeCareerTokens('刚刚好智创网站　全栈独立开发 / AI全栈:后台开发 / 全栈')).toEqual([
      '全栈独立开发',
      'AI全栈',
      '后台开发',
      '全栈',
    ])
  })

  it('空格分隔的多个职位必须拆成独立词', () => {
    expect(normalizeCareerTokens('全栈工程师 技术经理')).toEqual(['全栈工程师', '技术经理'])
  })

  it('去掉括号补充说明但保留职位主体', () => {
    expect(normalizeCareerTokens('全栈工程师（AI 智能体方向）')).toEqual(['全栈工程师'])
  })

  it('纯公司名/纯噪音不产出任何方向', () => {
    expect(normalizeCareerTokens('刚刚好智创科技有限公司')).toEqual([])
    expect(normalizeCareerTokens('   ')).toEqual([])
  })

  it('diagnoseCareerTokens 必须报告被剔除的公司名片段', () => {
    const diag = diagnoseCareerTokens('刚刚好智创网站　全栈独立开发 / 全栈')
    expect(diag.kept).toContain('全栈独立开发')
    // 用户需要知道「哪个公司名被丢掉了」，否则无法判断词到底从哪来
    expect(diag.dropped.join(' ')).toContain('刚刚好智创网站')
  })
})

describe('目标方向提取 extractTargetCareers', () => {
  it('优先使用用户填写的岗位名称并完成清洗', () => {
    const careers = extractTargetCareers(null, {
      jobTitles: 'PHP开发、后端开发、刚刚好智创网站 全栈独立开发',
    } as any)
    expect(careers).toContain('PHP开发')
    expect(careers).toContain('后端开发')
    expect(careers.join(' ')).not.toContain('刚刚好智创网站')
  })

  it('岗位名称为空时回退简历最近职位，且不含公司名', () => {
    const resume: any = {
      name: '张三',
      structuredData: {
        workExperience: [{ company: '某某科技', position: '刚刚好智创网站 全栈独立开发' }],
        projects: [],
        skills: [],
        education: [],
      },
    }
    const careers = extractTargetCareers(resume, { jobTitles: '' } as any)
    expect(careers).toContain('全栈独立开发')
    expect(careers.join(' ')).not.toContain('刚刚好智创网站')
  })
})

describe('职业方向匹配 isJobMatchingCareer', () => {
  it('后端与后台视为同一族谱', () => {
    expect(isJobMatchingCareer('后端开发工程师', ['后台开发'])).toBe(true)
    expect(isJobMatchingCareer('后台开发', ['后端开发'])).toBe(true)
  })

  it('语言栈必须双方同时出现才放行', () => {
    expect(isJobMatchingCareer('PHP开发工程师', ['PHP开发'])).toBe(true)
    expect(isJobMatchingCareer('Java开发工程师', ['PHP开发'])).toBe(false)
  })

  it('无标题直接不匹配，空方向列表则放行', () => {
    expect(isJobMatchingCareer('', ['全栈开发'])).toBe(false)
    expect(isJobMatchingCareer('任意岗位', [])).toBe(true)
  })

  it('销售客服类岗位即便方向放宽也应被硬拦截', () => {
    const res = evaluateJobCandidate(
      { id: '1', title: '电话客服', companyName: 'C', tags: [], jobUrl: 'u' } as any,
      { filters: null, targetCareers: [], blacklist: new Set() },
    )
    expect(res.pass).toBe(false)
  })

  it('方向不匹配标记为软过滤，交由匹配分把关而不是直接丢弃', () => {
    const res = evaluateJobCandidate(
      { id: '1', title: 'Java开发工程师', companyName: 'C', tags: [], jobUrl: 'u' } as any,
      { filters: null, targetCareers: ['PHP开发'], blacklist: new Set() },
    )
    expect(res.pass).toBe(false)
    expect(res.soft).toBe(true)
  })

  it('无关行业与黑名单属于硬过滤，不得标记为软过滤', () => {
    const unrelated = evaluateJobCandidate(
      { id: '1', title: '电话销售', companyName: 'C', tags: [], jobUrl: 'u' } as any,
      { filters: null, targetCareers: ['PHP开发'], blacklist: new Set() },
    )
    expect(unrelated.pass).toBe(false)
    expect(unrelated.soft).toBeUndefined()

    const blacklisted = evaluateJobCandidate(
      { id: '2', title: 'PHP开发工程师', companyName: '黑名单公司', tags: [], jobUrl: 'u' } as any,
      { filters: null, targetCareers: ['PHP开发'], blacklist: new Set(['黑名单公司']) },
    )
    expect(blacklisted.pass).toBe(false)
    expect(blacklisted.soft).toBeUndefined()
  })
})

// ─────────────────────────── 2. 关键词提取 ───────────────────────────

describe('搜索关键词提取 extractSearchKeywords', () => {
  it('绝不能用求职者姓名搜索岗位', () => {
    const resume: any = { name: '朱红全', structuredData: { workExperience: [], projects: [], skills: [] } }
    const kws = extractSearchKeywords(resume, undefined, { jobTitles: '' } as any)
    expect(kws).not.toContain('朱红全')
  })

  it('文件名中的职位可以提取，但公司名不行', () => {
    const resume: any = {
      name: '张三-PHP开发工程师-5年',
      structuredData: { workExperience: [], projects: [], skills: [] },
    }
    const kws = extractSearchKeywords(resume, undefined, { jobTitles: '' } as any)
    expect(kws.join(' ')).toContain('PHP开发工程师')
    expect(kws).not.toContain('张三')
  })

  it('超长描述句不会成为搜索词', () => {
    const kws = extractSearchKeywords(null, undefined, {
      jobTitles: 'BUG 修复与新增功能开发、商城后台维护',
    } as any)
    expect(kws).toContain('商城后台维护')
    expect(kws.every((k) => k.length <= 12)).toBe(true)
  })

  it('来源全空时回退标准词库', () => {
    const kws = extractSearchKeywords(null, undefined, { jobTitles: '' } as any)
    expect(kws.length).toBeGreaterThan(0)
    expect(kws).toContain('全栈工程师')
  })
})

// ─────────────────────────── 3. 投递时间窗 ───────────────────────────

describe('投递时间窗 isWithinWindow', () => {
  const at = (h: number, m = 0) => new Date(2026, 0, 1, h, m, 0)

  it('普通窗口的整点边界包含在内', () => {
    const w = [{ startHour: 9, startMin: 0, endHour: 21, endMin: 0 }]
    expect(isWithinWindow(w, at(9))).toBe(true)
    expect(isWithinWindow(w, at(21))).toBe(true)
    expect(isWithinWindow(w, at(8, 59))).toBe(false)
    expect(isWithinWindow(w, at(21, 1))).toBe(false)
  })

  it('空窗口数组视为全天不限', () => {
    expect(isWithinWindow([], at(3))).toBe(true)
    expect(formatTimeWindows([])).toContain('24')
  })

  it('跨午夜窗口（22:00-02:00）必须生效', () => {
    const overnight = [{ startHour: 22, startMin: 0, endHour: 2, endMin: 0 }]
    expect(isWithinWindow(overnight, at(23, 30))).toBe(true)
    expect(isWithinWindow(overnight, at(1, 0))).toBe(true)
    expect(isWithinWindow(overnight, at(12, 0))).toBe(false)
  })

  it('跨午夜窗口的等待时长应为正数且不超过 24 小时', () => {
    const overnight = [{ startHour: 22, startMin: 0, endHour: 2, endMin: 0 }]
    const delay = getDelayUntilNextWindow(overnight, at(12, 0))
    expect(delay).toBeGreaterThan(0)
    expect(delay).toBeLessThanOrEqual(24 * 60 * 60 * 1000)
  })
})

// ─────────────────────────── 4. 活动完成判定 ───────────────────────────

describe('活动完成判定 isCampaignFinished', () => {
  it('新建活动未完成', async () => {
    const cmp = await createNewCampaign({ boss: 5 }, ['boss'])
    expect(isCampaignFinished(cmp)).toBe(false)
  })

  it('队列被跳过清空但配额未满时不得判定完成', async () => {
    await createNewCampaign({ boss: 5 }, ['boss'])
    await appendTasksToCampaign([
      { id: 'boss:a', platform: 'boss', jobId: 'a', jobTitle: 'T', company: 'C', jobUrl: 'u' },
    ])
    const { task } = await claimNextTask()
    await updateTaskResult(task!.id, { status: 'skipped' })
    const cmp = await getCampaign()
    expect(isCampaignFinished(cmp!)).toBe(false)
  })

  it('配额投满后判定完成', async () => {
    await createNewCampaign({ boss: 1 }, ['boss'])
    await appendTasksToCampaign([
      { id: 'boss:b', platform: 'boss', jobId: 'b', jobTitle: 'T', company: 'C', jobUrl: 'u' },
    ])
    const { task } = await claimNextTask()
    await updateTaskResult(task!.id, { status: 'done' })
    const cmp = await getCampaign()
    expect(isCampaignFinished(cmp!)).toBe(true)
  })

  it('平台日限耗尽后判定完成', async () => {
    await createNewCampaign({ boss: 50 }, ['boss'])
    await markPlatformExhausted('boss')
    const cmp = await getCampaign()
    expect(isCampaignFinished(cmp!)).toBe(true)
  })
})

// ─────────────────────────── 5. 默认模型迁移 ───────────────────────────

describe('默认模型迁移 migrateDefaultModelName', () => {
  it('停用的 deepseek-chat 自动升级为 deepseek-flash', async () => {
    mockStorage['setting_modelPreset'] = 'deepseek'
    mockStorage['setting_modelName'] = 'deepseek-chat'
    const result = await migrateDefaultModelName()
    expect(result).toBe('deepseek-flash')
    expect(mockStorage['setting_modelName']).toBe('deepseek-flash')
  })

  it('已经是新模型名时不做改动', async () => {
    mockStorage['setting_modelPreset'] = 'deepseek'
    mockStorage['setting_modelName'] = 'deepseek-flash'
    expect(await migrateDefaultModelName()).toBeNull()
  })

  it('自定义预设不被覆盖', async () => {
    mockStorage['setting_modelPreset'] = 'custom'
    mockStorage['setting_modelName'] = 'deepseek-chat'
    expect(await migrateDefaultModelName()).toBeNull()
    expect(mockStorage['setting_modelName']).toBe('deepseek-chat')
  })
})

// ─────────────────────────── 6. 多模态内容组装 ───────────────────────────

describe('多模态 content 组装 buildUserContent', () => {
  it('无图片时保持纯字符串', () => {
    expect(buildUserContent('你好')).toBe('你好')
  })

  it('裸 base64 自动补 data URL 前缀', () => {
    const content = buildUserContent('看这张图', [{ data: 'AAAA', mimeType: 'image/png' }])
    expect(Array.isArray(content)).toBe(true)
    const parts = content as any[]
    expect(parts[0]).toEqual({ type: 'text', text: '看这张图' })
    expect(parts[1].image_url.url).toBe('data:image/png;base64,AAAA')
  })

  it('http 图片地址原样透传', () => {
    const content = buildUserContent('看图', [{ data: 'https://x.test/a.png' }])
    const parts = content as any[]
    expect(parts[1].image_url.url).toBe('https://x.test/a.png')
  })

  it('图片数据为空时必须退化为纯字符串，不能发出空数组 content', () => {
    expect(buildUserContent('你好', [{ data: '   ' }])).toBe('你好')
    expect(buildUserContent('你好', [])).toBe('你好')
  })

  it('视觉能力判定覆盖 V4.1 Flash 且排除 V4 Pro', () => {
    expect(isVisionCapableModel('deepseek-flash')).toBe(true)
    expect(isVisionCapableModel('deepseek-v4-pro')).toBe(false)
  })
})

// ─────────────────────────── 7. 下一窗口等待时长 ───────────────────────────

describe('下一窗口等待时长 getDelayUntilNextWindow', () => {
  const at = (h: number, m = 0) => new Date(2026, 0, 1, h, m, 0)
  const twoShifts = [
    { startHour: 9, startMin: 0, endHour: 11, endMin: 30 },
    { startHour: 14, startMin: 0, endHour: 17, endMin: 30 },
  ]

  it('在窗口内返回 0', () => {
    expect(getDelayUntilNextWindow(twoShifts, at(10, 0))).toBe(0)
  })

  it('午休时间应等到下午 14:00（2 小时）', () => {
    expect(getDelayUntilNextWindow(twoShifts, at(12, 0))).toBe(2 * 60 * 60 * 1000)
  })

  it('当天窗口结束后应等到次日 09:00', () => {
    const delay = getDelayUntilNextWindow(twoShifts, at(18, 0))
    expect(delay).toBe(15 * 60 * 60 * 1000) // 18:00 → 次日 09:00
  })

  it('早于第一个窗口时等到 09:00', () => {
    expect(getDelayUntilNextWindow(twoShifts, at(7, 30))).toBe(1.5 * 60 * 60 * 1000)
  })

  it('等待时长永远不超过 24 小时', () => {
    for (let h = 0; h < 24; h++) {
      const d = getDelayUntilNextWindow(twoShifts, at(h, 0))
      expect(d).toBeGreaterThanOrEqual(0)
      expect(d).toBeLessThanOrEqual(24 * 60 * 60 * 1000)
    }
  })
})
