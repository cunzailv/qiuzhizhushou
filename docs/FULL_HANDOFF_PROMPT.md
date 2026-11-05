# 完整交接提示词（一键启动）

> 把下面「---START---」到「---END---」之间的全部内容，直接粘贴给新会话的 `/teamwork` 或单智能体 AI。

---

---START---

## 项目背景

我正在开发一个 Chrome 扩展——智能求职助手（qiuzhizhushou），帮助用户在 Boss 直聘、猎聘、51job 等平台自动投简历。

**代码仓库：** `/Users/pc/Desktop/zhipinzhushou`
**Git 仓库：** `git@github.com:cunzailv/qiuzhizhushou.git`（main 分支）
**技术栈：** TypeScript + React + Vite + Dexie (IndexedDB) + Chrome Extension Manifest V3
**测试框架：** Vitest

---

## 已完成工作（请勿重复开发）

我们已经完成了「自愈韧性智能体架构」的 M1 和 M2：

### M1 — 技能热修复引擎（已完成 ✅）
- `src/shared/agent/skill-memory.ts`：选择器指纹提取、Promise 互斥写队列（防并发竞态）、技能沉淀/检索、熔断保护（failCount >= 3）、跨进程消息桥
- `src/shared/db/index.ts`：Dexie v8，agentSkills 新增 `[platform+goal]` 复合索引
- 测试：`tests/self-healing-skill.test.ts`（26用例）、`tests/adversarial-stress-m1.test.ts`、`tests/adversarial-skill-memory.test.ts`

### M2 — 多阶弹性降级与脱困（已完成 ✅）
- `src/shared/platform/boss/action-simulator.ts`：
  - `isNegativeButton`：严格黑名单（"不合适"/"不感兴趣"/`ka*="dislike"` 等，绝不误点）
  - `isPositiveApplyButton`：正面语义白名单（"立即沟通"/"继续沟通"等）
  - `clickApplyButtonWithResilience`：五阶降级（Tier0 技能缓存 → Tier1 预设选择器 → Tier2 语义启发式 → Tier3 LLM感知 → Tier4 本地安全回退）
  - `activateJobCardWithFallback`：三阶降级（常规定位 → 模糊多词匹配 → URL直达）
  - `dismissUnexpectedModals`：强力清除意外弹窗/遮罩/body滚动锁死
- `src/shared/platform/types.ts`：扩展 PlatformAdapter 接口
- `src/content/task-runner.ts`：cleanupUi 改为 export + adapter? 可选
- 测试：`tests/self-healing-button.test.ts`（31用例）、`tests/self-healing-card.test.ts`（20用例）、`tests/self-healing-modal.test.ts`（33用例）

**当前测试基线：4个核心自愈测试文件，110个用例，全部通过。**

验证基线命令：
```bash
cd /Users/pc/Desktop/zhipinzhushou
npx vitest run tests/self-healing-skill.test.ts tests/self-healing-button.test.ts tests/self-healing-card.test.ts tests/self-healing-modal.test.ts
# 预期：110 passed
```

---

## 待完成工作（本次任务）

详细计划见 `docs/UNFINISHED_PLAN.md`，以下是核心任务清单：

---

### M3 — 任务优先保障与单岗位故障隔离

**目标：** 保证单个岗位的任何异常都不会卡死整条投递流水线。

**Task 3.1** — 修改 `src/content/task-runner.ts`

给 `executeCampaignTask` 加 `try-finally` 边界：
```ts
export async function executeCampaignTask(...): Promise<TaskExecutionResponse> {
  let result: TaskExecutionResponse = { taskId: task.id, status: 'failed', failReason: '未知错误' }
  try {
    // 全部现有业务逻辑
    // 所有 return 改为：result = { taskId: task.id, status: 'xxx', ... }; return result
    result = { taskId: task.id, status: 'done', ... }
    return result
  } catch (err) {
    logError(MOD, 'executeCampaignTask', err)
    reportRunnerError({ ... })
    result = { taskId: task.id, status: 'failed', failReason: `任务执行异常: ${String(err)}` }
    return result
  } finally {
    // 无论成功/失败/异常，始终执行现场复原，不阻断主链路
    await cleanupUi(adapter).catch(() => {})
  }
}
```

**Task 3.2** — 加强 `cleanupUi`，在 `dismissUnexpectedModals` 之外补充：
```ts
// 恢复 body 滚动锁死
if (typeof document !== 'undefined') {
  document.body.style.overflow = ''
  // 失焦当前活跃元素（防止键盘焦点卡在弹窗内）
  ;(document.activeElement as HTMLElement)?.blur?.()
}
```

**Task 3.3** — 新建 `tests/self-healing-mission.test.ts`，覆盖：
- Suite 1：try-finally 正常路径：cleanupUi 在成功后调用
- Suite 2：try-finally 异常路径：cleanupUi 在 catch 后调用
- Suite 3：单岗位异常（点击按钮抛出）不影响下一任务执行
- Suite 4：cleanupUi 内部异常不向外冒泡（.catch(() => {}) 保护）
- Suite 5：adapter 未传入时 cleanupUi() 安全返回

---

### M4 — 事后归因与管家开发者待修清单

**Task 4.1** — 类型定义 `src/shared/types/diagnostics.ts` ✅ **已完成**（本轮已创建，直接复用）

**Task 4.2** — 新建 `src/shared/db/diagnostics-store.ts`

```ts
import { db } from './index'
import type { SelfHealingEvent, DeveloperFixSuggestion } from '../types/diagnostics'
import { CATEGORY_FIX_TEMPLATES } from '../types/diagnostics'

function generateId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6) }

// 存储复用 auditLogs 表，source 固定为 'self_healing'，避免新增 Dexie 版本号
export async function recordSelfHealingEvent(
  event: Omit<SelfHealingEvent, 'id' | 'createdAt'>
): Promise<SelfHealingEvent> {
  const record: SelfHealingEvent = { ...event, id: generateId(), createdAt: new Date().toISOString() }
  try {
    // 序列化存入 auditLogs（source='self_healing'，goal=category，error=JSON.stringify(event)）
    await db.auditLogs.add({
      id: record.id,
      createdAt: record.createdAt,
      source: 'self_healing',
      platform: event.platform,
      goal: event.category,
      result: event.success ? 'success' : 'failed',
      error: JSON.stringify(record),
    })
    // 超 500 条淘汰最老记录
    const all = await db.auditLogs.where('source').equals('self_healing').toArray()
    if (all.length > 500) {
      all.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      const toDelete = all.slice(0, all.length - 500)
      for (const r of toDelete) await db.auditLogs.delete(r.id)
    }
  } catch { /* 诊断失败不阻断业务 */ }
  return record
}

export async function listSelfHealingEvents(limit = 100): Promise<SelfHealingEvent[]> {
  try {
    const rows = await db.auditLogs.where('source').equals('self_healing')
      .reverse().limit(limit).toArray()
    return rows.map(r => {
      try { return JSON.parse(r.error || '{}') as SelfHealingEvent }
      catch { return null }
    }).filter(Boolean) as SelfHealingEvent[]
  } catch { return [] }
}

export async function getDeveloperFixSuggestions(): Promise<DeveloperFixSuggestion[]> {
  const events = await listSelfHealingEvents(500)
  const map = new Map<string, DeveloperFixSuggestion>()
  for (const e of events) {
    const key = `${e.platform}::${e.category}`
    const existing = map.get(key)
    const tmpl = CATEGORY_FIX_TEMPLATES[e.category]
    if (!existing) {
      map.set(key, {
        key, platform: e.platform, category: e.category,
        occurrences: 1, lastOccurredAt: e.createdAt,
        fixTitle: tmpl.title, fixDescription: tmpl.description, priority: tmpl.priority,
        failedSelectors: e.failedSelector ? [e.failedSelector] : [],
        buttonTexts: e.buttonText ? [e.buttonText] : [],
        eventIds: [e.id],
      })
    } else {
      existing.occurrences++
      if (e.createdAt > existing.lastOccurredAt) existing.lastOccurredAt = e.createdAt
      if (e.failedSelector && !existing.failedSelectors.includes(e.failedSelector))
        existing.failedSelectors.push(e.failedSelector)
      if (e.buttonText && !existing.buttonTexts.includes(e.buttonText))
        existing.buttonTexts.push(e.buttonText)
      if (existing.eventIds.length < 10) existing.eventIds.push(e.id)
    }
  }
  return Array.from(map.values()).sort((a, b) => {
    const order = { critical: 0, high: 1, medium: 2, low: 3 }
    return order[a.priority] - order[b.priority]
  })
}

export async function clearSelfHealingEvents(): Promise<void> {
  try {
    await db.auditLogs.where('source').equals('self_healing').delete()
  } catch { /* ignore */ }
}
```

**Task 4.3** — 在 `src/shared/platform/boss/action-simulator.ts` 埋点

在以下 7 处加入 `void recordSelfHealingEvent({...}).catch(() => {})` 调用（不阻断主链路）：

| 位置函数 | category | 触发条件 |
|---------|----------|---------|
| `activateJobCardWithFallback` Tier2分支 | `card_not_found` | 常规定位失败，模糊分词命中 |
| `activateJobCardWithFallback` Tier3分支 | `card_not_found` | 模糊也失败，URL直达 |
| `clickApplyButtonWithResilience` Tier2 | `button_heuristic` | 预设选择器失效，启发式命中 |
| `clickApplyButtonWithResilience` Tier3 | `button_llm` | 启发式未命中，LLM感知 |
| `clickApplyButtonWithResilience` Tier4 | `button_local_fallback` | LLM失败，本地回退 |
| `isNegativeButton` 拦截分支 | `negative_button_blocked` | 拦截到负面按钮 |
| `dismissUnexpectedModals` 命中分支 | `modal_dismissed` | 弹窗/遮罩被关闭 |

**Task 4.4** — 在 `src/content/task-runner.ts` 的 catch 块加入：
```ts
void recordSelfHealingEvent({
  platform: task.platform,
  category: 'task_isolated',
  triggerDescription: String(err),
  bypassPath: 'skip_and_continue',
  taskId: task.id,
  jobTitle: task.jobTitle,
  success: false,
}).catch(() => {})
```

**Task 4.5** — 修改 `src/popup/pages/Butler.tsx`

1. subTab 类型添加 `'fixes'`
2. 在"异常"Tab 按钮后面添加"待修清单"Tab 按钮（有建议时显示红色数量角标）
3. 新增 `{subTab === 'fixes' && (...)}`视图：
   - 标题栏：「🔧 开发者待修清单」+ 记录数 + 一键复制 Markdown 按钮 + 刷新按钮
   - 建议卡片列表（按 priority 排序）：显示优先级色块、标题、平台、次数、最近触发时间、说明、失败选择器
   - 一键复制生成 Markdown 格式（适合直接贴到 GitHub Issue）
4. `useEffect` 中当 `subTab === 'fixes'` 时调用 `getDeveloperFixSuggestions()`

**Task 4.6** — 新建 `tests/self-healing-diagnostics.test.ts`，覆盖：
- Suite 1：recordSelfHealingEvent 写入 + listSelfHealingEvents 读取
- Suite 2：getDeveloperFixSuggestions 聚合（同 platform+category 合并为 1 条）
- Suite 3：超 500 条时自动淘汰最老记录
- Suite 4：clearSelfHealingEvents 后 list 返回空数组
- Suite 5：CATEGORY_FIX_TEMPLATES 覆盖所有 SelfHealingCategory 枚举值

---

### M5 — 全量验收与提交

```bash
# 全量测试（预期全绿）
npx vitest run

# TypeScript 编译（预期零 error）
npx tsc -b

# 生产构建（预期零错误）
npm run build

# 提交
git add -A
git commit -m "feat(self-healing): M3 故障隔离 + M4 诊断归因与开发者待修清单 + M5 全量验收"
git push origin main
```

---

## 团队角色分工（如使用 /teamwork）

**Architect**
- 先读 `docs/UNFINISHED_PLAN.md` 和 `PROJECT.md`
- 制定每个里程碑的实现方案，协调分工，审查最终输出
- 确认所有实现符合 `PROJECT.md` 中的接口契约

**Implementer-Core**
- 负责：`src/content/task-runner.ts`（M3）、`src/shared/db/diagnostics-store.ts`（M4）、`src/shared/platform/boss/action-simulator.ts` 埋点（M4）
- 每完成一个文件运行 `npx tsc -b` 确认无编译错误

**Implementer-UI**
- 负责：`src/popup/pages/Butler.tsx` 添加"待修清单"Tab（M4 Task 4.5）
- 完成后运行 `npm run build` 确认无构建错误

**Tester**
- 负责：新建 `tests/self-healing-mission.test.ts`（M3）和 `tests/self-healing-diagnostics.test.ts`（M4）
- 每个文件完成后运行对应的 `npx vitest run tests/<file>`

**Reviewer**
- 检查 try-finally 结构（TypeScript 不允许 finally 里 return）
- 检查所有埋点调用均有 `.catch(() => {})` 防止诊断异常外溢
- 检查 diagnostics-store 复用 auditLogs 表，无新增 Dexie 版本号
- 确认全量 `npx vitest run` 不新增任何失败

**Auditor**
- 新建 `tests/adversarial-m3-stress.test.ts`：测试 cleanupUi 并发安全、异常不外溢
- 新建 `tests/adversarial-m4-stress.test.ts`：测试 DB 写入失败时 recordSelfHealingEvent 不抛出、500+条淘汰逻辑

---

## 验收标准

- [ ] `npx vitest run tests/self-healing-mission.test.ts` 全绿
- [ ] `npx vitest run tests/self-healing-diagnostics.test.ts` 全绿
- [ ] `npx vitest run`（全量，含原有 110 个用例）全绿
- [ ] `npx tsc -b` 零 error
- [ ] `npm run build` 零构建错误
- [ ] `git push origin main` 成功

---END---
