// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { db } from '../src/shared/db/index'
import { clearErrors } from '../src/shared/db/error-store'
import { setSkillMemoryTransportForTesting } from '../src/shared/agent/skill-memory'
import {
  findConfiguredApplyButtons,
  findApplyButtons,
  clickApplyButtonWithResilience,
  dismissUnexpectedModals,
  selectButtonViaLlm,
} from '../src/shared/platform/boss/action-simulator'
import * as apiClient from '../src/shared/ai/api-client'

function mockVisibleElement<T extends HTMLElement>(el: T, width = 120, height = 40): T {
  Object.defineProperty(el, 'offsetWidth', { value: width, configurable: true })
  Object.defineProperty(el, 'offsetHeight', { value: height, configurable: true })
  return el
}

describe('Challenger M2-IT2 Empirical Stress Tests: Scenarios A through F', () => {
  beforeEach(async () => {
    setSkillMemoryTransportForTesting('direct')
    await db.open()
    await db.agentSkills.clear()
    await clearErrors()
    await db.settings.put({ key: 'apiKey', value: 'mock-key' })
    await db.settings.put({ key: 'apiBaseUrl', value: 'https://mock.ai/v1' })

    document.body.innerHTML = ''
    document.body.className = ''
    document.body.style.overflow = ''
    document.body.style.position = ''
    document.body.style.pointerEvents = ''
    document.documentElement.className = ''
    document.documentElement.style.overflow = ''
    document.documentElement.style.pointerEvents = ''

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

  // ═══════════════════════════════════════════════════════════════════════════
  // Scenario A: Calling findConfiguredApplyButtons(null) and findApplyButtons(null)
  // ═══════════════════════════════════════════════════════════════════════════
  describe('Scenario A: Null parameter safety in button locators', () => {
    it('calling findConfiguredApplyButtons(null as any) returns empty array without throwing TypeError', () => {
      let result: HTMLElement[] | undefined
      expect(() => {
        result = findConfiguredApplyButtons(null as any)
      }).not.toThrow()
      expect(result).toBeDefined()
      expect(Array.isArray(result)).toBe(true)
      expect(result?.length).toBe(0)
    })

    it('calling findApplyButtons(null as any) returns empty array without throwing TypeError', () => {
      let result: HTMLElement[] | undefined
      expect(() => {
        result = findApplyButtons(null as any)
      }).not.toThrow()
      expect(result).toBeDefined()
      expect(Array.isArray(result)).toBe(true)
      expect(result?.length).toBe(0)
    })

    it('calling with undefined as any defaults safely without throwing', () => {
      let resConfigured: HTMLElement[] | undefined
      let resApply: HTMLElement[] | undefined
      expect(() => {
        resConfigured = findConfiguredApplyButtons(undefined as any)
      }).not.toThrow()
      expect(() => {
        resApply = findApplyButtons(undefined as any)
      }).not.toThrow()
      expect(Array.isArray(resConfigured)).toBe(true)
      expect(Array.isArray(resApply)).toBe(true)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // Scenario B: Passing jobCard = null to clickApplyButtonWithResilience
  // ═══════════════════════════════════════════════════════════════════════════
  describe('Scenario B: Null jobCard handling in clickApplyButtonWithResilience', () => {
    it('does not crash on standardButtons when jobCard is null and falls back to document or returns failed', async () => {
      let result: any
      await expect(
        (async () => {
          result = await clickApplyButtonWithResilience(null as any, {
            platform: 'boss',
            jobTitle: 'Frontend Engineer',
            company: 'Tech Corp',
            allowLlm: false,
          })
        })()
      ).resolves.not.toThrow()

      expect(result).toBeDefined()
      expect(result.success).toBe(false)
      expect(result.path).toBe('failed')
    })

    it('successfully locates and clicks document-level button when jobCard is null', async () => {
      const docBtn = document.createElement('button')
      docBtn.className = 'btn-startchat'
      docBtn.textContent = '立即沟通'
      mockVisibleElement(docBtn)
      document.body.appendChild(docBtn)

      let clicked = false
      docBtn.addEventListener('click', () => {
        clicked = true
      })

      const res = await clickApplyButtonWithResilience(null as any, {
        platform: 'boss',
        jobTitle: 'Frontend Engineer',
        company: 'Tech Corp',
        allowLlm: false,
      })

      expect(clicked).toBe(true)
      expect(res.success).toBe(true)
      expect(res.path).toBe('standard_heuristic')
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // Scenario C: Anti-hallucination guard against negative buttons
  // ═══════════════════════════════════════════════════════════════════════════
  describe('Scenario C: Anti-hallucination guard against negative LLM selections', () => {
    it('anti-hallucination guard rejects negative buttons ("放弃", "取消", "不合适") and falls back to Tier 4 local rule ranking', async () => {
      // 1. Verify anti-hallucination guard in selectButtonViaLlm rejects negative buttons directly
      const btnGiveUp = document.createElement('button')
      btnGiveUp.textContent = '放弃'
      const btnCancel = document.createElement('button')
      btnCancel.textContent = '取消'
      const btnUnsuitable = document.createElement('button')
      btnUnsuitable.textContent = '不合适'
      const btnPositive = document.createElement('button')
      btnPositive.textContent = '联系HR'

      const testCandidates = [
        { index: 0, tag: 'button', text: '放弃', className: 'btn', element: btnGiveUp },
        { index: 1, tag: 'button', text: '取消', className: 'btn', element: btnCancel },
        { index: 2, tag: 'button', text: '不合适', className: 'btn', element: btnUnsuitable },
        { index: 3, tag: 'button', text: '联系HR', className: 'btn', element: btnPositive },
      ]

      for (let i = 0; i < 3; i++) {
        vi.spyOn(apiClient, 'chatCompletion').mockResolvedValue(
          JSON.stringify({ selectedIndex: i, confidence: 0.99, reason: 'Hallucinated bad button' })
        )
        const llmDecision = await selectButtonViaLlm(testCandidates, {
          platform: 'boss',
          jobTitle: '测试岗',
          company: '测试司',
        })
        expect(llmDecision).toBeNull()
      }

      // 2. Integration test in clickApplyButtonWithResilience:
      // When Tier 1 & Tier 2 do not match, LLM is invoked; when LLM hallucinates an invalid/negative selection,
      // the system rejects it and falls back to Tier 4 local rule ranking.
      const card = document.createElement('div')
      card.className = 'custom-job-card'

      const customCommBtn = document.createElement('button')
      customCommBtn.className = 'btn-custom-reach'
      customCommBtn.textContent = '联系HR'
      mockVisibleElement(customCommBtn)
      card.appendChild(customCommBtn)
      document.body.appendChild(card)

      let commClicked = false
      customCommBtn.addEventListener('click', () => { commClicked = true })

      // Simulate LLM returning a hallucinated out-of-bounds or invalid negative response
      vi.spyOn(apiClient, 'chatCompletion').mockResolvedValue(
        JSON.stringify({ selectedIndex: null, confidence: 0, reason: 'Negative/No button found' })
      )

      const res = await clickApplyButtonWithResilience(card, {
        platform: 'boss',
        jobTitle: 'Node.js 架构师',
        company: '测试科技',
        allowLlm: true,
      })

      expect(commClicked).toBe(true)
      expect(res.success).toBe(true)
      expect(res.path).toBe('local_heuristic_revert')
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // Scenario D: Zero LLM configuration or LLM API throws timeout/network error
  // ═══════════════════════════════════════════════════════════════════════════
  describe('Scenario D: LLM failure and unconfigured fallback', () => {
    it('zero LLM configuration safely falls back to local heuristic without throwing', async () => {
      vi.spyOn(apiClient, 'checkAIConfigured').mockResolvedValue({ configured: false, reason: 'Unconfigured' })
      const chatSpy = vi.spyOn(apiClient, 'chatCompletion')

      const card = document.createElement('div')
      const btn = document.createElement('button')
      btn.className = 'btn-custom-reach'
      btn.textContent = '联系HR了解岗位'
      mockVisibleElement(btn)
      card.appendChild(btn)
      document.body.appendChild(card)

      let clicked = false
      btn.addEventListener('click', () => { clicked = true })

      const res = await clickApplyButtonWithResilience(card, {
        platform: 'boss',
        jobTitle: 'Golang Engineer',
        company: 'Cloud Corp',
        allowLlm: true,
      })

      expect(chatSpy).not.toHaveBeenCalled()
      expect(clicked).toBe(true)
      expect(res.success).toBe(true)
      expect(res.path).toBe('local_heuristic_revert')
    })

    it('LLM API throws network/timeout error safely falls back to local heuristic without throwing', async () => {
      vi.spyOn(apiClient, 'checkAIConfigured').mockResolvedValue({ configured: true })
      vi.spyOn(apiClient, 'chatCompletion').mockRejectedValue(new Error('Network error: ETIMEDOUT'))

      const card = document.createElement('div')
      const btn = document.createElement('button')
      btn.className = 'btn-custom-reach'
      btn.textContent = '投递职位简历'
      mockVisibleElement(btn)
      card.appendChild(btn)
      document.body.appendChild(card)

      let clicked = false
      btn.addEventListener('click', () => { clicked = true })

      const res = await clickApplyButtonWithResilience(card, {
        platform: 'boss',
        jobTitle: 'Golang Engineer',
        company: 'Cloud Corp',
        allowLlm: true,
      })

      expect(clicked).toBe(true)
      expect(res.success).toBe(true)
      expect(res.path).toBe('local_heuristic_revert')
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // Scenario E: Viewport frozen with multiple fixed z-index >= 1000 overlays
  // ═══════════════════════════════════════════════════════════════════════════
  describe('Scenario E: Viewport frozen and modal/overlay deblocking', () => {
    it('removes masks, resets body/html overflow, position and restores scrolling', () => {
      // 1. Setup frozen viewport
      document.body.style.overflow = 'hidden'
      document.body.style.position = 'fixed'
      document.body.style.pointerEvents = 'none'
      document.body.classList.add('modal-open', 'dialog-open', 'has-modal', 'popup-show', 'overflow-hidden')

      document.documentElement.style.overflow = 'hidden'
      document.documentElement.style.pointerEvents = 'none'

      // 2. Setup multiple fixed / absolute z-index >= 1000 overlays
      const overlay1 = document.createElement('div')
      overlay1.style.position = 'fixed'
      overlay1.style.zIndex = '1001'
      mockVisibleElement(overlay1, 1920, 1080)
      document.body.appendChild(overlay1)

      const overlay2 = document.createElement('div')
      overlay2.style.position = 'absolute'
      overlay2.style.zIndex = '2000'
      mockVisibleElement(overlay2, 1920, 1080)
      document.body.appendChild(overlay2)

      const mask1 = document.createElement('div')
      mask1.className = 'dialog-mask'
      mockVisibleElement(mask1, 1920, 1080)
      document.body.appendChild(mask1)

      const mask2 = document.createElement('div')
      mask2.className = 'el-overlay'
      mockVisibleElement(mask2, 1920, 1080)
      document.body.appendChild(mask2)

      const dismissed = dismissUnexpectedModals(document)

      expect(dismissed).toBe(true)

      // Overlays and masks hidden
      expect(overlay1.style.display).toBe('none')
      expect(overlay1.style.pointerEvents).toBe('none')
      expect(overlay2.style.display).toBe('none')
      expect(overlay2.style.pointerEvents).toBe('none')
      expect(mask1.style.display).toBe('none')
      expect(mask1.style.pointerEvents).toBe('none')
      expect(mask2.style.display).toBe('none')
      expect(mask2.style.pointerEvents).toBe('none')

      // Viewport styles restored
      expect(document.body.style.overflow).toBe('')
      expect(document.body.style.position).toBe('')
      expect(document.body.style.pointerEvents).toBe('')
      expect(document.documentElement.style.overflow).toBe('')
      expect(document.documentElement.style.pointerEvents).toBe('')

      // Lock classes stripped
      expect(document.body.classList.contains('modal-open')).toBe(false)
      expect(document.body.classList.contains('dialog-open')).toBe(false)
      expect(document.body.classList.contains('has-modal')).toBe(false)
      expect(document.body.classList.contains('popup-show')).toBe(false)
      expect(document.body.classList.contains('overflow-hidden')).toBe(false)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // Scenario F: Protected dialog preservation
  // ═══════════════════════════════════════════════════════════════════════════
  describe('Scenario F: Protected dialog preservation', () => {
    it('dialog containing .chat-input, textarea, Geetest slider, or account restriction text must NOT be dismissed', () => {
      // 1. Dialog containing .chat-input
      const chatDialog1 = document.createElement('div')
      chatDialog1.className = 'chat-dialog'
      chatDialog1.setAttribute('role', 'dialog')
      chatDialog1.innerHTML = `
        <div class="chat-header">向HR打招呼</div>
        <input type="text" class="chat-input" value="您好！" />
      `
      mockVisibleElement(chatDialog1, 400, 300)
      document.body.appendChild(chatDialog1)

      // 2. Dialog containing textarea with greeting
      const chatDialog2 = document.createElement('div')
      chatDialog2.setAttribute('role', 'dialog')
      chatDialog2.innerHTML = `
        <div>开聊前请发送打招呼语</div>
        <textarea>期待与您沟通！</textarea>
      `
      mockVisibleElement(chatDialog2, 400, 300)
      document.body.appendChild(chatDialog2)

      // 3. Dialog containing Geetest slider
      const geetestDialog = document.createElement('div')
      geetestDialog.className = 'geetest_holder'
      geetestDialog.setAttribute('role', 'dialog')
      geetestDialog.innerHTML = `
        <div>请完成安全验证</div>
        <div class="geetest_slider">滑动滑块</div>
      `
      mockVisibleElement(geetestDialog, 350, 250)
      document.body.appendChild(geetestDialog)

      // 4. Dialog containing account restriction text
      const restrictionDialog = document.createElement('div')
      restrictionDialog.className = 'boss-dialog'
      restrictionDialog.setAttribute('role', 'dialog')
      restrictionDialog.innerHTML = `
        <h3>今日沟通次数已达上限</h3>
        <p>为营造良好的沟通环境，今日沟通已达上限，请明天再试。</p>
      `
      mockVisibleElement(restrictionDialog, 350, 200)
      document.body.appendChild(restrictionDialog)

      const dismissed = dismissUnexpectedModals(document)

      // None of the protected dialogs should be dismissed or hidden
      expect(chatDialog1.style.display).not.toBe('none')
      expect(chatDialog2.style.display).not.toBe('none')
      expect(geetestDialog.style.display).not.toBe('none')
      expect(restrictionDialog.style.display).not.toBe('none')
      expect(dismissed).toBe(false)
    })
  })
})
