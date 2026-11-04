# 未完成计划文档 · 自愈韧性智能体架构

> 生成时间：2026-11-05  
> 分支：`main`（当前 HEAD `d172f2d`，含未 commit 的 M1/M2 工作区修改）

---

## 一、已完成里程碑概述

### ✅ M1 — 存储层升级与技能热修复引擎

**核心成果：**
- `src/shared/db/index.ts`：Dexie v8 迁移，`agentSkills` 新增复合索引 `[platform+goal]`，存量升级脚本补齐 `patchSource` 字段
- `src/shared/agent/skill-memory.ts`：实现 `buildSelectorFingerprint`（噪声过滤 + 语义保留）、`enqueueSkillWrite`（Promise 互斥队列防并发竞态）、`findBestSkill`、`upsertSkillDirect`、`recordSkillFailDirect`（3次失败自动隔离熔断）、跨进程消息桥（Content ↔ Background）

**测试覆盖（全绿）：**
| 测试文件 | 用例数 |
|---------|--------|
| `tests/self-healing-skill.test.ts` | 26 |
| `tests/adversarial-stress-m1.test.ts` | 22 |
| `tests/adversarial-skill-memory.test.ts` | 20 |
| `tests/challenger-m1-empirical.test.ts` | — |
| `tests/challenger-m1-it2-empirical.test.ts` | — |
| `tests/challenger-m1-it3-empirical.test.ts` | — |
| `tests/challenger-m1-it3-stress.test.ts` | — |

---

### ✅ M2 — 运行时多阶弹性降级与脱困体系

**核心成果：**
- `src/shared/platform/boss/action-simulator.ts`：
  - `isNegativeButton`：严格黑名单（"不合适"、"不感兴趣"、`ka*="dislike"` 等）
  - `isPositiveApplyButton`：正面语义白名单（"立即沟通"、"继续沟通"等）
  - `clickApplyButtonWithResilience`：五阶降级（Tier 0 技能缓存 → Tier 1 预设选择器 → Tier 2 语义启发式 → Tier 3 LLM 感知 → Tier 4 本地安全回退）
  - `activateJobCardWithFallback`：三阶降级（常规定位 → 模糊多词匹配 → URL 直达）
  - `cleanCompanyNameEnhanced`：剥离"有限公司"/"分公司"等行政后缀与城市前缀
  - `dismissUnexpectedModals`：强力清除意外弹窗、半透明遮罩、`body` 滚动锁死
- `src/shared/platform/boss/index.ts`：挂载 `activateJobCardWithFallback` 至适配器接口
- `src/shared/platform/types.ts`：扩展 `PlatformAdapter` 类型
- `src/content/task-runner.ts`：
  - `cleanupUi` 改为 `export` + `adapter?` 可选 + 委托给 `dismissUnexpectedModals`
  - `executeCampaignTask` 优先调用 `activateJobCardWithFallback`

**测试覆盖（全绿）：**
| 测试文件 | 用例数 |
|---------|--------|
| `tests/self-healing-card.test.ts` | 20 |
| `tests/self-healing-button.test.ts` | 31 |
| `tests/self-healing-modal.test.ts` | 33 |
| `tests/adversarial-m2-stress.test.ts` | — |
| `tests/auditor-m2-empirical.test.ts` | 11 |
| `tests/challenger-m2-gate2.test.ts` | — |
| `tests/challenger-m2-it2-empirical.test.ts` | — |

> **M1 + M2 合计：4 个核心自愈测试文件，110 个用例，全部通过 ✅**

---

## 二、未完成里程碑详细计划

### 🔲 M3 — 任务优先保障与单岗位故障隔离

**目标：** 保证单个岗位的任何异常都不会卡死整条投递流水线；`cleanupUi` 在成功/失败两条路径上都必须执行。

**当前问题：**
`executeCampaignTask` 目前的结构是 `try { ... } catch { ... }` ——仅在 `catch` 分支里手动调用 `cleanupUi`，正常路径的 `return` 分支也有零散调用，但不是统一的 `finally`。如果中途有 `return` 遗漏调用，页面残留弹窗/遮罩不会被清理。

**任务清单：**

#### Task 3.1 — `executeCampaignTask` 加 `try-finally` 边界

文件：[`src/content/task-runner.ts`](file:///Users/pc/Desktop/zhipinzhushou/src/content/task-runner.ts)

```ts
// 目标结构
export async function executeCampaignTask(...): Promise<TaskExecutionResponse> {
  let result: TaskExecutionResponse = { taskId: task.id, status: 'failed', failReason: '未知错误' }
  try {
    // ... 全部业务逻辑（包含所有现有的 return，改为 result = {...}; return result）
    // 或将所有 return 改为赋值 result 然后统一在 finally 后 return result
  } finally {
    // 无论成功/失败/异常，始终执行现场复原
    await cleanupUi(adapter).catch(() => {})
  }
  return result
}
```

> **注意：** TypeScript 要求 `finally` 内不 `return`，主 `try` 中所有提前 `return` 改为 `result = ...; return result` 即可，`finally` 内只做清理。

#### Task 3.2 — 增强 `cleanupUi` 覆盖度

文件：[`src/content/task-runner.ts`](file:///Users/pc/Desktop/zhipinzhushou/src/content/task-runner.ts)

在当前 `dismissUnexpectedModals` 委托之外，补充：
1. `document.activeElement` 失焦（`(document.activeElement as HTMLElement)?.blur()`）
2. 恢复 `document.body.style.overflow = ''`（防止 `overflow: hidden` 锁死）
3. 移除 `position: fixed; top: 0; left: 0; width: 100%; height: 100%` 的全屏遮罩孤节点

#### Task 3.3 — 编写 `tests/self-healing-mission.test.ts`

覆盖场景：
- **Suite 1**：`try-finally` 边界：`cleanupUi` 在正常完成后调用（不抛出异常）
- **Suite 2**：`try-finally` 边界：`cleanupUi` 在 `catch` 异常后调用（不抛出异常）
- **Suite 3**：单岗位故障（点击按钮抛出）不影响下一任务执行
- **Suite 4**：`cleanupUi` 内部抛出异常时不向外冒泡（`catch(() => {})`）
- **Suite 5**：`adapter` 未传入时 `cleanupUi()` 仍然安全执行

---

### 🔲 M4 — 事后归因与管家开发者待修清单

**目标：** 把每次自愈/降级事件记录到本地库，聚合为结构化"开发者待修建议"，在管家面板新增专属视图，支持一键复制 Markdown/Issue 格式。

#### Task 4.1 — 创建 `src/shared/types/diagnostics.ts` ✅ 已完成

> **已于本次会话创建**，包含 `SelfHealingEvent`、`DeveloperFixSuggestion`、`SelfHealingCategory`、`FixPriority` 类型，以及 `CATEGORY_LABELS` 和 `CATEGORY_FIX_TEMPLATES` 友好描述映射。

文件：[`src/shared/types/diagnostics.ts`](file:///Users/pc/Desktop/zhipinzhushou/src/shared/types/diagnostics.ts)

#### Task 4.2 — 创建 `src/shared/db/diagnostics-store.ts`

```ts
// 需实现以下函数：

/** 写入一条自愈事件 */
export async function recordSelfHealingEvent(
  event: Omit<SelfHealingEvent, 'id' | 'createdAt'>
): Promise<SelfHealingEvent>

/** 查询最近 N 条自愈事件（倒序） */
export async function listSelfHealingEvents(limit = 100): Promise<SelfHealingEvent[]>

/** 聚合并返回开发者待修建议（按 platform+category 去重聚合） */
export async function getDeveloperFixSuggestions(): Promise<DeveloperFixSuggestion[]>

/** 清空所有自愈事件 */
export async function clearSelfHealingEvents(): Promise<void>
```

> **实现要点：**
> - 存储至现有 `db.auditLogs`（新增 `source: 'self_healing'` 过滤字段），或在 `db.errors` 中用 `source` 前缀区分，**避免新增 Dexie 版本号**（免得触发强制迁移）
> - 聚合逻辑：按 `platform + category` 分组，合并 `failedSelectors`/`buttonTexts` 去重，取最大 `occurrences`，从 `CATEGORY_FIX_TEMPLATES` 生成 `fixTitle/fixDescription/priority`
> - 保留最近 500 条事件，超出按 `createdAt` 淘汰最老记录

#### Task 4.3 — 在 `action-simulator.ts` 中接入 `recordSelfHealingEvent`

文件：[`src/shared/platform/boss/action-simulator.ts`](file:///Users/pc/Desktop/zhipinzhushou/src/shared/platform/boss/action-simulator.ts)

关键埋点位置（以下每处都调用 `recordSelfHealingEvent`，`success` 字段视绕过结果而定）：

| 位置 | category | 触发条件 |
|------|----------|----------|
| `activateJobCardWithFallback` Tier 2 分支 | `card_not_found` | 常规定位失败，降级为模糊分词 |
| `activateJobCardWithFallback` Tier 3 分支 | `card_not_found` | 模糊也失败，降级为 URL 直达 |
| `clickApplyButtonWithResilience` Tier 2 | `button_heuristic` | 预设选择器失效，启发式命中 |
| `clickApplyButtonWithResilience` Tier 3 | `button_llm` | 启发式未命中，LLM 感知触发 |
| `clickApplyButtonWithResilience` Tier 4 | `button_local_fallback` | LLM 也失败，本地回退 |
| `isNegativeButton` 拦截分支 | `negative_button_blocked` | 拦截到负面按钮 |
| `dismissUnexpectedModals` 命中 | `modal_dismissed` | 弹窗/遮罩被强制关闭 |

> **注意：** 埋点为异步调用，统一用 `void recordSelfHealingEvent({...}).catch(() => {})` 不阻断主链路。

#### Task 4.4 — 在 `task-runner.ts` 中接入 `task_isolated` 事件

文件：[`src/content/task-runner.ts`](file:///Users/pc/Desktop/zhipinzhushou/src/content/task-runner.ts)

在 `catch` 块记录：
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

#### Task 4.5 — Butler.tsx 新增"开发者待修清单"子视图

文件：[`src/popup/pages/Butler.tsx`](file:///Users/pc/Desktop/zhipinzhushou/src/popup/pages/Butler.tsx)

**子 Tab 名：** `'fixes'`（插入在 `'errors'` 之后）

**UI 结构：**
```
[管家对话] [日报] [进化] [策略] [决策] [异常] [待修清单]  ← 新增
                                                         ↑ 红色角标（有建议时显示数量）

─────────────────────────────────────────────────────
  🔧 开发者待修建议                     [一键复制 MD] [刷新]
  共 N 条聚合建议 · 基于运行时自愈事件自动归因
─────────────────────────────────────────────────────
  [🔴 critical] 卡片定位失败 → 降级投递          Boss · 12次
  最近触发：2026-11-05 06:10
  > 更新岗位卡片选择器：`activateJobCard` 常规选择器...
  失败选择器：li.job-card-box（8次）
  [展开详情 ↓]
─────────────────────────────────────────────────────
  [🟠 high] 按钮选择器失效 → 语义启发式           Boss · 5次
  ...
```

**一键复制 Markdown 格式示例：**
```markdown
## 开发者待修清单（自动归因）· 2026-11-05

### [CRITICAL] 卡片定位失败 → 降级投递（12次）
**平台：** Boss  
**建议：** 更新 `activateJobCard` 选择器...  
**失败选择器：** `li.job-card-box`  
```

#### Task 4.6 — 编写 `tests/self-healing-diagnostics.test.ts`

覆盖场景：
- **Suite 1**：`recordSelfHealingEvent` 写入与 `listSelfHealingEvents` 读取
- **Suite 2**：`getDeveloperFixSuggestions` 聚合逻辑（同 platform+category 合并为 1 条）
- **Suite 3**：事件数 > 500 时自动淘汰最老记录
- **Suite 4**：`clearSelfHealingEvents` 清空后 list 返回空数组
- **Suite 5**：`CATEGORY_FIX_TEMPLATES` 覆盖所有 `SelfHealingCategory` 枚举值

---

### 🔲 M5 — 全量自动化测试验收与打包验收

#### Task 5.1 — 全量测试回归

```bash
npx vitest run
```

预期：所有 47 个测试文件全部通过（包含 M3/M4 新增的 2 个）。

> **已知待处理：** `tests/e2e-self-healing.test.ts`（端到端真实 DOM 测试）当前状态未知，需人工确认或补齐 mock。

#### Task 5.2 — TypeScript 编译验收

```bash
npx tsc -b
```

预期：零 error，零 warning（`noUnusedLocals` / `noUnusedParameters` 严格模式）。

#### Task 5.3 — 生产构建验收

```bash
npm run build
```

预期：`dist/` 生成完整扩展包，无 bundle 错误，无 tree-shake 警告。

#### Task 5.4 — 提交 & 推送

```bash
git add -A
git commit -m "feat(self-healing): M3 任务故障隔离 + M4 诊断归因与开发者待修清单"
git push origin main
```

---

## 三、当前未 commit 的工作区改动清单

> 这些改动已完成但尚未 `git commit`，下次开发时需先 `git add -A && git commit`。

| 文件 | 说明 |
|------|------|
| `src/content/task-runner.ts` | M2：`cleanupUi` export + adapter 可选 + 委托 dismissUnexpectedModals；M2：优先调用 `activateJobCardWithFallback` |
| `src/shared/agent/skill-memory.ts` | M1：完整技能热修复引擎实现 |
| `src/shared/platform/boss/action-simulator.ts` | M2：五阶降级按钮点击、三阶卡片激活、负面按钮黑名单、弹窗强力脱困 |
| `src/shared/platform/boss/index.ts` | M2：挂载 `activateJobCardWithFallback` |
| `src/shared/platform/types.ts` | M2：扩展 `PlatformAdapter` 接口 |
| `src/shared/agent/butler/daily-report-generator.ts` | 小修 |
| `tests/adversarial-skill-memory.test.ts` | M1：补齐并发竞态测试 |
| `tests/adversarial-m2-stress.test.ts` | M2：新增压测 |
| `tests/auditor-m2-empirical.test.ts` | M2：新增审计验证 |
| `tests/challenger-m1-empirical.test.ts` | M1：新增挑战者验证 |
| `tests/challenger-m1-it2-empirical.test.ts` | M1：迭代2 |
| `tests/challenger-m1-it3-empirical.test.ts` | M1：迭代3 |
| `tests/challenger-m1-it3-stress.test.ts` | M1：迭代3 压测 |
| `tests/challenger-m2-gate2.test.ts` | M2：Gate 2 验收 |
| `tests/challenger-m2-it2-empirical.test.ts` | M2：迭代2 |
| `tests/self-healing-button.test.ts` | M2：按钮降级 31 用例 |
| `tests/self-healing-card.test.ts` | M2：卡片降级 20 用例 |
| `tests/self-healing-modal.test.ts` | M2：弹窗脱困 33 用例 |
| `vitest.config.ts` | 新增测试配置 |
| `src/shared/types/diagnostics.ts` | **M4：已新建（本次会话）** |

---

## 四、已知 Bug 与根因记录

| # | Bug 现象 | 根因 | 修复状态 |
|---|---------|------|---------|
| 1 | Boss 自动点击"不合适" | `op-btn-chat` 类同时用于"不合适"与"立即沟通"，旧选择器无负面过滤 | ✅ M2 修复：`isNegativeButton` 黑名单 |
| 2 | 投递队列报错"页面中未找到对应岗位卡片" | 待投队列缓存了上一页数据，页面切换后卡片 ID 失效 | ✅ M2 缓解：URL 直达 Tier 3 降级；根本修复需业务层：每次投递前强制刷新页面或重新抓取队列 |
| 3 | IndexedDB 并发写入产生幽灵重复技能记录 | 多个 `Promise.all` 并发 `upsertSkill`，`first()` 检查在写入前完成 | ✅ M1 修复：`enqueueSkillWrite` Promise 互斥队列 |
| 4 | CSS Module 噪声类（`_9xa3`）污染选择器指纹 | `NOISY_CLASS_PATTERNS` 未覆盖下划线开头的短哈希 | ✅ M1 修复：新增 `/^_[a-zA-Z0-9]+$/` 过滤规则 |
| 5 | Teamwork 子智能体因配额耗尽中止 | 多个后台子智能体消耗订阅配额后服务器重启 | ⚠️ 架构限制，非代码 Bug |

---

## 五、开发接力指南（给下一个开发者）

### 快速上手

```bash
# 1. 安装依赖
npm install

# 2. 确认当前测试状态
npx vitest run tests/self-healing-button.test.ts tests/self-healing-card.test.ts \
  tests/self-healing-modal.test.ts tests/self-healing-skill.test.ts
# 预期：110 passed

# 3. 编译检查
npx tsc -b

# 4. 先提交当前未 commit 的 M1/M2 改动
git add -A
git commit -m "feat(self-healing): M1 技能热修复 + M2 多阶弹性降级（已测试）"
git push origin main
```

### 开发 M3（约 2-3 小时）

1. 修改 `src/content/task-runner.ts`：给 `executeCampaignTask` 加 `try-finally`（见 Task 3.1）
2. 加强 `cleanupUi`（见 Task 3.2）
3. 写 `tests/self-healing-mission.test.ts`（见 Task 3.3）
4. 运行 `npx vitest run tests/self-healing-mission.test.ts` 确认通过

### 开发 M4（约 4-6 小时）

1. `src/shared/types/diagnostics.ts` ✅ 已完成
2. 创建 `src/shared/db/diagnostics-store.ts`（见 Task 4.2）
3. 在 `action-simulator.ts` 埋点（见 Task 4.3）
4. 在 `task-runner.ts` 埋点（见 Task 4.4）
5. 修改 `Butler.tsx` 添加 `fixes` 子 Tab（见 Task 4.5）
6. 写 `tests/self-healing-diagnostics.test.ts`（见 Task 4.6）

### 验收 M5

```bash
npx vitest run   # 全量，预期全绿
npx tsc -b       # 零 error
npm run build    # 零构建错误
```

---

## 六、文件结构速查

```
src/
├── content/
│   ├── index.ts                              # 消息路由 / 投递主入口
│   └── task-runner.ts                        # executeCampaignTask（M3 待改造）
├── shared/
│   ├── agent/
│   │   ├── skill-memory.ts                   # M1 ✅ 技能热修复引擎
│   │   └── types.ts                          # AgentSkill / SelectorFingerprint
│   ├── db/
│   │   ├── index.ts                          # Dexie v8 ✅
│   │   ├── diagnostics-store.ts              # M4 🔲 待创建
│   │   ├── audit-store.ts                    # 现有审计日志
│   │   └── error-store.ts                    # 现有错误日志
│   ├── platform/
│   │   ├── boss/
│   │   │   ├── action-simulator.ts           # M2 ✅ 五阶降级 + 脱困
│   │   │   └── index.ts                      # M2 ✅ 适配器挂载
│   │   └── types.ts                          # M2 ✅ 接口扩展
│   └── types/
│       ├── diagnostics.ts                    # M4 ✅ 类型定义（已创建）
│       └── ...
└── popup/
    └── pages/
        └── Butler.tsx                        # M4 🔲 待添加 fixes 子 Tab

tests/
├── self-healing-skill.test.ts               # M1 ✅ 26 用例
├── self-healing-button.test.ts              # M2 ✅ 31 用例
├── self-healing-card.test.ts               # M2 ✅ 20 用例
├── self-healing-modal.test.ts              # M2 ✅ 33 用例
├── self-healing-mission.test.ts            # M3 🔲 待创建
└── self-healing-diagnostics.test.ts        # M4 🔲 待创建
```
