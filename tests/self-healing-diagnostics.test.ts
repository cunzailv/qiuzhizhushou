// M4 · 事后归因：自愈事件存储与开发者待修建议聚合
// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach } from 'vitest'
import { db } from '../src/shared/db/index'
import {
  recordSelfHealingEvent,
  listSelfHealingEvents,
  getDeveloperFixSuggestions,
  getDiagnosticFixRecommendations,
  clearSelfHealingEvents,
  MAX_SELF_HEALING_EVENTS,
} from '../src/shared/db/diagnostics-store'
import {
  CATEGORY_FIX_TEMPLATES,
  CATEGORY_LABELS,
  ALL_SELF_HEALING_CATEGORIES,
} from '../src/shared/types/diagnostics'

const baseEvent = {
  platform: 'boss',
  category: 'button_heuristic' as const,
  triggerDescription: '预设选择器未命中沟通按钮',
  bypassPath: 'semantic_text_whitelist',
  failedSelector: '.btn-startchat',
  buttonText: '立即沟通',
  jobTitle: '前端开发工程师',
  success: true,
}

describe('M4 · 自愈事件归因与开发者待修清单 (Diagnostics Store)', () => {
  beforeEach(async () => {
    await db.open()
    await clearSelfHealingEvents()
  })

  // ─── Suite 1: 写入与读取 ───
  describe('Suite 1: recordSelfHealingEvent 写入 + listSelfHealingEvents 读取', () => {
    it('1.1 写入后返回带 id / createdAt 的完整事件', async () => {
      const rec = await recordSelfHealingEvent(baseEvent)
      expect(rec.id).toBeTruthy()
      expect(rec.createdAt).toBeTruthy()
      expect(Number.isNaN(Date.parse(rec.createdAt))).toBe(false)
      expect(rec).toMatchObject(baseEvent)
    })

    it('1.2 list 能读回完整载荷（含 failedSelector / buttonText / jobTitle）', async () => {
      await recordSelfHealingEvent(baseEvent)
      const list = await listSelfHealingEvents()
      expect(list).toHaveLength(1)
      expect(list[0]).toMatchObject(baseEvent)
    })

    it('1.3 复用 auditLogs 表：source / goal / result 字段正确，未新增 Dexie 版本', async () => {
      await recordSelfHealingEvent(baseEvent)
      const rows = await db.auditLogs.where('source').equals('self_healing').toArray()
      expect(rows).toHaveLength(1)
      expect(rows[0].source).toBe('self_healing')
      expect(rows[0].goal).toBe('button_heuristic')
      expect(rows[0].result).toBe('success')
      expect(JSON.parse(rows[0].error || '{}').id).toBeTruthy()
      // Dexie v9：新增 experiences 经验记忆表（v8 的 auditLogs 结构未改动）
      expect(db.verno).toBe(9)
    })

    it('1.4 success=false 时 result 记为 failed', async () => {
      await recordSelfHealingEvent({ ...baseEvent, success: false })
      const rows = await db.auditLogs.where('source').equals('self_healing').toArray()
      expect(rows[0].result).toBe('failed')
    })

    it('1.5 limit 生效且按时间倒序（最新在前）', async () => {
      for (let i = 0; i < 5; i++) {
        await recordSelfHealingEvent({ ...baseEvent, triggerDescription: `evt-${i}` })
        await new Promise((r) => setTimeout(r, 2))
      }
      const list = await listSelfHealingEvents(3)
      expect(list).toHaveLength(3)
      expect(list[0].triggerDescription).toBe('evt-4')
    })
  })

  // ─── Suite 2: 聚合逻辑 ───
  describe('Suite 2: getDeveloperFixSuggestions 聚合', () => {
    it('2.1 相同 platform + category 合并为 1 条，occurrences 累加', async () => {
      await recordSelfHealingEvent({ ...baseEvent, failedSelector: '.a' })
      await recordSelfHealingEvent({ ...baseEvent, failedSelector: '.b' })
      await recordSelfHealingEvent({ ...baseEvent, failedSelector: '.a' })

      const suggestions = await getDeveloperFixSuggestions()
      expect(suggestions).toHaveLength(1)
      expect(suggestions[0].key).toBe('boss::button_heuristic')
      expect(suggestions[0].occurrences).toBe(3)
    })

    it('2.2 failedSelectors / buttonTexts 去重合并', async () => {
      await recordSelfHealingEvent({ ...baseEvent, failedSelector: '.a', buttonText: '立即沟通' })
      await recordSelfHealingEvent({ ...baseEvent, failedSelector: '.b', buttonText: '聊一聊' })
      await recordSelfHealingEvent({ ...baseEvent, failedSelector: '.a', buttonText: '立即沟通' })

      const [s] = await getDeveloperFixSuggestions()
      expect(s.failedSelectors).toHaveLength(2)
      expect(s.failedSelectors).toEqual(expect.arrayContaining(['.a', '.b']))
      expect(s.buttonTexts).toHaveLength(2)
      expect(s.buttonTexts).toEqual(expect.arrayContaining(['聊一聊', '立即沟通']))
      expect(s.eventIds.length).toBeLessThanOrEqual(10)
    })

    it('2.3 不同 platform 或不同 category 分开聚合', async () => {
      await recordSelfHealingEvent(baseEvent)
      await recordSelfHealingEvent({ ...baseEvent, platform: 'liepin' })
      await recordSelfHealingEvent({ ...baseEvent, category: 'card_not_found' })

      const suggestions = await getDeveloperFixSuggestions()
      expect(suggestions).toHaveLength(3)
      expect(new Set(suggestions.map((s) => s.key)).size).toBe(3)
    })

    it('2.4 修复模板与优先级取自 CATEGORY_FIX_TEMPLATES', async () => {
      await recordSelfHealingEvent(baseEvent)
      const [s] = await getDeveloperFixSuggestions()
      expect(s.fixTitle).toBe(CATEGORY_FIX_TEMPLATES.button_heuristic.title)
      expect(s.fixDescription).toBe(CATEGORY_FIX_TEMPLATES.button_heuristic.description)
      expect(s.priority).toBe('high')
    })

    it('2.5 按 priority（critical 优先）排序，并暴露契约兼容别名', async () => {
      await recordSelfHealingEvent(baseEvent) // high
      await recordSelfHealingEvent({ ...baseEvent, category: 'button_local_fallback' }) // critical
      await recordSelfHealingEvent({ ...baseEvent, category: 'skill_circuit_breaker' }) // low

      const suggestions = await getDeveloperFixSuggestions()
      expect(suggestions[0].priority).toBe('critical')
      expect(suggestions[suggestions.length - 1].priority).toBe('low')

      expect(typeof getDiagnosticFixRecommendations).toBe('function')
      const viaAlias = await getDiagnosticFixRecommendations()
      expect(viaAlias.map((s) => s.key)).toEqual(suggestions.map((s) => s.key))
    })

    it('2.6 lastOccurredAt 取该分组最近一次触发时间', async () => {
      await recordSelfHealingEvent(baseEvent)
      await new Promise((r) => setTimeout(r, 5))
      await recordSelfHealingEvent(baseEvent)
      const [s] = await getDeveloperFixSuggestions()
      expect(s.lastOccurredAt).toBe((await listSelfHealingEvents())[0].createdAt)
    })
  })

  // ─── Suite 3: 500 条淘汰 ───
  describe('Suite 3: 超 500 条时自动淘汰最老记录', () => {
    it('3.1 写入 505 条后仅保留最近 500 条', async () => {
      for (let i = 0; i < 505; i++) {
        await recordSelfHealingEvent({ ...baseEvent, triggerDescription: `bulk-${i}` })
      }
      const rows = await db.auditLogs.where('source').equals('self_healing').toArray()
      expect(rows).toHaveLength(MAX_SELF_HEALING_EVENTS)
      expect((await listSelfHealingEvents(1000)).length).toBe(MAX_SELF_HEALING_EVENTS)

      const descriptions = (await listSelfHealingEvents(1000)).map((e) => e.triggerDescription)
      for (let i = 0; i < 5; i++) {
        expect(descriptions).not.toContain(`bulk-${i}`)
      }
      expect(descriptions).toContain('bulk-504')
    })

    it('3.2 继续写入后总量稳定在 500，不会无限增长', async () => {
      for (let i = 0; i < 520; i++) {
        await recordSelfHealingEvent({ ...baseEvent, triggerDescription: `wave-${i}` })
      }
      for (let i = 0; i < 12; i++) {
        await recordSelfHealingEvent({ ...baseEvent, triggerDescription: `extra-${i}` })
      }
      const rows = await db.auditLogs.where('source').equals('self_healing').toArray()
      expect(rows).toHaveLength(MAX_SELF_HEALING_EVENTS)
      expect((await listSelfHealingEvents(1000)).map((e) => e.triggerDescription)).toContain('extra-11')
    })
  })

  // ─── Suite 4: 清空 ───
  describe('Suite 4: clearSelfHealingEvents', () => {
    it('4.1 清空后 list 返回空数组、聚合返回空数组', async () => {
      await recordSelfHealingEvent(baseEvent)
      await clearSelfHealingEvents()
      expect(await listSelfHealingEvents()).toEqual([])
      expect(await getDeveloperFixSuggestions()).toEqual([])
    })

    it('4.2 清空不影响其他 source 的审计记录', async () => {
      await db.auditLogs.add({
        id: 'unrelated-audit',
        createdAt: new Date().toISOString(),
        source: 'popup',
        result: 'success',
      })
      await recordSelfHealingEvent(baseEvent)
      await clearSelfHealingEvents()

      expect(await db.auditLogs.get('unrelated-audit')).toBeTruthy()
      expect(await db.auditLogs.where('source').equals('self_healing').count()).toBe(0)
      await db.auditLogs.delete('unrelated-audit')
    })

    it('4.3 重复清空幂等，不抛异常', async () => {
      await expect(clearSelfHealingEvents()).resolves.toBeUndefined()
      await expect(clearSelfHealingEvents()).resolves.toBeUndefined()
    })
  })

  // ─── Suite 5: 模板覆盖 ───
  describe('Suite 5: CATEGORY_FIX_TEMPLATES 覆盖所有 SelfHealingCategory', () => {
    it('5.1 全部 9 个枚举值均有修复模板与中文标签', () => {
      expect(ALL_SELF_HEALING_CATEGORIES).toHaveLength(9)
      for (const category of ALL_SELF_HEALING_CATEGORIES) {
        const tmpl = CATEGORY_FIX_TEMPLATES[category]
        expect(tmpl).toBeDefined()
        expect(tmpl.title.length).toBeGreaterThan(0)
        expect(tmpl.description.length).toBeGreaterThan(0)
        expect(['critical', 'high', 'medium', 'low']).toContain(tmpl.priority)
        expect(CATEGORY_LABELS[category]).toBeTruthy()
      }
    })

    it('5.2 映射表无冗余、无遗漏键', () => {
      expect(Object.keys(CATEGORY_FIX_TEMPLATES).sort()).toEqual(
        [...ALL_SELF_HEALING_CATEGORIES].sort(),
      )
      expect(Object.keys(CATEGORY_LABELS).sort()).toEqual(
        [...ALL_SELF_HEALING_CATEGORIES].sort(),
      )
    })

    it('5.3 每个类别都能被成功聚合并带上有效优先级', async () => {
      for (const category of ALL_SELF_HEALING_CATEGORIES) {
        await recordSelfHealingEvent({ ...baseEvent, category })
      }
      const suggestions = await getDeveloperFixSuggestions()
      expect(suggestions).toHaveLength(ALL_SELF_HEALING_CATEGORIES.length)
      expect(suggestions.every((s) => ['critical', 'high', 'medium', 'low'].includes(s.priority))).toBe(true)
    })
  })
})
