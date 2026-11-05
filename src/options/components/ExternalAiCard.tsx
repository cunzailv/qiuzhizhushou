import React, { useEffect, useState } from 'react'
import { Card } from '../../components/ui/card'
import { Button } from '../../components/ui/button'
import {
  Bot, Plug, Copy, Check, RefreshCw, ShieldAlert, ChevronDown, Terminal, CircleCheck, CircleX, Loader2,
} from 'lucide-react'
import {
  getExternalAiConfig, saveExternalAiConfig, getExternalAiStatus,
  subscribeExternalAiStatus,
} from '../../shared/bridge/config'
import { TOOL_DEFINITIONS, TOOL_COUNTS } from '../../shared/bridge/tools'
import { MSG_EXTERNAL_AI_CONTROL, DEFAULT_BRIDGE_URL } from '../../shared/bridge/types'
import type { ExternalAiConfig, ExternalAiStatus, ToolRisk } from '../../shared/bridge/types'

type Notify = (message: string, type: 'success' | 'error' | 'warning' | 'info') => void

const RISK_STYLE: Record<ToolRisk, string> = {
  read: 'bg-info/10 text-info border-info/20',
  write: 'bg-warning/10 text-amber-700 border-warning/20',
  dangerous: 'bg-danger/10 text-danger border-danger/20',
}
const RISK_LABEL: Record<ToolRisk, string> = { read: '只读', write: '写入', dangerous: '危险·需授权' }

function Toggle({ checked, onChange, label, hint, danger }: {
  checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string; danger?: boolean
}) {
  return (
    <label className="flex items-start gap-3 cursor-pointer py-1.5">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className={`w-4 h-4 mt-0.5 rounded ${danger ? 'accent-danger' : 'accent-primary'}`}
      />
      <span>
        <span className={`block text-sm ${danger ? 'text-danger font-medium' : 'text-text-secondary'}`}>{label}</span>
        {hint && <span className="block text-[11px] text-text-muted mt-0.5 leading-relaxed">{hint}</span>}
      </span>
    </label>
  )
}

export function ExternalAiCard({ onNotify }: { onNotify: Notify }) {
  const [config, setConfig] = useState<ExternalAiConfig | null>(null)
  const [status, setStatus] = useState<ExternalAiStatus | null>(null)
  const [urlDraft, setUrlDraft] = useState(DEFAULT_BRIDGE_URL)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState<string | null>(null)
  const [showTools, setShowTools] = useState(false)
  const [health, setHealth] = useState<string | null>(null)

  async function refresh() {
    const [cfg, st] = await Promise.all([getExternalAiConfig(), getExternalAiStatus()])
    setConfig(cfg)
    setStatus(st)
    setUrlDraft(cfg.bridgeUrl)
  }

  useEffect(() => {
    void refresh()
    const unsubscribe = subscribeExternalAiStatus((st) => setStatus(st))
    const timer = window.setInterval(() => { void refresh() }, 4000)
    return () => { unsubscribe(); window.clearInterval(timer) }
  }, [])

  async function patch(next: Partial<ExternalAiConfig>, message?: string) {
    const saved = await saveExternalAiConfig(next)
    setConfig(saved)
    if (saved.enabled) {
      try { await chrome.runtime.sendMessage({ type: MSG_EXTERNAL_AI_CONTROL, payload: { action: 'ensure' } }) } catch { /* ignore */ }
    }
    if (message) onNotify(message, 'success')
  }

  async function handleConnect() {
    setBusy(true)
    try {
      const saved = await saveExternalAiConfig({ enabled: true, bridgeUrl: urlDraft.trim(), paired: false, token: '' })
      setConfig(saved)
      await chrome.runtime.sendMessage({ type: MSG_EXTERNAL_AI_CONTROL, payload: { action: 'ensure' } })
      let ok = false
      for (let i = 0; i < 12; i++) {
        await new Promise((r) => setTimeout(r, 700))
        const st = await getExternalAiStatus()
        setStatus(st)
        if (st.connected && st.paired) { ok = true; break }
        if (st.lastError && i > 2) break
      }
      onNotify(ok ? '已连接本地桥接服务，外部 AI 可以调用了' : '未连上：请确认已运行 ./scripts/install.sh，且终端里桥接服务在线', ok ? 'success' : 'error')
    } catch (err) {
      onNotify(`连接失败：${String(err)}`, 'error')
    } finally { setBusy(false) }
  }

  async function handleTest() {
    try {
      const res = await fetch(`${urlDraft.trim().replace(/\/+$/, '')}/health`, { signal: AbortSignal.timeout(4000) })
      const body = await res.json() as { version?: string; toolsCount?: number; extensionConnected?: boolean }
      setHealth(`v${body.version || '?'} · ${body.toolsCount ?? 0} 个工具 · 扩展${body.extensionConnected ? '已连接' : '未连接'}`)
      onNotify('桥接服务在线', 'success')
    } catch (err) {
      setHealth(`无法连接：${String((err as { message?: string })?.message || err)}`)
      onNotify('桥接服务不在线，请先运行 ./scripts/install.sh', 'error')
    }
  }

  async function copy(key: string, text: string) {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(key)
      window.setTimeout(() => setCopied(null), 1800)
      onNotify('已复制到剪贴板', 'success')
    } catch { onNotify('复制失败，请手动选择文本', 'error') }
  }

  const connected = !!status?.connected && !!config?.enabled
  const stateLabel = !config?.enabled ? '未开启' : connected ? '已连接' : '连接中 / 未配对'
  const stateClass = !config?.enabled
    ? 'bg-black/5 text-text-muted border-black/10'
    : connected ? 'bg-success/10 text-success border-success/20' : 'bg-warning/10 text-amber-700 border-warning/20'

  return (
    <Card>
      <div className="flex items-center gap-2 mb-1">
        <Bot className="w-5 h-5 text-primary-light" />
        <span className="font-semibold text-text-primary">外部 AI 接入</span>
        <span className={`ml-auto text-[11px] px-2 py-0.5 rounded-full border font-medium flex items-center gap-1 ${stateClass}`}>
          {connected ? <CircleCheck className="w-3 h-3" /> : busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <CircleX className="w-3 h-3" />}
          {stateLabel}
        </span>
      </div>
      <p className="text-xs text-text-muted mb-4 leading-relaxed">
        让 <b>Claude Code / Codex / Cursor / OpenClaw 小龙虾</b> 等外部 AI 通过本机 MCP 服务读写求职数据、控制 AIbot。
        数据只在 127.0.0.1 本机流转，默认关闭，危险动作默认禁止。
      </p>

      <div className="space-y-3">
        <Toggle
          checked={!!config?.enabled}
          onChange={(v) => { void patch({ enabled: v }, v ? '已开启，点击下方「连接本地桥接」完成配对' : '已关闭外部 AI 接入') }}
          label="启用外部 AI 接入（总开关）"
          hint="关闭后所有外部调用立即被拒绝；桥接页面也会停止长轮询。"
        />

        <div>
          <label className="text-xs text-text-muted mb-1.5 block">本地桥接服务地址</label>
          <div className="flex gap-2">
            <input
              type="text"
              value={urlDraft}
              onChange={(e) => setUrlDraft(e.target.value)}
              onBlur={() => { if (urlDraft.trim() && urlDraft.trim() !== config?.bridgeUrl) void patch({ bridgeUrl: urlDraft.trim() }, '桥接地址已保存') }}
              className="flex-1 px-3 py-2 rounded-lg bg-surface-darkest border border-black/10 text-sm text-text-primary font-mono focus:border-primary-light focus:outline-none"
              placeholder={DEFAULT_BRIDGE_URL}
            />
            <Button variant="secondary" size="sm" onClick={() => void handleTest()}>测试</Button>
          </div>
          {health && <p className="text-[11px] text-text-muted mt-1.5 font-mono break-all">{health}</p>}
        </div>

        <div className="rounded-xl border border-black/10 bg-black/[0.02] p-3 space-y-1">
          <Toggle
            checked={config?.allowWrite !== false}
            onChange={(v) => { void patch({ allowWrite: v }) }}
            label="允许外部 AI 修改配置 / 写数据"
            hint="改各平台投递数、加黑名单、生成日报、写面试日历等。"
          />
          <Toggle
            checked={!!config?.allowDangerous}
            onChange={(v) => { void patch({ allowDangerous: v }, v ? '已允许危险动作，调用时仍需 confirm=true' : undefined) }}
            label="允许外部 AI 执行危险动作"
            hint="启动/恢复真实投递、采集岗位、清空投递记录。即使开启，每次调用也必须显式带 confirm=true。"
            danger
          />
        </div>

        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => void handleConnect()} loading={busy}>
            <Plug className="w-3.5 h-3.5" /> 连接本地桥接
          </Button>
          <Button variant="secondary" size="sm" onClick={() => void patch({ paired: false, token: '' }, '已重置配对，请重新点「连接本地桥接」')}>
            <RefreshCw className="w-3.5 h-3.5" /> 重新配对
          </Button>
          <Button variant="secondary" size="sm" onClick={() => void copy('install', './scripts/install.sh')}>
            <Terminal className="w-3.5 h-3.5" /> {copied === 'install' ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />} 安装命令
          </Button>
          <Button variant="secondary" size="sm" onClick={() => void copy('mcp', JSON.stringify({ mcpServers: { qiuzhizhushou: { type: 'http', url: `${config?.bridgeUrl || DEFAULT_BRIDGE_URL}/mcp`, headers: { Authorization: `Bearer ${config?.token || '<运行 install.sh 后自动写入>'}` } } } }, null, 2))}>
            <Copy className="w-3.5 h-3.5" /> 复制 MCP 配置
          </Button>
        </div>

        <div className="rounded-xl border border-black/10 bg-surface-darkest p-3">
          <button
            type="button"
            onClick={() => setShowTools(!showTools)}
            className="w-full flex items-center gap-2 text-xs font-medium text-text-primary cursor-pointer"
          >
            <span>可调用工具：共 {TOOL_COUNTS.total} 个</span>
            <span className="text-[10px] text-info">只读 {TOOL_COUNTS.read}</span>
            <span className="text-[10px] text-amber-700">写入 {TOOL_COUNTS.write}</span>
            <span className="text-[10px] text-danger">危险 {TOOL_COUNTS.dangerous}</span>
            <ChevronDown className={`w-3.5 h-3.5 ml-auto transition-transform ${showTools ? 'rotate-180' : ''}`} />
          </button>
          {showTools && (
            <div className="mt-3 max-h-64 overflow-y-auto space-y-1.5">
              {TOOL_DEFINITIONS.map((tool) => (
                <div key={tool.name} className="flex items-start gap-2 text-[11px]">
                  <span className={`shrink-0 px-1.5 py-0.5 rounded border ${RISK_STYLE[tool.risk]}`}>{RISK_LABEL[tool.risk]}</span>
                  <code className="font-mono text-text-primary shrink-0">{tool.name}</code>
                  <span className="text-text-muted leading-relaxed">{tool.description}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {status?.lastError && (
          <div className="flex items-start gap-2 p-2.5 rounded-lg bg-danger/10 border border-danger/20">
            <ShieldAlert className="w-4 h-4 text-danger shrink-0 mt-0.5" />
            <p className="text-[11px] text-danger break-all leading-relaxed">{status.lastError}</p>
          </div>
        )}

        <div className="rounded-xl border border-warning/20 bg-warning/5 p-3">
          <p className="text-[11px] text-text-secondary leading-relaxed">
            <b>一条龙安装：</b>在项目目录运行 <code className="font-mono">./scripts/install.sh</code>，脚本会自动构建扩展、生成令牌、
            写入 Claude Code / Codex / Cursor / 小龙虾 的 MCP 配置并启动服务。
            最后只需在 Chrome 加载 <code className="font-mono">dist/</code> 并点上面的「连接本地桥接」。
            详见 <code className="font-mono">docs/EXTERNAL_AI.md</code>。
          </p>
        </div>
      </div>
    </Card>
  )
}
