// @vitest-environment jsdom
// 猎聘适配器覆盖：纯逻辑粗筛 + 基于调研 DOM 的解析 + 详情页 JSON-LD。
// 全部为离线 fixture，不访问真实猎聘站点、不需要登录、不产生真实投递。
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { fetchJobDetailDescription, liepinAdapter, prefilterLiepinJob } from '../src/shared/platform/liepin'
import { DEFAULT_FILTERS, type ApplyFilters } from '../src/shared/types/filters'
import type { JobCard } from '../src/shared/types/job'
import type { Resume } from '../src/shared/types/resume'

function makeJob(overrides: Partial<JobCard> = {}): JobCard {
  return {
    id: 'job-1',
    title: '高级前端工程师',
    companyName: '测试公司',
    companyLogo: '',
    salary: '25K-40K',
    location: '深圳',
    experience: '3-5年',
    education: '本科',
    tags: [],
    jobDescription: '',
    bossName: '',
    bossTitle: '',
    bossOnline: true,
    publishedAt: '',
    url: 'https://www.liepin.com/a/77558891.shtml',
    platformId: 'liepin',
    ...overrides,
  }
}

function makeResume(overrides: Partial<Resume['structuredData']> = {}): Resume {
  return {
    id: 'resume-1',
    name: '候选人',
    fileName: 'resume.pdf',
    fileType: 'pdf',
    fileData: new ArrayBuffer(0),
    rawText: '',
    structuredData: {
      name: '候选人',
      email: '',
      phone: '',
      city: '深圳',
      education: [{ degree: '本科' }] as never,
      workExperience: [],
      projects: [],
      skills: ['TypeScript', 'React'],
      summary: '',
      yearsOfExperience: 3,
      ...overrides,
    },
    aiAnalysis: null,
    isDefault: true,
    createdAt: '2026-07-26T00:00:00.000Z',
    updatedAt: '2026-07-26T00:00:00.000Z',
  } as Resume
}

function makeFilters(overrides: Partial<ApplyFilters> = {}): ApplyFilters {
  return { ...DEFAULT_FILTERS, ...overrides }
}

beforeEach(() => {
  document.body.innerHTML = ''
  window.history.replaceState({}, '', '/')
  vi.unstubAllGlobals()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('prefilterLiepinJob · 卡片粗筛（纯本地规则）', () => {
  it('全条件命中时给出满分 110 且通过，无淘汰理由', () => {
    const result = prefilterLiepinJob(makeJob(), makeResume(), makeFilters())
    expect(result.pass).toBe(true)
    expect(result.score).toBe(110)
    expect(result.reasons).toEqual([])
  })

  it('岗位要求 Go 而简历只有 TS 时硬性淘汰（语言家族不匹配）', () => {
    const result = prefilterLiepinJob(
      makeJob({ title: 'Go 后端工程师' }),
      makeResume(),
      makeFilters(),
    )
    expect(result.pass).toBe(false)
    expect(result.reasons.join(' ')).toContain('语言不匹配')
  })

  it('岗位未提语言时语言项直接给分，不误伤前端岗', () => {
    const result = prefilterLiepinJob(makeJob(), makeResume(), makeFilters())
    expect(result.score).toBeGreaterThanOrEqual(40)
    expect(result.reasons.join(' ')).not.toContain('语言不匹配')
  })

  it('标题关键词全部命中才加分，未命中时给出可解释理由', () => {
    expect(prefilterLiepinJob(makeJob(), makeResume(), makeFilters({ jobTitles: '前端 工程师' })).score).toBe(110)
    const missed = prefilterLiepinJob(makeJob(), makeResume(), makeFilters({ jobTitles: '架构师' }))
    expect(missed.score).toBe(95)
    expect(missed.reasons.join(' ')).toContain('标题未命中岗位关键词')
  })

  it('薪资低于筛选下限时扣分并记录原因', () => {
    const result = prefilterLiepinJob(makeJob(), makeResume(), makeFilters({ salaryMin: 30 }))
    expect(result.score).toBe(95)
    expect(result.reasons.join(' ')).toContain('薪资未达筛选下限')
  })

  it('年限不足扣分；经验不限视为无门槛', () => {
    const short = prefilterLiepinJob(makeJob({ experience: '5-10年' }), makeResume(), makeFilters())
    expect(short.reasons.join(' ')).toContain('年限不足')

    const unlimited = prefilterLiepinJob(makeJob({ experience: '经验不限' }), makeResume(), makeFilters())
    expect(unlimited.score).toBe(110)
    expect(unlimited.reasons.join(' ')).not.toContain('年限不足')
  })

  it('学历不足扣分并记录原因', () => {
    const result = prefilterLiepinJob(makeJob({ education: '硕士' }), makeResume(), makeFilters())
    expect(result.score).toBe(95)
    expect(result.reasons.join(' ')).toContain('学历不足')
  })

  it('地点不在筛选范围时扣分并记录原因', () => {
    const result = prefilterLiepinJob(makeJob(), makeResume(), makeFilters({ locations: '北京' }))
    expect(result.score).toBe(100)
    expect(result.reasons.join(' ')).toContain('地点不在筛选范围')
  })

  it('多项不满足导致 score < 60 时 pass 为 false（即使语言匹配）', () => {
    const result = prefilterLiepinJob(
      makeJob({ salary: '10K-15K', experience: '5-10年', education: '博士', location: '成都' }),
      makeResume(),
      makeFilters({ jobTitles: '架构师', salaryMin: 30, locations: '北京' }),
    )
    expect(result.score).toBeLessThan(60)
    expect(result.pass).toBe(false)
    expect(result.reasons.length).toBeGreaterThanOrEqual(4)
  })
})

describe('liepinAdapter · 平台识别与 DOM 解析', () => {
  it('matchesUrl 只认猎聘域名（含子域），不误认其它平台', () => {
    expect(liepinAdapter.matchesUrl('https://www.liepin.com/zhaopin/')).toBe(true)
    expect(liepinAdapter.matchesUrl('https://c.liepin.com/a/123.shtml')).toBe(true)
    expect(liepinAdapter.matchesUrl('https://liepin.com/')).toBe(true)
    expect(liepinAdapter.matchesUrl('https://www.zhipin.com/job_detail/')).toBe(false)
    expect(liepinAdapter.matchesUrl('https://we.51job.com/pc/search')).toBe(false)
  })

  it('detectPageType 依据 URL 区分搜索页 / 详情页 / 聊天页', () => {
    window.history.replaceState({}, '', '/zhaopin/?key=前端')
    expect(liepinAdapter.detectPageType()).toBe('search')

    window.history.replaceState({}, '', '/job/77558891.shtml')
    expect(liepinAdapter.detectPageType()).toBe('detail')

    window.history.replaceState({}, '', '/chat/room-1')
    expect(liepinAdapter.detectPageType()).toBe('chat')
  })

  it('parseJobCardsFromSearchPage 解析新版 a[data-nick] 卡片字段', () => {
    document.body.innerHTML = `
      <div class="list-wrap">
        <a data-nick="job-detail-job-info" href="https://www.liepin.com/a/77558891.shtml">
          <div class="ellipsis-1" title="高级前端工程师">高级前端工程师</div>
          <div class="ellipsis-1">深圳</div>
          <span>25K-40K</span>
          <span>3-5年</span>
          <span>本科</span>
        </a>
        <div data-nick="job-detail-company-info">
          <span class="ellipsis-1">方圆宝科技有限公司</span>
        </div>
        <div class="recruiter-info-box">
          <div class="ellipsis-1">王经理</div>
          <div class="ellipsis-1">刚刚在线</div>
        </div>
      </div>`

    const cards = liepinAdapter.parseJobCardsFromSearchPage()
    expect(cards).toHaveLength(1)
    expect(cards[0]).toMatchObject({
      id: '77558891',
      title: '高级前端工程师',
      companyName: '方圆宝科技有限公司',
      salary: '25K-40K',
      location: '深圳',
      experience: '3-5年',
      education: '本科',
      platformId: 'liepin',
    })
    expect(cards[0].url).toBe('https://www.liepin.com/a/77558891.shtml')
  })

  it('页面没有岗位卡片时返回空数组而不是抛异常', () => {
    document.body.innerHTML = '<div class="empty-state">暂无职位</div>'
    expect(liepinAdapter.parseJobCardsFromSearchPage()).toEqual([])
  })

  it('parseJobDetailFromPage 解析详情页标题 / 公司 / 薪资 / 地点', () => {
    document.body.innerHTML = `
      <h1>PHP 后端工程师</h1>
      <div class="company-name">竖云科技</div>
      <span class="job-salary">20K-30K</span>
      <div class="job-dq-box"><span class="ellipsis-1">广州-天河区</span></div>`
    const detail = liepinAdapter.parseJobDetailFromPage()
    expect(detail).not.toBeNull()
    expect(detail).toMatchObject({
      title: 'PHP 后端工程师',
      companyName: '竖云科技',
      salary: '20K-30K',
      location: '广州',
      platformId: 'liepin',
    })
  })

  it('extractJobDescriptionFromDetail 归一化空白后返回 JD 文本', () => {
    document.body.innerHTML = '<div class="job-description">  负责  \n  订单与库存  模块  </div>'
    expect(liepinAdapter.extractJobDescriptionFromDetail()).toBe('负责 订单与库存 模块')
  })

  it('getRiskConfig 返回猎聘专属风控文案', () => {
    const risk = liepinAdapter.getRiskConfig()
    expect(risk.id).toBe('liepin')
    expect(risk.dailyLimitMarkers).toContain('沟通上限')
    expect(risk.captchaMarkers.length).toBeGreaterThan(0)
  })

  it('getJobSpecificGreeting 生成含姓名 / 公司 / 岗位 / 匹配技能的招呼语', () => {
    const greeting = liepinAdapter.getJobSpecificGreeting(
      '候选人',
      makeJob(),
      { skillMatch: ['React', 'TypeScript'] } as never,
    )
    expect(greeting).toContain('候选人')
    expect(greeting).toContain('测试公司')
    expect(greeting).toContain('高级前端工程师')
    expect(greeting).toContain('React、TypeScript')
  })
})

describe('fetchJobDetailDescription · 详情页 JSON-LD', () => {
  it('从 JobPosting 的 description 提取完整 JD', async () => {
    const html = `<html><head>
      <script type="application/ld+json">{"@type":"JobPosting","description":"负责 ERP 订单与库存模块开发"}</script>
      </head><body></body></html>`
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, text: async () => html })))
    await expect(fetchJobDetailDescription('https://www.liepin.com/a/77558891.shtml'))
      .resolves.toBe('负责 ERP 订单与库存模块开发')
  })

  it('无 JSON-LD 或请求失败时安全返回空串', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, text: async () => '<html></html>' })))
    await expect(fetchJobDetailDescription('https://www.liepin.com/a/1.shtml')).resolves.toBe('')

    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down') }))
    await expect(fetchJobDetailDescription('https://www.liepin.com/a/2.shtml')).resolves.toBe('')
  })
})
