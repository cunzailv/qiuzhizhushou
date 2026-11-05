// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { db } from '../src/shared/db/index'
import { clearErrors, listErrors, recordError } from '../src/shared/db/error-store'
import {
  setSkillMemoryTransportForTesting,
  findBestSkill,
  upsertSkill,
  recordSkillFail,
} from '../src/shared/agent/skill-memory'
import {
  cleanCompanyNameEnhanced,
  extractTitleTokens,
  fuzzyMultiWordMatch,
  activateJobCardWithFallback,
  clickApplyButtonWithResilience,
  dismissUnexpectedModals,
  isNegativeButton,
  isPositiveApplyButton,
  extractCandidateButtons,
} from '../src/shared/platform/boss/action-simulator'
import * as apiClient from '../src/shared/ai/api-client'

function mockVisibleElement<T extends HTMLElement>(el: T, width = 120, height = 40): T {
  Object.defineProperty(el, 'offsetWidth', { value: width, configurable: true })
  Object.defineProperty(el, 'offsetHeight', { value: height, configurable: true })
  return el
}

describe('Milestone M2 对抗性压力测试套件 (Milestone M2 Adversarial Stress Suite)', () => {
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
  // Area 1: Target Job Card Fallback Stress
  // ═══════════════════════════════════════════════════════════════════════════
  describe('Area 1: 目标卡片多阶降级对抗性测试 (Target Job Card Fallback Stress)', () => {
    describe('1.1 极度复杂行政与地理名称清洗 (Extreme Geographic & Administrative Names)', () => {
      it('1.1.1 极端嵌套自治区/自治州/自治县行政后缀清洗', () => {
        // 新疆维吾尔自治区伊犁哈萨克自治州伊宁市
        const name1 = '新疆维吾尔自治区伊犁哈萨克自治州伊宁市天山雪莲信息科技有限公司'
        const cleaned1 = cleanCompanyNameEnhanced(name1)
        expect(cleaned1).toContain('天山雪莲')
        expect(cleaned1).not.toContain('新疆')
        expect(cleaned1).not.toContain('信息科技有限公司')

        // 内蒙古自治区呼伦贝尔市海拉尔区
        const name2 = '内蒙古自治区呼伦贝尔市海拉尔区草原信息技术服务有限公司'
        const cleaned2 = cleanCompanyNameEnhanced(name2)
        expect(cleaned2).toContain('草原')
        expect(cleaned2).not.toContain('内蒙古')
        expect(cleaned2).not.toContain('信息技术服务有限公司')

        // 四川省凉山彝族自治州西昌市
        const name3 = '四川省凉山彝族自治州西昌市航天星图软件技术有限公司'
        const cleaned3 = cleanCompanyNameEnhanced(name3)
        expect(cleaned3).toContain('航天星图')
        expect(cleaned3).not.toContain('四川')

        // 广西壮族自治区崇左市大新县
        const name4 = '广西壮族自治区崇左市大新县雷平镇锰业矿业实业集团有限公司'
        const cleaned4 = cleanCompanyNameEnhanced(name4)
        expect(cleaned4).toContain('锰业矿业')
        expect(cleaned4).not.toContain('广西')
      })

      it('1.1.2 特别行政区、跨国机构与括号前缀清洗规则边界', () => {
        // 单项括号标签如（中国）或（总部）可被完全清除
        const name1 = '（中国）北京字节跳动网络技术服务有限公司'
        const cleaned1 = cleanCompanyNameEnhanced(name1)
        expect(cleaned1).toBe('字节跳动')

        const name2 = '阿里巴巴（中国）网络技术有限公司'
        const cleaned2 = cleanCompanyNameEnhanced(name2)
        expect(cleaned2).toBe('阿里巴巴')

        // 包含地名括号如（深圳）
        const name3 = '腾讯科技（深圳）有限公司'
        const cleaned3 = cleanCompanyNameEnhanced(name3)
        expect(cleaned3).toBe('腾讯')
      })

      it('1.1.3 极短或纯外企名称防过度清洗兜底（自动转小写并去除空格）', () => {
        expect(cleanCompanyNameEnhanced('Google')).toBe('google')
        expect(cleanCompanyNameEnhanced('Apple Inc.')).toBe('appleinc.')
        expect(cleanCompanyNameEnhanced('IBM')).toBe('ibm')
        expect(cleanCompanyNameEnhanced('OpenAI')).toBe('openai')
        expect(cleanCompanyNameEnhanced('网易')).toBe('网易')
        expect(cleanCompanyNameEnhanced('腾讯')).toBe('腾讯')
      })
    })

    describe('1.2 中英文混排与多重斜杠职位分词 (Multi-Slashed English/Chinese Hybrid Titles)', () => {
      it('1.2.1 提取复杂斜杠、点号与括号混合的技术栈职位核心特征词', () => {
        const title1 = 'Staff Software Engineer / 高级前端架构师 (React / Node.js / WebGL / TS) · 独立开发'
        const tokens1 = extractTitleTokens(title1)
        expect(tokens1).toContain('react')
        expect(tokens1).toContain('node.js')
        expect(tokens1).toContain('webgl')
        expect(tokens1).toContain('前端')
        expect(tokens1).toContain('架构师')
        expect(tokens1).toContain('独立开发')

        const title2 = 'AI/LLM Infra Architect / 大模型基础设施专家 (K8s/vLLM/DeepSeek/PyTorch)'
        const tokens2 = extractTitleTokens(title2)
        expect(tokens2).toContain('ai')
        expect(tokens2).toContain('llm')
        expect(tokens2).toContain('architect')
        expect(tokens2).toContain('k8s')
        expect(tokens2).toContain('vllm')
        expect(tokens2).toContain('deepseek')
        expect(tokens2).toContain('pytorch')
        expect(tokens2).toContain('专家')

        const title3 = 'iOS / Android / Flutter 跨端移动开发专家 (Tech Lead)'
        const tokens3 = extractTitleTokens(title3)
        expect(tokens3).toContain('ios')
        expect(tokens3).toContain('android')
        expect(tokens3).toContain('flutter')
        expect(tokens3).toContain('开发')
      })

      it('1.2.2 跨公司同标题防误触惩罚机制 (Cross-Company Misapplication Penalty)', () => {
        const targetTitle = '高级全栈工程师 (Node.js / React)'
        const targetCompany = '腾讯科技（深圳）有限公司'

        // 相同标题，但属于快手科技
        const cardTextOtherCompany = '高级全栈工程师 (Node.js / React) 30-50K · 北京快手科技有限公司 · 望京'
        const resultOther = fuzzyMultiWordMatch(cardTextOtherCompany, targetTitle, targetCompany)
        // 跨公司必须被严重惩罚 (composite * 0.3)，严禁匹配
        expect(resultOther.matched).toBe(false)
        expect(resultOther.score).toBeLessThan(0.4)

        // 相同标题与同公司变体
        const cardTextMatching = '高级全栈工程师 (Node / React) 35-55K · 腾讯 · 深圳南山区科兴科学园'
        const resultMatching = fuzzyMultiWordMatch(cardTextMatching, targetTitle, targetCompany)
        expect(resultMatching.matched).toBe(true)
        expect(resultMatching.score).toBeGreaterThanOrEqual(0.55)
      })

      it('1.2.3 列表仅有跨公司同名岗位卡片时，Tier 1 严禁误点并正确穿透至 Tier 3', async () => {
        document.body.innerHTML = `
          <ul class="job-list-box">
            <li class="job-card-box">
              <a class="job-title" href="/job_detail/kuaishou1.html">前端开发工程师</a>
              <span class="company-name">北京快手科技有限公司</span>
            </li>
          </ul>
        `
        const card = document.querySelector('li.job-card-box')!
        let cardClicked = false
        card.addEventListener('click', () => {
          cardClicked = true
        })

        const res = await activateJobCardWithFallback(
          'https://www.zhipin.com/job_detail/tencent999.html',
          'tencent999',
          '前端开发工程师',
          '腾讯科技（深圳）有限公司',
          { allowDirectUrl: true, maxDetailWaitMs: 100 }
        )

        // 验证系统严禁跨公司误点击快手卡片，而是平滑穿透降级至 Tier 3 静默直达
        expect(cardClicked).toBe(false)
        expect(res).not.toBe(card)
        expect(window.location.pathname).toContain('tencent999.html')
      })
    })

    describe('1.3 DOM 无匹配卡片边界与 Tier 3 静默直达 (Silent Direct URL Navigation Fallback)', () => {
      it('1.3.1 DOM 列表与当前视口无任何匹配时，静默回退独立 URL 直达且永不抛出异常', async () => {
        // 渲染一个完全不相关的页面列表（使用标准 anchor 标签）
        document.body.innerHTML = `
          <div class="job-list-box">
            <li class="job-card-box">
              <a class="job-name" href="/job_detail/other999.html">Java 实习生</a>
              <span class="company-name">某无关传统工厂</span>
            </li>
          </div>
        `

        const jobUrl = 'https://www.zhipin.com/job_detail/999888777.html'
        const jobId = '999888777'
        const title = 'Senior Python Architect'
        const company = 'Google China'

        const result = await activateJobCardWithFallback(jobUrl, jobId, title, company, {
          allowDirectUrl: true,
          maxDetailWaitMs: 100,
        })

        // Tier 3 会把 window.history.pushState 指向详情页并绑定详情容器（body 或 detail-container）
        expect(result).not.toBeNull()
        expect(window.location.pathname).toContain('/job_detail/999888777.html')

        // 校验审计日志中记录了 Tier 3 direct URL fallback
        const errs = await listErrors()
        const urlFallbackEvent = errs.find(
          (e) => e.source === 'self-healing.card_fallback.boss' && e.message.toLowerCase().includes('direct url fallback')
        )
        expect(urlFallbackEvent).toBeDefined()
      })

      it('1.3.3 当卡片职位名称使用 span/div 而非 a 标签时，findCardInDom 永不抛出未捕获 TypeError 且正常降级', async () => {
        // 渲染真实 DOM 结构中常见的 <span class="job-name">
        document.body.innerHTML = `
          <div class="job-list-box">
            <li class="job-card-box">
              <span class="job-name">前端架构师</span>
            </li>
          </div>
        `

        // 验证非 a 标签情况下绝不抛出未捕获 TypeError，并平稳降级至 Tier 3
        const res = await activateJobCardWithFallback(
          'https://www.zhipin.com/job_detail/abc.html',
          'abc',
          '前端架构师',
          '腾讯',
          { allowDirectUrl: true, maxDetailWaitMs: 50 }
        )
        expect(res).not.toBeNull()
        expect(window.location.pathname).toContain('abc.html')
      })

      it('1.3.2 极端畸形 URL、javascript: 伪协议与空参数边界防护', async () => {
        document.body.innerHTML = '<div class="job-list-box"></div>'

        // 畸形 URL (无法解析为有效详情路径)
        const res1 = await activateJobCardWithFallback('ht!tp://invalid:::url/', 'bad_id', '无关岗', '无关司', {
          maxDetailWaitMs: 50,
        })
        expect(res1).toBeNull()

        // 伪协议 URL
        const res2 = await activateJobCardWithFallback('javascript:alert(1)', 'bad_id', '无关岗', '无关司', {
          maxDetailWaitMs: 50,
        })
        expect(res2).toBeNull()

        // 全空输入
        const res3 = await activateJobCardWithFallback('', '', '', '', {
          maxDetailWaitMs: 50,
        })
        expect(res3).toBeNull()
      })
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // Area 2: Button Resilience Stress
  // ═══════════════════════════════════════════════════════════════════════════
  describe('Area 2: 按钮多阶降级与 LLM 安全对抗测试 (Button Resilience Stress)', () => {
    describe('2.1 LLM 未配置或不可用时，平滑降级至 Tier 4 本地启发式', () => {
      it('2.1.1 当 LLM 未配置 (apiKey 为空) 时，自动穿透 Tier 3 进入 Tier 4 并点击', async () => {
        // 清除 AI 配置
        await db.settings.delete('apiKey')
        await db.settings.delete('apiBaseUrl')
        vi.stubGlobal('chrome', {
          storage: {
            local: {
              get: vi.fn(async () => ({ apiKey: '', apiBaseUrl: '' })),
              set: vi.fn(async () => {}),
            },
          },
          runtime: {
            sendMessage: vi.fn(async () => ({ success: true })),
            lastError: null,
          },
        })

        const card = document.createElement('div')
        card.className = 'job-card-unconfigured-test'
        const btn = document.createElement('button')
        btn.className = 'custom-chat-action'
        btn.setAttribute('ka', 'job_chat_contact')
        btn.textContent = '沟通职位详情'
        mockVisibleElement(btn)
        card.appendChild(btn)
        document.body.appendChild(card)

        let clicked = false
        btn.addEventListener('click', () => {
          clicked = true
        })

        const res = await clickApplyButtonWithResilience(card, {
          platform: 'boss',
          jobTitle: '测试岗位',
          company: '测试公司',
          allowLlm: true,
        })

        expect(clicked).toBe(true)
        expect(res.success).toBe(true)
        expect(res.path).toBe('local_heuristic_revert')
      })
    })

    describe('2.2 LLM 超时与网络风暴 (Network Timeout >= 8000ms)', () => {
      it('2.2.1 LLM 响应挂起超过超时阈值时，Race 机制安全回退 Tier 4', async () => {
        const card = document.createElement('div')
        card.className = 'job-card-timeout-test'
        const btn = document.createElement('button')
        btn.className = 'btn-custom-comm'
        btn.setAttribute('ka', 'job_chat_action')
        btn.textContent = '联系HR沟通'
        mockVisibleElement(btn)
        card.appendChild(btn)
        document.body.appendChild(card)

        let clicked = false
        btn.addEventListener('click', () => {
          clicked = true
        })

        // 模拟 LLM 接口持续挂起（模拟网络超时）
        vi.spyOn(apiClient, 'chatCompletion').mockImplementation(
          () => new Promise((resolve) => setTimeout(() => resolve('{"index": 0}'), 20000))
        )

        // 指定极短超时 60ms 触发 timeout race
        const res = await clickApplyButtonWithResilience(card, {
          platform: 'boss',
          jobTitle: 'Node.js 后端开发',
          company: '未来科技',
          allowLlm: true,
          llmTimeoutMs: 60,
        })

        expect(clicked).toBe(true)
        expect(res.success).toBe(true)
        expect(res.path).toBe('local_heuristic_revert')
      })
    })

    describe('2.3 LLM 幻觉对抗守卫 (Anti-Hallucination Guard against Negative Buttons)', () => {
      it('2.3.1 当 LLM 产生幻觉并错误指示负向操作（不感兴趣/屏蔽）时，守卫坚决拦截并回退 Tier 4', async () => {
        const card = document.createElement('div')
        card.className = 'job-card-hallucination-test'

        const dislikeBtn = document.createElement('button')
        dislikeBtn.className = 'action-btn dislike-btn'
        dislikeBtn.setAttribute('ka', 'dislike_job')
        dislikeBtn.textContent = '不感兴趣'
        mockVisibleElement(dislikeBtn)

        const reportBtn = document.createElement('button')
        reportBtn.className = 'action-btn report-btn'
        reportBtn.setAttribute('ka', 'report_job')
        reportBtn.textContent = '举报职位'
        mockVisibleElement(reportBtn)

        const positiveBtn = document.createElement('button')
        positiveBtn.className = 'action-btn positive-btn'
        positiveBtn.setAttribute('ka', 'contact_hr')
        positiveBtn.textContent = '对话联系HR'
        mockVisibleElement(positiveBtn)

        card.appendChild(dislikeBtn)
        card.appendChild(reportBtn)
        card.appendChild(positiveBtn)
        document.body.appendChild(card)

        let dislikeClicked = false
        let positiveClicked = false
        dislikeBtn.addEventListener('click', () => {
          dislikeClicked = true
        })
        positiveBtn.addEventListener('click', () => {
          positiveClicked = true
        })

        // LLM 返回幻觉：指示点击 index 0（即使 candidates 过滤了负向，若 LLM 强行返回或者指定 negative）
        vi.spyOn(apiClient, 'chatCompletion').mockResolvedValue(
          '```json\n{"index": 0, "reason": "Hallucinated recommendation"}\n```'
        )

        const res = await clickApplyButtonWithResilience(card, {
          platform: 'boss',
          jobTitle: '前端专家',
          company: '某互联网公司',
          allowLlm: true,
          llmTimeoutMs: 500,
        })

        // 防幻觉守卫与候选过滤必须严格阻止点击负向按钮
        expect(dislikeClicked).toBe(false)
        // 且安全降级到正向沟通按钮
        expect(positiveClicked).toBe(true)
        expect(res.success).toBe(true)
      })

      it('2.3.2 当 LLM 返回越界索引 (如 index: 999) 或损坏的非 JSON 内容时，平稳降级', async () => {
        const card = document.createElement('div')
        card.className = 'job-card-corrupt-json'
        const btn = document.createElement('button')
        btn.className = 'action-btn'
        btn.setAttribute('ka', 'job_contact')
        btn.textContent = '联系对方沟通'
        mockVisibleElement(btn)
        card.appendChild(btn)
        document.body.appendChild(card)

        let clicked = false
        btn.addEventListener('click', () => {
          clicked = true
        })

        vi.spyOn(apiClient, 'chatCompletion').mockResolvedValue('I am an AI and I cannot output JSON.')

        const res = await clickApplyButtonWithResilience(card, {
          platform: 'boss',
          jobTitle: '测试',
          company: '测试',
          allowLlm: true,
          llmTimeoutMs: 500,
        })

        expect(clicked).toBe(true)
        expect(res.success).toBe(true)
        expect(res.path).toBe('local_heuristic_revert')
      })
    })

    describe('2.4 全选择器与全候选均失败时的安全终止 (Clean Terminal Failure)', () => {
      it('2.4.1 当卡片内只有纯负向按钮 (无任何正向或可沟通按钮) 时，返回 failed 且不抛出未捕获异常', async () => {
        const card = document.createElement('div')
        card.className = 'job-card-only-negative'
        const b1 = mockVisibleElement(document.createElement('button'))
        b1.className = 'btn-cancel'
        b1.textContent = '不合适'

        const b2 = mockVisibleElement(document.createElement('button'))
        b2.className = 'btn-shield'
        b2.setAttribute('ka', 'shield')
        b2.textContent = '屏蔽公司'

        const b3 = mockVisibleElement(document.createElement('button'))
        b3.className = 'btn-report'
        b3.setAttribute('ka', 'report')
        b3.textContent = '举报违规'

        card.appendChild(b1)
        card.appendChild(b2)
        card.appendChild(b3)
        document.body.appendChild(card)

        const res = await clickApplyButtonWithResilience(card, {
          platform: 'boss',
          jobTitle: '测试',
          company: '测试',
          allowLlm: false,
        })

        expect(res.success).toBe(false)
        expect(res.path).toBe('failed')
      })

      it('2.4.2 当 DOM 完全无任何按钮元素时，返回 failed 且不抛出未捕获异常', async () => {
        const emptyCard = document.createElement('div')
        emptyCard.className = 'empty-card'

        const res = await clickApplyButtonWithResilience(emptyCard, {
          platform: 'boss',
          jobTitle: '空岗位',
          company: '空公司',
          allowLlm: false,
        })

        expect(res.success).toBe(false)
        expect(res.path).toBe('failed')
      })
    })

    describe('2.5 动态技能热修复持久化与复用 (Skill Memory Hot-Patching Persistence)', () => {
      it('2.5.1 Tier 2 探测成功后写入 IndexedDB，下一次点击 0ms 优先复用 Tier 0', async () => {
        const card1 = document.createElement('div')
        card1.className = 'job-detail-box'
        const btn1 = document.createElement('button')
        btn1.className = 'special-vendor-chat-button'
        btn1.setAttribute('data-custom-id', 'vendor-btn')
        btn1.textContent = '打招呼'
        mockVisibleElement(btn1)
        card1.appendChild(btn1)
        document.body.appendChild(card1)

        let clickCount1 = 0
        btn1.addEventListener('click', () => {
          clickCount1++
        })

        // 第一次调用：Tier 1 失败，Tier 2 语义白名单匹配“打招呼”，并将指纹热修复写入 IndexedDB
        const res1 = await clickApplyButtonWithResilience(card1, {
          platform: 'boss',
          jobTitle: '资深测试工程师',
          company: '某知名科技',
          allowLlm: false,
        })

        expect(res1.success).toBe(true)
        expect(res1.path).toBe('semantic_heuristic')
        expect(clickCount1).toBe(1)

        // 验证 IndexedDB agentSkills 中已持久化沉淀记录
        const skillsInDb = await db.agentSkills.toArray()
        expect(skillsInDb.length).toBeGreaterThanOrEqual(1)
        const savedSkill = skillsInDb.find(
          (s) => s.platform === 'boss' && s.goal === 'click_apply'
        )
        expect(savedSkill).toBeDefined()
        expect(savedSkill?.patchSource).toBe('heuristic')

        // 渲染第二个新卡片（同样的 DOM 结构）
        document.body.innerHTML = ''
        const card2 = document.createElement('div')
        card2.className = 'job-detail-box'
        const btn2 = document.createElement('button')
        btn2.className = 'special-vendor-chat-button'
        btn2.setAttribute('data-custom-id', 'vendor-btn')
        btn2.textContent = '打招呼'
        mockVisibleElement(btn2)
        card2.appendChild(btn2)
        document.body.appendChild(card2)

        let clickCount2 = 0
        btn2.addEventListener('click', () => {
          clickCount2++
        })

        // 第二次调用：应直接命中 Tier 0 (Skill Memory Cache)
        const res2 = await clickApplyButtonWithResilience(card2, {
          platform: 'boss',
          jobTitle: '资深测试工程师',
          company: '某知名科技',
          allowLlm: false,
        })

        expect(res2.success).toBe(true)
        expect(res2.path).toBe('skill_memory')
        expect(res2.usedSkill).toBeDefined()
        expect(clickCount2).toBe(1)
      })

      it('2.5.2 技能沉淀后若 DOM 元素失效，连续 3 次失败自动熔断穿透至后续 Tier', async () => {
        // 先手动塞入一个已失效的选择器技能
        const staleSelector = '.stale-dead-selector-never-exists'
        const skill = await upsertSkill({
          platform: 'boss',
          pageType: 'job_detail',
          goal: 'click_apply',
          steps: [
            {
              thinking: 'Stale skill test',
              action: { type: 'click', target: { kind: 'css_selector', value: staleSelector } },
            },
          ],
          selectorSignature: staleSelector,
          patchSource: 'heuristic',
        })
        await db.agentSkills.update(skill.id!, { failCount: 2 })

        const card = document.createElement('div')
        card.className = 'job-card'
        const btn = document.createElement('button')
        btn.className = 'btn-startchat'
        btn.textContent = '立即沟通'
        mockVisibleElement(btn)
        card.appendChild(btn)
        document.body.appendChild(card)

        let clicked = false
        btn.addEventListener('click', () => {
          clicked = true
        })

        // 执行点击：由于 selector 不存在，recordSkillFail 将 failCount 增至 3，并平滑降级至 Tier 1
        const res1 = await clickApplyButtonWithResilience(card, {
          platform: 'boss',
          jobTitle: '测试',
          company: '测试',
        })

        expect(clicked).toBe(true)
        expect(res1.path).toBe('standard_heuristic')

        // 验证 failCount 已达到 3
        const updatedSkill = await db.agentSkills.get(skill.id!)
        expect(updatedSkill?.failCount).toBeGreaterThanOrEqual(3)

        // 下一次调用由于熔断 (failCount >= 3)，findBestSkill 直接忽略该技能
        const cached = await findBestSkill('boss', 'job_detail', 'click_apply')
        expect(cached).toBeNull()
      })
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // Area 3: Unexpected Modals Deblocking Stress
  // ═══════════════════════════════════════════════════════════════════════════
  describe('Area 3: 页面阻塞脱困与高危保护对话框安全对抗 (Modal Deblocking Stress)', () => {
    describe('3.1 极深嵌套遮罩、固定高 z-index 与多类名滚动锁死解除', () => {
      it('3.1.1 强力解除复合遮罩与 z-index >= 1000 的全屏阻塞浮层', () => {
        // 创建嵌套的各平台/UI库常见遮罩
        const mask1 = mockVisibleElement(document.createElement('div'), 1024, 768)
        mask1.className = 'dialog-mask'

        const mask2 = mockVisibleElement(document.createElement('div'), 1024, 768)
        mask2.className = 'ant-modal-mask'

        const mask3 = mockVisibleElement(document.createElement('div'), 1024, 768)
        mask3.className = 'el-overlay'

        // 全屏固定定位高 z-index 浮层
        const fixedOverlay = mockVisibleElement(document.createElement('div'), 1024, 768)
        fixedOverlay.style.position = 'fixed'
        fixedOverlay.style.zIndex = '9999'
        fixedOverlay.style.top = '0'
        fixedOverlay.style.left = '0'

        document.body.appendChild(mask1)
        document.body.appendChild(mask2)
        document.body.appendChild(mask3)
        document.body.appendChild(fixedOverlay)

        // 施加各种主流 CSS 锁死
        document.body.classList.add('modal-open', 'dialog-open', 'has-modal', 'popup-show', 'overflow-hidden')
        document.body.style.overflow = 'hidden'
        document.body.style.position = 'fixed'
        document.body.style.pointerEvents = 'none'

        document.documentElement.style.overflow = 'hidden'
        document.documentElement.style.pointerEvents = 'none'

        const dismissed = dismissUnexpectedModals(document)
        expect(dismissed).toBe(true)

        // 验证所有遮罩被强制 display = none
        expect(mask1.style.display).toBe('none')
        expect(mask2.style.display).toBe('none')
        expect(mask3.style.display).toBe('none')
        expect(fixedOverlay.style.display).toBe('none')

        // 验证 body 锁死类名被彻底剥离
        expect(document.body.classList.contains('modal-open')).toBe(false)
        expect(document.body.classList.contains('dialog-open')).toBe(false)
        expect(document.body.classList.contains('has-modal')).toBe(false)
        expect(document.body.classList.contains('popup-show')).toBe(false)
        expect(document.body.classList.contains('overflow-hidden')).toBe(false)

        // 验证 body 与 html 视口样式彻底复原
        expect(document.body.style.overflow).toBe('')
        expect(document.body.style.position).toBe('')
        expect(document.body.style.pointerEvents).toBe('')
        expect(document.documentElement.style.overflow).toBe('')
        expect(document.documentElement.style.pointerEvents).toBe('')

        // 幂等性检验：再次调用不应报错且无遮罩需要清理返回 false
        expect(dismissUnexpectedModals(document)).toBe(false)
      })
    })

    describe('3.2 高危受保护对话框严禁误杀检验 (Protected Dialogs Must NEVER be Dismissed)', () => {
      it('3.2.1 正在输入/编辑的打招呼对话框 (Active Chat Greeting Dialog) 绝对不予关闭', () => {
        const chatDialog = mockVisibleElement(document.createElement('div'), 400, 300)
        chatDialog.className = 'chat-dialog'
        chatDialog.setAttribute('role', 'dialog')
        chatDialog.innerHTML = `
          <div class="chat-header">打招呼沟通</div>
          <div class="chat-body">
            <textarea class="chat-input" placeholder="请输入打招呼内容...">您好，我对该岗位很感兴趣！</textarea>
          </div>
          <div class="chat-footer">
            <button class="btn-send">发送</button>
          </div>
        `
        document.body.appendChild(chatDialog)

        // 伴随的遮罩
        const mask = mockVisibleElement(document.createElement('div'), 1024, 768)
        mask.className = 'dialog-mask'
        document.body.appendChild(mask)

        const dismissed = dismissUnexpectedModals(document)

        // 打招呼对话框不能被误关
        expect(chatDialog.style.display).not.toBe('none')
        expect(chatDialog.isConnected).toBe(true)
        // 伴随的遮罩也必须保留，避免破坏正在进行的正向交互
        expect(mask.style.display).not.toBe('none')
        expect(dismissed).toBe(false)
      })

      it('3.2.2 极验/滑动拼图验证码 (Geetest / Slider Captcha) 绝对不予关闭', () => {
        const captchaModal = mockVisibleElement(document.createElement('div'), 300, 250)
        captchaModal.className = 'geetest_holder geetest_wind'
        captchaModal.setAttribute('role', 'dialog')
        captchaModal.innerHTML = `
          <div class="geetest_wrap">
            <div class="geetest_radar_tip">请完成安全验证</div>
            <div class="geetest_slider">拖动滑块完成拼图</div>
          </div>
        `
        document.body.appendChild(captchaModal)

        const dismissed = dismissUnexpectedModals(document)

        // 验证码绝对不可被关闭或隐藏，否则将导致风控卡死
        expect(captchaModal.style.display).not.toBe('none')
        expect(captchaModal.isConnected).toBe(true)
        expect(dismissed).toBe(false)
      })

      it('3.2.3 今日沟通次数已达上限等风控提示框保留', () => {
        const limitDialog = mockVisibleElement(document.createElement('div'), 300, 200)
        limitDialog.className = 'dialog-container'
        limitDialog.innerHTML = `
          <div class="title">今日沟通次数已达上限</div>
          <p>您今日发起的沟通已达上限，请明天再试。</p>
          <button class="btn-sure">我知道了</button>
        `
        document.body.appendChild(limitDialog)

        const dismissed = dismissUnexpectedModals(document)
        expect(limitDialog.style.display).not.toBe('none')
        expect(dismissed).toBe(false)
      })
    })
  })
})
