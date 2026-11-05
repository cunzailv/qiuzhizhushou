import React, { useState, useEffect } from 'react'
import { Card } from '../../components/ui/card'
import { getStats } from '../../shared/db/application-store'
import { loadSharedApplyFilters, persistSharedFilters } from '../../shared/agent/filter-config'
import { log } from '../../shared/utils/logger'
import type { ApplyFilters } from '../../shared/types/filters'
import { DEFAULT_FILTERS } from '../../shared/types/filters'
import FilterPanel from '../components/FilterPanel'
import BatchControlCard from '../components/BatchControlCard'
import { subscribeAssistantState } from '../../shared/assistant-state'
import type { AssistantRuntimeState } from '../../shared/runtime-state'
import {
  TrendingUp, Send, Eye, CalendarCheck, Target,
} from 'lucide-react'

const MOD = 'Popup:Dashboard'

interface DashboardProps {
  onStartApply?: (filters: ApplyFilters) => void
  onStopApply?: () => void
  applyRunning?: boolean
  runtime: AssistantRuntimeState
}

export default function Dashboard({
  onStartApply,
  onStopApply,
  applyRunning,
  runtime,
}: DashboardProps) {
  const [stats, setStats] = useState({ total: 0, today: 0, interview: 0, read: 0, passRate: 0 })
  const [filters, setFilters] = useState<ApplyFilters>(DEFAULT_FILTERS)
  const [filterCollapsed, setFilterCollapsed] = useState(true)

  useEffect(() => {
    loadData()
  }, [])

  // AIbot 页 / 设置页 / 网页浮窗改了 AI 评分开关时，概览筛选条件实时同步
  useEffect(() => {
    return subscribeAssistantState((state) => {
      setFilters((prev) => prev.enableAiMatch === state.enableAiMatch
        ? prev
        : { ...prev, enableAiMatch: state.enableAiMatch })
    })
  }, [])

  async function loadData() {
    const s = await getStats()
    setStats(s)

    // 与 AIbot 全自动流水线共用同一份筛选配置（shared/agent/filter-config）
    try {
      setFilters(await loadSharedApplyFilters())
    } catch {
      // 保留 DEFAULT_FILTERS
    }
  }

  async function handleFilterChange(updates: Partial<ApplyFilters>) {
    const newFilters = { ...filters, ...updates }
    setFilters(newFilters)
    log(MOD, 'filterChange', 'Filters updated:', Object.keys(updates).map(k => `${k}=${(updates as Record<string, unknown>)[k]}`).join(', '))
    // 持久化到共享配置：AI 评分开关双写 enableAiMatch / filterEnableAiMatch，
    // 让 content 与 AIbot 全自动流水线立即读到同一份值。
    void persistSharedFilters(updates).catch(() => {})
  }

  // 两处「开始」入口（筛选卡片 / 批量沟通控制台）统一锁定：避免重复申请锁把运行进度清零
  const startLocked = !!applyRunning || runtime.mode === 'manual' || runtime.mode === 'autopilot'

  function handleStart() {
    if (startLocked) {
      log(MOD, 'handleStart', 'Ignored — another run is active')
      return
    }
    log(MOD, 'handleStart', 'User clicked 开始智能沟通', {
      jobTitles: filters.jobTitles,
      locations: filters.locations,
      salaryRange: `${filters.salaryMin ?? '?'}-${filters.salaryMax ?? '?'}K`,
      experience: filters.experience,
      education: filters.education,
      excludeKeywords: filters.excludeKeywords,
      enableAiMatch: filters.enableAiMatch,
      minMatchScore: filters.minMatchScore,
    })
    onStartApply?.(filters)
  }

  const statCards = [
    { label: '今日投递', value: stats.today, icon: Send, color: '#F97316' },
    { label: '总投递数', value: stats.total, icon: TrendingUp, color: '#FB923C' },
    { label: 'HR已读', value: stats.read, icon: Eye, color: '#3B82F6' },
    { label: '面试邀约', value: stats.interview, icon: CalendarCheck, color: '#10B981' },
    { label: '转化率', value: `${stats.passRate}%`, icon: Target, color: '#F59E0B' },
  ]

  return (
    <div className="p-4 space-y-4">
      {/* 品牌头与「开始沟通」已移除：App 全局头部已有标题与平台徽章，
          启动入口统一收敛到「沟通筛选条件」与「批量沟通控制台」两处 */}

      {/* Filters */}
      <FilterPanel
        filters={filters}
        onChange={handleFilterChange}
        onStartApply={handleStart}
        collapsed={filterCollapsed}
        onToggleCollapse={() => setFilterCollapsed(!filterCollapsed)}
        startDisabled={startLocked}
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

      {/* 批量沟通控制台（替换原「最近投递」，与「追踪」页不再重复） */}
      <BatchControlCard
        runtime={runtime}
        filters={filters}
        applyRunning={!!applyRunning}
        onStartApply={handleStart}
        onStopApply={() => onStopApply?.()}
        onFilterChange={handleFilterChange}
      />
    </div>
  )
}
