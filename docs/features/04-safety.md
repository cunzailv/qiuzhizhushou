# 04 · 安全阀与权限（防封 + AI 自主边界）

> 一句话职责：**默认保守、越界必停**。让自动化跑得慢一点，但账号活得久一点。

---

## 一、安全阀（投递节奏）

### 三档（单一真源：`src/shared/types/safety-preset.ts`）

| 参数 | 保守（默认） | 标准 | 激进 |
|---|---|---|---|
| 每日上限 | 30 | 60 | 100 |
| 间隔 | 5-15 s | 3-10 s | 2-8 s |
| 单次扫描 | 20 | 50 | 100 |
| 沟通模式 | AI 推荐确认 | 批量 | 批量 |
| AI 预算 | 30 | 50 | 100 |

- UI：设置 → 防封策略顶部三按钮；手动改任一项 → 自动标记 `custom`。
- 新装用户：`resolveSafetyProfile()` 写 `conservative`；老用户已调过参数 → 标 `custom`，**不覆盖**。
- 各处兜底值统一取 `CONSERVATIVE_VALUES`（延迟、日上限、扫描数、AI 预算），避免"设置没读到就跑飞"。

### 分平台配额（`src/shared/agent/quota.ts`）

| 平台 | 每日 | 间隔 |
|---|---|---|
| BOSS | 80 | 60-180 s |
| 猎聘 | 100 | 45-120 s |
| 智联 | 60 | 60-150 s |
| 前程无忧 | 50 | 60-150 s |
| 脉脉 | 25 | 90-240 s |

平台维度优先于全局 `dailyLimit`；时间窗（`campaignWindows`）可限制只在某时段跑。

### 反检测（`src/shared/antiBot/`）

| 文件 | 作用 |
|---|---|
| `delay-engine.ts` | 随机延迟（非固定间隔，避免机械特征） |
| `rate-limiter.ts` | 每日/分平台计数，`chrome.alarms` 跨天重置 |
| `risk-detector.ts` | 识别验证码、频率限制、封禁、警告文案（各平台文案由适配器提供） |
| `human-behavior.ts` | 模拟滚动、鼠标轨迹、打字节奏 |

命中风控 → 整批 `blocked` 并提示用户，**不做绕过**。

---

## 二、权限三档（`src/shared/agent/permission.ts`）

| 动作 | 默认 | 可调 |
|---|---|---|
| 读取页面 / 采集 | `auto` | — |
| 投递 / 申请 | `confirm` | auto / denied |
| 发送消息 | `confirm` | auto / denied |
| 越权 / 超高频 | `denied` | 不可放开 |

存储键：`setting_permission_apply` / `setting_permission_send`，content 与 popup/options 共用。

## 三、自主授权契约（`src/shared/types/candidate-profile.ts`）

用户在简历页可写一份**声明式契约**，运行时查表判定（`src/shared/agent/authorization.ts`）：

```ts
{
  enabled: false,                 // 总开关，默认关
  facts: { allowRewrite: false }, // 恒 false：AI 不能改简历事实
  reply: { mode, allowedTopics, forbidTopics, maxPerDay },
  strategy: { apply: 'confirm'|'auto'|'deny', dailyQuotaMax, matchThresholdMin, mayTune },
  locks: { resumeFactEdit:'deny', offerDecision:'confirm',
           salaryNegotiation:'confirm', riskControlBypass:'deny' } // 硬锁，UI 只读
}
```

规则：**fail-closed**（不确定一律停下问）、**事实只读**、**硬锁不可下放**、`updatedAt` 超 14 天自动降级为「需确认」。

---

## 边界

- 不做验证码识别/绕过、不改平台请求签名、不批量注册账号。
- 激进档只建议小号/测试号；UI 有红色风险提示。
- 权限放开 ≠ 无限制：仍受 `dailyLimit`、平台配额、时间窗、黑名单约束。

## 相关测试

`platform-quotas`、`e3-confirm-ui`、`authorization`、`adversarial-m2/m3/m4-stress`、`aibot-marathon-endurance`。
