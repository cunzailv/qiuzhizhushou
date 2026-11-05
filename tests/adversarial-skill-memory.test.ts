// @vitest-environment jsdom
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
  SKILL_TTL_MS,
} from '../src/shared/agent/skill-memory'
import type { AgentSkill, AgentStep } from '../src/shared/agent/types'

describe('Adversarial Stress Test: Skill Memory & Data Integrity (Milestone M1)', () => {
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

  // ─────────────────────────────────────────────────────────────
  // 1. Strict TTL Expiration Filtering Stress Suite
  // ─────────────────────────────────────────────────────────────
  describe('1. Strict TTL Expiration Filtering', () => {
    it('1.1 单一过期技能：expiresAt 为过去时间戳时，findBestSkillDirect 严禁返回该技能', async () => {
      const now = Date.now()
      await db.agentSkills.put({
        id: 'expired-1s',
        platform: 'boss',
        pageType: 'detail',
        goal: 'click_chat',
        steps: [{ thinking: '过期测试', action: { type: 'click' } }],
        successCount: 15,
        failCount: 0,
        createdAt: now - 20000,
        lastUsedAt: now - 5000,
        expiresAt: now - 1000, // 过去 1 秒
        selectorSignature: 'sig-expired',
        enabled: true,
      })

      const result = await findBestSkillDirect('boss', 'detail', 'click_chat')
      expect(result).toBeNull()
    })

    it('1.2 边界极限值：expiresAt === now 时视为已过期（严格大于判断），必须返回 null', async () => {
      const fixedNow = 1700000000000
      vi.setSystemTime(fixedNow)

      await db.agentSkills.put({
        id: 'exact-boundary-skill',
        platform: 'boss',
        pageType: 'detail',
        goal: 'click_chat',
        steps: [{ thinking: '边界点测试', action: { type: 'click' } }],
        successCount: 5,
        failCount: 0,
        createdAt: fixedNow - 1000,
        lastUsedAt: fixedNow - 500,
        expiresAt: fixedNow, // 正好等于当前时间戳
        selectorSignature: 'sig-exact',
        enabled: true,
      })

      const result = await findBestSkillDirect('boss', 'detail', 'click_chat')
      expect(result).toBeNull()
    })

    it('1.3 边界有效值：expiresAt === now + 1ms 时属于有效技能，必须成功返回', async () => {
      const fixedNow = 1700000000000
      vi.setSystemTime(fixedNow)

      await db.agentSkills.put({
        id: 'just-valid-skill',
        platform: 'boss',
        pageType: 'detail',
        goal: 'click_chat',
        steps: [{ thinking: '微弱有效测试', action: { type: 'click' } }],
        successCount: 3,
        failCount: 0,
        createdAt: fixedNow - 1000,
        lastUsedAt: fixedNow - 500,
        expiresAt: fixedNow + 1, // 1毫秒后过期
        selectorSignature: 'sig-valid-1ms',
        enabled: true,
      })

      const result = await findBestSkillDirect('boss', 'detail', 'click_chat')
      expect(result).not.toBeNull()
      expect(result?.id).toBe('just-valid-skill')
    })

    it('1.4 高权重过期 vs 低权重有效：具有超高 successCount 但过期的技能不得压倒有效技能', async () => {
      const now = Date.now()
      await db.agentSkills.bulkPut([
        {
          id: 'dominant-but-expired',
          platform: 'boss',
          pageType: 'detail',
          goal: 'click_chat',
          steps: [{ thinking: '高频老技能', action: { type: 'click' } }],
          successCount: 9999,
          failCount: 0,
          createdAt: now - 30 * 86400000,
          lastUsedAt: now - 1000,
          expiresAt: now - 1, // 已过期 1ms
          selectorSignature: 'sig-dominant',
          enabled: true,
        },
        {
          id: 'fresh-low-weight',
          platform: 'boss',
          pageType: 'detail',
          goal: 'click_chat',
          steps: [{ thinking: '新探索单次技能', action: { type: 'click' } }],
          successCount: 1,
          failCount: 0,
          createdAt: now,
          lastUsedAt: now,
          expiresAt: now + SKILL_TTL_MS,
          selectorSignature: 'sig-fresh',
          enabled: true,
        },
      ])

      const result = await findBestSkillDirect('boss', 'detail', 'click_chat')
      expect(result).not.toBeNull()
      expect(result?.id).toBe('fresh-low-weight')
      expect(result?.successCount).toBe(1)
    })

    it('1.5 跨阶降级与 TTL 组合：Tier 1 技能全部过期时，能穿透并命中 Tier 2 有效技能', async () => {
      const now = Date.now()
      await db.agentSkills.bulkPut([
        {
          id: 'tier1-expired',
          platform: 'boss',
          pageType: 'detail', // 精确匹配 detail
          goal: 'click_chat',
          steps: [{ thinking: '详情页过期技能', action: { type: 'click' } }],
          successCount: 50,
          failCount: 0,
          createdAt: now - 20 * 86400000,
          lastUsedAt: now - 20 * 86400000,
          expiresAt: now - 100, // 过期
          selectorSignature: 'detail-expired',
          enabled: true,
        },
        {
          id: 'tier2-valid-cross-page',
          platform: 'boss',
          pageType: 'search', // 跨页面 search
          goal: 'click_chat',
          steps: [{ thinking: '搜索页跨场景可用技能', action: { type: 'click' } }],
          successCount: 5,
          failCount: 0,
          createdAt: now,
          lastUsedAt: now,
          expiresAt: now + SKILL_TTL_MS, // 有效
          selectorSignature: 'search-valid',
          enabled: true,
        },
      ])

      // 请求 detail 页面
      const result = await findBestSkillDirect('boss', 'detail', 'click_chat')
      expect(result).not.toBeNull()
      // Tier 1 虽匹配但已过期，顺利穿透降级至 Tier 2 并命中 search-valid
      expect(result?.id).toBe('tier2-valid-cross-page')
      expect(result?.pageType).toBe('search')
    })

    it('1.6 负值与 0 异常时间戳防御：expiresAt 为 0 或负数时严格过滤', async () => {
      const now = Date.now()
      await db.agentSkills.bulkPut([
        {
          id: 'zero-expires',
          platform: 'boss',
          pageType: 'detail',
          goal: 'click_chat',
          steps: [{ thinking: '0时间戳', action: { type: 'click' } }],
          successCount: 1,
          failCount: 0,
          createdAt: now,
          lastUsedAt: now,
          expiresAt: 0,
          selectorSignature: 'zero',
          enabled: true,
        },
        {
          id: 'negative-expires',
          platform: 'boss',
          pageType: 'detail',
          goal: 'click_chat',
          steps: [{ thinking: '负数时间戳', action: { type: 'click' } }],
          successCount: 1,
          failCount: 0,
          createdAt: now,
          lastUsedAt: now,
          expiresAt: -10000,
          selectorSignature: 'negative',
          enabled: true,
        },
      ])

      const result = await findBestSkillDirect('boss', 'detail', 'click_chat')
      expect(result).toBeNull()
    })

    it('1.7 模拟时间流逝（15 天后）：初始有效技能在 15 天后自动失效', async () => {
      const baseTime = 1700000000000
      vi.setSystemTime(baseTime)

      const initial = await upsertSkillDirect({
        platform: 'boss',
        pageType: 'detail',
        goal: 'click_chat',
        steps: [{ thinking: '有效动作', action: { type: 'click' } }],
        selectorSignature: 'sig',
      })
      expect(initial.expiresAt).toBe(baseTime + 14 * 86400000)

      // 验证当时能查到
      const foundAtBase = await findBestSkillDirect('boss', 'detail', 'click_chat')
      expect(foundAtBase).not.toBeNull()
      expect(foundAtBase?.id).toBe(initial.id)

      // 快进 15 天
      vi.setSystemTime(baseTime + 15 * 86400000)
      const foundAfter15Days = await findBestSkillDirect('boss', 'detail', 'click_chat')
      expect(foundAfter15Days).toBeNull()

      // 再次通过 upsertSkill 自愈更新该技能，验证其重获新生且 TTL 顺延 14 天
      const renewed = await upsertSkillDirect({
        platform: 'boss',
        pageType: 'detail',
        goal: 'click_chat',
        steps: [{ thinking: '重新热修复动作', action: { type: 'click' } }],
        selectorSignature: 'sig-renewed',
      })
      expect(renewed.id).toBe(initial.id)
      expect(renewed.expiresAt).toBe(baseTime + 15 * 86400000 + 14 * 86400000)

      const foundRenewed = await findBestSkillDirect('boss', 'detail', 'click_chat')
      expect(foundRenewed).not.toBeNull()
      expect(foundRenewed?.id).toBe(initial.id)
    })
  })

  // ─────────────────────────────────────────────────────────────
  // 2. Cross-Scene Loose Compound Index Fallback Stress Suite
  // ─────────────────────────────────────────────────────────────
  describe('2. Cross-Scene Loose Compound Index Fallback', () => {
    it('2.1 未知页面场景（如 pageType="unknown_modal"）：Tier 1 无法命中时，Tier 2 复合索引 [platform+goal] 正常捕获已有技能', async () => {
      await upsertSkillDirect({
        platform: 'boss',
        pageType: 'detail',
        goal: 'click_chat',
        steps: [{ thinking: '详情页沉淀', action: { type: 'click' } }],
        selectorSignature: 'sig-detail',
      })

      // 请求全新未见过的 pageType
      const result = await findBestSkillDirect('boss', 'unknown_modal', 'click_chat')
      expect(result).not.toBeNull()
      expect(result?.platform).toBe('boss')
      expect(result?.goal).toBe('click_chat')
      expect(result?.pageType).toBe('detail')
    })

    it('2.2 pageType 为空字符串、undefined 或 null 时安全跳过 Tier 1 直达 Tier 2 宽松索引', async () => {
      await upsertSkillDirect({
        platform: 'boss',
        pageType: 'list',
        goal: 'click_chat',
        steps: [{ thinking: '列表开聊', action: { type: 'click' } }],
        selectorSignature: 'sig-list',
      })

      // 空字符串
      const resEmpty = await findBestSkillDirect('boss', '', 'click_chat')
      expect(resEmpty).not.toBeNull()
      expect(resEmpty?.pageType).toBe('list')

      // undefined 转入
      const resUndef = await findBestSkillDirect('boss', undefined as unknown as string, 'click_chat')
      expect(resUndef).not.toBeNull()
      expect(resUndef?.pageType).toBe('list')
    })

    it('2.3 Tier 2 多候选竞争择优：按 successCount 倒序优先返回最稳健跨场景技能', async () => {
      const now = Date.now()
      await db.agentSkills.bulkPut([
        {
          id: 'cross-scene-c',
          platform: 'boss',
          pageType: 'page_c',
          goal: 'click_chat',
          steps: [],
          successCount: 3,
          failCount: 0,
          createdAt: now,
          lastUsedAt: now - 3000,
          expiresAt: now + SKILL_TTL_MS,
          selectorSignature: 'sig-c',
          enabled: true,
        },
        {
          id: 'cross-scene-b',
          platform: 'boss',
          pageType: 'page_b',
          goal: 'click_chat',
          steps: [],
          successCount: 45, // 最高成功率
          failCount: 0,
          createdAt: now,
          lastUsedAt: now - 2000,
          expiresAt: now + SKILL_TTL_MS,
          selectorSignature: 'sig-b',
          enabled: true,
        },
        {
          id: 'cross-scene-a',
          platform: 'boss',
          pageType: 'page_a',
          goal: 'click_chat',
          steps: [],
          successCount: 12,
          failCount: 0,
          createdAt: now,
          lastUsedAt: now - 1000,
          expiresAt: now + SKILL_TTL_MS,
          selectorSignature: 'sig-a',
          enabled: true,
        },
      ])

      const result = await findBestSkillDirect('boss', 'new_unseen_page', 'click_chat')
      expect(result).not.toBeNull()
      expect(result?.id).toBe('cross-scene-b')
      expect(result?.successCount).toBe(45)
    })

    it('2.4 Tier 2 相同成功率下以 lastUsedAt 倒序打破平局', async () => {
      const now = Date.now()
      await db.agentSkills.bulkPut([
        {
          id: 'skill-older',
          platform: 'boss',
          pageType: 'page_old',
          goal: 'click_chat',
          steps: [],
          successCount: 10,
          failCount: 0,
          createdAt: now - 10000,
          lastUsedAt: now - 5000, // 较早使用
          expiresAt: now + SKILL_TTL_MS,
          selectorSignature: 'sig-older',
          enabled: true,
        },
        {
          id: 'skill-newer',
          platform: 'boss',
          pageType: 'page_new',
          goal: 'click_chat',
          steps: [],
          successCount: 10,
          failCount: 0,
          createdAt: now - 5000,
          lastUsedAt: now - 500, // 最近使用
          expiresAt: now + SKILL_TTL_MS,
          selectorSignature: 'sig-newer',
          enabled: true,
        },
      ])

      const result = await findBestSkillDirect('boss', 'arbitrary_page', 'click_chat')
      expect(result?.id).toBe('skill-newer')
    })

    it('2.5 Tier 2 严密过滤：降级查询同样受到 failCount < 3、enabled !== false、expiresAt > now 约束', async () => {
      const now = Date.now()
      await db.agentSkills.bulkPut([
        {
          id: 'candidate-quarantined',
          platform: 'boss',
          pageType: 'scene_1',
          goal: 'click_chat',
          steps: [],
          successCount: 100,
          failCount: 3, // 隔离
          createdAt: now,
          lastUsedAt: now,
          expiresAt: now + SKILL_TTL_MS,
          selectorSignature: 'quarantined',
          enabled: true,
        },
        {
          id: 'candidate-disabled',
          platform: 'boss',
          pageType: 'scene_2',
          goal: 'click_chat',
          steps: [],
          successCount: 100,
          failCount: 0,
          createdAt: now,
          lastUsedAt: now,
          expiresAt: now + SKILL_TTL_MS,
          selectorSignature: 'disabled',
          enabled: false, // 禁用
        },
        {
          id: 'candidate-expired',
          platform: 'boss',
          pageType: 'scene_3',
          goal: 'click_chat',
          steps: [],
          successCount: 100,
          failCount: 0,
          createdAt: now - 20000,
          lastUsedAt: now - 20000,
          expiresAt: now - 100, // 过期
          selectorSignature: 'expired',
          enabled: true,
        },
      ])

      // 在未知页面触发 Tier 2 降级，所有候选均不合规
      const result = await findBestSkillDirect('boss', 'any_other_scene', 'click_chat')
      expect(result).toBeNull()
    })

    it('2.6 跨平台与跨目标绝对隔离：[platform+goal] 严防跨 platform 或跨 goal 误命中', async () => {
      const now = Date.now()
      await db.agentSkills.bulkPut([
        {
          id: 'zhaopin-chat',
          platform: 'zhaopin', // 不同平台
          pageType: 'detail',
          goal: 'click_chat',
          steps: [],
          successCount: 10,
          failCount: 0,
          createdAt: now,
          lastUsedAt: now,
          expiresAt: now + SKILL_TTL_MS,
          selectorSignature: 'zhaopin',
          enabled: true,
        },
        {
          id: 'boss-submit',
          platform: 'boss',
          pageType: 'detail',
          goal: 'submit_form', // 不同目标
          steps: [],
          successCount: 10,
          failCount: 0,
          createdAt: now,
          lastUsedAt: now,
          expiresAt: now + SKILL_TTL_MS,
          selectorSignature: 'submit',
          enabled: true,
        },
      ])

      const result = await findBestSkillDirect('boss', 'unknown_page', 'click_chat')
      expect(result).toBeNull()
    })
  })

  // ─────────────────────────────────────────────────────────────
  // 3. Content Script Messaging Failure & Safe Degradation (R4 Mission-First)
  // ─────────────────────────────────────────────────────────────
  describe('3. Content Script Messaging Failure & Safe Degradation (R4)', () => {
    beforeEach(() => {
      setSkillMemoryTransportForTesting('messaging')
    })

    it('3.1 同步崩溃：chrome.runtime.sendMessage 抛出同步异常时，findBestSkill/upsertSkill/recordSkillFail 均不向外冒泡异常', async () => {
      vi.stubGlobal('chrome', {
        runtime: {
          sendMessage: vi.fn(() => {
            throw new Error('Extension context invalidated.')
          }),
        },
      })

      // 1. findBestSkill 必须安全返回 null
      const skill = await findBestSkill('boss', 'detail', 'click_chat')
      expect(skill).toBeNull()

      // 2. upsertSkill 必须返回本地临时 fallback 对象保证流水线继续
      const fallbackSkill = await upsertSkill({
        platform: 'boss',
        pageType: 'detail',
        goal: 'click_chat',
        steps: [{ thinking: '崩溃回退动作', action: { type: 'click' } }],
        selectorSignature: 'fallback-sig',
      })
      expect(fallbackSkill).toBeDefined()
      expect(fallbackSkill.id).toMatch(/^fallback-/)
      expect(fallbackSkill.platform).toBe('boss')
      expect(fallbackSkill.goal).toBe('click_chat')

      // 3. recordSkillFail 必须安全 resolve，不抛出异常
      await expect(recordSkillFail(fallbackSkill)).resolves.not.toThrow()
    })

    it('3.2 异步消息通道断开：lastError 汇报 "Could not establish connection"，保障零异常', async () => {
      vi.stubGlobal('chrome', {
        runtime: {
          sendMessage: vi.fn((_msg: any, callback: (res: any) => void) => {
            (globalThis as any).chrome.runtime.lastError = {
              message: 'Could not establish connection. Receiving end does not exist.',
            }
            callback(undefined)
          }),
          lastError: null,
        },
      })

      const skill = await findBestSkill('boss', 'detail', 'click_chat')
      expect(skill).toBeNull()

      const saved = await upsertSkill({
        platform: 'boss',
        pageType: 'detail',
        goal: 'click_chat',
        steps: [],
        selectorSignature: 'sig',
      })
      expect(saved.id).toMatch(/^fallback-/)

      await expect(recordSkillFail(saved)).resolves.not.toThrow()
    })

    it('3.3 业务层拒绝：Background 返回 { success: false, error: "Database lock timeout" } 时优雅降级', async () => {
      vi.stubGlobal('chrome', {
        runtime: {
          sendMessage: vi.fn((_msg: any, callback: (res: any) => void) => {
            callback({ success: false, error: 'Database lock timeout' })
          }),
          lastError: null,
        },
      })

      const skill = await findBestSkill('boss', 'detail', 'click_chat')
      expect(skill).toBeNull()

      const saved = await upsertSkill({
        platform: 'boss',
        pageType: 'detail',
        goal: 'click_chat',
        steps: [],
        selectorSignature: 'sig',
      })
      expect(saved.id).toMatch(/^fallback-/)

      await expect(recordSkillFail(saved)).resolves.not.toThrow()
    })

    it('3.4 异常响应体防御：Background 回调空对象、undefined、null 或空数据体时正确返回 null', async () => {
      // 场景 A: callback 被调用但入参为 undefined
      vi.stubGlobal('chrome', {
        runtime: {
          sendMessage: vi.fn((_msg: any, callback: (res: any) => void) => {
            callback(undefined)
          }),
          lastError: null,
        },
      })
      expect(await findBestSkill('boss', 'detail', 'click_chat')).toBeNull()

      // 场景 B: callback 返回 { success: true, data: null }
      vi.stubGlobal('chrome', {
        runtime: {
          sendMessage: vi.fn((_msg: any, callback: (res: any) => void) => {
            callback({ success: true, data: null })
          }),
          lastError: null,
        },
      })
      expect(await findBestSkill('boss', 'detail', 'click_chat')).toBeNull()

      // 场景 C [实测缺陷暴露]: 当 Background 返回 { success: true } 或 { success: true, data: undefined }
      // sendRuntimeMessage 会将其视为非空对象解析，导致 findBestSkill 漏出一个不具备 AgentSkill 结构的伪对象
      vi.stubGlobal('chrome', {
        runtime: {
          sendMessage: vi.fn((_msg: any, callback: (res: any) => void) => {
            callback({ success: true, data: undefined })
          }),
          lastError: null,
        },
      })
      const skill = await findBestSkill('boss', 'detail', 'click_chat')
      // 实测证实：返回 null，杜绝泄露 { success: true } 伪对象
      expect(skill).toBeNull()
    })

    it('3.5 运行环境缺失：chrome 或 chrome.runtime.sendMessage 不存在时安全降级', async () => {
      // 彻底抹除 chrome
      vi.stubGlobal('chrome', undefined)

      const skill = await findBestSkill('boss', 'detail', 'click_chat')
      expect(skill).toBeNull()

      const saved = await upsertSkill({
        platform: 'boss',
        pageType: 'detail',
        goal: 'click_chat',
        steps: [],
        selectorSignature: 'sig',
      })
      expect(saved.id).toMatch(/^fallback-/)

      await expect(recordSkillFail(saved)).resolves.not.toThrow()
    })

    it('3.6 [实测缺陷暴露] 跨进程消息信道悬挂（Hanging Channel）：缺乏内置超时保护导致调用方无限期挂起', async () => {
      // 模拟 Chrome MV3 Service Worker 崩溃或被系统挂起，sendMessage 回调永远不被调用
      vi.stubGlobal('chrome', {
        runtime: {
          sendMessage: vi.fn((_msg: any, _callback: (res: any) => void) => {
            // 故意不调用 callback，也不设置 lastError
          }),
          lastError: null,
        },
      })

      // 验证 findBestSkill 在缺乏超时保护的情况下处于永久挂起状态
      const timeoutThresholdMs = 80
      const isHanging = await Promise.race([
        findBestSkill('boss', 'detail', 'click_chat').then(() => false),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(true), timeoutThresholdMs)),
      ])

      // 证实：80ms 过去后 Promise 依然没有完成，发生悬挂
      expect(isHanging).toBe(true)
    })
  })

  // ─────────────────────────────────────────────────────────────
  // 4. Dexie Database Key Validation Stress Suite
  // ─────────────────────────────────────────────────────────────
  describe('4. Dexie Compound Key Validation Stress Suite', () => {
    it('4.1 当 platform 或 goal 为 undefined/null 时，findBestSkillDirect 安全返回 null 防御 DataError', async () => {
      // 验证当调用方未传或传入非法 key 时，findBestSkillDirect 安全降级返回 null 杜绝底层 DataError
      expect(await findBestSkillDirect('boss', 'detail', undefined as unknown as string)).toBeNull()
      expect(await findBestSkillDirect(null as unknown as string, 'detail', 'click_chat')).toBeNull()
    })
  })
})
