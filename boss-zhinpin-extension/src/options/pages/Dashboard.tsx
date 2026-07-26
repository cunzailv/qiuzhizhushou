import React, { useState, useEffect } from 'react'
import { Card } from '../../components/ui/card'
import { Badge } from '../../components/ui/badge'
import { getStats, getAllApplications } from '../../shared/db/application-store'
import { getAllResumes } from '../../shared/db/resume-store'
import { getBlacklist } from '../../shared/db/blacklist-store'
import type { Application } from '../../shared/types/application'
import { APPLICATION_STATUS_LABELS } from '../../shared/types/application'
import { formatRelativeTime } from '../../shared/utils/date'
import {
  TrendingUp, Send, Eye, CalendarCheck, Target, FileText, Ban,
} from 'lucide-react'

export default function Dashboard() {
  const [stats, setStats] = useState({ total: 0, today: 0, interview: 0, read: 0, passRate: 0 })
  const [resumeCount, setResumeCount] = useState(0)
  const [blacklistCount, setBlacklistCount] = useState(0)
  const [recentApps, setRecentApps] = useState<Application[]>([])

  useEffect(() => {
    loadData()
  }, [])

  async function loadData() {
    const s = await getStats()
    setStats(s)
    const apps = await getAllApplications()
    setRecentApps(apps.slice(0, 10))
    const resumes = await getAllResumes()
    setResumeCount(resumes.length)
    const bl = await getBlacklist()
    setBlacklistCount(bl.length)
  }

  const statCards = [
    { label: '今日投递', value: stats.today, icon: Send, color: '#6366F1' },
    { label: '总投递数', value: stats.total, icon: TrendingUp, color: '#8B5CF6' },
    { label: 'HR已读', value: stats.read, icon: Eye, color: '#3B82F6' },
    { label: '面试邀约', value: stats.interview, icon: CalendarCheck, color: '#10B981' },
    { label: '转化率', value: `${stats.passRate}%`, icon: Target, color: '#F59E0B' },
    { label: '简历数', value: resumeCount, icon: FileText, color: '#EC4899' },
    { label: '黑名单', value: blacklistCount, icon: Ban, color: '#EF4444' },
  ]

  function getStatusVariant(status: Application['status']): 'default' | 'success' | 'danger' | 'warning' | 'info' {
    const map: Record<string, 'default' | 'success' | 'danger' | 'warning' | 'info'> = {
      applied: 'default', read: 'info', communicating: 'warning',
      interview: 'success', rejected: 'danger', hired: 'success',
    }
    return map[status]
  }

  // Status distribution
  const statusDist: Record<string, number> = {}
  const all = recentApps.length > 0 ? recentApps : []
  for (const app of all) {
    statusDist[app.status] = (statusDist[app.status] || 0) + 1
  }

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold gradient-text">求职数据看板</h1>
        <p className="text-sm text-text-muted mt-1">全面了解你的求职进度</p>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-4 gap-4">
        {statCards.map((stat) => (
          <Card key={stat.label} className="flex items-center gap-4 p-5">
            <div className="w-12 h-12 rounded-xl flex items-center justify-center" style={{ background: `${stat.color}15` }}>
              <stat.icon className="w-6 h-6" style={{ color: stat.color }} />
            </div>
            <div>
              <p className="text-2xl font-bold text-text-primary">{stat.value}</p>
              <p className="text-xs text-text-muted">{stat.label}</p>
            </div>
          </Card>
        ))}
      </div>

      {/* Status Distribution & Recent */}
      <div className="grid grid-cols-2 gap-4">
        {/* Status Distribution */}
        <Card className="p-5">
          <h3 className="text-sm font-semibold text-text-primary mb-4">状态分布</h3>
          <div className="space-y-3">
            {(Object.entries(APPLICATION_STATUS_LABELS) as [Application['status'], string][]).map(([status, label]) => (
              <div key={status} className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Badge variant={getStatusVariant(status)}>{label}</Badge>
                </div>
                <span className="text-sm font-semibold text-text-primary">{statusDist[status] || 0}</span>
              </div>
            ))}
          </div>
        </Card>

        {/* Recent Activity */}
        <Card className="p-5">
          <h3 className="text-sm font-semibold text-text-primary mb-4">最近动态</h3>
          <div className="space-y-3">
            {recentApps.slice(0, 8).map((app) => (
              <div key={app.id} className="flex items-center justify-between">
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-text-primary truncate">{app.jobTitle}</p>
                  <p className="text-xs text-text-muted">{app.companyName}</p>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[10px] text-text-muted">{formatRelativeTime(app.appliedAt)}</span>
                  <Badge variant={getStatusVariant(app.status)}>
                    {APPLICATION_STATUS_LABELS[app.status]}
                  </Badge>
                </div>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </div>
  )
}
