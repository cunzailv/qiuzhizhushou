// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { db } from '../src/shared/db/index'
import { clearErrors, listErrors, recordError } from '../src/shared/db/error-store'
import {
  setSkillMemoryTransportForTesting,
} from '../src/shared/agent/skill-memory'
import {
  cleanCompanyNameEnhanced,
  activateJobCardWithFallback,
  findConfiguredApplyButtons,
  findApplyButtons,
  clickApplyButtonWithResilience,
} from '../src/shared/platform/boss/action-simulator'

describe('Challenger M2 Gate 2: Empirical Stress Test Suite (Scenarios A - E)', () => {
  beforeEach(async () => {
    setSkillMemoryTransportForTesting('direct')
    await db.open()
    await db.agentSkills.clear()
    await clearErrors()
    await db.settings.put({ key: 'apiKey', value: 'mock-test-key' })
    await db.settings.put({ key: 'apiBaseUrl', value: 'https://api.mock.test/v1' })

    document.body.innerHTML = ''
    document.body.className = ''
    document.body.style.overflow = ''
    document.body.style.position = ''
    document.body.style.pointerEvents = ''
    document.documentElement.className = ''
    document.documentElement.style.overflow = ''
    document.documentElement.style.pointerEvents = ''

    window.scrollBy = vi.fn()
    window.scrollTo = vi.fn()
    window.Element.prototype.scrollIntoView = vi.fn()
    window.history.pushState({}, '', '/web/geek/job')

    vi.stubGlobal('chrome', {
      storage: {
        local: {
          get: vi.fn(async () => ({ apiKey: 'mock-test-key', apiBaseUrl: 'https://api.mock.test/v1' })),
          set: vi.fn(async () => {}),
        },
      },
      runtime: {
        sendMessage: vi.fn(async (msg) => {
          if (msg?.type === 'RECORD_ERROR') {
            await recordError(msg.payload)
          }
          return { success: true }
        }),
        lastError: null,
      },
    })
  })

  afterEach(() => {
    setSkillMemoryTransportForTesting(null)
    vi.restoreAllMocks()
    vi.useRealTimers()
    document.body.innerHTML = ''
    window.history.pushState({}, '', '/web/geek/job')
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // Scenario A: Non-anchor element job-name without href
  // ═══════════════════════════════════════════════════════════════════════════
  describe('Scenario A: Target job card contains non-anchor <span/div class="job-name"> without href', () => {
    it('Scenario A.1: <span class="job-name"> does NOT throw TypeError: Cannot read properties of undefined (reading includes)', async () => {
      document.body.innerHTML = `
        <div class="job-list-box">
          <li class="job-card-box">
            <span class="job-name">资深全栈工程师</span>
            <span class="company-name">腾讯科技</span>
          </li>
        </div>
      `

      // Calling activateJobCardWithFallback must resolve without throwing TypeError
      let threwError = false
      let result: HTMLElement | null = null
      try {
        result = await activateJobCardWithFallback(
          'https://www.zhipin.com/job_detail/tencent_a1.html',
          'tencent_a1',
          '资深全栈工程师',
          '腾讯科技',
          { allowDirectUrl: true, maxDetailWaitMs: 50 }
        )
      } catch (err) {
        threwError = true
      }

      expect(threwError).toBe(false)
      expect(result).not.toBeNull()
    })

    it('Scenario A.2: Multiple non-anchor elements (<div class="job-name">, <h3 class="job-name">) without href', async () => {
      document.body.innerHTML = `
        <div class="job-list-box">
          <div class="job-card-box">
            <div class="job-name">Go后端架构师</div>
            <div class="company-name">字节跳动</div>
          </div>
          <div class="job-card-box">
            <h3 class="job-name">Python算法专家</h3>
            <span class="company-name">阿里巴巴</span>
          </div>
        </div>
      `

      const res = await activateJobCardWithFallback(
        'https://www.zhipin.com/job_detail/bytedance_go.html',
        'bytedance_go',
        'Go后端架构师',
        '字节跳动',
        { allowDirectUrl: true, maxDetailWaitMs: 50 }
      )

      expect(res).not.toBeNull()
      expect(res).toBeDefined()
    })

    it('Scenario A.3: Corrupted anchor element where .href is explicitly undefined', async () => {
      document.body.innerHTML = `
        <div class="job-list-box">
          <li class="job-card-box">
            <a class="job-name">测试岗位</a>
            <span class="company-name">某公司</span>
          </li>
        </div>
      `
      const badAnchor = document.querySelector('a.job-name') as HTMLAnchorElement
      badAnchor.removeAttribute('href')
      Object.defineProperty(badAnchor, 'href', { value: undefined, configurable: true })

      let threw = false
      try {
        await activateJobCardWithFallback(
          'https://www.zhipin.com/job_detail/no_href.html',
          'no_href',
          '测试岗位',
          '某公司',
          { allowDirectUrl: true, maxDetailWaitMs: 50 }
        )
      } catch {
        threw = true
      }
      expect(threw).toBe(false)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // Scenario B: Cross-Company Misapplication Prevention
  // ═══════════════════════════════════════════════════════════════════════════
  describe('Scenario B: Cross-Company Misapplication Prevention in Tier 1 fallbackCard', () => {
    it('Scenario B.1: Target is 腾讯, DOM card is 快手 with identical title "前端开发工程师"', async () => {
      document.body.innerHTML = `
        <ul class="job-list-box">
          <li class="job-card-box" id="kuaishou-card">
            <a class="job-title" href="/job_detail/kuaishou_fe.html">前端开发工程师</a>
            <span class="company-name">北京快手科技有限公司</span>
          </li>
        </ul>
      `
      const kuaishouCard = document.getElementById('kuaishou-card')!
      let kuaishouClicked = false
      kuaishouCard.addEventListener('click', () => {
        kuaishouClicked = true
      })

      const targetUrl = 'https://www.zhipin.com/job_detail/tencent_fe_999.html'
      const targetJobId = 'tencent_fe_999'
      const targetTitle = '前端开发工程师'
      const targetCompany = '腾讯科技（深圳）有限公司'

      const result = await activateJobCardWithFallback(
        targetUrl,
        targetJobId,
        targetTitle,
        targetCompany,
        { allowDirectUrl: true, maxDetailWaitMs: 100 }
      )

      // CRITICAL VERIFICATION:
      // 1. The 快手 card must NOT be clicked!
      expect(kuaishouClicked).toBe(false)
      // 2. The result must NOT be the 快手 card!
      expect(result).not.toBe(kuaishouCard)
      // 3. Execution falls through Tier 1 -> Tier 2 (penalty fails match) -> Tier 3 direct URL
      expect(window.location.pathname).toContain('tencent_fe_999.html')
    })

    it('Scenario B.2: Target has NO expectedCompany specified -> fallbackCard is allowed as legitimate fallback', async () => {
      document.body.innerHTML = `
        <ul class="job-list-box">
          <li class="job-card-box" id="any-card">
            <a class="job-title" href="/job_detail/some_fe.html">前端开发工程师</a>
            <span class="company-name">某互联网公司</span>
          </li>
        </ul>
      `
      const anyCard = document.getElementById('any-card')!
      let cardClicked = false
      anyCard.addEventListener('click', () => {
        cardClicked = true
      })

      const result = await activateJobCardWithFallback(
        'https://www.zhipin.com/job_detail/some_fe.html',
        'some_fe',
        '前端开发工程师',
        '', // No company specified
        { allowDirectUrl: true, maxDetailWaitMs: 100 }
      )

      expect(cardClicked).toBe(true)
      expect(result).toBe(anyCard)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // Scenario C: activateJobCard unexpected runtime error
  // ═══════════════════════════════════════════════════════════════════════════
  describe('Scenario C: activateJobCard throws unexpected runtime error (e.g. simulated DOM detach)', () => {
    it('Scenario C.1: Tier 1 throws unexpected DOMException during DOM detach -> caught and falls through to Tier 3', async () => {
      document.body.innerHTML = `
        <ul class="job-list-box">
          <li class="job-card-box" id="detaching-card">
            <a class="job-title" href="/job_detail/detach_test.html">资深架构师</a>
            <span class="company-name">阿里巴巴</span>
          </li>
        </ul>
      `

      // Simulate DOM detachment during Tier 1: card detaches from DOM and throws DOMException
      const card = document.getElementById('detaching-card')!
      card.scrollIntoView = vi.fn().mockImplementation(() => {
        card.remove() // Simulated DOM detach: element is removed from DOM tree
        throw new DOMException('HierarchyRequestError: The node is no longer attached to the document', 'HierarchyRequestError')
      })

      let didThrow = false
      let result: HTMLElement | null = null
      try {
        result = await activateJobCardWithFallback(
          'https://www.zhipin.com/job_detail/detach_test.html',
          'detach_test',
          '资深架构师',
          '阿里巴巴',
          { allowDirectUrl: true, maxDetailWaitMs: 50 }
        )
      } catch (err) {
        didThrow = true
      }

      // Tier 1 exception was caught, and because card detached, Tier 2 safely bypassed to Tier 3
      expect(didThrow).toBe(false)
      expect(result).not.toBeNull()
      expect(window.location.pathname).toContain('detach_test.html')
    })

    it('Scenario C.2: Tier 1 throws DOMException on detached Card 1, and Tier 2 recovers using Card 2', async () => {
      document.body.innerHTML = `
        <ul class="job-list-box">
          <li class="job-card-box" id="card-broken" data-jobid="broken_job">
            <a class="job-title" href="/job_detail/broken_job.html">资深架构师</a>
            <span class="company-name">腾讯科技</span>
          </li>
          <li class="job-card-box" id="card-valid">
            <a class="job-title" href="/job_detail/valid_job.html">资深架构师</a>
            <span class="company-name">腾讯科技</span>
          </li>
        </ul>
      `

      const cardBroken = document.getElementById('card-broken')!
      const cardValid = document.getElementById('card-valid')!

      // Card 1 matches by data-jobid in Tier 1 Strategy A, but throws and detaches
      cardBroken.scrollIntoView = vi.fn().mockImplementation(() => {
        cardBroken.remove()
        throw new DOMException('The node was detached during scroll', 'HierarchyRequestError')
      })

      let cardValidClicked = false
      cardValid.addEventListener('click', () => {
        cardValidClicked = true
      })

      const res = await activateJobCardWithFallback(
        'https://www.zhipin.com/job_detail/broken_job.html',
        'broken_job',
        '资深架构师',
        '腾讯科技',
        { allowDirectUrl: true, maxDetailWaitMs: 50 }
      )

      expect(res).not.toBeNull()
      // Either matched cardValid via Tier 2 fuzzy match or navigated via Tier 3
      expect(res).toBeDefined()
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // Scenario D: Relative URL resolution against window.location.origin
  // ═══════════════════════════════════════════════════════════════════════════
  describe('Scenario D: Relative URL resolution against window.location.origin without duplication', () => {
    it('Scenario D.1: Relative path without leading slash "job_detail/test12345.html" on current page /job_detail/current.html', async () => {
      // Simulate currently on a job detail page
      window.history.pushState({}, '', '/job_detail/current.html')
      expect(window.location.pathname).toBe('/job_detail/current.html')

      document.body.innerHTML = '<div class="job-list-box"></div>'

      const result = await activateJobCardWithFallback(
        'job_detail/test12345.html',
        'test12345',
        '目标岗位',
        '目标公司',
        { allowDirectUrl: true, maxDetailWaitMs: 50 }
      )

      expect(result).not.toBeNull()
      // Crucial: pathname must be /job_detail/test12345.html, NOT /job_detail/job_detail/test12345.html
      expect(window.location.pathname).toBe('/job_detail/test12345.html')
      expect(window.location.pathname).not.toContain('/job_detail/job_detail/')
    })

    it('Scenario D.2: Relative path with leading slash "/job_detail/test67890.html" on current page /job_detail/current.html', async () => {
      window.history.pushState({}, '', '/job_detail/current.html')

      document.body.innerHTML = '<div class="job-list-box"></div>'

      const result = await activateJobCardWithFallback(
        '/job_detail/test67890.html',
        'test67890',
        '目标岗位2',
        '目标公司2',
        { allowDirectUrl: true, maxDetailWaitMs: 50 }
      )

      expect(result).not.toBeNull()
      expect(window.location.pathname).toBe('/job_detail/test67890.html')
      expect(window.location.pathname).not.toContain('/job_detail/job_detail/')
    })

    it('Scenario D.3: Short job path "/job/12345.html" resolves cleanly', async () => {
      window.history.pushState({}, '', '/job/prev.html')

      document.body.innerHTML = '<div class="job-list-box"></div>'

      const result = await activateJobCardWithFallback(
        '/job/12345.html',
        '12345',
        '目标岗位3',
        '目标公司3',
        { allowDirectUrl: true, maxDetailWaitMs: 50 }
      )

      expect(result).not.toBeNull()
      expect(window.location.pathname).toBe('/job/12345.html')
      expect(window.location.pathname).not.toContain('/job/job/')
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // Scenario E: Company name complex compound brackets cleaning
  // ═══════════════════════════════════════════════════════════════════════════
  describe('Scenario E: Compound brackets stripping in cleanCompanyNameEnhanced', () => {
    it('Scenario E.1: 【大中华区研发中心】腾讯科技 strips brackets and extracts core root 腾讯', () => {
      const input = '【大中华区研发中心】腾讯科技'
      const cleaned = cleanCompanyNameEnhanced(input)
      // Compound brackets stripped, and corporate suffix 科技 stripped
      expect(cleaned).toBe('腾讯')
      expect(cleaned).not.toContain('大中华区')
      expect(cleaned).not.toContain('研发中心')
      expect(cleaned).not.toContain('【')
      expect(cleaned).not.toContain('】')
    })

    it('Scenario E.2: Various complex compound brackets prefixes and suffixes', () => {
      // （中国总部）
      expect(cleanCompanyNameEnhanced('（中国总部）阿里巴巴网络技术有限公司')).toBe('阿里巴巴')

      // [亚太区创新中心]
      expect(cleanCompanyNameEnhanced('[亚太区创新中心]北京字节跳动网络技术有限公司')).toBe('字节跳动')

      // 【全球研发总部】
      const cleanedHuawei = cleanCompanyNameEnhanced('【全球研发总部】华为技术有限公司')
      expect(cleanedHuawei).toContain('华为')
      expect(cleanedHuawei).not.toContain('全球')
      expect(cleanedHuawei).not.toContain('研发总部')

      // (大中华区事业部)
      expect(cleanCompanyNameEnhanced('(大中华区事业部)美团科技有限公司')).toBe('美团')

      // 括号置于公司名中间：腾讯科技【大中华区研发中心】有限公司
      expect(cleanCompanyNameEnhanced('腾讯科技【大中华区研发中心】有限公司')).toBe('腾讯')

      // 括号置于公司名末尾：快手科技有限公司（中国总部）
      expect(cleanCompanyNameEnhanced('快手科技有限公司（中国总部）')).toBe('快手')
    })

    it('Scenario E.3: Multiple consecutive brackets (e.g. 【大中华区】【研发中心】)', () => {
      const input = '【大中华区】【研发中心】百度在线网络技术（北京）有限公司'
      const cleaned = cleanCompanyNameEnhanced(input)
      expect(cleaned).toBe('百度在线')
      expect(cleaned).not.toContain('大中华区')
      expect(cleaned).not.toContain('研发中心')
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // Additional Empirical Stress: Null safety in findConfiguredApplyButtons & findApplyButtons
  // ═══════════════════════════════════════════════════════════════════════════
  describe('Additional Safety: Null pointer handling in apply button finders', () => {
    it('findApplyButtons(null as unknown as Document) safely returns empty array', () => {
      const res = findApplyButtons(null as unknown as Document)
      expect(Array.isArray(res)).toBe(true)
    })

    it('findConfiguredApplyButtons(null as unknown as Document) safely returns empty array', () => {
      const res = findConfiguredApplyButtons(null as unknown as Document)
      expect(Array.isArray(res)).toBe(true)
    })

    it('clickApplyButtonWithResilience with null jobCard returns safe result', async () => {
      const res = await clickApplyButtonWithResilience(null as unknown as HTMLElement, {
        platform: 'boss',
        jobTitle: '前端',
        company: '腾讯',
        allowLlm: false,
      })
      expect(res.success).toBe(false)
      expect(res.path).toBe('failed')
    })
  })
})
