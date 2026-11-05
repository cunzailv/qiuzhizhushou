# 06 · 通知与面试日历

> 一句话职责：面试邀约不漏、异常早知道，站内记录 + 外部推送双通道。

---

## 站内：面试日历

| 环节 | 实现 |
|---|---|
| 事件产生 | 投递状态变为 `interview` 时写入 `interviewEvents`（applicationId、公司、岗位、时间、地点） |
| 提醒 | Background Service Worker 用 `chrome.alarms` 定时扫描，提前 `reminderMinutes`（默认 30）弹通知 |
| 开关 | `interviewReminder`（默认开）、`reminderMinutes` |
| 页面 | 管理后台 → 面试日历（`src/options/pages/InterviewCalendar.tsx`） |
| 存储 | `src/shared/db/interview-store.ts`，`notified` 标记防重复提醒 |

## 外部：Webhook 推送

`src/shared/notification/webhook-notifier.ts`，配置键 `notification_webhook_config`：

```ts
{
  enabled: boolean,           // 默认 false
  channel: 'feishu' | 'dingtalk' | 'wecom' | 'serverchan' | 'bark' | 'custom',
  webhookUrl: string,
  secret?: string,            // 钉钉/飞书加签
  notifyOnInterview: boolean, // 默认 true
  notifyOnDailyReport: boolean,
  notifyOnRiskWarning: boolean
}
```

| 通道 | 说明 |
|---|---|
| 飞书 / 钉钉 / 企微 | 群机器人 Webhook，支持签名校验 |
| Server酱 / Bark | 手机推送 |
| 自定义 | 任意接收 JSON 的 URL，便于接自建服务 |

触发类型：`interview`（面试邀约）、`daily_report`（管家日报）、`risk_warning`（风控告警）、`test`（测试发送）。

## 失败处理

- 推送失败只记日志（`logWarn`/`logError`），**不影响主流程**；不排队重试，避免堆积。
- URL 未填但 `enabled=true` → 设置页即时校验并提示，不静默失败。
- 通知配置与投递流水线解耦：关掉推送，站内日历与记录照常。

## 相关测试

`webhook-notifier.test.ts`、`extension-flow.test.ts`、`h2-h5-ui.test.ts`。
