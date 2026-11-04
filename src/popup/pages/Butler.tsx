import React, { useCallback, useEffect, useState } from 'react'
import {
  Bot,
  RefreshCw,
  CheckCircle2,
  Sparkles,
  BarChart3,
  Calendar,
  FileText,
  Clock,
  ShieldCheck,
  TrendingUp,
  Sliders,
  ChevronRight,
  Check,
  X,
  Copy,
  Zap,
  Target,
  AlertCircle,
  HelpCircle,
  Settings,
  Bug,
  Trash2,
  ChevronDown,
} from 'lucide-react'
import { buildStrategy, DEFAULT_DAILY_QUOTA } from '../../shared/agent/butler/butler-planner'
import { buildReview } from '../../shared/agent/butler/review-planner'
import { getActiveFollowUps, getRecentDecisions } from '../../shared/db/butler-store'
import { getAllApplications } from '../../shared/db/application-store'
import { getSetting } from '../../shared/db/settings-store'
import { log } from '../../shared/utils/logger'
import type { ButlerStrategy, FollowUpSuggestion, DecisionLog } from '../../shared/types/butler'
import type { ApplyFilters } from '../../shared/types/filters'
import type { ReviewResult } from '../../shared/agent/butler/review-planner'
import type { ButlerDailyReport, DailyReportConfig, EvolutionProposal } from '../../shared/types/butler-evolution'
import type { ErrorRecord } from '../../shared/db/index'
import ButlerChatView from '../components/ButlerChatView'

const MOD = 'ButlerTab'

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
  const [subTab, setSubTab] = useState<'chat' | 'daily_report' | 'evolution' | 'strategy' | 'decisions' | 'errors'>('chat')

  // 1. 日报状态
  const [dailyReport, setDailyReport] = useState<ButlerDailyReport | null>(null)
  const [loadingReport, setLoadingReport] = useState(false)
  const [generatingReport, setGeneratingReport] = useState(false)
  const [reportConfig, setReportConfig] = useState<DailyReportConfig | null>(null)
  const [showConfigModal, setShowConfigModal] = useState(false)
  const [scheduledTimeInput, setScheduledTimeInput] = useState('18:00')
  const [autoGenOnFinished, setAutoGenOnFinished] = useState(true)
  const [copiedMessage, setCopiedMessage] = useState(false)

  // 2. 进化提案状态
  const [proposals, setProposals] = useState<EvolutionProposal[]>([])
  const [loadingProposals, setLoadingProposals] = useState(false)
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
  const [errorFilter, setErrorFilter] = useState<'all' | 'boss' | 'campaign' | 'other'>('all')
  const [expandedErrorId, setExpandedErrorId] = useState<string | null>(null)
  const [copiedError, setCopiedError] = useState(false)

  // ─── 数据加载 ───

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
    void refreshBase()
  }, [fetchDailyReport, fetchProposals, fetchErrors, refreshBase])

  useEffect(() => {
    if (subTab === 'errors') {
      void fetchErrors()
    }
  }, [subTab, fetchErrors])

  // ─── 日报操作 ───

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
# 📋 求职管家 · 今日事后复盘日报 (${dailyReport.date})

> **战报综述**：${dailyReport.summary}

## 📊 投递漏斗概览
* **扫描职位**：${dailyReport.funnel.scanned} 个
* **AI 门槛筛除**：${dailyReport.funnel.filtered} 个
* **发起沟通**：${dailyReport.funnel.applied} 个
* **HR 互动/回复**：${dailyReport.funnel.read + dailyReport.funnel.communicating} 个
* **面试邀约**：${dailyReport.funnel.interview} 个
* **回复转化率**：${dailyReport.funnel.replyRate}%

## 🛡️ 安全护栏（Guardrails）与拟人保障
* **安全运行评分**：${dailyReport.guardrailStatus.safetyScore} / 100
* **拟人间歇区间**：${dailyReport.guardrailStatus.intervalRange} 随机延时
* **平台风控拦截**：${dailyReport.guardrailStatus.captchaEncounters} 次（已安全挂起）
* **护栏状态**：${dailyReport.guardrailStatus.safeStatusText}

## 🌟 今日高光
${dailyReport.highlights.map((h) => `- ${h}`).join('\n')}

## 🔍 诊断与归因
${dailyReport.diagnostics.map((d) => `- ${d}`).join('\n')}

## 🚀 明日作战指南
* **主攻岗位**：${dailyReport.nextDayActionPlan.focusTitles.join(' / ')}
* **黄金时段**：${dailyReport.nextDayActionPlan.recommendedHours}
* **建议配额**：${dailyReport.nextDayActionPlan.suggestedQuota} 份
`.trim()

    navigator.clipboard.writeText(md)
    setCopiedMessage(true)
    setTimeout(() => setCopiedMessage(false), 2000)
  }

  // ─── 进化提案操作（人做出战略抉择） ───

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
    <div className="p-3 space-y-3 text-text-primary">
      {/* 顶部标题与管家模式切换 */}
      <div className="flex items-center justify-between pb-1 border-b border-black/5">
        <div className="flex items-center gap-1.5">
          <div className="w-7 h-7 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center text-primary">
            <Bot className="w-4 h-4" />
          </div>
          <div>
            <h2 className="text-sm font-bold flex items-center gap-1">
              求职管家 Agent
              <span className="text-[10px] px-1.5 py-0.2 rounded bg-primary/10 text-primary border border-primary/20 font-medium">
                认知与自进化
              </span>
            </h2>
          </div>
          <button
            type="button"
            onClick={() => void runScan()}
            disabled={scanning}
            className="flex items-center gap-1 rounded-md bg-primary/10 hover:bg-primary/20 text-primary text-[10px] px-2 py-0.5 font-medium transition cursor-pointer disabled:opacity-50 ml-1 whitespace-nowrap"
          >
            <RefreshCw className={`w-3 h-3 ${scanning ? 'animate-spin' : ''}`} />
            {scanning ? '扫描中…' : '扫描跟进'}
          </button>
        </div>

        {/* 二级导航胶囊 */}
        <div className="flex items-center p-0.5 rounded-lg bg-surface-dark border border-black/5 text-[11px]">
          <button
            type="button"
            onClick={() => setSubTab('chat')}
            className={`px-2 py-1 rounded-md font-medium transition cursor-pointer flex items-center gap-1 ${
              subTab === 'chat'
                ? 'bg-white shadow-2xs text-primary font-bold'
                : 'text-text-muted hover:text-text-primary'
            }`}
          >
            <Bot className="w-3 h-3 text-orange-500" />
            对话中控
          </button>
          <button
            type="button"
            onClick={() => setSubTab('daily_report')}
            className={`px-2 py-1 rounded-md font-medium transition cursor-pointer flex items-center gap-1 ${
              subTab === 'daily_report'
                ? 'bg-white shadow-2xs text-primary'
                : 'text-text-muted hover:text-text-primary'
            }`}
          >
            <Calendar className="w-3 h-3" />
            管家日报
          </button>
          <button
            type="button"
            onClick={() => setSubTab('evolution')}
            className={`px-2 py-1 rounded-md font-medium transition cursor-pointer flex items-center gap-1 relative ${
              subTab === 'evolution'
                ? 'bg-white shadow-2xs text-primary'
                : 'text-text-muted hover:text-text-primary'
            }`}
          >
            <Sparkles className="w-3 h-3 text-brand-orange" />
            策略进化
            {pendingProposalsCount > 0 && (
              <span className="w-1.5 h-1.5 rounded-full bg-brand-orange animate-ping" />
            )}
          </button>
          <button
            type="button"
            onClick={() => setSubTab('strategy')}
            className={`px-2 py-1 rounded-md font-medium transition cursor-pointer flex items-center gap-1 ${
              subTab === 'strategy'
                ? 'bg-white shadow-2xs text-primary'
                : 'text-text-muted hover:text-text-primary'
            }`}
          >
            <Target className="w-3 h-3" />
            跟进与留痕
          </button>
          <button
            type="button"
            onClick={() => setSubTab('errors')}
            className={`px-2 py-1 rounded-md font-medium transition cursor-pointer flex items-center gap-1 ${
              subTab === 'errors'
                ? 'bg-white shadow-2xs text-red-600 font-bold'
                : 'text-text-muted hover:text-text-primary'
            }`}
          >
            <Bug className="w-3 h-3 text-red-500" />
            异常留痕
            {errorCount > 0 && (
              <span className="px-1 py-0.2 text-[9px] rounded-full bg-red-100 text-red-600 font-bold">
                {errorCount}
              </span>
            )}
          </button>
        </div>
      </div>

      {/* ─── 视图 0：对话即操作 · 智能中控台 ─── */}
      {subTab === 'chat' && <ButlerChatView />}

      {/* ─── 视图 1：事后复盘 · 管家日报 ─── */}
      {subTab === 'daily_report' && (
        <div className="space-y-3">
          {/* 日报控制栏与定时配置 */}
          <div className="flex items-center justify-between bg-surface-dark p-2 rounded-lg border border-black/5 text-xs">
            <div className="flex items-center gap-1.5">
              <Calendar className="w-3.5 h-3.5 text-primary" />
              <span className="font-semibold text-text-primary">
                {dailyReport?.date || '今日'} 投递复盘战报
              </span>
              <span className="text-[10px] text-emerald-600 bg-emerald-50 px-1.5 py-0.2 rounded border border-emerald-200">
                {dailyReport?.trigger === 'campaign_finished'
                  ? '跑毕自动生成'
                  : dailyReport?.trigger === 'scheduled'
                  ? '定时自动生成'
                  : '手动复盘'}
              </span>
            </div>

            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => setShowConfigModal(!showConfigModal)}
                className="text-[10px] text-text-muted hover:text-primary transition flex items-center gap-0.5 cursor-pointer px-1.5 py-0.5 rounded bg-white border border-black/10"
                title="修改每日自动生成时间"
              >
                <Clock className="w-2.5 h-2.5 text-primary" />
                定时: {reportConfig?.scheduledTime || '18:00'}
              </button>

              <button
                type="button"
                onClick={handleCopyReportMarkdown}
                className="text-[10px] text-text-muted hover:text-primary transition flex items-center gap-0.5 cursor-pointer px-1.5 py-0.5 rounded bg-white border border-black/10"
                title="一键复制 Markdown 格式战报"
              >
                {copiedMessage ? <Check className="w-2.5 h-2.5 text-emerald-600" /> : <Copy className="w-2.5 h-2.5" />}
                {copiedMessage ? '已复制' : '复制战报'}
              </button>

              <button
                type="button"
                onClick={handleManualGenerateReport}
                disabled={generatingReport}
                className="text-[10px] text-primary hover:bg-primary/10 transition flex items-center gap-0.5 cursor-pointer px-2 py-0.5 rounded bg-primary/5 border border-primary/20 font-medium disabled:opacity-50"
                title="重新生成并分析最新战报"
              >
                <RefreshCw className={`w-2.5 h-2.5 ${generatingReport ? 'animate-spin' : ''}`} />
                {generatingReport ? '复盘中...' : '重新复盘'}
              </button>
            </div>
          </div>

          {/* 定时生成设置浮层 */}
          {showConfigModal && (
            <div className="bg-surface-dark border border-black/10 rounded-lg p-2.5 text-xs space-y-2">
              <div className="flex items-center justify-between border-b border-black/5 pb-1">
                <span className="font-semibold text-text-primary flex items-center gap-1">
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
                <span className="text-[11px] text-text-secondary">每日定时生成时点：</span>
                <input
                  type="time"
                  value={scheduledTimeInput}
                  onChange={(e) => setScheduledTimeInput(e.target.value)}
                  className="px-2 py-0.5 rounded border border-black/10 bg-white text-xs outline-none focus:border-primary"
                />
              </div>

              <label className="flex items-center gap-1.5 text-[11px] text-text-secondary cursor-pointer">
                <input
                  type="checkbox"
                  checked={autoGenOnFinished}
                  onChange={(e) => setAutoGenOnFinished(e.target.checked)}
                  className="rounded text-primary focus:ring-0 w-3 h-3"
                />
                AIbot 当天全流程跑完/配额达成时立即自动复盘生成
              </label>

              <div className="flex justify-end gap-1.5 pt-1 border-t border-black/5">
                <button
                  type="button"
                  onClick={() => setShowConfigModal(false)}
                  className="px-2 py-0.5 rounded bg-white border border-black/10 text-[10px] text-text-secondary cursor-pointer"
                >
                  取消
                </button>
                <button
                  type="button"
                  onClick={handleSaveReportConfig}
                  className="px-2.5 py-0.5 rounded bg-primary text-white text-[10px] font-medium hover:bg-primary-light cursor-pointer"
                >
                  保存设置
                </button>
              </div>
            </div>
          )}

          {dailyReport ? (
            <>
              {/* 一句话宏观战报 */}
              <div className="rounded-xl border border-primary/20 bg-primary/5 p-3 space-y-1">
                <div className="flex items-center gap-1.5 text-xs font-semibold text-primary">
                  <Bot className="w-3.5 h-3.5" />
                  今日管家复盘综述
                </div>
                <p className="text-[11px] text-text-secondary leading-relaxed">
                  {dailyReport.summary}
                </p>
              </div>

              {/* 核心漏斗指标 */}
              <div className="grid grid-cols-4 gap-2 text-center bg-surface-dark p-2 rounded-lg border border-black/5">
                <div>
                  <div className="text-[10px] text-text-muted">扫描探测</div>
                  <div className="text-sm font-bold text-text-primary mt-0.5">
                    {dailyReport.funnel.scanned}
                  </div>
                </div>
                <div>
                  <div className="text-[10px] text-emerald-600 font-medium">发起沟通</div>
                  <div className="text-sm font-bold text-emerald-600 mt-0.5">
                    {dailyReport.funnel.applied}
                  </div>
                </div>
                <div>
                  <div className="text-[10px] text-sky-600">已读/互动</div>
                  <div className="text-sm font-bold text-sky-600 mt-0.5">
                    {dailyReport.funnel.read + dailyReport.funnel.communicating}
                  </div>
                </div>
                <div>
                  <div className="text-[10px] text-brand-orange font-medium">回复转化率</div>
                  <div className="text-sm font-bold text-brand-orange mt-0.5">
                    {dailyReport.funnel.replyRate}%
                  </div>
                </div>
              </div>

              {/* 严格安全护栏（Guardrails）与拟人保护达标证明 */}
              <div className="rounded-xl border border-emerald-200 bg-emerald-50/60 p-2.5 space-y-1.5 text-xs">
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-emerald-900 flex items-center gap-1">
                    <ShieldCheck className="w-4 h-4 text-emerald-600" />
                    严格安全护栏（Guardrails）达标运行
                  </span>
                  <span className="text-[10px] font-bold text-emerald-700 bg-white px-1.5 py-0.2 rounded border border-emerald-300">
                    安全得分: {dailyReport.guardrailStatus.safetyScore}/100
                  </span>
                </div>
                <div className="grid grid-cols-3 gap-1 text-[10px] text-emerald-800">
                  <div className="bg-white/80 p-1.5 rounded border border-emerald-100">
                    <span className="text-emerald-600 block">拟人间歇:</span>
                    <strong>{dailyReport.guardrailStatus.intervalRange}</strong>
                  </div>
                  <div className="bg-white/80 p-1.5 rounded border border-emerald-100">
                    <span className="text-emerald-600 block">风控拦截:</span>
                    <strong>{dailyReport.guardrailStatus.captchaEncounters} 次</strong>
                  </div>
                  <div className="bg-white/80 p-1.5 rounded border border-emerald-100">
                    <span className="text-emerald-600 block">账号安全度:</span>
                    <strong className="text-emerald-700">100% 极佳</strong>
                  </div>
                </div>
                <p className="text-[10px] text-emerald-700 mt-0.5">
                  ✓ {dailyReport.guardrailStatus.safeStatusText}
                </p>
              </div>

              {/* 各平台投递分布 */}
              <div className="rounded-lg border border-black/5 bg-surface-dark p-2.5 space-y-1.5 text-xs">
                <span className="text-[11px] font-semibold text-text-secondary block">
                  多平台投递与配额消耗分布
                </span>
                <div className="space-y-1">
                  {Object.entries(dailyReport.platformBreakdown).map(([pName, pData]) => (
                    <div key={pName} className="flex items-center justify-between text-[11px] bg-white p-1.5 rounded border border-black/5">
                      <span className="font-medium text-text-primary">{pName}</span>
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] text-text-muted">
                          沟通 {pData.applied} | 回复 {pData.replied}
                        </span>
                        <span className="text-[10px] font-mono text-primary bg-primary/5 px-1 rounded">
                          配额: {pData.quotaUsed}/{pData.quotaTotal}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* 今日高光亮点与问题诊断 */}
              <div className="grid grid-cols-1 gap-2">
                <div className="rounded-lg border border-black/5 bg-surface-dark p-2.5 space-y-1 text-xs">
                  <span className="text-[11px] font-semibold text-text-secondary flex items-center gap-1">
                    <Sparkles className="w-3.5 h-3.5 text-brand-orange" />
                    今日高光亮点
                  </span>
                  <ul className="text-[11px] text-text-muted space-y-1 pl-1">
                    {dailyReport.highlights.map((h, i) => (
                      <li key={i} className="flex items-start gap-1">
                        <span className="text-brand-orange shrink-0">·</span>
                        <span>{h}</span>
                      </li>
                    ))}
                  </ul>
                </div>

                <div className="rounded-lg border border-black/5 bg-surface-dark p-2.5 space-y-1 text-xs">
                  <span className="text-[11px] font-semibold text-text-secondary flex items-center gap-1">
                    <TrendingUp className="w-3.5 h-3.5 text-primary" />
                    问题诊断与归因
                  </span>
                  <ul className="text-[11px] text-text-muted space-y-1 pl-1">
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
              <div className="rounded-xl border border-primary/15 bg-primary/5 p-2.5 space-y-1 text-xs">
                <span className="text-[11px] font-semibold text-text-primary flex items-center gap-1">
                  <Target className="w-3.5 h-3.5 text-primary" />
                  明日作战行动指南
                </span>
                <div className="text-[10px] text-text-muted space-y-1">
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
                      <li key={i} className="flex items-start gap-1 text-[10px]">
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
              <Calendar className="w-8 h-8 text-black/20 mx-auto" />
              <p>今日尚无复盘日报，点击上方「重新复盘」或等待 AIbot 执行完毕后自动生成。</p>
            </div>
          )}
        </div>
      )}

      {/* ─── 视图 2：高级的进化 · 感知与进化策略中心 ─── */}
      {subTab === 'evolution' && (
        <div className="space-y-3">
          {/* 人机协同哲学导语卡片 */}
          <div className="rounded-xl border border-primary/20 bg-gradient-to-r from-primary/5 to-brand-orange/5 p-3 space-y-1.5 text-xs">
            <div className="flex items-center justify-between">
              <span className="font-bold text-[12px] text-text-primary flex items-center gap-1">
                <Sparkles className="w-4 h-4 text-brand-orange" />
                认知自进化闭环 · 战略抉择中心
              </span>
              <button
                type="button"
                onClick={handleRunInduction}
                disabled={analyzingInduction}
                className="text-[10px] text-primary bg-white border border-primary/30 hover:bg-primary/10 px-2 py-0.5 rounded transition flex items-center gap-1 cursor-pointer disabled:opacity-50"
                title="深度分析海量 JD 与真实回复规律"
              >
                <RefreshCw className={`w-2.5 h-2.5 ${analyzingInduction ? 'animate-spin' : ''}`} />
                {analyzingInduction ? '感知归纳中...' : '重新感知归纳'}
              </button>
            </div>
            <p className="text-[11px] text-text-muted leading-relaxed">
              <strong>系统负责感知与归纳</strong>（深度收集海量岗位 JD 与沟通数据，提炼高回复率特征）；
              <strong>系统向人汇报洞察并提出策略选项</strong>；
              <strong>人做出战略抉择</strong>，系统在严格的<strong>安全护栏（Guardrails）</strong>与拟人策略下克制地执行。
            </p>
          </div>

          {/* 提案过滤筛选 */}
          <div className="flex items-center justify-between text-xs">
            <div className="flex items-center gap-1 text-[11px]">
              <span className="text-text-muted">筛选：</span>
              {(['all', 'pending', 'accepted'] as const).map((f) => (
                <button
                  key={f}
                  type="button"
                  onClick={() => setProposalFilter(f)}
                  className={`px-2 py-0.5 rounded text-[10px] transition cursor-pointer ${
                    proposalFilter === f
                      ? 'bg-primary text-white font-medium'
                      : 'bg-surface-dark text-text-muted hover:text-text-primary'
                  }`}
                >
                  {f === 'all' ? '全部' : f === 'pending' ? '待战略抉择' : '已采纳'}
                </button>
              ))}
            </div>
            <span className="text-[10px] text-text-muted">
              共 {filteredProposals.length} 项进化提案
            </span>
          </div>

          {/* 进化提案列表 */}
          <div className="space-y-3">
            {filteredProposals.map((proposal) => {
              const isPending = proposal.status === 'pending'
              const isAccepted = proposal.status === 'accepted'
              const isRejected = proposal.status === 'rejected'

              return (
                <div
                  key={proposal.id}
                  className={`rounded-xl border p-3 space-y-2.5 transition-all text-xs ${
                    isPending
                      ? 'border-primary/30 bg-white shadow-xs'
                      : isAccepted
                      ? 'border-emerald-200 bg-emerald-50/30'
                      : 'border-black/5 bg-gray-50/70 opacity-60'
                  }`}
                >
                  {/* 提案头部与分类 */}
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-[12px] text-text-primary flex items-center gap-1.5">
                      <span className="text-[10px] px-1.5 py-0.2 rounded font-medium bg-brand-orange/10 text-brand-orange border border-brand-orange/20">
                        {proposal.categoryBadge}
                      </span>
                      {proposal.title}
                    </span>

                    {/* 状态徽章 */}
                    <div>
                      {isPending && (
                        <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-300 font-semibold animate-pulse">
                          等待您的战略抉择
                        </span>
                      )}
                      {isAccepted && (
                        <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-300 font-medium flex items-center gap-0.5">
                          <Check className="w-3 h-3 text-emerald-600" />
                          已采纳并写入记忆
                        </span>
                      )}
                      {isRejected && (
                        <span className="text-[10px] px-2 py-0.5 rounded-full bg-gray-100 text-gray-500 border border-black/10">
                          已保留原方案
                        </span>
                      )}
                    </div>
                  </div>

                  {/* 1. 感知与归纳证据栏（数据支撑） */}
                  <div className="bg-surface-dark rounded-lg p-2 space-y-1 text-[11px] border border-black/5">
                    <div className="flex items-center justify-between text-[10px]">
                      <span className="text-text-muted flex items-center gap-1 font-semibold">
                        <BarChart3 className="w-3 h-3 text-primary" />
                        系统感知与归纳依据：
                      </span>
                      <span className="text-brand-orange font-mono font-bold bg-white px-1.5 py-0.2 rounded border border-black/5">
                        样本规模: {proposal.evidenceStats.sampleSize} 个真实 JD
                      </span>
                    </div>
                    <p className="text-text-secondary leading-relaxed text-[11px]">
                      {proposal.insight}
                    </p>
                    <div className="flex items-center gap-2 pt-1 text-[10px] font-mono">
                      <span className="text-text-muted">
                        历史指标: {proposal.evidenceStats.beforeValue}
                      </span>
                      <span className="text-primary font-bold">→ 预期表现: {proposal.evidenceStats.afterValue}</span>
                      <span className="text-emerald-600 font-bold bg-emerald-50 px-1 rounded border border-emerald-200">
                        {proposal.evidenceStats.liftRate}
                      </span>
                    </div>
                  </div>

                  {/* 2. 策略变更对比（Before vs After） */}
                  <div className="space-y-1 text-[11px]">
                    <div className="text-[10px] font-semibold text-text-secondary">
                      策略提议详情（Before vs After 对比）：
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div className="bg-rose-50/60 border border-rose-200 rounded p-1.5 text-[10px]">
                        <span className="text-rose-600 font-semibold block mb-0.5">现有策略 / 关键词：</span>
                        <span className="text-text-secondary line-through">{proposal.diff.before}</span>
                      </div>
                      <div className="bg-emerald-50/80 border border-emerald-300 rounded p-1.5 text-[10px]">
                        <span className="text-emerald-700 font-bold block mb-0.5">建议采纳方案：</span>
                        <strong className="text-emerald-900">{proposal.diff.after}</strong>
                      </div>
                    </div>
                  </div>

                  {/* 3. 严格安全护栏保障说明 */}
                  <div className="bg-blue-50/40 border border-blue-200/60 rounded-lg p-2 text-[10px] text-blue-900 space-y-1">
                    <span className="font-semibold flex items-center gap-1 text-blue-800">
                      <ShieldCheck className="w-3 h-3 text-blue-600" />
                      克制执行承诺与严格安全护栏（Guardrails）：
                    </span>
                    <ul className="space-y-0.5 pl-1 text-[10px] text-blue-800">
                      {proposal.guardrails.map((g, i) => (
                        <li key={i} className="flex items-start gap-1">
                          <span className="text-blue-500">✓</span>
                          <span>{g}</span>
                        </li>
                      ))}
                    </ul>
                  </div>

                  {/* 4. 人做出战略抉择操作栏 */}
                  {isPending && (
                    <div className="flex items-center justify-end gap-2 pt-1 border-t border-black/5">
                      <button
                        type="button"
                        onClick={() => handleRejectProposal(proposal.id)}
                        disabled={respondingId === proposal.id}
                        className="px-2.5 py-1 text-[11px] rounded bg-white border border-black/10 hover:bg-surface-medium text-text-secondary transition cursor-pointer"
                      >
                        拒绝并保留现方案
                      </button>
                      <button
                        type="button"
                        onClick={() => handleAcceptProposal(proposal.id)}
                        disabled={respondingId === proposal.id}
                        className="px-3.5 py-1 text-[11px] rounded bg-primary text-white font-medium hover:bg-primary-light transition flex items-center gap-1 shadow-2xs cursor-pointer"
                      >
                        <Check className="w-3.5 h-3.5" />
                        同意并学习此策略
                      </button>
                    </div>
                  )}

                  {!isPending && proposal.humanDecisionNote && (
                    <div className="text-[10px] text-text-muted pt-1 border-t border-black/5 flex items-center justify-between">
                      <span>决策留痕：{proposal.humanDecisionNote}</span>
                      <span className="font-mono text-[9px]">{proposal.respondedAt?.slice(0, 16)}</span>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* ─── 视图 3：今日策略与跟进建议 ─── */}
      {subTab === 'strategy' && (
        <div className="space-y-3">
          {strategy && (
            <div className="rounded-xl border border-black/10 bg-black/[0.03] p-3 space-y-2">
              <div className="flex items-center gap-1.5 text-xs font-semibold text-text-primary">
                <Bot className="w-3.5 h-3.5 text-primary-light" />
                今日管家沟通总编排
              </div>
              <p className="text-[11px] text-text-muted leading-relaxed">{strategy.summary}</p>
              <ul className="text-[11px] text-text-muted space-y-1">
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
            <div className="rounded-xl border border-black/10 bg-black/[0.03] p-3 space-y-2">
              <div className="flex items-center gap-1.5 text-xs font-semibold text-text-primary">
                <BarChart3 className="w-3.5 h-3.5 text-primary-light" />
                周期复盘（{review.period}）
              </div>
              <div className="flex flex-wrap gap-1.5 text-[11px]">
                <span className="px-2 py-0.5 rounded-full bg-black/[0.05]">投递 {review.total}</span>
                <span className="px-2 py-0.5 rounded-full bg-black/[0.05]">已读 {review.funnel.read}</span>
                <span className="px-2 py-0.5 rounded-full bg-black/[0.05]">沟通 {review.funnel.communicating}</span>
                <span className="px-2 py-0.5 rounded-full bg-black/[0.05]">面试 {review.funnel.interview}</span>
                <span className="px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-600 font-medium">
                  回复率 {review.replyRate}%
                </span>
              </div>
              <ul className="text-[11px] text-text-muted space-y-1">
                {review.suggestions.slice(0, 3).map((suggestion, index) => (
                  <li key={index} className="flex gap-1.5">
                    <span className="text-primary-light">·</span>
                    {suggestion}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="rounded-xl border border-black/10 bg-black/[0.03] p-3 space-y-2">
            <div className="flex items-center gap-1.5 text-xs font-semibold text-text-primary">
              <Sparkles className="w-3.5 h-3.5 text-primary-light" />
              跟进建议（已投递 N 天未回复，建议+确认）
            </div>
            {followUps.length === 0 ? (
              <p className="text-[11px] text-text-muted">暂无待跟进的投递。AIbot 将自动为您监控回复状态。</p>
            ) : (
              followUps.slice(0, 5).map((followUp) => (
                <div key={followUp.id} className="rounded-lg bg-white border border-black/10 p-2.5 space-y-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-medium text-text-primary">
                      {followUp.companyName} · {followUp.jobTitle}
                    </span>
                    <span className="text-[10px] text-amber-500 whitespace-nowrap">
                      已 {followUp.daysSince} 天未回复
                    </span>
                  </div>
                  <p className="text-[11px] text-text-muted leading-relaxed">{followUp.draftMessage}</p>
                  <button
                    onClick={() => void dismissFollowUp(followUp.id)}
                    className="flex items-center gap-1 text-[11px] text-emerald-600 hover:text-emerald-700 cursor-pointer"
                  >
                    <CheckCircle2 className="w-3 h-3" /> 已处理
                  </button>
                </div>
              ))
            )}
          </div>

          <div className="rounded-xl border border-black/10 bg-black/[0.03] p-3 space-y-2">
            <div className="flex items-center gap-1.5 text-xs font-semibold text-text-primary">
              <Bot className="w-3.5 h-3.5 text-primary-light" />
              最近战略抉择与留痕
            </div>
            {decisions.length === 0 ? (
              <p className="text-[11px] text-text-muted">暂无留痕记录。人机协同战略抉择会在此留痕，可复盘可追溯。</p>
            ) : (
              decisions.map((decision) => (
                <div key={decision.id} className="text-[11px] text-text-muted leading-relaxed border-b border-black/5 pb-1">
                  <span className="text-primary font-medium">{decision.source}</span> · {decision.subject}
                  <span className="block text-[10px] opacity-80">{decision.thinking}</span>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {/* ─── 视图 4：异常与 Bug 留痕诊断中心 ─── */}
      {subTab === 'errors' && (
        <div className="space-y-3">
          {/* 控制面板 */}
          <div className="flex items-center justify-between p-2.5 rounded-xl bg-surface-dark border border-black/5">
            <div className="flex items-center gap-2">
              <div className="w-6 h-6 rounded-md bg-red-100 text-red-600 flex items-center justify-center">
                <Bug className="w-3.5 h-3.5" />
              </div>
              <div>
                <div className="text-xs font-bold text-text-primary flex items-center gap-1.5">
                  异常留痕与诊断中心
                  <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-black/5 text-text-muted">
                    共 {errorRecords.length} 条记录
                  </span>
                </div>
                <div className="text-[10px] text-text-muted">
                  自动记录投递执行、页面 DOM 提取、AI 通信全链路异常，留痕防丢
                </div>
              </div>
            </div>

            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={handleCopyErrors}
                disabled={errorRecords.length === 0}
                className="px-2 py-1 rounded-md text-[11px] bg-white border border-black/10 hover:bg-black/5 text-text-primary flex items-center gap-1 cursor-pointer disabled:opacity-40"
              >
                {copiedError ? <Check className="w-3 h-3 text-emerald-500" /> : <Copy className="w-3 h-3" />}
                {copiedError ? '已复制' : '复制诊断'}
              </button>
              <button
                type="button"
                onClick={handleClearErrors}
                disabled={errorRecords.length === 0}
                className="px-2 py-1 rounded-md text-[11px] bg-white border border-red-200 hover:bg-red-50 text-red-600 flex items-center gap-1 cursor-pointer disabled:opacity-40"
              >
                <Trash2 className="w-3 h-3" />
                清空
              </button>
              <button
                type="button"
                onClick={fetchErrors}
                className="p-1 rounded-md bg-white border border-black/10 hover:bg-black/5 text-text-muted cursor-pointer"
                title="刷新日志"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${loadingErrors ? 'animate-spin' : ''}`} />
              </button>
            </div>
          </div>

          {/* 筛选标签 */}
          <div className="flex items-center gap-1 text-[11px]">
            <button
              type="button"
              onClick={() => setErrorFilter('all')}
              className={`px-2 py-0.5 rounded-full cursor-pointer transition ${
                errorFilter === 'all'
                  ? 'bg-primary text-white font-medium'
                  : 'bg-black/5 text-text-muted hover:text-text-primary'
              }`}
            >
              全部 ({errorRecords.length})
            </button>
            <button
              type="button"
              onClick={() => setErrorFilter('boss')}
              className={`px-2 py-0.5 rounded-full cursor-pointer transition ${
                errorFilter === 'boss'
                  ? 'bg-primary text-white font-medium'
                  : 'bg-black/5 text-text-muted hover:text-text-primary'
              }`}
            >
              Boss相关 ({errorRecords.filter((r) => r.source.toLowerCase().includes('boss')).length})
            </button>
            <button
              type="button"
              onClick={() => setErrorFilter('campaign')}
              className={`px-2 py-0.5 rounded-full cursor-pointer transition ${
                errorFilter === 'campaign'
                  ? 'bg-primary text-white font-medium'
                  : 'bg-black/5 text-text-muted hover:text-text-primary'
              }`}
            >
              调度与通信 ({errorRecords.filter((r) => r.source.toLowerCase().includes('campaign')).length})
            </button>
            <button
              type="button"
              onClick={() => setErrorFilter('other')}
              className={`px-2 py-0.5 rounded-full cursor-pointer transition ${
                errorFilter === 'other'
                  ? 'bg-primary text-white font-medium'
                  : 'bg-black/5 text-text-muted hover:text-text-primary'
              }`}
            >
              其他
            </button>
          </div>

          {/* 列表渲染 */}
          {errorRecords.length === 0 ? (
            <div className="p-8 text-center rounded-xl bg-surface-dark border border-emerald-500/20 space-y-2">
              <div className="w-10 h-10 rounded-full bg-emerald-100 text-emerald-600 mx-auto flex items-center justify-center">
                <CheckCircle2 className="w-5 h-5" />
              </div>
              <div className="text-xs font-semibold text-text-primary">
                系统当前运行良好，暂无异常报错
              </div>
              <div className="text-[11px] text-text-muted max-w-xs mx-auto">
                当页面卡片未找到、按钮展开超时或通信失败时，AIbot 会将现场详细诊断自动在此留痕。
              </div>
            </div>
          ) : (
            <div className="space-y-2 max-h-[380px] overflow-y-auto pr-1">
              {errorRecords
                .filter((r) => {
                  if (errorFilter === 'boss') return r.source.toLowerCase().includes('boss')
                  if (errorFilter === 'campaign') return r.source.toLowerCase().includes('campaign')
                  if (errorFilter === 'other')
                    return (
                      !r.source.toLowerCase().includes('boss') &&
                      !r.source.toLowerCase().includes('campaign')
                    )
                  return true
                })
                .map((record) => {
                  const isExpanded = expandedErrorId === record.id
                  return (
                    <div
                      key={record.id}
                      className="p-2.5 rounded-xl bg-white border border-red-200/60 shadow-2xs space-y-1.5"
                    >
                      <div className="flex items-center justify-between gap-1.5">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span
                            className={`px-1.5 py-0.5 rounded text-[10px] font-mono font-medium ${
                              record.source.includes('boss')
                                ? 'bg-purple-100 text-purple-700 border border-purple-200'
                                : record.source.includes('campaign')
                                ? 'bg-blue-100 text-blue-700 border border-blue-200'
                                : 'bg-red-100 text-red-700 border border-red-200'
                            }`}
                          >
                            {record.source}
                          </span>
                          <span className="text-[10px] text-text-muted font-mono">
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
                            className="text-[10px] text-primary hover:underline flex items-center gap-0.5 cursor-pointer"
                          >
                            {isExpanded ? '收起堆栈' : '详情堆栈'}
                            <ChevronDown
                              className={`w-3 h-3 transition-transform ${isExpanded ? 'rotate-180' : ''}`}
                            />
                          </button>
                        )}
                      </div>

                      <div className="text-[11px] font-medium text-red-600 leading-snug">
                        {record.message}
                      </div>

                      {record.context && (
                        <div className="p-1.5 rounded-md bg-surface-dark border border-black/5 text-[10px] font-mono text-text-muted break-all leading-normal">
                          <div className="text-[9px] uppercase tracking-wider text-text-muted/70 mb-0.5 font-bold">
                            Diagnostics Context:
                          </div>
                          {record.context}
                        </div>
                      )}

                      {isExpanded && record.stack && (
                        <pre className="p-2 rounded-md bg-zinc-900 text-zinc-300 text-[9px] font-mono overflow-x-auto whitespace-pre-wrap leading-tight">
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
    </div>
  )
}
