import React, { useEffect, useState } from 'react'
import { Card } from '../../components/ui/card'
import { Toast } from '../../components/ui/toast'
import { getCareerProfile, clearCareerProfile, getCareerUpdatedAt } from '../../shared/db/career-store'
import {
  listCompanyMemories, deleteCompanyMemory, clearCompanyMemories,
  listDecisionLogs, clearDecisionLogs,
  listFollowUps, clearFollowUps,
} from '../../shared/db/butler-store'
import { getAllMatchAnalyses, deleteMatchAnalysis, deleteMatchAnalysesByResume } from '../../shared/db/match-analysis-store'
import { maskDeep } from '../../shared/security/mask'
import { Trash2, Download, Brain, Building2, GitBranch, BellRing, Target } from 'lucide-react'

function formatTime(t?: string | number): string {
  if (!t) return '-'
  const d = typeof t === 'number' ? new Date(t) : new Date(t)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** 下载 JSON/CSV 文件 */
function download(name: string, content: string, mime = 'application/json'): void {
  const blob = new Blob([content], { type: `${mime};charset=utf-8` })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  URL.revokeObjectURL(url)
}

function toCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return ''
  const headers = Object.keys(rows[0])
  const escape = (v: unknown) => {
    const s = String(v ?? '').replace(/"/g, '""')
    return /[",\n]/.test(s) ? `"${s}"` : s
  }
  return [headers.join(','), ...rows.map((r) => headers.map((h) => escape(r[h])).join(','))].join('\n')
}

interface MemoryCounts {
  career: number
  companies: number
  decisions: number
  followUps: number
  analyses: number
}

export default function Memory() {
  const [counts, setCounts] = useState<MemoryCounts>({ career: 0, companies: 0, decisions: 0, followUps: 0, analyses: 0 })
  const [careerUpdatedAt, setCareerUpdatedAt] = useState<string | undefined>(undefined)
  const [companies, setCompanies] = useState<any[]>([])
  const [decisions, setDecisions] = useState<any[]>([])
  const [followUps, setFollowUps] = useState<any[]>([])
  const [analyses, setAnalyses] = useState<any[]>([])
  const [toast, setToast] = useState<{ visible: boolean; message: string; type: 'success' | 'error' | 'warning' | 'info' }>({ visible: false, message: '', type: 'info' })

  useEffect(() => {
    loadAll()
  }, [])

  async function loadAll() {
    const [profile, updatedAt, comps, decs, fups, anas] = await Promise.all([
      getCareerProfile(), getCareerUpdatedAt(),
      listCompanyMemories(), listDecisionLogs(), listFollowUps(), getAllMatchAnalyses(),
    ])
    setCareerUpdatedAt(updatedAt)
    setCompanies(comps)
    setDecisions(decs)
    setFollowUps(fups)
    setAnalyses(anas)
    setCounts({
      career: profile?.skills?.length ? 1 : 0,
      companies: comps.length,
      decisions: decs.length,
      followUps: fups.length,
      analyses: anas.length,
    })
  }

  function showToast(message: string, type: 'success' | 'error' | 'warning' | 'info' = 'success') {
    setToast({ visible: true, message, type })
    setTimeout(() => setToast({ ...toast, visible: false }), 3000)
  }

  async function handleClear(kind: 'companies' | 'decisions' | 'followUps' | 'analyses' | 'career') {
    if (!confirm(`确认清空该记忆库？此操作不可恢复。`)) return
    if (kind === 'companies') await clearCompanyMemories()
    if (kind === 'decisions') await clearDecisionLogs()
    if (kind === 'followUps') await clearFollowUps()
    if (kind === 'analyses') { for (const a of analyses) await deleteMatchAnalysesByResume(a.resumeId) }
    if (kind === 'career') await clearCareerProfile()
    await loadAll()
    showToast('已清空', 'info')
  }

  function exportJson(kind: string, rows: unknown[]) {
    download(`memory-${kind}.json`, JSON.stringify(maskDeep(rows), null, 2))
    showToast('已导出 JSON（已脱敏）')
  }

  function exportCsv(kind: string, rows: Record<string, unknown>[]) {
    download(`memory-${kind}.csv`, toCsv(maskDeep(rows)), 'text/csv')
    showToast('已导出 CSV（已脱敏）')
  }

  const summary: Array<{ label: string; count: number; icon: React.ReactNode; updated: string }> = [
    { label: '职业画像', count: counts.career, icon: <Brain className="w-4 h-4" />, updated: formatTime(careerUpdatedAt) },
    { label: '公司记忆', count: counts.companies, icon: <Building2 className="w-4 h-4" />, updated: formatTime(companies[0]?.updatedAt) },
    { label: '决策留痕', count: counts.decisions, icon: <GitBranch className="w-4 h-4" />, updated: formatTime(decisions[0]?.createdAt) },
    { label: '跟进建议', count: counts.followUps, icon: <BellRing className="w-4 h-4" />, updated: formatTime(followUps[0]?.createdAt) },
    { label: '匹配分析', count: counts.analyses, icon: <Target className="w-4 h-4" />, updated: formatTime(analyses[0]?.createdAt) },
  ]

  return (
    <div className="max-w-5xl space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-text-primary">记忆中心</h2>
        <p className="text-sm text-text-muted mt-1">AI 记住了你什么：职业画像 · 公司记忆 · 决策留痕 · 跟进建议 · 匹配分析</p>
      </div>

      {/* 总览 */}
      <div className="grid grid-cols-5 gap-3">
        {summary.map((s) => (
          <div key={s.label} className="rounded-2xl border border-black/10 bg-surface-darkest p-4">
            <div className="flex items-center gap-2 text-text-muted">
              {s.icon}
              <span className="text-xs">{s.label}</span>
            </div>
            <div className="mt-2 text-2xl font-bold text-text-primary">{s.count}</div>
            <div className="text-[10px] text-text-muted mt-1">最近写入 {s.updated}</div>
          </div>
        ))}
      </div>

      <div className="flex gap-2">
        <button
          onClick={() => {
            download('memory-all.json', JSON.stringify({
              career: { updatedAt: careerUpdatedAt, companies: companies.length, decisions: decisions.length, followUps: followUps.length, analyses: analyses.length },
            }, null, 2))
            showToast('已导出记忆总览 JSON')
          }}
          className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-gradient-to-r from-orange-400 to-orange-500 text-white text-sm font-medium hover:opacity-90 transition-opacity"
        >
          <Download className="w-4 h-4" />
          导出记忆总览
        </button>
      </div>

      {/* 公司记忆 */}
      <Card>
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <Building2 className="w-5 h-5 text-primary-light" />
            <span className="font-semibold text-text-primary">公司记忆（{companies.length}）</span>
          </div>
          <div className="flex gap-2">
            <button onClick={() => exportCsv('companies', companies)} className="px-2.5 py-1 rounded-lg bg-black/5 text-text-muted text-xs hover:text-text-primary transition-colors">导出 CSV</button>
            <button onClick={() => handleClear('companies')} className="px-2.5 py-1 rounded-lg bg-black/5 text-text-muted text-xs hover:text-red-400 transition-colors">清空</button>
          </div>
        </div>
        {companies.length === 0 ? (
          <p className="text-sm text-text-muted text-center py-6">暂无公司记忆</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-xs text-text-muted border-b border-black/10">
                <th className="py-2 px-2 font-medium">公司</th><th className="py-2 px-2 font-medium">岗位</th>
                <th className="py-2 px-2 font-medium text-right">接触</th><th className="py-2 px-2 font-medium text-right">回复</th>
                <th className="py-2 px-2 font-medium">最近结果</th><th className="py-2 px-2 font-medium">更新时间</th>
                <th className="py-2 px-2 font-medium text-right">操作</th>
              </tr></thead>
              <tbody>
                {companies.map((c) => (
                  <tr key={c.id} className="border-b border-black/5 text-text-primary">
                    <td className="py-2 px-2 font-medium">{c.companyName}</td>
                    <td className="py-2 px-2 text-xs text-text-muted">{c.jobTitle || '-'}</td>
                    <td className="py-2 px-2 text-right">{c.touchCount}</td>
                    <td className="py-2 px-2 text-right text-success">{c.replyCount}</td>
                    <td className="py-2 px-2 text-xs">{c.lastOutcome || '-'}</td>
                    <td className="py-2 px-2 text-xs text-text-muted">{formatTime(c.updatedAt)}</td>
                    <td className="py-2 px-2 text-right">
                      <button onClick={async () => { await deleteCompanyMemory(c.id); await loadAll(); showToast('已删除', 'info') }}
                        className="p-1.5 rounded-lg hover:bg-red-500/10 text-text-muted hover:text-red-400 transition-colors" title="删除">
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* 决策留痕 */}
      <Card>
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <GitBranch className="w-5 h-5 text-primary-light" />
            <span className="font-semibold text-text-primary">决策留痕（{decisions.length}）</span>
          </div>
          <div className="flex gap-2">
            <button onClick={() => exportJson('decisions', decisions)} className="px-2.5 py-1 rounded-lg bg-black/5 text-text-muted text-xs hover:text-text-primary transition-colors">导出 JSON</button>
            <button onClick={() => handleClear('decisions')} className="px-2.5 py-1 rounded-lg bg-black/5 text-text-muted text-xs hover:text-red-400 transition-colors">清空</button>
          </div>
        </div>
        {decisions.length === 0 ? (
          <p className="text-sm text-text-muted text-center py-6">暂无决策留痕</p>
        ) : (
          <div className="space-y-2 max-h-[320px] overflow-y-auto">
            {decisions.slice(0, 50).map((d) => (
              <div key={d.id} className="rounded-xl border border-black/10 bg-surface-darkest p-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-text-primary">[{d.source}] {d.subject}</span>
                  <span className="text-[11px] text-text-muted">{formatTime(d.createdAt)}</span>
                </div>
                <p className="text-xs text-text-muted mt-1.5 line-clamp-2">{d.thinking}</p>
                <p className="text-[11px] text-text-muted/70 mt-0.5 line-clamp-1">{d.decision}</p>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* 跟进建议 */}
      <Card>
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <BellRing className="w-5 h-5 text-primary-light" />
            <span className="font-semibold text-text-primary">跟进建议（{followUps.length}）</span>
          </div>
          <div className="flex gap-2">
            <button onClick={() => exportJson('followups', followUps)} className="px-2.5 py-1 rounded-lg bg-black/5 text-text-muted text-xs hover:text-text-primary transition-colors">导出 JSON</button>
            <button onClick={() => handleClear('followUps')} className="px-2.5 py-1 rounded-lg bg-black/5 text-text-muted text-xs hover:text-red-400 transition-colors">清空</button>
          </div>
        </div>
        {followUps.length === 0 ? (
          <p className="text-sm text-text-muted text-center py-6">暂无跟进建议</p>
        ) : (
          <div className="space-y-2 max-h-[320px] overflow-y-auto">
            {followUps.slice(0, 50).map((f) => (
              <div key={f.id} className="rounded-xl border border-black/10 bg-surface-darkest p-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-text-primary">{f.companyName} · {f.jobTitle}</span>
                  <span className={`px-2 py-0.5 rounded-md text-[10px] font-medium ${f.dismissed ? 'bg-warning/10 text-warning' : 'bg-success/10 text-success'}`}>
                    {f.dismissed ? '已处理' : '待跟进'}
                  </span>
                </div>
                <p className="text-xs text-text-muted mt-1.5 line-clamp-2">{f.draftMessage}</p>
                <p className="text-[11px] text-text-muted/70 mt-0.5">投递 {f.daysSince} 天 · {formatTime(f.createdAt)}</p>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* 匹配分析 */}
      <Card>
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <Target className="w-5 h-5 text-primary-light" />
            <span className="font-semibold text-text-primary">匹配分析（{analyses.length}）</span>
          </div>
          <div className="flex gap-2">
            <button onClick={() => exportCsv('analyses', analyses.map((a) => ({ jobTitle: a.jobTitle, score: a.result.overallScore, recommendation: a.result.recommendation, createdAt: a.createdAt })))} className="px-2.5 py-1 rounded-lg bg-black/5 text-text-muted text-xs hover:text-text-primary transition-colors">导出 CSV</button>
            <button onClick={() => handleClear('analyses')} className="px-2.5 py-1 rounded-lg bg-black/5 text-text-muted text-xs hover:text-red-400 transition-colors">清空</button>
          </div>
        </div>
        {analyses.length === 0 ? (
          <p className="text-sm text-text-muted text-center py-6">暂无匹配分析</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-xs text-text-muted border-b border-black/10">
                <th className="py-2 px-2 font-medium">岗位</th><th className="py-2 px-2 font-medium text-right">匹配分</th>
                <th className="py-2 px-2 font-medium">推荐语</th><th className="py-2 px-2 font-medium">时间</th>
                <th className="py-2 px-2 font-medium text-right">操作</th>
              </tr></thead>
              <tbody>
                {analyses.map((a) => (
                  <tr key={a.id} className="border-b border-black/5 text-text-primary">
                    <td className="py-2 px-2 font-medium">{a.jobTitle || '未命名岗位'}</td>
                    <td className="py-2 px-2 text-right">
                      <span className={`font-semibold ${a.result.overallScore >= 70 ? 'text-success' : a.result.overallScore >= 50 ? 'text-primary-light' : 'text-warning'}`}>
                        {a.result.overallScore}
                      </span>
                    </td>
                    <td className="py-2 px-2 text-xs text-text-muted max-w-[280px] truncate">{a.result.recommendation}</td>
                    <td className="py-2 px-2 text-xs text-text-muted">{formatTime(a.createdAt)}</td>
                    <td className="py-2 px-2 text-right">
                      <button onClick={async () => { await deleteMatchAnalysis(a.id); await loadAll(); showToast('已删除', 'info') }}
                        className="p-1.5 rounded-lg hover:bg-red-500/10 text-text-muted hover:text-red-400 transition-colors" title="删除">
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* 职业画像 */}
      <Card>
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <Brain className="w-5 h-5 text-primary-light" />
            <span className="font-semibold text-text-primary">职业画像</span>
          </div>
          <div className="flex gap-2">
            <button onClick={() => handleClear('career')} className="px-2.5 py-1 rounded-lg bg-black/5 text-text-muted text-xs hover:text-red-400 transition-colors">清除画像</button>
          </div>
        </div>
        <p className="text-sm text-text-muted py-3">职业画像由简历画像与投递/差距报告自动沉淀，展示于仪表盘「职业状态」看板；清除后恢复空画像，下次匹配重新沉淀。</p>
      </Card>

      <Toast {...toast} onClose={() => setToast({ ...toast, visible: false })} />
    </div>
  )
}
