# 08 · 配置引导与安全默认

> 一句话职责：新用户 3 步就能开跑，且默认参数不会把账号跑进风控。

---

## 首屏引导（`src/components/setup-checklist.tsx`）

挂在管理后台 → 仪表盘顶部，可折叠。做两件事：

1. **实时探测 4 项必配**（只读，不改设置）：
   - 简历：`getAllResumes().length > 0`
   - 模型：`apiKey` 非空 **且** `aiEnabled = true`
   - 登录：`checkPlatformAuth` 逐个平台查 Cookie，显示"已登录 N 个平台"
   - 安全阀：读 `safetyProfile`，显示当前档位（默认保守即视为就绪）
   未完成项提供「去配置」→ 由 `App` 注入的 `setActiveNav` 切页。
2. **列出可后置的 4 项**：AI 自主权限、通知推送、公司黑名单、数据导出——写明"什么时候才需要"，并提供「去看看」。

弹窗设置页另有一行文案版「配置顺序」，照顾不进管理后台的用户。

## 安全默认（本次改动核心）

| 项 | 改动前 | 改动后 |
|---|---|---|
| `dailyLimit` | 10000 | **30** |
| `minDelay` / `maxDelay` | 2000 / 8000 | **5000 / 15000** |
| `maxScanCount` | 50 | **20** |
| `aiDailyBudget` | 50 | **30** |
| `applyMode` | batch（批量直投） | **recommend（推荐后确认）** |
| 新增 `safetyProfile` | — | **conservative** |

实现要点：

- 参数集中在 `src/shared/types/safety-preset.ts`，`DEFAULT_SETTINGS` 展开引用。
- 各模块兜底值同步改为 `CONSERVATIVE_VALUES`（delay-engine / rate-limiter / content 扫描 / ai-budget）。
- `resolveSafetyProfile()` 做首启迁移：老用户已有数值 → 标 `custom` 不覆盖；新用户 → 写 `conservative`。
- 设置页手动改任一项 → `detectSafetyProfile()` 自动判为 `custom`；点档位按钮 → 整组写回。

## 设计原则（新增配置项时请遵守）

1. **必须能空配置跑通**：任何新功能先给安全默认值，再解释"什么时候需要它"。
2. **默认值只能更保守**：不要用"最大能力"当默认，用户主动上调才算授权。
3. **单一真源**：节奏参数只允许在 `safety-preset.ts` 定义，禁止散落魔法数字。
4. **不覆盖存量**：新增默认值必须容忍"键不存在"，需要迁移时只补缺失键。
5. **可回退**：每档位一键切换即可恢复推荐值，`custom` 状态要能被用户看懂。

## 相关测试

`e4-options.test.ts`、`f2-agent-ui.test.ts`、`h2-h5-ui.test.ts`（页面渲染）；类型检查 `npx tsc -b`。
