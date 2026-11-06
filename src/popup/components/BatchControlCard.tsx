// 概览「批量沟通控制台」：把原本只存在于网页浮窗里的批量沟通控制能力搬进整高侧栏。
// 状态 / 进度 / 最近匹配来自全局 runtime（content 实时上报），模式与评分开关写回
// assistant-state / filters，与 content 的 loadApplyDefaultsFromSettings()、AIbot 流水线共用。

import React, { useEffect, useState } from 'react'
import {
  Send, Square, Zap, Sparkles, ListChecks, ShieldAlert, Activity,
} from 'lucide-react'
import type { ApplyFilters } from '../../shared/types/filters'
import { checkDailyLimit } from '../../shared/antiBot'
import { Disclosure } from '../../components/ui/disclosure'
import {
  DEFAULT_ASSISTANT_STATE,
  getAssistantState,
  patchAssistantState,
  subscribeAssistantState,
  type AssistantControlState,
} from '../../shared/assistant-state'
import type { AssistantRuntimeState, RunStatus } from '../../shared/runtime-state'

interface BatchControlCardProps {
  runtime: AssistantRuntimeState
  filters: ApplyFilters
  applyRunning: boolean
  onStartApply: (filters: ApplyFilters) => void
  onStopApply: () => void
  onFilterChange: (updates: Partial<ApplyFilters>) => void
}

const STATUS_META: Record<RunStatus, { label: string; dot: string; text: string; bg: string }> = {
  idle: { label: '待机中', dot: 'bg-slate-400', text: 'text-text-secondary', bg: 'bg-surface-dark border-surface-hairline' },
  scanning: { label: '扫描岗位中', dot: 'bg-primary', text: 'text-primary', bg: 'bg-surface-dark border-surface-hairline' },
  matching: { label: '匹配沟通中', dot: 'bg-primary', text: 'text-primary', bg: 'bg-surface-dark border-surface-hairline' },
  applying: { label: '正在沟通', dot: 'bg-success', text: 'text-success', bg: 'bg-surface-dark border-surface-hairline' },
  paused: { label: '已暂停', dot: 'bg-warning', text: 'text-warning', bg: 'bg-surface-dark border-surface-hairline' },
  done: { label: '本轮已完成', dot: 'bg-success', text: 'text-success', bg: 'bg-surface-dark border-surface-hairline' },
}

const ACTIVE_STATUSES: RunStatus[] = ['scanning', 'matching', 'applying']

export default function BatchControlCard({
  runtime,
  filters,
  applyRunning,
  onStartApply,
  onStopApply,
  onFilterChange,
}: BatchControlCardProps) {
  const [assistant, setAssistant] = useState<AssistantControlState>(DEFAULT_ASSISTANT_STATE)
  const [dailyRemaining, setDailyRemaining] = useState<number | null>(runtime.dailyRemaining)

  // 投递模式（批量沟通 / AI 自动确认）与页面浮窗、AIbot 共用 assistant-state
  useEffect(() => {
    getAssistantState().then(setAssistant).catch(() => {})
    return subscribeAssistantState(setAssistant)
  }, [])

  // 今日剩余额度：加载时取一次，每次处理进度变化后再刷新
  useEffect(() => {
    let cancelled = false
    checkDailyLimit()
      .then((res) => { if (!cancelled) setDailyRemaining(res.remaining) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [runtime.stats.processed, runtime.mode])

  const lockedByAutopilot = runtime.mode === 'autopilot'
  const isManualActive = runtime.mode === 'manual' && ACTIVE_STATUSES.includes(runtime.status)
  const busy = applyRunning || isManualActive
  const statusMeta = STATUS_META[runtime.status] ?? STATUS_META.idle
  const percent = runtime.stats.total > 0
    ? Math.min(100, Math.round((runtime.stats.processed / runtime.stats.total) * 100))
    : 0

  const handleModeChange = (mode: 'batch' | 'recommend') => {
    setAssistant((prev) => ({ ...prev, applyMode: mode }))
    void patchAssistantState({ applyMode: mode }).catch(() => {})
  }

  return (
    <div className="rounded-xl border border-surface-hairline bg-surface-darkest shadow-sm overflow-hidden">
      {/* 标题 + 状态胶囊 */}
      <div className="flex items-center justify-between gap-2 px-3.5 py-2.5 border-b border-surface-hairline">
        <div className="flex items-center gap-2 min-w-0">
          <div className="w-7 h-7 rounded-lg bg-brand-orange/10 border border-brand-orange/20 flex items-center justify-center shrink-0">
            <Activity className="w-4 h-4 text-brand-orange" />
          </div>
          <div className="min-w-0">
            <h3 className="text-[13px] font-medium text-text-primary leading-tight flex items-center gap-1.5">
              批量沟通控制台
              <span className="text-xs px-1.5 py-0.5 rounded bg-surface-dark text-text-secondary border border-surface-hairline font-medium shrink-0">
                半自动
              </span>
            </h3>
            <p className="text-xs text-text-muted leading-tight mt-0.5">扫描当前页面 · 按门槛逐个沟通</p>
          </div>
        </div>
        <span className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-md border font-medium shrink-0 ${statusMeta.bg} ${statusMeta.text}`}>
          <span className={`w-1.5 h-1.5 rounded-full ${statusMeta.dot}`} />
          {statusMeta.label}
        </span>
      </div>

      <div className="p-3.5 space-y-3">
        {/* 互斥提示：AIbot 全自动占用运行锁 */}
        {lockedByAutopilot && (
          <div className="flex items-start gap-2 rounded-lg border border-surface-hairline bg-surface-dark px-2.5 py-2 text-xs leading-relaxed text-warning">
            <ShieldAlert className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            <span>
              AIbot <strong>全自动</strong>正在运行。两条流水线互斥，请先在 AIbot 页点「终止」后再开始半自动沟通。
            </span>
          </div>
        )}

        {/* 进度条 */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-xs text-text-muted">
            <span className="truncate">{runtime.message || '尚未开始，配置好筛选条件后点「开始批量沟通」'}</span>
            <span className="font-mono shrink-0 ml-2">
              {runtime.stats.processed}/{runtime.stats.total || 0}
            </span>
          </div>
          <div className="w-full queue-rule">
            <div className="queue-rule-fill" style={{ width: `${percent}%` }} />
          </div>
        </div>

        {/* 三个核心数字 */}
        <div className="grid grid-cols-3 gap-2 text-center rounded-lg border border-surface-hairline bg-surface-dark p-2">
          <div>
            <div className="text-xs text-text-muted">本轮已处理</div>
            <div className="text-sm font-medium text-text-primary mt-0.5">{runtime.stats.processed}</div>
          </div>
          <div>
            <div className="text-xs text-success font-medium">匹配推荐</div>
            <div className="text-sm font-medium text-success mt-0.5">{runtime.stats.matched}</div>
          </div>
          <div>
            <div className="text-xs text-text-muted">今日剩余额度</div>
            <div className="text-sm font-medium text-text-primary mt-0.5">
              {dailyRemaining ?? runtime.dailyRemaining ?? '—'}
            </div>
          </div>
        </div>

        {/* 运行配置：投递模式 + AI 评分（与 AIbot 共用） */}
        <Disclosure label="更多设置" hint="投递模式 · AI 评分">
          <div className="space-y-2">
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-text-muted w-14 shrink-0">投递模式</span>
              <button
                type="button"
                onClick={() => handleModeChange('batch')}
                className={`flex-1 py-1.5 rounded-md text-xs border transition ${
                  assistant.applyMode === 'batch'
                    ? 'bg-primary text-white border-primary'
                    : 'bg-surface-darkest text-text-secondary border-surface-hairline hover:bg-surface-page'
                }`}
              >
                <Zap className="w-3 h-3 inline mr-0.5" />批量沟通
              </button>
              <button
                type="button"
                onClick={() => handleModeChange('recommend')}
                className={`flex-1 py-1.5 rounded-md text-xs border transition ${
                  assistant.applyMode === 'recommend'
                    ? 'bg-primary text-white border-primary'
                    : 'bg-surface-darkest text-text-secondary border-surface-hairline hover:bg-surface-page'
                }`}
              >
                <Sparkles className="w-3 h-3 inline mr-0.5" />AI自动确认
              </button>
            </div>

            <div className="flex items-center gap-1.5">
              <span className="text-xs text-text-muted w-14 shrink-0">AI 评分</span>
              <button
                type="button"
                onClick={() => onFilterChange({ enableAiMatch: true })}
                className={`flex-1 py-1.5 rounded-md text-xs border transition ${
                  filters.enableAiMatch
                    ? 'bg-primary text-white border-primary'
                    : 'bg-surface-darkest text-text-secondary border-surface-hairline hover:bg-surface-page'
                }`}
              >
                按分筛选
              </button>
              <button
                type="button"
                onClick={() => onFilterChange({ enableAiMatch: false })}
                className={`flex-1 py-1.5 rounded-md text-xs border transition ${
                  !filters.enableAiMatch
                    ? 'bg-primary text-white border-primary'
                    : 'bg-surface-darkest text-text-secondary border-surface-hairline hover:bg-surface-page'
                }`}
              >
                不评分沟通
              </button>
            </div>
            <p className="text-xs text-text-muted leading-relaxed">
              岗位、地点、薪资等门槛在上方筛选卡片设置，<strong>半自动与 AIbot 全自动共用同一份配置</strong>。
            </p>
          </div>
        </Disclosure>

        {/* 开始 / 停止 */}
        {busy ? (
          <button
            type="button"
            onClick={onStopApply}
            className="w-full py-2.5 rounded-lg bg-surface-dark hover:bg-rose-50 text-rose-600 border border-rose-200 text-xs font-medium flex items-center justify-center gap-1.5 transition active:scale-[0.99]"
          >
            <Square className="w-3.5 h-3.5 fill-current" />
            停止本轮批量沟通
          </button>
        ) : (
          <button
            type="button"
            onClick={() => onStartApply(filters)}
            disabled={lockedByAutopilot}
            className="w-full py-2.5 rounded-lg bg-accent text-white text-xs font-medium flex items-center justify-center gap-1.5 shadow-sm hover:brightness-105 active:scale-[0.99] transition disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Send className="w-3.5 h-3.5" />
            开始批量沟通（半自动）
          </button>
        )}

        {/* 最近匹配结果（只展示最近 3 条，完整记录在「追踪」页） */}
        <div className="border-t border-surface-hairline pt-2.5">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-medium text-text-secondary flex items-center gap-1">
              <ListChecks className="w-3.5 h-3.5 text-primary" />
              最近匹配结果
            </span>
          </div>
          {runtime.recentMatches.length === 0 ? (
            <p className="text-xs text-text-muted text-center py-3 rounded-lg bg-surface-dark border border-dashed border-surface-hairline">
              本轮还没有匹配结果，开始沟通后会实时显示
            </p>
          ) : (
            <div className="space-y-1.5">
              {runtime.recentMatches.slice(0, 3).map((item, index) => (
                <div
                  key={`${item.title}-${item.companyName}-${index}`}
                  className="flex items-center gap-2 px-2.5 py-2 rounded-lg border border-surface-hairline bg-surface-dark/70"
                >
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium text-text-primary truncate">{item.title}</p>
                    <p className="text-xs text-text-muted truncate">{item.companyName}</p>
                  </div>
                  <span
                    className={`text-xs font-medium px-1.5 py-0.5 rounded shrink-0 ${
                      item.scoreBypassed
                        ? 'bg-surface-dark text-text-secondary'
                        : item.recommended
                          ? 'bg-surface-dark text-success'
                          : 'bg-surface-dark text-text-secondary'
                    }`}
                  >
                    {item.scoreBypassed ? '直投' : `${item.score}分 ${item.recommended ? '✓' : '×'}`}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
