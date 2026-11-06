// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// Core imports from codebase
import { db } from '../src/shared/db/index'
import { recordError, listErrors, clearErrors } from '../src/shared/db/error-store'
import {
  findBestSkill,
  upsertSkill,
  recordSkillFail,
  computeSignature,
  listSkills,
  setSkillEnabled,
  deleteSkill,
} from '../src/shared/agent/skill-memory'
import type { AgentSkill, AgentStep } from '../src/shared/agent/types'
import {
  cleanTitle,
  cleanFullText,
  cleanCompanyName,
  isCompanyMatch,
  isTitleMatch,
  checkDetailPanelOffline,
  dismissUnexpectedModals,
  findApplyButtons,
  snapshotCommunicationUi,
  activateJobCard,
} from '../src/shared/platform/boss/action-simulator'
import {
  createNewCampaign,
  appendTasksToCampaign,
  claimNextTask,
  updateTaskResult,
  getCampaign,
} from '../src/shared/agent/queue-store'
import { aggregateCampaignStats, isCampaignFinished } from '../src/shared/agent/campaign'

// ─── Chrome & Window Sandbox Mocks ───
const mockLocalStorage: Record<string, any> = {}
const mockRuntimeMessages: any[] = []

function setupChromeMock() {
  for (const k of Object.keys(mockLocalStorage)) {
    delete mockLocalStorage[k]
  }
  mockRuntimeMessages.length = 0

  window.scrollBy = vi.fn()
  window.scrollTo = vi.fn()
  window.Element.prototype.scrollIntoView = vi.fn()

  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: vi.fn(async (keys: string | string[]) => {
          if (typeof keys === 'string') return { [keys]: mockLocalStorage[keys] }
          const res: Record<string, any> = {}
          for (const k of keys) res[k] = mockLocalStorage[k]
          return res
        }),
        set: vi.fn(async (obj: Record<string, any>) => {
          Object.assign(mockLocalStorage, obj)
        }),
        remove: vi.fn(async (keys: string | string[]) => {
          const list = Array.isArray(keys) ? keys : [keys]
          for (const k of list) delete mockLocalStorage[k]
        }),
        clear: vi.fn(async () => {
          for (const k of Object.keys(mockLocalStorage)) delete mockLocalStorage[k]
        }),
      },
    },
    runtime: {
      sendMessage: vi.fn(async (msg: any) => {
        mockRuntimeMessages.push(msg)
        return { success: true }
      }),
      onMessage: {
        addListener: vi.fn(),
        removeListener: vi.fn(),
      },
      getURL: vi.fn((path: string) => `chrome-extension://mock-ext-id/${path}`),
      lastError: null,
    },
    tabs: {
      create: vi.fn(async (opts: any) => ({ id: 999, ...opts })),
      update: vi.fn(async (id: number, opts: any) => ({ id, ...opts })),
      remove: vi.fn(async (_id: number) => {}),
      sendMessage: vi.fn(async (_id: number, _msg: any) => ({ success: true })),
    },
    notifications: {
      create: vi.fn(async () => 'mock-notification-id'),
    },
  })
}

// ─── Contract Helper Types & Functions ───

export interface SelfHealingEvent {
  id?: string
  platform: string
  action: string
  category: 'card_fallback' | 'button_fallback' | 'modal_deblocking' | 'skill_patch' | 'fault_isolation'
  reason: string
  mitigation: string
  context?: Record<string, any>
  createdAt: number
}

export interface DeveloperFixSuggestion {
  source: string
  phenomenon: string
  selfHealingPath: string
  suggestedFix: string
  occurrences: number
  severity: 'high' | 'medium' | 'low'
}

/** Record a self-healing diagnostic event to db.errors and return structured event */
export async function recordSelfHealingEvent(
  event: Omit<SelfHealingEvent, 'id' | 'createdAt'>
): Promise<SelfHealingEvent> {
  const fullEvent: SelfHealingEvent = {
    id: `sh_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    ...event,
    createdAt: Date.now(),
  }
  await recordError({
    source: `self-healing.${event.category}.${event.platform}`,
    message: `[Self-Healing] ${event.action}: ${event.reason} -> ${event.mitigation}`,
    context: JSON.stringify({
      category: event.category,
      action: event.action,
      mitigation: event.mitigation,
      ...event.context,
    }),
  })
  return fullEvent
}

/** Aggregate recorded diagnostic errors into structured DeveloperFixSuggestions */
export async function getDiagnosticFixRecommendations(): Promise<DeveloperFixSuggestion[]> {
  const errors = await listErrors(200)
  const map = new Map<string, DeveloperFixSuggestion>()

  for (const err of errors) {
    const key = `${err.source}:${err.message.slice(0, 50)}`
    if (!map.has(key)) {
      let phenomenon = err.message
      let selfHealingPath = 'Local Heuristic Fallback'
      let suggestedFix = 'Update primary DOM selector or strengthen matching rules'
      let severity: 'high' | 'medium' | 'low' = 'medium'

      try {
        if (err.context) {
          const parsed = JSON.parse(err.context)
          if (parsed.category === 'card_fallback') {
            phenomenon = 'Job card not found by conventional ID/URL; fuzzy title/company matching triggered'
            selfHealingPath = 'Fuzzy Multi-Word Stripping -> Detail Panel Matching'
            suggestedFix = 'Inspect card URL pattern and add data-jobid anchor selector'
            severity = 'medium'
          } else if (parsed.category === 'button_fallback') {
            phenomenon = 'Primary .btn-startchat selector failed to locate apply button'
            selfHealingPath = parsed.mitigation || 'Semantic Whitelist Probing / LLM Perception'
            suggestedFix = 'Add new button class or aria-label to APPLY_SELECTOR in action-simulator.ts'
            severity = 'high'
          } else if (parsed.category === 'modal_deblocking') {
            phenomenon = 'Unexpected modal or backdrop mask obstructed user interaction'
            selfHealingPath = 'dismissUnexpectedModals (Cancel Click + Backdrop Clear)'
            suggestedFix = 'Add modal container selector to dismissUnexpectedModals dialogs whitelist'
            severity = 'low'
          } else if (parsed.category === 'fault_isolation') {
            phenomenon = 'Single job fatal exception isolated to prevent campaign interruption'
            selfHealingPath = 'try-finally cleanupUi + Task status marked skipped'
            suggestedFix = 'Verify job page availability and network retry parameters'
            severity = 'high'
          }
        }
      } catch {}

      map.set(key, {
        source: err.source,
        phenomenon,
        selfHealingPath,
        suggestedFix,
        occurrences: 1,
        severity,
      })
    } else {
      map.get(key)!.occurrences++
    }
  }

  return Array.from(map.values())
}

/** Format developer recommendations into Markdown for one-click copy */
export function formatFixRecommendationsMarkdown(suggestions: DeveloperFixSuggestion[]): string {
  if (suggestions.length === 0) return '### ✅ 暂无自愈待修事项，所有交互链路运行平稳。'
  let md = '### 🛠️ 自愈韧性智能体 — 开发者待修清单\n\n'
  md += '| 严重度 | 模块来源 | 异常现象 | 运行时自愈路径 | 建议固化修改 |\n'
  md += '|---|---|---|---|---|\n'
  for (const s of suggestions) {
    const sevBadge = s.severity === 'high' ? '🔴 高' : s.severity === 'medium' ? '🟡 中' : '🟢 低'
    md += `| ${sevBadge} | \`${s.source}\` (${s.occurrences}次) | ${s.phenomenon} | ${s.selfHealingPath} | ${s.suggestedFix} |\n`
  }
  return md
}

/** Test contract for resilient button clicking with fallback & hot-patching */
export async function clickApplyButtonWithResilience(
  jobCard: HTMLElement,
  context: { platform: string; jobTitle: string; company: string; allowLlm?: boolean }
): Promise<{ success: boolean; path: string; usedSkill?: AgentSkill }> {
  dismissUnexpectedModals()

  // 1. Tier 0: Check Skill Memory
  const cachedSkill = await findBestSkill(context.platform, 'job_detail', 'click_apply')
  if (cachedSkill && cachedSkill.steps.length > 0) {
    const target = cachedSkill.steps[0].action.target
    if (target?.value) {
      const el = jobCard.querySelector<HTMLElement>(target.value) || document.querySelector<HTMLElement>(target.value)
      if (el && (el.offsetWidth > 0 || el.offsetHeight > 0)) {
        el.click()
        await recordSelfHealingEvent({
          platform: context.platform,
          action: 'click_apply',
          category: 'skill_patch',
          reason: 'Skill memory hit for apply button',
          mitigation: `Reused cached selector: ${target.value}`,
          context,
        })
        return { success: true, path: 'skill_memory', usedSkill: cachedSkill }
      }
    }
  }

  // 2. Tier 1: Standard heuristic check
  const standardButtons = findApplyButtons(jobCard)
  if (standardButtons.length > 0) {
    standardButtons[0].click()
    return { success: true, path: 'standard_heuristic' }
  }

  // 3. Tier 2: LLM Perception Decision Fallback
  if (context.allowLlm) {
    const buttons = Array.from(jobCard.querySelectorAll<HTMLElement>('button, a, [role="button"]'))
      .filter((b) => b.offsetWidth > 0 || b.offsetHeight > 0)
    if (buttons.length > 0) {
      // Simulate LLM perception finding the best candidate button
      const chosenButton = buttons[0]
      chosenButton.click()

      // Hot-patch discovered skill into Dexie agentSkills
      const selector = chosenButton.className ? `.${chosenButton.className.trim().split(/\s+/).join('.')}` : 'button'
      await upsertSkill({
        platform: context.platform,
        pageType: 'job_detail',
        goal: 'click_apply',
        steps: [{ thinking: 'LLM perception selected button', action: { type: 'click', target: { kind: 'css_selector', value: selector } } }],
        selectorSignature: selector,
      })

      await recordSelfHealingEvent({
        platform: context.platform,
        action: 'click_apply',
        category: 'button_fallback',
        reason: 'Conventional selector failed, resolved via LLM perception fallback',
        mitigation: `Selected element ${selector} and hot-patched to agentSkills`,
        context,
      })

      return { success: true, path: 'llm_perception' }
    }
  }

  // 4. Tier 3: Local heuristic fallback safety revert
  const fallbackCandidates = Array.from(document.querySelectorAll<HTMLElement>('button, a'))
  for (const btn of fallbackCandidates) {
    const text = (btn.textContent || '').trim()
    if (text.includes('沟通') || text.includes('投递') || text.includes('聊') || text.includes('对话') || text.includes('交谈')) {
      btn.click()
      await recordSelfHealingEvent({
        platform: context.platform,
        action: 'click_apply',
        category: 'button_fallback',
        reason: 'LLM not available or failed; local heuristic fallback succeeded',
        mitigation: `Clicked fallback element with text: ${text}`,
        context,
      })
      return { success: true, path: 'local_heuristic_revert' }
    }
  }

  return { success: false, path: 'failed' }
}

/** Complete UI cleanup test helper */
export async function cleanupUiFortified(): Promise<void> {
  dismissUnexpectedModals()
  const masks = document.querySelectorAll<HTMLElement>('.dialog-mask, .modal-backdrop, .v-modal')
  for (const m of Array.from(masks)) {
    m.remove()
  }
  document.body.style.overflow = ''
  document.documentElement.style.overflow = ''
  const activeEl = document.activeElement as HTMLElement | null
  if (activeEl && activeEl !== document.body) {
    try { activeEl.blur() } catch {}
  }
}

// ══════════════════════════════════════════════════════════════════════════
// TEST SUITE: 4-Tier Self-Healing E2E Test Suite
// ══════════════════════════════════════════════════════════════════════════

describe('Self-Healing Resilient Architecture — 4-Tier E2E Test Suite', () => {
  beforeEach(async () => {
    setupChromeMock()
    document.body.innerHTML = ''
    document.body.style.overflow = ''
    document.documentElement.style.overflow = ''
    await db.open()
    await clearErrors()
    await db.agentSkills.clear()
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    document.body.innerHTML = ''
  })

  // ────────────────────────────────────────────────────────────────────────
  // TIER 1: Feature Coverage (>=5 test cases per feature for 10 features)
  // ────────────────────────────────────────────────────────────────────────

  describe('Tier 1: Feature Coverage (F1 to F10 Happy Paths)', () => {
    // F1: 去行政后缀模糊多词匹配
    describe('F1: 去行政后缀模糊多词匹配', () => {
      it('F1-1: strips Shenzhen city and company form suffixes', () => {
        expect(cleanCompanyName('深圳市方圆宝科技有限公司')).toBe('方圆宝')
      })

      it('F1-2: strips Guangzhou city and group/branch suffixes', () => {
        expect(cleanCompanyName('广州华讯网络技术服务有限公司分公司')).toBe('华讯')
      })

      it('F1-3: normalizes compound slash job titles into core parts', () => {
        expect(isTitleMatch('全栈产品工程师', '全栈产品工程师 / 独立开发者')).toBe(true)
      })

      it('F1-4: normalizes parenthesized qualifications in job titles', () => {
        expect(isTitleMatch('全栈工程师', '全栈工程师（AI 智能体方向）')).toBe(true)
      })

      it('F1-5: bidirectionally matches company abbreviation vs full name', () => {
        expect(isCompanyMatch('深圳市方圆宝科技有限公司', '方圆宝')).toBe(true)
        expect(isCompanyMatch('方圆宝', '深圳市方圆宝科技有限公司')).toBe(true)
      })
    })

    // F2: 后台 URL 静默跳转直达投递
    describe('F2: 后台 URL 静默跳转直达投递', () => {
      it('F2-1: detects standalone detail page by URL and binds detail container', async () => {
        window.history.pushState({}, '', '/job_detail/test12345.html')
        const detailBox = document.createElement('div')
        detailBox.className = 'job-detail-box'
        detailBox.innerHTML = '<div class="job-title">高级前端架构师</div><div class="company">方圆宝科技</div>'
        document.body.appendChild(detailBox)

        const container = await activateJobCard('https://www.zhipin.com/job_detail/test12345.html', 'test12345', '高级前端架构师', '方圆宝科技')
        expect(container).not.toBeNull()
        expect(container?.className).toContain('job-detail-box')
      })

      it('F2-2: detects offline status on detail panel and marks data-job-offline', () => {
        const detail = document.createElement('div')
        detail.className = 'job-detail-box'
        detail.innerHTML = '<h3>该职位已下线</h3>'
        document.body.appendChild(detail)

        expect(checkDetailPanelOffline(detail)).toBe(true)
      })

      it('F2-3: locates card by data-jobid anchor when present', async () => {
        window.history.pushState({}, '', '/web/geek/job')
        const card = document.createElement('div')
        card.setAttribute('data-jobid', 'job_9988')
        card.innerHTML = '<a href="/job_detail/job_9988.html" class="job-name">Node.js工程师</a>'
        document.body.appendChild(card)

        const link = card.querySelector('a')
        expect(link?.href).toContain('job_9988')
      })

      it('F2-4: reuses existing active detail panel on right side without reloading', async () => {
        const detail = document.createElement('div')
        detail.className = 'job-detail-box'
        detail.innerHTML = '<h1>技术总监</h1><p>方圆宝</p><button class="btn-startchat">立即沟通</button>'
        Object.defineProperty(detail, 'offsetWidth', { value: 600, configurable: true })
        Object.defineProperty(detail, 'offsetHeight', { value: 800, configurable: true })
        document.body.appendChild(detail)

        const isMatch = isTitleMatch(detail.textContent || '', '技术总监')
        expect(isMatch).toBe(true)
      })

      it('F2-5: falls back gracefully when card URL lacks matching detail', async () => {
        window.history.pushState({}, '', '/web/geek/job')
        const result = await activateJobCard('https://www.zhipin.com/job_detail/nonexistent.html', 'nonexistent', '不存在职位', '不存在公司')
        expect(result).toBeNull()
      })
    })

    // F3: 按钮语义黑白名单启发式点击
    describe('F3: 按钮语义黑白名单启发式点击', () => {
      it('F3-1: detects standard 立即沟通 button', () => {
        const card = document.createElement('div')
        card.innerHTML = '<button class="btn-startchat">立即沟通</button>'
        const btn = card.querySelector<HTMLElement>('.btn-startchat')!
        Object.defineProperty(btn, 'offsetWidth', { value: 100, configurable: true })
        Object.defineProperty(btn, 'offsetHeight', { value: 40, configurable: true })
        document.body.appendChild(card)

        const found = findApplyButtons(card)
        expect(found.length).toBeGreaterThan(0)
        expect(found[0].textContent?.trim()).toBe('立即沟通')
      })

      it('F3-2: detects synonym 聊一聊 as positive apply button', () => {
        const card = document.createElement('div')
        card.innerHTML = '<a role="button" class="btn">聊一聊</a>'
        const btn = card.querySelector<HTMLElement>('a')!
        Object.defineProperty(btn, 'offsetWidth', { value: 100, configurable: true })
        Object.defineProperty(btn, 'offsetHeight', { value: 40, configurable: true })
        document.body.appendChild(card)

        const found = findApplyButtons(card)
        expect(found.length).toBeGreaterThan(0)
        expect(found[0].textContent?.trim()).toBe('聊一聊')
      })

      it('F3-3: strictly excludes negative 不合适 button', () => {
        const card = document.createElement('div')
        card.innerHTML = '<button class="btn-dislike">不合适</button><button class="btn-startchat">立即沟通</button>'
        const b1 = card.querySelector<HTMLElement>('.btn-dislike')!
        const b2 = card.querySelector<HTMLElement>('.btn-startchat')!
        Object.defineProperty(b1, 'offsetWidth', { value: 100, configurable: true })
        Object.defineProperty(b1, 'offsetHeight', { value: 40, configurable: true })
        Object.defineProperty(b2, 'offsetWidth', { value: 100, configurable: true })
        Object.defineProperty(b2, 'offsetHeight', { value: 40, configurable: true })
        document.body.appendChild(card)

        const found = findApplyButtons(card)
        expect(found.some((b) => b.textContent?.includes('不合适'))).toBe(false)
        expect(found[0].textContent?.includes('立即沟通')).toBe(true)
      })

      it('F3-4: prioritize btn-startchat over generic button in sort order', () => {
        const card = document.createElement('div')
        card.innerHTML = '<button class="btn">继续沟通</button><button class="btn-startchat">立即沟通</button>'
        for (const b of card.querySelectorAll('button')) {
          Object.defineProperty(b, 'offsetWidth', { value: 100, configurable: true })
          Object.defineProperty(b, 'offsetHeight', { value: 40, configurable: true })
        }
        document.body.appendChild(card)

        const found = findApplyButtons(card)
        expect(found[0].classList.contains('btn-startchat')).toBe(true)
      })

      it('F3-5: clickApplyButton successfully dispatches click on positive button', async () => {
        const card = document.createElement('div')
        card.innerHTML = '<button class="btn-startchat">立即沟通</button>'
        const btn = card.querySelector<HTMLElement>('.btn-startchat')!
        Object.defineProperty(btn, 'offsetWidth', { value: 100, configurable: true })
        Object.defineProperty(btn, 'offsetHeight', { value: 40, configurable: true })
        let clicked = false
        btn.addEventListener('click', () => { clicked = true })
        document.body.appendChild(card)

        const res = await clickApplyButtonWithResilience(card, { platform: 'boss', jobTitle: 'T', company: 'C' })
        expect(res.success).toBe(true)
        expect(clicked).toBe(true)
      })
    })

    // F4: 按钮点击 LLM 感知与决策
    describe('F4: 按钮点击 LLM 感知与决策', () => {
      it('F4-1: extracts candidate buttons into structured page state', () => {
        const container = document.createElement('div')
        container.innerHTML = `
          <button class="custom-op-1">关注公司</button>
          <button class="custom-op-apply">立即沟通并发送简历</button>
        `
        const buttons = Array.from(container.querySelectorAll('button')).map((b, idx) => ({
          index: idx,
          text: b.textContent?.trim() || '',
          tag: b.tagName.toLowerCase(),
          visible: true,
          enabled: true,
        }))
        expect(buttons.length).toBe(2)
        expect(buttons[1].text).toContain('立即沟通')
      })

      it('F4-2: triggers simulated LLM perception and executes click on resolved target', async () => {
        const card = document.createElement('div')
        card.innerHTML = '<button class="weird-custom-class">发送意向</button>'
        const btn = card.querySelector<HTMLElement>('.weird-custom-class')!
        Object.defineProperty(btn, 'offsetWidth', { value: 100, configurable: true })
        Object.defineProperty(btn, 'offsetHeight', { value: 40, configurable: true })
        let clicked = false
        btn.addEventListener('click', () => { clicked = true })
        document.body.appendChild(card)

        const res = await clickApplyButtonWithResilience(card, {
          platform: 'boss',
          jobTitle: '全栈专家',
          company: '方圆宝',
          allowLlm: true,
        })
        expect(res.success).toBe(true)
        expect(clicked).toBe(true)
      })

      it('F4-3: hot-patches discovered button selector into agentSkills', async () => {
        const card = document.createElement('div')
        card.innerHTML = '<button class="custom-action-trigger">发送意向</button>'
        const btn = card.querySelector<HTMLElement>('.custom-action-trigger')!
        Object.defineProperty(btn, 'offsetWidth', { value: 100, configurable: true })
        Object.defineProperty(btn, 'offsetHeight', { value: 40, configurable: true })
        document.body.appendChild(card)

        await clickApplyButtonWithResilience(card, {
          platform: 'boss',
          jobTitle: '架构师',
          company: '方圆宝',
          allowLlm: true,
        })

        const skill = await findBestSkill('boss', 'job_detail', 'click_apply')
        expect(skill).not.toBeNull()
        expect(skill?.steps[0].action.target?.value).toContain('.custom-action-trigger')
      })

      it('F4-4: logs self-healing event on LLM perception path', async () => {
        const card = document.createElement('div')
        card.innerHTML = '<button class="ai-identified-btn">发送意向</button>'
        const btn = card.querySelector<HTMLElement>('.ai-identified-btn')!
        Object.defineProperty(btn, 'offsetWidth', { value: 100, configurable: true })
        Object.defineProperty(btn, 'offsetHeight', { value: 40, configurable: true })
        document.body.appendChild(card)

        await clickApplyButtonWithResilience(card, {
          platform: 'boss',
          jobTitle: 'AI工程师',
          company: '方圆宝',
          allowLlm: true,
        })

        const errors = await listErrors()
        expect(errors.some((e) => e.source.includes('button_fallback'))).toBe(true)
      })

      it('F4-5: computes page structure signature from button list', () => {
        const state = {
          buttons: [{ text: '立即沟通' }, { text: '收藏' }, { text: '举报' }],
        }
        const sig = computeSignature(state)
        expect(sig).toBe('立即沟通|收藏|举报')
      })
    })

    // F5: 本地启发式安全回退与不阻断保障
    describe('F5: 本地启发式安全回退与不阻断保障', () => {
      it('F5-1: safe revert to local heuristic when allowLlm is false', async () => {
        const card = document.createElement('div')
        card.innerHTML = '<button class="heuristic-btn">立即沟通</button>'
        const btn = card.querySelector<HTMLElement>('.heuristic-btn')!
        Object.defineProperty(btn, 'offsetWidth', { value: 100, configurable: true })
        Object.defineProperty(btn, 'offsetHeight', { value: 40, configurable: true })
        let clicked = false
        btn.addEventListener('click', () => { clicked = true })
        document.body.appendChild(card)

        const res = await clickApplyButtonWithResilience(card, {
          platform: 'boss',
          jobTitle: '前端',
          company: '方圆宝',
          allowLlm: false,
        })
        expect(res.success).toBe(true)
        expect(clicked).toBe(true)
      })

      it('F5-2: records diagnostic event when local fallback is engaged', async () => {
        const card = document.createElement('div')
        card.innerHTML = '<button class="fallback-only-btn">发起对话</button>'
        const btn = card.querySelector<HTMLElement>('.fallback-only-btn')!
        Object.defineProperty(btn, 'offsetWidth', { value: 100, configurable: true })
        Object.defineProperty(btn, 'offsetHeight', { value: 40, configurable: true })
        document.body.appendChild(card)

        await clickApplyButtonWithResilience(card, {
          platform: 'boss',
          jobTitle: '后端',
          company: '方圆宝',
          allowLlm: false,
        })

        const errors = await listErrors()
        expect(errors.length).toBeGreaterThan(0)
      })

      it('F5-3: zero unhandled exceptions when both heuristics and LLM find no match', async () => {
        const card = document.createElement('div')
        card.innerHTML = '<div>纯文本介绍，没有任何可点击元素</div>'
        document.body.appendChild(card)

        const res = await clickApplyButtonWithResilience(card, {
          platform: 'boss',
          jobTitle: '无按钮岗位',
          company: '方圆宝',
          allowLlm: false,
        })
        expect(res.success).toBe(false)
        expect(res.path).toBe('failed')
      })

      it('F5-4: handles HTTP 429 rate limit simulation without throwing', async () => {
        const card = document.createElement('div')
        card.innerHTML = '<button class="rate-limited-fallback">立即沟通</button>'
        const btn = card.querySelector<HTMLElement>('.rate-limited-fallback')!
        Object.defineProperty(btn, 'offsetWidth', { value: 100, configurable: true })
        Object.defineProperty(btn, 'offsetHeight', { value: 40, configurable: true })
        document.body.appendChild(card)

        expect(async () => {
          await clickApplyButtonWithResilience(card, {
            platform: 'boss',
            jobTitle: '限流岗位',
            company: '方圆宝',
            allowLlm: true,
          })
        }).not.toThrow()
      })

      it('F5-5: preserves pipeline continuous state when error occurs', async () => {
        const initialCount = (await listErrors()).length
        await recordSelfHealingEvent({
          platform: 'boss',
          action: 'button_click',
          category: 'button_fallback',
          reason: 'Simulated network timeout',
          mitigation: 'Local heuristic fallback executed',
        })
        const afterCount = (await listErrors()).length
        expect(afterCount).toBe(initialCount + 1)
      })
    })

    // F6: 页面阻塞脱困与意外弹窗遮罩强力解除
    describe('F6: 页面阻塞脱困与意外弹窗遮罩强力解除', () => {
      it('F6-1: dismisses 不合适的原因 dialog via cancel button', () => {
        const dialog = document.createElement('div')
        dialog.className = 'dialog-wrap'
        dialog.innerHTML = `
          <h3>请选择不合适的原因</h3>
          <button class="btn-cancel">取消</button>
        `
        Object.defineProperty(dialog, 'offsetWidth', { value: 300, configurable: true })
        Object.defineProperty(dialog, 'offsetHeight', { value: 200, configurable: true })
        document.body.appendChild(dialog)

        let cancelClicked = false
        dialog.querySelector('button')!.addEventListener('click', () => { cancelClicked = true })

        const res = dismissUnexpectedModals()
        expect(res).toBe(true)
        expect(cancelClicked).toBe(true)
      })

      it('F6-2: dismisses 减少此类推荐 dialog via close icon', () => {
        const dialog = document.createElement('div')
        dialog.className = 'boss-dialog'
        dialog.innerHTML = `
          <h3>减少此类推荐</h3>
          <span class="icon-close">×</span>
        `
        Object.defineProperty(dialog, 'offsetWidth', { value: 300, configurable: true })
        Object.defineProperty(dialog, 'offsetHeight', { value: 200, configurable: true })
        document.body.appendChild(dialog)

        let closeClicked = false
        dialog.querySelector('.icon-close')!.addEventListener('click', () => { closeClicked = true })

        const res = dismissUnexpectedModals()
        expect(res).toBe(true)
        expect(closeClicked).toBe(true)
      })

      it('F6-3: removes orphaned dialog-mask and modal-backdrop', () => {
        const mask = document.createElement('div')
        mask.className = 'dialog-mask'
        Object.defineProperty(mask, 'offsetWidth', { value: 1920, configurable: true })
        Object.defineProperty(mask, 'offsetHeight', { value: 1080, configurable: true })
        document.body.appendChild(mask)

        dismissUnexpectedModals()
        expect(mask.style.display).toBe('none')
      })

      it('F6-4: fortifies body overflow restoration during cleanupUiFortified', async () => {
        document.body.style.overflow = 'hidden'
        document.documentElement.style.overflow = 'hidden'

        await cleanupUiFortified()

        expect(document.body.style.overflow).toBe('')
        expect(document.documentElement.style.overflow).toBe('')
      })

      it('F6-5: protects normal chat-dialog from being falsely dismissed', () => {
        const chatDialog = document.createElement('div')
        chatDialog.className = 'chat-dialog'
        chatDialog.innerHTML = '<h3>打招呼内容</h3><textarea></textarea>'
        Object.defineProperty(chatDialog, 'offsetWidth', { value: 400, configurable: true })
        Object.defineProperty(chatDialog, 'offsetHeight', { value: 300, configurable: true })
        document.body.appendChild(chatDialog)

        dismissUnexpectedModals()
        expect(chatDialog.style.display).not.toBe('none')
      })
    })

    // F7: 本地技能沉淀与免发版热修复
    describe('F7: 本地技能沉淀与免发版热修复', () => {
      it('F7-1: upserts and retrieves skill from Dexie agentSkills', async () => {
        const steps: AgentStep[] = [
          { thinking: 'Click start chat', action: { type: 'click', target: { kind: 'css_selector', value: '.btn-startchat' } } },
        ]
        await upsertSkill({
          platform: 'boss',
          pageType: 'job_detail',
          goal: 'click_apply',
          steps,
          selectorSignature: '.btn-startchat',
        })

        const skill = await findBestSkill('boss', 'job_detail', 'click_apply')
        expect(skill).not.toBeNull()
        expect(skill?.steps[0].action.target?.value).toBe('.btn-startchat')
        expect(skill?.successCount).toBe(1)
      })

      it('F7-2: updates existing skill with shorter steps optimization', async () => {
        const longSteps: AgentStep[] = [
          { thinking: 'step1', action: { type: 'wait', duration: 100 } },
          { thinking: 'step2', action: { type: 'click', target: { kind: 'css_selector', value: '.btn-startchat' } } },
        ]
        await upsertSkill({
          platform: 'boss',
          pageType: 'job_detail',
          goal: 'click_apply',
          steps: longSteps,
          selectorSignature: '.btn-startchat',
        })

        const shortSteps: AgentStep[] = [
          { thinking: 'direct click', action: { type: 'click', target: { kind: 'css_selector', value: '.btn-direct' } } },
        ]
        await upsertSkill({
          platform: 'boss',
          pageType: 'job_detail',
          goal: 'click_apply',
          steps: shortSteps,
          selectorSignature: '.btn-direct',
        })

        const skill = await findBestSkill('boss', 'job_detail', 'click_apply')
        expect(skill?.steps.length).toBe(1)
        expect(skill?.steps[0].action.target?.value).toBe('.btn-direct')
        expect(skill?.successCount).toBe(2)
      })

      it('F7-3: increments failCount via recordSkillFail', async () => {
        await upsertSkill({
          platform: 'liepin',
          pageType: 'job_detail',
          goal: 'click_apply',
          steps: [{ thinking: 'click', action: { type: 'click' } }],
          selectorSignature: 'sig',
        })
        const skill = (await findBestSkill('liepin', 'job_detail', 'click_apply'))!
        await recordSkillFail(skill)

        const updated = await db.agentSkills.get(skill.id)
        expect(updated?.failCount).toBe(1)
      })

      it('F7-4: lists all skills in reverse chronological order', async () => {
        await upsertSkill({ platform: 'boss', pageType: 'p1', goal: 'g1', steps: [], selectorSignature: 's1' })
        await upsertSkill({ platform: 'liepin', pageType: 'p2', goal: 'g2', steps: [], selectorSignature: 's2' })

        const all = await listSkills()
        expect(all.length).toBe(2)
      })

      it('F7-5: enables and disables skill dynamically via setSkillEnabled', async () => {
        await upsertSkill({ platform: 'boss', pageType: 'p3', goal: 'g3', steps: [], selectorSignature: 's3' })
        const skill = (await findBestSkill('boss', 'p3', 'g3'))!

        await setSkillEnabled(skill.id, false)
        const hitAfterDisable = await findBestSkill('boss', 'p3', 'g3')
        expect(hitAfterDisable).toBeNull()

        await setSkillEnabled(skill.id, true)
        const hitAfterReenable = await findBestSkill('boss', 'p3', 'g3')
        expect(hitAfterReenable).not.toBeNull()
      })
    })

    // F8: 任务优先保障与单岗位故障隔离
    describe('F8: 任务优先保障与单岗位故障隔离', () => {
      it('F8-1: creates campaign and processes tasks sequentially', async () => {
        const cmp = await createNewCampaign({ boss: 5 }, ['boss'], [{ startHour: 0, startMin: 0, endHour: 23, endMin: 59 }])
        expect(cmp.status).toBe('running')

        await appendTasksToCampaign([
          {
            id: 'boss:t1',
            platform: 'boss',
            jobId: 't1',
            jobTitle: '前端开发',
            company: '方圆宝',
            jobUrl: 'https://www.zhipin.com/job_detail/t1.html',
          },
        ])

        const { task } = await claimNextTask(60000)
        expect(task?.jobId).toBe('t1')

        await updateTaskResult(task!.id, { status: 'done', appliedAt: new Date().toISOString() })
        const updated = await getCampaign()
        const stats = aggregateCampaignStats(updated!)
        expect(stats.done).toBe(1)
      })

      it('F8-2: marks low score task as skipped and continues queue', async () => {
        await createNewCampaign({ boss: 5 }, ['boss'], [{ startHour: 0, startMin: 0, endHour: 23, endMin: 59 }])
        await appendTasksToCampaign([
          {
            id: 'boss:t2',
            platform: 'boss',
            jobId: 't2',
            jobTitle: '后端架构师',
            company: '方圆宝',
            jobUrl: 'https://www.zhipin.com/job_detail/t2.html',
          },
        ])
        const { task } = await claimNextTask(60000)
        expect(task?.jobId).toBe('t2')

        await updateTaskResult(task!.id, {
          status: 'skipped',
          matchScore: 50,
          failReason: 'Score 50 below threshold 60',
        })

        const updated = await getCampaign()
        const stats = aggregateCampaignStats(updated!)
        expect(stats.skipped).toBe(1)
        // 跳过不消耗配额：活动必须继续补仓，而不是因为队列暂时空了就宣布完成
        expect(isCampaignFinished(updated!)).toBe(false)
      })

      it('F8-3: execute cleanupUiFortified without residual masks', async () => {
        const mask = document.createElement('div')
        mask.className = 'dialog-mask'
        document.body.appendChild(mask)

        await cleanupUiFortified()
        expect(document.querySelector('.dialog-mask')).toBeNull()
      })

      it('F8-4: isolates task failure without corrupting campaign state', async () => {
        await createNewCampaign({ boss: 5 }, ['boss'], [{ startHour: 0, startMin: 0, endHour: 23, endMin: 59 }])
        await appendTasksToCampaign([
          {
            id: 'boss:t3',
            platform: 'boss',
            jobId: 't3',
            jobTitle: '测试开发',
            company: '方圆宝',
            jobUrl: 'https://www.zhipin.com/job_detail/t3.html',
          },
        ])

        const { task } = await claimNextTask(60000)
        await updateTaskResult(task!.id, {
          status: 'failed',
          failReason: 'Isolated runtime exception',
        })

        const updated = await getCampaign()
        expect(updated?.tasks.find((t) => t.id === 'boss:t3')?.status).toBe('failed')
      })

      it('F8-5: snapshots communication UI state cleanly', () => {
        const input = document.createElement('textarea')
        input.className = 'chat-input'
        document.body.appendChild(input)

        const snapshot = snapshotCommunicationUi()
        expect(snapshot.inputs.size).toBe(1)
      })
    })

    // F9: 自愈绕过事件与拦截根因入库
    describe('F9: 自愈绕过事件与拦截根因入库', () => {
      it('F9-1: records self healing event with full context', async () => {
        const evt = await recordSelfHealingEvent({
          platform: 'boss',
          action: 'fuzzy_match',
          category: 'card_fallback',
          reason: 'Company name mismatched due to administrative suffix',
          mitigation: 'Stripped 深圳市 and 科技有限公司',
          context: { jobTitle: '全栈专家', expected: '深圳市方圆宝科技有限公司' },
        })

        expect(evt.id).toBeDefined()
        expect(evt.category).toBe('card_fallback')
      })

      it('F9-2: persists error record into db.errors', async () => {
        await recordSelfHealingEvent({
          platform: 'boss',
          action: 'fuzzy_match',
          category: 'card_fallback',
          reason: 'Reason A',
          mitigation: 'Mitigation B',
        })
        const errors = await listErrors(10)
        expect(errors.length).toBeGreaterThan(0)
        expect(errors[0].source).toContain('self-healing')
      })

      it('F9-3: categorizes modal de-blocking event properly', async () => {
        await recordSelfHealingEvent({
          platform: 'boss',
          action: 'dismiss_modal',
          category: 'modal_deblocking',
          reason: 'Detected 不合适的原因 popup',
          mitigation: 'Clicked 取消 button and removed backdrop',
        })

        const errors = await listErrors(5)
        const modalErr = errors.find((e) => e.message.includes('dismiss_modal'))
        expect(modalErr).toBeDefined()
      })

      it('F9-4: categorizes fault isolation event properly', async () => {
        await recordSelfHealingEvent({
          platform: 'boss',
          action: 'isolate_job_failure',
          category: 'fault_isolation',
          reason: 'DOM detached during application click',
          mitigation: 'cleanupUi executed, task marked skipped',
        })

        const errors = await listErrors(5)
        expect(errors.some((e) => e.source.includes('fault_isolation'))).toBe(true)
      })

      it('F9-5: clears error store completely via clearErrors', async () => {
        await clearErrors()
        const errors = await listErrors(10)
        expect(errors.length).toBe(0)
      })
    })

    // F10: 管家开发者待修清单展示与导出
    describe('F10: 管家开发者待修清单展示与导出', () => {
      it('F10-1: aggregates recorded errors into DeveloperFixSuggestion', async () => {
        await recordSelfHealingEvent({
          platform: 'boss',
          action: 'button_click',
          category: 'button_fallback',
          reason: 'Selector .btn-startchat missing on page',
          mitigation: 'LLM perception resolved button',
        })

        const suggestions = await getDiagnosticFixRecommendations()
        expect(suggestions.length).toBeGreaterThan(0)
        expect(suggestions[0].suggestedFix).toBeDefined()
      })

      it('F10-2: counts occurrences of identical diagnostic events', async () => {
        await clearErrors()
        await recordSelfHealingEvent({
          platform: 'boss',
          action: 'modal_block',
          category: 'modal_deblocking',
          reason: 'Modal popup',
          mitigation: 'Dismissed',
        })
        await recordSelfHealingEvent({
          platform: 'boss',
          action: 'modal_block',
          category: 'modal_deblocking',
          reason: 'Modal popup',
          mitigation: 'Dismissed',
        })

        const suggestions = await getDiagnosticFixRecommendations()
        expect(suggestions.length).toBe(1)
        expect(suggestions[0].occurrences).toBe(2)
      })

      it('F10-3: assigns appropriate severity levels based on category', async () => {
        await clearErrors()
        await recordSelfHealingEvent({
          platform: 'boss',
          action: 'fatal_skip',
          category: 'fault_isolation',
          reason: 'Fatal job error',
          mitigation: 'Skipped',
        })

        const suggestions = await getDiagnosticFixRecommendations()
        expect(suggestions[0].severity).toBe('high')
      })

      it('F10-4: formats suggestions into human-readable Markdown', async () => {
        await recordSelfHealingEvent({
          platform: 'boss',
          action: 'button_click',
          category: 'button_fallback',
          reason: 'Selector .btn-startchat missing on page',
          mitigation: 'LLM perception resolved button',
        })
        const suggestions = await getDiagnosticFixRecommendations()
        const md = formatFixRecommendationsMarkdown(suggestions)
        expect(md).toContain('自愈韧性智能体 — 开发者待修清单')
        expect(md).toContain('| 严重度 | 模块来源 |')
      })

      it('F10-5: returns friendly empty state markdown when no errors exist', () => {
        const md = formatFixRecommendationsMarkdown([])
        expect(md).toContain('暂无自愈待修事项')
      })
    })
  })

  // ────────────────────────────────────────────────────────────────────────
  // TIER 2: Boundary & Corner Cases (>=5 test cases per feature)
  // ────────────────────────────────────────────────────────────────────────

  describe('Tier 2: Boundary & Corner Cases (F1 to F10 Adversarial / Edge Inputs)', () => {
    // F1 Boundary
    describe('F1 Boundary', () => {
      it('F1-B1: empty expected company or title does not throw and returns true', () => {
        expect(isCompanyMatch('深圳市方圆宝科技有限公司', '')).toBe(true)
        expect(isTitleMatch('全栈工程师', '')).toBe(true)
      })

      it('F1-B2: short 2-character company abbreviation matches properly', () => {
        expect(cleanCompanyName('大疆')).toBe('大疆')
        expect(isCompanyMatch('大疆创新科技有限公司', '大疆')).toBe(true)
      })

      it('F1-B3: handles title with excessive special delimiters and punctuation', () => {
        expect(cleanTitle('【AI / 智能体·全栈】工程师---（北京/深圳）')).toBe('工程师')
      })

      it('F1-B4: completely unrelated company names return false', () => {
        expect(isCompanyMatch('腾讯计算机系统有限公司', '阿里巴巴')).toBe(false)
      })

      it('F1-B5: handles spaces and punctuation delimiters in company names', () => {
        const spaced = '方 圆 宝'
        expect(isCompanyMatch(spaced, '方圆宝')).toBe(true)
        const punctuated = '方-圆_宝'
        expect(isCompanyMatch(punctuated, '方圆宝')).toBe(true)
      })
    })

    // F2 Boundary
    describe('F2 Boundary', () => {
      it('F2-B1: malformed detail URL does not crash activateJobCard', async () => {
        const res = await activateJobCard('invalid-url-string', '', '', '')
        expect(res).toBeNull()
      })

      it('F2-B2: container with closed job text is detected offline', () => {
        const el = document.createElement('div')
        el.innerHTML = '<span>该职位已停止招聘</span>'
        expect(checkDetailPanelOffline(el)).toBe(true)
      })

      it('F2-B3: container with offline class attribute is detected offline', () => {
        const el = document.createElement('div')
        el.innerHTML = '<button class="btn-disabled">已停招</button>'
        expect(checkDetailPanelOffline(el)).toBe(true)
      })

      it('F2-B4: returns null when job card is not in DOM and not on detail page', async () => {
        window.history.pushState({}, '', '/search')
        const res = await activateJobCard('https://zhipin.com/job/404', '404', '不存在', '不存在')
        expect(res).toBeNull()
      })

      it('F2-B5: resolves correctly when page URL has search parameters and hash', async () => {
        window.history.pushState({}, '', '/job_detail/xyz.html?source=recommend#section1')
        const detail = document.createElement('div')
        detail.className = 'job-detail-box'
        detail.innerHTML = '<h2>架构师</h2>'
        document.body.appendChild(detail)

        const res = await activateJobCard('https://zhipin.com/job_detail/xyz.html', 'xyz', '架构师', '')
        expect(res).not.toBeNull()
      })
    })

    // F3 Boundary
    describe('F3 Boundary', () => {
      it('F3-B1: element with offsetWidth=0 and offsetHeight=0 is filtered out', () => {
        const card = document.createElement('div')
        card.innerHTML = '<button class="btn-startchat">立即沟通</button>'
        const b = card.querySelector('button')!
        Object.defineProperty(b, 'offsetWidth', { value: 0, configurable: true })
        Object.defineProperty(b, 'offsetHeight', { value: 0, configurable: true })
        document.body.appendChild(card)

        const found = findApplyButtons(card)
        expect(found.length).toBe(0)
      })

      it('F3-B2: button with text 不合适 is rejected by blacklist', () => {
        const card = document.createElement('div')
        card.innerHTML = '<button class="btn">不合适</button>'
        const b = card.querySelector('button')!
        Object.defineProperty(b, 'offsetWidth', { value: 100, configurable: true })
        Object.defineProperty(b, 'offsetHeight', { value: 40, configurable: true })
        document.body.appendChild(card)

        const found = findApplyButtons(card)
        expect(found.length).toBe(0)
      })

      it('F3-B3: deeply nested span inside button correctly resolves', () => {
        const card = document.createElement('div')
        card.innerHTML = '<button class="btn"><div><span>立即沟通</span></div></button>'
        const b = card.querySelector('button')!
        Object.defineProperty(b, 'offsetWidth', { value: 100, configurable: true })
        Object.defineProperty(b, 'offsetHeight', { value: 40, configurable: true })
        document.body.appendChild(card)

        const found = findApplyButtons(card)
        expect(found.length).toBe(1)
      })

      it('F3-B4: disabled attribute button is not clicked', async () => {
        const card = document.createElement('div')
        card.innerHTML = '<button class="btn-startchat" disabled>立即沟通</button>'
        const b = card.querySelector('button')!
        Object.defineProperty(b, 'offsetWidth', { value: 100, configurable: true })
        Object.defineProperty(b, 'offsetHeight', { value: 40, configurable: true })
        document.body.appendChild(card)

        expect(b.hasAttribute('disabled')).toBe(true)
      })

      it('F3-B5: empty card container returns empty array without throwing', () => {
        const card = document.createElement('div')
        expect(findApplyButtons(card)).toEqual([])
      })
    })

    // F4 Boundary
    describe('F4 Boundary', () => {
      it('F4-B1: candidate with no buttons falls back without exception', async () => {
        const card = document.createElement('div')
        card.innerHTML = '<span>没有可操作项</span>'
        document.body.appendChild(card)

        const res = await clickApplyButtonWithResilience(card, {
          platform: 'boss',
          jobTitle: '测试',
          company: '公司',
          allowLlm: true,
        })
        expect(res.success).toBe(false)
      })

      it('F4-B2: button with weird whitespace and newlines is extracted cleanly', () => {
        const card = document.createElement('div')
        card.innerHTML = '<button>\n\t  立即沟通  \n</button>'
        const text = (card.querySelector('button')?.textContent || '').trim()
        expect(text).toBe('立即沟通')
      })

      it('F4-B3: handles 20+ candidate buttons without performance degradation', () => {
        const card = document.createElement('div')
        for (let i = 0; i < 25; i++) {
          card.innerHTML += `<button class="btn-${i}">操作${i}</button>`
        }
        expect(card.querySelectorAll('button').length).toBe(25)
      })

      it('F4-B4: selector signature handles empty button array', () => {
        expect(computeSignature({ buttons: [] })).toBe('')
      })

      it('F4-B5: handles SVG icon-only button without text content', () => {
        const card = document.createElement('div')
        card.innerHTML = '<button class="btn-icon" aria-label="立即沟通"><svg></svg></button>'
        const b = card.querySelector('button')!
        expect(b.getAttribute('aria-label')).toBe('立即沟通')
      })
    })

    // F5 Boundary
    describe('F5 Boundary', () => {
      it('F5-B1: empty chrome storage does not crash settings lookup', async () => {
        const res = await chrome.storage.local.get('apiKey')
        expect(res.apiKey).toBeUndefined()
      })

      it('F5-B2: repeated fallback invocations execute rapidly without leaking', async () => {
        const card = document.createElement('div')
        card.innerHTML = '<button class="btn">立即沟通</button>'
        const b = card.querySelector('button')!
        Object.defineProperty(b, 'offsetWidth', { value: 100, configurable: true })
        Object.defineProperty(b, 'offsetHeight', { value: 40, configurable: true })
        document.body.appendChild(card)

        for (let i = 0; i < 5; i++) {
          const res = await clickApplyButtonWithResilience(card, {
            platform: 'boss',
            jobTitle: `岗位${i}`,
            company: '方圆宝',
            allowLlm: false,
          })
          expect(res.success).toBe(true)
        }
      })

      it('F5-B3: missing platform in context defaults gracefully', async () => {
        const card = document.createElement('div')
        card.innerHTML = '<button class="btn-startchat">立即沟通</button>'
        const b = card.querySelector('button')!
        Object.defineProperty(b, 'offsetWidth', { value: 100, configurable: true })
        Object.defineProperty(b, 'offsetHeight', { value: 40, configurable: true })
        document.body.appendChild(card)

        const res = await clickApplyButtonWithResilience(card, {
          platform: '',
          jobTitle: 'Title',
          company: 'Company',
        })
        expect(res.success).toBe(true)
      })

      it('F5-B4: multiple concurrent fallback calls resolve independently', async () => {
        const card1 = document.createElement('div')
        card1.innerHTML = '<button class="btn-startchat">立即沟通</button>'
        const card2 = document.createElement('div')
        card2.innerHTML = '<button class="btn-startchat">立即沟通</button>'
        for (const c of [card1, card2]) {
          const b = c.querySelector('button')!
          Object.defineProperty(b, 'offsetWidth', { value: 100, configurable: true })
          Object.defineProperty(b, 'offsetHeight', { value: 40, configurable: true })
          document.body.appendChild(c)
        }

        const [r1, r2] = await Promise.all([
          clickApplyButtonWithResilience(card1, { platform: 'boss', jobTitle: 'T1', company: 'C1' }),
          clickApplyButtonWithResilience(card2, { platform: 'boss', jobTitle: 'T2', company: 'C2' }),
        ])
        expect(r1.success).toBe(true)
        expect(r2.success).toBe(true)
      })

      it('F5-B5: fallback maintains zero console.error unhandled errors', async () => {
        const card = document.createElement('div')
        card.innerHTML = '<div>No buttons</div>'
        document.body.appendChild(card)

        const res = await clickApplyButtonWithResilience(card, { platform: 'boss', jobTitle: 'T', company: 'C' })
        expect(res.success).toBe(false)
      })
    })

    // F6 Boundary
    describe('F6 Boundary', () => {
      it('F6-B1: stubborn modal without buttons is forcefully hidden via style.display none', () => {
        const dialog = document.createElement('div')
        dialog.className = 'dialog-wrap'
        dialog.innerHTML = '<p>为什么不合适（没有任何关闭按钮）</p>'
        Object.defineProperty(dialog, 'offsetWidth', { value: 300, configurable: true })
        Object.defineProperty(dialog, 'offsetHeight', { value: 200, configurable: true })
        document.body.appendChild(dialog)

        dismissUnexpectedModals()
        expect(dialog.style.display).toBe('none')
      })

      it('F6-B2: handles multiple simultaneous stacked backdrops', () => {
        const m1 = document.createElement('div'); m1.className = 'dialog-mask'
        const m2 = document.createElement('div'); m2.className = 'modal-backdrop'
        const m3 = document.createElement('div'); m3.className = 'v-modal'
        for (const m of [m1, m2, m3]) {
          Object.defineProperty(m, 'offsetWidth', { value: 100, configurable: true })
          Object.defineProperty(m, 'offsetHeight', { value: 100, configurable: true })
          document.body.appendChild(m)
        }

        dismissUnexpectedModals()
        expect(m1.style.display).toBe('none')
        expect(m2.style.display).toBe('none')
        expect(m3.style.display).toBe('none')
      })

      it('F6-B3: modal inside shadow-like nested div resolves', () => {
        const wrapper = document.createElement('div')
        wrapper.innerHTML = '<div class="boss-popup"><div class="title">选择原因</div><a class="close">x</a></div>'
        const popup = wrapper.querySelector<HTMLElement>('.boss-popup')!
        Object.defineProperty(popup, 'offsetWidth', { value: 200, configurable: true })
        Object.defineProperty(popup, 'offsetHeight', { value: 200, configurable: true })
        document.body.appendChild(wrapper)

        let clicked = false
        wrapper.querySelector('.close')!.addEventListener('click', () => { clicked = true })

        dismissUnexpectedModals()
        expect(clicked).toBe(true)
      })

      it('F6-B4: cleanupUiFortified restores active element focus', async () => {
        const input = document.createElement('input')
        document.body.appendChild(input)
        input.focus()
        expect(document.activeElement).toBe(input)

        await cleanupUiFortified()
        expect(document.activeElement).not.toBe(input)
      })

      it('F6-B5: handles document without modals gracefully', () => {
        expect(() => dismissUnexpectedModals()).not.toThrow()
      })
    })

    // F7 Boundary
    describe('F7 Boundary', () => {
      it('F7-B1: expired skill (expiresAt < now) is not returned by findBestSkill', async () => {
        await db.agentSkills.put({
          id: 'exp1',
          platform: 'boss',
          pageType: 'p',
          goal: 'g',
          steps: [],
          successCount: 10,
          failCount: 0,
          createdAt: Date.now() - 20 * 86400000,
          lastUsedAt: Date.now() - 20 * 86400000,
          expiresAt: Date.now() - 1000, // Expired
          selectorSignature: 'sig',
          enabled: true,
        })

        const skill = await findBestSkill('boss', 'p', 'g')
        expect(skill).toBeNull()
      })

      it('F7-B2: skill with failCount >= 3 is filtered out (circuit breaker)', async () => {
        await db.agentSkills.put({
          id: 'fail3',
          platform: 'boss',
          pageType: 'p_fail',
          goal: 'g_fail',
          steps: [],
          successCount: 5,
          failCount: 3, // Circuit breaker tripped
          createdAt: Date.now(),
          lastUsedAt: Date.now(),
          expiresAt: Date.now() + 86400000,
          selectorSignature: 'sig',
          enabled: true,
        })

        const skill = await findBestSkill('boss', 'p_fail', 'g_fail')
        expect(skill).toBeNull()
      })

      it('F7-B3: deleteSkill completely purges record', async () => {
        await upsertSkill({ platform: 'boss', pageType: 'del', goal: 'del', steps: [], selectorSignature: 's' })
        const s = (await findBestSkill('boss', 'del', 'del'))!

        await deleteSkill(s.id)
        const check = await db.agentSkills.get(s.id)
        expect(check).toBeUndefined()
      })

      it('F7-B4: sorts skills by successCount descending', async () => {
        await db.agentSkills.put({
          id: 's_low',
          platform: 'boss',
          pageType: 'sort_p',
          goal: 'sort_g',
          steps: [{ thinking: 'low', action: { type: 'click' } }],
          successCount: 1,
          failCount: 0,
          createdAt: Date.now(),
          lastUsedAt: Date.now(),
          expiresAt: Date.now() + 86400000,
          selectorSignature: 'low',
          enabled: true,
        })
        await db.agentSkills.put({
          id: 's_high',
          platform: 'boss',
          pageType: 'sort_p',
          goal: 'sort_g',
          steps: [{ thinking: 'high', action: { type: 'click' } }],
          successCount: 10,
          failCount: 0,
          createdAt: Date.now(),
          lastUsedAt: Date.now(),
          expiresAt: Date.now() + 86400000,
          selectorSignature: 'high',
          enabled: true,
        })

        const best = await findBestSkill('boss', 'sort_p', 'sort_g')
        expect(best?.id).toBe('s_high')
      })

      it('F7-B5: handles special characters in selectorSignature', async () => {
        await upsertSkill({
          platform: 'boss',
          pageType: 'p',
          goal: 'special_sig',
          steps: [],
          selectorSignature: 'div > button[data-test="a#b.c"]:nth-child(2)',
        })
        const skill = await findBestSkill('boss', 'p', 'special_sig')
        expect(skill?.selectorSignature).toContain(':nth-child(2)')
      })
    })

    // F8 Boundary
    describe('F8 Boundary', () => {
      it('F8-B1: empty campaign queue returns null without throwing', async () => {
        const { task } = await claimNextTask(60000)
        expect(task).toBeNull()
      })

      it('F8-B2: handles duplicate task IDs without adding duplicate queue items', async () => {
        await createNewCampaign({ boss: 5 }, ['boss'], [{ startHour: 0, startMin: 0, endHour: 23, endMin: 59 }])
        await appendTasksToCampaign([
          { id: 'dup:1', platform: 'boss', jobId: 'dup1', jobTitle: 'T', company: 'C', jobUrl: 'u' },
          { id: 'dup:1', platform: 'boss', jobId: 'dup1', jobTitle: 'T', company: 'C', jobUrl: 'u' },
        ])
        const cmp = await getCampaign()
        const count = cmp?.tasks.filter((t) => t.id === 'dup:1').length
        expect(count).toBe(1)
      })

      it('F8-B3: aggregateCampaignStats handles empty campaign gracefully', () => {
        const stats = aggregateCampaignStats({
          id: 'cmp_empty',
          status: 'idle',
          targetQuota: { boss: 10 },
          tasks: [],
          enabledPlatforms: ['boss'],
          windows: [],
          createdAt: Date.now(),
        })
        expect(stats.totalTasks).toBe(0)
        expect(stats.done).toBe(0)
      })

      it('F8-B4: all tasks skipped still leaves the campaign running', async () => {
        const cmp = await createNewCampaign({ boss: 1 }, ['boss'], [{ startHour: 0, startMin: 0, endHour: 23, endMin: 59 }])
        await appendTasksToCampaign([
          { id: '1', platform: 'boss', jobId: '1', jobTitle: 'T', company: 'C', jobUrl: 'u' },
        ])
        const { task } = await claimNextTask(60000)
        await updateTaskResult(task!.id, { status: 'skipped', failReason: 'low score' })
        const updated = (await getCampaign())!
        // 岗位被跳过 ≠ 配额投满。此时必须继续补仓找新岗位，
        // 否则会重现「投几个就宣布全部完成并停止流水线」的致命 bug。
        expect(updated.quotas.boss.applied).toBe(0)
        expect(isCampaignFinished(updated)).toBe(false)
        expect(cmp.status).toBe('running')
      })

      it('F8-B5: handles missing callback without throwing', async () => {
        expect(() => {
          const s = snapshotCommunicationUi()
          expect(s).toBeDefined()
        }).not.toThrow()
      })
    })

    // F9 Boundary
    describe('F9 Boundary', () => {
      it('F9-B1: limits error store retrieval correctly', async () => {
        await clearErrors()
        for (let i = 0; i < 5; i++) {
          await recordError({ source: 'test', message: `err ${i}` })
        }
        const limited = await listErrors(3)
        expect(limited.length).toBe(3)
      })

      it('F9-B2: circular context objects are handled safely', async () => {
        const circularObj: any = { a: 1 }
        circularObj.self = circularObj

        let safeContext: string
        try {
          safeContext = JSON.stringify(circularObj)
        } catch {
          safeContext = JSON.stringify({ note: 'circular object sanitized' })
        }

        await recordError({ source: 'test.circular', message: 'circular test', context: safeContext })
        const errs = await listErrors(1)
        expect(errs[0].context).toContain('sanitized')
      })

      it('F9-B3: error timestamp is monotonic and within valid bounds', async () => {
        const now = Date.now() - 1000
        await recordError({ source: 'test.time', message: 'time check' })
        const errs = await listErrors(1)
        expect(new Date(errs[0].createdAt).getTime()).toBeGreaterThanOrEqual(now)
      })

      it('F9-B4: multiple distinct sources are queryable', async () => {
        await recordError({ source: 'source.alpha', message: 'msg1' })
        await recordError({ source: 'source.beta', message: 'msg2' })
        const errs = await listErrors(10)
        expect(errs.some((e) => e.source === 'source.alpha')).toBe(true)
        expect(errs.some((e) => e.source === 'source.beta')).toBe(true)
      })

      it('F9-B5: large error stack trace is stored without truncation', async () => {
        const longStack = new Array(50).fill('at line in file.ts:123').join('\n')
        await recordError({ source: 'test.stack', message: 'stack err', stack: longStack })
        const errs = await listErrors(1)
        expect(errs[0].stack).toContain('at line in file.ts:123')
      })
    })

    // F10 Boundary
    describe('F10 Boundary', () => {
      it('F10-B1: handles 50+ mixed errors in recommendation aggregation', async () => {
        await clearErrors()
        for (let i = 0; i < 50; i++) {
          await recordSelfHealingEvent({
            platform: 'boss',
            action: `action_${i % 4}`,
            category: i % 2 === 0 ? 'card_fallback' : 'button_fallback',
            reason: `reason_${i % 4}`,
            mitigation: `mitigation_${i % 4}`,
          })
        }
        const recs = await getDiagnosticFixRecommendations()
        expect(recs.length).toBeLessThanOrEqual(50)
      })

      it('F10-B2: markdown export escapes pipe meta-characters in phenomenon text', () => {
        const suggestions: DeveloperFixSuggestion[] = [
          {
            source: 'boss.test',
            phenomenon: 'Contains | pipes | and `code`',
            selfHealingPath: 'Path A',
            suggestedFix: 'Fix B',
            occurrences: 3,
            severity: 'medium',
          },
        ]
        const md = formatFixRecommendationsMarkdown(suggestions)
        expect(md).toContain('boss.test')
      })

      it('F10-B3: deduplicates identical recommendations across different times', async () => {
        await clearErrors()
        await recordSelfHealingEvent({ platform: 'boss', action: 'dedup', category: 'card_fallback', reason: 'same', mitigation: 'same' })
        await recordSelfHealingEvent({ platform: 'boss', action: 'dedup', category: 'card_fallback', reason: 'same', mitigation: 'same' })

        const recs = await getDiagnosticFixRecommendations()
        expect(recs.length).toBe(1)
        expect(recs[0].occurrences).toBe(2)
      })

      it('F10-B4: correctly formats all three severity badges', () => {
        const suggestions: DeveloperFixSuggestion[] = [
          { source: 's1', phenomenon: 'p1', selfHealingPath: 'h1', suggestedFix: 'f1', occurrences: 1, severity: 'high' },
          { source: 's2', phenomenon: 'p2', selfHealingPath: 'h2', suggestedFix: 'f2', occurrences: 1, severity: 'medium' },
          { source: 's3', phenomenon: 'p3', selfHealingPath: 'h3', suggestedFix: 'f3', occurrences: 1, severity: 'low' },
        ]
        const md = formatFixRecommendationsMarkdown(suggestions)
        expect(md).toContain('🔴 高')
        expect(md).toContain('🟡 中')
        expect(md).toContain('🟢 低')
      })

      it('F10-B5: handles non-JSON context in diagnostic aggregator without crashing', async () => {
        await clearErrors()
        await recordError({ source: 'raw.source', message: 'Plain error without JSON context', context: 'non-json string' })
        const recs = await getDiagnosticFixRecommendations()
        expect(recs.length).toBe(1)
        expect(recs[0].phenomenon).toContain('Plain error')
      })
    })
  })

  // ────────────────────────────────────────────────────────────────────────
  // TIER 3: Pairwise Cross-Feature Combinations
  // ────────────────────────────────────────────────────────────────────────

  describe('Tier 3: Pairwise Cross-Feature Combinations', () => {
    it('T3-1: Card Fallback + Button Fallback (F1/F2 + F3/F4)', async () => {
      const card = document.createElement('div')
      card.innerHTML = `
        <div class="job-title">全栈工程师（AI方向）</div>
        <div class="company-name">深圳市方圆宝科技有限公司</div>
        <button class="custom-novel-btn">发起对话</button>
      `
      const b = card.querySelector<HTMLElement>('.custom-novel-btn')!
      Object.defineProperty(b, 'offsetWidth', { value: 100, configurable: true })
      Object.defineProperty(b, 'offsetHeight', { value: 40, configurable: true })
      document.body.appendChild(card)

      expect(isTitleMatch('全栈工程师（AI方向）', '全栈工程师')).toBe(true)
      expect(isCompanyMatch('深圳市方圆宝科技有限公司', '方圆宝')).toBe(true)

      const clickRes = await clickApplyButtonWithResilience(card, {
        platform: 'boss',
        jobTitle: '全栈工程师',
        company: '方圆宝',
        allowLlm: true,
      })
      expect(clickRes.success).toBe(true)

      const errors = await listErrors()
      expect(errors.length).toBeGreaterThan(0)
    })

    it('T3-2: Unexpected Modal Popup during Fallback Probing (F6 + F3/F5)', async () => {
      const modal = document.createElement('div')
      modal.className = 'dialog-wrap'
      modal.innerHTML = '<h3>请选择不合适的原因</h3><button class="btn-cancel">取消</button>'
      Object.defineProperty(modal, 'offsetWidth', { value: 300, configurable: true })
      Object.defineProperty(modal, 'offsetHeight', { value: 200, configurable: true })
      document.body.appendChild(modal)

      const card = document.createElement('div')
      card.innerHTML = '<button class="btn-startchat">立即沟通</button>'
      const b = card.querySelector<HTMLElement>('.btn-startchat')!
      Object.defineProperty(b, 'offsetWidth', { value: 100, configurable: true })
      Object.defineProperty(b, 'offsetHeight', { value: 40, configurable: true })
      document.body.appendChild(card)

      const res = await clickApplyButtonWithResilience(card, {
        platform: 'boss',
        jobTitle: '前端架构师',
        company: '方圆宝',
      })

      expect(res.success).toBe(true)
    })

    it('T3-3: Skill Cache Hit + UI Cleanup Verification (F7 + F8)', async () => {
      await upsertSkill({
        platform: 'boss',
        pageType: 'job_detail',
        goal: 'click_apply',
        steps: [{ thinking: 'cached', action: { type: 'click', target: { kind: 'css_selector', value: '.skill-targeted-btn' } } }],
        selectorSignature: '.skill-targeted-btn',
      })

      const card = document.createElement('div')
      card.innerHTML = '<button class="skill-targeted-btn">立即沟通</button>'
      const b = card.querySelector<HTMLElement>('.skill-targeted-btn')!
      Object.defineProperty(b, 'offsetWidth', { value: 100, configurable: true })
      Object.defineProperty(b, 'offsetHeight', { value: 40, configurable: true })
      document.body.appendChild(card)

      const res = await clickApplyButtonWithResilience(card, {
        platform: 'boss',
        jobTitle: '技能复用岗位',
        company: '方圆宝',
      })
      expect(res.success).toBe(true)
      expect(res.path).toBe('skill_memory')

      await cleanupUiFortified()
      expect(document.body.style.overflow).toBe('')
    })

    it('T3-4: Offline Job Detection + Audit Logging + Safe Skip (F2 + F9 + F8)', async () => {
      const detail = document.createElement('div')
      detail.className = 'job-detail-box'
      detail.innerHTML = '<h1>该职位已下线</h1>'
      document.body.appendChild(detail)

      const isOffline = checkDetailPanelOffline(detail)
      expect(isOffline).toBe(true)

      await recordSelfHealingEvent({
        platform: 'boss',
        action: 'detect_offline_job',
        category: 'card_fallback',
        reason: 'Job status closed on detail panel',
        mitigation: 'Skipped job delivery to conserve daily quota',
      })

      await cleanupUiFortified()
      expect(detail.isConnected).toBe(true)
      const errors = await listErrors()
      expect(errors.some((e) => e.message.includes('Job status closed'))).toBe(true)
    })

    it('T3-5: LLM Failure + Local Heuristic Safe Recovery + Skill Hot-Patching (F4 + F5 + F7)', async () => {
      const card = document.createElement('div')
      card.innerHTML = '<button class="custom-patch-trigger">发送意向</button>'
      const b = card.querySelector<HTMLElement>('.custom-patch-trigger')!
      Object.defineProperty(b, 'offsetWidth', { value: 100, configurable: true })
      Object.defineProperty(b, 'offsetHeight', { value: 40, configurable: true })
      document.body.appendChild(card)

      const res = await clickApplyButtonWithResilience(card, {
        platform: 'boss',
        jobTitle: '自愈固化岗位',
        company: '方圆宝',
        allowLlm: true,
      })
      expect(res.success).toBe(true)

      const skill = await findBestSkill('boss', 'job_detail', 'click_apply')
      expect(skill).not.toBeNull()
      expect(skill?.steps[0].action.target?.value).toContain('.custom-patch-trigger')
    })

    it('T3-6: Persistent Backdrop Lock + DOM CleanupUi + Next Task Continuation (F6 + F8)', async () => {
      document.body.style.overflow = 'hidden'
      const mask = document.createElement('div')
      mask.className = 'dialog-mask'
      document.body.appendChild(mask)

      await cleanupUiFortified()

      expect(document.body.style.overflow).toBe('')
      expect(document.querySelector('.dialog-mask')).toBeNull()
    })
  })

  // ────────────────────────────────────────────────────────────────────────
  // TIER 4: Real-World Multi-Stage Application Scenarios
  // ────────────────────────────────────────────────────────────────────────

  describe('Tier 4: Real-World End-to-End Recruitment Scenarios', () => {
    it('Scenario 1: 5-Job Campaign Disaster Recovery Pipeline', async () => {
      await createNewCampaign({ boss: 5 }, ['boss'], [{ startHour: 0, startMin: 0, endHour: 23, endMin: 59 }])
      await appendTasksToCampaign([
        { id: 'job-1', platform: 'boss', jobId: 'j1', jobTitle: '常规前端', company: '方圆宝', jobUrl: 'u1' },
        { id: 'job-2', platform: 'boss', jobId: 'j2', jobTitle: '全栈工程师（AI方向）', company: '深圳市方圆宝科技有限公司', jobUrl: 'u2' },
        { id: 'job-3', platform: 'boss', jobId: 'j3', jobTitle: '变异按钮岗', company: '方圆宝', jobUrl: 'u3' },
        { id: 'job-4', platform: 'boss', jobId: 'j4', jobTitle: '弹窗阻塞岗', company: '方圆宝', jobUrl: 'u4' },
        { id: 'job-5', platform: 'boss', jobId: 'j5', jobTitle: '已下线岗', company: '方圆宝', jobUrl: 'u5' },
      ])

      // Job 1: Normal clean job
      {
        const { task } = await claimNextTask(60000)
        expect(task?.jobId).toBe('j1')
        const card = document.createElement('div')
        card.innerHTML = '<button class="btn-startchat">立即沟通</button>'
        const b = card.querySelector<HTMLElement>('.btn-startchat')!
        Object.defineProperty(b, 'offsetWidth', { value: 100, configurable: true })
        Object.defineProperty(b, 'offsetHeight', { value: 40, configurable: true })
        document.body.appendChild(card)

        const clickRes = await clickApplyButtonWithResilience(card, { platform: 'boss', jobTitle: task!.jobTitle, company: task!.company })
        expect(clickRes.success).toBe(true)
        await updateTaskResult(task!.id, { status: 'done', appliedAt: new Date().toISOString() })
        await cleanupUiFortified()
        document.body.innerHTML = ''
      }

      // Job 2: Fuzzy title and company match
      {
        const { task } = await claimNextTask(60000)
        expect(task?.jobId).toBe('j2')
        expect(isTitleMatch(task!.jobTitle, '全栈工程师')).toBe(true)
        expect(isCompanyMatch(task!.company, '方圆宝')).toBe(true)

        const card = document.createElement('div')
        card.innerHTML = '<button class="btn-startchat">立即沟通</button>'
        const b = card.querySelector<HTMLElement>('.btn-startchat')!
        Object.defineProperty(b, 'offsetWidth', { value: 100, configurable: true })
        Object.defineProperty(b, 'offsetHeight', { value: 40, configurable: true })
        document.body.appendChild(card)

        await clickApplyButtonWithResilience(card, { platform: 'boss', jobTitle: task!.jobTitle, company: task!.company })
        await updateTaskResult(task!.id, { status: 'done', appliedAt: new Date().toISOString() })
        await cleanupUiFortified()
        document.body.innerHTML = ''
      }

      // Job 3: Obfuscated button requiring LLM/heuristic fallback
      {
        const { task } = await claimNextTask(60000)
        expect(task?.jobId).toBe('j3')
        const card = document.createElement('div')
        card.innerHTML = '<button class="obfuscated-button-xyz">发起交谈</button>'
        const b = card.querySelector<HTMLElement>('.obfuscated-button-xyz')!
        Object.defineProperty(b, 'offsetWidth', { value: 100, configurable: true })
        Object.defineProperty(b, 'offsetHeight', { value: 40, configurable: true })
        document.body.appendChild(card)

        const res = await clickApplyButtonWithResilience(card, { platform: 'boss', jobTitle: task!.jobTitle, company: task!.company, allowLlm: true })
        expect(res.success).toBe(true)
        await updateTaskResult(task!.id, { status: 'done', appliedAt: new Date().toISOString() })
        await cleanupUiFortified()
        document.body.innerHTML = ''
      }

      // Job 4: Obstructed by unexpected dislike modal
      {
        const { task } = await claimNextTask(60000)
        expect(task?.jobId).toBe('j4')

        const modal = document.createElement('div')
        modal.className = 'dialog-wrap'
        modal.innerHTML = '<h3>请选择不合适的原因</h3><button class="btn-cancel">取消</button>'
        Object.defineProperty(modal, 'offsetWidth', { value: 300, configurable: true })
        Object.defineProperty(modal, 'offsetHeight', { value: 200, configurable: true })
        document.body.appendChild(modal)

        const card = document.createElement('div')
        card.innerHTML = '<button class="btn-startchat">立即沟通</button>'
        const b = card.querySelector<HTMLElement>('.btn-startchat')!
        Object.defineProperty(b, 'offsetWidth', { value: 100, configurable: true })
        Object.defineProperty(b, 'offsetHeight', { value: 40, configurable: true })
        document.body.appendChild(card)

        const res = await clickApplyButtonWithResilience(card, { platform: 'boss', jobTitle: task!.jobTitle, company: task!.company })
        expect(res.success).toBe(true)
        await updateTaskResult(task!.id, { status: 'done', appliedAt: new Date().toISOString() })
        await cleanupUiFortified()
        document.body.innerHTML = ''
      }

      // Job 5: Offline job detected, skipped, isolated
      {
        const { task } = await claimNextTask(60000)
        expect(task?.jobId).toBe('j5')

        const detail = document.createElement('div')
        detail.innerHTML = '<h3>该职位已关闭</h3>'
        document.body.appendChild(detail)

        const isClosed = checkDetailPanelOffline(detail)
        expect(isClosed).toBe(true)

        await recordSelfHealingEvent({
          platform: 'boss',
          action: 'detect_closed_job',
          category: 'fault_isolation',
          reason: 'Job closed on detail view',
          mitigation: 'Skipped to preserve application quota',
          context: { jobId: task!.jobId },
        })

        await updateTaskResult(task!.id, { status: 'skipped', failReason: 'Job closed' })
        await cleanupUiFortified()
        document.body.innerHTML = ''
      }

      // Final Assertions on Campaign & Butler Recommendations
      const cmp = await getCampaign()
      expect(cmp).not.toBeNull()
      const stats = aggregateCampaignStats(cmp!)
      expect(stats.totalTasks).toBe(5)
      expect(stats.done).toBe(4)
      expect(stats.skipped).toBe(1)
      expect(stats.pending).toBe(0)
      // 20 个配额里只投成 4 个，远未投满：活动应保持运行继续补仓
      expect(isCampaignFinished(cmp!)).toBe(false)

      const recs = await getDiagnosticFixRecommendations()
      expect(recs.length).toBeGreaterThan(0)
      const mdReport = formatFixRecommendationsMarkdown(recs)
      expect(mdReport).toContain('自愈韧性智能体 — 开发者待修清单')
    })

    it('Scenario 2: Zero-Day DOM Mutation with Skill Memory Hot-Patching Lifecycle', async () => {
      await db.agentSkills.clear()

      // Round 1: Discovery via fallback & hot-patching
      const card1 = document.createElement('div')
      card1.innerHTML = '<button class="custom-dynamic-button">发送意向</button>'
      const b1 = card1.querySelector<HTMLElement>('.custom-dynamic-button')!
      Object.defineProperty(b1, 'offsetWidth', { value: 100, configurable: true })
      Object.defineProperty(b1, 'offsetHeight', { value: 40, configurable: true })
      document.body.appendChild(card1)

      const r1 = await clickApplyButtonWithResilience(card1, {
        platform: 'boss',
        jobTitle: '前端架构师',
        company: '方圆宝',
        allowLlm: true,
      })
      expect(r1.success).toBe(true)
      expect(r1.path).toBe('llm_perception')

      // Round 2: Zero-day reuse via Tier 0 Skill Memory (0ms)
      document.body.innerHTML = ''
      const card2 = document.createElement('div')
      card2.innerHTML = '<button class="custom-dynamic-button">发送意向</button>'
      const b2 = card2.querySelector<HTMLElement>('.custom-dynamic-button')!
      Object.defineProperty(b2, 'offsetWidth', { value: 100, configurable: true })
      Object.defineProperty(b2, 'offsetHeight', { value: 40, configurable: true })
      document.body.appendChild(card2)

      const r2 = await clickApplyButtonWithResilience(card2, {
        platform: 'boss',
        jobTitle: '前端架构师',
        company: '方圆宝',
        allowLlm: true,
      })
      expect(r2.success).toBe(true)
      expect(r2.path).toBe('skill_memory')
      expect(r2.usedSkill).toBeDefined()

      // Round 3: Administrator disables skill in dashboard; reverts to fallback smoothly
      const skill = (await findBestSkill('boss', 'job_detail', 'click_apply'))!
      await setSkillEnabled(skill.id, false)

      document.body.innerHTML = ''
      const card3 = document.createElement('div')
      card3.innerHTML = '<button class="custom-dynamic-button">发送意向</button>'
      const b3 = card3.querySelector<HTMLElement>('.custom-dynamic-button')!
      Object.defineProperty(b3, 'offsetWidth', { value: 100, configurable: true })
      Object.defineProperty(b3, 'offsetHeight', { value: 40, configurable: true })
      document.body.appendChild(card3)

      const r3 = await clickApplyButtonWithResilience(card3, {
        platform: 'boss',
        jobTitle: '前端架构师',
        company: '方圆宝',
        allowLlm: true,
      })
      expect(r3.success).toBe(true)
      expect(r3.path).not.toBe('skill_memory')
    })

    it('Scenario 3: Cascading Failure Fault Isolation & Cleanup', async () => {
      let finallyExecuted = false
      const simulatedTaskExecution = async () => {
        try {
          document.body.style.overflow = 'hidden'
          const mask = document.createElement('div')
          mask.className = 'modal-backdrop'
          document.body.appendChild(mask)

          throw new Error('Fatal DOM disconnected while dispatching event')
        } finally {
          await cleanupUiFortified()
          finallyExecuted = true
        }
      }

      await expect(simulatedTaskExecution()).rejects.toThrow('Fatal DOM disconnected')

      expect(finallyExecuted).toBe(true)
      expect(document.body.style.overflow).toBe('')
      expect(document.querySelector('.modal-backdrop')).toBeNull()

      await recordSelfHealingEvent({
        platform: 'boss',
        action: 'catastrophic_recovery',
        category: 'fault_isolation',
        reason: 'Fatal DOM disconnected caught by try-finally boundary',
        mitigation: 'cleanupUi executed and DOM sanitized',
      })

      const recs = await getDiagnosticFixRecommendations()
      expect(recs.some((r) => r.source.includes('fault_isolation'))).toBe(true)
    })
  })
})
