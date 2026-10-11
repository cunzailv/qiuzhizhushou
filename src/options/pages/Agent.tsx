import React, { useEffect, useState } from 'react'
import { Card } from '../../components/ui/card'
import { Toast } from '../../components/ui/toast'
import { PROMPT_REGISTRY, getPrompt, setPrompt, resetPrompt, getPromptOverrides } from '../../shared/db/prompt-store'
import { AGENT_ROLES, getAgentRole, setAgentRole, type AgentRoleId } from '../../shared/agent/agent-role'
import { listSkills, setSkillEnabled, deleteSkill } from '../../shared/agent/skill-memory'
import type { AgentSkill } from '../../shared/agent/types'
import { Bot, Sparkles, MessagesSquare, Cog, Save, RotateCcw, Trash2, Power } from 'lucide-react'

const CATEGORY_META: Record<string, { label: string; icon: React.ReactNode; desc: string }> = {
  ai: { label: 'AI 分析', icon: <Sparkles className="w-4 h-4" />, desc: '匹配评分、简历画像、JD 分析等分析类提示词' },
  butler: { label: '管家沟通', icon: <MessagesSquare className="w-4 h-4" />, desc: '投递打招呼、HR 问题自动应答' },
  agent: { label: '自动化 Agent', icon: <Cog className="w-4 h-4" />, desc: 'Harness 核心：投递/沟通自动化的决策提示词' },
}

function formatTime(ts: number): string {
  if (!ts) return '-'
  const d = new Date(ts)
  return `${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export default function Agent() {
  const [role, setRole] = useState<AgentRoleId>('custom')
  const [prompts, setPrompts] = useState<Record<string, string>>({})
  const [dirty, setDirty] = useState<Set<string>>(new Set())
  const [skills, setSkills] = useState<AgentSkill[]>([])
  const [toast, setToast] = useState<{ visible: boolean; message: string; type: 'success' | 'error' | 'warning' | 'info' }>({ visible: false, message: '', type: 'info' })

  useEffect(() => {
    loadAll()
  }, [])

  async function loadAll() {
    const [r, overrides, skillList] = await Promise.all([getAgentRole(), getPromptOverrides(), listSkills()])
    setRole(r)
    const current: Record<string, string> = {}
    for (const def of PROMPT_REGISTRY) {
      current[def.key] = overrides[def.key] ?? def.default
    }
    setPrompts(current)
    setSkills(skillList)
  }

  function showToast(message: string, type: 'success' | 'error' | 'warning' | 'info' = 'success') {
    setToast({ visible: true, message, type })
    setTimeout(() => setToast({ ...toast, visible: false }), 3000)
  }

  async function handleSetRole(next: AgentRoleId) {
    await setAgentRole(next)
    setRole(next)
    showToast(`已切换到「${AGENT_ROLES.find(r => r.id === next)?.name}」${next === 'custom' ? '（参数不变）' : '，对应参数已应用'}`)
  }

  function handlePromptChange(key: string, value: string) {
    setPrompts((p) => ({ ...p, [key]: value }))
    setDirty((d) => new Set(d).add(key))
  }

  async function handleSavePrompt(key: string) {
    await setPrompt(key, prompts[key])
    setDirty((d) => { const next = new Set(d); next.delete(key); return next })
    showToast('提示词已保存（运行时即时生效）')
  }

  async function handleResetPrompt(key: string) {
    await resetPrompt(key)
    setPrompts((p) => {
      const def = PROMPT_REGISTRY.find((x) => x.key === key)
      return { ...p, [key]: def?.default ?? '' }
    })
    setDirty((d) => { const next = new Set(d); next.delete(key); return next })
    showToast('已恢复默认提示词', 'info')
  }

  async function handleToggleSkill(skill: AgentSkill) {
    const next = skill.enabled !== false ? false : true
    await setSkillEnabled(skill.id, next)
    setSkills((list) => list.map((s) => (s.id === skill.id ? { ...s, enabled: next } : s)))
    showToast(next ? '技能已启用' : '技能已停用（自动化将不再使用它）', next ? 'success' : 'warning')
  }

  async function handleDeleteSkill(skill: AgentSkill) {
    await deleteSkill(skill.id)
    setSkills((list) => list.filter((s) => s.id !== skill.id))
    showToast('技能已删除', 'info')
  }

  const changedCount = dirty.size

  return (
    <div className="max-w-4xl space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-text-primary">智能体配置</h2>
        <p className="text-sm text-text-muted mt-1">角色预设 · 提示词编辑 · 自动化技能管理</p>
      </div>

      {/* ─── 角色预设（F2） ─── */}
      <Card>
        <div className="flex items-center gap-2 mb-1">
          <Bot className="w-5 h-5 text-primary-light" />
          <span className="font-semibold text-text-primary">智能体角色</span>
        </div>
        <p className="text-xs text-text-muted mb-4">角色决定匹配门槛与投递策略；安全护栏（AI 动作权限）不受角色影响，始终以设置页为准。</p>
        <div className="grid grid-cols-3 gap-3">
          {AGENT_ROLES.map((r) => (
            <button
              key={r.id}
              onClick={() => handleSetRole(r.id)}
              className={`text-left p-4 rounded-2xl border transition-all ${
                role === r.id
                  ? 'border-primary/40 bg-primary/10 shadow-glow'
                  : 'border-black/10 bg-surface-darkest hover:border-black/20'
              }`}
            >
              <div className="flex items-center justify-between mb-1.5">
                <span className="font-semibold text-text-primary">{r.name}</span>
                {role === r.id && <span className="w-2 h-2 rounded-full bg-primary-light" />}
              </div>
              <p className="text-xs text-text-muted leading-relaxed">{r.description}</p>
              <div className="mt-3 flex gap-1.5">
                {Object.entries(r.params ?? {}).map(([k, v]) => (
                  <span key={k} className="px-1.5 py-0.5 rounded-md bg-black/5 text-[10px] text-text-muted">
                    {k === 'applyMode' ? (v === 'batch' ? '批量沟通' : 'AI推荐') : k === 'enableAiMatch' ? (v ? 'AI评分' : '不评分') : `${k}:${v}`}
                  </span>
                ))}
              </div>
            </button>
          ))}
        </div>
      </Card>

      {/* ─── 提示词编辑（F1） ─── */}
      <Card>
        <div className="flex items-center justify-between mb-1">
          <div className="flex items-center gap-2">
            <Sparkles className="w-5 h-5 text-primary-light" />
            <span className="font-semibold text-text-primary">提示词编辑</span>
          </div>
          {changedCount > 0 && (
            <span className="text-xs text-primary-light font-medium">{changedCount} 处未保存</span>
          )}
        </div>
        <p className="text-xs text-text-muted mb-4">修改后点「保存」即时生效，未保存的改动重启后丢弃；「恢复默认」回到内置版本。</p>

        {(['ai', 'butler', 'agent'] as const).map((cat) => {
          const meta = CATEGORY_META[cat]
          const items = PROMPT_REGISTRY.filter((p) => p.category === cat)
          return (
            <div key={cat} className="mb-5 last:mb-0">
              <div className="flex items-center gap-2 mb-1">
                {meta.icon}
                <span className="text-sm font-medium text-text-primary">{meta.label}</span>
                <span className="text-[11px] text-text-muted">{meta.desc}</span>
              </div>
              <div className="space-y-3">
                {items.map((def) => {
                  const isDirty = dirty.has(def.key)
                  const value = prompts[def.key] ?? def.default
                  return (
                    <div key={def.key} className="rounded-xl border border-black/10 bg-surface-darkest overflow-hidden">
                      <div className="flex items-center justify-between px-3 py-2 bg-black/[0.03]">
                        <div>
                          <span className="text-sm font-medium text-text-primary">{def.label}</span>
                          <span className="ml-2 text-[11px] text-text-muted">{def.description}</span>
                        </div>
                        <div className="flex items-center gap-1.5">
                          {isDirty && (
                            <span className="text-[10px] text-primary-light font-medium">未保存</span>
                          )}
                          <button
                            onClick={() => handleSavePrompt(def.key)}
                            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-gradient-to-r from-orange-400 to-orange-500 text-white text-xs font-medium hover:opacity-90 transition-opacity"
                          >
                            <Save className="w-3 h-3" />
                            保存
                          </button>
                          <button
                            onClick={() => handleResetPrompt(def.key)}
                            className="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-black/5 text-text-muted text-xs hover:text-text-primary transition-colors"
                            title="恢复默认"
                          >
                            <RotateCcw className="w-3 h-3" />
                          </button>
                        </div>
                      </div>
                      <textarea
                        value={value}
                        onChange={(e) => handlePromptChange(def.key, e.target.value)}
                        rows={Math.min(10, Math.max(5, value.split('\n').length + 1))}
                        className="w-full px-3 py-2.5 bg-transparent text-[13px] leading-relaxed text-text-primary font-mono placeholder-text-muted focus:outline-none resize-y"
                        spellCheck={false}
                      />
                    </div>
                  )
                })}
              </div>
            </div>
          )
        })}
      </Card>

      {/* ─── 技能管理（F3） ─── */}
      <Card>
        <div className="flex items-center gap-2 mb-1">
          <Cog className="w-5 h-5 text-primary-light" />
          <span className="font-semibold text-text-primary">自动化技能</span>
        </div>
        <p className="text-xs text-text-muted mb-4">Harness 自动沉淀的投递动作序列；停用后自动化不再命中该技能。</p>

        {skills.length === 0 ? (
          <div className="p-8 text-center rounded-xl bg-black/[0.02] border border-dashed border-black/10">
            <Cog className="w-8 h-8 mx-auto mb-2 text-text-muted/50" />
            <p className="text-sm text-text-muted">暂无已沉淀技能</p>
            <p className="text-xs text-text-muted/60 mt-1">在招聘页使用 AI 自动化投递成功后，动作序列会自动记录在这里</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-text-muted border-b border-black/10">
                  <th className="py-2 px-2 font-medium">平台 / 页面</th>
                  <th className="py-2 px-2 font-medium">目标</th>
                  <th className="py-2 px-2 font-medium text-right">步骤</th>
                  <th className="py-2 px-2 font-medium text-right">成功</th>
                  <th className="py-2 px-2 font-medium text-right">失败</th>
                  <th className="py-2 px-2 font-medium">最后使用</th>
                  <th className="py-2 px-2 font-medium text-center">状态</th>
                  <th className="py-2 px-2 font-medium text-right">操作</th>
                </tr>
              </thead>
              <tbody>
                {skills.map((s) => {
                  const enabled = s.enabled !== false
                  return (
                    <tr key={s.id} className="border-b border-black/5 text-text-primary">
                      <td className="py-2.5 px-2">
                        <span className="font-medium">{s.platform}</span>
                        <span className="text-text-muted text-xs ml-1.5">{s.pageType}</span>
                      </td>
                      <td className="py-2.5 px-2 text-xs max-w-[180px] truncate" title={s.goal}>{s.goal}</td>
                      <td className="py-2.5 px-2 text-right text-xs text-text-muted">{s.steps.length}</td>
                      <td className="py-2.5 px-2 text-right text-xs text-success">{s.successCount}</td>
                      <td className="py-2.5 px-2 text-right text-xs text-warning">{s.failCount}</td>
                      <td className="py-2.5 px-2 text-xs text-text-muted">{formatTime(s.lastUsedAt)}</td>
                      <td className="py-2.5 px-2 text-center">
                        <button
                          onClick={() => handleToggleSkill(s)}
                          className={`inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-medium transition-colors ${
                            enabled
                              ? 'bg-success/10 text-success hover:bg-success/20'
                              : 'bg-warning/10 text-warning hover:bg-warning/20'
                          }`}
                        >
                          <Power className="w-3 h-3" />
                          {enabled ? '启用中' : '已停用'}
                        </button>
                      </td>
                      <td className="py-2.5 px-2 text-right">
                        <button
                          onClick={() => handleDeleteSkill(s)}
                          className="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-black/5 text-text-muted text-[11px] hover:text-red-400 hover:bg-red-500/10 transition-colors"
                          title="删除技能"
                        >
                          <Trash2 className="w-3 h-3" />
                          删除
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Toast {...toast} onClose={() => setToast({ ...toast, visible: false })} />
    </div>
  )
}
