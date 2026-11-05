// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { db } from '../src/shared/db/index'
import { recordError, listErrors, clearErrors } from '../src/shared/db/error-store'
import {
  cleanTitle,
  cleanFullText,
  cleanCompanyName,
  cleanCompanyNameEnhanced,
  extractTitleTokens,
  fuzzyMultiWordMatch,
  isCompanyMatch,
  isTitleMatch,
  checkDetailPanelOffline,
  dismissUnexpectedModals,
  findApplyButtons,
  activateJobCard,
  activateJobCardWithFallback,
} from '../src/shared/platform/boss/action-simulator'

// Setup Chrome Mock and Window Sandbox
const mockLocalStorage: Record<string, any> = {}
const mockRuntimeMessages: any[] = []

function setupChromeMock() {
  for (const k of Object.keys(mockLocalStorage)) delete mockLocalStorage[k]
  mockRuntimeMessages.length = 0
  window.scrollBy = vi.fn()
  window.scrollTo = vi.fn()
  window.Element.prototype.scrollIntoView = vi.fn()

  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: vi.fn(async (_k) => ({})),
        set: vi.fn(async () => {}),
      },
    },
    runtime: {
      sendMessage: vi.fn(async (msg) => {
        mockRuntimeMessages.push(msg)
        if (msg.type === 'RECORD_ERROR') {
          await recordError(msg.payload)
        }
        return { success: true }
      }),
      onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
      lastError: null,
    },
  })
}

describe('自愈韧性智能体架构 · 目标卡片多阶激活降级 (Target Job Card Activation Fallback)', () => {
  beforeEach(async () => {
    setupChromeMock()
    await db.open()
    await clearErrors()
    document.body.innerHTML = ''
    window.history.pushState({}, '', '/web/geek/job')
  })

  afterEach(async () => {
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  // ─── 1. 行政后缀全面剥离与主体提取 (Administrative Suffix Stripping) ───
  describe('Suite 1: cleanCompanyNameEnhanced 行政与地理后缀剥离', () => {
    it('1.1 剥离一线直辖市 (北京/上海/天津/重庆) 与标准有限公司后缀', () => {
      expect(cleanCompanyNameEnhanced('北京字节跳动科技有限公司')).toBe('字节跳动')
      expect(cleanCompanyNameEnhanced('上海寻梦信息技术有限公司')).toBe('寻梦')
    })

    it('1.2 剥离省份 + 市级联合前缀 (如 广东省深圳市/浙江省杭州市)', () => {
      expect(cleanCompanyNameEnhanced('广东省深圳市方圆宝科技有限公司')).toBe('方圆宝')
      expect(cleanCompanyNameEnhanced('浙江省杭州市阿里巴巴网络技术有限公司')).toBe('阿里巴巴')
    })

    it('1.3 剥离集团/控股/分公司等复合企业组织形式', () => {
      expect(cleanCompanyNameEnhanced('广州华讯网络技术服务有限公司分公司')).toBe('华讯')
      expect(cleanCompanyNameEnhanced('腾讯科技(深圳)有限公司')).toBe('腾讯')
      expect(cleanCompanyNameEnhanced('美团(北京三快在线科技有限公司)')).toBe('美团三快在线')
    })

    it('1.4 剥离合伙企业、事务所、独资等特殊组织形式', () => {
      expect(cleanCompanyNameEnhanced('红杉资本股权投资管理(天津)合伙企业(有限合伙)')).toBe('红杉资本股权投资管理')
    })

    it('1.5 极短名称或纯外企名称防过度清洗兜底', () => {
      expect(cleanCompanyNameEnhanced('Google LLC')).toBe('googlellc')
      expect(cleanCompanyNameEnhanced('Apple')).toBe('apple')
      expect(cleanCompanyNameEnhanced('')).toBe('')
    })
  })

  // ─── 2. 职位分词与去后缀模糊多词匹配 (Fuzzy Multi-Word Match) ───
  describe('Suite 2: extractTitleTokens & fuzzyMultiWordMatch 模糊多词评分', () => {
    it('2.1 正确切分中文与技术栈复合职位关键词', () => {
      const tokens = extractTitleTokens('全栈开发工程师（React / Node.js 方向）')
      expect(tokens).toContain('全栈')
      expect(tokens).toContain('开发')
      expect(tokens).toContain('工程师')
      expect(tokens).toContain('react')
      expect(tokens).toContain('node.js')
    })

    it('2.2 标题与公司全匹配时满分 1.0', () => {
      const card = '高级前端工程师 深圳市方圆宝科技有限公司 25-35K'
      const res = fuzzyMultiWordMatch(card, '高级前端工程师', '深圳市方圆宝科技有限公司')
      expect(res.matched).toBe(true)
      expect(res.score).toBe(1.0)
    })

    it('2.3 词序倒置与修饰词不同时命中并达到高分', () => {
      const card = 'Web前端开发专家 (React架构) 方圆宝科技'
      const res = fuzzyMultiWordMatch(card, 'React Web前端工程师', '深圳市方圆宝科技有限公司')
      expect(res.matched).toBe(true)
      expect(res.score).toBeGreaterThanOrEqual(0.65)
    })

    it('2.4 斜杠复合职位分词重叠判定', () => {
      const card = '全栈产品工程师 独立开发 20-40K 方圆宝'
      const res = fuzzyMultiWordMatch(card, '全栈工程师 / 独立开发者', '方圆宝')
      expect(res.matched).toBe(true)
      expect(res.titleScore).toBeGreaterThanOrEqual(0.6)
    })

    it('2.5 公司不匹配时触发惩罚性降分，坚决防止跨公司误投', () => {
      const card = '高级前端工程师 百度网讯科技有限公司 25-35K'
      const res = fuzzyMultiWordMatch(card, '高级前端工程师', '深圳市方圆宝科技有限公司')
      expect(res.companyScore).toBe(0)
      expect(res.matched).toBe(false) // 综合分低于 0.55
    })

    it('2.6 职位完全无关时拒绝匹配 (如 销售总监 vs 前端)', () => {
      const card = '商务拓展与销售总监 方圆宝科技'
      const res = fuzzyMultiWordMatch(card, '前端工程师', '方圆宝')
      expect(res.matched).toBe(false)
      expect(res.titleScore).toBe(0)
    })
  })

  // ─── 3. Tier 1: 常规视口定位与虚拟列表复位 ───
  describe('Suite 3: Tier 1 常规定位与视口滚动复位', () => {
    it('3.1 视口内卡片通过 data-jobid 快速激活', async () => {
      const card = document.createElement('div')
      card.setAttribute('data-jobid', 'job_alpha_1')
      card.innerHTML = '<a href="/job_detail/job_alpha_1.html" class="job-name">Node.js架构师</a>'
      document.body.appendChild(card)

      const result = await activateJobCard('https://zhipin.com/job_detail/job_alpha_1.html', 'job_alpha_1', 'Node.js架构师', '')
      expect(result).not.toBeNull()
    })

    it('3.2 右侧已展开详情面板时直接复用，不重复触发点击', async () => {
      const detail = document.createElement('div')
      detail.className = 'job-detail-box'
      detail.innerHTML = '<h1>技术总监</h1><p>方圆宝</p><button class="btn-startchat">立即沟通</button>'
      Object.defineProperty(detail, 'offsetWidth', { value: 600, configurable: true })
      Object.defineProperty(detail, 'offsetHeight', { value: 800, configurable: true })
      document.body.appendChild(detail)

      const res = await activateJobCard('', '', '技术总监', '方圆宝')
      expect(res).toBe(detail)
    })

    it('3.3 职位下线时给详情容器打上 data-job-offline="true" 标记', () => {
      const detail = document.createElement('div')
      detail.className = 'job-detail-box'
      detail.innerHTML = '<h2>该职位已停止招聘</h2>'
      document.body.appendChild(detail)

      expect(checkDetailPanelOffline(detail)).toBe(true)
    })
  })

  // ─── 4. Tier 2: 去行政后缀模糊多词降级与自愈事件入库 ───
  describe('Suite 4: Tier 2 模糊多词降级与自愈诊断', () => {
    it('4.1 常规定位失败后，Tier 2 成功通过模糊分词激活卡片', async () => {
      window.history.pushState({}, '', '/web/geek/job')
      const card = document.createElement('li')
      card.className = 'job-card-box'
      card.innerHTML = `
        <div class="job-card-body">
          <div class="job-title">React Web前端开发专家</div>
          <div class="company-name">方圆宝科技</div>
        </div>
      `
      document.body.appendChild(card)

      const detail = document.createElement('div')
      detail.className = 'job-detail-box'
      detail.innerHTML = '<h3>React Web前端开发专家</h3><p>方圆宝</p><button class="btn-startchat">立即沟通</button>'
      Object.defineProperty(detail, 'offsetWidth', { value: 500, configurable: true })
      Object.defineProperty(detail, 'offsetHeight', { value: 600, configurable: true })
      document.body.appendChild(detail)

      const result = await activateJobCardWithFallback(
        'https://zhipin.com/job_detail/obfuscated_token.html',
        'diff_id_999',
        '全栈前端工程师 (React方向)',
        '深圳市方圆宝科技有限公司'
      )
      expect(result).not.toBeNull()
    })

    it('4.2 Tier 2 降级激活时，自动记录 self-healing.card_fallback 审计日志', async () => {
      window.history.pushState({}, '', '/web/geek/job')
      const card = document.createElement('li')
      card.className = 'job-card-box'
      card.innerHTML = '<div class="job-title">Java开发</div><div class="company-name">华讯</div>'
      document.body.appendChild(card)

      const detail = document.createElement('div')
      detail.className = 'job-detail-box'
      detail.innerHTML = '<h3>Java开发</h3><p>华讯</p><button class="btn-startchat">立即沟通</button>'
      Object.defineProperty(detail, 'offsetWidth', { value: 500, configurable: true })
      Object.defineProperty(detail, 'offsetHeight', { value: 600, configurable: true })
      document.body.appendChild(detail)

      await activateJobCardWithFallback(
        'https://zhipin.com/job_detail/java_123.html',
        'unmatched_id',
        'Java后端开发工程师',
        '广州华讯网络技术服务有限公司分公司'
      )

      const errors = await listErrors(10)
      const fallbackEvent = errors.find((e) => e.source.includes('card_fallback'))
      expect(fallbackEvent).toBeDefined()
      expect(fallbackEvent?.message).toContain('fuzzyMultiWordMatch')
    })
  })

  // ─── 5. Tier 3: 独立 URL 详情页静默直达与异常边界 ───
  describe('Suite 5: Tier 3 静默直达与边界容错', () => {
    it('5.1 列表无卡片时，降级为独立 URL 详情页直接绑定投递容器', async () => {
      window.history.pushState({}, '', '/search')
      // DOM 中完全没有列表卡片，仅存在独立详情页的 DOM 容器
      const detailContainer = document.createElement('div')
      detailContainer.className = 'job-detail-box'
      detailContainer.innerHTML = '<h1>系统架构师</h1><div class="btn-startchat">立即沟通</div>'
      document.body.appendChild(detailContainer)

      const res = await activateJobCardWithFallback(
        'https://www.zhipin.com/job_detail/target_standalone_777.html',
        'target_standalone_777',
        '系统架构师',
        '方圆宝'
      )
      expect(res).not.toBeNull()
      expect(res?.className).toContain('job-detail-box')
      expect(window.location.pathname).toContain('target_standalone_777')
    })

    it('5.2 畸形 URL (invalid-url-string) 平稳返回 null，不抛出异常', async () => {
      const res = await activateJobCardWithFallback('invalid-url-string', '', '', '')
      expect(res).toBeNull()
    })

    it('5.3 全空参数 (jobUrl="", jobId="", title="", company="") 安全返回 null', async () => {
      const res = await activateJobCardWithFallback('', '', '', '')
      expect(res).toBeNull()
    })

    it('5.4 零尺寸卡片 (offsetWidth=0, offsetHeight=0) 过滤不予点击', async () => {
      const card = document.createElement('li')
      card.className = 'job-card-box'
      card.innerHTML = '<div class="job-title">算法工程师</div>'
      Object.defineProperty(card, 'offsetWidth', { value: 0, configurable: true })
      Object.defineProperty(card, 'offsetHeight', { value: 0, configurable: true })
      document.body.appendChild(card)

      const found = findApplyButtons(card)
      expect(found.length).toBe(0)
    })
  })
})
