// @vitest-environment jsdom
/* eslint-disable @typescript-eslint/no-explicit-any */
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { db } from '../src/shared/db/index'
import {
  findBestSkillDirect,
  upsertSkillDirect,
  recordSkillFailDirect,
  buildSelectorFingerprint,
  setSkillMemoryTransportForTesting,
} from '../src/shared/agent/skill-memory'
import type { AgentStep } from '../src/shared/agent/types'

describe('Challenger M1 Iteration 3 Deep Empirical Stress Harness', () => {
  beforeEach(async () => {
    setSkillMemoryTransportForTesting('direct')
    await db.open()
    await db.agentSkills.clear()
    document.body.innerHTML = ''
  })

  afterEach(async () => {
    setSkillMemoryTransportForTesting(null)
    await db.agentSkills.clear()
    document.body.innerHTML = ''
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  // =========================================================================
  // Focus Area 1: Concurrency & Atomic Transactions
  // =========================================================================
  describe('Focus Area 1: Concurrency & Atomic Transactions', () => {
    it('1.1 100 simultaneous concurrent writes to upsertSkillDirect with identical key deduplicates to exactly 1 record with successCount=100', async () => {
      const concurrency = 100
      const step: AgentStep = { thinking: '100 concurrency test', action: { type: 'click' } }

      const promises = Array.from({ length: concurrency }).map((_, i) =>
        upsertSkillDirect({
          platform: 'boss',
          pageType: 'search',
          goal: 'click_chat',
          steps: [step],
          selectorSignature: `sig-concurrency-${i}`,
          patchSource: 'heuristic',
        })
      )

      const results = await Promise.all(promises)
      expect(results).toHaveLength(concurrency)

      // Query database directly
      const matching = await db.agentSkills
        .where('[platform+pageType+goal]')
        .equals(['boss', 'search', 'click_chat'])
        .toArray()

      // Exact single authoritative record
      expect(matching).toHaveLength(1)
      const record = matching[0]
      expect(record.platform).toBe('boss')
      expect(record.pageType).toBe('search')
      expect(record.goal).toBe('click_chat')
      expect(record.successCount).toBe(concurrency)
      expect(record.failCount).toBe(0)
    })

    it('1.2 High-volume mixed burst: 50 upserts + 50 fails + 50 queries simultaneously with zero aborts or unhandled rejections', async () => {
      // First seed a base skill
      const initial = await upsertSkillDirect({
        platform: 'boss',
        pageType: 'search',
        goal: 'burst_target',
        steps: [{ thinking: 'seed', action: { type: 'click' } }],
        selectorSignature: 'sig-burst',
      })

      const tasks: Promise<any>[] = []

      // 50 concurrent upserts on the same skill
      for (let i = 0; i < 50; i++) {
        tasks.push(
          upsertSkillDirect({
            platform: 'boss',
            pageType: 'search',
            goal: 'burst_target',
            steps: [{ thinking: `step-${i}`, action: { type: 'click' } }],
            selectorSignature: `sig-burst-${i}`,
          })
        )
      }

      // 50 concurrent fails
      for (let i = 0; i < 50; i++) {
        tasks.push(recordSkillFailDirect(initial))
      }

      // 50 concurrent queries
      for (let i = 0; i < 50; i++) {
        tasks.push(findBestSkillDirect('boss', 'search', 'burst_target'))
      }

      await expect(Promise.all(tasks)).resolves.not.toThrow()

      const records = await db.agentSkills
        .where('[platform+pageType+goal]')
        .equals(['boss', 'search', 'burst_target'])
        .toArray()

      expect(records).toHaveLength(1)
      expect(records[0].id).toBe(initial.id)
    })

    it('1.3 Concurrent multi-key write isolation: 10 distinct goals x 10 concurrent writes', async () => {
      const distinctGoals = Array.from({ length: 10 }).map((_, i) => `goal_${i}`)
      const allWrites = distinctGoals.flatMap((g) =>
        Array.from({ length: 10 }).map((_, i) =>
          upsertSkillDirect({
            platform: 'boss',
            pageType: 'detail',
            goal: g,
            steps: [{ thinking: `${g}_step_${i}`, action: { type: 'click' } }],
            selectorSignature: `sig_${g}_${i}`,
          })
        )
      )

      await expect(Promise.all(allWrites)).resolves.not.toThrow()

      const totalInDb = await db.agentSkills.count()
      expect(totalInDb).toBe(10)

      for (const g of distinctGoals) {
        const found = await findBestSkillDirect('boss', 'detail', g)
        expect(found).not.toBeNull()
        expect(found?.goal).toBe(g)
        expect(found?.successCount).toBe(10)
      }
    })

    it('1.4 Concurrent recordSkillFailDirect stress: 20 simultaneous failures accurately increments failCount', async () => {
      const skill = await upsertSkillDirect({
        platform: 'boss',
        pageType: 'search',
        goal: 'test_fail_accumulation',
        steps: [{ thinking: 'step', action: { type: 'click' } }],
        selectorSignature: 'sig-fail-acc',
      })
      expect(skill.failCount).toBe(0)

      const fails = Array.from({ length: 20 }).map(() => recordSkillFailDirect(skill))
      await Promise.all(fails)

      const updated = await db.agentSkills.get(skill.id)
      expect(updated?.failCount).toBe(20)
    })
  })

  // =========================================================================
  // Focus Area 2: Index Stability & Undefined Parameter Defense
  // =========================================================================
  describe('Focus Area 2: Index Stability & Undefined Parameter Defense', () => {
    it('2.1 upsertSkillDirect with undefined/null pageType normalizes without Dexie DataError', async () => {
      // 1. undefined pageType
      const skill1 = await upsertSkillDirect({
        platform: 'boss',
        pageType: undefined,
        goal: 'chat_undefined_pt',
        steps: [{ thinking: 'undef pt', action: { type: 'click' } }],
        selectorSignature: 'sig-undef-pt',
      })
      expect(skill1).toBeDefined()
      expect(skill1.pageType).toBe('')

      // 2. null pageType
      const skill2 = await upsertSkillDirect({
        platform: 'boss',
        pageType: null as any,
        goal: 'chat_null_pt',
        steps: [{ thinking: 'null pt', action: { type: 'click' } }],
        selectorSignature: 'sig-null-pt',
      })
      expect(skill2).toBeDefined()
      expect(skill2.pageType).toBe('')

      // 3. empty string pageType
      const skill3 = await upsertSkillDirect({
        platform: 'boss',
        pageType: '',
        goal: 'chat_empty_pt',
        steps: [{ thinking: 'empty pt', action: { type: 'click' } }],
        selectorSignature: 'sig-empty-pt',
      })
      expect(skill3).toBeDefined()
      expect(skill3.pageType).toBe('')

      // Verify records are present in Dexie compound indexes
      const found1 = await findBestSkillDirect('boss', undefined as any, 'chat_undefined_pt')
      expect(found1?.id).toBe(skill1.id)

      const found2 = await findBestSkillDirect('boss', null as any, 'chat_null_pt')
      expect(found2?.id).toBe(skill2.id)

      const found3 = await findBestSkillDirect('boss', '', 'chat_empty_pt')
      expect(found3?.id).toBe(skill3.id)
    })

    it('2.2 findBestSkillDirect with undefined, null, or empty arguments gracefully returns null without throwing DataError', async () => {
      // platform missing
      await expect(findBestSkillDirect(undefined as any, 'detail', 'chat')).resolves.toBeNull()
      await expect(findBestSkillDirect(null as any, 'detail', 'chat')).resolves.toBeNull()
      await expect(findBestSkillDirect('', 'detail', 'chat')).resolves.toBeNull()

      // goal missing
      await expect(findBestSkillDirect('boss', 'detail', undefined as any)).resolves.toBeNull()
      await expect(findBestSkillDirect('boss', 'detail', null as any)).resolves.toBeNull()
      await expect(findBestSkillDirect('boss', 'detail', '')).resolves.toBeNull()

      // both missing
      await expect(findBestSkillDirect('', '', '')).resolves.toBeNull()
      await expect(findBestSkillDirect(undefined as any, undefined as any, undefined as any)).resolves.toBeNull()
    })

    it('2.3 upsertSkillDirect with missing platform or goal throws descriptive ValidationError, not Dexie DataError', async () => {
      await expect(
        upsertSkillDirect({
          platform: '',
          goal: 'chat',
          steps: [],
          selectorSignature: '',
        })
      ).rejects.toThrow('upsertSkillDirect: platform and goal are required')

      await expect(
        upsertSkillDirect({
          platform: 'boss',
          goal: '',
          steps: [],
          selectorSignature: '',
        })
      ).rejects.toThrow('upsertSkillDirect: platform and goal are required')

      await expect(
        upsertSkillDirect({
          platform: undefined as any,
          goal: undefined as any,
          steps: [],
          selectorSignature: '',
        })
      ).rejects.toThrow('upsertSkillDirect: platform and goal are required')
    })

    it('2.4 recordSkillFailDirect with null or missing id safely ignores without throwing', async () => {
      await expect(recordSkillFailDirect(null as any)).resolves.toBeUndefined()
      await expect(recordSkillFailDirect(undefined as any)).resolves.toBeUndefined()
      await expect(recordSkillFailDirect({ id: '' } as any)).resolves.toBeUndefined()
      await expect(recordSkillFailDirect({ id: 'non-existent-random-id-999' } as any)).resolves.toBeUndefined()
    })

    it('2.5 Cross-tier index resolution: skill saved with pageType="" is resolvable via Tier 2 loose index from any pageType', async () => {
      const skill = await upsertSkillDirect({
        platform: 'boss',
        pageType: undefined,
        goal: 'universal_action',
        steps: [{ thinking: 'universal', action: { type: 'click' } }],
        selectorSignature: 'sig-univ',
      })

      // Query from arbitrary pageTypes should fall back to Tier 2 and locate the skill
      const foundInSearch = await findBestSkillDirect('boss', 'search', 'universal_action')
      expect(foundInSearch?.id).toBe(skill.id)

      const foundInDetail = await findBestSkillDirect('boss', 'detail', 'universal_action')
      expect(foundInDetail?.id).toBe(skill.id)

      const foundInGeek = await findBestSkillDirect('boss', 'geek', 'universal_action')
      expect(foundInGeek?.id).toBe(skill.id)
    })
  })

  // =========================================================================
  // Focus Area 3: Class Noise Filtering (Zero False Positives & Negatives)
  // =========================================================================
  describe('Focus Area 3: Class Noise Filtering (Zero False Positives & Negatives)', () => {
    // Dynamic hashes, framework junk, and atomic utilities that MUST be filtered out
    const ADVERSARIAL_NOISY_HASHES = [
      // 1. Underline-prefixed hashes & CSS modules
      '_9xa3',
      '_3xk8',
      '_abc12',
      '_1h5y',
      '_z7k2',
      '_m4n9p',
      // 2. Short 3-6 char alphanumeric hashes
      'b3kz',
      '9xa3',
      'a8f2',
      'x7k9p',
      '1a2b3c',
      '4k9m1',
      'h2j8k',
      'z9q1w',
      // 3. 4-6 char consonant-only random hashes
      'gzkd',
      'bckz',
      'xkzp',
      'qwxz',
      'zxcvb',
      'bcdfgh',
      'jkpqr',
      // 4. 7+ char alphanumeric hashes
      'ab12cd34ef',
      'x9y8z7w6',
      'k3j2h1g9',
      'a1b2c3d4e5f6',
      // 5. 8+ char hex hashes
      '0123456789abcdef',
      'deadbeef0123',
      'c0ffee1234',
      // 6. CSS Module compound hashes
      'Button__btn___9xa3',
      'JobCard__title___3xk8',
      'Header__nav___abc12',
      '_button_9xa3',
      '___x8k2___',
      // 7. Tailwind & atomic utility classes
      'flex',
      'grid',
      'block',
      'inline',
      'hidden',
      'relative',
      'absolute',
      'flex-col',
      'grid-cols-2',
      'items-center',
      'justify-between',
      'p-4',
      'px-2',
      'py-1',
      'm-0',
      'mt-6',
      'w-full',
      'h-screen',
      'w-12',
      'h-12',
      'text-sm',
      'text-red-500',
      'bg-blue-500',
      'bg-white',
      'border-gray-200',
      'rounded-lg',
      'shadow-md',
      'gap-4',
      'z-50',
      'cursor-pointer',
      'hover:bg-blue-600',
      'focus:outline-none',
      'space-x-2',
      // 8. Framework generated classes
      'css-1h8fa',
      'css-xyz123',
      'sc-bdVaJa',
      'jsx-12345',
      'svelte-1a2b3c',
    ]

    // Semantic UI words that MUST BE PRESERVED (Zero False Positives)
    const CRITICAL_SEMANTIC_CLASSES = [
      // Common UI components & nouns
      'badge',
      'title',
      'label',
      'status',
      'detail',
      'resume',
      'salary',
      'switch',
      'toggle',
      'drawer',
      'banner',
      'notice',
      'header',
      'footer',
      'avatar',
      'tag',
      'divider',
      'content',
      'wrapper',
      'container',
      'card',
      'item',
      'list',
      'tabs',
      'table',
      'column',
      'row',
      'modal',
      'dialog',
      'popup',
      'panel',
      'input',
      'form',
      'checkbox',
      'radio',
      'select',
      'dropdown',
      'tooltip',
      'popover',
      'alert',
      'progress',
      'spinner',
      'slider',
      'menu',
      'nav',
      'pagination',
      'link',
      'icon',
      'image',
      'video',
      'chat',
      'message',
      'search',
      'filter',
      'sort',
      'company',
      'location',
      'experience',
      'education',
      'degree',
      'description',
      'requirement',
      'benefit',
      'address',
      'phone',
      'email',
      // Core action & state words
      'btn',
      'button',
      'startchat',
      'apply',
      'submit',
      'sure',
      'confirm',
      'primary',
      'action',
      'target',
      'success',
      'cancel',
      'close',
      'agree',
      'active',
      'selected',
      'disabled',
      'checked',
      'expanded',
      'collapsed',
      // Numbered semantic classes protected by regex negative lookahead
      'btn1',
      'col2',
      'row3',
      'tab4',
      'step1',
      // BEM & hyphenated semantic classes
      'job-card',
      'job-title',
      'job-card__title',
      'company-name',
      'chat-btn',
      'startchat-btn',
      'btn-primary',
      'btn-submit',
      'btn-apply',
      'apply-button',
      'contact-hr',
      'geek-item',
      'recommend-card',
      'search-job-result',
      'job-list-container',
      'dialog-footer-btn',
      'agree-policy-checkbox',
    ]

    it('3.1 Every noisy hash is rejected when building selector fingerprint (Zero False Negatives)', () => {
      for (const noisyClass of ADVERSARIAL_NOISY_HASHES) {
        document.body.innerHTML = `
          <div class="test-container">
            <button class="${noisyClass}">Click Me</button>
          </div>
        `
        const btn = document.querySelector('button')!
        const fp = buildSelectorFingerprint(btn)
        
        // Fingerprint must NOT use the noisy class
        const escaped = noisyClass.replace(/:/g, '\\:')
        expect(fp).not.toContain(`.${escaped}`)
        expect(fp).not.toContain(`.${noisyClass}`)
      }
    })

    it('3.2 Every critical semantic UI class is preserved and utilized in selector fingerprint (Zero False Positives)', () => {
      const failedSemanticClasses: string[] = []

      for (const semanticClass of CRITICAL_SEMANTIC_CLASSES) {
        document.body.innerHTML = `
          <div class="page-container">
            <button class="${semanticClass}">ActionButton</button>
          </div>
        `
        const btn = document.querySelector('button')!
        const fp = buildSelectorFingerprint(btn)

        // The fingerprint MUST include this semantic class
        if (!fp.includes(semanticClass)) {
          failedSemanticClasses.push(semanticClass)
        }
      }

      expect(failedSemanticClasses).toEqual([])
    })

    it('3.3 Mixed class element: noisy hashes pruned while co-existing semantic classes are retained', () => {
      document.body.innerHTML = `
        <div class="job-list-container">
          <button class="flex items-center p-2 text-sm bg-blue-500 _9xa3 b3kz gzkd Button__btn___9xa3 btn-primary startchat-btn">
            立即沟通
          </button>
        </div>
      `
      const btn = document.querySelector('button')!
      const fp = buildSelectorFingerprint(btn)

      // Noisy hashes must NOT appear
      expect(fp).not.toContain('_9xa3')
      expect(fp).not.toContain('b3kz')
      expect(fp).not.toContain('gzkd')
      expect(fp).not.toContain('Button__btn___9xa3')
      expect(fp).not.toContain('p-2')
      expect(fp).not.toContain('flex')
      expect(fp).not.toContain('bg-blue-500')

      // Semantic classes MUST appear
      const hasSemanticClass = fp.includes('startchat-btn') || fp.includes('btn-primary')
      expect(hasSemanticClass).toBe(true)

      // Fingerprint must cleanly locate the exact button
      const matched = document.querySelector(fp)
      expect(matched).toBe(btn)
    })
  })
})
