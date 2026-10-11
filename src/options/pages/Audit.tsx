// E6 观测审计视图：全链路动作审计（列表/筛选/统计/CSV 导出 + 投递状态机图）
import React, { useState, useEffect } from 'react'
import { Card } from '../../components/ui/card'
import { Button } from '../../components/ui/button'
import { getAuditLogs, countAuditByResult, auditToCsv, type AuditRecord, type AuditResult } from '../../shared/db/audit-store'
import { FileDown, Filter, CheckCircle2, XCircle, Clock3, Ban, SkipForward, RefreshCw } from 'lucide-react'

const RESULT_META: Record<AuditResult, { label: string; color: string; bg: string; icon: React.ReactNode }> = {
  success: { label: '成功', color: '#16A34A', bg: 'rgba(22,163,74,0.12)', icon: <CheckCircle2 className="w-4 h-4" /> },
  failed: { label: '失败', color: '#DC2626', bg: 'rgba(220,38,38,0.12)', icon: <XCircle className="w-4 h-4" /> },
  confirm_wait: { label: '待确认', color: '#D97706', bg: 'rgba(217,119,6,0.12)', icon: <Clock3 className="w-4 h-4" /> },
  denied: { label: '拒绝', color: '#7C3AED', bg: 'rgba(124,58,237,0.12)', icon: <Ban className="w-4 h-4" /> },
  skipped: { label: '跳过', color: '#6B7280', bg: 'rgba(107,114,128,0.12)', icon: <SkipForward className="w-4 h-4" /> },
}

function fmtTime(iso: string): string {
  const d = new Date(iso)
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
}

const PLATFORM_NAMES: Record<string, string> = { boss: 'Boss直聘', liepin: '猎聘', '51job': '前程无忧', zhaopin: '智联招聘', maimai: '脉脉' }

export default function Audit() {
  const [rows, setRows] = useState<AuditRecord[]>([])
  const [counts, setCounts] = useState<Record<AuditResult, number>>({ success: 0, failed: 0, confirm_wait: 0, denied: 0, skipped: 0 })
  const [resultFilter, setResultFilter] = useState<AuditResult | 'all'>('all')
  const [platformFilter, setPlatformFilter] = useState('all')

  async function load() {
    const [logs, cnt] = await Promise.all([getAuditLogs({ limit: 300 }), countAuditByResult()])
    setRows(logs)
    setCounts(cnt)
  }

  useEffect(() => { load() }, [])

  const filtered = rows.filter((r) =>
    (resultFilter === 'all' || r.result === resultFilter) &&
    (platformFilter === 'all' || r.platform === platformFilter),
  )
  const total = Object.values(counts).reduce((a, b) => a + b, 0)

  function exportCsv() {
    const csv = auditToCsv(filtered)
    const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `审计日志-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="space-y-4">
      {/* 统计 */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        {(Object.keys(RESULT_META) as AuditResult[]).map((key) => (
          <Card key={key} className="!p-4">
            <div className="flex items-center gap-2 mb-1">
              <span style={{ color: RESULT_META[key].color }}>{RESULT_META[key].icon}</span>
              <span className="text-xs text-text-muted">{RESULT_META[key].label}</span>
            </div>
            <div className="text-2xl font-bold" style={{ color: RESULT_META[key].color }}>{counts[key]}</div>
          </Card>
        ))}
      </div>

      {/* 工具条 */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-1.5">
          <Filter className="w-4 h-4 text-text-muted" />
          <select
            value={resultFilter}
            onChange={(e) => setResultFilter(e.target.value as AuditResult | 'all')}
            className="px-3 py-2 rounded-xl bg-surface-darkest border border-black/10 text-sm text-text-primary"
          >
            <option value="all">全部结果</option>
            {(Object.keys(RESULT_META) as AuditResult[]).map((k) => (
              <option key={k} value={k}>{RESULT_META[k].label}</option>
            ))}
          </select>
          <select
            value={platformFilter}
            onChange={(e) => setPlatformFilter(e.target.value)}
            className="px-3 py-2 rounded-xl bg-surface-darkest border border-black/10 text-sm text-text-primary"
          >
            <option value="all">全部平台</option>
            {Object.entries(PLATFORM_NAMES).map(([k, v]) => (
              <option key={k} value={k}>{v}</option>
            ))}
          </select>
        </div>
        <div className="flex-1" />
        <Button variant="secondary" onClick={load}><RefreshCw className="w-4 h-4" />刷新</Button>
        <Button onClick={exportCsv}><FileDown className="w-4 h-4" />导出 CSV（{filtered.length} 条）</Button>
      </div>

      <p className="text-xs text-text-muted">共 {total} 条审计记录（显示最近 {rows.length} 条）。验证列表示该动作是否通过页面状态断言（运行时闭环）。</p>

      {/* 审计表格 */}
      <Card className="!p-0 overflow-hidden">
        <div className="overflow-x-auto max-h-[420px] overflow-y-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-surface-medium text-text-muted text-xs">
              <tr>
                {['时间', '来源', '平台', '目标', '动作', '权限', '结果', '耗时', '验证', '状态迁移', '错误'].map((h) => (
                  <th key={h} className="px-3 py-2.5 text-left font-medium whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 && (
                <tr><td colSpan={11} className="px-4 py-10 text-center text-text-muted text-sm">暂无审计记录，开始使用智能沟通后会自动记录。</td></tr>
              )}
              {filtered.map((r) => (
                <tr key={r.id} className="border-t border-black/5 hover:bg-black/[0.02]">
                  <td className="px-3 py-2 text-text-muted whitespace-nowrap text-xs">{fmtTime(r.createdAt)}</td>
                  <td className="px-3 py-2 whitespace-nowrap">{r.source}</td>
                  <td className="px-3 py-2 whitespace-nowrap">{PLATFORM_NAMES[r.platform || ''] || r.platform || '-'}</td>
                  <td className="px-3 py-2 max-w-[160px] truncate" title={r.goal}>{r.goal || '-'}</td>
                  <td className="px-3 py-2 whitespace-nowrap font-mono text-xs">{r.tool || '-'}</td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    {r.permissionLevel ? (
                      <span className={`px-2 py-0.5 rounded-md text-xs font-medium ${
                        r.permissionLevel === 'auto' ? 'bg-success/10 text-success'
                        : r.permissionLevel === 'confirm' ? 'bg-warning/10 text-warning'
                        : 'bg-danger/10 text-danger'
                      }`}>{r.permissionLevel}</span>
                    ) : '-'}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-medium"
                      style={{ color: RESULT_META[r.result]?.color, background: RESULT_META[r.result]?.bg }}>
                      {RESULT_META[r.result]?.icon}{RESULT_META[r.result]?.label || r.result}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right whitespace-nowrap text-xs text-text-muted">{r.durationMs ?? '-'}{r.durationMs ? 'ms' : ''}</td>
                  <td className="px-3 py-2 text-center">
                    {r.verified === undefined ? <span className="text-text-muted text-xs">-</span>
                      : r.verified ? <span className="text-success text-sm font-bold">✓</span>
                      : <span className="text-danger text-sm font-bold">✗</span>}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap font-mono text-xs text-primary-light">{r.stateFrom ? `${r.stateFrom}→${r.stateTo}` : '-'}</td>
                  <td className="px-3 py-2 max-w-[180px] truncate text-text-muted text-xs" title={r.error}>{r.error || ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {/* 投递状态机（E5 编排可视化） */}
      <Card>
        <div className="flex items-center gap-2 mb-4">
          <span className="font-semibold text-text-primary">投递状态机</span>
          <span className="text-xs text-text-muted">E5 编排层 · 每次投递的迁移都会在审计中留下 stateFrom→stateTo</span>
        </div>
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          {['matched', 'opening_detail', 'detail_open', 'clicking_chat', 'chat_started', 'sending_greeting', 'applied'].map((s, i, arr) => (
            <React.Fragment key={s}>
              <span className={`px-2.5 py-1 rounded-lg font-medium ${s === 'applied' ? 'bg-success/15 text-success' : 'bg-surface-darkest text-text-secondary'}`}>{s}</span>
              {i < arr.length - 1 && <span className="text-text-muted">→</span>}
            </React.Fragment>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-1.5 mt-2 text-xs">
          {['denied', 'skipped', 'failed', 'blocked'].map((s) => (
            <React.Fragment key={s}>
              <span className="px-2.5 py-1 rounded-lg bg-danger/10 text-danger font-medium">{s}</span>
              <span className="text-text-muted">（终态）</span>
            </React.Fragment>
          ))}
        </div>
        <p className="text-xs text-text-muted mt-3 leading-relaxed">
          降级策略：打开详情失败但列表页仍有直投路径 → 直接发起沟通；沟通失败但可直接发问候 → 降级发送；用户拒绝/超时未确认 → denied/skipped；风控触发 → blocked。
        </p>
      </Card>
    </div>
  )
}
