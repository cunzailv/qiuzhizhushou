// @vitest-environment jsdom
// 平台解析契约测试：固定 Boss 搜索列表的 DOM 结构，锁死解析行为。
// 平台改版时这里会先红，而不是等到「AIbot 一直找不到新岗位」才发现。
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { parseJobCardsFromSearchPage, detectPageType } from '../src/shared/platform/boss/parser'

beforeEach(() => {
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

function mount(html: string) {
  document.body.innerHTML = html
}

const standardCard = `
<li class="job-card-box">
  <div class="job-card-wrapper">
    <div class="job-info">
      <div class="job-title"><a href="https://www.zhipin.com/job_detail/abc123.html">PHP开发工程师</a></div>
      <span class="job-salary">15-25K</span>
      <div class="job-area">深圳·南山区</div>
      <ul class="tag-list"><li>3-5年</li><li>本科</li><li>Laravel</li></ul>
    </div>
    <div class="company-info">
      <h3 class="company-name"><a href="/gongsi/1.html">某某科技有限公司</a></h3>
    </div>
    <span class="boss-online-tag">今日活跃</span>
  </div>
</li>`

describe('Boss 搜索列表卡片解析契约', () => {
  it('能解析出标题、公司、薪资、地点、经验、学历与活跃时间', () => {
    mount(`<ul class="job-list-box">${standardCard}</ul>`)

    const cards = parseJobCardsFromSearchPage()
    expect(cards).toHaveLength(1)

    const card = cards[0]
    expect(card.title).toBe('PHP开发工程师')
    expect(card.companyName).toBe('某某科技有限公司')
    expect(card.salary).toBe('15-25K')
    expect(card.location).toContain('深圳')
    expect(card.experience).toBe('3-5年')
    expect(card.education).toBe('本科')
    expect(card.url).toContain('abc123')
    expect(card.publishedAt).toBe('今日活跃')
    expect(card.id).toBeTruthy()
  })

  it('标题内嵌薪资节点时，薪资不能泄漏进标题', () => {
    mount(`
      <ul class="job-list-box">
        <li class="job-card-box">
          <div class="job-title">
            <a href="https://www.zhipin.com/job_detail/x1.html">前端开发工程师</a>
            <span class="job-salary">20-30K</span>
          </div>
          <div class="company-info"><h3 class="company-name"><a>测试公司</a></h3></div>
        </li>
      </ul>`)

    const cards = parseJobCardsFromSearchPage()
    expect(cards).toHaveLength(1)
    expect(cards[0].title).toBe('前端开发工程师')
    expect(cards[0].title).not.toContain('K')
  })

  it('同一张卡片不会被重复解析', () => {
    mount(`
      <ul class="job-list-box">
        <li class="job-card-box">
          <div class="job-card-wrapper">
            <div class="job-title"><a href="https://www.zhipin.com/job_detail/dup.html">全栈工程师</a></div>
            <div class="company-info"><h3 class="company-name"><a>重复公司</a></h3></div>
          </div>
        </li>
      </ul>`)

    expect(parseJobCardsFromSearchPage()).toHaveLength(1)
  })

  it('多张卡片按顺序全部解析', () => {
    mount(`
      <ul class="job-list-box">
        <li class="job-card-box">
          <div class="job-title"><a href="https://www.zhipin.com/job_detail/a.html">后端开发</a></div>
          <h3 class="company-name"><a>A公司</a></h3>
        </li>
        <li class="job-card-box">
          <div class="job-title"><a href="https://www.zhipin.com/job_detail/b.html">前端开发</a></div>
          <h3 class="company-name"><a>B公司</a></h3>
        </li>
      </ul>`)

    const cards = parseJobCardsFromSearchPage()
    expect(cards).toHaveLength(2)
    expect(cards.map((c) => c.title)).toEqual(['后端开发', '前端开发'])
    expect(cards.map((c) => c.companyName)).toEqual(['A公司', 'B公司'])
  })

  it('没有标题的卡片被丢弃而不是产出空岗位', () => {
    mount(`
      <ul class="job-list-box">
        <li class="job-card-box">
          <div class="job-title"></div>
          <span class="job-salary">10-15K</span>
        </li>
      </ul>`)

    expect(parseJobCardsFromSearchPage()).toHaveLength(0)
  })

  it('空页面返回空数组且不抛异常', () => {
    mount('<div class="nothing"></div>')
    expect(() => parseJobCardsFromSearchPage()).not.toThrow()
    expect(parseJobCardsFromSearchPage()).toEqual([])
  })
})

describe('Boss 页面类型识别', () => {
  // 注：URL 分支依赖真实 location，jsdom 无法跨源改写，交由浏览器 e2e 覆盖。
  // 这里只锁死「DOM 兜底分支」，它同样会在改版时先报警。

  it('URL 无特征时按 DOM 判定为搜索列表页', () => {
    document.body.innerHTML = '<ul class="job-list-box"><li class="job-card-box"></li></ul>'
    expect(detectPageType()).toBe('search')
  })

  it('无任何页面特征时返回 other', () => {
    document.body.innerHTML = '<div class="blank"></div>'
    expect(detectPageType()).toBe('other')
  })
})
