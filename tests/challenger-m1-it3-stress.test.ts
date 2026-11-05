// @vitest-environment jsdom
/* eslint-disable @typescript-eslint/no-explicit-any */
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { db } from '../src/shared/db/index'
import {
  buildSelectorFingerprint,
  findBestSkillDirect,
  upsertSkillDirect,
  recordSkillFailDirect,
  findBestSkill,
  upsertSkill,
  recordSkillFail,
  setSkillMemoryTransportForTesting,
} from '../src/shared/agent/skill-memory'
import type { AgentSkill, AgentStep } from '../src/shared/agent/types'

describe('Challenger 1 Milestone M1 (Iteration 3) Empirical Stress Suite', () => {
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
  })

  // =========================================================================
  // Dimension 1: Heavy Concurrency Races, Ghost Record De-duplication & Atomic Counts
  // =========================================================================
  describe('Dimension 1: Heavy Concurrency Races & Atomic Operations', () => {
    it('1.1 Extreme Concurrency: 100 simultaneous upserts against exact same key produce exactly 1 authoritative record with successCount = 100', async () => {
      const step: AgentStep = { thinking: 'stress-concurrency-100', action: { type: 'click' } }
      const concurrency = 100

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
      expect(results).toHaveLength(100)

      // Query database directly
      const allMatching = await db.agentSkills
        .where('[platform+pageType+goal]')
        .equals(['boss', 'search', 'click_chat'])
        .toArray()

      // Exactly 1 authoritative record must exist
      expect(allMatching).toHaveLength(1)
      const record = allMatching[0]
      expect(record.platform).toBe('boss')
      expect(record.pageType).toBe('search')
      expect(record.goal).toBe('click_chat')
      expect(record.successCount).toBe(100)
      expect(record.failCount).toBe(0)
    })

    it('1.2 Pre-seeded Duplicate Ghost Records Elimination: cleans up stale ghosts and retains the authoritative record', async () => {
      const now = Date.now()
      // Artificially inject 5 ghost duplicate records with varying successCounts
      const ghostRecords: AgentSkill[] = [
        {
          id: 'ghost-1',
          platform: 'boss',
          pageType: 'search',
          goal: 'click_chat',
          steps: [{ thinking: 'ghost 1', action: { type: 'click' } }],
          successCount: 3,
          failCount: 0,
          createdAt: now - 5000,
          lastUsedAt: now - 5000,
          expiresAt: now + 100000,
          selectorSignature: 'sig-ghost-1',
          enabled: true,
          patchSource: 'heuristic',
        },
        {
          id: 'ghost-authoritative',
          platform: 'boss',
          pageType: 'search',
          goal: 'click_chat',
          steps: [{ thinking: 'authoritative ghost', action: { type: 'click' } }],
          successCount: 15, // highest successCount
          failCount: 0,
          createdAt: now - 1000,
          lastUsedAt: now - 1000,
          expiresAt: now + 100000,
          selectorSignature: 'sig-ghost-top',
          enabled: true,
          patchSource: 'heuristic',
        },
        {
          id: 'ghost-2',
          platform: 'boss',
          pageType: 'search',
          goal: 'click_chat',
          steps: [{ thinking: 'ghost 2', action: { type: 'click' } }],
          successCount: 7,
          failCount: 0,
          createdAt: now - 3000,
          lastUsedAt: now - 3000,
          expiresAt: now + 100000,
          selectorSignature: 'sig-ghost-2',
          enabled: true,
          patchSource: 'heuristic',
        },
        {
          id: 'ghost-3',
          platform: 'boss',
          pageType: 'search',
          goal: 'click_chat',
          steps: [{ thinking: 'ghost 3', action: { type: 'click' } }],
          successCount: 1,
          failCount: 0,
          createdAt: now - 9000,
          lastUsedAt: now - 9000,
          expiresAt: now + 100000,
          selectorSignature: 'sig-ghost-3',
          enabled: true,
          patchSource: 'heuristic',
        },
        {
          id: 'ghost-4',
          platform: 'boss',
          pageType: 'search',
          goal: 'click_chat',
          steps: [{ thinking: 'ghost 4', action: { type: 'click' } }],
          successCount: 15,
          failCount: 0,
          createdAt: now - 4000,
          lastUsedAt: now - 2000, // older than authoritative
          selectorSignature: 'sig-ghost-4',
          enabled: true,
          patchSource: 'heuristic',
        },
      ]

      await db.agentSkills.bulkAdd(ghostRecords)

      const preCheck = await db.agentSkills
        .where('[platform+pageType+goal]')
        .equals(['boss', 'search', 'click_chat'])
        .toArray()
      expect(preCheck).toHaveLength(5)

      // Now run upsertSkillDirect
      const updated = await upsertSkillDirect({
        platform: 'boss',
        pageType: 'search',
        goal: 'click_chat',
        steps: [{ thinking: 'new step', action: { type: 'click' } }],
        selectorSignature: 'sig-new',
        patchSource: 'llm',
      })

      expect(updated.id).toBe('ghost-authoritative')
      expect(updated.successCount).toBe(16) // 15 + 1

      // Verify that all 4 ghost records were deleted
      const postCheck = await db.agentSkills
        .where('[platform+pageType+goal]')
        .equals(['boss', 'search', 'click_chat'])
        .toArray()
      expect(postCheck).toHaveLength(1)
      expect(postCheck[0].id).toBe('ghost-authoritative')

      // Check deleted IDs are truly gone
      const deletedCheck = await db.agentSkills.bulkGet(['ghost-1', 'ghost-2', 'ghost-3', 'ghost-4'])
      expect(deletedCheck.filter(Boolean)).toHaveLength(0)
    })

    it('1.3 Atomic Failure Counting: 50 concurrent recordSkillFailDirect calls increment failCount to exactly 50 without lost updates', async () => {
      const initial = await upsertSkillDirect({
        platform: 'boss',
        pageType: 'search',
        goal: 'click_chat',
        steps: [{ thinking: 'initial', action: { type: 'click' } }],
        selectorSignature: 'sig-fail-test',
      })

      expect(initial.failCount).toBe(0)

      const concurrency = 50
      const failPromises = Array.from({ length: concurrency }).map(() =>
        recordSkillFailDirect(initial)
      )

      await Promise.all(failPromises)

      const skillInDb = await db.agentSkills.get(initial.id)
      expect(skillInDb).toBeDefined()
      expect(skillInDb?.failCount).toBe(50)
    })

    it('1.4 Concurrent Mixed Operations Storm: 60 interleaved upserts, fails, and queries execute without deadlock or inconsistency', async () => {
      const operations: Promise<any>[] = []

      for (let i = 0; i < 20; i++) {
        // Upsert stream A
        operations.push(
          upsertSkillDirect({
            platform: 'boss',
            pageType: 'search',
            goal: 'action_a',
            steps: [{ thinking: `step-${i}`, action: { type: 'click' } }],
            selectorSignature: `sig-a-${i}`,
          })
        )
        // Upsert stream B
        operations.push(
          upsertSkillDirect({
            platform: 'zhaopin',
            pageType: 'detail',
            goal: 'action_b',
            steps: [{ thinking: `step-${i}`, action: { type: 'click' } }],
            selectorSignature: `sig-b-${i}`,
          })
        )
        // Query stream
        operations.push(findBestSkillDirect('boss', 'search', 'action_a'))
      }

      const results = await Promise.all(operations)
      expect(results).toHaveLength(60)

      const skillA = await db.agentSkills
        .where('[platform+pageType+goal]')
        .equals(['boss', 'search', 'action_a'])
        .toArray()
      expect(skillA).toHaveLength(1)
      expect(skillA[0].successCount).toBe(20)

      const skillB = await db.agentSkills
        .where('[platform+pageType+goal]')
        .equals(['zhaopin', 'detail', 'action_b'])
        .toArray()
      expect(skillB).toHaveLength(1)
      expect(skillB[0].successCount).toBe(20)
    })

    it('1.5 Quarantine and Recovery: skill quarantined at failCount >= 3 is hidden from findBestSkill, and healed upon remediation upsert', async () => {
      const skill = await upsertSkillDirect({
        platform: 'boss',
        pageType: 'recommend',
        goal: 'click_chat',
        steps: [{ thinking: 'quarantine test', action: { type: 'click' } }],
        selectorSignature: 'sig-quarantine',
      })

      // Fail 3 times
      await recordSkillFailDirect(skill)
      await recordSkillFailDirect(skill)
      await recordSkillFailDirect(skill)

      // Verified quarantined
      const quarantined = await findBestSkillDirect('boss', 'recommend', 'click_chat')
      expect(quarantined).toBeNull()

      // Remediate with remediationNotes
      const healed = await upsertSkillDirect({
        platform: 'boss',
        pageType: 'recommend',
        goal: 'click_chat',
        steps: [{ thinking: 'healed step', action: { type: 'click' } }],
        selectorSignature: 'sig-quarantine-healed',
        remediationNotes: 'Fixed dynamic selector mismatch',
        patchSource: 'llm',
      })

      expect(healed.id).toBe(skill.id)
      expect(healed.failCount).toBe(0)
      expect(healed.remediationNotes).toBe('Fixed dynamic selector mismatch')

      // Verified un-quarantined and discoverable
      const retrieved = await findBestSkillDirect('boss', 'recommend', 'click_chat')
      expect(retrieved).not.toBeNull()
      expect(retrieved?.id).toBe(skill.id)
      expect(retrieved?.failCount).toBe(0)
    })
  })

  // =========================================================================
  // Dimension 2: Noise Filter Regexes (Hashes vs Semantic UI Vocabulary)
  // =========================================================================
  describe('Dimension 2: Noise Filter Regexes Stress & DOM Selector Fingerprinting', () => {
    it('2.1 Hashes (_9xa3, _3xk8, b3kz, gzkd, ___btn_hash, and others) are 100% pruned from element fingerprints', () => {
      document.body.innerHTML = `
        <div class="container _9xa3">
          <div class="row _3xk8">
            <button class="chat-btn _9xa3 _3xk8 b3kz gzkd ___btn_hash Button__btn___9xa3 css-12345 sc-abcdef" ka="chat-action">
              立即沟通
            </button>
          </div>
        </div>
      `
      const btn = document.querySelector('button')!
      const fp = buildSelectorFingerprint(btn)

      expect(fp).toBeTruthy()
      expect(fp).not.toContain('_9xa3')
      expect(fp).not.toContain('_3xk8')
      expect(fp).not.toContain('b3kz')
      expect(fp).not.toContain('gzkd')
      expect(fp).not.toContain('___btn_hash')
      expect(fp).not.toContain('Button__btn___9xa3')
      expect(fp).not.toContain('css-12345')
      expect(fp).not.toContain('sc-abcdef')

      const found = document.querySelector(fp)
      expect(found).toBe(btn)
    })

    it('2.2 Standard English UI words (badge, title, label, status, detail, resume, salary) are 100% preserved', () => {
      // Test individual element with standard semantic UI classes
      const words = ['badge', 'title', 'label', 'status', 'detail', 'resume', 'salary']
      for (const word of words) {
        document.body.innerHTML = `
          <div class="wrapper">
            <span class="${word}">Content for ${word}</span>
          </div>
        `
        const span = document.querySelector('span')!
        const fp = buildSelectorFingerprint(span)

        expect(fp).toContain(word)
        const found = document.querySelector(fp)
        expect(found).toBe(span)
      }
    })

    it('2.3 Complex composite element with mixed noise hashes and semantic UI classes isolates semantic classes cleanly', () => {
      document.body.innerHTML = `
        <div class="job-card _9xa3 b3kz">
          <div class="job-card__header _3xk8">
            <h3 class="title salary _9xa3">前端高级工程师</h3>
            <span class="badge status gzkd">急聘</span>
          </div>
          <div class="job-card__body ___btn_hash">
            <p class="detail resume b3kz">5-10年经验 | 本科</p>
            <button class="chat-btn label ___btn_hash _9xa3" data-testid="chat-trigger">
              沟通
            </button>
          </div>
        </div>
      `
      const btn = document.querySelector('button')!
      const fp = buildSelectorFingerprint(btn)

      expect(fp).toBeTruthy()
      expect(fp).not.toContain('_9xa3')
      expect(fp).not.toContain('_3xk8')
      expect(fp).not.toContain('b3kz')
      expect(fp).not.toContain('gzkd')
      expect(fp).not.toContain('___btn_hash')

      const found = document.querySelector(fp)
      expect(found).toBe(btn)
    })

    it('2.4 Pure noise hash elements degrade safely to tag or DOM hierarchy without invalid syntax', () => {
      document.body.innerHTML = `
        <section class="_9xa3">
          <div class="_3xk8">
            <button class="_9xa3 _3xk8 b3kz gzkd ___btn_hash">无语义纯hash按钮</button>
          </div>
        </section>
      `
      const btn = document.querySelector('button')!
      const fp = buildSelectorFingerprint(btn)

      expect(fp).toBeTruthy()
      // Must not produce invalid class selectors like "button." or trailing dot
      expect(fp).not.toMatch(/\.\s*$/)
      expect(fp).not.toContain('button.')
      expect(fp).not.toContain('_9xa3')
      expect(fp).not.toContain('_3xk8')
      expect(fp).not.toContain('b3kz')
      expect(fp).not.toContain('gzkd')
      expect(fp).not.toContain('___btn_hash')

      const found = document.querySelector(fp)
      expect(found).toBe(btn)
    })
  })

  // =========================================================================
  // Dimension 3: Parameter Normalization (pageType: undefined & Boundary Values)
  // =========================================================================
  describe('Dimension 3: Parameter Normalization & Defense Against DataError', () => {
    it('3.1 upsertSkillDirect with pageType: undefined normalizes to "" and does not throw Dexie DataError', async () => {
      const skill = await upsertSkillDirect({
        platform: 'boss',
        pageType: undefined,
        goal: 'click_chat',
        steps: [{ thinking: 'undefined pageType step', action: { type: 'click' } }],
        selectorSignature: 'sig-norm-direct',
      })

      expect(skill).toBeDefined()
      expect(skill.pageType).toBe('')
      expect(skill.platform).toBe('boss')
      expect(skill.goal).toBe('click_chat')

      // Verify in DB directly
      const raw = await db.agentSkills.get(skill.id)
      expect(raw).toBeDefined()
      expect(raw?.pageType).toBe('')

      // Tier 1 with '' or Tier 2 lookup
      const retrievedLoose = await findBestSkillDirect('boss', undefined as any, 'click_chat')
      expect(retrievedLoose).not.toBeNull()
      expect(retrievedLoose?.id).toBe(skill.id)
    })

    it('3.2 upsertSkill in content script simulation with pageType: undefined sends normalized pageType = ""', async () => {
      setSkillMemoryTransportForTesting('messaging')

      let sentPayload: any = null
      vi.stubGlobal('chrome', {
        runtime: {
          sendMessage: vi.fn((msg: any, cb: any) => {
            sentPayload = msg.payload
            cb({
              success: true,
              data: {
                id: 'skill-mock-1',
                ...msg.payload,
                successCount: 1,
                failCount: 0,
                createdAt: Date.now(),
                lastUsedAt: Date.now(),
                expiresAt: Date.now() + 100000,
                enabled: true,
              },
            })
          }),
          lastError: null,
        },
      })

      const skill = await upsertSkill({
        platform: 'boss',
        pageType: undefined,
        goal: 'click_chat',
        steps: [{ thinking: 'step', action: { type: 'click' } }],
        selectorSignature: 'sig-norm-cs',
      })

      expect(sentPayload).toBeDefined()
      expect(sentPayload.pageType).toBe('')
      expect(skill).toBeDefined()
      expect(skill.pageType).toBe('')
    })

    it('3.3 findBestSkillDirect with undefined or null parameters safely returns null without throwing DataError', async () => {
      // Missing platform or goal
      const r1 = await findBestSkillDirect('', 'detail', 'click_chat')
      expect(r1).toBeNull()

      const r2 = await findBestSkillDirect('boss', 'detail', '')
      expect(r2).toBeNull()

      const r3 = await findBestSkillDirect(null as any, 'detail', 'click_chat')
      expect(r3).toBeNull()

      const r4 = await findBestSkillDirect('boss', 'detail', null as any)
      expect(r4).toBeNull()

      // undefined pageType with valid platform and goal returns null when empty
      const r5 = await findBestSkillDirect('boss', undefined as any, 'non_existent_goal')
      expect(r5).toBeNull()
    })

    it('3.4 Repeated upsertSkillDirect with alternating undefined and empty pageType updates the same record', async () => {
      const first = await upsertSkillDirect({
        platform: 'boss',
        pageType: undefined,
        goal: 'test_toggle',
        steps: [{ thinking: 'first', action: { type: 'click' } }],
        selectorSignature: 'sig-1',
      })
      expect(first.successCount).toBe(1)
      expect(first.pageType).toBe('')

      const second = await upsertSkillDirect({
        platform: 'boss',
        pageType: '',
        goal: 'test_toggle',
        steps: [{ thinking: 'second', action: { type: 'click' } }],
        selectorSignature: 'sig-2',
      })
      expect(second.id).toBe(first.id)
      expect(second.successCount).toBe(2)
      expect(second.pageType).toBe('')

      const third = await upsertSkillDirect({
        platform: 'boss',
        pageType: undefined,
        goal: 'test_toggle',
        steps: [{ thinking: 'third', action: { type: 'click' } }],
        selectorSignature: 'sig-3',
      })
      expect(third.id).toBe(first.id)
      expect(third.successCount).toBe(3)

      const all = await db.agentSkills
        .where('[platform+pageType+goal]')
        .equals(['boss', '', 'test_toggle'])
        .toArray()
      expect(all).toHaveLength(1)
    })
  })
})
