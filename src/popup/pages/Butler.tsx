import React, { useCallback, useEffect, useState } from 'react'
import { Bot, RefreshCw, CheckCircle2, Sparkles } from 'lucide-react'
import { buildStrategy, DEFAULT_DAILY_QUOTA } from '../../shared/agent/butler/butler-planner'
import { getActiveFollowUps, getRecentDecisions } from '../../shared/db/butler-store'
import { getSetting } from '../../shared/db/settings-store'
import { log } from '../../shared/utils/logger'
import type { ButlerStrategy, FollowUpSuggestion, DecisionLog } from '../../shared/types/butler'
import type { ApplyFilters } from '../../shared/types/filters'

const MOD = 'ButlerTab'

function loadUserProfile(): Promise<{ jobTitles: string[]; locations: string[]; salaryMin?: number; salaryMax?: number }> {
  return getSetting<Partial<ApplyFilters>>('applyFilters', {}).then((filters) => ({
    jobTitles: (filters?.jobTitles || '').split(/\s+/).filter(Boolean),
    locations: (filters?.locations || '').split(/\s+/).filter(Boolean),
    salaryMin: filters?.salaryMin ?? undefined,
    salaryMax: filters?.salaryMax ?? undefined,
  }))
}

export default function Butler() {
  const [strategy, setStrategy] = useState<ButlerStrategy | null>(null)
  const [followUps, setFollowUps] = useState<FollowUpSuggestion[]>([])
  const [decisions, setDecisions] = useState<DecisionLog[]>([])
  const [scanning, setScanning] = useState(false)

  const refresh = useCallback(async () => {
    const profile = await loadUserProfile()
    setStrategy(buildStrategy({
      targetTitles: profile.jobTitles,
      targetCities: profile.locations,
      salaryMin: profile.salaryMin,
      salaryMax: profile.salaryMax,
      dailyQuota: DEFAULT_DAILY_QUOTA,
    }))
    setFollowUps(await getActiveFollowUps())
    setDecisions(await getRecentDecisions(5))
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const runScan = async () => {
    setScanning(true)
    try {
      const response = await chrome.runtime.sendMessage({ type: 'BUTLER_SCAN' }) as
        { success?: boolean; data?: { reportSummary: string; followUps: FollowUpSuggestion[] } } | undefined
      if (response?.success) {
        log(MOD, 'scan', response.data?.reportSummary ?? '')
        await refresh()
      }
    } catch (error) {
      log(MOD, 'scan', 'Butler scan failed', error)
    } finally {
      setScanning(false)
    }
  }

  const dismiss = async (id: string) => {
    const { dismissFollowUp } = await import('../../shared/db/butler-store')
    await dismissFollowUp(id)
    setFollowUps((current) => current.filter((f) => f.id !== id))
  }

  return (
    <div className="p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-bold gradient-text">求职管家</h1>
        <button
          onClick={() => void runScan()}
          disabled={scanning}
          className="flex items-center gap-1 rounded-lg bg-primary/20 hover:bg-primary/30 text-primary-light text-xs px-2.5 py-1.5 font-medium transition-colors disabled:opacity-50"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${scanning ? 'animate-spin' : ''}`} />
          {scanning ? '扫描中…' : '扫描跟进'}
        </button>
      </div>

      {strategy && (
        <div className="rounded-xl border border-white/5 bg-white/[0.03] p-3 space-y-2">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-text-primary">
            <Bot className="w-3.5 h-3.5 text-primary-light" />
            今日沟通策略
          </div>
          <p className="text-[11px] text-text-muted leading-relaxed">{strategy.summary}</p>
          <ul className="text-[11px] text-text-muted space-y-1">
            {strategy.priorities.map((priority, index) => (
              <li key={index} className="flex gap-1.5"><span className="text-primary-light">·</span>{priority}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="rounded-xl border border-white/5 bg-white/[0.03] p-3 space-y-2">
        <div className="flex items-center gap-1.5 text-xs font-semibold text-text-primary">
          <Sparkles className="w-3.5 h-3.5 text-primary-light" />
          跟进建议（投递 N 天未回复，建议+确认）
        </div>
        {followUps.length === 0 ? (
          <p className="text-[11px] text-text-muted">暂无待跟进的投递。点击「扫描跟进」检查投递状态。</p>
        ) : (
          followUps.slice(0, 5).map((followUp) => (
            <div key={followUp.id} className="rounded-lg bg-white/[0.03] border border-white/5 p-2.5 space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-medium text-text-normal">
                  {followUp.companyName} · {followUp.jobTitle}
                </span>
                <span className="text-[10px] text-amber-400 whitespace-nowrap">已 {followUp.daysSince} 天未回复</span>
              </div>
              <p className="text-[11px] text-text-muted leading-relaxed">{followUp.draftMessage}</p>
              <button
                onClick={() => void dismiss(followUp.id)}
                className="flex items-center gap-1 text-[11px] text-emerald-400 hover:text-emerald-300"
              >
                <CheckCircle2 className="w-3 h-3" /> 已处理
              </button>
            </div>
          ))
        )}
      </div>

      <div className="rounded-xl border border-white/5 bg-white/[0.03] p-3 space-y-2">
        <div className="flex items-center gap-1.5 text-xs font-semibold text-text-primary">
          <Bot className="w-3.5 h-3.5 text-primary-light" />
          最近 AI/Agent 决策留痕
        </div>
        {decisions.length === 0 ? (
          <p className="text-[11px] text-text-muted">暂无留痕记录。AI 决策会在此留痕，可复盘可追溯。</p>
        ) : (
          decisions.map((decision) => (
            <div key={decision.id} className="text-[11px] text-text-muted leading-relaxed">
              <span className="text-primary-light">{decision.source}</span> · {decision.subject}
              <span className="block text-[10px] opacity-70">{decision.thinking}</span>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
