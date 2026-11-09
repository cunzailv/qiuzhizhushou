// @vitest-environment jsdom
/**
 * 51job 真实页面回归（2026-11-09 现场调试）。
 *
 * 用户报错：`❌ 投递未完成：[51job] AI全栈开发工程师 (原因: 页面中未找到对应岗位卡片或详情无法展开)`
 * 现场 Chrome 里同时出现十几个 `jobs.51job.com/all/coXXX.html` 公司页标签。
 *
 * 真实搜索页 DOM（we.51job.com/pc/search?keyword=PHP）里同时有两类链接：
 *   · 公司页 https://jobs.51job.com/all/coUzxRPVA2VmkAYQdlVjY.html
 *   · 岗位页 https://jobs.51job.com/shenzhen-ftq/173795328.html?s=pchome...
 * 旧适配器取「第一个 a[href*=jobs.51job.com]」→ 抓到公司页 → activateJobCard
 * window.open 它 → 回原搜索页找详情容器 → null → 必然失败，还刷一堆垃圾标签。
 *
 * 本文件用现场复刻的 DOM 锁死：公司页永不作为 jobUrl、不新开标签页、
 * 找不到目标岗位时必须返回 null（绝不投错第一个卡片）、投递按钮点得准。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  job51Adapter,
  isJobDetailUrl,
  isCompanyPageUrl,
  SELECTORS,
} from '../src/shared/platform/51job'
import {
  collectPageDomDiagnostics,
  describePageDomDiagnostics,
} from '../src/content/task-runner'

const ROOT = process.cwd()
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf-8')
const ADAPTER = 'src/shared/platform/51job/index.ts'
const RUNNER = 'src/content/task-runner.ts'
const SERVICE = 'src/background/campaign-service.ts'

const COMPANY_URL = 'https://jobs.51job.com/all/coUzxRPVA2VmkAYQdlVjY.html'
const JOB_URL = 'https://jobs.51job.com/shenzhen-ftq/173795328.html?s=pchome_jobgroup_joblist&t=0_0'

/** 复刻现场 Chrome 的搜索页结构：公司链接 + 投递按钮 + 岗位详情链接 */
function mountRealisticSearchPage(options: { withApplyButton?: boolean } = {}) {
  const applyBtn = options.withApplyButton === false ? '' : '<button>投递</button>'
  document.body.innerHTML = `
    <div class="joblist">
      <div class="joblist-item">
        <a href="${COMPANY_URL}">凯帝纳国际货运代理（上海）有限公司深圳分公司  货运/物流/仓储 外资（欧美） 少于50人</a>
        <button>+ 关注</button>
        <a href="${JOB_URL}">PHP开发工程师1.2-1.5万·13薪凯帝纳国际货运代理（上海）有限公司深圳深圳·福田区</a>
        ${applyBtn}
      </div>
      <div class="joblist-item">
        <a href="https://jobs.51job.com/all/coAWBUNVAwUW8BbFQ2UjU.html">深圳建广数字科技有限公司青岛分公司  计算机软件丨企业服务 民营 1000-5000人</a>
        <a href="https://jobs.51job.com/shenzhen/173992381.html?s=pchome_jobgroup_joblist">PHP开发1.3-1.3万深圳建广数字科技有限公司青岛深圳</a>
        ${applyBtn}
      </div>
    </div>
  `
}

describe('51job URL 分类：公司页永远不是岗位页', () => {
  it('识别真实岗位详情链接（城市可带连字符、可带 query）', () => {
    expect(isJobDetailUrl(JOB_URL)).toBe(true)
    expect(isJobDetailUrl('https://jobs.51job.com/shenzhen/173992381.html')).toBe(true)
  })

  it('把公司页明确判为非岗位页', () => {
    expect(isJobDetailUrl(COMPANY_URL)).toBe(false)
    expect(isCompanyPageUrl(COMPANY_URL)).toBe(true)
  })

  it('城市聚合页同样不算岗位页', () => {
    expect(isJobDetailUrl('https://jobs.51job.com/shantou/')).toBe(false)
    expect(isCompanyPageUrl('https://jobs.51job.com/shantou/')).toBe(false)
  })

  it('新版 we.51job 带 jobid 的链接也认作岗位', () => {
    expect(isJobDetailUrl('https://we.51job.com/pc/jobdetail?jobid=173992381')).toBe(true)
  })
})

describe('51job 列表采集：只拿岗位链接，不拿公司链接', () => {
  beforeEach(() => mountRealisticSearchPage())

  it('从真实结构采到 2 个岗位，jobUrl 都是数字 ID 岗位页', () => {
    const cards = job51Adapter.parseJobCardsFromSearchPage()
    expect(cards).toHaveLength(2)
    for (const card of cards) {
      expect(isJobDetailUrl(card.url)).toBe(true)
      expect(card.url).not.toContain('/all/co')
    }
  })

  it('岗位 ID 取数字 ID，稳定且不等于公司页 URL', () => {
    const cards = job51Adapter.parseJobCardsFromSearchPage()
    expect(cards.map((c) => c.id).sort()).toEqual(['173795328', '173992381'])
    expect(cards.every((c) => !c.id.includes('jobs.51job.com'))).toBe(true)
  })

  it('公司名从公司页链接里取，不带行业/规模后缀', () => {
    const cards = job51Adapter.parseJobCardsFromSearchPage()
    const company = cards.find((c) => c.id === '173795328')?.companyName || ''
    expect(company).toContain('有限公司')
    expect(company).not.toContain('外资')
    expect(company).not.toContain('少于50人')
  })

  it('标题从岗位链接文本里切出，薪资不混进职位名', () => {
    const cards = job51Adapter.parseJobCardsFromSearchPage()
    const title = cards.find((c) => c.id === '173795328')?.title || ''
    expect(title).toContain('PHP开发工程师')
    expect(title).not.toContain('1.2-1.5万')
  })

  it('经典 .joblist-item 模拟页面仍然兼容（不破坏既有 E2E）', () => {
    document.body.innerHTML = `
      <div class="joblist">
        <div class="joblist-item" data-jobid="job51-001">
          <div class="joblist-item-jobname"><div class="job-info text-cut">前端工程师（AI方向）</div></div>
          <div class="joblist-item-jobinfo text-cut">20-30万·14薪<div class="area">上海·浦东新区</div></div>
          <div class="joblist-item-right">裕太微电子股份有限公司</div>
          <button>投递</button>
        </div>
      </div>`
    const cards = job51Adapter.parseJobCardsFromSearchPage()
    expect(cards).toHaveLength(1)
    expect(cards[0].id).toBe('job51-001')
    expect(cards[0].title).toBe('前端工程师（AI方向）')
    expect(cards[0].companyName).toContain('裕太微电子')
  })
})

describe('51job 激活与投递：不新开标签页、不投错岗位', () => {
  beforeEach(() => {
    mountRealisticSearchPage()
    vi.spyOn(window, 'open').mockImplementation(() => null)
  })
  afterEach(() => vi.restoreAllMocks())

  it('公司页 jobUrl 绝不触发 window.open（旧版刷了一堆公司页标签）', async () => {
    const el = await job51Adapter.activateJobCard(COMPANY_URL, COMPANY_URL, 'PHP开发工程师', '凯帝纳')
    expect(window.open).not.toHaveBeenCalled()
    // 公司页 URL 本身无法定位岗位，但页面里有同标题岗位链接，应按标题回退命中
    expect(el).not.toBeNull()
  })

  it('按数字 jobId 精确命中卡片，返回含「投递」按钮的容器', async () => {
    const el = await job51Adapter.activateJobCard(JOB_URL, '173795328', 'PHP开发工程师', '凯帝纳')
    expect(window.open).not.toHaveBeenCalled()
    expect(el).not.toBeNull()
    const btnTexts = Array.from(el!.querySelectorAll('button')).map((b) => (b.textContent || '').trim())
    expect(btnTexts).toContain('投递')
  })

  it('目标岗位不在当前页时返回 null，绝不兜底点第一个卡片', async () => {
    const el = await job51Adapter.activateJobCard(
      'https://jobs.51job.com/shenzhen/999999999.html',
      '999999999',
      '不存在的岗位',
      '不存在的公司',
    )
    expect(el).toBeNull()
    expect(window.open).not.toHaveBeenCalled()
  })

  it('页面没有任何岗位详情链接时，仍按 data-jobid 命中老结构卡片（E2E 回归）', async () => {
    document.body.innerHTML = `
      <div class="joblist">
        <div class="joblist-item" data-jobid="job51-001">
          <div class="joblist-item-jobname"><div class="job-info text-cut">前端工程师（AI方向）</div></div>
          <div class="joblist-item-jobinfo text-cut">20-30万·14薪<div class="area">上海·浦东新区</div></div>
          <div class="joblist-item-right">裕太微电子股份有限公司</div>
          <button>投递</button>
        </div>
      </div>`
    const el = await job51Adapter.activateJobCard('', 'job51-001', '前端工程师（AI方向）', '裕太微电子股份有限公司')
    expect(el).not.toBeNull()
    expect(el!.getAttribute('data-jobid')).toBe('job51-001')
    expect(Array.from(el!.querySelectorAll('button')).map((b) => (b.textContent || '').trim())).toContain('投递')
    expect(window.open).not.toHaveBeenCalled()
  })

  it('老结构无详情链接时先点卡片行展开 JD，再返回目标卡片（评分依赖完整 JD）', async () => {
    document.body.innerHTML = `
      <div class="joblist">
        <div class="joblist-item" data-jobid="job51-001">
          <div class="joblist-item-jobname">前端工程师（AI方向）</div>
          <button>投递</button>
        </div>
      </div>`
    const card = document.querySelector<HTMLElement>('.joblist-item')!
    let opened = 0
    card.addEventListener('click', () => {
      opened++
      const desc = document.createElement('div')
      desc.className = 'job_msg'
      desc.textContent = 'React TypeScript JavaScript HTML CSS Node.js 负责前端开发'
      document.body.append(desc)
    })
    const el = await job51Adapter.activateJobCard('', 'job51-001', '前端工程师（AI方向）', '裕太微电子')
    expect(opened).toBe(1)
    expect(el).toBe(card)
    // batch 模式靠 adapter.extractJobDescriptionFromDetail(卡片) 拿完整 JD 打分
    expect(job51Adapter.extractJobDescriptionFromDetail(el!).length).toBeGreaterThan(30)
  })

  it('老结构页面里找不到目标 jobId 时依然返回 null，不投第一张卡', async () => {
    document.body.innerHTML = `
      <div class="joblist">
        <div class="joblist-item" data-jobid="job51-001"><button>投递</button></div>
      </div>`
    expect(await job51Adapter.activateJobCard('', 'job51-999', '别的岗位', '别的公司')).toBeNull()
  })

  it('clickApplyButton 只点「投递」，不会误点「+ 关注」', async () => {
    const card = document.querySelector<HTMLElement>('.joblist-item')!
    const clicked: string[] = []
    card.querySelectorAll('button').forEach((b) => {
      b.addEventListener('click', () => clicked.push((b.textContent || '').trim()))
    })
    const ok = await job51Adapter.clickApplyButton(card)
    expect(ok).toBe(true)
    expect(clicked).toContain('投递')
    expect(clicked).not.toContain('+ 关注')
  })

  it('没有投递按钮时返回 false，不虚报点击成功', async () => {
    mountRealisticSearchPage({ withApplyButton: false })
    document.querySelectorAll('button').forEach((b) => {
      if ((b.textContent || '').includes('投递')) b.remove()
    })
    const card = document.querySelector<HTMLElement>('.joblist-item')!
    expect(await job51Adapter.clickApplyButton(card)).toBe(false)
  })
})

describe('51job 没有「打招呼」：只在确认弹窗里点确定', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  it('没有弹窗时返回 false（不无脑点任意含「投递」的按钮）', async () => {
    document.body.innerHTML = '<button>投递</button><button>+ 关注</button>'
    expect(await job51Adapter.fillGreetingMessage('您好')).toBe(false)
  })

  it('出现投递确认弹窗时点「确定」', async () => {
    document.body.innerHTML = `
      <div role="dialog"><p>确认投递该职位？</p><button>确定</button><button>取消</button></div>`
    let confirmed = false
    document.querySelector('[role="dialog"] button')!.addEventListener('click', () => { confirmed = true })
    expect(await job51Adapter.fillGreetingMessage('您好')).toBe(true)
    expect(confirmed).toBe(true)
  })

  it('UI 快照包含可见弹窗，投递成功提示才能成为平台确认信号', () => {
    document.body.innerHTML = '<div role="dialog">投递成功</div>'
    const snapshot = job51Adapter.snapshotCommunicationUi()
    expect(snapshot.visibleDialogs.size).toBeGreaterThan(0)
  })
})

describe('bot 是否记录了问题：现场诊断与留痕链路', () => {
  beforeEach(() => mountRealisticSearchPage())

  it('DOM 诊断能看到卡片数 / 详情链接数 / 按钮数 / 链接样例', () => {
    const diag = collectPageDomDiagnostics()
    expect(Number(diag.jobCards)).toBeGreaterThan(0)
    expect(Number(diag.detailLinks)).toBeGreaterThan(0)
    expect(Number(diag.buttons)).toBeGreaterThan(0)
    expect(Array.isArray(diag.sampleLinkTexts)).toBe(true)
    expect(describePageDomDiagnostics(diag)).toContain('张岗位卡片')
  })

  it('适配器源码里不再有 window.open', () => {
    const adapter = read(ADAPTER)
    expect(adapter).not.toContain('window.open(')
    expect(adapter).toContain('isJobDetailUrl')
    expect(adapter).toContain('isCompanyPageUrl')
    expect(SELECTORS.companyLink).toContain('/all/co')
  })

  it('错误上报带三层兜底，后台休眠时不会把诊断丢掉', () => {
    const runner = read(RUNNER)
    expect(runner).toContain('fallbackRecordRunnerError')
    expect(runner).toContain('appendSharedError')
    expect(runner).toContain('collectPageDomDiagnostics')
    // 旧版只数 Boss 选择器，对 51job 恒为 0
    expect(runner).not.toContain("'li.job-card-box, .job-card-wrapper")
  })

  it('现场诊断会回传后台并写进 AIbot 行为日志与错误记录', () => {
    const service = read(SERVICE)
    expect(service).toContain('describeRunnerDiagnostics')
    expect(service).toContain('diagnostics: result.diagnostics')
    expect(service).toContain('diagNote')
  })
})
