import React, { useEffect, useMemo, useState } from 'react'
import { Card } from '../../components/ui/card'
import { Toast } from '../../components/ui/toast'
import { getAllApplications, getStats } from '../../shared/db/application-store'
import { Download, Send, CircleDot } from 'lucide-react'

const STATUS_LABELS: Record<string, string> = {
  applied: '已投递', read: '已读', communicating: '沟通中', interview: '面试',
  hired: 'Offer/入职', rejected: '未通过', withdrawn: '已撤回',
}

function formatTime(t: string): string {
  if (!t) return '-'
  const d = new Date(t)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
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

export default function Applications() {
  const [rows, setRows] = useState<any[]>([])
  const [stats, setStats] = useState<any>(null)
  const [filter, setFilter] = useState('all')
  const [toast, setToast] = useState<{ visible: boolean; message: string; type: 'success' | 'error' | 'warning' | 'info' }>({ visible: false, message: '', type: 'info' })

  useEffect(() => {
    loadAll()
  }, [])

  async function loadAll() {
    const [apps, s] = await Promise.all([getAllApplications(), getStats()])
    setRows(apps)
    setStats(s)
  }

  function showToast(message: string, type: 'success' | 'error' | 'warning' | 'info' = 'success') {
    setToast({ visible: true, message, type })
    setTimeout(() => setToast({ ...toast, visible: false }), 3000)
  }

  const filtered = useMemo(() => {
    if (filter === 'all') return rows
    return rows.filter((r) => r.status === filter)
  }, [rows, filter])

  function exportCsv() {
    const csv = toCsv(filtered.map((r) => ({
      company: r.companyName, jobTitle: r.jobTitle, salary: r.salary, location: r.location,
      platform: r.platform || '-', status: STATUS_LABELS[r.status] || r.status,
      matchScore: r.matchScore ?? '', appliedAt: formatTime(r.appliedAt), notes: r.notes,
    })))
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `applications-${filter}.csv`
    a.click()
    URL.revokeObjectURL(url)
    showToast('已导出 CSV')
  }

  return (
    <div className="max-w-5xl space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-text-primary">投递记录</h2>
        <p className="text-sm text-text-muted mt-1">全部投递的完整台账：状态流转与匹配分</p>
      </div>

      {stats && (
        <div className="grid grid-cols-4 gap-3">
          {[
            { label: '累计投递', value: stats.total },
            { label: '今日投递', value: stats.today },
            { label: '面试/Offer', value: stats.interview },
            { label: '已读', value: stats.read },
          ].map((s) => (
            <div key={s.label} className="rounded-2xl border border-black/10 bg-surface-darkest p-4">
              <div className="text-xs text-text-muted">{s.label}</div>
              <div className="mt-1.5 text-2xl font-bold text-text-primary">{s.value}</div>
            </div>
          ))}
        </div>
      )}

      <Card>
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2 flex-wrap">
            <button
              onClick={() => setFilter('all')}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${filter === 'all' ? 'bg-primary/20 text-primary-light ring-1 ring-primary/30' : 'bg-black/5 text-text-muted hover:text-text-primary'}`}
            >
              全部（{rows.length}）
            </button>
            {Object.entries(STATUS_LABELS).map(([k, label]) => (
              <button
                key={k}
                onClick={() => setFilter(k)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${filter === k ? 'bg-primary/20 text-primary-light ring-1 ring-primary/30' : 'bg-black/5 text-text-muted hover:text-text-primary'}`}
              >
                {label}
              </button>
            ))}
          </div>
          <button
            onClick={exportCsv}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-gradient-to-r from-orange-400 to-orange-500 text-white text-sm font-medium hover:opacity-90 transition-opacity"
          >
            <Download className="w-4 h-4" />
            导出 CSV
          </button>
        </div>

        {filtered.length === 0 ? (
          <div className="p-10 text-center">
            <Send className="w-8 h-8 mx-auto mb-2 text-text-muted/50" />
            <p className="text-sm text-text-muted">暂无投递记录</p>
            <p className="text-xs text-text-muted/60 mt-1">在招聘平台使用扩展投递后，记录会自动沉淀到这里</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-xs text-text-muted border-b border-black/10">
                <th className="py-2 px-2 font-medium">公司 / 岗位</th>
                <th className="py-2 px-2 font-medium">平台</th>
                <th className="py-2 px-2 font-medium">薪资</th>
                <th className="py-2 px-2 font-medium text-right">匹配分</th>
                <th className="py-2 px-2 font-medium">状态</th>
                <th className="py-2 px-2 font-medium">投递时间</th>
                <th className="py-2 px-2 font-medium">备注</th>
              </tr></thead>
              <tbody>
                {filtered.map((r) => (
                  <tr key={r.id} className="border-b border-black/5 text-text-primary">
                    <td className="py-2.5 px-2">
                      <div className="font-medium">{r.companyName}</div>
                      <div className="text-xs text-text-muted">{r.jobTitle}</div>
                    </td>
                    <td className="py-2.5 px-2 text-xs">{r.platform || '-'}</td>
                    <td className="py-2.5 px-2 text-xs">{r.salary || '-'}</td>
                    <td className="py-2.5 px-2 text-right">
                      {r.matchScore != null ? (
                        <span className={`font-semibold ${r.matchScore >= 70 ? 'text-success' : r.matchScore >= 50 ? 'text-primary-light' : 'text-warning'}`}>
                          {r.matchScore}
                        </span>
                      ) : '-'}
                    </td>
                    <td className="py-2.5 px-2">
                      <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-medium ${
                        ['interview', 'hired'].includes(r.status) ? 'bg-success/10 text-success'
                        : ['rejected', 'withdrawn'].includes(r.status) ? 'bg-warning/10 text-warning'
                        : 'bg-primary/10 text-primary-light'
                      }`}>
                        <CircleDot className="w-2.5 h-2.5" />
                        {STATUS_LABELS[r.status] || r.status}
                      </span>
                    </td>
                    <td className="py-2.5 px-2 text-xs text-text-muted">{formatTime(r.appliedAt)}</td>
                    <td className="py-2.5 px-2 text-xs text-text-muted max-w-[160px] truncate" title={r.notes}>{r.notes || '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Toast {...toast} onClose={() => setToast({ ...toast, visible: false })} />
    </div>
  )
}
