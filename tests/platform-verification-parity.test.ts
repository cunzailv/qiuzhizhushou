// @vitest-environment jsdom
/**
 * 回归「Boss直聘、猎聘两个平台测试使用了，其他还需要测试」。
 *
 * 现状：51job / 智联 / 脉脉只有 `multi-platform-flow.test.ts` 的 Playwright + route mock
 * 模拟页面 E2E，**没有真实账号验证**。真实站点 DOM 与调研 fixture 必然有偏差，
 * 所以这组测试把「未实测平台」最容易出事的三件事锁死：
 *  1. 平台识别 / 注册 / 配额 / 风控文案不能缺项；
 *  2. 搜索 URL 真的带关键词与页码（否则永远停在推荐流）；
 *  3. 列表解析的岗位 ID 必须稳定 —— 它是补仓去重键，一旦用 Date.now() 兜底，
 *     站点改版后同一岗位每轮都换新 ID，会被反复入队、重复投递。
 *
 * 注意：本文件只能证明「适配层在调研 DOM 上行为正确」，不能替代真实账号验收。
 * 真实登录态 / 验证码 / 日限 / 聊天列表确认，仍需按 README 的验收清单人工跑一遍。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PLATFORMS, detectPlatformByUrl, getPlatformById } from '../src/shared/platform'
import { getPlatformSearchUrl } from '../src/background/tab-manager'
import { job51Adapter, SELECTORS as SELECTORS_51JOB } from '../src/shared/platform/51job'
import { zhaopinAdapter, SELECTORS as SELECTORS_ZHAOPIN } from '../src/shared/platform/zhaopin'
import { maimaiAdapter, SELECTORS as SELECTORS_MAIMAI } from '../src/shared/platform/maimai'
import { decideApplyVerification } from '../src/shared/agent/apply-verification'
import { DEFAULT_PLATFORM_QUOTAS } from '../src/shared/agent/quota'
import type { PlatformAdapter } from '../src/shared/platform/types'

const ROOT = process.cwd()
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf-8')

const PENDING = [
  {
    id: '51job',
    adapter: job51Adapter,
    urls: [
      'https://we.51job.com/pc/search?keyword=PHP',
      'https://jobs.51job.com/shenzhen/12345678.html',
    ],
  },
  {
    id: 'zhaopin',
    adapter: zhaopinAdapter,
    urls: ['https://sou.zhaopin.com/?kw=PHP', 'https://www.zhaopin.com/jobs?jl=765'],
  },
  {
    id: 'maimai',
    adapter: maimaiAdapter,
    urls: ['https://maimai.cn/jobs?query=PHP', 'https://maimai.cn/web/search_center?type=job'],
  },
] as const

const REQUIRED_METHODS: Array<keyof PlatformAdapter> = [
  'matchesUrl', 'detectPageType', 'parseJobCardsFromSearchPage',
  'parseJobDetailFromPage', 'extractJobDescriptionFromDetail', 'collectJobCards',
  'activateJobCard', 'clickApplyButton', 'fillGreetingMessage',
  'getJobSpecificGreeting', 'snapshotCommunicationUi', 'getRiskConfig',
]

beforeEach(() => {
  document.body.innerHTML = ''
})

// ─────────── ① 注册 / 识别 / 配置完整性 ───────────

describe('待验证平台 · 注册与 URL 识别', () => {
  it('三个平台都注册进 PLATFORMS，且能按 id 取回', () => {
    expect(PLATFORMS).toHaveLength(5)
    for (const { id, adapter } of PENDING) {
      expect(PLATFORMS.some((p) => p.id === id)).toBe(true)
      expect(getPlatformById(id)).toBe(adapter)
    }
  })

  it('各自网址只匹配自己，不串到别的平台', () => {
    for (const { id, urls } of PENDING) {
      for (const url of urls) {
        const hit = detectPlatformByUrl(url)
        expect(hit?.id, url).toBe(id)
      }
    }
  })

  it('适配器接口没有缺项，homeUrl 可直达且能被自己识别', () => {
    for (const { id, adapter } of PENDING) {
      for (const method of REQUIRED_METHODS) {
        expect(typeof adapter[method], `${id}.${String(method)}`).toBe('function')
      }
      expect(adapter.homeUrl, id).toMatch(/^https:\/\//)
      expect(adapter.matchesUrl(adapter.homeUrl), id).toBe(true)
    }
  })

  it('风控文案与每日配额都覆盖三个平台（否则日限 / 验证码识别会失灵）', () => {
    for (const { id, adapter } of PENDING) {
      const risk = adapter.getRiskConfig()
      expect(risk.id, id).toBe(id)
      expect(risk.dailyLimitMarkers.length, id).toBeGreaterThan(0)
      expect(risk.rateLimitMarkers.length, id).toBeGreaterThan(0)
      expect(risk.blockMarkers.length, id).toBeGreaterThan(0)
      expect(risk.captchaMarkers.length, id).toBeGreaterThan(0)
      expect(DEFAULT_PLATFORM_QUOTAS[id as keyof typeof DEFAULT_PLATFORM_QUOTAS], id).toBeGreaterThan(0)
    }
  })
})

// ─────────── ② 搜索 URL：关键词与翻页都必须生效 ───────────

describe('待验证平台 · 搜索 URL 契约', () => {
  it('query 真的写进 URL，不回落成推荐流首页', () => {
    const q = encodeURIComponent('PHP 后台')
    for (const { id } of PENDING) {
      const url = getPlatformSearchUrl(id, 'PHP 后台')
      expect(url, id).toContain(q)
      expect(url, id).not.toBe('https://maimai.cn/jobs')
    }
  })

  it('第 2 页带上各自的页码参数，补仓翻页不会永远停在第 1 页', () => {
    for (const { id } of PENDING) {
      const first = getPlatformSearchUrl(id, 'PHP', 1)
      const second = getPlatformSearchUrl(id, 'PHP', 2)
      expect(second, id).not.toBe(first)
      expect(second, id).toMatch(/[?&](page|p|pageNum|currentPage)=2/)
    }
  })
})

// ─────────── ③ 列表解析契约：字段、去重数量、稳定 ID ───────────

/** 与 multi-platform-flow.test.ts 的调研 DOM 一致，但去掉 data-jobid / 链接，专门压测 ID 兜底 */
const FIXTURES = {
  '51job': `
    <div class="joblist">
      <div class="joblist-item">
        <div class="joblist-item-left">
          <div class="joblist-item-jobname"><div class="job-info text-cut">PHP后台开发工程师</div></div>
          <div class="joblist-item-jobinfo text-cut">15-25K<div class="area">深圳·南山区</div></div>
          <div class="joblist-item-tags"><span class="tag">Laravel</span><span class="tag">PHP</span></div>
        </div>
        <div class="joblist-item-right">某某科技有限公司</div>
      </div>
    </div>`,
  zhaopin: `
    <div class="job-card">
      <div class="job-card__title-row"><div class="job-card__title-main">PHP后台开发工程师</div></div>
      <div class="job-card__salary">20K-30K</div>
      <div class="job-card__skill-tags"><span class="job-card__skill-tag">Laravel</span></div>
      <div class="job-card__company-row">中科创达软件股份有限公司</div>
    </div>`,
  maimai: `
    <div class="job-card">
      <div class="job-card-title">PHP后台开发工程师</div>
      <div class="job-card-salary">25-40K</div>
      <div class="job-card-company">字节跳动</div>
      <div class="job-card-tags"><span class="tag">PHP</span></div>
    </div>`,
} as const

describe('待验证平台 · 列表解析与去重键', () => {
  it('三个平台都能从各自的调研 DOM 解析出标题 / 公司 / 平台标识', () => {
    for (const { id, adapter } of PENDING) {
      document.body.innerHTML = FIXTURES[id]
      const cards = adapter.parseJobCardsFromSearchPage()
      expect(cards.length, id).toBeGreaterThan(0)
      const card = cards[0]
      expect(card.title, id).toContain('PHP后台开发工程师')
      expect(card.companyName, id).not.toBe('')
      expect(card.platformId, id).toBe(id)
      expect(card.id, id).toBeTruthy()
    }
  })

  it('同一张卡片只入队一次，不会因为宽泛选择器把子元素也当成岗位', () => {
    for (const { id, adapter } of PENDING) {
      document.body.innerHTML = FIXTURES[id]
      const cards = adapter.parseJobCardsFromSearchPage()
      const titles = cards.map((c) => `${c.title}|${c.companyName}`)
      expect(new Set(titles).size, `${id}: ${JSON.stringify(titles)}`).toBe(titles.length)
    }
  })

  it('没有详情链接 / data-jobid 时，ID 仍然稳定（旧版 Date.now() 会重复投递）', () => {
    for (const { id, adapter } of PENDING) {
      document.body.innerHTML = FIXTURES[id]
      const first = adapter.parseJobCardsFromSearchPage()[0]
      const second = adapter.parseJobCardsFromSearchPage()[0]
      expect(second.id, id).toBe(first.id)
      // 纯时间戳兜底会导致相邻两轮 ID 不同；这里再排除「看起来就是毫秒时间戳」
      expect(/^\d{13}$/.test(first.id), `${id}: ${first.id}`).toBe(false)
    }
  })

  it('选择器都保留多候选，站点改版时不会只靠一个类名', () => {
    expect(SELECTORS_51JOB.detailDesc).toContain(',')
    expect(SELECTORS_ZHAOPIN.detailPanel).toContain(',')
    expect(SELECTORS_MAIMAI.card).toContain(',')
  })
})

// ─────────── ④ 未实测平台更不能出现「假成功」 ───────────

describe('待验证平台 · 投递成功口径', () => {
  it('点了按钮但页面没有新增确认证据，一律不算平台确认', () => {
    const verdict = decideApplyVerification({
      clicked: true,
      greetingSent: false,
      pageTexts: [],
    })
    expect(verdict.level).toBe('unverified')
    expect(verdict.reason).toContain('不写投递记录')
  })

  it('确认层是统一链路，不为单个平台开特例', () => {
    const content = read('src/content/index.ts')
    expect(content).toContain('decideApplyVerification')
    const runner = read('src/content/task-runner.ts')
    expect(runner).toContain("verification.level !== 'confirmed'")
  })

  it('README 明确区分「真实账号实测」与「仅模拟页面 E2E」', () => {
    const readme = read('README.md')
    expect(readme).toContain('真实账号实测')
    expect(readme).toContain('待真实账号验证')
  })
})
