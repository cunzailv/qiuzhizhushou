import { describe, it, expect, vi, beforeEach } from 'vitest'
import 'fake-indexeddb/auto'
import {
  buildFeishuPayload,
  buildDingTalkPayload,
  buildWeComPayload,
  buildServerChanPayload,
  buildBarkPayload,
  buildCustomPayload,
  formatWebhookPayload,
  sendWebhookNotification,
  testWebhookConnection,
  type WebhookConfig,
  type NotificationPayload,
} from '../src/shared/notification/webhook-notifier'

describe('Webhook Notifier (跨端实时通知推送)', () => {
  const samplePayload: NotificationPayload = {
    title: '收到面试邀约: 字节跳动',
    content: '岗位【全栈架构师】HR 发来面试邀请，约周五下午 14:00',
    type: 'interview',
    timestamp: '2026-11-03 21:00:00',
    extra: { company: '字节跳动', jobId: 'job_123' },
  }

  it('formats Feishu interactive card payload correctly', () => {
    const feishu = buildFeishuPayload(samplePayload)
    expect(feishu.msg_type).toBe('interactive')
    expect(feishu.card.header.title.content).toContain('收到面试邀约: 字节跳动')
    expect(feishu.card.header.template).toBe('green')
    expect(feishu.card.elements[0].text.content).toContain('全栈架构师')
  })

  it('formats DingTalk markdown payload correctly', () => {
    const dingtalk = buildDingTalkPayload(samplePayload)
    expect(dingtalk.msgtype).toBe('markdown')
    expect(dingtalk.markdown.title).toContain('收到面试邀约: 字节跳动')
    expect(dingtalk.markdown.text).toContain('### 🤖 【求职助手】收到面试邀约: 字节跳动')
  })

  it('formats WeCom markdown payload correctly', () => {
    const wecom = buildWeComPayload(samplePayload)
    expect(wecom.msgtype).toBe('markdown')
    expect(wecom.markdown.content).toContain('收到面试邀约: 字节跳动')
  })

  it('formats ServerChan payload correctly', () => {
    const serverchan = buildServerChanPayload(samplePayload)
    expect(serverchan.title).toBe('【求职助手】收到面试邀约: 字节跳动')
    expect(serverchan.desp).toContain('全栈架构师')
  })

  it('formats Bark payload correctly', () => {
    const bark = buildBarkPayload(samplePayload, 'https://api.day.app/key')
    expect(bark.title).toBe('🤖 【求职助手】收到面试邀约: 字节跳动')
    expect(bark.body).toContain('全栈架构师')
    expect(bark.group).toBe('求职助手')
  })

  it('formats Custom JSON payload correctly', () => {
    const custom = buildCustomPayload(samplePayload)
    expect(custom.source).toBe('ai_job_assistant')
    expect(custom.type).toBe('interview')
    expect(custom.extra.company).toBe('字节跳动')
  })

  it('skips sending when disabled or empty url', async () => {
    const disabledConfig: WebhookConfig = {
      enabled: false,
      channel: 'feishu',
      webhookUrl: 'https://open.feishu.cn/hook',
      notifyOnInterview: true,
      notifyOnDailyReport: true,
      notifyOnRiskWarning: true,
    }
    const res = await sendWebhookNotification(samplePayload, disabledConfig)
    expect(res.success).toBe(false)
    expect(res.reason).toBe('disabled')
  })

  it('respects notification event type filters', async () => {
    const configNoInterview: WebhookConfig = {
      enabled: true,
      channel: 'feishu',
      webhookUrl: 'https://open.feishu.cn/hook',
      notifyOnInterview: false,
      notifyOnDailyReport: true,
      notifyOnRiskWarning: true,
    }
    const res = await sendWebhookNotification(samplePayload, configNoInterview)
    expect(res.success).toBe(false)
    expect(res.reason).toBe('type_disabled_interview')
  })

  it('handles network dispatch and error gracefully', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
    })
    global.fetch = fetchMock

    const activeConfig: WebhookConfig = {
      enabled: true,
      channel: 'dingtalk',
      webhookUrl: 'https://oapi.dingtalk.com/robot/send?access_token=test',
      notifyOnInterview: true,
      notifyOnDailyReport: true,
      notifyOnRiskWarning: true,
    }

    const res = await sendWebhookNotification(samplePayload, activeConfig)
    expect(res.success).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    // Test connection helper
    const testRes = await testWebhookConnection(activeConfig)
    expect(testRes.success).toBe(true)
    expect(testRes.message).toContain('测试推送发送成功')
  })
})
