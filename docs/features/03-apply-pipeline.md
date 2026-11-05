# 03 · 投递流水线（队列 / 状态机 / 自愈）

> 一句话职责：把「一堆待投岗位」变成「一条不中断、失败可归因、异常能自愈」的执行流水线。

---

## 分层结构

| 层 | 文件 | 职责 |
|---|---|---|
| 队列 | `src/shared/agent/queue-store.ts` | Campaign 与任务队列持久化到 `chrome.storage.local`，Service Worker 重启/多标签页不丢任务 |
| 生命周期 | `src/shared/agent/campaign.ts` | 创建/暂停/恢复/结束、战报聚合、日志 |
| 状态机 | `src/shared/agent/apply-state-machine.ts` | 纯函数：每次阶段迁移落审计（`stateFrom → stateTo + verified`），失败按策略分流 |
| 执行 | `src/content/task-runner.ts` | 真实 DOM 交互：打开详情、点沟通、发问候、回写结果、现场复原 |
| ReAct | `src/shared/agent/react-loop.ts` | 选择器全失效时的 LLM 感知决策环（工具：观察页面/点击/输入） |
| 工具层 | `src/shared/agent/tool-registry.ts` + `action-executor.ts` | 把 DOM 操作抽象为「名称 + 入参校验 + 执行 + 结构化结果」 |
| 技能记忆 | `src/shared/agent/skill-memory.ts` | 成功动作链指纹沉淀到 `agentSkills`，下次优先复用（免发版热修复） |
| 断点 | `applyRuns` 表 | 记录 `jobId → state + context`，中断后可恢复 |

---

## 一次任务的状态流转

```
init → matched → detail_opened → contact_clicked → greeting_sent → done
                     │                  │                 │
                     ├ detail 失败 → 有兜底则 URL 直达直投，否则 failed
                     ├ 用户拒绝 → denied
                     └ 命中风控 → blocked（整批停下）
```

- 每个迁移都写 `auditLogs`，可在「审计中心」按 `source / platform / result` 筛。
- 单岗位不可逆异常标记 `skipped` 并继续下一岗（`try ... finally` 故障隔离），保证批次不整体崩。
- `cleanupUi` 复原现场：关残留弹窗、移除遮罩、恢复 body 滚动、清理焦点，避免污染下一个岗位。

---

## 自愈四阶（细节见 PROJECT.md）

| 阶 | 触发场景 | 手段 |
|---|---|---|
| 0 | 曾成功过的同类页面 | 技能记忆命中，0ms 复用上次动作链 |
| 1 | 卡片定位失败 | 去行政后缀模糊多词匹配 |
| 2 | 列表完全定位不到 | 后台静默跳详情页 URL 直达 |
| 3 | 按钮找不到 | 语义黑白名单启发式 → LLM 感知决策 → 本地安全回退 |

诊断产物：`SelfHealingEvent` + `DeveloperFixSuggestion` 写入 `errors` / `auditLogs`，管家面板可一键复制 Markdown 待修清单。

---

## 依赖的配置

| 配置 | 影响 |
|---|---|
| `dailyLimit` / 分平台配额 | 每批最多投多少 |
| `minDelay` / `maxDelay` | 岗位之间间隔 |
| `applyMode` | 是否逐条确认 |
| `permission_apply` / `permission_send` | 投递/发送是自动、需确认还是禁止 |
| `safetyProfile` | 上述节奏参数的分档来源 |

---

## 边界

- 不破解验证码、不伪造请求；命中风控信号（`risk-detector`）时**停止**并提示，不尝试绕过。
- 确认卡片（E3）在 `permission=confirm` 时必经用户点击，不存在"静默自动点掉"路径。
- 投递动作只在用户已登录的页面执行，不搬运 Cookie。

---

## 改动指南

- 加状态：`apply-state-machine.ts` 的迁移表 + 审计字段 + 对应单测（`e2-machine.test.ts`）。
- 改执行细节：`task-runner.ts`，注意保持 `try/finally` 现场复原。
- 加工具：`tool-registry.ts` 注册 + `action-executor.ts` 实现。
- 相关测试：`campaign-pipeline`、`e2-machine`、`h3-apply-run`、`e1-harness`、`self-healing-*`（5 个）、`adversarial-*`。
