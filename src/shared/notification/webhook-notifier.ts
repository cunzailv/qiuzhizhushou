// 跨端实时通知推送服务（支持飞书、钉钉、企业微信、Server酱、Bark、自定义 Webhook）
import { getSetting, setSetting } from '../db/settings-store'
import { log, logWarn, logError } from '../utils/logger'

const MOD = 'WebhookNotifier'
const WEBHOOK_SETTING_KEY = 'notification_webhook_config'

export type WebhookChannel = 'feishu' | 'dingtalk' | 'wecom' | 'serverchan' | 'bark' | 'custom'

export interface WebhookConfig {
  enabled: boolean
  channel: WebhookChannel
  webhookUrl: string
  secret?: string
  notifyOnInterview: boolean
  notifyOnDailyReport: boolean
  notifyOnRiskWarning: boolean
}

export const DEFAULT_WEBHOOK_CONFIG: WebhookConfig = {
  enabled: false,
  channel: 'feishu',
  webhookUrl: '',
  secret: '',
  notifyOnInterview: true,
  notifyOnDailyReport: true,
  notifyOnRiskWarning: true,
}

export type NotificationType = 'interview' | 'daily_report' | 'risk_warning' | 'test'

export interface NotificationPayload {
  title: string
  content: string
  type: NotificationType
  extra?: Record<string, any>
  timestamp?: string
}

/** 获取 Webhook 配置 */
export async function getWebhookConfig(): Promise<WebhookConfig> {
  const saved = await getSetting<Partial<WebhookConfig> | null>(WEBHOOK_SETTING_KEY, null)
  if (!saved) return { ...DEFAULT_WEBHOOK_CONFIG }
  return {
    ...DEFAULT_WEBHOOK_CONFIG,
    ...saved,
  }
}

/** 保存 Webhook 配置 */
export async function saveWebhookConfig(config: Partial<WebhookConfig>): Promise<WebhookConfig> {
  const current = await getWebhookConfig()
  const updated: WebhookConfig = {
    ...current,
    ...config,
  }
  await setSetting(WEBHOOK_SETTING_KEY, updated)
  return updated
}

/**
 * 飞书卡片消息构建器
 */
export function buildFeishuPayload(payload: NotificationPayload) {
  const templateColor =
    payload.type === 'risk_warning'
      ? 'red'
      : payload.type === 'interview'
      ? 'green'
      : payload.type === 'test'
      ? 'turquoise'
      : 'blue'

  return {
    msg_type: 'interactive',
    card: {
      header: {
        title: {
          tag: 'plain_text',
          content: `🤖 【求职助手】${payload.title}`,
        },
        template: templateColor,
      },
      elements: [
        {
          tag: 'div',
          text: {
            tag: 'lark_md',
            content: payload.content,
          },
        },
        {
          tag: 'note',
          elements: [
            {
              tag: 'plain_text',
              content: `发送时间: ${payload.timestamp || new Date().toLocaleString('zh-CN')}`,
            },
          ],
        },
      ],
    },
  }
}

/**
 * 钉钉 Markdown 消息构建器
 */
export function buildDingTalkPayload(payload: NotificationPayload) {
  const now = payload.timestamp || new Date().toLocaleString('zh-CN')
  return {
    msgtype: 'markdown',
    markdown: {
      title: `🤖 【求职助手】${payload.title}`,
      text: `### 🤖 【求职助手】${payload.title}\n\n${payload.content}\n\n> ⏰ 发送时间: ${now}`,
    },
  }
}

/**
 * 企业微信 Markdown 消息构建器
 */
export function buildWeComPayload(payload: NotificationPayload) {
  const now = payload.timestamp || new Date().toLocaleString('zh-CN')
  const tagColor = payload.type === 'risk_warning' ? 'warning' : 'info'
  return {
    msgtype: 'markdown',
    markdown: {
      content: `### <font color="${tagColor}">🤖 【求职助手】${payload.title}</font>\n\n${payload.content}\n\n> ⏰ 发送时间: ${now}`,
    },
  }
}

/**
 * Server酱 (方糖 Turbo) 消息构建器
 */
export function buildServerChanPayload(payload: NotificationPayload) {
  const now = payload.timestamp || new Date().toLocaleString('zh-CN')
  return {
    title: `【求职助手】${payload.title}`,
    desp: `${payload.content}\n\n> ⏰ 发送时间: ${now}`,
  }
}

/**
 * Bark (iOS) 消息构建器
 */
export function buildBarkPayload(payload: NotificationPayload, _webhookUrl: string) {
  return {
    title: `🤖 【求职助手】${payload.title}`,
    body: payload.content,
    group: '求职助手',
    icon: 'https://img.icons8.com/color/96/robot.png',
  }
}

/**
 * 自定义标准 Webhook 消息构建器
 */
export function buildCustomPayload(payload: NotificationPayload) {
  return {
    source: 'ai_job_assistant',
    title: payload.title,
    content: payload.content,
    type: payload.type,
    timestamp: payload.timestamp || new Date().toISOString(),
    extra: payload.extra || {},
  }
}

/**
 * 根据渠道格式化 Webhook 请求体
 */
export function formatWebhookPayload(
  channel: WebhookChannel,
  payload: NotificationPayload,
  webhookUrl: string,
) {
  switch (channel) {
    case 'feishu':
      return buildFeishuPayload(payload)
    case 'dingtalk':
      return buildDingTalkPayload(payload)
    case 'wecom':
      return buildWeComPayload(payload)
    case 'serverchan':
      return buildServerChanPayload(payload)
    case 'bark':
      return buildBarkPayload(payload, webhookUrl)
    case 'custom':
    default:
      return buildCustomPayload(payload)
  }
}

/**
 * 发送 Webhook 跨端推送通知
 */
export async function sendWebhookNotification(
  payload: NotificationPayload,
  configOverride?: WebhookConfig,
): Promise<{ success: boolean; error?: string; reason?: string }> {
  try {
    const config = configOverride || (await getWebhookConfig())

    if (!config.enabled && payload.type !== 'test') {
      return { success: false, reason: 'disabled' }
    }

    const url = config.webhookUrl?.trim()
    if (!url) {
      return { success: false, reason: 'empty_url' }
    }

    // 检查事件开关（测试类型不拦截）
    if (payload.type === 'interview' && !config.notifyOnInterview) {
      return { success: false, reason: 'type_disabled_interview' }
    }
    if (payload.type === 'daily_report' && !config.notifyOnDailyReport) {
      return { success: false, reason: 'type_disabled_daily_report' }
    }
    if (payload.type === 'risk_warning' && !config.notifyOnRiskWarning) {
      return { success: false, reason: 'type_disabled_risk_warning' }
    }

    const normalizedPayload: NotificationPayload = {
      ...payload,
      timestamp: payload.timestamp || new Date().toLocaleString('zh-CN'),
    }

    const bodyObj = formatWebhookPayload(config.channel, normalizedPayload, url)

    log(MOD, 'sendWebhookNotification', `Sending ${payload.type} notification to ${config.channel}...`)

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 10000)

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(bodyObj),
      signal: controller.signal,
    })

    clearTimeout(timer)

    if (!response.ok) {
      const errText = await response.text().catch(() => '')
      logWarn(MOD, 'sendWebhookNotification', `Failed with HTTP status ${response.status}: ${errText}`)
      return {
        success: false,
        error: `HTTP ${response.status}: ${errText.slice(0, 100)}`,
      }
    }

    log(MOD, 'sendWebhookNotification', `Notification sent successfully to ${config.channel}`)
    return { success: true }
  } catch (err: any) {
    const msg = err?.name === 'AbortError' ? '请求超时 (10s)' : err?.message || String(err)
    logError(MOD, 'sendWebhookNotification', `Error sending webhook: ${msg}`)
    return { success: false, error: msg }
  }
}

/**
 * 测试 Webhook 连通性
 */
export async function testWebhookConnection(
  config: WebhookConfig,
): Promise<{ success: boolean; message: string }> {
  const result = await sendWebhookNotification(
    {
      title: '配置连通性测试',
      content: `🎉 恭喜！您的求职助手 Webhook 跨端推送配置成功！\n\n- **推送渠道**：${config.channel}\n- **通知内容**：HR 面试邀约、每日管家战报、风控拦截熔断告警\n- **测试时间**：${new Date().toLocaleString('zh-CN')}`,
      type: 'test',
    },
    config,
  )

  if (result.success) {
    return {
      success: true,
      message: '✅ 测试推送发送成功！请检查手机或对应群聊消息。',
    }
  }

  return {
    success: false,
    message: `❌ 测试推送失败：${result.error || result.reason || '网络错误'}`,
  }
}
