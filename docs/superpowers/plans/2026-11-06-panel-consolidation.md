# 2026-11-06 侧栏正文收敛：去掉小浮窗、概览批量沟通台、半自动/全自动互斥

## 0. 需求原文与合理性判断

1. **不要悬浮窗了**
2. **概览内容中的「最近投递」不要了，改成悬浮窗内容，就是批量沟通那些**
3. **分清楚概览的「开始沟通」和 AIbot 的「悬浮窗配置」是互斥的**：概览是半自动，AIbot 是全自动
4. **「沟通筛选条件」是两边通用的吗？**

### 合理性判断

| # | 判断 | 依据 |
|---|---|---|
| 1 | ✅ 合理 | 现在有 `expanded / floating / bubble` 三级，用户实际只需要「整高侧栏 ⇄ 半圆浮球」两态；400×620 小浮窗是上一轮按错误理解加的，属于多余中间态 |
| 2 | ✅ 合理，且能顺手减重复 | 「最近投递」与「追踪」页是同一份数据（`getAllApplications().slice(0,5)`），概览重复展示意义不大；换成批量沟通控制台后，概览变成「配置 + 执行 + 进度」的完整工作台 |
| 3 | ✅ **必须做，现状是真 bug** | 两条链路各用各的运行标志：半自动用 content 里的局部变量 `isApplying`，全自动用 `campaignTaskCancelled` + background 的 campaign.status。二者互不感知，同一标签页**可以同时跑两套流水线**，会抢 DOM、重复打招呼 |
| 4 | ⚠️ **半通用，需补齐** | 见下表 |

### 第 4 点：筛选条件通用性现状（代码实测）

| 筛选项 | 概览半自动 `EXECUTE_APPLY` | AIbot 全自动 `START_CAMPAIGN` → `campaign-service.ts` | 共用？ |
|---|---|---|---|
| 岗位名称 / 工作地点 / 薪资 / 经验 / 学历 / 排除词 / 发布时间 | 直接随 payload 传 `ApplyFilters` | 从 `chrome.storage.local` 读同一批 `filter*` 键 | ✅ 共用 |
| `enableAiMatch`（AI 评分开关） | 用 `filters.enableAiMatch` | **硬编码 `enableAiMatch: true`**（`campaign-service.ts:350`） | ❌ |
| `minMatchScore`（最低匹配分） | 用 `filters.minMatchScore` | **硬编码 `60`**（`campaign-service.ts:351`） | ❌ |
| AIbot 页「⭐ 按分筛选 / 🚀 不评分沟通」 | 无关 | 写 `setting_enableAiMatch`（`AssistantControlState`），与 `filterEnableAiMatch` 是**两个键** | ❌ 两套状态 |

结论：改一处筛选，AI 评分相关两项不会同步到 AIbot；反过来改 AIbot 的评分开关也不会影响概览。本次一并把评分配置收敛到单一真源。

---

## 1. 目标态

**形态两态**：点插件图标 / 点浮球 → 整高侧栏（正文 = 完整助手面板）；点 × → 半圆浮球。不再有小浮窗、不再有拖动脱离。

**概览页结构**（从上到下）：
1. 标题行 + 当前运行模式徽标 + 「开始沟通 / 停止」按钮（半自动）
2. 沟通筛选条件（保持）
3. 统计卡片（保持）
4. **【替换「最近投递」】批量沟通控制台**：状态、进度、匹配推荐、今日剩余额度、模式（批量沟通 / AI自动确认）、评分（按分筛选 / 不评分沟通）、启动/停止、最近匹配结果列表

**互斥契约**：全局任意时刻只能有一个运行模式 `manual`（半自动）或 `autopilot`（全自动），由 background 原子仲裁。

**筛选条件**：所有字段两边共用同一份设置，AI 评分开关与最低分不再硬编码。

---

## 2. 实施步骤

### Phase A — 形态收敛（去掉小浮窗）

| 文件 | 改动 |
|---|---|
| `src/shared/assistant-state.ts` | `PanelState` 去掉 `floating` → `expanded \| bubble \| collapsed \| closed`；`normalizeInitialPanelState()` 把残留 `floating` 归一为 `expanded` |
| `src/content/inject-ui.tsx` | 删 `FLOATING_WIDTH` / `FLOATING_HEIGHT` / `applyFloatingLayout()` / `detachSidebarToFloating()`；`setPanelState()` 去掉 floating 分支；`createFloatingTrigger()` 目标统一为 `expanded`；拖动标题栏改为禁用（`cursor: default`，`installPanelDragging` 不再调用 detach）；`btn-close` 文案改「收起为浮球」、浮球 title 改「展开侧栏」 |
| `src/content/index.ts` | `SET_PANEL_STATE` 白名单去掉 `floating`；`toggleAssistantPanelPresence()` 仍为 `expanded ⇄ bubble` |
| `src/background/external-ai-rpc.ts` / `src/shared/bridge/tools.ts` | 联合类型与文案去掉 `floating` |
| `src/popup/components/CampaignPanel.tsx` | 「面板形态」三格改两格（整高侧栏 / 半圆浮球）+ 停止 |
| 测试 | `assistant-control.test.ts`：浮球点击期望 `expanded`（宽度 440）；`extension-flow.test.ts`：期望宽度 440，去掉 400 断言 |

### Phase B — 统一运行状态与互斥锁（核心）

新增 `src/shared/runtime-state.ts`（单一真源，`chrome.storage.local` 的 `setting_*`）：

```ts
export type RunMode = 'idle' | 'manual' | 'autopilot'
export interface AssistantRuntimeState {
  mode: RunMode                  // 互斥锁
  status: 'idle'|'scanning'|'matching'|'applying'|'paused'|'done'
  stats?: { processed: number; total: number; matched: number }
  message?: string
  dailyRemaining?: number
  startedAt?: number
}
```

- `acquireRunMode(mode)` / `releaseRunMode(mode)` / `patchRuntimeState()` / `subscribeRuntimeState()`，全部走 `chrome.storage.local` 与 `onChanged` 订阅（与 `assistant-state.ts` 同套路）。
- `background/index.ts` 提供消息 `RUNTIME_ACQUIRE { mode }` → `{ ok, conflict? }`，`RUNTIME_RELEASE { mode }`，`RUNTIME_PATCH`。写入前二次读取校验，避免竞态。
- **概览启动** `App.handleStartApply`：先 `RUNTIME_ACQUIRE(manual)`；冲突（autopilot）→ toast「AIbot 全自动正在运行，请先在 AIbot 页终止」，按钮 disabled。成功后发 `EXECUTE_APPLY`；收到 `APPLY_ENDED` 释放。
- **AIbot 启动** `CampaignPanel.handleStart`：先 `RUNTIME_ACQUIRE(autopilot)`；冲突（manual）→ toast「概览的半自动沟通正在运行，请先停止」。终止/暂停/异常结束时释放。
- **兜底二次校验**：`content/index.ts` 的 `EXECUTE_APPLY` 与 `EXECUTE_CAMPAIGN_TASK` 入口各查一次 runtime.mode，不属于自己的模式直接拒绝，防止绕过 popup。
- UI 双向提示：概览顶部显示「🤖 AIbot 全自动运行中，半自动已锁定」；AIbot 顶部显示「✋ 概览半自动沟通中，全自动已锁定」。

### Phase C — 概览批量沟通控制台

新增 `src/popup/components/BatchControlCard.tsx`（替换 Dashboard 里的「最近投递」块）：
- 订阅 `subscribeRuntimeState()` 显示状态 / 进度条 / 匹配推荐 / 今日剩余额度 / 提示语。
- 模式切换 `applyMode: batch | recommend`、评分切换 `enableAiMatch`：都写 `setting_*`，与 content 的 `loadApplyDefaultsFromSettings()` / `syncFromAssistantState()` 对齐。
- 开始/停止按钮复用 `onStartApply(filters)` / `onStopApply()`，并根据 `runtime.mode === 'autopilot'` 禁用。
- 最近匹配结果：先做空态 + 前 3 条（数据来自 runtime.stats/message），不做完整列表（完整列表在「追踪」页）。
- `Dashboard.tsx`：删除 `recentApps` / `getAllApplications` / `formatRelativeTime` / `getStatusBadge` / `renderScore` / `openJobDetail` 与「最近投递」 DOM，保留统计卡与筛选。

### Phase D — 筛选条件彻底通用

- `src/background/campaign-service.ts:341-352`：`enableAiMatch` 改读 `getSetting<boolean>('enableAiMatch', true)`，`minMatchScore` 改读 `getSetting<number>('filterMinMatchScore', 60)`，删除硬编码。
- `Dashboard.handleFilterChange`：写 `filterEnableAiMatch` 时同步写 `enableAiMatch`；写 `filterMinMatchScore` 时同步 `patchAssistantState({ enableAiMatch })`，让 AIbot 页开关同步。
- `CampaignPanel` 的「AI 评分」开关：同步写 `setting_filterEnableAiMatch`，保证两个入口一致。
- AIbot 页「投递模式 / AI 评分」区上方加一行说明：「沟通筛选条件与概览共用，去「概览 → 沟通筛选条件」修改」。
- 概览筛选卡片也加一行「此配置同时作用于 AIbot 全自动流水线」。

### Phase E — 文档与验证

- `README.md` F 层、`CHANGELOG.md` Unreleased 同步；计划文档标注完成状态。
- 验证链：`npx tsc -b` → `npm run lint` → `CI=1 SKIP_BROWSER_E2E=1 npx vitest run tests` → `npx vite build` → 真机 Chromium 截图（侧栏 / 浮球 / 概览页）→ 互斥场景实测（先开半自动再点 AIbot 启动，应被拒；反之亦然）。

---

## 3. 风险与取舍

- **runtime 状态与两处旧标志并存**：`isApplying` / `campaignTaskCancelled` 保留为页面内短路保护，不删，避免大范围重构；互斥以 runtime.mode 为准。
- **iframe 里的 popup 与 background 通信**：`chrome.runtime.sendMessage` / `chrome.storage.onChanged` 在 iframe 内可用（已验证同源扩展页），无需 postMessage 桥。
- **异常退出残留锁**：`APPLY_ENDED` / campaign abort 释放；另加 `startedAt` 超过 2 小时视为陈旧锁，允许抢占，避免刷新后永久锁死。
- **不改动已有投递算法**：本次只动形态、UI、状态仲裁与配置读取，不碰 `startApply` / `executeCampaignTask` 的扫描与点击逻辑。

## 4. 验收口径

| 项 | 期望 |
|---|---|
| 形态 | 只有整高侧栏 ⇄ 半圆浮球；无 400×620 小浮窗；拖标题栏不再脱离 |
| 概览 | 无「最近投递」；有批量沟通控制台，状态/进度/模式/评分/开始停止齐全 |
| 互斥 | 半自动运行时 AIbot 启动被拒且按钮禁用；全自动运行时概览开始被拒且按钮禁用 |
| 筛选 | 概览改 AI 评分 / 最低分，AIbot 流水线实际生效；AIbot 改评分开关，概览显示同步 |
| 回归 | 全量单测、面板 E2E、tsc、lint、build 全绿 |

---

## 5. 完成状态（实施记录）

| Phase | 状态 | 实际落地 |
|---|---|---|
| A 形态收敛 | ✅ 完成 | `PanelState` 去掉 `floating`；删除拖动脱离 / 小浮窗 / 视口夹取；`external-ai-rpc` 与 `bridge/tools` 文案同步；`assistant-control.test.ts` 13 例与 `extension-flow.test.ts` 拖拽回归通过 |
| B 互斥锁 | ✅ 完成 | 新增 `shared/runtime-state.ts`（含 `recentMatches` 与 `reportBatchProgress`）；background 4 个 RUNTIME 消息 + `START_CAMPAIGN` 二次校验；App / CampaignPanel 接锁；content 在 `EXECUTE_APPLY` / `EXECUTE_CAMPAIGN_TASK` 做冲突拦截并在收尾释放锁；暂停让锁 / 恢复抢锁 / 自然完成释放；新增 18 例单测 |
| C 批量沟通控制台 | ✅ 完成 | 新增 `popup/components/BatchControlCard.tsx`；`Dashboard.tsx` 删除「最近投递」及相关 imports / helpers；content 在扫描 / 匹配 / 沟通 / 结束各阶段上报进度与最近 3 条匹配 |
| D 筛选通用 | ✅ 完成 | 新增 `shared/agent/filter-config.ts` 作为单一真源（读 + 写），`campaign-service.ts` / `Dashboard.tsx` / `CampaignPanel.tsx` 全部改走它；两处 UI 增加「配置共用」说明；新增 8 例单测 |
| E 文档与验证 | ✅ 完成 | README F 层、CHANGELOG Unreleased、本计划同步；`tsc -b` / `lint` / 全量单测 / `vite build` / 10 个浏览器 E2E 套件通过；真机截图确认控制台渲染 |

### 最终验证结果

| 命令 | 结果 |
|---|---|
| `npx tsc -b` | 0 error |
| `npm run lint` | 0 error（42 个既有 `no-explicit-any` warnings） |
| `CI=1 SKIP_BROWSER_E2E=1 npx vitest run tests` | Phase A–E 时 **52 文件 / 803 用例全绿**；补做「入口修复」后为 **53 文件 / 819 用例全绿**（新增 `assistant-entry.test.ts` 16 例） |
| `npx vite build --emptyOutDir false` | 成功（仅 `Resumes` chunk > 500 kB 的既有警告） |
| 浏览器 E2E（10 套件，分批跑） | `extension-flow` 12/12、`aibot-browser-e2e` 1/1、`liepin-flow` 2/2、`butler-flow` 1/1、`e4-options` 3/3、`f2-agent-ui` 4/4、`e3-confirm-ui` 1/1、`g1-memory-ui`+`h2-h5-ui`+`multi-platform-flow` 9/9 |
| 真机截图 | `/tmp/qzzs_dashboard_card.png`：状态胶囊 / 进度条 / 三数 / 模式 / 评分 / 开始停止 / 最近匹配空态全部清晰，无拥挤或裁切 |

> 注：一次性把 10 个 headed Chromium 套件放进同一个 vitest 进程会触发 WorkBuddy 的 `node-brokered-fs-shim` 资源错误导致 worker 崩溃，分批运行即可全绿；与代码无关。
>
> 另修一处**既有回归**：`tests/e3-confirm-ui.test.ts` 仍按「可见」断言旧内联确认卡片，而 iframe 侧栏改造后该卡片位于隐藏容器 `#panel-legacy`。改为按「已挂载」断言 + `dispatchEvent('click')` 触发，与 `extension-flow.test.ts` 的既有做法一致，仍验证 `requestUserConfirm` / `settleConfirm` 链路。

### 实施中对原计划的调整（有意为之）

1. **content 二次校验改为「只拦真实冲突」**：原计划要求 `EXECUTE_APPLY` 必须持有 `manual` 锁，但浏览器 E2E 与网页浮窗旧入口会直接派发 `EXECUTE_APPLY`（不经过 popup）。强制持锁会让 6 个 E2E 用例全部失败，也会破坏旧入口。改为：仅当 `runtime.mode === 'autopilot'` 时拒绝；`EXECUTE_CAMPAIGN_TASK` 仅当 `runtime.mode === 'manual'` 时拒绝。互斥语义不变，兼容性更好。
2. **暂停 / 恢复纳入锁生命周期**：原计划未细化。最终为 `PAUSE_CAMPAIGN` 释放 autopilot 锁，`RESUME_CAMPAIGN` 重新申请（半自动运行时拒绝），campaign 自然完成也释放，避免「暂停后锁死概览」或「恢复后两条流水线并行」。
3. **进度上报真实化**：原计划只做「空态 + 前 3 条」。最终让 content 在 `startApply` 各阶段写 `reportBatchProgress`，控制台展示的是真实进度而非占位数据。
4. **开跑 AIbot 不再收起侧栏**：旧逻辑会把面板写成 `bubble`，但侧栏正文现在就是完整面板（含实时日志），收起会让用户看不到运行过程，改为保持 `expanded`。
5. **评分配置收敛为独立模块**：从「两边各自读同一批键」升级为共享 loader / persister，便于单测直接证明「写后即读一致」。

---

## 6. 后续修复：点击图标跳后台、后台回不来（用户实测反馈）

> 用户原话：「怎么一点击跳到后台了，而且到了后台回不来了」

### 根因

```
chrome.action.onClicked
  └─ toggleAssistantPanelInTab(tabId) 失败
       └─ chrome.tabs.create('src/options/index.html')   ← 无条件兜底
            └─ 后台页是 chrome-extension://，content script 注入不了
                 └─ 再点图标 → 又开一个后台页（死循环）
```
后台页自身没有任何「返回助手」入口，用户被彻底困住。

### 修复原则

**任何不可注入 / 注入失败的场景都统一回到助手，绝不再跳后台。** 并从依赖签名上移除「打开后台」这个能力，让同类 bug 无法再被写回来：`AssistantEntryDeps` 只有 `tryToggleSidebar` 与 `openAssistantPanel` 两个函数。

### 落地

| 文件 | 改动 |
|---|---|
| `src/shared/assistant-entry.ts` | 新增：`canHostSidebar`（只认非扩展源的 http(s)）、`planAssistantEntry`、`runAssistantEntry`、`findJobSiteTabId`、`findAssistantTabId` |
| `src/background/index.ts` | `chrome.action.onClicked` 改走 `runAssistantEntry`；新增 `POPUP_PAGE_URL` / `extensionOrigin()` / `focusOrCreateAssistantPanel()` / `openJobSiteWithSidebar()`；新增 `OPEN_ASSISTANT_PANEL`、`OPEN_SIDEBAR_ON_JOB_SITE`；`OPEN_ASSISTANT_SIDEBAR` 失败回退到招聘网站侧栏 |
| `src/options/App.tsx` | 左侧栏顶部加「返回助手侧栏」主按钮 +「打开独立助手面板」次按钮 |
| `src/popup/App.tsx` | 支持 `?standalone=1`；独立面板顶部提示、右上角「展开侧栏」按钮，点击发 `OPEN_SIDEBAR_ON_JOB_SITE` |
| `src/assets/styles/globals.css` | 新增 `body.app-standalone` 居中留白样式 |
| `tests/assistant-entry.test.ts` | 16 例，含「后台页连注入都不尝试」「注入失败不打开后台」「依赖里不存在打开后台入口」 |

显式 `OPEN_OPTIONS`（用户主动点设置）保留，仅移除所有兜底跳后台路径。

### 验证结果

| 检查 | 结果 |
|---|---|
| `npx tsc -b` | 0 error |
| `npm run lint` | 0 error（42 个既有 warnings） |
| `CI=1 SKIP_BROWSER_E2E=1 npx vitest run tests` | **53 文件 / 819 用例全绿** |
| `npx vite build --emptyOutDir false` | 成功 |
| 浏览器 E2E（10 套件，分 3 批） | 4 文件 16 例 + 3 文件 8 例 + 3 文件 9 例 = **33 例全绿** |
| 真机 Chromium 导航链路（8 项） | 后台页有返回按钮 ✅ / 出现招聘网站标签页 ✅ / 侧栏 `#boss-assistant-panel` = 1 ✅ / 后台标签页数量 1→1 未增加 ✅ / 打开独立面板 ✅ / 有提示 ✅ / 有「展开侧栏」按钮 ✅ / 点击后 toast ✅ |
| 截图 | `/tmp/qzzs_standalone.png`：独立面板居中、顶部提示、右上角「展开侧栏」、右下成功 toast，无溢出或裁切 |

> 真机验证脚本用完已非破坏性移至 `/tmp/qzzs-nav.mjs`，未留在仓库。

---

## 7. 后续：概览头部去冗余（用户实测反馈）

> 用户原话：「概览的 求职助手 / Boss直聘 · 智能投递 / 开始沟通 这个显示都不需要了吧」

**判断：合理，照做。** 该 Header 是两层冗余：

1. 「求职助手 / {平台} · 智能投递」是**第二层品牌头**——`App.tsx` 全局头部已有「求职投递助手」+ 平台徽章 + 平台选择行。
2. 顶部「开始沟通 / 停止」是概览页**第三个启动入口**——「沟通筛选条件」有「开始智能沟通」，「批量沟通控制台」有「开始批量沟通（半自动）」/「停止本轮批量沟通」。三处并存既挤又容易重复申请运行锁。

**改动**：`Dashboard.tsx` 删除整个 Header 块与紧随其后那条与 `BatchControlCard` 重复的 AIbot 互斥提示；清理 `Button` / `ShieldAlert` imports 与 `platformName` prop；`startLocked` 注释与逻辑改为「两处入口」。`App.tsx` 不再传 `platformName`（`effectivePlatformName` 仍供全局头部徽章使用）。`extension-flow.test.ts` 的 bootstrap 锚点从 `getByText('求职助手')` 换成 `getByRole('heading', { name: '求职投递助手' })`。README F 层 / 快速开始、`CHANGELOG`、`runtime-state.ts` 注释同步。

**验证**：`tsc -b` 0 error；`lint` 0 error / 42 既有 warnings；`SKIP_BROWSER_E2E=1 vitest` **53 文件 / 819 用例全绿**；`vite build` 成功；浏览器 E2E 10 套件分 3 批 **33 例全绿**；真机 Chromium 7 项断言全 OK（品牌头在、旧标题/副标题/按钮已移除、两个新入口仍在、筛选卡片仍在），截图 `/tmp/qzzs_dashboard_after.png`。

> 踩坑：筛选卡片默认 `filterCollapsed = true`，折叠时「开始智能沟通」按钮不在可访问树里，`getByRole('button').count()` 会是 0。真机断言必须先展开卡片；这不是回归。
