# 全流程自动化投递流水线 · 改造设计

- 日期：2026-11-03
- 目标：一次点击 → 队列驱动 → 多平台轮转 → AI 筛岗 + 生成话术 → 投递 → 断点续跑
- 决策：AI 粒度取「筛岗 + 话术」双调用（每岗 2 次 LLM）

---

## 1. 目标与非目标

### 目标（必须有）

| 编号 | 能力 | 验收标准 |
|---|---|---|
| G1 | 持久化任务队列 | 关闭浏览器后重开，队列状态与进度不丢 |
| G2 | 后台 tick 调度 | 无页面交互时也能推进，不依赖某个 tab 停留 |
| G3 | 跨页续跑 | 投到第 N 份遇验证码，人工处理后从第 N 份继续 |
| G4 | 多平台轮转 | 一个 campaign 串行跑 2–5 个平台，各自独立配额 |
| G5 | AI 筛岗 + 话术 | 每岗 2 次调用，话术落队列缓存，失败降级模板 |
| G6 | 拟人节奏 | 单次间隔分钟级随机，分时段窗口，非匀速 |
| G7 | 硬性停手 | 命中平台日限/账号受限/验证码时立即停，不硬闯 |

### 非目标（明确不做）

- 不绕过验证码（只挂起等人工）
- 不修改简历内容做「一岗一版」自动改写（超出本轮）
- 不做多账号并行（风控风险叠加，无可靠隔离方案）
- 不追求「每平台 100 份跑满」（见 §7 配额策略，按匹配度动态给量）

---

## 2. 现状盘点

### 已具备（可直接复用）

| 模块 | 文件 | 说明 |
|---|---|---|
| 无限滚动采集 | `shared/platform/boss/action-simulator.ts:182` `collectJobCards` | 滚到底 + 连续 5 轮无新增才停，已支持 `maxJobs` / `shouldCancel` |
| 投递状态机 | `shared/agent/apply-state-machine.ts` | 11 态 + 纯函数迁移表 + 审计落库，可直接嵌入任务级状态 |
| 每日计数 | `shared/antiBot/rate-limiter.ts` | `chrome.storage.local` 跨上下文计数 + 日期自动重置 |
| 风控检测 | `shared/antiBot/risk-detector.ts` | 按平台配置识别 日限/频率/封禁/验证码 四类文案 |
| 平台适配 | `shared/platform/` 5 平台 | 统一 `PlatformAdapter` 接口 |
| AI 匹配 | `shared/ai/` | 画像 + JD 理解 + 语义评分 0–100 |
| 通知 | `background/index.ts:65,97,123` | `chrome.notifications` 已在用 |
| 定时器 | `background/index.ts:21,26,31` | 已有 3 个 alarm，模式可复制 |

### 关键缺口

| 缺口 | 现状证据 | 影响 |
|---|---|---|
| 无持久队列 | `content/index.ts` 内 `let matchResults` / 内存数组 | 关页即丢，无法续跑 |
| 单页内存循环 | `content/index.ts:339` `startApply` → `for (const job of jobs)` | 只能跑当前页，跑完即止 |
| 无 tab 调度 | `background` 无 `tabs.create` | 不能无人值守跨平台 |
| 采集与投递耦合 | 先 `collectJobCards` 全采完 → 再逐个投 | 无法「投够配额就停，剩余留明天」 |
| 配额默认失效 | `types/settings.ts:40` `dailyLimit: 10000` | 等于没限制 |
| 节奏过快 | `types/settings.ts:41-42` `minDelay: 2000` / `maxDelay: 8000` | 2–8 秒一封，必触发风控 |
| 确认阻塞 | `content/index.ts:55` `requestUserConfirm` 30s 超时拒绝 | 无人值守场景下会误跳过 |

---

## 3. 目标架构

```
┌─ UI 层 ────────────────────────────────────────┐
│ popup / options                                │
│   [一键开跑] → START_CAMPAIGN                  │
│   战报面板 ← CAMPAIGN_PROGRESS (订阅)           │
└───────────────────┬───────────────────────────┘
                    │ chrome.runtime.sendMessage
┌───────────────────▼───────────────────────────┐
│ background / CampaignService (新增)            │
│                                                │
│  ┌─ ApplyQueue (chrome.storage.local) ──────┐  │
│  │ campaign: status / stats / windows       │  │
│  │ tasks[]: pending|running|done|...        │  │
│  └──────────────────────────────────────────┘  │
│                                                │
│  alarm 'apply-tick' (每 45s)                   │
│    1. 读队列 → 过滤可执行任务（配额/时间窗）    │
│    2. 选下一个 pending → 标记 running          │
│    3. 确保目标平台 tab（复用 or tabs.create）  │
│    4. sendMessage EXECUTE_TASK → 等回执        │
│    5. 回写状态 + 累加统计 + 判停               │
│                                                │
│  alarm 'campaign-window' (整点) → 开/关时间窗  │
└───────────────────┬───────────────────────────┘
                    │ tabs.sendMessage
┌───────────────────▼───────────────────────────┐
│ content / TaskRunner (改造)                    │
│  EXECUTE_TASK(task)                            │
│    a. 在页面定位卡片（jobId 匹配 / 滚动找）     │
│    b. AI 筛岗 → 低分 SKIP 上报                 │
│    c. AI 话术（未缓存则生成，写回队列）         │
│    d. apply-state-machine 执行投递             │
│    e. 上报 { status, appliedAt, reason }       │
│  保留：浮窗进度、风控文案侦测、人工查看入口     │
└────────────────────────────────────────────────┘
```

**核心原则**：background 只做「派活和记账」，不碰 DOM；content 只做「干活和上报」，不持有跨任务状态。所有跨会话状态都在 `chrome.storage.local`，Service Worker 被终止也能恢复。

---

## 4. 数据模型

### 4.1 队列存储

`chrome.storage.local` key：`apply_queue_v1`

选 storage 而非 IndexedDB 的理由：现有 `rate-limiter.ts` 已用 storage 做跨上下文计数，模式一致；队列 500 条 × 约 200 字节 ≈ 100 KB，远低于 5 MB 上限；content 侧可直接读，省一层消息往返。

```ts
export type PlatformId = 'boss' | 'liepin' | 'zhaopin' | '51job' | 'maimai'

export type TaskStatus =
  | 'pending'      // 待执行
  | 'running'      // content 执行中（带 lease 超时）
  | 'done'         // 已投递
  | 'skipped'      // AI 判定不值得投 / 用户跳过
  | 'failed'       // 执行失败（已用尽重试）
  | 'paused'       // 遇验证码等，等人工

export interface ApplyTask {
  id: string                  // `${platform}:${jobId}`
  platform: PlatformId
  jobId: string
  jobTitle: string
  company: string
  jobUrl: string
  status: TaskStatus
  attempts: number            // 已尝试次数，上限 2
  leaseUntil?: number         // running 态的租约到期时间戳，防卡死

  // AI 产出（双调用结果，缓存复用）
  matchScore?: number
  matchReason?: string
  greeting?: string
  aiCost?: number             // 累计 token，用于预算控制

  appliedAt?: string
  failReason?: string
}

export interface PlatformQuota {
  quota: number               // 本平台本 campaign 上限
  minDelayMs: number
  maxDelayMs: number
  applied: number
  skipped: number
  failed: number
  exhausted: boolean          // 命中日限标记
}

export interface Campaign {
  id: string
  createdAt: string
  status: 'running' | 'paused' | 'done' | 'aborted'
  pausedReason?: 'captcha' | 'user' | 'rate' | 'blocked'
  tasks: ApplyTask[]
  quotas: Record<PlatformId, PlatformQuota>
  windows: Array<{ start: number; end: number }>  // 允许运行的小时区间
  lastTickAt?: number
  aiBudgetUsed: number
}
```

### 4.2 投递态与任务态的映射

现有 `ApplyState`（11 态）是**单次投递内**的状态机，保持不变；`TaskStatus` 是**跨任务**的队列状态。二者关系：

```
TaskStatus.pending
  → content 领到任务，标记 running
  → ApplyState: matched → opening_detail → ... → applied
      applied        → TaskStatus.done
      skipped        → TaskStatus.skipped
      denied/failed  → TaskStatus.failed（attempts < 2 则退回 pending）
      blocked        → TaskStatus.paused（campaign 同步挂起）
```

审计表按 `task.id` 关联，`apply-state-machine` 的 `recordMachineTransition` 无需改动，只补一个 `taskId` 字段。

---

## 5. AI 调用策略（筛岗 + 话术）

### 5.1 每岗两次调用

| 步骤 | 输入 | 输出 | 现有可复用 |
|---|---|---|---|
| ① 筛岗 | 简历画像 + JD 结构化 | `score: 0-100` + `reason` + `dims[]` | `shared/ai/` `matchResumeToJob` 已有 |
| ② 话术 | 简历亮点 + 岗位标题/公司/JD 关键词 | 60–120 字个性化招呼语 | `getJobSpecificGreeting` 现为同步模板拼接，需新增异步 LLM 版本 |

### 5.2 话术生成改造

现有接口是同步的，无法直接塞 LLM：

```ts
// 现状 shared/platform/types.ts
getJobSpecificGreeting(resumeName: string, job: JobCard, match: MatchResult): string
```

新增旁路函数，不改动原接口：

```ts
// 新增 shared/ai/greeting.ts
export async function generateGreeting(
  resume: Resume,
  job: JobCard,
  match: MatchResult,
): Promise<{ text: string; tokens: number }>
```

调用顺序：先走 `generateGreeting`，成功则用其结果，失败/超预算则降级到 `adapter.getJobSpecificGreeting`。这样既有平台模板兜底，AI 挂了流程不断。

### 5.3 预取优化（关键，决定总耗时）

串行跑 500 岗：500 × (筛岗 2s + 话术 3s) = 42 分钟纯 AI 等待。

改为**预取下 N 个岗位的 AI 产出**，与投递并行：

```
tick N   : 执行 task[i]（DOM 操作，耗时 45-180s）
           同时后台预取 task[i+1..i+3] 的 score + greeting
tick N+1 : task[i+1] 的 AI 结果已就绪 → 直接执行
```

AI 时间被投递间隔完全吸收，总耗时 = 投递耗时（约 2.5 小时/80 份），不额外增加。

### 5.4 预算与降级

- 单岗 AI 预算上限：`aiDailyBudget`（现有设置项，默认 50，需上调至能覆盖 500 岗的量级）
- 超预算 → 关闭筛岗调用，退回本地规则初筛（`shared/ai/` 已有本地语义精筛）
- 筛岗失败 → 默认 `score = 60`（放行），但标记 `aiDegraded: true` 供战报统计

---

## 6. 节奏引擎

### 6.1 为什么必须改默认值

`minDelay: 2000 / maxDelay: 8000` 是从「单页快速跑完」场景设的。挪到 100 份量级，等于 8 秒一封连续打 13 分钟，是典型的机器行为特征。

### 6.2 三层节奏

```
层 1 · 任务间隔     : 分钟级随机，见下表
层 2 · 分时段窗口   : 09:00-11:30 / 14:00-17:30，窗口外 tick 空转不发任务
层 3 · 随机休息     : 每投 15-25 份，强制停 8-20 分钟（模拟人在忙别的）
```

### 6.3 节奏参数表

| 平台 | 建议配额 | 单次间隔 | 预估耗时 |
|---|---|---|---|
| Boss 直聘 | 80 | 60–180 s | 2.0–4.0 h |
| 猎聘 | 100 | 45–120 s | 1.3–3.3 h |
| 智联招聘 | 60 | 60–150 s | 1.0–2.5 h |
| 前程无忧 | 50 | 60–150 s | 0.8–2.1 h |
| 脉脉 | 25 | 90–240 s | 0.6–1.7 h |

合计约 315 份/天，跨 5 平台。任一平台耗时超过时间窗则自动顺延到次日（队列里 pending 不丢）。

---

## 7. 配额分配策略

不用「固定 100 份」，改**按匹配分动态配额**：

| 匹配分 | 处理 | 说明 |
|---|---|---|
| 90–100 | 必投 + 优先（排到队首） | 强匹配，值得花 AI 写好话术 |
| 80–89 | 投，正常排队 | 主力区 |
| 60–79 | 投，但用模板话术省 AI | 量的大部分来自这里 |
| < 60 | 直接 `skipped`，不消耗投递额度 | 本地规则初筛即可拦掉，不浪费平台配额 |

配额按平台上限的 60–70% 设定（Boss 150 → 配 80），留出余量给：突发补充投递、手动打招呼、以及避免正好踩线触发日限。

**为什么这样更好**：海投 100 份模板话术的回复率通常 2–3%，而 80 份里 30 份强匹配 + 50 份正常，整体回复率能到 5% 以上。投递总量下降 20%，邀约数上升。

---

## 8. 文件级改动清单

### 新增

| 文件 | 职责 | 预估行数 |
|---|---|---|
| `src/shared/agent/queue-store.ts` | 队列读写、原子更新、租约管理 | ~180 |
| `src/shared/agent/campaign.ts` | Campaign 生命周期、任务展开、统计聚合 | ~200 |
| `src/background/campaign-service.ts` | tick 调度、tab 管理、任务派发、回执处理 | ~260 |
| `src/background/tab-manager.ts` | 平台 tab 复用/创建/健康检查 | ~90 |
| `src/shared/agent/quota.ts` | 分平台配额、时间窗判定、动态配给 | ~120 |
| `src/shared/ai/greeting.ts` | LLM 话术生成 + 缓存 + 降级 | ~130 |
| `src/shared/ai/prefetch.ts` | 下 N 岗 AI 产出预取 | ~110 |
| `src/content/task-runner.ts` | content 侧任务执行入口（从 index.ts 抽出投递逻辑） | ~280 |
| `src/popup/components/CampaignPanel.tsx` | 一键开跑 + 战报面板 | ~220 |

### 修改

| 文件 | 改动点 |
|---|---|
| `src/background/index.ts:21` | 新增 `apply-tick`（每 45 s）+ `campaign-window`（整点）两个 alarm |
| `src/background/index.ts:111` | 消息路由新增 `START_CAMPAIGN` / `PAUSE_CAMPAIGN` / `RESUME_CAMPAIGN` / `GET_CAMPAIGN` / `EXECUTE_TASK_RESULT` |
| `src/content/index.ts:339` | `startApply` 改为两层：保留手动单页模式（现有逻辑不动）+ 新增队列模式入口 |
| `src/content/index.ts:55` | `requestUserConfirm` 增加「无人值守」分支：不超时拒绝，改为挂起任务 + 通知 + 等 `RESUME` |
| `src/shared/types/settings.ts:40-42` | 拆成 `platformQuotas: Record<PlatformId, number>`、`minDelayMs`/`maxDelayMs` 按平台配置；`dailyLimit` 废弃 |
| `src/shared/types/settings.ts:31` | `aiDailyBudget` 上调默认值，或在 UI 说明「500 岗约需 X」 |
| `src/shared/antiBot/rate-limiter.ts:32` | 从读全局 `dailyLimit` 改为读平台级配额 |
| `src/shared/db/audit-store.ts` | 审计记录补 `taskId` 字段 |
| `src/popup/App.tsx` | 挂载 `CampaignPanel` |

### 保持不变

`apply-state-machine.ts`、`risk-detector.ts`、`platform/*` 适配器、`shared/ai/` 评分引擎、`db/*` 各 store —— 这些是已验证资产，改造不动它们。

---

## 9. 分阶段实施

每阶段独立可验收，可单独发版。

### P0 · 队列地基（核心，先做这个）

- `queue-store.ts` + `campaign.ts` + `tab-manager.ts`
- `apply-tick` alarm 驱动单平台队列执行
- `content` 侧 `task-runner.ts` 接 `EXECUTE_TASK`
- 断点续跑：浏览器崩溃/关闭后重启，从 `pending` 继续
- **验收**：Boss 单平台跑 10 份，中途刷新页面，能自动接上继续

### P1 · 多平台轮转

- 平台级配额 + 时间窗判定
- tab 复用/重建、平台间切换
- 日限/封禁命中后 `exhausted` / `aborted` 分流
- **验收**：Boss 跑到配额后自动切猎聘，无需人工干预

### P2 · AI 双调用 + 预取

- `greeting.ts` 话术生成 + 缓存 + 模板降级
- `prefetch.ts` 并行预取
- 预算熔断
- **验收**：连续 20 岗，AI 产出全部命中缓存，总耗时不超过投递耗时 1.2 倍

### P3 · 护栏与战报

- 验证码挂起/恢复（通知 + 一键继续）
- 拟人节奏三层引擎 + 随机休息
- `CampaignPanel` 战报（漏斗、平台分布、AI 降级率、跳过原因 Top 5）
- **验收**：制造一次验证码，处理后从断点续跑且计数不重复

---

## 10. 风险与降级

| 风险 | 触发条件 | 降级动作 |
|---|---|---|
| 验证码 | `risk-detector` 命中 `captchaMarkers` | task → `paused`；campaign → `paused`；发通知；人工处理完点「继续」 |
| 平台日限 | 命中 `dailyLimitMarkers` | 该平台 `exhausted = true`，本日不再派任务，切下一平台 |
| 账号受限 | 命中 `blockMarkers` | campaign → `aborted`，全平台停手，通知用户 |
| SW 被终止 | Chrome 回收 Service Worker | 所有状态在 storage，alarm 重启后读队列恢复，无需处理 |
| Tab 被手动关闭 | tick 时 `tabs.get` 失败 | `tab-manager` 自动重建，任务退回 `pending` |
| 页面改版 | adapter 选择器失效 | 任务 `failed`，重试 2 次后跳过；连续 3 岗失败 → campaign 挂起并提示「平台结构可能已变更」 |
| 租约卡死 | content 崩溃未回执 | `leaseUntil` 超时（3 分钟）后任务自动退回 `pending` |
| AI 超预算 | `aiBudgetUsed` 触顶 | 关闭筛岗，退回本地规则初筛；话术退模板 |

---

## 11. 合规边界（写在代码注释和 UI 里）

- 只做「模拟真人在自己账号上的点击」，不伪造指纹、不改 UA、不绕验证码
- 配额上限硬编码为平台公开日限的 70%，用户改不到 100%
- 命中验证码一律停手等人工，不尝试自动过
- 时段限制在 HR 工作时间内，夜间不跑
- 首次使用强制显示风险提示，需勾选确认

---

## 12. 待确认项

1. `aiDailyBudget` 现默认 50，500 岗双调用约需 1000 次。是否改为按「次数」而非金额计量，并在 UI 显示「今日剩余 X 岗额度」？
2. 话术个性化程度：每个岗位完全独立生成（慢、贵、更像人），还是一类岗位共用一个模板家族（快、便宜、略有重复感）？
3. 是否需要「面试转化数据反哺」——把 `追踪` 页回复率高的岗位特征回灌到筛岗 prompt，形成闭环？这是 P4 的候选。
