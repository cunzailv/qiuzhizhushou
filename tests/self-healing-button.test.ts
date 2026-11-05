// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { db } from '../src/shared/db/index'
import { clearErrors, listErrors } from '../src/shared/db/error-store'
import {
  upsertSkill,
  findBestSkill,
  setSkillMemoryTransportForTesting,
  recordSkillFail,
  SKILL_TTL_MS,
} from '../src/shared/agent/skill-memory'
import {
  clickApplyButtonWithResilience,
  extractCandidateButtons,
  findWhitelistCandidate,
  selectButtonViaLlm,
  rankCandidatesLocally,
} from '../src/shared/platform/boss/action-simulator'
import * as apiClient from '../src/shared/ai/api-client'

describe('自愈韧性智能体架构 · 按钮点击多阶降级与 LLM 安全兜底 (Feature 3, 4, 5, 7)', () => {
  beforeEach(async () => {
    setSkillMemoryTransportForTesting('direct')
    await db.open()
    await db.agentSkills.clear()
    await clearErrors()
    await db.settings.put({ key: 'apiKey', value: 'mock-key' })
    await db.settings.put({ key: 'apiBaseUrl', value: 'https://mock.ai/v1' })
    document.body.innerHTML = ''

    vi.stubGlobal('chrome', {
      storage: {
        local: {
          get: vi.fn(async () => ({ apiKey: 'mock-key', apiBaseUrl: 'https://mock.ai/v1' })),
          set: vi.fn(async () => {}),
        },
      },
      runtime: {
        sendMessage: vi.fn(async () => ({ success: true })),
        lastError: null,
      },
    })
  })

  afterEach(() => {
    setSkillMemoryTransportForTesting(null)
    vi.restoreAllMocks()
    vi.useRealTimers()
    document.body.innerHTML = ''
  })

  // ─── Suite 1: Tier 0 技能记忆优先复用与熔断隔离 ───
  describe('Suite 1: Tier 0 技能记忆优先复用与熔断隔离', () => {
    it('1.1 命中有效沉淀技能时，0ms 优先复用 selector 并返回 skill_memory', async () => {
      const card = document.createElement('div')
      card.className = 'custom-job-card'
      const btn = document.createElement('button')
      btn.className = 'custom-apply-action-btn'
      btn.textContent = '立即开聊'
      Object.defineProperty(btn, 'offsetWidth', { value: 100, configurable: true })
      Object.defineProperty(btn, 'offsetHeight', { value: 36, configurable: true })
      card.appendChild(btn)
      document.body.appendChild(card)

      let clicked = false
      btn.onclick = () => { clicked = true }

      // 提前注入沉淀技能
      await upsertSkill({
        platform: 'boss',
        pageType: 'job_detail',
        goal: 'click_apply',
        steps: [
          {
            thinking: 'Reusing learned selector',
            action: { type: 'click', target: { kind: 'css_selector', value: '.custom-apply-action-btn' } },
          },
        ],
        selectorSignature: '.custom-apply-action-btn',
        patchSource: 'heuristic',
      })

      const res = await clickApplyButtonWithResilience(card, {
        platform: 'boss',
        jobTitle: '前端开发',
        company: '方圆宝',
        allowLlm: false,
      })

      expect(res.success).toBe(true)
      expect(res.path).toBe('skill_memory')
      expect(res.usedSkill).toBeDefined()
      expect(clicked).toBe(true)
    })

    it('1.2 缓存的选择器在 DOM 中不存在时，自动调用 recordSkillFail 增加 failCount 并平滑降级至 Tier 1', async () => {
      const card = document.createElement('div')
      const validTier1Btn = document.createElement('button')
      validTier1Btn.className = 'btn-startchat'
      validTier1Btn.textContent = '立即沟通'
      Object.defineProperty(validTier1Btn, 'offsetWidth', { value: 120, configurable: true })
      Object.defineProperty(validTier1Btn, 'offsetHeight', { value: 40, configurable: true })
      card.appendChild(validTier1Btn)
      document.body.appendChild(card)

      let tier1Clicked = false
      validTier1Btn.onclick = () => { tier1Clicked = true }

      // 注入已失效的选择器
      const staleSkill = await upsertSkill({
        platform: 'boss',
        pageType: 'job_detail',
        goal: 'click_apply',
        steps: [
          {
            thinking: 'Outdated selector',
            action: { type: 'click', target: { kind: 'css_selector', value: '.non-existent-button' } },
          },
        ],
        selectorSignature: '.non-existent-button',
        patchSource: 'heuristic',
      })

      const res = await clickApplyButtonWithResilience(card, {
        platform: 'boss',
        jobTitle: '后端工程师',
        company: '方圆宝',
        allowLlm: false,
      })

      expect(res.success).toBe(true)
      expect(res.path).toBe('standard_heuristic')
      expect(tier1Clicked).toBe(true)

      const updated = await db.agentSkills.get(staleSkill.id)
      expect(updated?.failCount).toBe(1)
    })

    it('1.3 failCount >= 3 触发熔断保护，自动穿透技能缓存进入 Tier 1', async () => {
      const card = document.createElement('div')
      const btn = document.createElement('button')
      btn.className = 'btn-startchat'
      btn.textContent = '立即沟通'
      Object.defineProperty(btn, 'offsetWidth', { value: 120, configurable: true })
      Object.defineProperty(btn, 'offsetHeight', { value: 40, configurable: true })
      card.appendChild(btn)
      document.body.appendChild(card)

      const brokenSkill = await upsertSkill({
        platform: 'boss',
        pageType: 'job_detail',
        goal: 'click_apply',
        steps: [
          { thinking: 'test', action: { type: 'click', target: { kind: 'css_selector', value: '.broken' } } },
        ],
        selectorSignature: '.broken',
      })

      // 连续失败 3 次
      await recordSkillFail(brokenSkill)
      await recordSkillFail(brokenSkill)
      await recordSkillFail(brokenSkill)

      const res = await clickApplyButtonWithResilience(card, {
        platform: 'boss',
        jobTitle: '测试开发',
        company: '方圆宝',
      })

      expect(res.success).toBe(true)
      expect(res.path).toBe('standard_heuristic')
    })

    it('1.4 技能处于 enabled === false 停用状态时，findBestSkill 不命中并进入降级', async () => {
      const card = document.createElement('div')
      const btn = document.createElement('button')
      btn.className = 'btn-startchat'
      btn.textContent = '立即沟通'
      Object.defineProperty(btn, 'offsetWidth', { value: 120, configurable: true })
      Object.defineProperty(btn, 'offsetHeight', { value: 40, configurable: true })
      card.appendChild(btn)
      document.body.appendChild(card)

      await upsertSkill({
        platform: 'boss',
        pageType: 'job_detail',
        goal: 'click_apply',
        steps: [
          { thinking: 'disabled', action: { type: 'click', target: { kind: 'css_selector', value: '.disabled-selector' } } },
        ],
        selectorSignature: '.disabled-selector',
      })
      const stored = await findBestSkill('boss', 'job_detail', 'click_apply')
      if (stored) {
        await db.agentSkills.update(stored.id, { enabled: false })
      }

      const res = await clickApplyButtonWithResilience(card, {
        platform: 'boss',
        jobTitle: '架构师',
        company: '方圆宝',
      })

      expect(res.success).toBe(true)
      expect(res.path).toBe('standard_heuristic')
    })

    it('1.5 技能过期 (expiresAt < now) 时自动穿透', async () => {
      const card = document.createElement('div')
      const btn = document.createElement('button')
      btn.className = 'btn-startchat'
      btn.textContent = '立即沟通'
      Object.defineProperty(btn, 'offsetWidth', { value: 120, configurable: true })
      Object.defineProperty(btn, 'offsetHeight', { value: 40, configurable: true })
      card.appendChild(btn)
      document.body.appendChild(card)

      const skill = await upsertSkill({
        platform: 'boss',
        pageType: 'job_detail',
        goal: 'click_apply',
        steps: [
          { thinking: 'expired', action: { type: 'click', target: { kind: 'css_selector', value: '.expired-btn' } } },
        ],
        selectorSignature: '.expired-btn',
      })
      await db.agentSkills.update(skill.id, { expiresAt: Date.now() - 1000 })

      const res = await clickApplyButtonWithResilience(card, {
        platform: 'boss',
        jobTitle: '算法工程师',
        company: '方圆宝',
      })

      expect(res.success).toBe(true)
      expect(res.path).toBe('standard_heuristic')
    })

    it('1.6 缓存选择器对应元素处于不可见状态 (0x0) 时，自动标记失败并降级', async () => {
      const card = document.createElement('div')
      const hiddenTarget = document.createElement('button')
      hiddenTarget.className = 'ghost-btn'
      hiddenTarget.textContent = '立即沟通'
      Object.defineProperty(hiddenTarget, 'offsetWidth', { value: 0, configurable: true })
      Object.defineProperty(hiddenTarget, 'offsetHeight', { value: 0, configurable: true })
      card.appendChild(hiddenTarget)

      const visibleTier1 = document.createElement('button')
      visibleTier1.className = 'btn-startchat'
      visibleTier1.textContent = '立即沟通'
      Object.defineProperty(visibleTier1, 'offsetWidth', { value: 100, configurable: true })
      Object.defineProperty(visibleTier1, 'offsetHeight', { value: 40, configurable: true })
      card.appendChild(visibleTier1)
      document.body.appendChild(card)

      const ghostSkill = await upsertSkill({
        platform: 'boss',
        pageType: 'job_detail',
        goal: 'click_apply',
        steps: [
          { thinking: 'ghost', action: { type: 'click', target: { kind: 'css_selector', value: '.ghost-btn' } } },
        ],
        selectorSignature: '.ghost-btn',
      })

      const res = await clickApplyButtonWithResilience(card, {
        platform: 'boss',
        jobTitle: '运维总监',
        company: '方圆宝',
      })

      expect(res.success).toBe(true)
      expect(res.path).toBe('standard_heuristic')
      const updated = await db.agentSkills.get(ghostSkill.id)
      expect(updated?.failCount).toBe(1)
    })
  })

  // ─── Suite 2: Tier 1 预设类名点击 ───
  describe('Suite 2: Tier 1 预设类名点击', () => {
    it('2.1 命中标准 .btn-startchat 按钮时成功触发点击并返回 standard_heuristic', async () => {
      const card = document.createElement('div')
      const btn = document.createElement('button')
      btn.className = 'btn-startchat'
      btn.textContent = '立即沟通'
      Object.defineProperty(btn, 'offsetWidth', { value: 120, configurable: true })
      Object.defineProperty(btn, 'offsetHeight', { value: 40, configurable: true })
      card.appendChild(btn)
      document.body.appendChild(card)

      let clicked = false
      btn.onclick = () => { clicked = true }

      const res = await clickApplyButtonWithResilience(card, {
        platform: 'boss',
        jobTitle: '前端架构师',
        company: '方圆宝',
      })

      expect(res.success).toBe(true)
      expect(res.path).toBe('standard_heuristic')
      expect(clicked).toBe(true)
    })

    it('2.2 支持 ka="job_card_start_chat" 等变体选择器', async () => {
      const card = document.createElement('div')
      const a = document.createElement('a')
      a.setAttribute('ka', 'job_card_start_chat')
      a.textContent = '立即沟通'
      Object.defineProperty(a, 'offsetWidth', { value: 100, configurable: true })
      Object.defineProperty(a, 'offsetHeight', { value: 36, configurable: true })
      card.appendChild(a)
      document.body.appendChild(card)

      let clicked = false
      a.onclick = () => { clicked = true }

      const res = await clickApplyButtonWithResilience(card, {
        platform: 'boss',
        jobTitle: '全栈专家',
        company: '方圆宝',
      })

      expect(res.success).toBe(true)
      expect(res.path).toBe('standard_heuristic')
      expect(clicked).toBe(true)
    })

    it('2.3 多个按钮并存时，严格优先点击“立即沟通”主按钮', async () => {
      const card = document.createElement('div')
      const secondaryBtn = document.createElement('button')
      secondaryBtn.className = 'chat-btn'
      secondaryBtn.textContent = '发消息'
      Object.defineProperty(secondaryBtn, 'offsetWidth', { value: 80, configurable: true })
      Object.defineProperty(secondaryBtn, 'offsetHeight', { value: 30, configurable: true })

      const primaryBtn = document.createElement('button')
      primaryBtn.className = 'btn-startchat'
      primaryBtn.textContent = '立即沟通'
      Object.defineProperty(primaryBtn, 'offsetWidth', { value: 120, configurable: true })
      Object.defineProperty(primaryBtn, 'offsetHeight', { value: 40, configurable: true })

      card.appendChild(secondaryBtn)
      card.appendChild(primaryBtn)
      document.body.appendChild(card)

      let clickedPrimary = false
      primaryBtn.onclick = () => { clickedPrimary = true }

      const res = await clickApplyButtonWithResilience(card, {
        platform: 'boss',
        jobTitle: '产品经理',
        company: '方圆宝',
      })

      expect(res.success).toBe(true)
      expect(clickedPrimary).toBe(true)
    })

    it('2.4 预设类名按钮携带 disabled 属性时安全跳过', async () => {
      const card = document.createElement('div')
      const btn = document.createElement('button')
      btn.className = 'btn-startchat'
      btn.setAttribute('disabled', 'true')
      btn.textContent = '立即沟通'
      Object.defineProperty(btn, 'offsetWidth', { value: 100, configurable: true })
      Object.defineProperty(btn, 'offsetHeight', { value: 36, configurable: true })
      card.appendChild(btn)
      document.body.appendChild(card)

      const res = await clickApplyButtonWithResilience(card, {
        platform: 'boss',
        jobTitle: '项目经理',
        company: '方圆宝',
        allowLlm: false,
      })

      expect(res.success).toBe(false)
    })

    it('2.5 预设类名包含负向状态（已停止招聘）时被严格排除', async () => {
      const card = document.createElement('div')
      const btn = document.createElement('button')
      btn.className = 'btn-startchat'
      btn.textContent = '已停止招聘'
      Object.defineProperty(btn, 'offsetWidth', { value: 100, configurable: true })
      Object.defineProperty(btn, 'offsetHeight', { value: 36, configurable: true })
      card.appendChild(btn)
      document.body.appendChild(card)

      const res = await clickApplyButtonWithResilience(card, {
        platform: 'boss',
        jobTitle: '技术专家',
        company: '方圆宝',
        allowLlm: false,
      })

      expect(res.success).toBe(false)
    })
  })

  // ─── Suite 3: Tier 2 语义黑白名单启发式点击 ───
  describe('Suite 3: Tier 2 语义黑白名单启发式点击与技能沉淀', () => {
    it('3.1 预设类名失效时，通过“聊一聊”白名单文本定位并点击，返回 semantic_heuristic', async () => {
      const card = document.createElement('div')
      const btn = document.createElement('button')
      btn.className = 'unrecognized-random-class-abc'
      btn.textContent = '聊一聊'
      Object.defineProperty(btn, 'offsetWidth', { value: 90, configurable: true })
      Object.defineProperty(btn, 'offsetHeight', { value: 32, configurable: true })
      card.appendChild(btn)
      document.body.appendChild(card)

      let clicked = false
      btn.onclick = () => { clicked = true }

      const res = await clickApplyButtonWithResilience(card, {
        platform: 'boss',
        jobTitle: '前端工程师',
        company: '方圆宝',
      })

      expect(res.success).toBe(true)
      expect(res.path).toBe('semantic_heuristic')
      expect(clicked).toBe(true)
    })

    it('3.2 白名单支持“立即沟通”、“打招呼”、“聊一聊”、“投递简历”、“继续沟通”', () => {
      const primaryKeywords = ['立即沟通', '打招呼', '聊一聊', '投递简历', '继续沟通']
      for (const kw of primaryKeywords) {
        const candidates = [
          {
            index: 0,
            tag: 'button',
            text: kw,
            className: 'btn-action',
            element: document.createElement('button'),
          },
        ]
        const matched = findWhitelistCandidate(candidates)
        expect(matched).not.toBeNull()
        expect(matched?.text).toBe(kw)
      }
    })

    it('3.3 严格黑名单排除“不感兴趣”、“关闭”、“取消”、“举报”、“屏蔽”、“收藏”、“关注”', () => {
      const blacklistedTexts = ['不感兴趣', '关闭', '取消', '举报', '屏蔽', '收藏', '关注', '不想看']
      const card = document.createElement('div')
      for (const text of blacklistedTexts) {
        const btn = document.createElement('button')
        btn.textContent = text
        Object.defineProperty(btn, 'offsetWidth', { value: 80, configurable: true })
        Object.defineProperty(btn, 'offsetHeight', { value: 30, configurable: true })
        card.appendChild(btn)
      }
      document.body.appendChild(card)

      const candidates = extractCandidateButtons(card)
      expect(candidates.length).toBe(0)
    })

    it('3.4 属性级黑名单排除 ka="dislike" 与 class="btn-cancel"', () => {
      const card = document.createElement('div')
      const btn1 = document.createElement('button')
      btn1.setAttribute('ka', 'job_card_dislike')
      btn1.textContent = '聊一聊'
      Object.defineProperty(btn1, 'offsetWidth', { value: 80, configurable: true })
      Object.defineProperty(btn1, 'offsetHeight', { value: 30, configurable: true })

      const btn2 = document.createElement('button')
      btn2.className = 'btn-cancel'
      btn2.textContent = '立即沟通'
      Object.defineProperty(btn2, 'offsetWidth', { value: 80, configurable: true })
      Object.defineProperty(btn2, 'offsetHeight', { value: 30, configurable: true })

      card.appendChild(btn1)
      card.appendChild(btn2)
      document.body.appendChild(card)

      const candidates = extractCandidateButtons(card)
      expect(candidates.length).toBe(0)
    })

    it('3.5 启发式命中后，自动提取选择器指纹并沉淀到 agentSkills (patchSource: heuristic)', async () => {
      const card = document.createElement('div')
      card.className = 'job-card-wrapper'
      const btn = document.createElement('button')
      btn.className = 'btn-open-chat-now'
      btn.textContent = '立即沟通'
      Object.defineProperty(btn, 'offsetWidth', { value: 100, configurable: true })
      Object.defineProperty(btn, 'offsetHeight', { value: 35, configurable: true })
      card.appendChild(btn)
      document.body.appendChild(card)

      const res = await clickApplyButtonWithResilience(card, {
        platform: 'boss',
        jobTitle: 'iOS工程师',
        company: '方圆宝',
      })

      expect(res.success).toBe(true)
      expect(res.path).toBe('semantic_heuristic')

      const storedSkill = await findBestSkill('boss', 'job_detail', 'click_apply')
      expect(storedSkill).not.toBeNull()
      expect(storedSkill?.patchSource).toBe('heuristic')
      expect(storedSkill?.selectorSignature).toContain('btn-open-chat-now')
    })

    it('3.6 第二次执行同场景时，成功通过 Tier 0 复用刚沉淀的动态技能 (0ms 自愈)', async () => {
      const card = document.createElement('div')
      card.className = 'job-card-wrapper'
      const btn = document.createElement('button')
      btn.className = 'btn-open-chat-now'
      btn.textContent = '立即沟通'
      Object.defineProperty(btn, 'offsetWidth', { value: 100, configurable: true })
      Object.defineProperty(btn, 'offsetHeight', { value: 35, configurable: true })
      card.appendChild(btn)
      document.body.appendChild(card)

      // 第一次：Tier 2 启发式触发并沉淀技能
      const first = await clickApplyButtonWithResilience(card, {
        platform: 'boss',
        jobTitle: 'Android工程师',
        company: '方圆宝',
      })
      expect(first.path).toBe('semantic_heuristic')

      // 第二次：相同页面直接命中 Tier 0
      const second = await clickApplyButtonWithResilience(card, {
        platform: 'boss',
        jobTitle: 'Android工程师',
        company: '方圆宝',
      })
      expect(second.success).toBe(true)
      expect(second.path).toBe('skill_memory')
    })
  })

  // ─── Suite 4: Tier 3 LLM 感知与决策降级 ───
  describe('Suite 4: Tier 3 LLM 感知决策与防幻觉护栏', () => {
    it('4.1 提取候选元素列表，结构化包含 tag, text, className, role, ka', () => {
      const card = document.createElement('div')
      const btn = document.createElement('button')
      btn.className = 'btn-weird-obfuscated'
      btn.setAttribute('role', 'button')
      btn.setAttribute('ka', 'custom_ka')
      btn.setAttribute('aria-label', 'Chat with HR')
      btn.textContent = '发起对话'
      Object.defineProperty(btn, 'offsetWidth', { value: 90, configurable: true })
      Object.defineProperty(btn, 'offsetHeight', { value: 32, configurable: true })
      card.appendChild(btn)
      document.body.appendChild(card)

      const candidates = extractCandidateButtons(card)
      expect(candidates.length).toBe(1)
      expect(candidates[0].tag).toBe('button')
      expect(candidates[0].text).toBe('发起对话')
      expect(candidates[0].className).toContain('btn-weird-obfuscated')
      expect(candidates[0].role).toBe('button')
      expect(candidates[0].ka).toBe('custom_ka')
      expect(candidates[0].ariaLabel).toBe('Chat with HR')
    })

    it('4.2 启发式未命中时，调用 LLM 决策并在返回正确索引后成功点击，返回 llm_perception', async () => {
      const card = document.createElement('div')
      // 故意使用无任何启发式白名单关键词的按钮
      const weirdBtn = document.createElement('button')
      weirdBtn.className = 'btn-obfuscated-xyz'
      weirdBtn.textContent = 'Get in Touch'
      Object.defineProperty(weirdBtn, 'offsetWidth', { value: 100, configurable: true })
      Object.defineProperty(weirdBtn, 'offsetHeight', { value: 35, configurable: true })
      card.appendChild(weirdBtn)
      document.body.appendChild(card)

      let clicked = false
      weirdBtn.onclick = () => { clicked = true }

      // Mock LLM Client 返回索引 0
      vi.spyOn(apiClient, 'chatCompletion').mockResolvedValue(
        JSON.stringify({ selectedIndex: 0, confidence: 0.95, reason: 'Identified English communication CTA' })
      )

      const res = await clickApplyButtonWithResilience(card, {
        platform: 'boss',
        jobTitle: 'Foreign Sales Specialist',
        company: 'Global Corp',
        allowLlm: true,
      })

      expect(res.success).toBe(true)
      expect(res.path).toBe('llm_perception')
      expect(clicked).toBe(true)
    })

    it('4.3 LLM 识别成功后，选择器指纹持久化入库 (patchSource: llm)', async () => {
      const card = document.createElement('div')
      const strangeBtn = document.createElement('button')
      strangeBtn.className = 'btn-strange-cta'
      strangeBtn.textContent = 'Reach Out'
      Object.defineProperty(strangeBtn, 'offsetWidth', { value: 100, configurable: true })
      Object.defineProperty(strangeBtn, 'offsetHeight', { value: 35, configurable: true })
      card.appendChild(strangeBtn)
      document.body.appendChild(card)

      vi.spyOn(apiClient, 'chatCompletion').mockResolvedValue(
        JSON.stringify({ selectedIndex: 0, confidence: 0.9, reason: 'Reach Out represents apply CTA' })
      )

      const res = await clickApplyButtonWithResilience(card, {
        platform: 'boss',
        jobTitle: 'HR Director',
        company: 'Tech Corp',
        allowLlm: true,
      })

      expect(res.success).toBe(true)
      expect(res.path).toBe('llm_perception')

      const saved = await findBestSkill('boss', 'job_detail', 'click_apply')
      expect(saved).not.toBeNull()
      expect(saved?.patchSource).toBe('llm')
    })

    it('4.4 技能持久化后，后续同场景 0ms 命中 Tier 0，不再发生重复 AI 计费', async () => {
      const card = document.createElement('div')
      const btn = document.createElement('button')
      btn.className = 'btn-strange-cta'
      btn.textContent = 'Reach Out'
      Object.defineProperty(btn, 'offsetWidth', { value: 100, configurable: true })
      Object.defineProperty(btn, 'offsetHeight', { value: 35, configurable: true })
      card.appendChild(btn)
      document.body.appendChild(card)

      const llmSpy = vi.spyOn(apiClient, 'chatCompletion').mockResolvedValue(
        JSON.stringify({ selectedIndex: 0, confidence: 0.9, reason: 'Apply action' })
      )

      // 首次执行：触发 LLM 并持久化
      await clickApplyButtonWithResilience(card, {
        platform: 'boss',
        jobTitle: 'VP Engineering',
        company: 'Tech Corp',
        allowLlm: true,
      })
      expect(llmSpy).toHaveBeenCalledTimes(1)

      // 第二次执行：Tier 0 命中，不再调用 LLM
      const secondRes = await clickApplyButtonWithResilience(card, {
        platform: 'boss',
        jobTitle: 'VP Engineering',
        company: 'Tech Corp',
        allowLlm: true,
      })
      expect(secondRes.path).toBe('skill_memory')
      expect(llmSpy).toHaveBeenCalledTimes(1) // 保持 1 次未增加！
    })

    it('4.5 LLM 幻觉防御：若模型返回了黑名单关闭按钮索引，安全检查拒绝并回退 Tier 4', async () => {
      const candidates = [
        {
          index: 0,
          tag: 'button',
          text: '不感兴趣',
          className: 'btn-dislike',
          element: document.createElement('button'),
        },
      ]
      candidates[0].element.textContent = '不感兴趣'

      vi.spyOn(apiClient, 'chatCompletion').mockResolvedValue(
        JSON.stringify({ selectedIndex: 0, confidence: 0.99, reason: 'Hallucinated negative button' })
      )

      const result = await selectButtonViaLlm(candidates, {
        platform: 'boss',
        jobTitle: 'Dev',
        company: 'Co',
      })
      expect(result).toBeNull()
    })

    it('4.6 模型返回 Markdown 格式或非纯 JSON 时，正则抽取依然能安全解析', async () => {
      const btn = document.createElement('button')
      btn.textContent = '立即开聊'
      const candidates = [
        {
          index: 0,
          tag: 'button',
          text: '立即开聊',
          className: 'btn-chat',
          element: btn,
        },
      ]

      vi.spyOn(apiClient, 'chatCompletion').mockResolvedValue(
        'Here is the result:\n```json\n{"selectedIndex": 0, "confidence": 0.88, "reason": "Valid CTA"}\n```\nHope this helps!'
      )

      const result = await selectButtonViaLlm(candidates, {
        platform: 'boss',
        jobTitle: 'Dev',
        company: 'Co',
      })
      expect(result).not.toBeNull()
      expect(result?.candidate.index).toBe(0)
    })
  })

  // ─── Suite 5: Tier 4 本地启发式安全回退与不阻断保障 ───
  describe('Suite 5: Tier 4 本地启发式安全回退与任务连续性保障', () => {
    it('5.1 allowLlm === false 时，安全跳过 LLM 并无缝降级到 Tier 4', async () => {
      const card = document.createElement('div')
      const btn = document.createElement('button')
      btn.className = 'btn-contact-hr'
      btn.textContent = '联系HR'
      Object.defineProperty(btn, 'offsetWidth', { value: 100, configurable: true })
      Object.defineProperty(btn, 'offsetHeight', { value: 35, configurable: true })
      card.appendChild(btn)
      document.body.appendChild(card)

      const llmSpy = vi.spyOn(apiClient, 'chatCompletion')

      const res = await clickApplyButtonWithResilience(card, {
        platform: 'boss',
        jobTitle: '技术总监',
        company: '方圆宝',
        allowLlm: false,
      })

      expect(llmSpy).not.toHaveBeenCalled()
      expect(res.success).toBe(true)
      expect(res.path).toBe('local_heuristic_revert')
    })

    it('5.2 API Key 为空或未配置 AI 时，直接回退 Tier 4，不发起任何 fetch 网络请求', async () => {
      vi.spyOn(apiClient, 'checkAIConfigured').mockResolvedValue({ configured: false, reason: 'No API key' })
      const llmSpy = vi.spyOn(apiClient, 'chatCompletion')

      const card = document.createElement('div')
      const btn = document.createElement('button')
      btn.className = 'btn-contact-custom'
      btn.textContent = '联系HR'
      Object.defineProperty(btn, 'offsetWidth', { value: 90, configurable: true })
      Object.defineProperty(btn, 'offsetHeight', { value: 30, configurable: true })
      card.appendChild(btn)
      document.body.appendChild(card)

      const res = await clickApplyButtonWithResilience(card, {
        platform: 'boss',
        jobTitle: '算法总监',
        company: '方圆宝',
        allowLlm: true,
      })

      expect(llmSpy).not.toHaveBeenCalled()
      expect(res.success).toBe(true)
      expect(res.path).toBe('local_heuristic_revert')
    })

    it('5.3 LLM 接口返回 HTTP 429 限流或网络异常时，静默捕获并平滑降级至 Tier 4', async () => {
      vi.spyOn(apiClient, 'chatCompletion').mockRejectedValue(new Error('HTTP 429 Too Many Requests'))

      const card = document.createElement('div')
      const btn = document.createElement('button')
      btn.className = 'btn-contact-custom'
      btn.textContent = '联系HR'
      Object.defineProperty(btn, 'offsetWidth', { value: 90, configurable: true })
      Object.defineProperty(btn, 'offsetHeight', { value: 30, configurable: true })
      card.appendChild(btn)
      document.body.appendChild(card)

      const res = await clickApplyButtonWithResilience(card, {
        platform: 'boss',
        jobTitle: '产品总监',
        company: '方圆宝',
        allowLlm: true,
      })

      expect(res.success).toBe(true)
      expect(res.path).toBe('local_heuristic_revert')
    })

    it('5.4 LLM 调用超时 (8000ms) 时，触发超时熔断并快速回退 Tier 4', async () => {
      vi.spyOn(apiClient, 'chatCompletion').mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve('{}'), 250))
      )

      const card = document.createElement('div')
      const btn = document.createElement('button')
      btn.className = 'btn-contact-custom'
      btn.textContent = '联系HR'
      Object.defineProperty(btn, 'offsetWidth', { value: 90, configurable: true })
      Object.defineProperty(btn, 'offsetHeight', { value: 30, configurable: true })
      card.appendChild(btn)
      document.body.appendChild(card)

      const res = await clickApplyButtonWithResilience(card, {
        platform: 'boss',
        jobTitle: '测试主管',
        company: '方圆宝',
        allowLlm: true,
        llmTimeoutMs: 50,
      })

      expect(res.success).toBe(true)
      expect(res.path).toBe('local_heuristic_revert')
    })

    it('5.5 本地启发式规则基于宽泛沟通词 (沟通/投递/聊/对话) 成功定位并点击', () => {
      const candidates = [
        {
          index: 0,
          tag: 'div',
          text: '其他选项',
          className: 'opt',
          element: document.createElement('div'),
        },
        {
          index: 1,
          tag: 'button',
          text: '与Boss开聊',
          className: 'primary-chat',
          element: document.createElement('button'),
        },
      ]
      const chosen = rankCandidatesLocally(candidates)
      expect(chosen).not.toBeNull()
      expect(chosen?.index).toBe(1)
    })

    it('5.6 本地规则成功时同样将有效选择器持久化到 agentSkills (patchSource: heuristic)', async () => {
      const card = document.createElement('div')
      const btn = document.createElement('button')
      btn.className = 'btn-apply-fast'
      btn.textContent = '投递职位'
      Object.defineProperty(btn, 'offsetWidth', { value: 90, configurable: true })
      Object.defineProperty(btn, 'offsetHeight', { value: 30, configurable: true })
      card.appendChild(btn)
      document.body.appendChild(card)

      const res = await clickApplyButtonWithResilience(card, {
        platform: 'boss',
        jobTitle: 'Golang工程师',
        company: '方圆宝',
        allowLlm: false,
      })

      expect(res.success).toBe(true)
      expect(res.path).toBe('local_heuristic_revert')

      const skill = await findBestSkill('boss', 'job_detail', 'click_apply')
      expect(skill).not.toBeNull()
      expect(skill?.patchSource).toBe('heuristic')
      expect(skill?.remediationNotes).toContain('Tier 4')
    })

    it('5.7 极端全空页面：所有 Tier 均未命中时返回 { success: false, path: "failed" }，零异常抛出', async () => {
      const emptyCard = document.createElement('div')
      document.body.appendChild(emptyCard)

      const res = await clickApplyButtonWithResilience(emptyCard, {
        platform: 'boss',
        jobTitle: 'None',
        company: 'None',
        allowLlm: false,
      })

      expect(res.success).toBe(false)
      expect(res.path).toBe('failed')
    })

    it('5.8 自愈事件完整入库：每次降级均在 db.errors 中留下结构化审计记录', async () => {
      const card = document.createElement('div')
      const btn = document.createElement('button')
      btn.className = 'btn-recovered'
      btn.textContent = '与TA沟通'
      Object.defineProperty(btn, 'offsetWidth', { value: 90, configurable: true })
      Object.defineProperty(btn, 'offsetHeight', { value: 30, configurable: true })
      card.appendChild(btn)
      document.body.appendChild(card)

      await clickApplyButtonWithResilience(card, {
        platform: 'boss',
        jobTitle: '大数据开发',
        company: '方圆宝',
        allowLlm: false,
      })

      const errors = await listErrors(10)
      const buttonFallback = errors.find((e) => e.source.includes('button_fallback'))
      expect(buttonFallback).toBeDefined()
      expect(buttonFallback?.context).toContain('button_fallback')
    })
  })
})
