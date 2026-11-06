import React, { useState, useRef, useEffect } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  Bot,
  Send,
  Sparkles,
  CheckCircle2,
  AlertTriangle,
  RotateCcw,
  Wrench,
} from 'lucide-react'
import {
  dispatchButlerAgentMessage,
  getButlerChatHistory,
  clearButlerChatHistory,
  type ButlerAgentMode,
  type ButlerPendingApproval,
  type ButlerToolCall,
} from '../../shared/agent/butler/chat-engine'
import { reportErrorAsync } from '../../shared/db/error-report'

const QUICK_PROMPTS = [
  { label: '📈 今天为什么投得少', prompt: '帮我看看今天为什么投递数量少，结合真实数据和错误日志分析原因' },
  { label: '📊 查投递漏斗', prompt: '查一下目前的投递统计与回复率，并给出建议' },
  { label: '💰 期望薪资 20-30K', prompt: '把期望薪资改成 20-30K' },
  { label: '🕒 工作时间 09:30-18:00', prompt: '工作时间设为 09:30-18:00' },
  { label: '⏱️ 拟人间歇 60-120秒', prompt: '拟人间歇设为 60-120 秒' },
  { label: '🛠️ 简历加 Docker、K8s', prompt: '简历加上技能 Docker、K8s' },
  { label: '📤 导出今日报表', prompt: '导出今天的投递记录为 CSV' },
]

const WELCOME = `👋 您好！我是您的**求职中控 Agent**。

现在不只是"下指令改配置"了：我可以自己查真实数据、连续调用多个工具、记住前面聊过的内容，也能回答开放问题。

试试这样问我：
- 🔍 *"今天为什么只投了几份？结合错误日志分析一下"*
- 📊 *"帮我看看投递漏斗，问题出在哪一步"*
- 💬 *"回复率太低了，我该怎么调？"*
- ⚙️ *"把各平台配额调到 60"*（会先弹确认）

涉及具体数字时我会先查数据，不会瞎猜。`

interface UiMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  createdAt: string
  mode?: ButlerAgentMode
  notice?: string
  toolTrace?: ButlerToolCall[]
  pendingApproval?: ButlerPendingApproval
}

function timeLabel(at?: number): string {
  if (!at) return new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  return new Date(at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}

const MODE_LABELS: Record<ButlerAgentMode, { text: string; cls: string }> = {
  agent: { text: 'AI Agent', cls: 'bg-emerald-50 text-emerald-600 border-emerald-200' },
  json_fallback: { text: 'JSON 兼容模式', cls: 'bg-amber-50 text-amber-700 border-amber-200' },
  offline: { text: '本地规则模式', cls: 'bg-slate-100 text-slate-500 border-slate-200' },
}

export default function ButlerChatView() {
  const [messages, setMessages] = useState<UiMessage[]>([
    { id: 'welcome', role: 'assistant', content: WELCOME, createdAt: timeLabel() },
  ])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [mode, setMode] = useState<ButlerAgentMode | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  const scrollToBottom = () => {
    const node = scrollRef.current
    if (node) node.scrollTo({ top: node.scrollHeight, behavior: 'smooth' })
  }

  useEffect(() => {
    scrollToBottom()
  }, [messages, loading])

  // 打开面板时恢复上一次的对话上下文（模型侧与界面侧同源）
  useEffect(() => {
    void getButlerChatHistory().then((history) => {
      if (!history || history.length === 0) return
      setMessages([
        { id: 'welcome', role: 'assistant', content: WELCOME, createdAt: timeLabel() },
        ...history.map((t, i) => ({
          id: `hist-${t.at}-${i}`,
          role: t.role,
          content: t.content,
          createdAt: timeLabel(t.at),
        })),
      ])
    })
  }, [])

  const pushAssistant = (reply: Awaited<ReturnType<typeof dispatchButlerAgentMessage>>, now: string) => {
    setMode(reply.mode)
    setMessages((prev) => [
      ...prev,
      {
        id: `a-${Date.now()}`,
        role: 'assistant',
        content: reply.content,
        createdAt: now,
        mode: reply.mode,
        notice: reply.notice,
        toolTrace: reply.toolTrace,
        pendingApproval: reply.pendingApproval,
      },
    ])
  }

  const handleSend = async (customText?: string) => {
    const textToSend = (customText || input).trim()
    if (!textToSend || loading) return
    const now = timeLabel()

    setMessages((prev) => [
      ...prev,
      { id: `u-${Date.now()}`, role: 'user', content: textToSend, createdAt: now },
    ])
    setInput('')
    setLoading(true)
    try {
      pushAssistant(await dispatchButlerAgentMessage(textToSend), now)
    } catch (err: any) {
      reportErrorAsync({
        source: 'butler.ui',
        message: `对话台发送失败：${err?.message || '未知错误'}`,
        context: JSON.stringify({ stage: 'send', inputLength: textToSend.length }),
        dedupeWindowMs: 60_000,
      })
      setMessages((prev) => [
        ...prev,
        {
          id: `a-${Date.now()}`,
          role: 'assistant',
          content: `执行失败：${err?.message || '未知错误'}（已写入管家「异常留痕」，可复制诊断）`,
          createdAt: now,
        },
      ])
    } finally {
      setLoading(false)
    }
  }

  // 审批卡只能生效一次：确认或取消后立刻把卡片从消息里移除，
  // 避免用户反复点击造成危险动作被重复执行（例如清空两次数据）
  const clearApproval = (pending: ButlerPendingApproval) => {
    setMessages((prev) => prev.map((m) => (
      m.pendingApproval === pending ? { ...m, pendingApproval: undefined } : m
    )))
  }

  const handleApprove = async (pending: ButlerPendingApproval) => {
    if (loading) return
    clearApproval(pending)
    setLoading(true)
    const now = timeLabel()
    try {
      pushAssistant(await dispatchButlerAgentMessage('', { approved: pending }), now)
    } catch (err: any) {
      reportErrorAsync({
        source: 'butler.ui',
        message: `审批执行失败：${err?.message || '未知错误'}`,
        context: JSON.stringify({ stage: 'approve', tool: pending.tool }),
        dedupeWindowMs: 60_000,
      })
      setMessages((prev) => [
        ...prev,
        { id: `a-${Date.now()}`, role: 'assistant', content: `审批执行失败：${err?.message || '未知错误'}（已写入「异常留痕」）`, createdAt: now },
      ])
    } finally {
      setLoading(false)
    }
  }

  const handleDeny = (pending: ButlerPendingApproval) => {
    clearApproval(pending)
    setMessages((prev) => [
      ...prev,
      {
        id: `a-${Date.now()}`,
        role: 'assistant',
        content: `✖ 已取消【${pending.displayName}】，未做任何改动。`,
        createdAt: timeLabel(),
      },
    ])
  }

  const clearChat = () => {
    void clearButlerChatHistory()
    setMode(null)
    setMessages([
      { id: `welcome-${Date.now()}`, role: 'assistant', content: '会话已清空，上下文重新开始。您可以随时向我提问或下达指令！', createdAt: timeLabel() },
    ])
  }

  const badge = mode ? MODE_LABELS[mode] : null

  return (
    <div className="flex flex-col h-[520px] bg-slate-50 border border-slate-200 rounded-xl overflow-hidden shadow-sm">
      <div className="flex items-center justify-between px-3.5 py-3 bg-white border-b border-slate-100">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-lg bg-orange-100 text-orange-600 flex items-center justify-center font-bold text-xs shadow-xs">
            <Bot className="w-4 h-4" />
          </div>
          <div>
            <div className="flex items-center gap-1.5">
              <h4 className="text-xs font-bold text-slate-800">智能中控对话台</h4>
              <span className={`px-1.5 py-0.5 text-[9px] font-semibold border rounded-md ${badge?.cls || 'bg-emerald-50 text-emerald-600 border-emerald-200'}`}>
                {badge?.text || 'Tool-Calling Agent'}
              </span>
            </div>
            <p className="text-[10px] text-slate-400">多轮上下文 · 可调用扩展内部工具 · 危险动作需确认</p>
          </div>
        </div>
        <button
          onClick={clearChat}
          title="清空聊天记录与上下文"
          className="p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-md transition-colors"
        >
          <RotateCcw className="w-3.5 h-3.5" />
        </button>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto p-3.5 space-y-3.5">
        {messages.map((m) => (
          <div key={m.id} className={`flex flex-col ${m.role === 'user' ? 'items-end' : 'items-start'}`}>
            <div
              className={`max-w-[88%] text-xs rounded-xl p-3 shadow-xs leading-relaxed whitespace-pre-wrap ${
                m.role === 'user'
                  ? 'bg-gradient-to-r from-orange-500 to-amber-500 text-white rounded-br-none'
                  : 'bg-white border border-slate-200/80 text-slate-800 rounded-bl-none'
              }`}
            >
              {m.role === 'assistant' ? (
                <div className="butler-md [&_p]:my-1 [&_strong]:font-semibold [&_ul]:list-disc [&_ul]:pl-4 [&_ol]:list-decimal [&_ol]:pl-4 [&_code]:bg-slate-100 [&_code]:px-1 [&_code]:rounded [&_a]:text-orange-600 [&_a]:underline">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown>
                </div>
              ) : (
                m.content
              )}

              {m.notice && (
                <div className="mt-2 pt-2 border-t border-amber-100 flex items-start gap-1.5 text-[10px] text-amber-700 leading-relaxed">
                  <AlertTriangle className="w-3 h-3 shrink-0 mt-0.5" />
                  <span>{m.notice}</span>
                </div>
              )}

              {m.toolTrace && m.toolTrace.length > 0 && (
                <details className="mt-2 pt-2 border-t border-slate-100 text-[10px] text-slate-500">
                  <summary className="cursor-pointer flex items-center gap-1 font-medium text-slate-600">
                    <Wrench className="w-3 h-3" />
                    已调用 {m.toolTrace.length} 个工具 · 查看执行轨迹
                  </summary>
                  <ul className="mt-1.5 space-y-1 pl-1">
                    {m.toolTrace.map((t, i) => (
                      <li key={`${t.name}-${i}`} className="flex items-start gap-1">
                        {t.ok ? (
                          <CheckCircle2 className="w-3 h-3 shrink-0 mt-0.5 text-emerald-500" />
                        ) : (
                          <AlertTriangle className="w-3 h-3 shrink-0 mt-0.5 text-amber-500" />
                        )}
                        <span className="break-all">
                          <b>{t.name}</b>（{t.risk}）· {t.summary}
                        </span>
                      </li>
                    ))}
                  </ul>
                </details>
              )}

              {m.pendingApproval && (
                <div className="mt-2.5 p-2 bg-amber-50 border border-amber-200 rounded-lg">
                  <div className="flex items-center gap-1 text-[11px] font-bold text-amber-900 mb-1.5">
                    <AlertTriangle className="w-3.5 h-3.5 text-amber-600" />
                    <span>需要您的审批确认</span>
                  </div>
                  <div className="flex gap-2 mt-2">
                    <button
                      disabled={loading}
                      onClick={() => handleApprove(m.pendingApproval!)}
                      className="flex-1 py-1 px-2 bg-red-600 hover:bg-red-700 text-white rounded text-[11px] font-semibold transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      确认执行
                    </button>
                    <button
                      disabled={loading}
                      onClick={() => handleDeny(m.pendingApproval!)}
                      className="flex-1 py-1 px-2 bg-slate-200 hover:bg-slate-300 text-slate-700 rounded text-[11px] font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
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
            <span>Agent 正在查数据 / 调度工具...</span>
          </div>
        )}
      </div>

      <div className="px-3 py-2 bg-slate-100/70 border-t border-slate-200/60 overflow-x-auto flex gap-2 no-scrollbar">
        {QUICK_PROMPTS.map((chip, idx) => (
          <button
            key={idx}
            disabled={loading}
            onClick={() => handleSend(chip.prompt)}
            className="shrink-0 text-[11px] bg-white border border-slate-200 hover:border-orange-300 hover:text-orange-600 px-2.5 py-1.5 rounded-full text-slate-600 transition-colors shadow-xs"
          >
            {chip.label}
          </button>
        ))}
      </div>

      <div className="p-3 bg-white border-t border-slate-100 flex gap-2 items-center">
        <input
          type="text"
          value={input}
          disabled={loading}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSend()}
          placeholder="直接提问，如：今天为什么只投了 8 份？"
          className="flex-1 text-xs border border-slate-200 rounded-lg px-3 py-2.5 focus:outline-none focus:ring-1 focus:ring-orange-500 focus:border-orange-500 bg-slate-50/50"
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
