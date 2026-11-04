// Webhook 跨端手机通知配置卡片（支持飞书/钉钉/企业微信/Server酱/Bark）

import React, { useState, useEffect } from 'react'
import { Card } from '../../components/ui/card'
import {
  Bell,
  Send,
  Check,
  AlertTriangle,
  Smartphone,
  ShieldAlert,
  Sparkles,
  Link,
  Key,
} from 'lucide-react'
import {
  getWebhookConfig,
  saveWebhookConfig,
  testWebhookConnection,
  type WebhookConfig,
  type WebhookChannel,
  DEFAULT_WEBHOOK_CONFIG,
} from '../../shared/notification/webhook-notifier'

interface NotificationSettingsCardProps {
  onNotify?: (msg: string, type: 'success' | 'warning' | 'error' | 'info') => void
}

const CHANNELS: Array<{ id: WebhookChannel; name: string; placeholder: string; hint: string }> = [
  {
    id: 'feishu',
    name: '飞书群机器人 (Feishu)',
    placeholder: 'https://open.feishu.cn/open-apis/bot/v2/hook/...',
    hint: '支持飞书富文本卡片排版，群设置 -> 机器人 -> 添加自定义机器人',
  },
  {
    id: 'dingtalk',
    name: '钉钉群机器人 (DingTalk)',
    placeholder: 'https://oapi.dingtalk.com/robot/send?access_token=...',
    hint: '群设置 -> 智能群助手 -> 添加机器人 -> 自定义 (Webhook)，支持 Markdown',
  },
  {
    id: 'wecom',
    name: '企业微信群机器人 (WeCom)',
    placeholder: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=...',
    hint: '群设置 -> 自动群机器人 -> 添加机器人，支持 Markdown 排版',
  },
  {
    id: 'serverchan',
    name: 'Server酱 · 方糖 (微信推送)',
    placeholder: 'https://sctapi.ftqq.com/SCTxxxx.send',
    hint: '微信直接接收通知，访问 sct.ftqq.com 免费获取 SendKey',
  },
  {
    id: 'bark',
    name: 'Bark (iOS 自托管/官方推送)',
    placeholder: 'https://api.day.app/your_key',
    hint: 'iOS 设备首选秒级静默/横幅弹窗，App Store 搜索 Bark 安装',
  },
  {
    id: 'custom',
    name: '自定义 JSON POST Webhook',
    placeholder: 'https://your-domain.com/api/webhook',
    hint: '发送包含 title、content、type 等字段的标准 JSON POST 请求',
  },
]

export const NotificationSettingsCard: React.FC<NotificationSettingsCardProps> = ({ onNotify }) => {
  const [config, setConfig] = useState<WebhookConfig>(DEFAULT_WEBHOOK_CONFIG)
  const [loading, setLoading] = useState(true)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null)

  useEffect(() => {
    getWebhookConfig()
      .then((data) => setConfig(data))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  const updateConfig = async (patch: Partial<WebhookConfig>) => {
    const updated = { ...config, ...patch }
    setConfig(updated)
    await saveWebhookConfig(updated)
    setTestResult(null)
    onNotify?.('通知配置已保存', 'success')
  }

  const handleTestSend = async () => {
    if (!config.webhookUrl.trim()) {
      onNotify?.('请先填写 Webhook 接收地址', 'warning')
      return
    }
    setTesting(true)
    setTestResult(null)
    try {
      const res = await testWebhookConnection(config)
      setTestResult(res)
      if (res.success) {
        onNotify?.(res.message, 'success')
      } else {
        onNotify?.(res.message, 'error')
      }
    } catch (e: any) {
      setTestResult({ success: false, message: e?.message || '测试失败' })
    } finally {
      setTesting(false)
    }
  }

  const currentChannelMeta = CHANNELS.find((c) => c.id === config.channel) || CHANNELS[0]

  if (loading) {
    return (
      <Card className="p-4 bg-white/80 backdrop-blur-sm border-gray-100 shadow-sm animate-pulse">
        <div className="h-5 bg-gray-200 rounded w-1/3 mb-4" />
        <div className="h-10 bg-gray-100 rounded mb-2" />
      </Card>
    )
  }

  return (
    <Card className="p-4 bg-white/80 backdrop-blur-sm border-gray-100 shadow-sm space-y-4">
      {/* 头部标题与总开关 */}
      <div className="flex items-center justify-between pb-2 border-b border-gray-100">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center text-primary">
            <Smartphone className="w-4 h-4" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h3 className="font-semibold text-gray-800 text-sm">跨端实时通知推送 (Webhook)</h3>
              <span className="text-[10px] bg-primary/10 text-primary font-medium px-1.5 py-0.5 rounded">
                手机实时通知
              </span>
            </div>
            <p className="text-xs text-gray-500 mt-0.5">
              HR面试邀约、每日管家战报、风控拦截实时同步推送至手机
            </p>
          </div>
        </div>

        {/* 总开关 */}
        <label className="relative inline-flex items-center cursor-pointer">
          <input
            type="checkbox"
            className="sr-only peer"
            checked={config.enabled}
            onChange={(e) => updateConfig({ enabled: e.target.checked })}
          />
          <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-primary"></div>
        </label>
      </div>

      {config.enabled && (
        <div className="space-y-3 pt-1 text-xs">
          {/* 渠道选择 */}
          <div>
            <label className="block text-gray-700 font-medium mb-1">推送渠道</label>
            <select
              value={config.channel}
              onChange={(e) => updateConfig({ channel: e.target.value as WebhookChannel })}
              className="w-full text-xs border border-gray-200 rounded-lg p-2 bg-gray-50/50 focus:bg-white focus:outline-none focus:ring-1 focus:ring-primary"
            >
              {CHANNELS.map((ch) => (
                <option key={ch.id} value={ch.id}>
                  {ch.name}
                </option>
              ))}
            </select>
            <p className="text-[11px] text-gray-400 mt-1">{currentChannelMeta.hint}</p>
          </div>

          {/* Webhook URL */}
          <div>
            <label className="block text-gray-700 font-medium mb-1 flex items-center gap-1">
              <Link className="w-3.5 h-3.5 text-gray-400" />
              Webhook 接收地址
            </label>
            <input
              type="text"
              value={config.webhookUrl}
              onChange={(e) => updateConfig({ webhookUrl: e.target.value })}
              placeholder={currentChannelMeta.placeholder}
              className="w-full text-xs font-mono border border-gray-200 rounded-lg p-2 bg-gray-50/50 focus:bg-white focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>

          {/* 密钥 (DingTalk/Feishu) */}
          {(config.channel === 'dingtalk' || config.channel === 'feishu') && (
            <div>
              <label className="block text-gray-700 font-medium mb-1 flex items-center gap-1">
                <Key className="w-3.5 h-3.5 text-gray-400" />
                加签安全密钥 (可选)
              </label>
              <input
                type="password"
                value={config.secret || ''}
                onChange={(e) => updateConfig({ secret: e.target.value })}
                placeholder="SEC... (若机器人设置了安全加签则必填)"
                className="w-full text-xs font-mono border border-gray-200 rounded-lg p-2 bg-gray-50/50 focus:bg-white focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>
          )}

          {/* 触发事件过滤 */}
          <div className="pt-2 border-t border-gray-100">
            <span className="block text-gray-700 font-medium mb-2">通知触发事件</span>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              <label className="flex items-center gap-2 p-2 rounded-lg border border-gray-200/60 bg-gray-50/40 cursor-pointer hover:bg-gray-50 transition-colors">
                <input
                  type="checkbox"
                  checked={config.notifyOnInterview}
                  onChange={(e) => updateConfig({ notifyOnInterview: e.target.checked })}
                  className="rounded text-primary focus:ring-primary h-3.5 w-3.5"
                />
                <div>
                  <div className="font-medium text-gray-800">🎉 面试邀约</div>
                  <div className="text-[10px] text-gray-400">收到面试立即推手机</div>
                </div>
              </label>

              <label className="flex items-center gap-2 p-2 rounded-lg border border-gray-200/60 bg-gray-50/40 cursor-pointer hover:bg-gray-50 transition-colors">
                <input
                  type="checkbox"
                  checked={config.notifyOnDailyReport}
                  onChange={(e) => updateConfig({ notifyOnDailyReport: e.target.checked })}
                  className="rounded text-primary focus:ring-primary h-3.5 w-3.5"
                />
                <div>
                  <div className="font-medium text-gray-800">📊 每日战报</div>
                  <div className="text-[10px] text-gray-400">投递结束与复盘推送</div>
                </div>
              </label>

              <label className="flex items-center gap-2 p-2 rounded-lg border border-gray-200/60 bg-gray-50/40 cursor-pointer hover:bg-gray-50 transition-colors">
                <input
                  type="checkbox"
                  checked={config.notifyOnRiskWarning}
                  onChange={(e) => updateConfig({ notifyOnRiskWarning: e.target.checked })}
                  className="rounded text-primary focus:ring-primary h-3.5 w-3.5"
                />
                <div>
                  <div className="font-medium text-gray-800">🚨 风控熔断</div>
                  <div className="text-[10px] text-gray-400">验证码/额度告警</div>
                </div>
              </label>
            </div>
          </div>

          {/* 测试按钮与测试结果反馈 */}
          <div className="flex items-center justify-between pt-2">
            <button
              onClick={handleTestSend}
              disabled={testing || !config.webhookUrl.trim()}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-primary/10 hover:bg-primary/20 text-primary font-medium rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Send className="w-3.5 h-3.5" />
              {testing ? '正在发送测试通知...' : '发送测试推送'}
            </button>

            {testResult && (
              <span
                className={`text-xs flex items-center gap-1 ${
                  testResult.success ? 'text-green-600 font-medium' : 'text-red-500'
                }`}
              >
                {testResult.success ? (
                  <Check className="w-3.5 h-3.5" />
                ) : (
                  <AlertTriangle className="w-3.5 h-3.5" />
                )}
                {testResult.message}
              </span>
            )}
          </div>
        </div>
      )}
    </Card>
  )
}
