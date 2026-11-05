// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { db } from '../src/shared/db/index'
import {
  cleanCompanyNameEnhanced,
  extractTitleTokens,
  fuzzyMultiWordMatch,
  isNegativeButton,
  isPositiveApplyButton,
  dismissUnexpectedModals,
  findConfiguredApplyButtons,
  clickApplyButtonWithResilience,
  activateJobCardWithFallback,
} from '../src/shared/platform/boss/action-simulator'
import * as apiClient from '../src/shared/ai/api-client'

describe('Auditor M2 Forensic & Adversarial Stress Tests', () => {
  beforeEach(async () => {
    await db.open()
    await db.agentSkills.clear()
    document.body.innerHTML = ''
    document.body.style.overflow = ''
    document.body.style.position = ''
    document.body.style.pointerEvents = ''
    document.body.className = ''
    document.documentElement.style.overflow = ''
    document.documentElement.style.pointerEvents = ''

    vi.stubGlobal('chrome', {
      storage: {
        local: {
          get: vi.fn(async () => ({})),
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
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  describe('Adversarial 1: cleanCompanyNameEnhanced & extractTitleTokens boundary stress', () => {
    it('handles nested parentheses, multiple geographic prefixes, and legal suffixes', () => {
      const input = '广东省广州市腾讯科技(深圳)有限公司(大中华区)[总公司]'
      const cleaned = cleanCompanyNameEnhanced(input)
      expect(cleaned).toBe('腾讯')
    })

    it('survives malicious strings with script tags and null bytes', () => {
      const malicious = '<script>alert("xss")</script>深圳市方圆宝科技有限公司\u0000'
      const cleaned = cleanCompanyNameEnhanced(malicious)
      expect(cleaned).toContain('方圆宝')
      expect(cleaned).not.toContain('深圳')
      expect(cleaned).not.toContain('科技')
    })

    it('handles titles with unusual delimiters, emojis, and symbols', () => {
      const title = '🚀 Senior Full-Stack Engineer / 全栈开发 (Node.js + Vue.js · 架构师) 💻'
      const tokens = extractTitleTokens(title)
      expect(tokens).toContain('全栈')
      expect(tokens).toContain('node.js')
      expect(tokens).toContain('架构师')
    })
  })

  describe('Adversarial 2: fuzzyMultiWordMatch anti-collision & cross-company defense', () => {
    it('strictly rejects when title matches 100% but company belongs to a direct competitor', () => {
      const card = '资深前端工程师 阿里巴巴集团 30-50K'
      const result = fuzzyMultiWordMatch(card, '资深前端工程师', '深圳市腾讯计算机系统有限公司')
      expect(result.titleScore).toBe(1.0)
      expect(result.companyScore).toBe(0.0)
      // Composite score must be penalized: 1.0 * 0.3 = 0.300 < 0.55
      expect(result.score).toBeLessThan(0.55)
      expect(result.matched).toBe(false)
    })

    it('tolerates standard company naming variations and abbreviations', () => {
      const card = '全栈工程师 腾讯 25-40K'
      const result = fuzzyMultiWordMatch(card, '全栈工程师', '腾讯科技(深圳)有限公司')
      expect(result.matched).toBe(true)
      expect(result.score).toBeGreaterThanOrEqual(0.8)
    })

    it('handles massive 10,000 character garbage string without hanging or crashing', () => {
      const hugeGarbage = 'abc '.repeat(2500)
      const t0 = Date.now()
      const result = fuzzyMultiWordMatch(hugeGarbage, '前端开发', '方圆宝')
      const elapsed = Date.now() - t0
      expect(elapsed).toBeLessThan(500)
      expect(result.matched).toBe(false)
    })
  })

  describe('Adversarial 3: dismissUnexpectedModals active greeting preservation & idempotency', () => {
    it('strictly preserves chat greeting dialog even when it contains negative-sounding words in user input', () => {
      const chatDialog = document.createElement('div')
      chatDialog.className = 'chat-dialog'
      chatDialog.innerHTML = `
        <div class="header">打招呼内容</div>
        <textarea class="chat-input">您好，看到贵司写着如果技能不合适可以沟通，我想了解更多细节</textarea>
        <button class="btn-send">发送</button>
      `
      Object.defineProperty(chatDialog, 'offsetWidth', { value: 400, configurable: true })
      Object.defineProperty(chatDialog, 'offsetHeight', { value: 300, configurable: true })
      document.body.appendChild(chatDialog)

      const dismissed = dismissUnexpectedModals(document)
      expect(dismissed).toBe(false)
      expect(chatDialog.style.display).not.toBe('none')
    })

    it('is completely idempotent when called 10 times consecutively on cleared DOM', () => {
      // First call clears mask
      const mask = document.createElement('div')
      mask.className = 'dialog-mask'
      Object.defineProperty(mask, 'offsetWidth', { value: 800, configurable: true })
      Object.defineProperty(mask, 'offsetHeight', { value: 600, configurable: true })
      document.body.appendChild(mask)

      const firstCall = dismissUnexpectedModals(document)
      expect(firstCall).toBe(true)
      expect(mask.style.display).toBe('none')

      // Subsequent 9 calls should safely return false without side effects
      for (let i = 0; i < 9; i++) {
        const res = dismissUnexpectedModals(document)
        expect(res).toBe(false)
      }
    })

    it('handles null/undefined document gracefully without throwing', () => {
      expect(() => dismissUnexpectedModals(null as any)).not.toThrow()
      expect(() => dismissUnexpectedModals(undefined as any)).not.toThrow()
    })
  })

  describe('Adversarial 4: clickApplyButtonWithResilience negative button exclusion & LLM timeout fallback', () => {
    it('strictly rejects clicking negative buttons even if marked as .btn-startchat', async () => {
      const card = document.createElement('div')
      const fakeApply = document.createElement('button')
      fakeApply.className = 'btn-startchat'
      fakeApply.textContent = '不合适' // Poisoned button text
      Object.defineProperty(fakeApply, 'offsetWidth', { value: 100, configurable: true })
      Object.defineProperty(fakeApply, 'offsetHeight', { value: 35, configurable: true })
      card.appendChild(fakeApply)
      document.body.appendChild(card)

      let clicked = false
      fakeApply.onclick = () => { clicked = true }

      const res = await clickApplyButtonWithResilience(card, {
        platform: 'boss',
        jobTitle: '前端',
        company: '测试公司',
        allowLlm: false,
      })

      expect(clicked).toBe(false)
      expect(res.path).not.toBe('standard_heuristic')
    })

    it('falls back cleanly to local heuristic when LLM promise hangs past timeoutMs', async () => {
      vi.spyOn(apiClient, 'checkAIConfigured').mockResolvedValue({ configured: true })
      // Make LLM promise never resolve
      vi.spyOn(apiClient, 'chatCompletion').mockImplementation(() => new Promise(() => {}))

      const card = document.createElement('div')
      const btn = document.createElement('button')
      btn.className = 'btn-contact-custom'
      btn.textContent = '沟通职位'
      Object.defineProperty(btn, 'offsetWidth', { value: 100, configurable: true })
      Object.defineProperty(btn, 'offsetHeight', { value: 35, configurable: true })
      card.appendChild(btn)
      document.body.appendChild(card)

      let clicked = false
      btn.onclick = () => { clicked = true }

      const t0 = Date.now()
      const res = await clickApplyButtonWithResilience(card, {
        platform: 'boss',
        jobTitle: '前端',
        company: '测试公司',
        allowLlm: true,
        llmTimeoutMs: 100, // Short timeout for adversarial test
      })
      const duration = Date.now() - t0

      expect(res.success).toBe(true)
      expect(res.path).toBe('local_heuristic_revert')
      expect(clicked).toBe(true)
      expect(duration).toBeLessThan(1000)
    })
  })
})
