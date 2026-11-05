import React, { useState, useRef, useEffect } from 'react'
import {
  Bot,
  Send,
  Sparkles,
  CheckCircle2,
  AlertTriangle,
  RotateCcw,
} from 'lucide-react'
import {
  dispatchButlerChatMessage,
  type ButlerChatMessage,
  type PendingApprovalAction,
} from '../../shared/agent/butler/chat-to-action'

const QUICK_PROMPTS = [
  { label: '📊 导出今日报表', prompt: '导出今天的投递记录为 CSV' },
  { label: '💰 期望薪资调为 20-30K', prompt: '把期望薪资改成 20-30K' },
  { label: '🕒 工作时间 09:30-18:00', prompt: '工作时间设为 09:30-18:00' },
  { label: '⏱️ 拟人间歇 60-120秒', prompt: '拟人间歇设为 60-120 秒' },
  { label: '🛠️ 简历增加技能 Docker、K8s', prompt: '简历加上技能 Docker、K8s' },
  { label: '📈 查看投递漏斗统计', prompt: '查一下目前的投递统计与回复率' },
]

export default function ButlerChatView() {
  const [messages, setMessages] = useState<ButlerChatMessage[]>([
    {
      id: 'welcome',
      role: 'assistant',
      content: `👋 您好！我是您的**求职 Bot 智能管家**。
您不需要手动查找复杂的设置项，直接在下方对我说话即可操纵系统！
比如：
- 💰 *“把期望薪资改成 20-30K，最快1周到岗”*
- 🕒 *“工作时间设为 09:30-18:00，拟人间歇 60-150秒”*
- 🛠️ *“简历加上技术栈 Next.js、Docker”*
- 📊 *“导出今天的投递记录为 CSV 表格”*
- 📈 *“查一下今天的投递数据与回复率”*`,
      createdAt: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
    },
  ])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }

  useEffect(() => {
    scrollToBottom()
  }, [messages, loading])

  const handleSend = async (customText?: string) => {
    const textToSend = (customText || input).trim()
    if (!textToSend || loading) return

    const now = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    const userMsg: ButlerChatMessage = {
      id: Date.now().toString(),
      role: 'user',
      content: textToSend,
      createdAt: now,
    }

    setMessages((prev) => [...prev, userMsg])
    setInput('')
    setLoading(true)

    try {
      const response = await dispatchButlerChatMessage(textToSend)
      setMessages((prev) => [...prev, response])
    } catch (err: any) {
      setMessages((prev) => [
        ...prev,
        {
          id: Date.now().toString(),
          role: 'assistant',
          content: `执行失败：${err?.message || '未知错误'}`,
          createdAt: now,
        },
      ])
    } finally {
      setLoading(false)
    }
  }

  const handleApprove = async (pending: PendingApprovalAction) => {
    setLoading(true)
    try {
      const response = await dispatchButlerChatMessage('', pending)
      setMessages((prev) => [...prev, response])
    } catch (err: any) {
      setMessages((prev) => [
        ...prev,
        {
          id: Date.now().toString(),
          role: 'assistant',
          content: `审批执行失败：${err?.message || '未知错误'}`,
          createdAt: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
        },
      ])
    } finally {
      setLoading(false)
    }
  }

  const handleDeny = (pending: PendingApprovalAction) => {
    setMessages((prev) => [
      ...prev,
      {
        id: Date.now().toString(),
        role: 'assistant',
        content: `✖ 已取消操作【${pending.displayName}】，您的数据未发生任何变动。`,
        createdAt: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
      },
    ])
  }

  const clearChat = () => {
    setMessages([
      {
        id: Date.now().toString(),
        role: 'assistant',
        content: '会话已清空。您可以随时向我下达新的指令！',
        createdAt: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
      },
    ])
  }

  return (
    <div className="flex flex-col h-[520px] bg-slate-50 border border-slate-200 rounded-xl overflow-hidden shadow-sm">
      {/* 头部状态条 */}
      <div className="flex items-center justify-between px-3.5 py-2.5 bg-white border-b border-slate-100">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-lg bg-orange-100 text-orange-600 flex items-center justify-center font-bold text-xs shadow-xs">
            <Bot className="w-4 h-4" />
          </div>
          <div>
            <div className="flex items-center gap-1.5">
              <h4 className="text-xs font-bold text-slate-800">智能中控对话台</h4>
              <span className="px-1.5 py-0.5 text-[9px] font-semibold bg-emerald-50 text-emerald-600 border border-emerald-200 rounded-md">
                Chat-to-Action 随时待命
              </span>
            </div>
            <p className="text-[10px] text-slate-400">自然语言直接修改简历/配置/导出数据</p>
          </div>
        </div>
        <button
          onClick={clearChat}
          title="清空聊天记录"
          className="p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-md transition-colors"
        >
          <RotateCcw className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* 消息滚动流 */}
      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {messages.map((m) => (
          <div
            key={m.id}
            className={`flex flex-col ${m.role === 'user' ? 'items-end' : 'items-start'}`}
          >
            <div
              className={`max-w-[88%] text-xs rounded-xl p-2.5 shadow-xs leading-relaxed whitespace-pre-wrap ${
                m.role === 'user'
                  ? 'bg-gradient-to-r from-orange-500 to-amber-500 text-white rounded-br-none'
                  : 'bg-white border border-slate-200/80 text-slate-800 rounded-bl-none'
              }`}
            >
              {m.content}

              {/* 动作执行成功卡片 */}
              {m.actionResult && (
                <div className="mt-2 pt-2 border-t border-slate-100 flex items-center gap-1.5 text-[11px] text-emerald-600 font-medium">
                  <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                  <span>已自动执行：{m.actionResult.displayName}</span>
                </div>
              )}

              {/* 高危操作人机审批确认卡 */}
              {m.pendingApproval && (
                <div className="mt-2.5 p-2 bg-amber-50 border border-amber-200 rounded-lg">
                  <div className="flex items-center gap-1 text-[11px] font-bold text-amber-900 mb-1.5">
                    <AlertTriangle className="w-3.5 h-3.5 text-amber-600" />
                    <span>需要您的审批确认</span>
                  </div>
                  <div className="flex gap-2 mt-2">
                    <button
                      onClick={() => handleApprove(m.pendingApproval!)}
                      className="flex-1 py-1 px-2 bg-red-600 hover:bg-red-700 text-white rounded text-[11px] font-semibold transition-colors"
                    >
                      确认执行
                    </button>
                    <button
                      onClick={() => handleDeny(m.pendingApproval!)}
                      className="flex-1 py-1 px-2 bg-slate-200 hover:bg-slate-300 text-slate-700 rounded text-[11px] font-medium transition-colors"
                    >
                      取消
                    </button>
                  </div>
                </div>
              )}
            </div>
            <span className="text-[9px] text-slate-400 mt-1 px-1">{m.createdAt}</span>
          </div>
        ))}

        {loading && (
          <div className="flex items-center gap-1.5 text-slate-400 text-xs py-1">
            <Sparkles className="w-3.5 h-3.5 animate-spin text-orange-500" />
            <span>智能管家正在调度执行...</span>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* 快捷推荐芯片 (Prompt Chips) */}
      <div className="px-2.5 py-1.5 bg-slate-100/70 border-t border-slate-200/60 overflow-x-auto flex gap-1.5 no-scrollbar">
        {QUICK_PROMPTS.map((chip, idx) => (
          <button
            key={idx}
            disabled={loading}
            onClick={() => handleSend(chip.prompt)}
            className="shrink-0 text-[10px] bg-white border border-slate-200 hover:border-orange-300 hover:text-orange-600 px-2 py-1 rounded-full text-slate-600 transition-colors shadow-xs"
          >
            {chip.label}
          </button>
        ))}
      </div>

      {/* 输入框与发送 */}
      <div className="p-2.5 bg-white border-t border-slate-100 flex gap-1.5 items-center">
        <input
          type="text"
          value={input}
          disabled={loading}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSend()}
          placeholder="给管家下达指令，如：期望薪资改成20-30K、导出今天数据..."
          className="flex-1 text-xs border border-slate-200 rounded-lg px-2.5 py-2 focus:outline-none focus:ring-1 focus:ring-orange-500 focus:border-orange-500 bg-slate-50/50"
        />
        <button
          onClick={() => handleSend()}
          disabled={loading || !input.trim()}
          className="p-2 bg-gradient-to-r from-orange-500 to-amber-500 text-white rounded-lg hover:shadow-sm disabled:opacity-40 disabled:cursor-not-allowed transition-all"
        >
          <Send className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  )
}
