// M4 · 白盒对抗压测：DB 写入失败静默降级 + 500+ 条淘汰 + 畸形载荷
// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { db } from '../src/shared/db/index'
import {
  recordSelfHealingEvent,
  listSelfHealingEvents,
  getDeveloperFixSuggestions,
  clearSelfHealingEvents,
  MAX_SELF_HEALING_EVENTS,
} from '../src/shared/db/diagnostics-store'

const base = {
  platform: 'boss',
  category: 'button_local_fallback' as const,
  triggerDescription: 'LLM 不可用，回退本地规则',
  bypassPath: 'local_heuristic_revert',
  success: true,
}

describe('M4 · 对抗压测：诊断链路绝不阻断业务', () => {
  beforeEach(async () => {
    await db.open()
    await clearSelfHealingEvents()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('Suite 1: DB 写入失败时 recordSelfHealingEvent 不抛出', () => {
    it('1.1 auditLogs.add 抛 QuotaExceededError 时仍返回完整事件', async () => {
      const spy = vi
        .spyOn(db.auditLogs, 'add')
        .mockRejectedValue(new Error('QuotaExceededError'))

      const rec = await recordSelfHealingEvent(base)
      expect(rec.id).toBeTruthy()
      expect(rec.createdAt).toBeTruthy()
      expect(rec).toMatchObject(base)
      spy.mockRestore()
    })

    it('1.2 50 次并发写入全部失败也不产生未捕获异常，且 id 唯一', async () => {
      const spy = vi.spyOn(db.auditLogs, 'add').mockRejectedValue(new Error('disk full'))
      const recs = await Promise.all(
        Array.from({ length: 50 }, () => recordSelfHealingEvent(base)),
      )
      expect(recs).toHaveLength(50)
      expect(new Set(recs.map((r) => r.id)).size).toBe(50)
      spy.mockRestore()
    })

    it('1.3 淘汰逻辑自身抛错（where 不可用）也不影响写入返回', async () => {
      const spy = vi.spyOn(db.auditLogs, 'where').mockImplementation(() => {
        throw new Error('IDB disconnected')
      })
      await expect(recordSelfHealingEvent(base)).resolves.toMatchObject(base)
      spy.mockRestore()
    })

    it('1.4 删除阶段抛错时写入仍静默降级', async () => {
      await db.auditLogs.add({
        id: 'stub-row',
        createdAt: new Date().toISOString(),
        source: 'self_healing',
        result: 'success',
        error: JSON.stringify({ id: 'stub-row', category: 'modal_dismissed' }),
      })
      const spy = vi.spyOn(db.auditLogs, 'bulkDelete').mockRejectedValue(new Error('delete denied'))
      await expect(recordSelfHealingEvent(base)).resolves.toMatchObject(base)
      spy.mockRestore()
    })
  })

  describe('Suite 2: 查询链路失败时返回安全空值', () => {
    it('2.1 where 抛错时 list / suggestions / clear 全部安全降级', async () => {
      const spy = vi.spyOn(db.auditLogs, 'where').mockImplementation(() => {
        throw new Error('IDB unavailable')
      })
      expect(await listSelfHealingEvents()).toEqual([])
      expect(await getDeveloperFixSuggestions()).toEqual([])
      await expect(clearSelfHealingEvents()).resolves.toBeUndefined()
      spy.mockRestore()
    })

    it('2.2 JSON 畸形行被过滤，不会让 list 崩溃', async () => {
      await db.auditLogs.add({
        id: 'corrupt-row',
        createdAt: new Date().toISOString(),
        source: 'self_healing',
        goal: 'unknown',
        result: 'failed',
        error: '{ this is not json',
      })
      await recordSelfHealingEvent(base)
      const list = await listSelfHealingEvents()
      expect(list).toHaveLength(1)
      expect(list[0]).toMatchObject(base)
    })

    it('2.3 缺少可选字段的历史行仍可聚合', async () => {
      await db.auditLogs.add({
        id: 'legacy-row',
        createdAt: new Date().toISOString(),
        source: 'self_healing',
        result: 'failed',
        error: JSON.stringify({
          id: 'legacy-row',
          createdAt: new Date().toISOString(),
          platform: 'boss',
          category: 'task_isolated',
          triggerDescription: 'legacy',
          bypassPath: 'skip',
          success: false,
        }),
      })
      const suggestions = await getDeveloperFixSuggestions()
      expect(suggestions).toHaveLength(1)
      expect(suggestions[0].occurrences).toBe(1)
      expect(suggestions[0].failedSelectors).toEqual([])
      expect(suggestions[0].buttonTexts).toEqual([])
    })
  })

  describe('Suite 3: 500+ 条淘汰逻辑', () => {
    it('3.1 写入 510 条后总量严格收敛到 500，且保留最新记录', async () => {
      for (let i = 0; i < 510; i++) {
        await recordSelfHealingEvent({ ...base, triggerDescription: `stress-${i}` })
      }
      expect(await db.auditLogs.where('source').equals('self_healing').count()).toBe(
        MAX_SELF_HEALING_EVENTS,
      )
      const all = await listSelfHealingEvents(1000)
      expect(all).toHaveLength(MAX_SELF_HEALING_EVENTS)
      expect(all.map((e) => e.triggerDescription)).toContain('stress-509')
      expect(all.map((e) => e.triggerDescription)).not.toContain('stress-0')
    })

    it('3.2 淘汰后聚合结果仍然正确', async () => {
      for (let i = 0; i < 505; i++) {
        await recordSelfHealingEvent({ ...base, triggerDescription: `agg-${i}` })
      }
      const suggestions = await getDeveloperFixSuggestions()
      expect(suggestions).toHaveLength(1)
      expect(suggestions[0].occurrences).toBe(MAX_SELF_HEALING_EVENTS)
    })

    it('3.3 并发 50 次写入不产生主键冲突', async () => {
      const recs = await Promise.all(
        Array.from({ length: 50 }, (_, i) =>
          recordSelfHealingEvent({ ...base, triggerDescription: `parallel-${i}` }),
        ),
      )
      expect(new Set(recs.map((r) => r.id)).size).toBe(50)
      expect(await db.auditLogs.where('source').equals('self_healing').count()).toBe(50)
    })
  })

  describe('Suite 4: 极端载荷与未知类别', () => {
    it('4.1 特殊字符 / emoji / 超长文本 JSON 往返无损', async () => {
      const weird = `引号" 反斜杠\\ 换行\n emoji 🦇 <script>alert(1)</script> ${'x'.repeat(5000)}`
      await recordSelfHealingEvent({ ...base, triggerDescription: weird })
      const [row] = await listSelfHealingEvents()
      expect(row.triggerDescription).toBe(weird)
    })

    it('4.2 未知 category 使用兜底模板，不导致聚合崩溃', async () => {
      await recordSelfHealingEvent({
        ...base,
        category: 'unknown_future_category' as unknown as typeof base.category,
      })
      const suggestions = await getDeveloperFixSuggestions()
      expect(suggestions).toHaveLength(1)
      expect(suggestions[0].fixTitle).toContain('未知')
      expect(suggestions[0].priority).toBe('low')
    })

    it('4.3 success=false 与空 platform 不污染聚合', async () => {
      await recordSelfHealingEvent({
        platform: '',
        category: 'task_isolated',
        triggerDescription: 'no platform',
        bypassPath: 'skip_and_continue',
        success: false,
      })
      const suggestions = await getDeveloperFixSuggestions()
      expect(suggestions).toEqual([])
    })
  })
})
