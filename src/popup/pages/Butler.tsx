import React, { useCallback, useEffect, useState } from 'react'
import {
  Bot,
  RefreshCw,
  CheckCircle2,
  Sparkles,
  BarChart3,
  Calendar,
  Clock,
  ShieldCheck,
  TrendingUp,
  Check,
  X,
  Copy,
  Target,
  Bug,
  Trash2,
  ChevronDown,
  Wrench,
} from 'lucide-react'
import { buildStrategy, DEFAULT_DAILY_QUOTA } from '../../shared/agent/butler/butler-planner'
import { buildReview } from '../../shared/agent/butler/review-planner'
import { getActiveFollowUps, getRecentDecisions } from '../../shared/db/butler-store'
import { getAllApplications } from '../../shared/db/application-store'
import { getSetting } from '../../shared/db/settings-store'
import { getDeveloperFixSuggestions } from '../../shared/db/diagnostics-store'
import { CATEGORY_LABELS } from '../../shared/types/diagnostics'
import type { DeveloperFixSuggestion, FixPriority } from '../../shared/types/diagnostics'
import { log } from '../../shared/utils/logger'
import type { ButlerStrategy, FollowUpSuggestion, DecisionLog } from '../../shared/types/butler'
import type { ApplyFilters } from '../../shared/types/filters'
import type { ReviewResult } from '../../shared/agent/butler/review-planner'
import type { ButlerDailyReport, DailyReportConfig, EvolutionProposal } from '../../shared/types/butler-evolution'
import type { ErrorRecord } from '../../shared/db/index'
import ButlerChatView from '../components/ButlerChatView'

const MOD = 'ButlerTab'

/** 开发者待修建议 · 优先级视觉映射 */
const FIX_PRIORITY_STYLE: Record<
  FixPriority,
  { label: string; badge: string; dot: string }
> = {
  critical: { label: 'CRITICAL', badge: 'bg-red-100 text-danger border-red-300', dot: 'bg-danger' },
  high: { label: 'HIGH', badge: 'bg-surface-dark text-orange-700 border-accent', dot: 'bg-surface-dark0' },
  medium: { label: 'MEDIUM', badge: 'bg-amber-100 text-warning border-surface-hairline', dot: 'bg-amber-400' },
  low: { label: 'LOW', badge: 'bg-surface-dark text-text-secondary border-surface-hairline', dot: 'bg-slate-400' },
}

function loadUserProfile(): Promise<{
  jobTitles: string[]
  locations: string[]
  salaryMin?: number
  salaryMax?: number
}> {
  return getSetting<Partial<ApplyFilters>>('applyFilters', {}).then((filters) => ({
    jobTitles: (filters?.jobTitles || '').split(/\s+/).filter(Boolean),
    locations: (filters?.locations || '').split(/\s+/).filter(Boolean),
    salaryMin: filters?.salaryMin ?? undefined,
    salaryMax: filters?.salaryMax ?? undefined,
  }))
}

export default function Butler() {
  const [subTab, setSubTab] = useState<'chat' | 'daily_report' | 'evolution' | 'strategy' | 'decisions' | 'errors' | 'fixes'>('chat')

  // 1. 日报状态
  const [dailyReport, setDailyReport] = useState<ButlerDailyReport | null>(null)
  const [, setLoadingReport] = useState(false)
  const [generatingReport, setGeneratingReport] = useState(false)
  const [reportConfig, setReportConfig] = useState<DailyReportConfig | null>(null)
  const [showConfigModal, setShowConfigModal] = useState(false)
  const [scheduledTimeInput, setScheduledTimeInput] = useState('18:00')
  const [autoGenOnFinished, setAutoGenOnFinished] = useState(true)
  const [copiedMessage, setCopiedMessage] = useState(false)

  // 2. 进化提案状态
  const [proposals, setProposals] = useState<EvolutionProposal[]>([])
  const [, setLoadingProposals] = useState(false)
  const [analyzingInduction, setAnalyzingInduction] = useState(false)
  const [respondingId, setRespondingId] = useState<string | null>(null)
  const [proposalFilter, setProposalFilter] = useState<'all' | 'pending' | 'accepted'>('all')

  // 3. 基础管家状态
  const [strategy, setStrategy] = useState<ButlerStrategy | null>(null)
  const [followUps, setFollowUps] = useState<FollowUpSuggestion[]>([])
  const [decisions, setDecisions] = useState<DecisionLog[]>([])
  const [review, setReview] = useState<ReviewResult | null>(null)
  const [scanning, setScanning] = useState(false)

  // 4. 异常与 Bug 留痕状态
  const [errorRecords, setErrorRecords] = useState<ErrorRecord[]>([])
  const [errorCount, setErrorCount] = useState(0)
  const [loadingErrors, setLoadingErrors] = useState(false)
  const [errorFilter, setErrorFilter] = useState<'all' | 'boss' | 'campaign' | 'butler' | 'other'>('all')
  const [expandedErrorId, setExpandedErrorId] = useState<string | null>(null)
  const [copiedError, setCopiedError] = useState(false)

  // 5. 开发者待修清单状态（M4 · 自愈事件自动归因）
  const [fixSuggestions, setFixSuggestions] = useState<DeveloperFixSuggestion[]>([])
  const [loadingFixes, setLoadingFixes] = useState(false)
  const [copiedFixes, setCopiedFixes] = useState(false)
  const [expandedFixKey, setExpandedFixKey] = useState<string | null>(null)

  // 数据加载

  const fetchDailyReport = useCallback(async () => {
    setLoadingReport(true)
    try {
      const res = (await chrome.runtime.sendMessage({ type: 'GET_DAILY_REPORT' })) as {
        success: boolean
        data?: ButlerDailyReport
      }
      if (res?.success && res.data) {
        setDailyReport(res.data)
      } else {
        // 如果今天尚未生成，自动生成一次
        const genRes = (await chrome.runtime.sendMessage({ type: 'GENERATE_DAILY_REPORT' })) as {
          success: boolean
          data?: ButlerDailyReport
        }
        if (genRes?.success && genRes.data) {
          setDailyReport(genRes.data)
        }
      }

      const cfgRes = (await chrome.runtime.sendMessage({ type: 'GET_DAILY_REPORT_CONFIG' })) as {
        success: boolean
        data?: DailyReportConfig
      }
      if (cfgRes?.success && cfgRes.data) {
        setReportConfig(cfgRes.data)
        setScheduledTimeInput(cfgRes.data.scheduledTime || '18:00')
        setAutoGenOnFinished(cfgRes.data.triggerOnCampaignFinished ?? true)
      }
    } catch (e) {
      log(MOD, 'fetchDailyReport error', e)
    } finally {
      setLoadingReport(false)
    }
  }, [])

  const fetchProposals = useCallback(async () => {
    setLoadingProposals(true)
    try {
      const res = (await chrome.runtime.sendMessage({ type: 'LIST_EVOLUTION_PROPOSALS' })) as {
        success: boolean
        data?: EvolutionProposal[]
      }
      if (res?.success && res.data) {
        setProposals(res.data)
      }
    } catch (e) {
      log(MOD, 'fetchProposals error', e)
    } finally {
      setLoadingProposals(false)
    }
  }, [])

  const fetchErrors = useCallback(async () => {
    setLoadingErrors(true)
    try {
      const res = (await chrome.runtime.sendMessage({
        type: 'LIST_ERRORS',
        payload: { limit: 100 },
      })) as { success: boolean; data?: ErrorRecord[] }
      if (res?.success && Array.isArray(res.data)) {
        setErrorRecords(res.data)
        setErrorCount(res.data.length)
      }
    } catch (e) {
      log(MOD, 'fetchErrors error', e)
    } finally {
      setLoadingErrors(false)
    }
  }, [])

  const fetchFixes = useCallback(async () => {
    setLoadingFixes(true)
    try {
      const data = await getDeveloperFixSuggestions()
      setFixSuggestions(Array.isArray(data) ? data : [])
    } catch (e) {
      log(MOD, 'fetchFixes error', e)
      setFixSuggestions([])
    } finally {
      setLoadingFixes(false)
    }
  }, [])

  const handleClearErrors = async () => {
    try {
      await chrome.runtime.sendMessage({ type: 'CLEAR_ERRORS' })
      setErrorRecords([])
      setErrorCount(0)
    } catch {
      // 忽略
    }
  }

  const handleCopyErrors = () => {
    if (errorRecords.length === 0) return
    const text = errorRecords
      .map(
        (r, i) =>
          `[#${i + 1}] ${r.createdAt} | 模块: ${r.source}\n错误原因: ${r.message}\n诊断上下文: ${r.context || '无'}\n异常堆栈: ${r.stack || '无'}`
      )
      .join('\n\n------------------------------\n\n')
    navigator.clipboard.writeText(text)
    setCopiedError(true)
    setTimeout(() => setCopiedError(false), 2000)
  }

  /** 生成可直接粘贴到 GitHub Issue 的 Markdown 待修清单 */
  const handleCopyFixesMarkdown = () => {
    if (fixSuggestions.length === 0) return
    const lines: string[] = [
      `## 开发者待修清单（自动归因）· ${new Date().toISOString().slice(0, 10)}`,
      '',
      `> 共 ${fixSuggestions.length} 条聚合建议 · 基于运行时自愈事件自动归因，按修复优先级排序。`,
      '',
    ]

    fixSuggestions.forEach((s, i) => {
      const style = FIX_PRIORITY_STYLE[s.priority] ?? FIX_PRIORITY_STYLE.low
      lines.push(`### ${i + 1}. [${style.label}] ${s.fixTitle}（${s.occurrences} 次）`, '')
      lines.push(`- **平台**：${s.platform}`)
      lines.push(`- **类别**：${CATEGORY_LABELS[s.category] ?? s.category}`)
      lines.push(`- **最近触发**：${s.lastOccurredAt}`)
      lines.push(`- **建议**：${s.fixDescription}`)
      lines.push(
        s.failedSelectors.length > 0
          ? `- **失败选择器**：${s.failedSelectors.map((v) => `\`${v}\``).join(', ')}`
          : '- **失败选择器**：无',
      )
      if (s.buttonTexts.length > 0) {
        lines.push(`- **相关按钮文本**：${s.buttonTexts.map((v) => `\`${v}\``).join(', ')}`)
      }
      lines.push('')
    })

    navigator.clipboard.writeText(lines.join('\n').trim())
    setCopiedFixes(true)
    setTimeout(() => setCopiedFixes(false), 2000)
  }

  const refreshBase = useCallback(async () => {
    const profile = await loadUserProfile()
    setStrategy(
      buildStrategy({
        targetTitles: profile.jobTitles,
        targetCities: profile.locations,
        salaryMin: profile.salaryMin,
        salaryMax: profile.salaryMax,
        dailyQuota: DEFAULT_DAILY_QUOTA,
      }),
    )
    setFollowUps(await getActiveFollowUps())
    setDecisions(await getRecentDecisions(10))
    setReview(buildReview(await getAllApplications()))
  }, [])

  const runScan = async () => {
    setScanning(true)
    try {
      const response = (await chrome.runtime.sendMessage({ type: 'BUTLER_SCAN' })) as
        | { success?: boolean; data?: { reportSummary: string; followUps: FollowUpSuggestion[] } }
        | undefined
      if (response?.success) {
        log(MOD, 'scan', response.data?.reportSummary ?? '')
        await refreshBase()
        setSubTab('strategy')
      }
    } catch (error) {
      log(MOD, 'scan', 'Butler scan failed', error)
    } finally {
      setScanning(false)
    }
  }

  useEffect(() => {
    void fetchDailyReport()
    void fetchProposals()
    void fetchErrors()
    void fetchFixes()
    void refreshBase()
  }, [fetchDailyReport, fetchProposals, fetchErrors, fetchFixes, refreshBase])

  useEffect(() => {
    if (subTab === 'errors') {
      void fetchErrors()
    }
    if (subTab === 'fixes') {
      void fetchFixes()
    }
  }, [subTab, fetchErrors, fetchFixes])

  // 日报操作

  const handleManualGenerateReport = async () => {
    setGeneratingReport(true)
    try {
      const res = (await chrome.runtime.sendMessage({ type: 'GENERATE_DAILY_REPORT' })) as {
        success: boolean
        data?: ButlerDailyReport
      }
      if (res?.success && res.data) {
        setDailyReport(res.data)
      }
    } finally {
      setGeneratingReport(false)
    }
  }

  const handleSaveReportConfig = async () => {
    try {
      await chrome.runtime.sendMessage({
        type: 'UPDATE_DAILY_REPORT_CONFIG',
        payload: {
          scheduledTime: scheduledTimeInput,
          triggerOnCampaignFinished: autoGenOnFinished,
          autoGenerate: true,
        },
      })
      setShowConfigModal(false)
      await fetchDailyReport()
    } catch {
      // 忽略
    }
  }

  const handleCopyReportMarkdown = () => {
    if (!dailyReport) return
    const md = `
# 求职管家 · 今日事后复盘日报 (${dailyReport.date})

> **战报综述**：${dailyReport.summary}

## 投递漏斗概览
* **扫描职位**：${dailyReport.funnel.scanned} 个
* **AI 门槛筛除**：${dailyReport.funnel.filtered} 个
* **发起沟通**：${dailyReport.funnel.applied} 个
* **HR 互动/回复**：${dailyReport.funnel.read + dailyReport.funnel.communicating} 个
* **面试邀约**：${dailyReport.funnel.interview} 个
* **回复转化率**：${dailyReport.funnel.replyRate}%

## 安全护栏（Guardrails）与拟人保障
* **安全运行评分**：${dailyReport.guardrailStatus.safetyScore} / 100
* **拟人间歇区间**：${dailyReport.guardrailStatus.intervalRange} 随机延时
* **平台风控拦截**：${dailyReport.guardrailStatus.captchaEncounters} 次（已安全挂起）
* **护栏状态**：${dailyReport.guardrailStatus.safeStatusText}

## 今日高光
${dailyReport.highlights.map((h) => `- ${h}`).join('\n')}

## 诊断与归因
${dailyReport.diagnostics.map((d) => `- ${d}`).join('\n')}

## 明日作战指南
* **主攻岗位**：${dailyReport.nextDayActionPlan.focusTitles.join(' / ')}
* **黄金时段**：${dailyReport.nextDayActionPlan.recommendedHours}
* **建议配额**：${dailyReport.nextDayActionPlan.suggestedQuota} 份
`.trim()

    navigator.clipboard.writeText(md)
    setCopiedMessage(true)
    setTimeout(() => setCopiedMessage(false), 2000)
  }

  // 进化提案操作（人做出战略抉择）

  const handleRunInduction = async () => {
    setAnalyzingInduction(true)
    try {
      const res = (await chrome.runtime.sendMessage({ type: 'RUN_INDUCTION_ANALYSIS' })) as {
        success: boolean
        data?: EvolutionProposal[]
      }
      if (res?.success && res.data) {
        setProposals(res.data)
      }
    } finally {
      setAnalyzingInduction(false)
    }
  }

  const handleAcceptProposal = async (id: string) => {
    setRespondingId(id)
    try {
      await chrome.runtime.sendMessage({
        type: 'ACCEPT_EVOLUTION_PROPOSAL',
        payload: { id, note: '用户通过界面确认同意采纳并学习写入画像' },
      })
      await fetchProposals()
      await refreshBase()
    } finally {
      setRespondingId(null)
    }
  }

  const handleRejectProposal = async (id: string) => {
    setRespondingId(id)
    try {
      await chrome.runtime.sendMessage({
        type: 'REJECT_EVOLUTION_PROPOSAL',
        payload: { id, note: '用户选择保留原方案' },
      })
      await fetchProposals()
      await refreshBase()
    } finally {
      setRespondingId(null)
    }
  }

  const dismissFollowUp = async (id: string) => {
    const { dismissFollowUp: dismiss } = await import('../../shared/db/butler-store')
    await dismiss(id)
    setFollowUps((curr) => curr.filter((f) => f.id !== id))
  }

  const pendingProposalsCount = proposals.filter((p) => p.status === 'pending').length

  const filteredProposals = proposals.filter((p) => {
    if (proposalFilter === 'all') return true
    return p.status === proposalFilter
  })

  return (
    <div className="px-3.5 py-3 pb-4 space-y-4 text-text-primary">
      {/* 顶部标题与管家模式切换 */}
      <div className="space-y-3 pb-3 border-b border-surface-hairline">
        {/* 标题行：标题与操作按钮分列两端，不再和导航抢空间 */}
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <div className="w-8 h-8 rounded-lg bg-surface-dark border border-surface-hairline flex items-center justify-center text-primary shrink-0">
              <Bot className="w-4 h-4" />
            </div>
            <div className="min-w-0">
              <h2 className="text-sm font-medium flex items-center gap-1.5 flex-wrap">
                求职管家 Agent
                <span className="text-xs px-1.5 py-0.5 rounded bg-surface-dark text-primary border border-surface-hairline font-medium">
                  认知与自进化
                </span>
              </h2>
            </div>
          </div>
          <button
            type="button"
            onClick={() => void runScan()}
            disabled={scanning}
            className="flex items-center gap-1.5 rounded-lg bg-surface-dark hover:bg-surface-dark text-primary text-xs px-2.5 py-1.5 font-medium transition cursor-pointer disabled:opacity-50 shrink-0 whitespace-nowrap"
          >
            <RefreshCw className={`w-3 h-3 ${scanning ? 'animate-spin' : ''}`} />
            {scanning ? '扫描中…' : '扫描跟进'}
          </button>
        </div>

        {/* 二级导航：两行三列网格，6 个入口不再挤在同一行 */}
        <div className="grid grid-cols-3 gap-1.5 p-1 rounded-xl bg-surface-dark border border-surface-hairline">
          <button
            type="button"
            onClick={() => setSubTab('chat')}
            className={`flex items-center justify-center gap-1.5 rounded-lg px-2 py-2 text-xs font-medium transition cursor-pointer ${
              subTab === 'chat'
                ? 'bg-surface-darkest shadow-2xs text-primary font-medium border border-surface-hairline'
                : 'text-text-muted hover:text-text-primary hover:bg-surface-darkest'
            }`}
          >
            <Bot className="w-3.5 h-3.5 text-accent" />
            对话中控
          </button>
          <button
            type="button"
            onClick={() => setSubTab('daily_report')}
            className={`flex items-center justify-center gap-1.5 rounded-lg px-2 py-2 text-xs font-medium transition cursor-pointer ${
              subTab === 'daily_report'
                ? 'bg-surface-darkest shadow-2xs text-primary border border-surface-hairline'
                : 'text-text-muted hover:text-text-primary hover:bg-surface-darkest'
            }`}
          >
            <Calendar className="w-3.5 h-3.5" />
            管家日报
          </button>
          <button
            type="button"
            onClick={() => setSubTab('evolution')}
            className={`flex items-center justify-center gap-1.5 rounded-lg px-2 py-2 text-xs font-medium transition cursor-pointer relative ${
              subTab === 'evolution'
                ? 'bg-surface-darkest shadow-2xs text-primary border border-surface-hairline'
                : 'text-text-muted hover:text-text-primary hover:bg-surface-darkest'
            }`}
          >
            <Sparkles className="w-3.5 h-3.5 text-brand-orange" />
            策略进化
            {pendingProposalsCount > 0 && (
              <span className="w-1.5 h-1.5 rounded-full bg-brand-orange" />
            )}
          </button>
          <button
            type="button"
            onClick={() => setSubTab('strategy')}
            className={`flex items-center justify-center gap-1.5 rounded-lg px-2 py-2 text-xs font-medium transition cursor-pointer ${
              subTab === 'strategy'
                ? 'bg-surface-darkest shadow-2xs text-primary border border-surface-hairline'
                : 'text-text-muted hover:text-text-primary hover:bg-surface-darkest'
            }`}
          >
            <Target className="w-3.5 h-3.5" />
            跟进与留痕
          </button>
          <button
            type="button"
            onClick={() => setSubTab('errors')}
            className={`flex items-center justify-center gap-1.5 rounded-lg px-2 py-2 text-xs font-medium transition cursor-pointer ${
              subTab === 'errors'
                ? 'bg-surface-darkest shadow-2xs text-danger font-medium border border-surface-hairline'
                : 'text-text-muted hover:text-text-primary hover:bg-surface-darkest'
            }`}
          >
            <Bug className="w-3.5 h-3.5 text-red-500" />
            异常留痕
            {errorCount > 0 && (
              <span className="px-1 py-0.5 text-xs rounded-md bg-red-100 text-danger font-medium">
                {errorCount}
              </span>
            )}
          </button>
          <button
            type="button"
            onClick={() => setSubTab('fixes')}
            className={`flex items-center justify-center gap-1.5 rounded-lg px-2 py-2 text-xs font-medium transition cursor-pointer ${
              subTab === 'fixes'
                ? 'bg-surface-darkest shadow-2xs text-warning font-medium border border-surface-hairline'
                : 'text-text-muted hover:text-text-primary hover:bg-surface-darkest'
            }`}
          >
            <Wrench className="w-3.5 h-3.5 text-warning" />
            待修清单
            {fixSuggestions.length > 0 && (
              <span className="px-1 py-0.5 text-xs rounded-md bg-danger text-white font-medium">
                {fixSuggestions.length}
              </span>
            )}
          </button>
        </div>
      </div>

      {/* 视图 0：对话即操作 · 智能中控台 */}
      {subTab === 'chat' && <ButlerChatView />}

      {/* 视图 1：事后复盘 · 管家日报 */}
      {subTab === 'daily_report' && (
        <div className="space-y-4">
          {/* 日报控制栏与定时配置 */}
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 bg-surface-dark p-3 rounded-xl border border-surface-hairline text-xs">
            <div className="flex flex-wrap items-center gap-2 min-w-0">
              <Calendar className="w-3.5 h-3.5 text-primary shrink-0" />
              <span className="font-medium text-text-primary">
                {dailyReport?.date || '今日'} 投递复盘战报
              </span>
              <span className="text-xs text-success bg-surface-dark px-1.5 py-0.5 rounded border border-surface-hairline">
                {dailyReport?.trigger === 'campaign_finished'
                  ? '跑毕自动生成'
                  : dailyReport?.trigger === 'scheduled'
                  ? '定时自动生成'
                  : '手动复盘'}
              </span>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => setShowConfigModal(!showConfigModal)}
                className="text-xs text-text-muted hover:text-primary transition flex items-center gap-1 cursor-pointer px-2 py-1 rounded-lg bg-surface-darkest border border-surface-hairline"
                title="修改每日自动生成时间"
              >
                <Clock className="w-3 h-3 text-primary" />
                定时: {reportConfig?.scheduledTime || '18:00'}
              </button>

              <button
                type="button"
                onClick={handleCopyReportMarkdown}
                className="text-xs text-text-muted hover:text-primary transition flex items-center gap-1 cursor-pointer px-2 py-1 rounded-lg bg-surface-darkest border border-surface-hairline"
                title="一键复制 Markdown 格式战报"
              >
                {copiedMessage ? <Check className="w-3 h-3 text-success" /> : <Copy className="w-3 h-3" />}
                {copiedMessage ? '已复制' : '复制战报'}
              </button>

              <button
                type="button"
                onClick={handleManualGenerateReport}
                disabled={generatingReport}
                className="text-xs text-primary hover:bg-surface-dark transition flex items-center gap-1 cursor-pointer px-2.5 py-1 rounded-lg bg-surface-dark border border-surface-hairline font-medium disabled:opacity-50"
                title="重新生成并分析最新战报"
              >
                <RefreshCw className={`w-3 h-3 ${generatingReport ? 'animate-spin' : ''}`} />
                {generatingReport ? '复盘中...' : '重新复盘'}
              </button>
            </div>
          </div>

          {/* 定时生成设置浮层 */}
          {showConfigModal && (
            <div className="bg-surface-dark border border-surface-hairline rounded-xl p-3 text-xs space-y-2.5">
              <div className="flex items-center justify-between border-b border-surface-hairline pb-1">
                <span className="font-medium text-text-primary flex items-center gap-1">
                  <Clock className="w-3.5 h-3.5 text-primary" />
                  日报全自动生成定时配置
                </span>
                <button
                  type="button"
                  onClick={() => setShowConfigModal(false)}
                  className="text-text-muted hover:text-text-primary cursor-pointer"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>

              <div className="flex items-center justify-between">
                <span className="text-xs text-text-secondary">每日定时生成时点：</span>
                <input
                  type="time"
                  value={scheduledTimeInput}
                  onChange={(e) => setScheduledTimeInput(e.target.value)}
                  className="px-2 py-0.5 rounded border border-surface-hairline bg-surface-darkest text-xs outline-none focus:border-primary"
                />
              </div>

              <label className="flex items-center gap-1.5 text-xs text-text-secondary cursor-pointer">
                <input
                  type="checkbox"
                  checked={autoGenOnFinished}
                  onChange={(e) => setAutoGenOnFinished(e.target.checked)}
                  className="rounded text-primary focus:ring-0 w-3 h-3"
                />
                AIbot 当天全流程跑完/配额达成时立即自动复盘生成
              </label>

              <div className="flex justify-end gap-1.5 pt-1 border-t border-surface-hairline">
                <button
                  type="button"
                  onClick={() => setShowConfigModal(false)}
                  className="px-2.5 py-1 rounded-lg bg-surface-darkest border border-surface-hairline text-xs text-text-secondary cursor-pointer"
                >
                  取消
                </button>
                <button
                  type="button"
                  onClick={handleSaveReportConfig}
                  className="px-3 py-1 rounded-lg bg-primary text-white text-xs font-medium hover:bg-primary-light cursor-pointer"
                >
                  保存设置
                </button>
              </div>
            </div>
          )}

          {dailyReport ? (
            <>
              {/* 一句话宏观战报 */}
              <div className="rounded-xl border border-surface-hairline bg-surface-dark p-3 space-y-1">
                <div className="flex items-center gap-1.5 text-xs font-medium text-primary">
                  <Bot className="w-3.5 h-3.5" />
                  今日管家复盘综述
                </div>
                <p className="text-xs text-text-secondary leading-relaxed">
                  {dailyReport.summary}
                </p>
              </div>

              {/* 核心漏斗指标 */}
              <div className="grid grid-cols-4 gap-2 text-center bg-surface-dark p-3 rounded-xl border border-surface-hairline">
                <div className="min-w-0">
                  <div className="text-xs leading-snug text-text-muted">扫描探测</div>
                  <div className="text-base font-medium text-text-primary mt-1">
                    {dailyReport.funnel.scanned}
                  </div>
                </div>
                <div className="min-w-0">
                  <div className="text-xs leading-snug text-success font-medium">发起沟通</div>
                  <div className="text-base font-medium text-success mt-1">
                    {dailyReport.funnel.applied}
                  </div>
                </div>
                <div className="min-w-0">
                  <div className="text-xs leading-snug text-sky-600">已读/互动</div>
                  <div className="text-base font-medium text-sky-600 mt-1">
                    {dailyReport.funnel.read + dailyReport.funnel.communicating}
                  </div>
                </div>
                <div className="min-w-0">
                  <div className="text-xs leading-snug text-brand-orange font-medium">回复转化率</div>
                  <div className="text-base font-medium text-brand-orange mt-1">
                    {dailyReport.funnel.replyRate}%
                  </div>
                </div>
              </div>

              {/* 严格安全护栏（Guardrails）与拟人保护达标证明 */}
              <div className="rounded-xl border border-surface-hairline bg-surface-dark/60 p-3 space-y-2 text-xs">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium text-emerald-900 flex items-center gap-1.5">
                    <ShieldCheck className="w-4 h-4 text-success" />
                    严格安全护栏（Guardrails）达标运行
                  </span>
                  <span className="text-xs font-medium text-success bg-surface-darkest px-2 py-0.5 rounded border border-emerald-300">
                    安全得分: {dailyReport.guardrailStatus.safetyScore}/100
                  </span>
                </div>
                <div className="grid grid-cols-3 gap-2 text-xs leading-snug text-emerald-800">
                  <div className="bg-surface-darkest p-2 rounded-lg border border-emerald-100">
                    <span className="text-success block">拟人间歇:</span>
                    <strong>{dailyReport.guardrailStatus.intervalRange}</strong>
                  </div>
                  <div className="bg-surface-darkest p-2 rounded-lg border border-emerald-100">
                    <span className="text-success block">风控拦截:</span>
                    <strong>{dailyReport.guardrailStatus.captchaEncounters} 次</strong>
                  </div>
                  <div className="bg-surface-darkest p-2 rounded-lg border border-emerald-100">
                    <span className="text-success block">账号安全度:</span>
                    <strong className="text-success">100% 极佳</strong>
                  </div>
                </div>
                <p className="text-xs text-success mt-1 leading-relaxed">
                  ✓ {dailyReport.guardrailStatus.safeStatusText}
                </p>
              </div>

              {/* 各平台投递分布 */}
              <div className="rounded-xl border border-surface-hairline bg-surface-dark p-3 space-y-2 text-xs">
                <span className="text-xs font-medium text-text-secondary block">
                  多平台投递与配额消耗分布
                </span>
                <div className="space-y-1.5">
                  {Object.entries(dailyReport.platformBreakdown).map(([pName, pData]) => (
                    <div key={pName} className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 text-xs bg-surface-darkest p-2.5 rounded-lg border border-surface-hairline">
                      <span className="font-medium text-text-primary">{pName}</span>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="text-xs text-text-muted">
                          沟通 {pData.applied} | 回复 {pData.replied}
                        </span>
                        <span className="text-xs font-mono text-primary bg-surface-dark px-1.5 py-0.5 rounded">
                          配额: {pData.quotaUsed}/{pData.quotaTotal}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>


              {/* 今日高光亮点与问题诊断 */}
              <div className="grid grid-cols-1 gap-2">
                <div className="rounded-xl border border-surface-hairline bg-surface-dark p-3 space-y-2 text-xs">
                  <span className="text-xs font-medium text-text-secondary flex items-center gap-1">
                    <Sparkles className="w-3.5 h-3.5 text-brand-orange" />
                    今日高光亮点
                  </span>
                  <ul className="text-xs leading-relaxed text-text-muted space-y-1.5 pl-1">
                    {dailyReport.highlights.map((h, i) => (
                      <li key={i} className="flex items-start gap-1">
                        <span className="text-brand-orange shrink-0">·</span>
                        <span>{h}</span>
                      </li>
                    ))}
                  </ul>
                </div>

                <div className="rounded-xl border border-surface-hairline bg-surface-dark p-3 space-y-2 text-xs">
                  <span className="text-xs font-medium text-text-secondary flex items-center gap-1">
                    <TrendingUp className="w-3.5 h-3.5 text-primary" />
                    问题诊断与归因
                  </span>
                  <ul className="text-xs leading-relaxed text-text-muted space-y-1.5 pl-1">
                    {dailyReport.diagnostics.map((d, i) => (
                      <li key={i} className="flex items-start gap-1">
                        <span className="text-primary shrink-0">·</span>
                        <span>{d}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>

              {/* 明日作战指南 */}
              <div className="rounded-xl border border-surface-hairline bg-surface-dark p-3 space-y-2 text-xs">
                <span className="text-xs font-medium text-text-primary flex items-center gap-1">
                  <Target className="w-3.5 h-3.5 text-primary" />
                  明日作战行动指南
                </span>
                <div className="text-xs leading-relaxed text-text-muted space-y-1.5">
                  <div>
                    <strong className="text-text-secondary">主攻方向：</strong>
                    {dailyReport.nextDayActionPlan.focusTitles.join(' / ')}
                  </div>
                  <div>
                    <strong className="text-text-secondary">推荐黄金时段：</strong>
                    {dailyReport.nextDayActionPlan.recommendedHours}
                  </div>
                  <ul className="space-y-0.5 pt-0.5">
                    {dailyReport.nextDayActionPlan.keyTips.map((tip, i) => (
                      <li key={i} className="flex items-start gap-1.5 text-xs">
                        <span className="text-primary shrink-0">✓</span>
                        <span>{tip}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            </>
          ) : (
            <div className="text-center py-10 text-xs text-text-muted space-y-2">
              <Calendar className="w-8 h-8 text-text-muted mx-auto" />
              <p>今日尚无复盘日报，点击上方「重新复盘」或等待 AIbot 执行完毕后自动生成。</p>
            </div>
          )}
        </div>
      )}

      {/* 视图 2：高级的进化 · 感知与进化策略中心 */}
      {subTab === 'evolution' && (
        <div className="space-y-4">
          {/* 人机协同哲学导语卡片 */}
          <div className="rounded-xl border border-surface-hairline bg-surface-dark p-3.5 space-y-2 text-xs">
            <div className="flex items-center justify-between">
              <span className="font-medium text-[12px] text-text-primary flex items-center gap-1">
                <Sparkles className="w-4 h-4 text-brand-orange" />
                认知自进化闭环 · 战略抉择中心
              </span>
              <button
                type="button"
                onClick={handleRunInduction}
                disabled={analyzingInduction}
                className="text-xs text-primary bg-surface-darkest border border-surface-hairline hover:bg-surface-dark px-2.5 py-1 rounded-lg transition flex items-center gap-1 cursor-pointer disabled:opacity-50"
                title="深度分析海量 JD 与真实回复规律"
              >
                <RefreshCw className={`w-2.5 h-2.5 ${analyzingInduction ? 'animate-spin' : ''}`} />
                {analyzingInduction ? '感知归纳中...' : '重新感知归纳'}
              </button>
            </div>
            <p className="text-xs text-text-muted leading-relaxed">
              <strong>系统负责感知与归纳</strong>（深度收集海量岗位 JD 与沟通数据，提炼高回复率特征）；
              <strong>系统向人汇报洞察并提出策略选项</strong>；
              <strong>人做出战略抉择</strong>，系统在严格的<strong>安全护栏（Guardrails）</strong>与拟人策略下克制地执行。
            </p>
          </div>

          {/* 提案过滤筛选 */}
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
            <div className="flex flex-wrap items-center gap-1.5 text-xs">
              <span className="text-text-muted">筛选：</span>
              {(['all', 'pending', 'accepted'] as const).map((f) => (
                <button
                  key={f}
                  type="button"
                  onClick={() => setProposalFilter(f)}
                  className={`px-2.5 py-1 rounded-lg text-xs transition cursor-pointer ${
                    proposalFilter === f
                      ? 'bg-primary text-white font-medium'
                      : 'bg-surface-dark text-text-muted hover:text-text-primary'
                  }`}
                >
                  {f === 'all' ? '全部' : f === 'pending' ? '待战略抉择' : '已采纳'}
                </button>
              ))}
            </div>
            <span className="text-xs text-text-muted">
              共 {filteredProposals.length} 项进化提案
            </span>
          </div>

          {/* 进化提案列表 */}
          <div className="space-y-4">
            {filteredProposals.map((proposal) => {
              const isPending = proposal.status === 'pending'
              const isAccepted = proposal.status === 'accepted'
              const isRejected = proposal.status === 'rejected'

              return (
                <div
                  key={proposal.id}
                  className={`rounded-xl border p-3.5 space-y-3 transition-colors text-xs ${
                    isPending
                      ? 'border-surface-hairline bg-surface-darkest shadow-xs'
                      : isAccepted
                      ? 'border-surface-hairline bg-surface-dark/30'
                      : 'border-surface-hairline bg-surface-page/70 opacity-60'
                  }`}
                >
                  {/* 提案头部与分类 */}
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <span className="font-medium text-[12px] text-text-primary flex flex-wrap items-center gap-1.5 min-w-0 flex-1">
                      <span className="text-xs px-1.5 py-0.5 rounded font-medium bg-brand-orange/10 text-brand-orange border border-brand-orange/20">
                        {proposal.categoryBadge}
                      </span>
                      {proposal.title}
                    </span>

                    {/* 状态徽章 */}
                    <div>
                      {isPending && (
                        <span className="text-xs px-2 py-0.5 rounded-md bg-surface-dark text-warning border border-amber-300 font-medium">
                          等待您的战略抉择
                        </span>
                      )}
                      {isAccepted && (
                        <span className="text-xs px-2 py-0.5 rounded-md bg-surface-dark text-success border border-emerald-300 font-medium flex items-center gap-0.5">
                          <Check className="w-3 h-3 text-success" />
                          已采纳并写入记忆
                        </span>
                      )}
                      {isRejected && (
                        <span className="text-xs px-2 py-0.5 rounded-md bg-surface-dark text-gray-500 border border-surface-hairline">
                          已保留原方案
                        </span>
                      )}
                    </div>
                  </div>

                  {/* 1. 感知与归纳证据栏（数据支撑） */}
                  <div className="bg-surface-dark rounded-lg p-2.5 space-y-1.5 text-xs border border-surface-hairline">
                    <div className="flex flex-wrap items-center justify-between gap-1.5 text-xs">
                      <span className="text-text-muted flex items-center gap-1 font-medium">
                        <BarChart3 className="w-3 h-3 text-primary" />
                        系统感知与归纳依据：
                      </span>
                      <span className="text-brand-orange font-mono font-medium bg-surface-darkest px-1.5 py-0.5 rounded border border-surface-hairline">
                        样本规模: {proposal.evidenceStats.sampleSize} 个真实 JD
                      </span>
                    </div>
                    <p className="text-text-secondary leading-relaxed text-xs">
                      {proposal.insight}
                    </p>
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 pt-1 text-xs font-mono">
                      <span className="text-text-muted">
                        历史指标: {proposal.evidenceStats.beforeValue}
                      </span>
                      <span className="text-primary font-medium">→ 预期表现: {proposal.evidenceStats.afterValue}</span>
                      <span className="text-success font-medium bg-surface-dark px-1 rounded border border-surface-hairline">
                        {proposal.evidenceStats.liftRate}
                      </span>
                    </div>
                  </div>

                  {/* 2. 策略变更对比（Before vs After） */}
                  <div className="space-y-1 text-xs">
                    <div className="text-xs font-medium text-text-secondary">
                      策略提议详情（Before vs After 对比）：
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div className="bg-rose-50/60 border border-rose-200 rounded-lg p-2 text-xs leading-relaxed">
                        <span className="text-rose-600 font-medium block mb-0.5">现有策略 / 关键词：</span>
                        <span className="text-text-secondary line-through">{proposal.diff.before}</span>
                      </div>
                      <div className="bg-surface-dark/80 border border-emerald-300 rounded-lg p-2 text-xs leading-relaxed">
                        <span className="text-success font-medium block mb-0.5">建议采纳方案：</span>
                        <strong className="text-emerald-900">{proposal.diff.after}</strong>
                      </div>
                    </div>
                  </div>

                  {/* 3. 严格安全护栏保障说明 */}
                  <div className="bg-surface-dark/40 border border-surface-hairline/60 rounded-lg p-2.5 text-xs text-blue-900 space-y-1.5">
                    <span className="font-medium flex items-center gap-1 text-blue-800">
                      <ShieldCheck className="w-3 h-3 text-info" />
                      克制执行承诺与严格安全护栏（Guardrails）：
                    </span>
                    <ul className="space-y-1 pl-1 text-xs leading-relaxed text-blue-800">
                      {proposal.guardrails.map((g, i) => (
                        <li key={i} className="flex items-start gap-1">
                          <span className="text-info">✓</span>
                          <span>{g}</span>
                        </li>
                      ))}
                    </ul>
                  </div>

                  {/* 4. 人做出战略抉择操作栏 */}
                  {isPending && (
                    <div className="flex items-center justify-end gap-2 pt-1 border-t border-surface-hairline">
                      <button
                        type="button"
                        onClick={() => handleRejectProposal(proposal.id)}
                        disabled={respondingId === proposal.id}
                        className="px-3 py-1.5 text-xs rounded-lg bg-surface-darkest border border-surface-hairline hover:bg-surface-medium text-text-secondary transition cursor-pointer"
                      >
                        拒绝并保留现方案
                      </button>
                      <button
                        type="button"
                        onClick={() => handleAcceptProposal(proposal.id)}
                        disabled={respondingId === proposal.id}
                        className="px-3.5 py-1.5 text-xs rounded-lg bg-primary text-white font-medium hover:bg-primary-light transition flex items-center gap-1 shadow-2xs cursor-pointer"
                      >
                        <Check className="w-3.5 h-3.5" />
                        同意并学习此策略
                      </button>
                    </div>
                  )}

                  {!isPending && proposal.humanDecisionNote && (
                    <div className="text-xs text-text-muted pt-1 border-t border-surface-hairline flex items-center justify-between">
                      <span>决策留痕：{proposal.humanDecisionNote}</span>
                      <span className="font-mono text-xs">{proposal.respondedAt?.slice(0, 16)}</span>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* 视图 3：今日策略与跟进建议 */}
      {subTab === 'strategy' && (
        <div className="space-y-4">
          {strategy && (
            <div className="rounded-xl border border-surface-hairline bg-black/[0.03] p-3.5 space-y-2.5">
              <div className="flex items-center gap-1.5 text-xs font-medium text-text-primary">
                <Bot className="w-3.5 h-3.5 text-primary-light" />
                今日管家沟通总编排
              </div>
              <p className="text-xs text-text-muted leading-relaxed">{strategy.summary}</p>
              <ul className="text-xs text-text-muted space-y-1">
                {strategy.priorities.map((priority, index) => (
                  <li key={index} className="flex gap-1.5">
                    <span className="text-primary-light">·</span>
                    {priority}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {review && (
            <div className="rounded-xl border border-surface-hairline bg-black/[0.03] p-3.5 space-y-2.5">
              <div className="flex items-center gap-1.5 text-xs font-medium text-text-primary">
                <BarChart3 className="w-3.5 h-3.5 text-primary-light" />
                周期复盘（{review.period}）
              </div>
              <div className="flex flex-wrap gap-1.5 text-xs">
                <span className="px-2 py-0.5 rounded-md bg-black/[0.05]">投递 {review.total}</span>
                <span className="px-2 py-0.5 rounded-md bg-black/[0.05]">已读 {review.funnel.read}</span>
                <span className="px-2 py-0.5 rounded-md bg-black/[0.05]">沟通 {review.funnel.communicating}</span>
                <span className="px-2 py-0.5 rounded-md bg-black/[0.05]">面试 {review.funnel.interview}</span>
                <span className="px-2 py-0.5 rounded-md bg-success/20 text-success font-medium">
                  回复率 {review.replyRate}%
                </span>
              </div>
              <ul className="text-xs text-text-muted space-y-1">
                {review.suggestions.slice(0, 3).map((suggestion, index) => (
                  <li key={index} className="flex gap-1.5">
                    <span className="text-primary-light">·</span>
                    {suggestion}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="rounded-xl border border-surface-hairline bg-black/[0.03] p-3.5 space-y-2.5">
            <div className="flex items-center gap-1.5 text-xs font-medium text-text-primary">
              <Sparkles className="w-3.5 h-3.5 text-primary-light" />
              跟进建议（已投递 N 天未回复，建议+确认）
            </div>
            {followUps.length === 0 ? (
              <p className="text-xs text-text-muted">暂无待跟进的投递。AIbot 将自动为您监控回复状态。</p>
            ) : (
              followUps.slice(0, 5).map((followUp) => (
                <div key={followUp.id} className="rounded-lg bg-surface-darkest border border-surface-hairline p-3 space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-medium text-text-primary">
                      {followUp.companyName} · {followUp.jobTitle}
                    </span>
                    <span className="text-xs text-warning whitespace-nowrap">
                      已 {followUp.daysSince} 天未回复
                    </span>
                  </div>
                  <p className="text-xs text-text-muted leading-relaxed">{followUp.draftMessage}</p>
                  <button
                    onClick={() => void dismissFollowUp(followUp.id)}
                    className="flex items-center gap-1 text-xs text-success hover:text-success cursor-pointer"
                  >
                    <CheckCircle2 className="w-3 h-3" /> 已处理
                  </button>
                </div>
              ))
            )}
          </div>

          <div className="rounded-xl border border-surface-hairline bg-black/[0.03] p-3.5 space-y-2.5">
            <div className="flex items-center gap-1.5 text-xs font-medium text-text-primary">
              <Bot className="w-3.5 h-3.5 text-primary-light" />
              最近战略抉择与留痕
            </div>
            {decisions.length === 0 ? (
              <p className="text-xs text-text-muted">暂无留痕记录。人机协同战略抉择会在此留痕，可复盘可追溯。</p>
            ) : (
              decisions.map((decision) => (
                <div key={decision.id} className="text-xs text-text-muted leading-relaxed border-b border-surface-hairline pb-1">
                  <span className="text-primary font-medium">{decision.source}</span> · {decision.subject}
                  <span className="block text-xs opacity-80">{decision.thinking}</span>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {/* 视图 4：异常与 Bug 留痕诊断中心 */}
      {subTab === 'errors' && (
        <div className="space-y-4">
          {/* 控制面板 */}
          <div className="flex flex-wrap items-center justify-between gap-3 p-3 rounded-xl bg-surface-dark border border-surface-hairline">
            <div className="flex items-center gap-2">
              <div className="w-6 h-6 rounded-md bg-red-100 text-danger flex items-center justify-center">
                <Bug className="w-3.5 h-3.5" />
              </div>
              <div>
                <div className="text-xs font-medium text-text-primary flex items-center gap-1.5">
                  异常留痕与诊断中心
                  <span className="text-xs font-mono px-1.5 py-0.5 rounded bg-surface-dark text-text-muted">
                    共 {errorRecords.length} 条记录
                  </span>
                </div>
                <div className="text-xs leading-snug text-text-muted">
                  自动记录投递执行、页面 DOM 提取、AI 通信全链路异常，留痕防丢
                </div>
              </div>
            </div>

            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={handleCopyErrors}
                disabled={errorRecords.length === 0}
                className="px-2 py-1 rounded-md text-xs bg-surface-darkest border border-surface-hairline hover:bg-surface-dark text-text-primary flex items-center gap-1 cursor-pointer disabled:opacity-40"
              >
                {copiedError ? <Check className="w-3 h-3 text-success" /> : <Copy className="w-3 h-3" />}
                {copiedError ? '已复制' : '复制诊断'}
              </button>
              <button
                type="button"
                onClick={handleClearErrors}
                disabled={errorRecords.length === 0}
                className="px-2 py-1 rounded-md text-xs bg-surface-darkest border border-surface-hairline hover:bg-surface-dark text-danger flex items-center gap-1 cursor-pointer disabled:opacity-40"
              >
                <Trash2 className="w-3 h-3" />
                清空
              </button>
              <button
                type="button"
                onClick={fetchErrors}
                className="p-1 rounded-md bg-surface-darkest border border-surface-hairline hover:bg-surface-dark text-text-muted cursor-pointer"
                title="刷新日志"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${loadingErrors ? 'animate-spin' : ''}`} />
              </button>
            </div>
          </div>

          {/* 筛选标签 */}
          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            <button
              type="button"
              onClick={() => setErrorFilter('all')}
              className={`px-2.5 py-1 rounded-md cursor-pointer transition ${
                errorFilter === 'all'
                  ? 'bg-primary text-white font-medium'
                  : 'bg-surface-dark text-text-muted hover:text-text-primary'
              }`}
            >
              全部 ({errorRecords.length})
            </button>
            <button
              type="button"
              onClick={() => setErrorFilter('boss')}
              className={`px-2.5 py-1 rounded-md cursor-pointer transition ${
                errorFilter === 'boss'
                  ? 'bg-primary text-white font-medium'
                  : 'bg-surface-dark text-text-muted hover:text-text-primary'
              }`}
            >
              Boss相关 ({errorRecords.filter((r) => r.source.toLowerCase().includes('boss')).length})
            </button>
            <button
              type="button"
              onClick={() => setErrorFilter('campaign')}
              className={`px-2.5 py-1 rounded-md cursor-pointer transition ${
                errorFilter === 'campaign'
                  ? 'bg-primary text-white font-medium'
                  : 'bg-surface-dark text-text-muted hover:text-text-primary'
              }`}
            >
              调度与通信 ({errorRecords.filter((r) => r.source.toLowerCase().includes('campaign')).length})
            </button>
            <button
              type="button"
              onClick={() => setErrorFilter('butler')}
              className={`px-2.5 py-1 rounded-md cursor-pointer transition ${
                errorFilter === 'butler'
                  ? 'bg-indigo-600 text-white font-medium'
                  : 'bg-surface-dark text-text-muted hover:text-text-primary'
              }`}
            >
              对话台 ({errorRecords.filter((r) => r.source.toLowerCase().includes('butler')).length})
            </button>
            <button
              type="button"
              onClick={() => setErrorFilter('other')}
              className={`px-2.5 py-1 rounded-md cursor-pointer transition ${
                errorFilter === 'other'
                  ? 'bg-primary text-white font-medium'
                  : 'bg-surface-dark text-text-muted hover:text-text-primary'
              }`}
            >
              其他
            </button>
          </div>

          {/* 列表渲染 */}
          {errorRecords.length === 0 ? (
            <div className="p-8 text-center rounded-xl bg-surface-dark border border-emerald-500/20 space-y-2">
              <div className="w-10 h-10 rounded-full bg-emerald-100 text-success mx-auto flex items-center justify-center">
                <CheckCircle2 className="w-5 h-5" />
              </div>
              <div className="text-xs font-medium text-text-primary">
                系统当前运行良好，暂无异常报错
              </div>
              <div className="text-xs text-text-muted max-w-xs mx-auto">
                当页面卡片未找到、按钮展开超时或通信失败时，AIbot 会将现场详细诊断自动在此留痕。
              </div>
            </div>
          ) : (
            <div className="space-y-2 max-h-[380px] overflow-y-auto pr-1">
              {errorRecords
                .filter((r) => {
                  if (errorFilter === 'boss') return r.source.toLowerCase().includes('boss')
                  if (errorFilter === 'campaign') return r.source.toLowerCase().includes('campaign')
                  if (errorFilter === 'butler') return r.source.toLowerCase().includes('butler')
                  if (errorFilter === 'other')
                    return (
                      !r.source.toLowerCase().includes('boss') &&
                      !r.source.toLowerCase().includes('campaign') &&
                      !r.source.toLowerCase().includes('butler')
                    )
                  return true
                })
                .map((record) => {
                  const isExpanded = expandedErrorId === record.id
                  return (
                    <div
                      key={record.id}
                      className="p-3 rounded-xl bg-surface-darkest border border-surface-hairline/60 shadow-2xs space-y-2"
                    >
                      <div className="flex items-center justify-between gap-1.5">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span
                            className={`px-1.5 py-0.5 rounded text-xs font-mono font-medium ${
                              record.source.includes('butler')
                                ? 'bg-indigo-100 text-indigo-700 border border-indigo-200'
                                : record.source.includes('boss')
                                ? 'bg-purple-100 text-purple-700 border border-purple-200'
                                : record.source.includes('campaign')
                                ? 'bg-blue-100 text-blue-700 border border-surface-hairline'
                                : 'bg-red-100 text-danger border border-surface-hairline'
                            }`}
                          >
                            {record.source}
                          </span>
                          <span className="text-xs text-text-muted font-mono">
                            {new Date(record.createdAt).toLocaleTimeString([], {
                              hour: '2-digit',
                              minute: '2-digit',
                              second: '2-digit',
                            })}
                          </span>
                        </div>
                        {record.stack && (
                          <button
                            type="button"
                            onClick={() => setExpandedErrorId(isExpanded ? null : record.id)}
                            className="text-xs text-primary hover:underline flex items-center gap-0.5 cursor-pointer"
                          >
                            {isExpanded ? '收起堆栈' : '详情堆栈'}
                            <ChevronDown
                              className={`w-3 h-3 transition-transform ${isExpanded ? 'rotate-180' : ''}`}
                            />
                          </button>
                        )}
                      </div>

                      <div className="text-xs font-medium text-danger leading-snug">
                        {record.message}
                      </div>

                      {record.context && (
                        <div className="p-2 rounded-md bg-surface-dark border border-surface-hairline text-xs font-mono text-text-muted break-all leading-relaxed">
                          <div className="text-xs uppercase tracking-wider text-text-muted/70 mb-1 font-medium">
                            Diagnostics Context:
                          </div>
                          {record.context}
                        </div>
                      )}

                      {isExpanded && record.stack && (
                        <pre className="p-2 rounded-md bg-zinc-900 text-zinc-300 text-xs font-mono overflow-x-auto whitespace-pre-wrap leading-tight">
                          {record.stack}
                        </pre>
                      )}
                    </div>
                  )
                })}
            </div>
          )}
        </div>
      )}

      {/* 视图 5：开发者待修清单（M4 · 自愈事件自动归因） */}
      {subTab === 'fixes' && (
        <div className="space-y-4">
          {/* 控制栏 */}
          <div className="flex flex-wrap items-center justify-between gap-3 p-3 rounded-xl bg-surface-dark border border-surface-hairline">
            <div className="flex items-center gap-2">
              <div className="w-6 h-6 rounded-md bg-amber-100 text-warning flex items-center justify-center">
                <Wrench className="w-3.5 h-3.5" />
              </div>
              <div>
                <div className="text-xs font-medium text-text-primary flex items-center gap-1.5">
                  开发者待修清单
                  <span className="text-xs font-mono px-1.5 py-0.5 rounded bg-surface-dark text-text-muted">
                    共 {fixSuggestions.length} 条建议
                  </span>
                </div>
                <div className="text-xs leading-snug text-text-muted">
                  基于运行时自愈/降级事件自动归因 · 按修复优先级排序
                </div>
              </div>
            </div>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={handleCopyFixesMarkdown}
                disabled={fixSuggestions.length === 0}
                className="px-2 py-1 rounded-md text-xs bg-surface-darkest border border-surface-hairline hover:bg-surface-dark text-text-primary flex items-center gap-1 cursor-pointer disabled:opacity-40"
                title="复制为 Markdown，可直接粘贴到 GitHub Issue"
              >
                {copiedFixes ? <Check className="w-3 h-3 text-success" /> : <Copy className="w-3 h-3" />}
                {copiedFixes ? '已复制' : '复制 Markdown'}
              </button>
              <button
                type="button"
                onClick={() => void fetchFixes()}
                className="p-1 rounded-md bg-surface-darkest border border-surface-hairline hover:bg-surface-dark text-text-muted cursor-pointer"
                title="刷新待修建议"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${loadingFixes ? 'animate-spin' : ''}`} />
              </button>
            </div>
          </div>

          {/* 空状态 */}
          {fixSuggestions.length === 0 ? (
            <div className="p-8 text-center rounded-xl bg-surface-dark border border-emerald-500/20 space-y-2">
              <div className="w-10 h-10 rounded-full bg-emerald-100 text-success mx-auto flex items-center justify-center">
                <CheckCircle2 className="w-5 h-5" />
              </div>
              <div className="text-xs font-medium text-text-primary">
                暂无待修项，选择器与降级链路运行正常
              </div>
              <div className="text-xs text-text-muted max-w-xs mx-auto">
                当系统触发卡片/按钮降级、拦截负面按钮或强制清除弹窗时，会自动在此聚合为可修复的建议。
              </div>
            </div>
          ) : (
            <div className="space-y-2 max-h-[400px] overflow-y-auto pr-1">
              {fixSuggestions.map((s) => {
                const style = FIX_PRIORITY_STYLE[s.priority] ?? FIX_PRIORITY_STYLE.low
                const isExpanded = expandedFixKey === s.key
                return (
                  <div
                    key={s.key}
                    className="p-3 rounded-xl bg-surface-darkest border border-surface-hairline shadow-2xs space-y-2"
                  >
                    <div className="flex items-center justify-between gap-1.5">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className={`px-1.5 py-0.5 rounded text-xs font-mono font-medium border ${style.badge}`}>
                          <span className={`inline-block w-1.5 h-1.5 rounded-full mr-1 ${style.dot}`} />
                          {style.label}
                        </span>
                        <span className="text-xs font-medium text-text-primary">{s.fixTitle}</span>
                      </div>
                      <span className="text-xs font-mono px-1.5 py-0.5 rounded bg-surface-dark text-danger border border-surface-hairline whitespace-nowrap">
                        {s.occurrences} 次
                      </span>
                    </div>

                    <div className="flex items-center gap-2 flex-wrap text-xs text-text-muted font-mono">
                      <span className="px-1 rounded bg-surface-dark">{s.platform}</span>
                      <span>{CATEGORY_LABELS[s.category] ?? s.category}</span>
                      <span>最近触发 {new Date(s.lastOccurredAt).toLocaleString()}</span>
                    </div>

                    <p className="text-xs text-text-secondary leading-relaxed">{s.fixDescription}</p>

                    {s.failedSelectors.length > 0 && (
                      <div className="p-2 rounded-md bg-surface-dark border border-surface-hairline text-xs font-mono text-text-muted break-all">
                        <div className="text-xs uppercase tracking-wider font-medium mb-1">
                          失败选择器
                        </div>
                        {s.failedSelectors.join(' · ')}
                      </div>
                    )}

                    <button
                      type="button"
                      onClick={() => setExpandedFixKey(isExpanded ? null : s.key)}
                      className="text-xs text-primary hover:underline flex items-center gap-0.5 cursor-pointer"
                    >
                      {isExpanded ? '收起详情' : '展开详情'}
                      <ChevronDown className={`w-3 h-3 transition-transform ${isExpanded ? 'rotate-180' : ''}`} />
                    </button>

                    {isExpanded && (
                      <div className="p-2 rounded-md bg-surface-dark border border-surface-hairline text-xs leading-relaxed text-text-muted space-y-1.5">
                        <div>
                          <strong className="text-text-secondary">按钮文本：</strong>
                          {s.buttonTexts.length > 0 ? s.buttonTexts.join(' / ') : '无'}
                        </div>
                        <div className="font-mono break-all">
                          <strong className="text-text-secondary">关联事件 ID：</strong>
                          {s.eventIds.join(', ')}
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
