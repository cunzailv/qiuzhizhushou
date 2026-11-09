// @vitest-environment jsdom
/**
 * 2026-11-09 第五轮真实账号现场日志（51job 修好之后，猎聘接棒报错）：
 *
 *   ⚠️ 页面未找到岗位卡片：招聘PHP工程师
 *      当前页（页面 www.liepin.com/zhaopin/） 0 张岗位卡片 / 41 个岗位详情链接 / 3 个按钮 / 正文 6993 字
 *   ❌ 投递未完成：[liepin] 招聘PHP工程师 (原因: 页面中未找到对应岗位卡片或详情无法展开)
 *      ｜现场：… / 岗位样例：商务助理【北京-大兴区】… / AI技术产品化经理【北京-顺义区】…
 *
 * 用同一已登录 Chrome 打开 `www.liepin.com/zhaopin/?key=PHP开发` 读真实 DOM：
 * 岗位是 `<a href="https://www.liepin.com/job/1986608107.shtml?…">PHP工程师【上海-虹口区】…</a>`，
 * 链接自身就承载标题 / 薪资 / 地点。但适配器只认三种卡片容器类名，
 * 站点一改版就 `qa(JOB_CARD_SELECTOR)` 全部落空 → 明明有 41 个岗位链接却报「找不到卡片」。
 *
 * 本文件锁死：不依赖任何 class 名，按 jobId → 标题 → 公司从详情链接精确反查，
 * 且绝不兜底点第一个岗位（会投错人）。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { findCardFromDetailLinks } from '../src/shared/platform/liepin'

const ROOT = process.cwd()
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf-8')
const ADAPTER = 'src/shared/platform/liepin/index.ts'
const SERVICE = 'src/background/campaign-service.ts'

const PHP_JOB = 'https://www.liepin.com/job/1986608107.shtml?pgRef=c_pc_search_page&d_posi=0'
const PHP_JOB_2 = 'https://www.liepin.com/job/1986608049.shtml?pgRef=c_pc_search_page&d_posi=1'
const OTHER_JOB = 'https://www.liepin.com/job/1986608999.shtml'
const OLD_STYLE_JOB = 'https://www.liepin.com/a/77558891.shtml'

function mountLinks() {
  document.body.innerHTML = `
    <div class="whatever-new-layout-2026">
      <a href="${PHP_JOB}">PHP工程师【上海-虹口区】15-40k1年以上本科</a>
      <a href="${PHP_JOB_2}">PHP开发【上海-徐汇区】20-30k2年以上本科</a>
      <a href="${OTHER_JOB}">商务助理【北京-大兴区】30-55k·16薪经验不限大专</a>
      <a href="${OLD_STYLE_JOB}">AI技术产品化经理【北京-顺义区】急聘15-20k·13薪</a>
      <a href="https://www.liepin.com/company/12345/">某某公司主页</a>
      <a href="https://www.liepin.com/zhaopin/">更多职位</a>
    </div>`
}

describe('猎聘：容器选择器失配时从岗位详情链接反查', () => {
  beforeEach(() => mountLinks())

  it('按 jobId 精确命中现场真实 URL', () => {
    const hit = findCardFromDetailLinks('1986608107', '招聘PHP工程师', '')
    expect(hit?.href).toContain('/job/1986608107.shtml')
  })

  it('jobId 没带上时按标题精确命中', () => {
    const hit = findCardFromDetailLinks('', 'PHP开发', '')
    expect(hit?.href).toContain('/job/1986608049.shtml')
  })

  it('平台在标题前加「招聘」前缀时，去前缀仍能命中', () => {
    const hit = findCardFromDetailLinks('', '招聘PHP工程师', '')
    expect(hit?.href).toContain('/job/1986608107.shtml')
  })

  it('按公司名也能命中，且旧版 /a/<id>.shtml 链接同样认得', () => {
    const hit = findCardFromDetailLinks('', '', 'AI技术产品化经理')
    expect(hit?.href).toContain('/a/77558891.shtml')
  })

  it('目标岗位不在本页时返回 null，绝不兜底点第一个岗位', () => {
    expect(findCardFromDetailLinks('9999999999', '不存在的岗位', '不存在的公司')).toBeNull()
    expect(findCardFromDetailLinks('', '', '')).toBeNull()
  })

  it('公司主页 / 频道页链接不参与反查', () => {
    const hit = findCardFromDetailLinks('12345', '', '')
    expect(hit).toBeNull()
  })

  it('页面一个岗位链接都没有时返回 null', () => {
    document.body.innerHTML = '<div>暂无职位</div>'
    expect(findCardFromDetailLinks('1986608107', 'PHP工程师', '')).toBeNull()
  })
})

describe('全链路接线静态契约', () => {
  it('activateJobCard 在容器选择器落空时调用反查', () => {
    const adapter = read(ADAPTER)
    expect(adapter).toContain('export function findCardFromDetailLinks')
    expect(adapter).toContain('findCardFromDetailLinks(jobId, expectedTitle, expectedCompany)')
    expect(adapter).toContain('Card resolved via detail-link fallback')
  })

  it('反查落在 <a> 上时，聊一聊按钮查找会向外层扩展作用域', () => {
    const adapter = read(ADAPTER)
    expect(adapter).toContain('let scope = (card as HTMLElement).parentElement')
    expect(adapter).toContain("findButtonByText(scope, ['聊一聊'])")
  })

  it('后台诊断会点明「有岗位链接但卡片容器未命中」', () => {
    const service = read(SERVICE)
    expect(service).toContain('cards === 0 && details > 0')
    expect(service).toContain('有岗位链接但卡片容器未命中')
  })
})
