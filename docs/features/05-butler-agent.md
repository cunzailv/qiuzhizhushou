# 05 · 求职管家 Agent

> 一句话职责：不只替你点按钮，还每天告诉你「今天该做什么、昨天做得怎么样」。

---

## 能力构成

| 能力 | 文件 | 说明 |
|---|---|---|
| 每日运行 | `src/shared/agent/butler/index.ts` | `butlerRunDaily`：生成当日策略 → 扫描跟进 → 记忆回流 → 决策留痕 → 汇总 |
| 策略规划 | `butler/butler-planner.ts` | 按投递量、回复率、剩余配额给出今日建议（含默认配额 `DEFAULT_DAILY_QUOTA`） |
| 岗位选择 | `butler/job-selector.ts` | 在候选池里挑出优先投递的岗位 |
| 跟进建议 | `butler/followup-planner.ts` | 长时间无回复、HR 已读未回 → 生成跟进动作与话术 |
| 日报 | `butler/daily-report-generator.ts` | 结构化日报（投递数、回复率、平台分布、异常） |
| 复盘校准 | `butler/review-planner.ts` | 周期复盘 + 权重校准建议（哪些条件该放宽/收紧） |
| 记忆归纳 | `butler/induction-engine.ts` → `companyMemories` | 沉淀公司维度经验（面试流程、反馈风格） |
| 对话式操作 | `butler/chat.ts` + `chat-to-action.ts` + `actions-registry.ts` | 自然语言 → 注册动作执行，失败降级到本地确定性规则 |

---

## 用户视角

- 弹窗 → **管家**：聊天式交互（"今天投什么""帮我看看谁没回"），卡片式展示建议与结果。
- 管理后台 → **智能体**：配置管家参数、查看日报与待修清单。
- 管理后台 → **记忆中心**：查看 AI 沉淀的技能、公司记忆、决策留痕。

## 数据

`companyMemories`、`decisionLogs`、`followUps`（可 `dismissed`）、`applications`、`auditLogs`。
首次运行若 AI 不可用，管家仍能基于本地数据产出日报与跟进清单（无 LLM 降级路径）。

---

## 依赖的配置

| 配置 | 影响 |
|---|---|
| `aiEnabled` / `apiKey` / `aiDailyBudget` | 对话与智能建议 |
| 自主授权契约 | 管家能自动做什么、哪些必须问 |
| 通知配置 | 日报/跟进是否外推 |
| 安全阀档位 | 建议里的每日配额上限 |

## 边界

- 管家不能改简历事实、不能替用户接受 Offer、不能谈薪（硬锁）。
- 对话动作走 `actions-registry` 白名单，未注册的意图只做解释，不执行。

## 相关测试

`butler.test.ts`、`butler-flow.test.ts`、`butler-evolution.test.ts`、`chat-to-action.test.ts`、`planner.test.ts`、`c-layer.test.ts`、`g1-memory-ui.test.ts`。
