// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Dexie from 'dexie'
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

describe('自愈韧性智能体架构 · 技能记忆与选择器指纹 (Skill Memory & Selector Fingerprinting)', () => {
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

  // ─────────────────────────────────────────────────────────────
  // 1. Dexie Version 8 与 Schema 迁移检验
  // ─────────────────────────────────────────────────────────────
  describe('1. Dexie Version 8 与 Schema 迁移检验', () => {
    it('1.1 复合索引 [platform+pageType+goal] 与 [platform+goal] 正常支持查询', async () => {
      const sampleSkill: AgentSkill = {
        id: 'skill-v8-index-test',
        platform: 'boss',
        pageType: 'detail',
        goal: 'click_chat',
        steps: [{ thinking: '点击沟通', action: { type: 'click' } }],
        successCount: 2,
        failCount: 0,
        createdAt: Date.now(),
        lastUsedAt: Date.now(),
        expiresAt: Date.now() + SKILL_TTL_MS,
        selectorSignature: '立即沟通',
        enabled: true,
        patchSource: 'heuristic',
        fingerprint: {
          cssSelector: 'button.btn-startchat',
          buttonText: '立即沟通',
          signature: 'boss:detail:chat',
        },
        remediationNotes: 'Boss直聘详情页开聊自愈',
      }
      await db.agentSkills.put(sampleSkill)

      // 验证严格三元复合索引
      const exact = await db.agentSkills
        .where('[platform+pageType+goal]')
        .equals(['boss', 'detail', 'click_chat'])
        .first()
      expect(exact).toBeDefined()
      expect(exact?.id).toBe('skill-v8-index-test')
      expect(exact?.patchSource).toBe('heuristic')

      // 验证二元宽松复合索引
      const loose = await db.agentSkills
        .where('[platform+goal]')
        .equals(['boss', 'click_chat'])
        .first()
      expect(loose).toBeDefined()
      expect(loose?.id).toBe('skill-v8-index-test')
      expect(loose?.fingerprint?.cssSelector).toBe('button.btn-startchat')
    })

    it('1.2 模拟历史数据库从 Version 7 升级至 Version 8 自动补齐 patchSource 并不丢失历史数据', async () => {
      const legacyDbName = 'LegacyV7TestDB'
      const legacyDb = new Dexie(legacyDbName)
      legacyDb.version(7).stores({
        agentSkills: 'id, platform, pageType, goal, [platform+pageType+goal], lastUsedAt, expiresAt',
      })
      await legacyDb.open()

      // 写入历史未标记 patchSource 的老记录
      await legacyDb.table('agentSkills').put({
        id: 'legacy-skill-101',
        platform: 'boss',
        pageType: 'search',
        goal: 'click_chat',
        steps: [{ thinking: '旧动作', action: { type: 'click' } }],
        successCount: 7,
        failCount: 0,
        createdAt: Date.now() - 50000,
        lastUsedAt: Date.now() - 10000,
        expiresAt: Date.now() + 86400000,
        selectorSignature: 'old-signature',
        enabled: true,
      })
      await legacyDb.close()

      // 以 Version 8 声明打开该数据库
      class UpgradedDB extends Dexie {
        agentSkills!: Dexie.Table<AgentSkill, string>
        constructor() {
          super(legacyDbName)
          this.version(7).stores({
            agentSkills: 'id, platform, pageType, goal, [platform+pageType+goal], lastUsedAt, expiresAt',
          })
          this.version(8).stores({
            agentSkills: 'id, platform, pageType, goal, [platform+pageType+goal], [platform+goal], lastUsedAt, expiresAt',
          }).upgrade(async (tx) => {
            await tx
              .table<AgentSkill, string>('agentSkills')
              .toCollection()
              .modify((skill: AgentSkill) => {
                if (skill.patchSource === undefined) {
                  skill.patchSource = 'heuristic'
                }
              })
          })
        }
      }

      const upgradedDb = new UpgradedDB()
      await upgradedDb.open()

      const restored = await upgradedDb.agentSkills.get('legacy-skill-101')
      expect(restored).toBeDefined()
      expect(restored?.successCount).toBe(7)
      expect(restored?.selectorSignature).toBe('old-signature')
      // 验证 upgrade 回调成功补齐 patchSource = 'heuristic'
      expect(restored?.patchSource).toBe('heuristic')

      // 验证新添加的 [platform+goal] 复合索引已立即生效
      const byNewIndex = await upgradedDb.agentSkills
        .where('[platform+goal]')
        .equals(['boss', 'click_chat'])
        .first()
      expect(byNewIndex?.id).toBe('legacy-skill-101')

      await upgradedDb.close()
      await Dexie.delete(legacyDbName)
    })
  })

  // ─────────────────────────────────────────────────────────────
  // 2. 选择器指纹提取引擎 (buildSelectorFingerprint)
  // ─────────────────────────────────────────────────────────────
  describe('2. 选择器指纹提取引擎 (buildSelectorFingerprint)', () => {
    it('2.1 单一元素具备语义 class 时生成精确 CSS 选择器并成功定位', () => {
      document.body.innerHTML = `
        <div class="job-detail-box">
          <button class="btn btn-startchat">立即沟通</button>
        </div>
      `
      const btn = document.querySelector('.btn-startchat')!
      const fingerprint = buildSelectorFingerprint(btn)

      expect(fingerprint).toMatch(/btn-startchat/)
      const resolved = document.querySelector(fingerprint)
      expect(resolved).toBe(btn)
    })

    it('2.2 包含 Boss 直聘 ka 平台专属属性时生成 ka 属性选择器', () => {
      document.body.innerHTML = `
        <div class="card-item">
          <button class="btn-primary" ka="job_card_start_chat">开聊</button>
        </div>
      `
      const btn = document.querySelector('button[ka]')!
      const fingerprint = buildSelectorFingerprint(btn)

      expect(fingerprint).toContain('job_card_start_chat')
      const resolved = document.querySelector(fingerprint)
      expect(resolved).toBe(btn)
    })

    it('2.3 包含 data-testid / aria-label 属性时优先生成语义属性选择器', () => {
      document.body.innerHTML = `
        <div>
          <button data-testid="chat-submit-btn" aria-label="立即沟通" class="normal-btn">立即沟通</button>
        </div>
      `
      const btn = document.querySelector('[data-testid="chat-submit-btn"]')!
      const fingerprint = buildSelectorFingerprint(btn)

      expect(fingerprint).toContain('data-testid="chat-submit-btn"')
      expect(document.querySelector(fingerprint)).toBe(btn)
    })

    it('2.4 过滤 Tailwind 原子类与动态 hash 类名，仅保留语义核心特征', () => {
      document.body.innerHTML = `
        <div class="p-4 flex items-center justify-between">
          <button class="flex items-center text-sm px-4 py-2 bg-blue-500 _3xk8 css-1h5y btn-startchat">
            <span>立即沟通</span>
          </button>
        </div>
      `
      const btn = document.querySelector('.btn-startchat')!
      const fingerprint = buildSelectorFingerprint(btn)

      // 验证未包含 tailwind 噪音类或动态 hash
      expect(fingerprint).not.toContain('items-center')
      expect(fingerprint).not.toContain('px-4')
      expect(fingerprint).not.toContain('_3xk8')
      expect(fingerprint).not.toContain('css-1h5y')
      // 验证包含语义核心类
      expect(fingerprint).toContain('btn-startchat')
      expect(document.querySelector(fingerprint)).toBe(btn)
    })

    it('2.5 容器作用域感知：在多卡片共存时，生成容器内精准唯一的选择器', () => {
      document.body.innerHTML = `
        <div id="card-1" class="job-card-box">
          <div class="company">公司A</div>
          <button class="btn btn-startchat">立即沟通</button>
        </div>
        <div id="card-2" class="job-card-box">
          <div class="company">公司B</div>
          <button class="btn btn-startchat">立即沟通</button>
        </div>
      `
      const card2 = document.getElementById('card-2')!
      const btn2 = card2.querySelector('.btn-startchat')!

      // 提取针对 card2 的选择器指纹
      const fingerprint = buildSelectorFingerprint(btn2, card2)
      expect(fingerprint).toBeTruthy()

      // 验证在 card2 容器内定位且不会串至 card1
      const resolvedInCard2 = card2.querySelector(fingerprint)
      expect(resolvedInCard2).toBe(btn2)
    })

    it('2.6 存在多个同级同名按钮时通过位置消歧 (:nth-of-type / :nth-child) 精确定位', () => {
      document.body.innerHTML = `
        <div class="action-bar">
          <button class="btn">收藏</button>
          <button class="btn">立即沟通</button>
          <button class="btn">分享</button>
        </div>
      `
      const container = document.querySelector('.action-bar')!
      const applyBtn = container.querySelectorAll('.btn')[1] // 第二个按钮

      const fingerprint = buildSelectorFingerprint(applyBtn, container)
      expect(fingerprint).toBeTruthy()
      expect(container.querySelector(fingerprint)).toBe(applyBtn)
    })

    it('2.7 无任何 class 与自定义属性时的通用 DOM 标签路径兜底', () => {
      document.body.innerHTML = `
        <form>
          <div>
            <section>
              <button>提交</button>
            </section>
          </div>
        </form>
      `
      const btn = document.querySelector('button')!
      const fingerprint = buildSelectorFingerprint(btn)

      expect(fingerprint).toBeTruthy()
      expect(document.querySelector(fingerprint)).toBe(btn)
    })

    it('2.8 稳定 ID 优先提取，动态生成 ID 自动规避', () => {
      document.body.innerHTML = `
        <button id="btn-custom-chat" class="btn">开聊</button>
        <button id=":r1:" class="btn">动态ID</button>
      `
      const stableBtn = document.getElementById('btn-custom-chat')!
      const dynamicBtn = document.getElementById(':r1:')!

      const stableFp = buildSelectorFingerprint(stableBtn)
      expect(stableFp).toBe('#btn-custom-chat')

      const dynamicFp = buildSelectorFingerprint(dynamicBtn)
      expect(dynamicFp).not.toContain(':r1:')
      expect(document.querySelector(dynamicFp)).toBe(dynamicBtn)
    })

    it('2.9 异常入参防御：传入空值或无效节点时返回空字符串', () => {
      expect(buildSelectorFingerprint(null as unknown as Element)).toBe('')
      expect(buildSelectorFingerprint(undefined as unknown as Element)).toBe('')
    })
  })

  // ─────────────────────────────────────────────────────────────
  // 3. 技能持久化与 TTL 生命周期 (upsertSkill)
  // ─────────────────────────────────────────────────────────────
  describe('3. 技能持久化与 TTL 生命周期 (upsertSkill)', () => {
    it('3.1 初次录入创建技能，默认设置 14 天 TTL、failCount=0、enabled=true', async () => {
      const step: AgentStep = {
        thinking: '点击投递',
        action: { type: 'click', target: { kind: 'css_selector', value: 'button.btn-startchat' } },
      }

      const created = await upsertSkillDirect({
        platform: 'boss',
        pageType: 'detail',
        goal: 'click_chat',
        steps: [step],
        selectorSignature: '立即沟通',
        patchSource: 'heuristic',
        fingerprint: {
          cssSelector: 'button.btn-startchat',
          buttonText: '立即沟通',
          signature: 'boss:detail:btn-startchat',
        },
        remediationNotes: 'Boss直聘详情页立即沟通启发式修复',
      })

      expect(created.id).toBeTruthy()
      expect(created.successCount).toBe(1)
      expect(created.failCount).toBe(0)
      expect(created.enabled).toBe(true)
      expect(created.patchSource).toBe('heuristic')
      expect(created.remediationNotes).toContain('启发式修复')
      expect(created.fingerprint?.cssSelector).toBe('button.btn-startchat')

      // 验证 14 天 TTL
      const expectedTtl = Date.now() + SKILL_TTL_MS
      expect(created.expiresAt).toBeGreaterThanOrEqual(expectedTtl - 5000)
      expect(created.expiresAt).toBeLessThanOrEqual(expectedTtl + 5000)
    })

    it('3.2 存量技能更新：成功时重置 failCount=0、递增 successCount、刷新 14 天 TTL', async () => {
      // 预置一条有 2 次失败记录的老技能
      const oldTime = Date.now() - 50000
      await db.agentSkills.put({
        id: 'skill-pre-existing-1',
        platform: 'boss',
        pageType: 'detail',
        goal: 'click_chat',
        steps: [{ thinking: '旧动作1', action: { type: 'click' } }, { thinking: '旧动作2', action: { type: 'wait' } }],
        successCount: 3,
        failCount: 2, // 曾经失败两次
        createdAt: oldTime,
        lastUsedAt: oldTime,
        expiresAt: oldTime + 100000,
        selectorSignature: '旧签名',
        enabled: true,
      })

      const updated = await upsertSkillDirect({
        platform: 'boss',
        pageType: 'detail',
        goal: 'click_chat',
        steps: [{ thinking: '优化动作', action: { type: 'click' } }], // 步骤更短 (1 < 2)
        selectorSignature: '新签名',
      })

      expect(updated.id).toBe('skill-pre-existing-1')
      expect(updated.successCount).toBe(4)
      expect(updated.failCount).toBe(0) // 必须彻底清零，恢复健康
      expect(updated.steps.length).toBe(1) // 替换为更短的步骤
      expect(updated.selectorSignature).toBe('新签名')
      // 验证 TTL 得到重新延长
      expect(updated.expiresAt).toBeGreaterThan(Date.now() + SKILL_TTL_MS - 5000)
    })

    it('3.3 存量技能更新：新步骤长度更长时不替换已有步骤，但依然增加计数与刷新 TTL', async () => {
      await db.agentSkills.put({
        id: 'skill-short-steps',
        platform: 'boss',
        pageType: 'search',
        goal: 'open_detail',
        steps: [{ thinking: '极简单步', action: { type: 'click' } }],
        successCount: 5,
        failCount: 1,
        createdAt: Date.now() - 10000,
        lastUsedAt: Date.now() - 10000,
        expiresAt: Date.now() + 100000,
        selectorSignature: 'sig-1',
        enabled: true,
      })

      const updated = await upsertSkillDirect({
        platform: 'boss',
        pageType: 'search',
        goal: 'open_detail',
        steps: [
          { thinking: '多余等待', action: { type: 'wait' } },
          { thinking: '步骤二', action: { type: 'click' } },
        ],
        selectorSignature: 'sig-2',
      })

      expect(updated.id).toBe('skill-short-steps')
      expect(updated.steps.length).toBe(1) // 保持优质的单步
      expect(updated.successCount).toBe(6)
      expect(updated.failCount).toBe(0)
    })
  })

  // ─────────────────────────────────────────────────────────────
  // 4. 多阶检索与自愈过滤 (findBestSkill)
  // ─────────────────────────────────────────────────────────────
  describe('4. 多阶检索与自愈过滤 (findBestSkill)', () => {
    it('4.1 Tier 1 严格三元复合匹配：精确匹配 [platform+pageType+goal]', async () => {
      await upsertSkillDirect({
        platform: 'boss',
        pageType: 'detail',
        goal: 'click_chat',
        steps: [{ thinking: '详情页开聊', action: { type: 'click' } }],
        selectorSignature: 'detail-sig',
      })

      const skill = await findBestSkillDirect('boss', 'detail', 'click_chat')
      expect(skill).not.toBeNull()
      expect(skill?.pageType).toBe('detail')
      expect(skill?.goal).toBe('click_chat')
    })

    it('4.2 Tier 2 宽松二元复合匹配：在不同 pageType 下降级命中同 platform+goal 技能', async () => {
      // 仅在 'search' 页面沉淀了 'click_chat' 技能
      await upsertSkillDirect({
        platform: 'boss',
        pageType: 'search',
        goal: 'click_chat',
        steps: [{ thinking: '通用卡片开聊', action: { type: 'click' } }],
        selectorSignature: 'search-sig',
      })

      // 在 'recommend'（个性化推荐列表）请求相同的 'click_chat' 目标
      const fallbackSkill = await findBestSkillDirect('boss', 'recommend', 'click_chat')
      expect(fallbackSkill).not.toBeNull()
      expect(fallbackSkill?.platform).toBe('boss')
      expect(fallbackSkill?.goal).toBe('click_chat')
      expect(fallbackSkill?.pageType).toBe('search') // 成功跨场景复用
    })

    it('4.3 失败阈值过滤：failCount >= 3 的故障技能被自动隔离，不再被检索命中', async () => {
      const skill = await upsertSkillDirect({
        platform: 'boss',
        pageType: 'detail',
        goal: 'click_chat',
        steps: [{ thinking: '已失效按钮', action: { type: 'click' } }],
        selectorSignature: 'stale-sig',
      })

      // 连续失败 3 次
      await recordSkillFailDirect(skill)
      await recordSkillFailDirect(skill)
      await recordSkillFailDirect(skill)

      const found = await findBestSkillDirect('boss', 'detail', 'click_chat')
      expect(found).toBeNull() // failCount=3 触发自动隔离
    })

    it('4.4 后台停用过滤：enabled=false 的技能不被检索命中', async () => {
      const skill = await upsertSkillDirect({
        platform: 'boss',
        pageType: 'detail',
        goal: 'click_chat',
        steps: [{ thinking: '管理员禁用的技能', action: { type: 'click' } }],
        selectorSignature: 'sig',
      })

      await db.agentSkills.update(skill.id, { enabled: false })

      const found = await findBestSkillDirect('boss', 'detail', 'click_chat')
      expect(found).toBeNull()
    })

    it('4.5 过期失效过滤：超过 14 天 TTL (expiresAt <= Date.now()) 的技能自动失效', async () => {
      await db.agentSkills.put({
        id: 'expired-skill',
        platform: 'boss',
        pageType: 'detail',
        goal: 'click_chat',
        steps: [{ thinking: '过期步骤', action: { type: 'click' } }],
        successCount: 10,
        failCount: 0,
        createdAt: Date.now() - 20 * 86400000,
        lastUsedAt: Date.now() - 20 * 86400000,
        expiresAt: Date.now() - 1000, // 已过期 1 秒
        selectorSignature: 'expired',
        enabled: true,
      })

      const found = await findBestSkillDirect('boss', 'detail', 'click_chat')
      expect(found).toBeNull()
    })

    it('4.6 排序择优：多个合格技能存在时，优先命中 successCount 更高者', async () => {
      await db.agentSkills.bulkPut([
        {
          id: 'skill-low-success',
          platform: 'boss',
          pageType: 'detail',
          goal: 'click_chat',
          steps: [{ thinking: '低频', action: { type: 'click' } }],
          successCount: 2,
          failCount: 0,
          createdAt: Date.now(),
          lastUsedAt: Date.now() - 5000,
          expiresAt: Date.now() + SKILL_TTL_MS,
          selectorSignature: 'low',
          enabled: true,
        },
        {
          id: 'skill-high-success',
          platform: 'boss',
          pageType: 'detail',
          goal: 'click_chat',
          steps: [{ thinking: '高频稳健', action: { type: 'click' } }],
          successCount: 42,
          failCount: 0,
          createdAt: Date.now(),
          lastUsedAt: Date.now() - 1000,
          expiresAt: Date.now() + SKILL_TTL_MS,
          selectorSignature: 'high',
          enabled: true,
        },
      ])

      const best = await findBestSkillDirect('boss', 'detail', 'click_chat')
      expect(best?.id).toBe('skill-high-success')
    })
  })

  // ─────────────────────────────────────────────────────────────
  // 5. 故障累加与自愈闭环 (recordSkillFail & Self-Healing Cycle)
  // ─────────────────────────────────────────────────────────────
  describe('5. 故障累加与自愈闭环 (recordSkillFail & Self-Healing Cycle)', () => {
    it('5.1 recordSkillFail 正确累加 failCount 并更新 lastUsedAt', async () => {
      const skill = await upsertSkillDirect({
        platform: 'boss',
        pageType: 'detail',
        goal: 'click_chat',
        steps: [{ thinking: '动作', action: { type: 'click' } }],
        selectorSignature: 'sig',
      })
      expect(skill.failCount).toBe(0)

      await recordSkillFailDirect(skill)
      const after1 = await db.agentSkills.get(skill.id)
      expect(after1?.failCount).toBe(1)

      await recordSkillFailDirect(skill)
      const after2 = await db.agentSkills.get(skill.id)
      expect(after2?.failCount).toBe(2)
    })

    it('5.2 完整自愈演进闭环：产生 -> 2次失败(仍可用) -> 3次失败(被隔离) -> 重新自愈探索入库(恢复健康)', async () => {
      // 阶段 1：初次沉淀
      const initial = await upsertSkillDirect({
        platform: 'boss',
        pageType: 'detail',
        goal: 'click_chat',
        steps: [{ thinking: '旧选择器', action: { type: 'click', target: { kind: 'css_selector', value: '.old-btn' } } }],
        selectorSignature: 'old-btn',
      })

      // 阶段 2：偶然 2 次失败，仍然在容忍范围内
      await recordSkillFailDirect(initial)
      await recordSkillFailDirect(initial)
      let found = await findBestSkillDirect('boss', 'detail', 'click_chat')
      expect(found).not.toBeNull()
      expect(found?.failCount).toBe(2)

      // 阶段 3：第 3 次失败，页面改版，彻底被系统熔断隔离
      await recordSkillFailDirect(initial)
      found = await findBestSkillDirect('boss', 'detail', 'click_chat')
      expect(found).toBeNull()

      // 阶段 4：后续任务通过启发式 / LLM 探索到了新选择器并调用 upsertSkill
      const healed = await upsertSkillDirect({
        platform: 'boss',
        pageType: 'detail',
        goal: 'click_chat',
        steps: [{ thinking: '自愈新选择器', action: { type: 'click', target: { kind: 'css_selector', value: 'button.btn-startchat' } } }],
        selectorSignature: 'button.btn-startchat',
        patchSource: 'heuristic',
        remediationNotes: '免发版运行时自愈热修复生效',
      })

      // 验证技能满血复活
      expect(healed.failCount).toBe(0)
      const recovered = await findBestSkillDirect('boss', 'detail', 'click_chat')
      expect(recovered).not.toBeNull()
      expect(recovered?.id).toBe(initial.id)
      expect(recovered?.failCount).toBe(0)
      expect(recovered?.steps[0].thinking).toContain('自愈新选择器')
      expect(recovered?.remediationNotes).toContain('免发版运行时自愈')
    })
  })

  // ─────────────────────────────────────────────────────────────
  // 6. 跨进程消息桥接与任务优先安全兜底 (Cross-Origin Bridge & Resilience)
  // ─────────────────────────────────────────────────────────────
  describe('6. 跨进程消息桥接与任务优先安全兜底 (Cross-Origin Bridge & Resilience)', () => {
    it('6.1 模拟 Content Script 环境：findBestSkill / upsertSkill / recordSkillFail 经由 chrome.runtime.sendMessage 发送', async () => {
      setSkillMemoryTransportForTesting('messaging')

      const mockSendMessage = vi.fn((msg: any, callback: (res: any) => void) => {
        if (msg.type === 'GET_BEST_SKILL') {
          callback({
            success: true,
            data: {
              id: 'bridge-skill-1',
              platform: msg.payload.platform,
              pageType: msg.payload.pageType,
              goal: msg.payload.goal,
              steps: [],
              successCount: 10,
              failCount: 0,
              createdAt: Date.now(),
              lastUsedAt: Date.now(),
              expiresAt: Date.now() + SKILL_TTL_MS,
              selectorSignature: 'bridge-sig',
              enabled: true,
            },
          })
        } else if (msg.type === 'UPSERT_SKILL') {
          callback({
            success: true,
            data: {
              id: 'saved-bridge-skill',
              ...msg.payload,
              successCount: 1,
              failCount: 0,
              createdAt: Date.now(),
              lastUsedAt: Date.now(),
              expiresAt: Date.now() + SKILL_TTL_MS,
              enabled: true,
            },
          })
        } else if (msg.type === 'RECORD_SKILL_FAIL') {
          callback({ success: true })
        }
      })

      // 设置全局 chrome mock
      vi.stubGlobal('chrome', {
        runtime: {
          sendMessage: mockSendMessage,
          lastError: null,
        },
      })

      // 1. 测试 findBestSkill 消息透传
      const skill = await findBestSkill('boss', 'detail', 'click_chat')
      expect(skill).not.toBeNull()
      expect(skill?.id).toBe('bridge-skill-1')
      expect(mockSendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'GET_BEST_SKILL',
          payload: { platform: 'boss', pageType: 'detail', goal: 'click_chat' },
        }),
        expect.any(Function)
      )

      // 2. 测试 upsertSkill 消息透传
      const saved = await upsertSkill({
        platform: 'boss',
        pageType: 'detail',
        goal: 'click_chat',
        steps: [{ thinking: '桥接动作', action: { type: 'click' } }],
        selectorSignature: 'bridge-sig',
      })
      expect(saved.id).toBe('saved-bridge-skill')
      expect(mockSendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'UPSERT_SKILL',
        }),
        expect.any(Function)
      )

      // 3. 测试 recordSkillFail 消息透传
      await recordSkillFail(saved)
      expect(mockSendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'RECORD_SKILL_FAIL',
        }),
        expect.any(Function)
      )
    })

    it('6.2 任务优先 (R4 Mission-First)：当 Background 通信异常或断开时，findBestSkill 安全返回 null 绝不抛出异常阻断任务', async () => {
      setSkillMemoryTransportForTesting('messaging')

      // 模拟 background 通信抛错 (例如 Service Worker 崩溃或端口断开)
      vi.stubGlobal('chrome', {
        runtime: {
          sendMessage: vi.fn((_msg: any, callback: (res: any) => void) => {
            // 设置 lastError
            (globalThis as any).chrome.runtime.lastError = { message: 'Could not establish connection. Receiving end does not exist.' }
            callback(undefined)
          }),
          lastError: null,
        },
      })

      // 必须安全返回 null，绝不向外抛出异常
      const skill = await findBestSkill('boss', 'detail', 'click_chat')
      expect(skill).toBeNull()

      // upsertSkill 在网络/通道故障时也必须返回本地临时结构，不阻断主流程
      const fallbackUpsert = await upsertSkill({
        platform: 'boss',
        pageType: 'detail',
        goal: 'click_chat',
        steps: [],
        selectorSignature: 'fallback',
      })
      expect(fallbackUpsert).toBeDefined()
      expect(fallbackUpsert.id).toContain('fallback-')

      // recordSkillFail 同样静默吞并错误，不阻断后续投递
      await expect(recordSkillFail(fallbackUpsert)).resolves.not.toThrow()
    })
  })

  // ─────────────────────────────────────────────────────────────
  // 7. 辅助与兼容性检验 (computeSignature)
  // ─────────────────────────────────────────────────────────────
  describe('7. 辅助与兼容性检验 (computeSignature)', () => {
    it('7.1 computeSignature 正确提取前 10 个按钮的文本并以竖线拼接', () => {
      const state = {
        buttons: [
          { text: '立即沟通' },
          { text: '收藏' },
          { text: '投递' },
        ],
      }
      expect(computeSignature(state)).toBe('立即沟通|收藏|投递')
    })
  })

  // ─────────────────────────────────────────────────────────────
  // 8. Background 消息路由集成模拟 (Background Message Handlers)
  // ─────────────────────────────────────────────────────────────
  describe('8. Background 消息路由集成模拟 (Background Message Handlers)', () => {
    it('8.1 模拟 background 接收 GET_BEST_SKILL, UPSERT_SKILL, RECORD_SKILL_FAIL', async () => {
      // 模拟 background 处理流程
      const handleBackgroundMessage = async (message: any): Promise<any> => {
        return new Promise((resolve) => {
          const sendResponse = (resp: any) => resolve(resp)

          if (message.type === 'GET_BEST_SKILL') {
            const { platform, pageType, goal } = message.payload || {}
            findBestSkillDirect(platform, pageType, goal)
              .then((skill) => sendResponse({ success: true, data: skill }))
              .catch((err) => sendResponse({ success: false, error: String(err?.message || err) }))
          } else if (message.type === 'UPSERT_SKILL') {
            upsertSkillDirect(message.payload || {})
              .then((saved) => sendResponse({ success: true, data: saved }))
              .catch((err) => sendResponse({ success: false, error: String(err?.message || err) }))
          } else if (message.type === 'RECORD_SKILL_FAIL') {
            const skill = (message.payload?.skill || message.payload) as AgentSkill
            recordSkillFailDirect(skill)
              .then(() => sendResponse({ success: true }))
              .catch((err) => sendResponse({ success: false, error: String(err?.message || err) }))
          }
        })
      }

      // 1. 模拟 background 写入技能
      const upsertResp = await handleBackgroundMessage({
        type: 'UPSERT_SKILL',
        payload: {
          platform: 'boss',
          pageType: 'search',
          goal: 'click_chat',
          steps: [{ thinking: '后台写入动作', action: { type: 'click' } }],
          selectorSignature: 'bg-sig',
          patchSource: 'llm',
          remediationNotes: 'LLM感知发现新开聊按钮',
        },
      })
      expect(upsertResp.success).toBe(true)
      expect(upsertResp.data.patchSource).toBe('llm')

      // 2. 模拟 background 查询技能
      const getResp = await handleBackgroundMessage({
        type: 'GET_BEST_SKILL',
        payload: { platform: 'boss', pageType: 'search', goal: 'click_chat' },
      })
      expect(getResp.success).toBe(true)
      expect(getResp.data.id).toBe(upsertResp.data.id)
      expect(getResp.data.remediationNotes).toContain('LLM感知')

      // 3. 模拟 background 记录失败
      const failResp = await handleBackgroundMessage({
        type: 'RECORD_SKILL_FAIL',
        payload: { skill: upsertResp.data },
      })
      expect(failResp.success).toBe(true)

      const afterFail = await db.agentSkills.get(upsertResp.data.id)
      expect(afterFail?.failCount).toBe(1)
    })
  })
})
