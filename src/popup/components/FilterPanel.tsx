import React from 'react'
import {
  Search, MapPin, DollarSign, GraduationCap, Filter,
  Shield, Sparkles, ChevronDown, ChevronUp,
} from 'lucide-react'
import type { ApplyFilters } from '../../shared/types/filters'

interface FilterPanelProps {
  filters: ApplyFilters
  onChange: (updates: Partial<ApplyFilters>) => void
  onStartApply: () => void
  collapsed: boolean
  onToggleCollapse: () => void
}

export default function FilterPanel({ filters, onChange, collapsed, onToggleCollapse, onStartApply }: FilterPanelProps) {
  const activeCount = [
    filters.jobTitles, filters.locations,
    filters.salaryMin || filters.salaryMax,
    filters.experience, filters.education, filters.excludeKeywords,
  ].filter(Boolean).length

  return (
    <div className="space-y-3">
      {/* Collapse toggle */}
      <button
        onClick={onToggleCollapse}
        className="w-full flex items-center justify-between py-2 px-3 rounded-xl bg-white/[0.03] border border-white/5 hover:border-white/10 transition-colors"
      >
        <div className="flex items-center gap-2">
          <Filter className="w-3.5 h-3.5 text-primary-light" />
          <span className="text-xs font-medium text-text-primary">投递筛选条件</span>
          {activeCount > 0 && (
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-primary/15 text-primary-light">
              {activeCount}
            </span>
          )}
        </div>
        {collapsed ? <ChevronDown className="w-3.5 h-3.5 text-text-muted" /> : <ChevronUp className="w-3.5 h-3.5 text-text-muted" />}
      </button>

      {!collapsed && (
        <div className="space-y-2.5 p-3 bg-white/[0.02] rounded-xl border border-white/5">
          {/* Job Title */}
          <FilterField
            icon={<Search className="w-3 h-3 text-primary-light" />}
            label="岗位名称"
            placeholder="例：前端开发 后端 Java（空格分隔）"
            value={filters.jobTitles}
            onChange={(v) => onChange({ jobTitles: v })}
          />

          {/* Location */}
          <FilterField
            icon={<MapPin className="w-3 h-3 text-primary-light" />}
            label="工作地点"
            placeholder="例：北京 上海 深圳（空格分隔）"
            value={filters.locations}
            onChange={(v) => onChange({ locations: v })}
          />

          {/* Salary Range */}
          <div>
            <div className="flex items-center gap-1.5 mb-1">
              <DollarSign className="w-3 h-3 text-primary-light" />
              <span className="text-[11px] text-text-muted">薪资范围（K/月）</span>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="number"
                placeholder="最低"
                value={filters.salaryMin ?? ''}
                onChange={(e) => onChange({ salaryMin: e.target.value ? Number(e.target.value) : null })}
                className="w-[80px] input-field text-xs py-1.5 text-center"
                min={0}
                max={99}
              />
              <span className="text-text-muted text-xs">—</span>
              <input
                type="number"
                placeholder="最高"
                value={filters.salaryMax ?? ''}
                onChange={(e) => onChange({ salaryMax: e.target.value ? Number(e.target.value) : null })}
                className="w-[80px] input-field text-xs py-1.5 text-center"
                min={0}
                max={99}
              />
              <span className="text-[10px] text-text-muted">K</span>
            </div>
          </div>

          {/* Experience & Education row — free text */}
          <div className="grid grid-cols-2 gap-2">
            <FilterField
              icon={<GraduationCap className="w-3 h-3 text-primary-light" />}
              label="经验要求"
              placeholder="例：3-5年、应届生"
              value={filters.experience}
              onChange={(v) => onChange({ experience: v })}
            />
            <FilterField
              icon={<GraduationCap className="w-3 h-3 text-primary-light" />}
              label="学历要求"
              placeholder="例：本科、硕士"
              value={filters.education}
              onChange={(v) => onChange({ education: v })}
            />
          </div>

          {/* Exclude Keywords */}
          <FilterField
            icon={<Shield className="w-3 h-3 text-danger" />}
            label="排除公司/关键词"
            placeholder="例：外包 派遣 996"
            value={filters.excludeKeywords}
            onChange={(v) => onChange({ excludeKeywords: v })}
          />

          {/* AI Match Toggle */}
          <div className="flex items-center justify-between py-1">
            <div className="flex items-center gap-1.5">
              <Sparkles className="w-3 h-3 text-accent" />
              <span className="text-[11px] text-text-muted">按匹配分筛选</span>
            </div>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={filters.enableAiMatch}
                onChange={(e) => onChange({ enableAiMatch: e.target.checked })}
                className="w-3.5 h-3.5 rounded accent-primary"
              />
              <span className="text-[10px] text-text-muted">
                {filters.enableAiMatch ? `最低 ${filters.minMatchScore} 分` : '关闭 · 直接投递'}
              </span>
            </label>
          </div>

          {!filters.enableAiMatch && (
            <p className="text-[10px] leading-4 text-warning">
              不计算匹配门槛；通过职位、地区等基础筛选后直接投递。
            </p>
          )}

          {/* Min Match Score (only when AI enabled) */}
          {filters.enableAiMatch && (
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-text-muted whitespace-nowrap">最低匹配分</span>
              <input
                type="range"
                min={30}
                max={90}
                step={5}
                value={filters.minMatchScore}
                onChange={(e) => onChange({ minMatchScore: Number(e.target.value) })}
                className="flex-1 accent-primary h-1"
              />
              <span className="text-[10px] text-primary-light font-medium w-5">{filters.minMatchScore}</span>
            </div>
          )}

          {/* Start Button */}
          <button
            onClick={onStartApply}
            className="w-full mt-1 py-2.5 rounded-xl bg-gradient-to-r from-primary to-primary-light text-white text-sm font-semibold hover:shadow-lg hover:shadow-primary/20 transition-all active:scale-[0.98] flex items-center justify-center gap-2"
          >
            <Sparkles className="w-4 h-4" />
            开始智能投递
          </button>
        </div>
      )}
    </div>
  )
}

function FilterField({
  icon,
  label,
  placeholder,
  value,
  onChange,
}: {
  icon: React.ReactNode
  label: string
  placeholder: string
  value: string
  onChange: (v: string) => void
}) {
  return (
    <div>
      <div className="flex items-center gap-1.5 mb-1">
        {icon}
        <span className="text-[11px] text-text-muted">{label}</span>
      </div>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="input-field text-xs py-1.5"
        placeholder={placeholder}
      />
    </div>
  )
}
