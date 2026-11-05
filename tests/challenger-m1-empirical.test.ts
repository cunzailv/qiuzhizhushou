// @vitest-environment jsdom
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
  RUNTIME_MESSAGE_TIMEOUT_MS,
  SKILL_TTL_MS,
} from '../src/shared/agent/skill-memory'
import type { AgentSkill, AgentStep } from '../src/shared/agent/types'

describe('Empirical Challenger Harness: Milestone M1 (Iteration 2)', () => {
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

  // ═════════════════════════════════════════════════════════════════
  // Suite A: CSS Module Noise Pruning & Obfuscation Resilience
  // ═════════════════════════════════════════════════════════════════
  describe('Suite A: CSS Module Noise Pruning & Obfuscation Resilience', () => {
    it('A.1 Explicitly prunes _9xa3, _3xk8, and b3kz from generated selector fingerprints', () => {
      document.body.innerHTML = `
        <div class="job-card-wrapper _9xa3">
          <button class="chat-btn _9xa3 _3xk8 b3kz" data-testid="apply-btn">
            立即沟通
          </button>
        </div>
      `
      const btn = document.querySelector('button')!
      const fp = buildSelectorFingerprint(btn)

      // 验证选择器生成
      expect(fp).toBeTruthy()
      expect(fp).not.toContain('_9xa3')
      expect(fp).not.toContain('_3xk8')
      expect(fp).not.toContain('b3kz')

      // 验证选择器能够正常匹配
      const found = document.querySelector(fp)
      expect(found).toBe(btn)
    })

    it('A.2 Element having ONLY noise hashes (_9xa3, _3xk8, b3kz) degrades safely to clean tag/hierarchy without invalid selectors', () => {
      document.body.innerHTML = `
        <div class="content-box">
          <button class="_9xa3 _3xk8 b3kz">纯噪音按钮</button>
        </div>
      `
      const btn = document.querySelector('button')!
      const fp = buildSelectorFingerprint(btn)

      expect(fp).toBeTruthy()
      expect(fp).not.toContain('_9xa3')
      expect(fp).not.toContain('_3xk8')
      expect(fp).not.toContain('b3kz')
      // 不能包含带点号的空类选择器如 button.
      expect(fp).not.toContain('button.')
      expect(fp).not.toMatch(/\.\s*$/)

      const matched = document.querySelector(fp)
      expect(matched).toBe(btn)
    })

    it('A.3 Parent container has noise hashes (_9xa3, _3xk8) while child has b3kz: hierarchical selectors are clean', () => {
      document.body.innerHTML = `
        <div class="_9xa3">
          <section class="_3xk8">
            <button class="b3kz">分层噪音测试</button>
          </section>
        </div>
      `
      const btn = document.querySelector('button')!
      const fp = buildSelectorFingerprint(btn)

      expect(fp).not.toContain('_9xa3')
      expect(fp).not.toContain('_3xk8')
      expect(fp).not.toContain('b3kz')

      const matched = document.querySelector(fp)
      expect(matched).toBe(btn)
    })

    it('A.4 Preserves legitimate semantic classes while dropping noise hashes in same element', () => {
      const semanticWords = ['btn', 'startchat', 'apply', 'submit', 'sure', 'confirm', 'primary']
      for (const word of semanticWords) {
        document.body.innerHTML = `
          <div class="container">
            <button class="${word} _9xa3 _3xk8 b3kz">${word} 测试</button>
          </div>
        `
        const btn = document.querySelector('button')!
        const fp = buildSelectorFingerprint(btn)

        expect(fp).toContain(word)
        expect(fp).not.toContain('_9xa3')
        expect(fp).not.toContain('_3xk8')
        expect(fp).not.toContain('b3kz')

        const matched = document.querySelector(fp)
        expect(matched).toBe(btn)
      }
    })

    it('A.5 Prunes complex CSS-in-JS, Webpack hash variations, and framework prefixes', () => {
      const noisyClasses = [
        '_abc12',
        '_1h5y',
        'a8f2',
        'x7k9p',
        '1a2b3c',
        'gzkd',
        'xkzp',
        'Button__btn___9xa3',
        'css-1h8fa',
        'sc-bdVaJa',
        'jsx-12345678',
        'svelte-xyz123',
      ]

      for (const noise of noisyClasses) {
        document.body.innerHTML = `
          <div>
            <button class="${noise} btn-target">测试 ${noise}</button>
          </div>
        `
        const btn = document.querySelector('button')!
        const fp = buildSelectorFingerprint(btn)

        expect(fp).not.toContain(noise)
        expect(fp).toContain('btn-target')
        expect(document.querySelector(fp)).toBe(btn)
      }
    })
  })

  // ═════════════════════════════════════════════════════════════════
  // Suite B: Concurrency Stress & Race Condition Verification
  // ═════════════════════════════════════════════════════════════════
  describe('Suite B: Concurrency Stress & Race Condition Verification', () => {
    it('B.1 Heavy concurrency: 100 simultaneous upserts against exact same [platform+pageType+goal] results in strictly 1 authoritative record', async () => {
      const concurrency = 100
      const promises = Array.from({ length: concurrency }).map((_, i) =>
        upsertSkillDirect({
          platform: 'boss',
          pageType: 'search',
          goal: 'heavy_concurrent_chat',
          steps: [{ thinking: `step-${i}`, action: { type: 'click' } }],
          selectorSignature: `sig-${i}`,
          patchSource: 'heuristic',
        })
      )

      const results = await Promise.all(promises)
      expect(results).toHaveLength(concurrency)

      const recordsInDb = await db.agentSkills
        .where('[platform+pageType+goal]')
        .equals(['boss', 'search', 'heavy_concurrent_chat'])
        .toArray()

      // 关键验证：绝对不能产生重复幽灵记录！
      expect(recordsInDb).toHaveLength(1)
      expect(recordsInDb[0].platform).toBe('boss')
      expect(recordsInDb[0].goal).toBe('heavy_concurrent_chat')
      // successCount 应该累加
      expect(recordsInDb[0].successCount).toBeGreaterThanOrEqual(1)

      // findBestSkillDirect 能够正常读取
      const best = await findBestSkillDirect('boss', 'search', 'heavy_concurrent_chat')
      expect(best).not.toBeNull()
      expect(best?.id).toBe(recordsInDb[0].id)
    })

    it('B.2 Atomic failure counting: 20 concurrent recordSkillFailDirect calls increment failCount accurately by exactly 20', async () => {
      const skill = await upsertSkillDirect({
        platform: 'boss',
        pageType: 'detail',
        goal: 'atomic_fail_test',
        steps: [{ thinking: 'initial', action: { type: 'click' } }],
        selectorSignature: 'sig-fail',
      })
      expect(skill.failCount).toBe(0)

      const failIterations = 20
      const failPromises = Array.from({ length: failIterations }).map(() =>
        recordSkillFailDirect(skill)
      )

      await Promise.all(failPromises)

      const afterFails = await db.agentSkills.get(skill.id)
      expect(afterFails).toBeDefined()
      // 事务原子化保障：无丢失更新，failCount 必须准确等于 20
      expect(afterFails!.failCount).toBe(failIterations)
    })

    it('B.3 Interleaved concurrent read, upsert, fail, and quarantine across multi-tenants', async () => {
      const goals = ['goal_alpha', 'goal_beta', 'goal_gamma', 'goal_delta']
      const operations: Promise<unknown>[] = []

      // 初始化 4 个 goals
      for (const g of goals) {
        operations.push(
          upsertSkillDirect({
            platform: 'boss',
            pageType: 'search',
            goal: g,
            steps: [{ thinking: `init-${g}`, action: { type: 'click' } }],
            selectorSignature: `sig-${g}`,
          })
        )
      }
      await Promise.all(operations)

      // 混合 60 个随机并发操作
      const mixedOps: Promise<unknown>[] = []
      for (let i = 0; i < 60; i++) {
        const targetGoal = goals[i % goals.length]
        if (i % 3 === 0) {
          mixedOps.push(
            upsertSkillDirect({
              platform: 'boss',
              pageType: 'search',
              goal: targetGoal,
              steps: [{ thinking: `update-${i}`, action: { type: 'click' } }],
              selectorSignature: `sig-update-${i}`,
            })
          )
        } else if (i % 3 === 1) {
          mixedOps.push(findBestSkillDirect('boss', 'search', targetGoal))
        } else {
          mixedOps.push(
            findBestSkillDirect('boss', 'search', targetGoal).then((s) => {
              if (s) return recordSkillFailDirect(s)
            })
          )
        }
      }

      await expect(Promise.all(mixedOps)).resolves.not.toThrow()

      // 验证各个 goal 在数据库中依旧保持每组恰好一条记录
      for (const g of goals) {
        const records = await db.agentSkills
          .where('[platform+pageType+goal]')
          .equals(['boss', 'search', g])
          .toArray()
        expect(records).toHaveLength(1)
      }
    })
  })

  // ═════════════════════════════════════════════════════════════════
  // Suite C: Envelope Unpacking, Timeout & Communication Resilience
  // ═════════════════════════════════════════════════════════════════
  describe('Suite C: Envelope Unpacking, Timeout & Communication Resilience', () => {
    it('C.1 Unpacks { success: true, data: undefined } and { success: true } to null without leaking envelope object', async () => {
      setSkillMemoryTransportForTesting('messaging')

      // Case 1: data is undefined
      vi.stubGlobal('chrome', {
        runtime: {
          sendMessage: vi.fn((_msg: any, callback: (res: any) => void) => {
            callback({ success: true, data: undefined })
          }),
          lastError: null,
        },
      })
      const result1 = await findBestSkill('boss', 'search', 'click_chat')
      expect(result1).toBeNull()

      // Case 2: raw envelope with only success: true
      vi.stubGlobal('chrome', {
        runtime: {
          sendMessage: vi.fn((_msg: any, callback: (res: any) => void) => {
            callback({ success: true })
          }),
          lastError: null,
        },
      })
      const result2 = await findBestSkill('boss', 'search', 'click_chat')
      expect(result2).toBeNull()

      // Case 3: data is corrupted structure (missing steps)
      vi.stubGlobal('chrome', {
        runtime: {
          sendMessage: vi.fn((_msg: any, callback: (res: any) => void) => {
            callback({ success: true, data: { id: 'fake', platform: 'boss' } })
          }),
          lastError: null,
        },
      })
      const result3 = await findBestSkill('boss', 'search', 'click_chat')
      expect(result3).toBeNull()
    })

    it('C.2 Properly enforces RUNTIME_MESSAGE_TIMEOUT_MS when background hangs indefinitely', async () => {
      setSkillMemoryTransportForTesting('messaging')
      expect(RUNTIME_MESSAGE_TIMEOUT_MS).toBe(1500)

      // 模拟 background 接收到消息但不调用 callback
      vi.stubGlobal('chrome', {
        runtime: {
          sendMessage: vi.fn((_msg: any, _callback: (res: any) => void) => {
            // Hanging channel: neither callback nor lastError
          }),
          lastError: null,
        },
      })

      const start = Date.now()
      const skill = await findBestSkill('boss', 'detail', 'click_chat')
      const elapsed = Date.now() - start

      // findBestSkill 内部应捕获 1500ms 超时异常并安全回退到 null，绝不悬挂与抛错
      expect(skill).toBeNull()
      expect(elapsed).toBeGreaterThanOrEqual(1400)
      expect(elapsed).toBeLessThan(4000)
    }, 6000)

    it('C.3 Malformed or falsy query inputs do not trigger Dexie DataError', async () => {
      // 各种非法 falsy key
      expect(await findBestSkillDirect('', 'detail', 'click_chat')).toBeNull()
      expect(await findBestSkillDirect('boss', 'detail', '')).toBeNull()
      expect(await findBestSkillDirect(null as any, 'detail', 'click_chat')).toBeNull()
      expect(await findBestSkillDirect('boss', 'detail', null as any)).toBeNull()
      expect(await findBestSkillDirect(undefined as any, 'detail', 'click_chat')).toBeNull()
      expect(await findBestSkillDirect('boss', 'detail', undefined as any)).toBeNull()

      // findBestSkill 也防御
      expect(await findBestSkill('', 'detail', 'click_chat')).toBeNull()
      expect(await findBestSkill('boss', 'detail', '')).toBeNull()

      // upsertSkillDirect 抛出明确校验异常
      await expect(
        upsertSkillDirect({
          platform: '',
          pageType: 'detail',
          goal: 'goal',
          steps: [],
          selectorSignature: '',
        })
      ).rejects.toThrow('platform and goal are required')

      // recordSkillFailDirect 传入非法入参安全忽略
      await expect(recordSkillFailDirect(null as any)).resolves.toBeUndefined()
      await expect(recordSkillFailDirect({} as any)).resolves.toBeUndefined()
    })
  })
})
