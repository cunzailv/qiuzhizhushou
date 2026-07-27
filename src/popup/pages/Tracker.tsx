import React, { useState, useEffect } from 'react'
import { Card } from '../../components/ui/card'
import { Badge } from '../../components/ui/badge'
import { getAllApplications, updateApplicationStatus } from '../../shared/db/application-store'
import type { Application, ApplicationStatus } from '../../shared/types/application'
import { APPLICATION_STATUS_LABELS } from '../../shared/types/application'
import { formatRelativeTime } from '../../shared/utils/date'
import { Search, Building2, Clock } from 'lucide-react'

const STATUS_FILTERS: Array<{ label: string; value: ApplicationStatus | 'all' }> = [
  { label: '全部', value: 'all' },
  { label: '已投递', value: 'applied' },
  { label: '已读', value: 'read' },
  { label: '沟通中', value: 'communicating' },
  { label: '面试', value: 'interview' },
  { label: '不合适', value: 'rejected' },
]

export default function Tracker() {
  const [applications, setApplications] = useState<Application[]>([])
  const [filterStatus, setFilterStatus] = useState<ApplicationStatus | 'all'>('all')
  const [search, setSearch] = useState('')
  const [expandedId, setExpandedId] = useState<string | null>(null)

  useEffect(() => {
    loadApplications()
  }, [])

  async function loadApplications() {
    const apps = await getAllApplications()
    setApplications(apps)
  }

  async function handleStatusChange(id: string, status: ApplicationStatus) {
    await updateApplicationStatus(id, status)
    await loadApplications()
  }

  const filtered = applications.filter((app) => {
    if (filterStatus !== 'all' && app.status !== filterStatus) return false
    if (search) {
      const q = search.toLowerCase()
      return (
        app.jobTitle.toLowerCase().includes(q) ||
        app.companyName.toLowerCase().includes(q)
      )
    }
    return true
  })

  function getStatusVariant(status: ApplicationStatus): 'default' | 'success' | 'danger' | 'warning' | 'info' {
    const map: Record<string, 'default' | 'success' | 'danger' | 'warning' | 'info'> = {
      applied: 'default',
      read: 'info',
      communicating: 'warning',
      interview: 'success',
      rejected: 'danger',
      hired: 'success',
    }
    return map[status]
  }

  return (
    <div className="p-4 space-y-3">
      <h2 className="text-lg font-bold gradient-text">投递追踪</h2>

      {/* Search */}
      <div className="relative">
        <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
        <input
          type="text"
          placeholder="搜索公司或岗位..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="input-field pl-9"
        />
      </div>

      {/* Status Filter */}
      <div className="flex gap-1 flex-wrap">
        {STATUS_FILTERS.map((f) => (
          <button
            key={f.value}
            onClick={() => setFilterStatus(f.value)}
            className={`px-2.5 py-1 text-[11px] rounded-lg transition-colors ${
              filterStatus === f.value
                ? 'bg-primary/20 text-primary-light font-medium'
                : 'text-text-muted hover:text-text-secondary'
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* Applications List */}
      <div className="space-y-2 max-h-[400px] overflow-y-auto">
        {filtered.length === 0 ? (
          <p className="text-xs text-text-muted text-center py-8">暂无匹配的投递记录</p>
        ) : (
          filtered.map((app) => (
            <Card
              key={app.id}
              className="p-3 cursor-pointer"
              onClick={() => setExpandedId(expandedId === app.id ? null : app.id)}
            >
              <div className="flex items-start gap-3">
                <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                  <Building2 className="w-4 h-4 text-primary-light" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-medium text-text-primary truncate">{app.jobTitle}</p>
                    <Badge variant={getStatusVariant(app.status)}>
                      {APPLICATION_STATUS_LABELS[app.status]}
                    </Badge>
                  </div>
                  <p className="text-xs text-text-muted mt-0.5">{app.companyName}</p>
                  <div className="flex items-center gap-2 mt-1">
                    <span className="text-[11px] text-text-muted">{app.salary}</span>
                    <span className="text-[11px] text-text-muted">·</span>
                    <span className="text-[11px] text-text-muted flex items-center gap-1">
                      <Clock className="w-2.5 h-2.5" />
                      {formatRelativeTime(app.appliedAt)}
                    </span>
                  </div>
                </div>
              </div>

              {/* Expanded Details */}
              {expandedId === app.id && (
                <div className="mt-3 pt-3 border-t border-white/5 space-y-2">
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] text-text-muted">匹配分数：</span>
                    <span className="text-sm font-bold text-primary-light">
                      {app.matchScore === null ? '未评分' : `${app.matchScore}分`}
                    </span>
                  </div>
                  {app.matchReason && (
                    <p className="text-xs text-text-secondary">{app.matchReason}</p>
                  )}
                  {/* Status Change Buttons */}
                  <div className="flex gap-1 flex-wrap pt-1">
                    {(['read', 'communicating', 'interview', 'rejected', 'hired'] as ApplicationStatus[]).map((s) => (
                      <button
                        key={s}
                        onClick={(e) => {
                          e.stopPropagation()
                          handleStatusChange(app.id, s)
                        }}
                        className={`px-2 py-1 text-[10px] rounded-lg transition-colors ${
                          app.status === s
                            ? 'bg-primary/20 text-primary-light'
                            : 'bg-white/5 text-text-muted hover:text-text-secondary'
                        }`}
                      >
                        {APPLICATION_STATUS_LABELS[s]}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </Card>
          ))
        )}
      </div>
    </div>
  )
}
