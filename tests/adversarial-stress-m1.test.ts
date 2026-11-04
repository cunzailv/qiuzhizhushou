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
  computeSignature,
  setSkillMemoryTransportForTesting,
  SKILL_TTL_MS,
} from '../src/shared/agent/skill-memory'
import type { AgentSkill, AgentStep, SelectorFingerprint, SkillPatchSource } from '../src/shared/agent/types'

describe('Milestone M1 Adversarial Stress Harness (Empirical Challenger)', () => {
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

  // ═════════════════════════════════════════════════════════════════
  // 1. Concurrency & Race Condition Stress
  // ═════════════════════════════════════════════════════════════════
  describe('1. Concurrency & Race Condition Stress', () => {
    it('1.1 Rapid concurrent writes to upsertSkillDirect with identical [platform+pageType+goal]', async () => {
      const step: AgentStep = { thinking: '并发写入测试', action: { type: 'click' } }
      const concurrency = 10

      // 同时发起 10 个针对完全相同 key 的并发 upsert
      const promises = Array.from({ length: concurrency }).map((_, i) =>
        upsertSkillDirect({
          platform: 'boss',
          pageType: 'search',
          goal: 'click_chat',
          steps: [step],
          selectorSignature: `sig-${i}`,
          patchSource: 'heuristic',
        })
      )

      const results = await Promise.all(promises)
      expect(results).toHaveLength(concurrency)

      // 检查数据库中是否存在重复记录或脏数据
      const allMatching = await db.agentSkills
        .where('[platform+pageType+goal]')
        .equals(['boss', 'search', 'click_chat'])
        .toArray()

      console.log(`[Adversarial 1.1] Count of records after 10 concurrent upserts: ${allMatching.length}`)
      
      // 检验：系统能否在并发写入下保持稳定且不出错
      for (const res of results) {
        expect(res).toBeDefined()
        expect(res.platform).toBe('boss')
        expect(res.goal).toBe('click_chat')
      }

      // 验证 findBestSkillDirect 能够正常读取而不抛出异常
      const best = await findBestSkillDirect('boss', 'search', 'click_chat')
      expect(best).not.toBeNull()
      expect(best?.platform).toBe('boss')
    })

    it('1.2 Rapid concurrent writes with overlapping fingerprints across different pageTypes', async () => {
      const pageTypes = ['search', 'detail', 'recommend', 'geek']
      const promises = pageTypes.flatMap((pt, idx) =>
        Array.from({ length: 5 }).map((_, i) =>
          upsertSkillDirect({
            platform: 'boss',
            pageType: pt,
            goal: 'click_chat',
            steps: [{ thinking: `${pt}-${i}`, action: { type: 'click' } }],
            selectorSignature: `btn-startchat-${idx}`,
            fingerprint: {
              cssSelector: `button.btn-startchat-${idx}`,
              buttonText: '立即沟通',
              signature: `boss:${pt}:chat`,
            },
          })
        )
      )

      await expect(Promise.all(promises)).resolves.not.toThrow()

      // 检查每个 pageType 都能被正确检索
      for (const pt of pageTypes) {
        const found = await findBestSkillDirect('boss', pt, 'click_chat')
        expect(found).not.toBeNull()
        expect(found?.platform).toBe('boss')
      }

      // 宽松匹配也应能命中
      const loose = await findBestSkillDirect('boss', 'unknown_page', 'click_chat')
      expect(loose).not.toBeNull()
      expect(loose?.platform).toBe('boss')
      expect(loose?.goal).toBe('click_chat')
    })

    it('1.3 Concurrent recordSkillFail calls on the same skill: verify no unhandled rejection & failCount behavior', async () => {
      const skill = await upsertSkillDirect({
        platform: 'boss',
        pageType: 'search',
        goal: 'click_chat',
        steps: [{ thinking: '初次写入', action: { type: 'click' } }],
        selectorSignature: 'sig-fail-test',
      })
      expect(skill.failCount).toBe(0)

      // 触发 5 次并发 recordSkillFail
      const failPromises = Array.from({ length: 5 }).map(() =>
        recordSkillFailDirect(skill)
      )
      await expect(Promise.all(failPromises)).resolves.not.toThrow()

      const recordAfterFails = await db.agentSkills.get(skill.id)
      expect(recordAfterFails).toBeDefined()
      console.log(`[Adversarial 1.3] failCount after 5 concurrent recordSkillFail: ${recordAfterFails?.failCount}`)
      // 至少增加了失败计数，且未发生死锁或崩溃
      expect(recordAfterFails!.failCount).toBeGreaterThan(0)
    })

    it('1.4 Interleaved concurrent upsertSkill and recordSkillFail execution', async () => {
      const initial = await upsertSkillDirect({
        platform: 'boss',
        pageType: 'detail',
        goal: 'apply',
        steps: [{ thinking: 'init', action: { type: 'click' } }],
        selectorSignature: 'sig-apply',
      })

      const operations = [
        recordSkillFailDirect(initial),
        upsertSkillDirect({
          platform: 'boss',
          pageType: 'detail',
          goal: 'apply',
          steps: [{ thinking: 'step-new', action: { type: 'click' } }],
          selectorSignature: 'sig-apply-2',
        }),
        recordSkillFailDirect(initial),
        upsertSkillDirect({
          platform: 'boss',
          pageType: 'detail',
          goal: 'apply',
          steps: [{ thinking: 'step-new2', action: { type: 'click' } }],
          selectorSignature: 'sig-apply-3',
        }),
      ]

      await expect(Promise.all(operations)).resolves.not.toThrow()
      const retrieved = await findBestSkillDirect('boss', 'detail', 'apply')
      expect(retrieved).not.toBeNull()
    })

    it('1.5 50 concurrent mixed operations simultaneously: ensure zero unhandled rejections', async () => {
      const tasks: Promise<unknown>[] = []
      for (let i = 0; i < 50; i++) {
        if (i % 3 === 0) {
          tasks.push(
            upsertSkillDirect({
              platform: 'boss',
              pageType: `page-${i % 5}`,
              goal: `goal-${i % 3}`,
              steps: [{ thinking: `step-${i}`, action: { type: 'click' } }],
              selectorSignature: `sig-${i}`,
            })
          )
        } else if (i % 3 === 1) {
          tasks.push(findBestSkillDirect('boss', `page-${i % 5}`, `goal-${i % 3}`))
        } else {
          tasks.push(
            recordSkillFailDirect({
              id: `non-existent-${i}`,
              platform: 'boss',
              pageType: 'any',
              goal: 'any',
              steps: [],
              successCount: 0,
              failCount: 0,
              createdAt: Date.now(),
              lastUsedAt: Date.now(),
              expiresAt: Date.now() + 1000,
              selectorSignature: '',
              enabled: true,
            })
          )
        }
      }

      await expect(Promise.all(tasks)).resolves.not.toThrow()
    })

    it('1.6 Blast radius of concurrent upserts: ghost duplicate records break quarantine isolation', async () => {
      // 5 concurrent upserts for the same skill key
      await Promise.all(
        Array.from({ length: 5 }).map((_, i) =>
          upsertSkillDirect({
            platform: 'boss',
            pageType: 'search',
            goal: 'click_chat',
            steps: [{ thinking: `step-${i}`, action: { type: 'click' } }],
            selectorSignature: `sig-${i}`,
          })
        )
      )

      // Check how many records were created in Dexie
      const records = await db.agentSkills
        .where('[platform+pageType+goal]')
        .equals(['boss', 'search', 'click_chat'])
        .toArray()
      console.log(`[Adversarial 1.6] Total records in db: ${records.length}`)

      // Retrieve best skill
      const firstSkill = await findBestSkillDirect('boss', 'search', 'click_chat')
      expect(firstSkill).not.toBeNull()

      // Fail it 3 times to quarantine
      await recordSkillFailDirect(firstSkill!)
      await recordSkillFailDirect(firstSkill!)
      await recordSkillFailDirect(firstSkill!)

      // Should be quarantined (return null)
      const afterQuarantine = await findBestSkillDirect('boss', 'search', 'click_chat')
      console.log('[Adversarial 1.6] afterQuarantine returned skill ID:', afterQuarantine?.id, 'failCount:', afterQuarantine?.failCount)

      // An isolated goal MUST return null. If it returns another duplicate with failCount=0, quarantine is bypassed!
      expect(afterQuarantine).toBeNull()
    })

    it('1.7 Race condition in recordSkillFail: 3 concurrent failures must result in failCount >= 3', async () => {
      const skill = await upsertSkillDirect({
        platform: 'boss',
        pageType: 'search',
        goal: 'click_chat',
        steps: [{ thinking: 'step', action: { type: 'click' } }],
        selectorSignature: 'sig-race',
      })

      // 3 concurrent failures
      await Promise.all([
        recordSkillFailDirect(skill),
        recordSkillFailDirect(skill),
        recordSkillFailDirect(skill),
      ])

      const updated = await db.agentSkills.get(skill.id)
      console.log(`[Adversarial 1.7] failCount after 3 concurrent recordSkillFail: ${updated?.failCount}`)

      // Expected: failCount should be 3 (quarantine threshold reached)
      // Reality: due to non-atomic read-then-write race condition, failCount is 1!
      expect(updated?.failCount).toBe(3)
    })

    it('1.8 Extreme concurrency stress: 10 concurrent upserts followed by 10 concurrent queries', async () => {
      const step: AgentStep = { thinking: 'stress', action: { type: 'click' } }
      await expect(
        Promise.all(
          Array.from({ length: 10 }).map((_, i) =>
            upsertSkillDirect({
              platform: 'boss',
              pageType: 'search',
              goal: 'concurrent_goal',
              steps: [step],
              selectorSignature: `sig-${i}`,
            })
          )
        )
      ).resolves.not.toThrow()

      const queries = Array.from({ length: 10 }).map(() =>
        findBestSkillDirect('boss', 'search', 'concurrent_goal')
      )
      const queryResults = await Promise.all(queries)
      for (const res of queryResults) {
        expect(res).not.toBeNull()
        expect(res?.platform).toBe('boss')
      }
    })
  })

  // ═════════════════════════════════════════════════════════════════
  // 2. Quarantine Boundary & Recovery Dynamics
  // ═════════════════════════════════════════════════════════════════
  describe('2. Quarantine Boundary & Recovery Dynamics', () => {
    it('2.1 Exact threshold verification: failCount 0 -> 1 -> 2 (healthy) -> 3 (isolated) -> 4 (isolated)', async () => {
      const created = await upsertSkillDirect({
        platform: 'boss',
        pageType: 'search',
        goal: 'click_chat',
        steps: [{ thinking: 'action', action: { type: 'click' } }],
        selectorSignature: 'sig-chat',
      })

      // failCount = 0: healthy
      let found = await findBestSkillDirect('boss', 'search', 'click_chat')
      expect(found).not.toBeNull()
      expect(found?.failCount).toBe(0)

      // failCount = 1: healthy
      await recordSkillFailDirect(created)
      found = await findBestSkillDirect('boss', 'search', 'click_chat')
      expect(found).not.toBeNull()
      expect(found?.failCount).toBe(1)

      // failCount = 2: healthy
      await recordSkillFailDirect(created)
      found = await findBestSkillDirect('boss', 'search', 'click_chat')
      expect(found).not.toBeNull()
      expect(found?.failCount).toBe(2)

      // failCount = 3: QUARANTINED (isolated)
      await recordSkillFailDirect(created)
      found = await findBestSkillDirect('boss', 'search', 'click_chat')
      expect(found).toBeNull()

      // Also isolated in Tier 2 loose fallback
      const looseFound = await findBestSkillDirect('boss', 'other_page', 'click_chat')
      expect(looseFound).toBeNull()

      // failCount = 4: remains isolated
      await recordSkillFailDirect(created)
      found = await findBestSkillDirect('boss', 'search', 'click_chat')
      expect(found).toBeNull()
    })

    it('2.2 Reactivation on upsertSkill: resets failCount to 0 and restores immediate eligibility', async () => {
      const skill = await upsertSkillDirect({
        platform: 'boss',
        pageType: 'search',
        goal: 'click_chat',
        steps: [{ thinking: 'bad steps', action: { type: 'click' } }],
        selectorSignature: 'sig-old',
      })

      // Quarantining skill
      await recordSkillFailDirect(skill)
      await recordSkillFailDirect(skill)
      await recordSkillFailDirect(skill)
      expect(await findBestSkillDirect('boss', 'search', 'click_chat')).toBeNull()

      // Reactivation via upsertSkillDirect with newly discovered steps
      const healed = await upsertSkillDirect({
        platform: 'boss',
        pageType: 'search',
        goal: 'click_chat',
        steps: [{ thinking: 'new healed step', action: { type: 'click' } }],
        selectorSignature: 'sig-healed',
        patchSource: 'heuristic',
        remediationNotes: 'Reactivated via hot patch',
      })

      expect(healed.failCount).toBe(0)
      expect(healed.successCount).toBe(skill.successCount + 1)
      expect(healed.remediationNotes).toBe('Reactivated via hot patch')

      // Query should now succeed immediately (0ms instant recovery)
      const restored = await findBestSkillDirect('boss', 'search', 'click_chat')
      expect(restored).not.toBeNull()
      expect(restored?.failCount).toBe(0)
      expect(restored?.selectorSignature).toBe('sig-healed')
    })

    it('2.3 Multiple competing skills: quarantined champion cleanly degrades to runner-up', async () => {
      // 插入冠军技能 (successCount = 20)
      const champion = await upsertSkillDirect({
        platform: 'boss',
        pageType: 'search',
        goal: 'click_chat',
        steps: [{ thinking: 'champ step', action: { type: 'click' } }],
        selectorSignature: 'sig-champ',
      })
      // 手工将 champion 的 successCount 改为 20
      await db.agentSkills.update(champion.id, { successCount: 20 })

      // 插入亚军技能 (successCount = 5) 在同一 platform+goal 但不同 pageType 供 Tier 2 复用
      const runnerUp = await upsertSkillDirect({
        platform: 'boss',
        pageType: 'detail',
        goal: 'click_chat',
        steps: [{ thinking: 'runner step', action: { type: 'click' } }],
        selectorSignature: 'sig-runner',
      })
      await db.agentSkills.update(runnerUp.id, { successCount: 5 })

      // 跨场景查询 'recommend'：Tier 2 应选出 champion
      let selected = await findBestSkillDirect('boss', 'recommend', 'click_chat')
      expect(selected?.id).toBe(champion.id)

      // Champion 失败 3 次进入隔离
      await recordSkillFailDirect(champion)
      await recordSkillFailDirect(champion)
      await recordSkillFailDirect(champion)

      // 跨场景查询 'recommend'：Tier 2 必须平滑降级命中 runnerUp！
      selected = await findBestSkillDirect('boss', 'recommend', 'click_chat')
      expect(selected).not.toBeNull()
      expect(selected?.id).toBe(runnerUp.id)
      expect(selected?.successCount).toBe(5)

      // Runner-up 也失败 3 次
      await recordSkillFailDirect(runnerUp)
      await recordSkillFailDirect(runnerUp)
      await recordSkillFailDirect(runnerUp)

      // 此时全部隔离，应返回 null 且不抛出错误
      selected = await findBestSkillDirect('boss', 'recommend', 'click_chat')
      expect(selected).toBeNull()
    })

    it('2.4 Orthogonal isolation: enabled=false, expired, and failCount>=3', async () => {
      const now = Date.now()
      // 技能 A: expired
      await db.agentSkills.put({
        id: 'skill-expired',
        platform: 'boss',
        pageType: 'search',
        goal: 'submit',
        steps: [],
        successCount: 10,
        failCount: 0,
        createdAt: now - 20 * 86400000,
        lastUsedAt: now - 20 * 86400000,
        expiresAt: now - 1000, // expired
        selectorSignature: 'sig-expired',
        enabled: true,
      })

      // 技能 B: disabled
      await db.agentSkills.put({
        id: 'skill-disabled',
        platform: 'boss',
        pageType: 'search',
        goal: 'submit',
        steps: [],
        successCount: 10,
        failCount: 0,
        createdAt: now,
        lastUsedAt: now,
        expiresAt: now + SKILL_TTL_MS,
        selectorSignature: 'sig-disabled',
        enabled: false, // disabled
      })

      // 技能 C: quarantined
      await db.agentSkills.put({
        id: 'skill-quarantined',
        platform: 'boss',
        pageType: 'search',
        goal: 'submit',
        steps: [],
        successCount: 10,
        failCount: 3, // quarantined
        createdAt: now,
        lastUsedAt: now,
        expiresAt: now + SKILL_TTL_MS,
        selectorSignature: 'sig-quarantined',
        enabled: true,
      })

      // 全部三种不可用状态共存时，必须返回 null
      const result = await findBestSkillDirect('boss', 'search', 'submit')
      expect(result).toBeNull()

      // 启用技能 B
      await db.agentSkills.update('skill-disabled', { enabled: true })
      const enabledResult = await findBestSkillDirect('boss', 'search', 'submit')
      expect(enabledResult?.id).toBe('skill-disabled')
    })
  })

  // ═════════════════════════════════════════════════════════════════
  // 3. Edge-case Element Fingerprints & Adversarial DOM
  // ═════════════════════════════════════════════════════════════════
  describe('3. Edge-case Element Fingerprints & Adversarial DOM', () => {
    it('3.1 Deeply nested elements (50+ levels of generic divs with no classes/ids)', () => {
      let current = document.body
      for (let i = 0; i < 50; i++) {
        const div = document.createElement('div')
        current.appendChild(div)
        current = div
      }
      const targetBtn = document.createElement('button')
      targetBtn.textContent = '深层按钮'
      current.appendChild(targetBtn)

      const fingerprint = buildSelectorFingerprint(targetBtn)
      expect(fingerprint).toBeTruthy()

      // 验证生成的选择器在当前 DOM 中有效且能准确匹配 targetBtn
      const matched = document.querySelector(fingerprint)
      expect(matched).toBe(targetBtn)
    })

    it('3.2 Attributes with empty strings: data-testid="", ka="", title="", class=""', () => {
      document.body.innerHTML = `
        <div class="">
          <button data-testid="" ka="" title="" class="" aria-label="">空属性测试</button>
        </div>
      `
      const btn = document.querySelector('button')!
      const fingerprint = buildSelectorFingerprint(btn)
      expect(fingerprint).toBeTruthy()

      // 验证不应生成 [data-testid=""] 或 button. 这种非法/无意义选择器
      expect(fingerprint).not.toContain('=""')
      expect(fingerprint).not.toContain('button.')
      const matched = document.querySelector(fingerprint)
      expect(matched).toBe(btn)
    })

    it('3.3 Attributes with quotes, brackets, ampersands, and special characters', () => {
      document.body.innerHTML = `
        <div class="test-container">
          <button ka='btn"quote\\[boss\\]' aria-label='立即沟通 "Boss" (直聘) [v2.0]'>沟通</button>
        </div>
      `
      const btn = document.querySelector('button')!
      const fingerprint = buildSelectorFingerprint(btn)
      console.log('[Adversarial 3.3] fingerprint:', fingerprint)
      expect(fingerprint).toBeTruthy()

      // 关键断言：生成的选择器直接传给 document.querySelector 绝不能抛出 DOMException 语法错误
      let matched: Element | null = null
      expect(() => {
        matched = document.querySelector(fingerprint)
      }).not.toThrow()
      expect(matched).toBe(btn)
    })

    it('3.4 Attributes with newlines and whitespace: aria-label="Submit\\nApplication"', () => {
      document.body.innerHTML = `
        <div class="form-box">
          <button title="Line1\nLine2" aria-label="Submit\nNow">多行文本属性</button>
        </div>
      `
      const btn = document.querySelector('button')!
      const fingerprint = buildSelectorFingerprint(btn)
      console.log('[Adversarial 3.4] fingerprint:', fingerprint)
      expect(fingerprint).toBeTruthy()

      // 验证生成的选择器传给 document.querySelector 不报语法错误并成功定位
      let matched: Element | null = null
      expect(() => {
        matched = document.querySelector(fingerprint)
      }).not.toThrow()
      expect(matched).toBe(btn)
    })

    it('3.5 Elements with only noisy Tailwind classes and random hashes', () => {
      document.body.innerHTML = `
        <div class="p-6 m-2 flex items-center justify-between">
          <button class="flex items-center text-xs p-2 bg-red-500 hover:bg-red-600 _9xa3 b3kz css-1h8fa">
            <span>噪音类按钮</span>
          </button>
        </div>
      `
      const btn = document.querySelector('button')!
      const fingerprint = buildSelectorFingerprint(btn)
      expect(fingerprint).toBeTruthy()

      // 验证所有噪音类被完全剔除
      expect(fingerprint).not.toContain('p-2')
      expect(fingerprint).not.toContain('bg-red-500')
      expect(fingerprint).not.toContain('_9xa3')
      expect(fingerprint).not.toContain('css-1h8fa')

      // 仍能精准定位该按钮
      const matched = document.querySelector(fingerprint)
      expect(matched).toBe(btn)
    })

    it('3.6 Element ID edge cases: leading digits, dynamic IDs, colons, dots', () => {
      document.body.innerHTML = `
        <div class="wrapper">
          <button id="123-numeric-start">纯数字开头ID</button>
          <button id=":r1:">React动态ID</button>
          <button id="rc-anchor-btn">AntD动态ID</button>
          <button id="stable_submit_button">合法稳定ID</button>
        </div>
      `
      const numericBtn = document.getElementById('123-numeric-start')!
      const reactBtn = document.getElementById(':r1:')!
      const antdBtn = document.getElementById('rc-anchor-btn')!
      const stableBtn = document.getElementById('stable_submit_button')!

      // 稳定 ID 正常采用 ID 选择器
      const stableFp = buildSelectorFingerprint(stableBtn)
      expect(stableFp).toBe('#stable_submit_button')
      expect(document.querySelector(stableFp)).toBe(stableBtn)

      // 动态 React ID / AntD ID 不应被采信为唯一 ID 选择器
      const reactFp = buildSelectorFingerprint(reactBtn)
      expect(reactFp).not.toBe('#:r1:')

      const antdFp = buildSelectorFingerprint(antdBtn)
      expect(antdFp).not.toBe('#rc-anchor-btn')

      // 数字开头 ID：生成选择器必须在 querySelector 下合法并不抛异常
      const numFp = buildSelectorFingerprint(numericBtn)
      expect(() => {
        const res = document.querySelector(numFp)
        expect(res).toBe(numericBtn)
      }).not.toThrow()
    })

    it('3.7 Non-standard and SVG elements (<svg>, <path>, <custom-btn>)', () => {
      document.body.innerHTML = `
        <div class="card">
          <custom-apply-btn class="btn-custom" data-testid="custom-btn">
            <svg class="icon-chat" ka="chat-svg">
              <path d="M10 10" class="path-chat"></path>
            </svg>
          </custom-apply-btn>
        </div>
      `
      const customEl = document.querySelector('custom-apply-btn')!
      const svgEl = document.querySelector('svg')!
      const pathEl = document.querySelector('path')!

      const customFp = buildSelectorFingerprint(customEl)
      expect(document.querySelector(customFp)).toBe(customEl)

      const svgFp = buildSelectorFingerprint(svgEl)
      expect(document.querySelector(svgFp)).toBe(svgEl)

      const pathFp = buildSelectorFingerprint(pathEl)
      expect(document.querySelector(pathFp)).toBe(pathEl)
    })

    it('3.8 Disconnected elements and cross-container scope handling', () => {
      const detachedBtn = document.createElement('button')
      detachedBtn.textContent = '孤立节点'
      
      // 孤立未挂载节点不应崩溃
      const detachedFp = buildSelectorFingerprint(detachedBtn)
      expect(typeof detachedFp).toBe('string')

      // 容器与目标节点无关
      const containerA = document.createElement('div')
      const containerB = document.createElement('div')
      const btnInB = document.createElement('button')
      containerB.appendChild(btnInB)
      document.body.appendChild(containerA)
      document.body.appendChild(containerB)

      // 传入无关的 containerA 作为 scope，函数应优雅返回或兜底，不崩溃
      const fp = buildSelectorFingerprint(btnInB, containerA)
      expect(typeof fp).toBe('string')
    })
  })

  // ═════════════════════════════════════════════════════════════════
  // 4. Content Script Bridge & Resilient Fallback Stress
  // ═════════════════════════════════════════════════════════════════
  describe('4. Content Script Bridge & Resilient Fallback Stress', () => {
    it('4.1 Simulated content script environment: rapid messaging failures guarantee null/fallback without unhandled rejection', async () => {
      setSkillMemoryTransportForTesting('messaging')

      // 模拟 chrome.runtime.sendMessage 始终失败（如扩展正在重载、端口断开）
      const mockSendMessage = vi.fn((message, callback) => {
        // 设置 lastError 并返回 undefined
        if (chrome.runtime) {
          ;(chrome.runtime as any).lastError = { message: 'Extension context invalidated.' }
        }
        callback(undefined)
      })

      ;(globalThis as any).chrome = {
        runtime: {
          sendMessage: mockSendMessage,
          lastError: null,
        },
      }

      // 连续 10 次调用 findBestSkill
      for (let i = 0; i < 10; i++) {
        const skill = await findBestSkill('boss', 'detail', 'click_chat')
        // Mission-First: 绝不抛错，安全返回 null
        expect(skill).toBeNull()
      }

      // 连续 5 次调用 upsertSkill
      for (let i = 0; i < 5; i++) {
        const saved = await upsertSkill({
          platform: 'boss',
          pageType: 'detail',
          goal: 'click_chat',
          steps: [],
          selectorSignature: `sig-${i}`,
        })
        // 发生通信异常时，生成本地临时 fallback 技能对象保证流水线不崩溃
        expect(saved).toBeDefined()
        expect(saved.id).toContain('fallback-')
      }

      // 连续 5 次调用 recordSkillFail
      for (let i = 0; i < 5; i++) {
        await expect(
          recordSkillFail({
            id: 'skill-1',
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
          })
        ).resolves.not.toThrow()
      }
    })

    it('4.2 Input Defense: null/undefined/empty arguments do not cause unhandled crash', async () => {
      // 1. computeSignature with empty/malformed inputs
      expect(computeSignature({ buttons: [] })).toBe('')

      // 2. buildSelectorFingerprint with null/undefined/non-element
      expect(buildSelectorFingerprint(null as any)).toBe('')
      expect(buildSelectorFingerprint(undefined as any)).toBe('')
      expect(buildSelectorFingerprint({} as any)).toBe('')

      // 3. findBestSkillDirect with empty string pageType (should fall back to Tier 2 gracefully)
      const emptyPageResult = await findBestSkillDirect('boss', '', 'click_chat')
      expect(emptyPageResult).toBeNull()
    })
  })
})
