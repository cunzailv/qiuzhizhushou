# 功能说明书（FEATURES）

> 适用版本：v1.1.1+ ｜ 面向：使用者 / 接手开发者 / AI 助手
> 配套：[CONFIG_GUIDE.md](./CONFIG_GUIDE.md)（配置项与默认值）、[PROJECT.md](../PROJECT.md)（自愈架构细节）、[features/](./features/)（分功能详解）

---

## 1. 这个产品是什么

一个 **Chrome 扩展形态的求职自动化助手（求职者端）**：在 Boss 直聘 / 猎聘 / 智联 / 前程无忧 / 脉脉 页面里，用本地规则 + 大模型完成「读简历 → 找岗位 → 评匹配 → 打招呼 → 记投递 → 追跟进」的闭环，并把所有数据留在本机浏览器。

**明确的边界（写进 DISCLAIMER 的）**：只做简历事实范围内的辅助与自动化，不做简历造假、不做风控绕过、不代替用户做 Offer / 薪资决策。

---

## 2. 功能地图

```
浏览器页面（content script）           扩展后台 / 管理页面
┌──────────────────────────┐        ┌───────────────────────────┐
│ 悬浮面板 / 一键沟通       │        │ 管理后台（options，10 页）  │
│ 岗位采集 → 过滤 → 评分    │◄──────►│ 弹窗（popup，5 页）         │
│ 打招呼 → 投递 → 状态回写  │  消息  │ Background SW（队列/闹钟）  │
└──────────────────────────┘        └───────────────────────────┘
              │                                  │
              └────────── IndexedDB + chrome.storage.local ─────────┘
```

| # | 功能模块 | 用户价值 | 入口 | 详细文档 |
|---|---|---|---|---|
| 1 | 简历解析与求职画像 | PDF/Word 一键导入，自动抽出技能、经历、匹配所需画像 | 简历管理 | [01-resume.md](./features/01-resume.md) |
| 2 | 岗位采集 / 过滤 / AI 评分 | 只投"值得投"的岗位，过滤外包、薪资不符、行业不符 | 悬浮面板、一键沟通 | [02-job-matching.md](./features/02-job-matching.md) |
| 3 | 打招呼与 HR 应答 Copilot | 按岗位 JD 生成个性化开场白；HR 追问时给可直接发的回复 | 悬浮面板聊天区 | [02-job-matching.md](./features/02-job-matching.md) |
| 4 | 投递流水线（队列 / 状态机 / 自愈） | 批量投递不中断，单岗位失败跳过、页面异常自动绕过 | 一键沟通、Campaign 面板 | [03-apply-pipeline.md](./features/03-apply-pipeline.md) |
| 5 | 安全阀与反检测 | 拟人间隔、分平台配额、风控文案识别、三档节奏 | 设置 → 防封策略 | [04-safety.md](./features/04-safety.md) |
| 6 | 权限与自主授权 | AI 动作默认需确认；可用声明式契约放开区间 | 设置 → AI 动作权限 / 简历页 | [04-safety.md](./features/04-safety.md) |
| 7 | 求职管家 Agent | 每日策略、跟进建议、日报、对话式操作、复盘校准 | 弹窗 → 管家 / 管理后台 → 智能体 | [05-butler-agent.md](./features/05-butler-agent.md) |
| 8 | 通知与面试日历 | 面试邀约提醒、Webhook 推送到飞书/钉钉/企微/Bark | 设置 → 通知；面试日历 | [06-notifications.md](./features/06-notifications.md) |
| 9 | 数据管理 / 导出 / 加密 | 投递记录导出 Excel、敏感字段脱敏、简历原文加密 | 导出中心、设置 → 数据管理 | [07-data-export.md](./features/07-data-export.md) |
| 10 | 配置引导与安全默认 | 首屏 3+1 步走完即可用，其余后置 | 仪表盘顶部卡片 | [08-config-onboarding.md](./features/08-config-onboarding.md) |
| 11 | 审计 / 错误日志 / 记忆中心 | 每次动作可追溯，AI 沉淀的技能与决策可查 | 审计中心、记忆中心 | [03-apply-pipeline.md](./features/03-apply-pipeline.md) |

---

## 3. 端到端主流程（一次投递发生了什么）

1. **准备**：用户在平台页面搜索岗位 → 悬浮面板「一键沟通」。
2. **采集**：`job-discovery` 滚动采集岗位卡片，受 `maxScanCount` 限制（保守档 20）。
3. **过滤**：`job-filter` 按薪资区间、城市、排除词、黑名单、标题匹配剔除。
4. **评分**：`remote-matcher` 优先 AI 评分（`semantic-matcher`），AI 不可用/超预算 → `local-matcher` 本地规则分。
5. **排队**：通过阈值的岗位进入 `queue-store` 的 Campaign 队列（持久化在 `chrome.storage.local`）。
6. **执行**：content 侧 `task-runner` 逐条取出 → `apply-state-machine` 走状态流转（匹配 → 详情 → 沟通 → 发送 → 完成），每步落审计。
7. **自愈**：选择器失效 → 技能记忆（Tier 0）→ 模糊匹配 → URL 直达 → LLM 感知 → 本地启发式兜底（详见 PROJECT.md）。
8. **限流**：每步之间 `randomDelay`（保守档 5-15 s），每平台按 `DEFAULT_PLATFORM_CONFIGS` 计数，触发风控文案立即停。
9. **回写**：投递结果写入 `applications`，状态流转 `applied → read → communicating → interview → rejected/hired`。
10. **后续**：面试事件进 `interviewEvents` + `chrome.alarms` 提醒 + Webhook 推送；管家扫描跟进建议。

---

## 4. 平台适配层

每个平台一个适配器，统一 `PlatformAdapter` 协议（见 `src/shared/platform/types.ts`）：选择器、风控文案、日上限文案、详情页解析、投递动作。

| 平台 | 目录 | 状态 |
|---|---|---|
| BOSS 直聘 | `platform/boss/` | 主战场，能力最全（含聊天、简历发送、HR 回复） |
| 猎聘 | `platform/liepin/` | 支持投递 + 岗位详情预筛（`prefilterLiepinJob`） |
| 智联招聘 | `platform/zhaopin/` | 基础投递 |
| 前程无忧 | `platform/51job/` | 基础投递 |
| 脉脉 | `platform/maimai/` | 基础投递（配额最低 25/天） |

新增平台 = 新增一个目录实现 `PlatformAdapter` + 在 `platform/index.ts` 注册 + 在 `auth-checker.ts` 补 Cookie 探测名和登录地址 + 在 `quota.ts` 补默认配额。**不需要改流水线主逻辑**。

---

## 5. 代码结构速查

| 目录 | 职责 |
|---|---|
| `src/background/` | Service Worker：闹钟、跨标签页调度、面试提醒 |
| `src/content/` | 页面内注入：悬浮面板、任务执行、DOM 交互、现场复原 |
| `src/options/` | 管理后台（10 个页面，React + Vite） |
| `src/popup/` | 扩展弹窗（5 个页面） |
| `src/components/` | 跨页面共用组件（`ui/*` + `setup-checklist`） |
| `src/shared/agent/` | Agent 能力：队列、状态机、ReAct 循环、技能记忆、权限、管家 |
| `src/shared/ai/` | 模型客户端、评分、打招呼、简历分析、HR Copilot、预算护栏 |
| `src/shared/antiBot/` | 拟人延迟、限流、风控识别、真人行为模拟 |
| `src/shared/db/` | Dexie 表与各 store（简历、投递、审计、错误、记忆…） |
| `src/shared/platform/` | 五平台适配器 + 登录态探测 |
| `src/shared/parser/` | PDF/Word 解析 + 技能词典 + 结构化抽取 |
| `src/shared/security/` | AES-GCM 加密（vault）、导出脱敏（mask） |
| `src/shared/types/` | 全部类型定义，含 `settings.ts`、`safety-preset.ts`、`candidate-profile.ts` |

---

## 6. 数据表（IndexedDB `BossZhipinAssistant`）

| 表 | 内容 | 关键索引 |
|---|---|---|
| `resumes` | 简历（原文加密） | id, isDefault, createdAt |
| `applications` | 投递记录 | jobId, companyName, status, appliedAt, matchScore |
| `blacklist` | 公司黑名单 | companyName |
| `interviewEvents` | 面试事件 | applicationId, interviewDate |
| `matchAnalyses` | 匹配分析记录 | resumeId, createdAt |
| `agentSkills` | 自愈技能沉淀 | [platform+pageType+goal], lastUsedAt |
| `companyMemories` / `decisionLogs` / `followUps` | 管家记忆与决策 | companyName / createdAt |
| `auditLogs` | 动作审计 | createdAt, source, platform, result |
| `careerProfiles` | 职业画像（加密） | id |
| `applyRuns` | 投递状态快照（断点恢复） | jobId |
| `errors` | 错误日志 | createdAt, source |
| `experiences` | 经历库 | id |

设置类数据不在 Dexie 里作为权威源，走 `chrome.storage.local` 的 `setting_*` 键（详见 CONFIG_GUIDE 第 6 节）。

---

## 7. 质量基线

- 测试：`tests/` 下 58 个文件、700+ 用例，覆盖五平台流程、自愈四阶、管家、权限、加密、Webhook。
- 命令：`npm test`（含 build + vitest）、`npm run lint`、`npx tsc -b`。
- 验收记录见 `PROJECT.md` 顶部「验收基线」。
