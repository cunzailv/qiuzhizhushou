import React, { useState, useEffect } from 'react'
import { Card } from '../../components/ui/card'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { getStats } from '../../shared/db/application-store'
import { getAllApplications } from '../../shared/db/application-store'
import { formatRelativeTime } from '../../shared/utils/date'
import { getSetting, setSetting } from '../../shared/db/settings-store'
import { log } from '../../shared/utils/logger'
import type { Application } from '../../shared/types/application'
import { APPLICATION_STATUS_LABELS } from '../../shared/types/application'
import type { ApplyFilters } from '../../shared/types/filters'
import { DEFAULT_FILTERS } from '../../shared/types/filters'
import FilterPanel from '../components/FilterPanel'
import {
  TrendingUp, Send, Eye, CalendarCheck, Target,
} from 'lucide-react'

const MOD = 'Popup:Dashboard'

interface DashboardProps {
  onStartApply?: (filters: ApplyFilters) => void
}

export default function Dashboard({ onStartApply }: DashboardProps) {
  const [stats, setStats] = useState({ total: 0, today: 0, interview: 0, read: 0, passRate: 0 })
  const [recentApps, setRecentApps] = useState<Application[]>([])
  const [filters, setFilters] = useState<ApplyFilters>(DEFAULT_FILTERS)
  const [filterCollapsed, setFilterCollapsed] = useState(true)

  useEffect(() => {
    loadData()
  }, [])

  async function loadData() {
    const s = await getStats()
    setStats(s)
    const apps = await getAllApplications()
    setRecentApps(apps.slice(0, 5))

    // Load saved filters
    try {
      const savedJobTitles = await getSetting<string>('filterJobTitles', '')
      const savedLocations = await getSetting<string>('filterLocations', '')
      const savedSalaryMin = await getSetting<number | null>('filterSalaryMin', null)
      const savedSalaryMax = await getSetting<number | null>('filterSalaryMax', null)
      const savedExperience = await getSetting<string>('filterExperience', '')
      const savedEducation = await getSetting<string>('filterEducation', '')
      const savedExcludeKeywords = await getSetting<string>('filterExcludeKeywords', '')
      const savedEnableAi = await getSetting<boolean>(
        'enableAiMatch',
        await getSetting<boolean>('filterEnableAiMatch', true),
      )
      const savedMinScore = await getSetting<number>('filterMinMatchScore', 60)
      setFilters({
        jobTitles: savedJobTitles,
        locations: savedLocations,
        salaryMin: savedSalaryMin,
        salaryMax: savedSalaryMax,
        experience: savedExperience,
        education: savedEducation,
        excludeKeywords: savedExcludeKeywords,
        enableAiMatch: savedEnableAi,
        minMatchScore: savedMinScore,
      })
    } catch {
      // Use defaults
    }
  }

  async function handleFilterChange(updates: Partial<ApplyFilters>) {
    const newFilters = { ...filters, ...updates }
    setFilters(newFilters)
    log(MOD, 'filterChange', 'Filters updated:', Object.keys(updates).map(k => `${k}=${(updates as Record<string, unknown>)[k]}`).join(', '))
    // Persist to settings
    try {
      // we can ignore await Promise.all - just fire and forget for perf
      const f = newFilters
      if (updates.jobTitles !== undefined) setSetting('filterJobTitles', f.jobTitles)
      if (updates.locations !== undefined) setSetting('filterLocations', f.locations)
      if (updates.salaryMin !== undefined) setSetting('filterSalaryMin', f.salaryMin)
      if (updates.salaryMax !== undefined) setSetting('filterSalaryMax', f.salaryMax)
      if (updates.experience !== undefined) setSetting('filterExperience', f.experience)
      if (updates.education !== undefined) setSetting('filterEducation', f.education)
      if (updates.excludeKeywords !== undefined) setSetting('filterExcludeKeywords', f.excludeKeywords)
      if (updates.enableAiMatch !== undefined) setSetting('filterEnableAiMatch', f.enableAiMatch)
      if (updates.minMatchScore !== undefined) setSetting('filterMinMatchScore', f.minMatchScore)
    } catch { /* ignore */ }
  }

  function handleStart() {
    log(MOD, 'handleStart', 'User clicked 开始智能投递', {
      jobTitles: filters.jobTitles,
      locations: filters.locations,
      salaryRange: `${filters.salaryMin ?? '?'}-${filters.salaryMax ?? '?'}K`,
      experience: filters.experience,
      education: filters.education,
      excludeKeywords: filters.excludeKeywords,
    })
    onStartApply?.(filters)
  }

  const statCards = [
    { label: '今日投递', value: stats.today, icon: Send, color: '#6366F1' },
    { label: '总投递数', value: stats.total, icon: TrendingUp, color: '#8B5CF6' },
    { label: 'HR已读', value: stats.read, icon: Eye, color: '#3B82F6' },
    { label: '面试邀约', value: stats.interview, icon: CalendarCheck, color: '#10B981' },
    { label: '转化率', value: `${stats.passRate}%`, icon: Target, color: '#F59E0B' },
  ]

  function getStatusBadge(status: Application['status']) {
    const variants: Record<string, 'default' | 'success' | 'danger' | 'warning' | 'info'> = {
      applied: 'default',
      read: 'info',
      communicating: 'warning',
      interview: 'success',
      rejected: 'danger',
      hired: 'success',
    }
    return <Badge variant={variants[status]}>{APPLICATION_STATUS_LABELS[status]}</Badge>
  }

  return (
    <div className="p-4 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-bold gradient-text">求职助手</h1>
          <p className="text-xs text-text-muted mt-0.5">Boss直聘 · 智能投递</p>
        </div>
        <Button size="sm" onClick={handleStart}>
          <Send className="w-3.5 h-3.5" />
          开始投递
        </Button>
      </div>

      {/* Filters */}
      <FilterPanel
        filters={filters}
        onChange={handleFilterChange}
        onStartApply={handleStart}
        collapsed={filterCollapsed}
        onToggleCollapse={() => setFilterCollapsed(!filterCollapsed)}
      />

      {/* Stats Grid */}
      <div className="grid grid-cols-3 gap-2">
        {statCards.map((stat) => (
          <Card key={stat.label} className="flex flex-col items-center justify-center py-3 px-2 text-center">
            <stat.icon className="w-4 h-4 mb-1" style={{ color: stat.color }} />
            <p className="text-lg font-bold text-text-primary">{stat.value}</p>
            <p className="text-[10px] text-text-muted">{stat.label}</p>
          </Card>
        ))}
      </div>

      {/* Recent Applications */}
      <div>
        <h3 className="text-sm font-semibold text-text-secondary mb-3">最近投递</h3>
        <div className="space-y-2">
          {recentApps.length === 0 ? (
            <p className="text-xs text-text-muted text-center py-6">暂无投递记录，快去投递吧！</p>
          ) : (
            recentApps.map((app) => (
              <Card key={app.id} className="flex items-center gap-3 py-2.5 px-3">
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium text-text-primary truncate">{app.jobTitle}</p>
                  <p className="text-[10px] text-text-muted truncate">{app.companyName} · {app.salary}</p>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[10px] text-text-muted">{formatRelativeTime(app.appliedAt)}</span>
                  {getStatusBadge(app.status)}
                </div>
              </Card>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
