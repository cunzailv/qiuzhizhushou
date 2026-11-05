// @vitest-environment jsdom
/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars */
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { db } from '../src/shared/db/index'
import {
  findBestSkillDirect,
  upsertSkillDirect,
  recordSkillFailDirect,
  findBestSkill,
  upsertSkill,
  recordSkillFail,
  setSkillMemoryTransportForTesting,
  RUNTIME_MESSAGE_TIMEOUT_MS,
  SKILL_TTL_MS,
} from '../src/shared/agent/skill-memory'
import type { AgentSkill, AgentStep } from '../src/shared/agent/types'

describe('Challenger 2 Empirical Verification Suite: Milestone M1 (Iteration 2)', () => {
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
  // Dimension 1: Runtime Message Timeout & Hanging Channel
  // =========================================================================
  describe('Dimension 1: Runtime Message Timeout & Hanging Channel', () => {
    it('1.1 RUNTIME_MESSAGE_TIMEOUT_MS constant is exported and equals 1500ms', () => {
      expect(RUNTIME_MESSAGE_TIMEOUT_MS).toBe(1500)
    })

    it('1.2 findBestSkill cleanly resolves to null after ~1500ms timeout when background hangs', async () => {
      setSkillMemoryTransportForTesting('messaging')

      // Mock sendMessage that never calls callback
      const mockSendMessage = vi.fn((_msg: any, _cb: any) => {})
      vi.stubGlobal('chrome', {
        runtime: {
          sendMessage: mockSendMessage,
          lastError: null,
        },
      })

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

      const startTime = Date.now()
      const result = await findBestSkill('boss', 'detail', 'click_chat')
      const elapsed = Date.now() - startTime

      expect(result).toBeNull()
      expect(elapsed).toBeGreaterThanOrEqual(1450)
      expect(elapsed).toBeLessThan(2500)
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('[SkillMemory] GET_BEST_SKILL fallback to null:'),
        expect.any(Error)
      )
    }, 5000)

    it('1.3 upsertSkill cleanly resolves to local fallback after ~1500ms timeout when background hangs', async () => {
      setSkillMemoryTransportForTesting('messaging')

      const mockSendMessage = vi.fn((_msg: any, _cb: any) => {})
      vi.stubGlobal('chrome', {
        runtime: {
          sendMessage: mockSendMessage,
          lastError: null,
        },
      })

      vi.spyOn(console, 'warn').mockImplementation(() => {})

      const startTime = Date.now()
      const result = await upsertSkill({
        platform: 'boss',
        pageType: 'detail',
        goal: 'click_chat',
        steps: [{ thinking: 'hang test', action: { type: 'click' } }],
        selectorSignature: 'sig-hang',
      })
      const elapsed = Date.now() - startTime

      expect(result).toBeDefined()
      expect(result.id).toMatch(/^fallback-/)
      expect(result.platform).toBe('boss')
      expect(result.goal).toBe('click_chat')
      expect(result.successCount).toBe(1)
      expect(result.failCount).toBe(0)
      expect(elapsed).toBeGreaterThanOrEqual(1450)
      expect(elapsed).toBeLessThan(2500)
    }, 5000)

    it('1.4 recordSkillFail cleanly resolves without error after ~1500ms timeout when background hangs', async () => {
      setSkillMemoryTransportForTesting('messaging')

      const mockSendMessage = vi.fn((_msg: any, _cb: any) => {})
      vi.stubGlobal('chrome', {
        runtime: {
          sendMessage: mockSendMessage,
          lastError: null,
        },
      })

      vi.spyOn(console, 'warn').mockImplementation(() => {})

      const fakeSkill: AgentSkill = {
        id: 'sk-hang',
        platform: 'boss',
        pageType: 'detail',
        goal: 'click_chat',
        steps: [],
        successCount: 1,
        failCount: 1,
        createdAt: Date.now(),
        lastUsedAt: Date.now(),
        expiresAt: Date.now() + 10000,
        selectorSignature: 'sig',
        enabled: true,
      }

      const startTime = Date.now()
      await expect(recordSkillFail(fakeSkill)).resolves.toBeUndefined()
      const elapsed = Date.now() - startTime
      expect(elapsed).toBeGreaterThanOrEqual(1450)
      expect(elapsed).toBeLessThan(2500)
    }, 5000)

    it('1.5 Late callback execution after timeout does NOT cause unhandled errors or corrupt state', async () => {
      setSkillMemoryTransportForTesting('messaging')

      let lateCallback: ((res: any) => void) | null = null
      const mockSendMessage = vi.fn((_msg: any, cb: any) => {
        lateCallback = cb
      })
      vi.stubGlobal('chrome', {
        runtime: {
          sendMessage: mockSendMessage,
          lastError: null,
        },
      })

      vi.spyOn(console, 'warn').mockImplementation(() => {})

      const res = await findBestSkill('boss', 'detail', 'click_chat')
      expect(res).toBeNull()

      // Late callback arrives after timeout has expired
      expect(() => {
        if (lateCallback) {
          lateCallback({ success: true, data: { id: 'late-skill', steps: [] } })
        }
      }).not.toThrow()
    }, 5000)
  })

  // =========================================================================
  // Dimension 2: Channel Failure & Resilient Degradation
  // =========================================================================
  describe('Dimension 2: Channel Failure & Resilient Degradation', () => {
    beforeEach(() => {
      setSkillMemoryTransportForTesting('messaging')
    })

    it('2.1 chrome.runtime.lastError: Receiving end does not exist', async () => {
      vi.stubGlobal('chrome', {
        runtime: {
          sendMessage: vi.fn((_msg: any, cb: any) => {
            ;(globalThis as any).chrome.runtime.lastError = {
              message: 'Could not establish connection. Receiving end does not exist.',
            }
            cb(undefined)
          }),
          lastError: null,
        },
      })

      expect(await findBestSkill('boss', 'detail', 'click_chat')).toBeNull()

      const fallback = await upsertSkill({
        platform: 'boss',
        pageType: 'detail',
        goal: 'click_chat',
        steps: [],
        selectorSignature: 'sig',
      })
      expect(fallback.id).toMatch(/^fallback-/)
    })

    it('2.2 Synchronous exception thrown during sendMessage call', async () => {
      vi.stubGlobal('chrome', {
        runtime: {
          sendMessage: vi.fn(() => {
            throw new Error('Extension context invalidated.')
          }),
          lastError: null,
        },
      })

      expect(await findBestSkill('boss', 'detail', 'click_chat')).toBeNull()

      const fallback = await upsertSkill({
        platform: 'boss',
        pageType: 'detail',
        goal: 'click_chat',
        steps: [],
        selectorSignature: 'sig',
      })
      expect(fallback.id).toMatch(/^fallback-/)

      await expect(recordSkillFail(fallback)).resolves.not.toThrow()
    })

    it('2.3 Background responds with explicit error payload', async () => {
      vi.stubGlobal('chrome', {
        runtime: {
          sendMessage: vi.fn((_msg: any, cb: any) => {
            cb({ success: false, error: 'Database transaction lock timeout' })
          }),
          lastError: null,
        },
      })

      expect(await findBestSkill('boss', 'detail', 'click_chat')).toBeNull()

      const fallback = await upsertSkill({
        platform: 'boss',
        pageType: 'detail',
        goal: 'click_chat',
        steps: [],
        selectorSignature: 'sig',
      })
      expect(fallback.id).toMatch(/^fallback-/)
    })

    it('2.4 Missing chrome runtime environment', async () => {
      vi.stubGlobal('chrome', undefined)

      expect(await findBestSkill('boss', 'detail', 'click_chat')).toBeNull()

      const fallback = await upsertSkill({
        platform: 'boss',
        pageType: 'detail',
        goal: 'click_chat',
        steps: [],
        selectorSignature: 'sig',
      })
      expect(fallback.id).toMatch(/^fallback-/)

      await expect(recordSkillFail(fallback)).resolves.not.toThrow()
    })
  })

  // =========================================================================
  // Dimension 3: Response Envelope Unpacking & Structure Validation
  // =========================================================================
  describe('Dimension 3: Response Envelope Unpacking & Structure Validation', () => {
    beforeEach(() => {
      setSkillMemoryTransportForTesting('messaging')
    })

    it('3.1 { success: true, data: undefined } returns null instead of leaking { success: true }', async () => {
      vi.stubGlobal('chrome', {
        runtime: {
          sendMessage: vi.fn((_msg: any, cb: any) => {
            cb({ success: true, data: undefined })
          }),
          lastError: null,
        },
      })

      const skill = await findBestSkill('boss', 'detail', 'click_chat')
      expect(skill).toBeNull()
    })

    it('3.2 { success: true } with missing data property returns null', async () => {
      vi.stubGlobal('chrome', {
        runtime: {
          sendMessage: vi.fn((_msg: any, cb: any) => {
            cb({ success: true })
          }),
          lastError: null,
        },
      })

      const skill = await findBestSkill('boss', 'detail', 'click_chat')
      expect(skill).toBeNull()
    })

    it('3.3 { success: true, data: null } returns null', async () => {
      vi.stubGlobal('chrome', {
        runtime: {
          sendMessage: vi.fn((_msg: any, cb: any) => {
            cb({ success: true, data: null })
          }),
          lastError: null,
        },
      })

      const skill = await findBestSkill('boss', 'detail', 'click_chat')
      expect(skill).toBeNull()
    })

    it('3.4 Malformed payload: data is a primitive or object missing id or steps', async () => {
      const malformedResponses = [
        { success: true, data: 'string_not_skill' },
        { success: true, data: 12345 },
        { success: true, data: {} },
        { success: true, data: { id: 'missing_steps' } },
        { success: true, data: { steps: [] } },
        { success: true, data: { id: 'not_array_steps', steps: 'invalid' } },
      ]

      for (const resp of malformedResponses) {
        vi.stubGlobal('chrome', {
          runtime: {
            sendMessage: vi.fn((_msg: any, cb: any) => {
              cb(resp)
            }),
            lastError: null,
          },
        })

        const skill = await findBestSkill('boss', 'detail', 'click_chat')
        expect(skill).toBeNull()
      }
    })

    it('3.5 Valid envelope: { success: true, data: AgentSkill } correctly unpacks and returns the skill', async () => {
      const validSkill: AgentSkill = {
        id: 'skill-valid-envelope',
        platform: 'boss',
        pageType: 'detail',
        goal: 'click_chat',
        steps: [{ thinking: 'valid step', action: { type: 'click' } }],
        successCount: 10,
        failCount: 0,
        createdAt: Date.now(),
        lastUsedAt: Date.now(),
        expiresAt: Date.now() + SKILL_TTL_MS,
        selectorSignature: 'sig',
        enabled: true,
      }

      vi.stubGlobal('chrome', {
        runtime: {
          sendMessage: vi.fn((_msg: any, cb: any) => {
            cb({ success: true, data: validSkill })
          }),
          lastError: null,
        },
      })

      const skill = await findBestSkill('boss', 'detail', 'click_chat')
      expect(skill).not.toBeNull()
      expect(skill?.id).toBe('skill-valid-envelope')
      expect(skill?.steps).toHaveLength(1)
    })
  })

  // =========================================================================
  // Dimension 4: Falsy & Malformed Parameters Defense
  // =========================================================================
  describe('Dimension 4: Falsy & Malformed Parameters Defense', () => {
    it('4.1 findBestSkillDirect with falsy platform or goal returns null without throwing DataError', async () => {
      expect(await findBestSkillDirect(null as any, 'detail', 'click_chat')).toBeNull()
      expect(await findBestSkillDirect(undefined as any, 'detail', 'click_chat')).toBeNull()
      expect(await findBestSkillDirect('', 'detail', 'click_chat')).toBeNull()
      expect(await findBestSkillDirect('boss', 'detail', null as any)).toBeNull()
      expect(await findBestSkillDirect('boss', 'detail', undefined as any)).toBeNull()
      expect(await findBestSkillDirect('boss', 'detail', '')).toBeNull()
      expect(await findBestSkillDirect(null as any, null as any, null as any)).toBeNull()
    })

    it('4.2 findBestSkillDirect with falsy pageType smoothly falls back to Tier 2 loose index', async () => {
      const now = Date.now()
      await db.agentSkills.put({
        id: 'loose-fallback-skill',
        platform: 'boss',
        pageType: 'search_results',
        goal: 'click_chat',
        steps: [{ thinking: 'loose step', action: { type: 'click' } }],
        successCount: 5,
        failCount: 0,
        createdAt: now,
        lastUsedAt: now,
        expiresAt: now + SKILL_TTL_MS,
        selectorSignature: 'sig-loose',
        enabled: true,
      })

      // When pageType is empty string, null, or undefined, it should bypass Tier 1 and match Tier 2
      const resEmpty = await findBestSkillDirect('boss', '', 'click_chat')
      expect(resEmpty).not.toBeNull()
      expect(resEmpty?.id).toBe('loose-fallback-skill')

      const resNull = await findBestSkillDirect('boss', null as any, 'click_chat')
      expect(resNull).not.toBeNull()
      expect(resNull?.id).toBe('loose-fallback-skill')

      const resUndefined = await findBestSkillDirect('boss', undefined as any, 'click_chat')
      expect(resUndefined).not.toBeNull()
      expect(resUndefined?.id).toBe('loose-fallback-skill')
    })

    it('4.3 findBestSkill wrapper with falsy platform or goal returns null immediately', async () => {
      setSkillMemoryTransportForTesting('messaging')
      const mockSendMessage = vi.fn()
      vi.stubGlobal('chrome', {
        runtime: { sendMessage: mockSendMessage, lastError: null },
      })

      // Should return null without even calling sendMessage
      expect(await findBestSkill('', 'detail', 'click_chat')).toBeNull()
      expect(await findBestSkill(null as any, 'detail', 'click_chat')).toBeNull()
      expect(await findBestSkill('boss', 'detail', '')).toBeNull()
      expect(await findBestSkill('boss', 'detail', null as any)).toBeNull()
      expect(mockSendMessage).not.toHaveBeenCalled()
    })

    it('4.4 upsertSkillDirect strictly rejects when platform or goal is missing', async () => {
      await expect(
        upsertSkillDirect({
          platform: '',
          pageType: 'detail',
          goal: 'click_chat',
          steps: [],
          selectorSignature: 'sig',
        })
      ).rejects.toThrow('upsertSkillDirect: platform and goal are required')

      await expect(
        upsertSkillDirect({
          platform: 'boss',
          pageType: 'detail',
          goal: '',
          steps: [],
          selectorSignature: 'sig',
        })
      ).rejects.toThrow('upsertSkillDirect: platform and goal are required')

      await expect(
        upsertSkillDirect({} as any)
      ).rejects.toThrow('upsertSkillDirect: platform and goal are required')
    })

    it('4.4.1 upsertSkillDirect normalizes undefined pageType to empty string and saves without DataError', async () => {
      // 验证当调用方未传 pageType 时，upsertSkillDirect 自动规整为 ''，防御 Dexie DataError
      const skill = await upsertSkillDirect({
        platform: 'boss',
        pageType: undefined as any,
        goal: 'click_chat',
        steps: [{ thinking: 'normalized-step', action: { type: 'click' } }],
        selectorSignature: 'sig-norm-1',
      })

      expect(skill).toBeDefined()
      expect(skill.pageType).toBe('')

      // 验证可通过 Tier 2 宽松复合索引检索发现
      const retrieved = await findBestSkillDirect('boss', undefined as any, 'click_chat')
      expect(retrieved).not.toBeNull()
      expect(retrieved?.id).toBe(skill.id)
    })

    it('4.5 recordSkillFail & recordSkillFailDirect handle null/malformed skill gracefully', async () => {
      // Direct
      await expect(recordSkillFailDirect(null as any)).resolves.toBeUndefined()
      await expect(recordSkillFailDirect(undefined as any)).resolves.toBeUndefined()
      await expect(recordSkillFailDirect({} as any)).resolves.toBeUndefined()
      await expect(recordSkillFailDirect({ id: 'non-existent' } as any)).resolves.toBeUndefined()

      // High-level
      await expect(recordSkillFail(null as any)).resolves.toBeUndefined()
      await expect(recordSkillFail(undefined as any)).resolves.toBeUndefined()
      await expect(recordSkillFail({} as any)).resolves.toBeUndefined()
    })
  })

  // =========================================================================
  // Dimension 5: Concurrency, Deduplication & Atomic Quarantine Recovery
  // =========================================================================
  describe('Dimension 5: Concurrency, Deduplication & Atomic Quarantine Recovery', () => {
    it('5.1 Concurrent upserts do not create duplicate records in agentSkills', async () => {
      const promises = Array.from({ length: 15 }, (_, i) =>
        upsertSkillDirect({
          platform: 'boss',
          pageType: 'detail',
          goal: 'click_chat',
          steps: [{ thinking: `step-${i}`, action: { type: 'click' } }],
          selectorSignature: `sig-${i}`,
        })
      )

      await Promise.all(promises)

      const records = await db.agentSkills
        .where('[platform+pageType+goal]')
        .equals(['boss', 'detail', 'click_chat'])
        .toArray()

      expect(records).toHaveLength(1)
      expect(records[0].successCount).toBe(15)
      expect(records[0].failCount).toBe(0)
    })

    it('5.2 Concurrent recordSkillFail calls atomically increment failCount without race loss', async () => {
      const skill = await upsertSkillDirect({
        platform: 'boss',
        pageType: 'detail',
        goal: 'click_chat',
        steps: [{ thinking: 'step', action: { type: 'click' } }],
        selectorSignature: 'sig',
      })

      // Execute 8 concurrent failures
      await Promise.all(
        Array.from({ length: 8 }, () => recordSkillFailDirect(skill))
      )

      const updated = await db.agentSkills.get(skill.id)
      expect(updated?.failCount).toBe(8)
    })

    it('5.3 Quarantined skill (failCount >= 3) can be recovered via upsertSkill', async () => {
      const skill = await upsertSkillDirect({
        platform: 'boss',
        pageType: 'detail',
        goal: 'click_chat',
        steps: [{ thinking: 'bad step', action: { type: 'click' } }],
        selectorSignature: 'bad-sig',
      })

      // Fail 3 times to quarantine
      await recordSkillFailDirect(skill)
      await recordSkillFailDirect(skill)
      await recordSkillFailDirect(skill)

      const quarantined = await findBestSkillDirect('boss', 'detail', 'click_chat')
      expect(quarantined).toBeNull()

      // Heal via upsert with remediationNotes
      const healed = await upsertSkillDirect({
        platform: 'boss',
        pageType: 'detail',
        goal: 'click_chat',
        steps: [{ thinking: 'remediated step', action: { type: 'click' } }],
        selectorSignature: 'good-sig',
        remediationNotes: 'Fixed dynamic selector change',
        patchSource: 'llm',
      })

      expect(healed.failCount).toBe(0)
      expect(healed.steps[0].thinking).toBe('remediated step')

      const available = await findBestSkillDirect('boss', 'detail', 'click_chat')
      expect(available).not.toBeNull()
      expect(available?.id).toBe(skill.id)
      expect(available?.failCount).toBe(0)
    })
  })
})
