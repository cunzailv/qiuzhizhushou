// AIbot 全自动投递控制面板与每时每刻行为日志终端

import React, { useState, useEffect, useCallback, useRef } from 'react'
import {
  Play,
  Pause,
  RotateCw,
  Square,
  AlertTriangle,
  Coffee,
  Clock,
  Sparkles,
  Bot,
  Terminal,
  Edit2,
  ChevronDown,
  ChevronUp,
  Save,
  X,
  Trash2,
} from 'lucide-react'
import type { CampaignStats } from '../../shared/agent/campaign'
import type { PlatformId, TimeWindow, IntervalConfig } from '../../shared/agent/quota'
import {
  DEFAULT_WINDOWS,
  DEFAULT_INTERVAL_CONFIG,
  DEFAULT_PLATFORM_QUOTAS,
  MIN_PLATFORM_QUOTA,
  MAX_PLATFORM_QUOTA,
  formatTimeWindows,
  getSavedTimeWindows,
  saveTimeWindows,
  parseTimeString,
  getSavedIntervalConfig,
  saveIntervalConfig,
  getSavedPlatformQuotas,
  savePlatformQuotas,
  resetPlatformQuotas,
} from '../../shared/agent/quota'
import type { PlatformAuthInfo } from '../../shared/platform/auth-checker'
import { PLATFORM_LOGIN_URLS } from '../../shared/platform/auth-checker'
import { getSetting, setSetting } from '../../shared/db/settings-store'
import { persistSharedFilters } from '../../shared/agent/filter-config'
import {
  DEFAULT_ASSISTANT_STATE,
  getAssistantState,
  subscribeAssistantState,
  type AssistantControlState,
  type PanelState,
} from '../../shared/assistant-state'
import {
  DEFAULT_RUNTIME_STATE,
  getRuntimeState,
  subscribeRuntimeState,
  type AssistantRuntimeState,
} from '../../shared/runtime-state'

const PLATFORM_INFOS: Array<{ id: PlatformId; name: string; icon: string }> = [
  { id: 'boss', name: 'Boss直聘', icon: '💼' },
  { id: 'liepin', name: '猎聘', icon: '👔' },
  { id: 'zhaopin', name: '智联招聘', icon: '🏢' },
  { id: '51job', name: '前程无忧', icon: '📮' },
  { id: 'maimai', name: '脉脉', icon: '👥' },
]

interface CampaignPanelProps {
  onNotify?: (msg: string, type: 'success' | 'warning' | 'error' | 'info') => void
  onNavigateTab?: (tab: string) => void
}

export const CampaignPanel: React.FC<CampaignPanelProps> = ({ onNotify, onNavigateTab }) => {
  const [stats, setStats] = useState<CampaignStats | null>(null)
  const [assistant, setAssistant] = useState<AssistantControlState>(DEFAULT_ASSISTANT_STATE)
  const [runtime, setRuntime] = useState<AssistantRuntimeState>(DEFAULT_RUNTIME_STATE)
  const [loading, setLoading] = useState(false)

  // 悬浮窗配置：与页面浮窗、后台调度共享同一份状态
  useEffect(() => {
    getAssistantState().then(setAssistant).catch(() => {})
    return subscribeAssistantState(setAssistant)
  }, [])

  // 全局运行锁：概览半自动运行时，全自动入口必须禁用
  useEffect(() => {
    getRuntimeState().then(setRuntime).catch(() => {})
    return subscribeRuntimeState(setRuntime)
  }, [])

  const updateAssistant = useCallback(async (patch: Partial<AssistantControlState>) => {
    setAssistant((prev) => ({ ...prev, ...patch }))
    try {
      const res = (await chrome.runtime.sendMessage({
        type: 'ASSISTANT_CONTROL',
        payload: { action: 'patch', patch },
      })) as { data?: AssistantControlState }
      if (res?.data) setAssistant(res.data)
    } catch { /* 预期内异常，安全忽略 */ }
  }, [])

  const handlePanelState = useCallback(async (state: PanelState) => {
    if (state === 'closed') {
      setAssistant((prev) => ({ ...prev, panelState: 'closed' }))
      try {
        await chrome.runtime.sendMessage({
          type: 'ASSISTANT_CONTROL',
          payload: { action: 'shutdown' },
        })
      } catch { /* 预期内异常，安全忽略 */ }
      return
    }
    await updateAssistant({ panelState: state })
  }, [updateAssistant])

  /** AI 评分开关：写 assistant-state 单一真源 + 共享筛选配置（概览会实时同步） */
  const handleAiMatchChange = useCallback((enabled: boolean) => {
    void updateAssistant({ enableAiMatch: enabled })
    void persistSharedFilters({ enableAiMatch: enabled }).catch(() => {})
  }, [updateAssistant])

  const [collectingJobs, setCollectingJobs] = useState(false)
  const [clearingPending, setClearingPending] = useState(false)
  const [enabledPlatforms, setEnabledPlatforms] = useState<Record<PlatformId, boolean>>({
    boss: true,
    liepin: true,
    zhaopin: false,
    '51job': false,
    maimai: false,
  })

  // 平台登录与授权状态
  const [authInfo, setAuthInfo] = useState<Record<PlatformId, PlatformAuthInfo> | null>(null)
  const [checkingAuth, setCheckingAuth] = useState(false)

  // 时段自定义相关状态
  const [timeWindows, setTimeWindows] = useState<TimeWindow[]>(DEFAULT_WINDOWS)
  const [showTimeEditor, setShowTimeEditor] = useState(false)
  const [start1, setStart1] = useState('09:00')
  const [end1, setEnd1] = useState('11:30')
  const [enableSecondWindow, setEnableSecondWindow] = useState(true)
  const [start2, setStart2] = useState('14:00')
  const [end2, setEnd2] = useState('17:30')

  // 拟人间歇自定义相关状态
  const [intervalConfig, setIntervalConfig] = useState<IntervalConfig>(DEFAULT_INTERVAL_CONFIG)
  const [showIntervalEditor, setShowIntervalEditor] = useState(false)
  const [minSecInput, setMinSecInput] = useState('45')
  const [maxSecInput, setMaxSecInput] = useState('180')

  // 各平台投递数量：可直接在平台行内编辑，持久化后运行中即时生效
  const [platformQuotas, setPlatformQuotas] = useState<Record<PlatformId, number>>({
    ...DEFAULT_PLATFORM_QUOTAS,
  })
  const [editingQuota, setEditingQuota] = useState<PlatformId | null>(null)
  const [quotaInput, setQuotaInput] = useState('')
  const cancelQuotaEditRef = useRef(false)

  const [logExpanded, setLogExpanded] = useState(true)
  const logContainerRef = useRef<HTMLDivElement>(null)

  // 检查各平台登录授权状态
  const checkAuth = useCallback(async () => {
    try {
      setCheckingAuth(true)
      const res = (await chrome.runtime.sendMessage({ type: 'CHECK_PLATFORMS_AUTH' })) as {
        success: boolean
        data?: Record<PlatformId, PlatformAuthInfo>
      }
      if (res?.success && res.data) {
        setAuthInfo(res.data)
      }
    } catch {
      // 忽略
    } finally {
      setCheckingAuth(false)
    }
  }, [])

  // 1. 初始化读取本地保存的开启平台、时段偏好与拟人间歇
  useEffect(() => {
    ;(async () => {
      try {
        const savedPlatforms = await getSetting<Record<string, boolean>>('aibot_enabled_platforms', {
          boss: true,
          liepin: true,
          zhaopin: false,
          '51job': false,
          maimai: false,
        })
        if (savedPlatforms) {
          setEnabledPlatforms((prev) => ({ ...prev, ...(savedPlatforms as any) }))
        }

        const savedWindows = await getSavedTimeWindows()
        setTimeWindows(savedWindows)
        if (savedWindows.length > 0) {
          setStart1(
            `${String(savedWindows[0].startHour).padStart(2, '0')}:${String(savedWindows[0].startMin).padStart(2, '0')}`,
          )
          setEnd1(
            `${String(savedWindows[0].endHour).padStart(2, '0')}:${String(savedWindows[0].endMin).padStart(2, '0')}`,
          )
          if (savedWindows.length > 1) {
            setEnableSecondWindow(true)
            setStart2(
              `${String(savedWindows[1].startHour).padStart(2, '0')}:${String(savedWindows[1].startMin).padStart(2, '0')}`,
            )
            setEnd2(
              `${String(savedWindows[1].endHour).padStart(2, '0')}:${String(savedWindows[1].endMin).padStart(2, '0')}`,
            )
          } else {
            setEnableSecondWindow(false)
          }
        }

        const savedInterval = await getSavedIntervalConfig()
        setIntervalConfig(savedInterval)
        setMinSecInput(String(savedInterval.minSeconds))
        setMaxSecInput(String(savedInterval.maxSeconds))

        const savedQuotas = await getSavedPlatformQuotas()
        setPlatformQuotas(savedQuotas)
      } catch {
        // 使用默认值
      }
    })()

    checkAuth()
  }, [checkAuth])

  // 2. 轮询获取统计数据与实时流水日志
  const fetchStats = useCallback(async () => {
    try {
      const res = (await chrome.runtime.sendMessage({ type: 'GET_CAMPAIGN_STATS' })) as {
        success: boolean
        data?: CampaignStats
      }
      if (res?.success && res.data) {
        setStats(res.data)
        // 同步后台各平台的 enabled 状态到本地
        if (res.data.platformBreakdown) {
          setEnabledPlatforms((prev) => {
            const next = { ...prev }
            for (const pid of Object.keys(res.data!.platformBreakdown) as PlatformId[]) {
              if (res.data!.platformBreakdown[pid]?.enabled !== undefined) {
                next[pid] = res.data!.platformBreakdown[pid].enabled
              }
            }
            return next
          })
        }
        if (res.data.intervalConfig) {
          setIntervalConfig(res.data.intervalConfig)
        }
      } else {
        setStats(null)
      }
    } catch {
      // 忽略通信错误
    }
  }, [])

  useEffect(() => {
    fetchStats()
    const timer = setInterval(fetchStats, 2000)
    return () => clearInterval(timer)
  }, [fetchStats])

  // 3. 自动滚动日志到最新底部
  useEffect(() => {
    if (logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight
    }
  }, [stats?.logs])

  // 切换平台开关
  const handleTogglePlatform = async (platform: PlatformId) => {
    const nextState = !enabledPlatforms[platform]
    const updated = { ...enabledPlatforms, [platform]: nextState }
    setEnabledPlatforms(updated)
    await setSetting('aibot_enabled_platforms', updated)

    if (stats) {
      try {
        await chrome.runtime.sendMessage({
          type: 'TOGGLE_PLATFORM',
          payload: { platform, enabled: nextState },
        })
        await fetchStats()
      } catch {
        // 忽略
      }
    }
  }

  /**
   * 修改单个平台的投递数量。
   * 同时写本地持久化与通知后台：面板数字、campaign 计划上限、每日风控上限三处一起生效。
   */
  const commitQuota = async (id: PlatformId, raw: string) => {
    setEditingQuota(null)
    const value = parseInt(raw, 10)
    if (!Number.isFinite(value) || value < MIN_PLATFORM_QUOTA || value > MAX_PLATFORM_QUOTA) {
      onNotify?.(`投递数量需为 ${MIN_PLATFORM_QUOTA}-${MAX_PLATFORM_QUOTA} 之间的整数`, 'warning')
      return
    }
    if (platformQuotas[id] === value) return

    const next = { ...platformQuotas, [id]: value }
    setPlatformQuotas(next)
    try {
      await savePlatformQuotas({ [id]: value })
      await chrome.runtime.sendMessage({
        type: 'UPDATE_CAMPAIGN_QUOTAS',
        payload: { quotas: next },
      })
    } catch {
      // 后台暂不可达时至少已本地落盘，下次开跑会自动读取
    }
    await fetchStats()
    const name = PLATFORM_INFOS.find((p) => p.id === id)?.name ?? id
    onNotify?.(`${name} 投递数量已改为 ${value}（运行中即时生效）`, 'success')
  }

  /** 一键恢复各平台推荐默认投递数量 */
  const handleResetQuotas = async () => {
    const defaults = await resetPlatformQuotas()
    setPlatformQuotas(defaults)
    setEditingQuota(null)
    try {
      await chrome.runtime.sendMessage({
        type: 'UPDATE_CAMPAIGN_QUOTAS',
        payload: { quotas: defaults },
      })
    } catch {
      // 忽略后台通信异常，本地已恢复
    }
    await fetchStats()
    onNotify?.('已恢复各平台默认投递数量', 'info')
  }

  // 保存自定义工作时段
  const handleSaveTimeWindows = async () => {
    const p1Start = parseTimeString(start1)
    const p1End = parseTimeString(end1)
    if (!p1Start || !p1End) {
      onNotify?.('时段 1 时间输入格式有误', 'warning')
      return
    }

    const windows: TimeWindow[] = [
      { startHour: p1Start.hour, startMin: p1Start.min, endHour: p1End.hour, endMin: p1End.min },
    ]

    if (enableSecondWindow) {
      const p2Start = parseTimeString(start2)
      const p2End = parseTimeString(end2)
      if (!p2Start || !p2End) {
        onNotify?.('时段 2 时间输入格式有误', 'warning')
        return
      }
      windows.push({
        startHour: p2Start.hour,
        startMin: p2Start.min,
        endHour: p2End.hour,
        endMin: p2End.min,
      })
    }

    setTimeWindows(windows)
    await saveTimeWindows(windows)

    try {
      await chrome.runtime.sendMessage({
        type: 'UPDATE_CAMPAIGN_WINDOWS',
        payload: { windows },
      })
      await fetchStats()
    } catch {
      // 忽略
    }

    onNotify?.(`工作时段已更新为：${formatTimeWindows(windows)}`, 'success')
    setShowTimeEditor(false)
  }

  // 快捷应用时段预设
  const applyPreset = (preset: 'standard' | 'relaxed' | 'allDay') => {
    if (preset === 'standard') {
      setStart1('09:00')
      setEnd1('11:30')
      setEnableSecondWindow(true)
      setStart2('14:00')
      setEnd2('17:30')
    } else if (preset === 'relaxed') {
      setStart1('09:00')
      setEnd1('21:00')
      setEnableSecondWindow(false)
    } else if (preset === 'allDay') {
      setStart1('00:00')
      setEnd1('23:59')
      setEnableSecondWindow(false)
    }
  }

  // 拟人间歇预设
  const applyIntervalPreset = (preset: 'fast' | 'normal' | 'safe') => {
    if (preset === 'fast') {
      setMinSecInput('15')
      setMaxSecInput('45')
    } else if (preset === 'normal') {
      setMinSecInput('45')
      setMaxSecInput('180')
    } else if (preset === 'safe') {
      setMinSecInput('90')
      setMaxSecInput('300')
    }
  }

  // 保存拟人间歇配置
  const handleSaveInterval = async () => {
    const minSec = parseInt(minSecInput, 10)
    const maxSec = parseInt(maxSecInput, 10)
    if (isNaN(minSec) || isNaN(maxSec) || minSec < 5 || maxSec < minSec) {
      onNotify?.('间隔时间无效：最小秒数不能小于 5 秒，且最大秒数必须大于等于最小秒数', 'warning')
      return
    }

    const cfg: IntervalConfig = { minSeconds: minSec, maxSeconds: maxSec }
    setIntervalConfig(cfg)
    await saveIntervalConfig(cfg)

    try {
      await chrome.runtime.sendMessage({
        type: 'UPDATE_CAMPAIGN_INTERVAL',
        payload: { interval: cfg },
      })
      await fetchStats()
    } catch {
      // 忽略
    }

    onNotify?.(`拟人间歇已更新为：${minSec}-${maxSec} 秒随机等待`, 'success')
    setShowIntervalEditor(false)
  }

  // 手动触发全自主岗位探测与补仓
  const handleTriggerAutoCollect = async () => {
    setCollectingJobs(true)
    try {
      const res = (await chrome.runtime.sendMessage({ type: 'TRIGGER_AUTO_COLLECT' })) as {
        success: boolean
        error?: string
      }
      if (res?.success) {
        onNotify?.('已向各开启平台发起全自主职位探测与补仓！', 'info')
        setTimeout(fetchStats, 1500)
      } else {
        onNotify?.(`探测补仓提示: ${res?.error || '请确认已登录平台'}`, 'warning')
      }
    } catch (err) {
      onNotify?.(`探测补仓异常: ${String(err)}`, 'error')
    } finally {
      setTimeout(() => setCollectingJobs(false), 2000)
    }
  }

  // 清空过期待投队列并立即从当前最新页面重获
  const handleClearPending = async () => {
    setClearingPending(true)
    try {
      const res = (await chrome.runtime.sendMessage({
        type: 'CLEAR_PENDING_TASKS',
        payload: { recollect: true },
      })) as { success: boolean; data?: { cleared: number; recollected: boolean }; error?: string }

      if (res?.success) {
        const count = res.data?.cleared ?? 0
        onNotify?.(`已清空 ${count} 个旧页面待投缓存，正在重新抓取当前最新页面岗位！`, 'success')
        setTimeout(fetchStats, 1500)
      } else {
        onNotify?.(`清空重获提示: ${res?.error || '操作未完成'}`, 'warning')
      }
    } catch (err) {
      onNotify?.(`清空重获异常: ${String(err)}`, 'error')
    } finally {
      setTimeout(() => setClearingPending(false), 1500)
    }
  }

  // 启动流水线（全自动）：先申请 autopilot 锁，与概览的半自动互斥
  const handleStart = async () => {
    if (runtime.mode === 'manual') {
      onNotify?.('概览的半自动沟通正在运行，请先在概览页点「停止」', 'warning')
      return
    }
    try {
      const lock = await chrome.runtime.sendMessage({
        type: 'RUNTIME_ACQUIRE', payload: { mode: 'autopilot' },
      }) as { ok?: boolean; conflict?: string; error?: string } | undefined
      if (!lock?.ok) {
        onNotify?.(
          lock?.conflict === 'manual'
            ? '概览的半自动沟通正在运行，请先停止后再启动 AIbot'
            : `启动失败：${lock?.error || '运行状态未就绪'}`,
          'warning',
        )
        return
      }
    } catch {
      onNotify?.('无法取得全自动运行锁，请重试', 'error')
      return
    }

    const activePlatformIds = (Object.keys(enabledPlatforms) as PlatformId[]).filter(
      (p) => enabledPlatforms[p],
    )
    if (activePlatformIds.length === 0) {
      onNotify?.('请至少开启一个要投递的招聘平台！', 'warning')
      void chrome.runtime.sendMessage({ type: 'RUNTIME_RELEASE', payload: { mode: 'autopilot' } }).catch(() => {})
      return
    }

    // 检查开启平台的登录授权状态并提醒
    if (authInfo) {
      const unauthenticated = activePlatformIds.filter((p) => authInfo[p] && !authInfo[p].isLoggedIn)
      if (unauthenticated.length > 0) {
        const names = unauthenticated
          .map((p) => PLATFORM_INFOS.find((item) => item.id === p)?.name || p)
          .join('、')
        onNotify?.(`提示：【${names}】未检测到登录授权，建议点击平台上的「去登录」`, 'info')
      }
    }

    setLoading(true)
    try {
      const res = (await chrome.runtime.sendMessage({
        type: 'START_CAMPAIGN',
        payload: {
          enabledPlatforms: activePlatformIds,
          windows: timeWindows,
          quotas: platformQuotas,
        },
      })) as { success: boolean; error?: string }

      if (res.success) {
        onNotify?.(`AIbot 已启动！正在调度 [${activePlatformIds.join(', ')}]`, 'success')
        await fetchStats()
      } else {
        void chrome.runtime.sendMessage({ type: 'RUNTIME_RELEASE', payload: { mode: 'autopilot' } }).catch(() => {})
        onNotify?.(`启动失败: ${res.error}`, 'error')
      }
    } catch (err) {
      void chrome.runtime.sendMessage({ type: 'RUNTIME_RELEASE', payload: { mode: 'autopilot' } }).catch(() => {})
      onNotify?.(`启动异常: ${String(err)}`, 'error')
    } finally {
      setLoading(false)
    }
  }

  // 暂停
  const handlePause = async () => {
    setLoading(true)
    try {
      await chrome.runtime.sendMessage({ type: 'PAUSE_CAMPAIGN', payload: { reason: 'user' } })
      onNotify?.('AIbot 已暂停', 'info')
      await fetchStats()
    } finally {
      setLoading(false)
    }
  }

  // 恢复（等同重启：后台会重新申请 autopilot 锁，与概览半自动互斥）
  const handleResume = async () => {
    setLoading(true)
    try {
      const res = (await chrome.runtime.sendMessage({ type: 'RESUME_CAMPAIGN' })) as {
        success: boolean
        error?: string
      }
      if (res?.success) {
        onNotify?.('AIbot 已恢复投递', 'success')
        await fetchStats()
      } else {
        onNotify?.(res?.error || '恢复失败，请重试', 'warning')
      }
    } catch (err) {
      onNotify?.(`恢复异常: ${String(err)}`, 'error')
    } finally {
      setLoading(false)
    }
  }

  // 终止
  const handleAbort = async () => {
    setLoading(true)
    try {
      // 与「关闭浮窗」完全同一个动作：终止流水线 + 清定时器 + 三方状态同步
      await chrome.runtime.sendMessage({
        type: 'ASSISTANT_CONTROL',
        payload: { action: 'shutdown' },
      })
      setAssistant((prev) => ({ ...prev, panelState: 'closed' }))
      onNotify?.('AIbot 流水线已终止，浮窗已关闭', 'warning')
      await fetchStats()
    } finally {
      setLoading(false)
    }
  }

  const isRunning = stats?.status === 'running'
  const isPaused = stats?.status === 'paused'
  const isCaptchaPaused = isPaused && stats?.pausedReason === 'captcha'

  return (
    <div className="bg-white rounded-xl border border-black/10 shadow-sm overflow-hidden text-text-primary space-y-3.5 p-3.5">
      {/* 头部：品牌与状态指示 */}
      <div className="flex items-center justify-between pb-2 border-b border-black/5">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center text-primary">
            <Bot className="w-5 h-5 animate-pulse" />
          </div>
          <div>
            <h3 className="font-bold text-[13px] flex items-center gap-1.5 text-text-primary">
              AIbot 全自动投递流水线
              <span className="text-[10px] px-1.5 py-0.2 rounded bg-primary/10 text-primary border border-primary/20 font-medium">
                无人值守
              </span>
            </h3>
            <p className="text-[10px] text-text-muted">多平台轮转 · AI 筛岗 + 话术 · 拟人防封</p>
          </div>
        </div>

        {/* 运行状态胶囊 */}
        <div>
          {isRunning && (
            <span className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-600 border border-emerald-200 font-medium">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-ping" />
              运行中
            </span>
          )}
          {isCaptchaPaused && (
            <span className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full bg-amber-50 text-amber-600 border border-amber-200 font-medium">
              <AlertTriangle className="w-3.5 h-3.5" />
              等验证码
            </span>
          )}
          {isPaused && !isCaptchaPaused && (
            <span className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full bg-surface-dark text-text-secondary border border-black/10 font-medium">
              <Pause className="w-3.5 h-3.5" />
              已暂停
            </span>
          )}
          {!stats && (
            <span className="text-[11px] text-text-muted px-2 py-0.5 rounded bg-surface-dark border border-black/5 font-medium">
              待就绪
            </span>
          )}
        </div>
      </div>

      {/* 验证码警报通知条 */}
      {isCaptchaPaused && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-2.5 text-xs text-amber-800 flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
          <div className="flex-1">
            <p className="font-semibold text-amber-900">检测到安全验证码，AIbot 已安全挂起！</p>
            <p className="text-amber-700 text-[11px] mt-0.5">
              请在招聘网站标签页手动通过滑块或短信验证，完成后点击下方「已解验证码，继续」。
            </p>
          </div>
        </div>
      )}

      {/* 模拟真人休息提示条 */}
      {stats?.restUntil && stats.restUntil > Date.now() && (
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-2 text-xs text-blue-800 flex items-center gap-2">
          <Coffee className="w-4 h-4 text-blue-600 shrink-0" />
          <span className="text-[11px]">
            模拟真人作息休息中：已连续投递多份，剩余约{' '}
            <strong className="text-blue-700">
              {Math.max(1, Math.round((stats.restUntil - Date.now()) / 60000))}
            </strong>{' '}
            分钟后自动继续投递。
          </span>
        </div>
      )}

      {/* 核心指标看板 */}
      <div className="grid grid-cols-4 gap-2 text-center bg-surface-dark p-2 rounded-lg border border-black/5">
        <div>
          <div className="text-[10px] text-text-muted">待投队列</div>
          <div className="text-sm font-bold text-text-primary mt-0.5">
            {stats?.pending ?? 0}
            {collectingJobs ? (
              <span className="block text-[9px] text-primary font-normal animate-pulse">探测扫描中</span>
            ) : isRunning && (stats?.pending ?? 0) === 0 ? (
              <span className="block text-[9px] text-amber-500 font-normal animate-pulse">自动补仓中</span>
            ) : null}
          </div>
        </div>
        <div>
          <div className="text-[10px] text-emerald-600 font-medium">已成功投递</div>
          <div className="text-sm font-bold text-emerald-600 mt-0.5">{stats?.done ?? 0}</div>
        </div>
        <div>
          <div className="text-[10px] text-text-muted">AI筛岗跳过</div>
          <div className="text-sm font-bold text-text-secondary mt-0.5">{stats?.skipped ?? 0}</div>
        </div>
        <div>
          <div className="text-[10px] text-rose-500">失败重试</div>
          <div className="text-sm font-bold text-rose-500 mt-0.5">{stats?.failed ?? 0}</div>
        </div>
      </div>

      {/* 管家事后复盘与策略进化快捷跳转 */}
      {onNavigateTab && (
        <div className="flex items-center justify-between bg-surface-dark px-2.5 py-1.5 rounded-lg border border-black/5 text-xs">
          <span className="text-[11px] text-text-muted flex items-center gap-1 font-medium">
            <Bot className="w-3.5 h-3.5 text-primary" />
            管家事后复盘与策略进化
          </span>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => onNavigateTab('butler')}
              className="px-2 py-0.5 rounded bg-white border border-primary/20 text-primary hover:bg-primary/5 font-medium transition cursor-pointer text-[10px] flex items-center gap-0.5"
            >
              📋 管家日报
            </button>
            <button
              type="button"
              onClick={() => onNavigateTab('butler')}
              className="px-2 py-0.5 rounded bg-white border border-brand-orange/30 text-brand-orange hover:bg-brand-orange/5 font-medium transition cursor-pointer text-[10px] flex items-center gap-0.5"
            >
              🧬 策略进化
            </button>
          </div>
        </div>
      )}

      {/* 全自主无人值守队列说明与补仓卡片 */}
      <div className="bg-primary/5 border border-primary/15 rounded-lg p-2.5 flex items-center justify-between text-xs gap-2">
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <Sparkles className="w-4 h-4 text-primary shrink-0" />
          <div className="min-w-0">
            <div className="text-[11px] font-semibold text-text-primary flex items-center gap-1">
              全自主无人值守队列
              <span className="text-[9px] px-1 py-0.2 rounded bg-emerald-50 text-emerald-600 border border-emerald-200 font-medium shrink-0">
                免手动
              </span>
            </div>
            <div className="text-[10px] text-text-muted mt-0.5 truncate">
              待投队列由 AIbot 自主巡检开启平台推荐流自动补仓
            </div>
          </div>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          <button
            type="button"
            onClick={handleClearPending}
            disabled={clearingPending}
            className="px-2 py-1 rounded-md bg-white border border-rose-200 text-rose-600 hover:bg-rose-50 text-[10px] font-medium transition flex items-center gap-1 shadow-2xs disabled:opacity-50 cursor-pointer"
            title="清空旧页面残留的待投缓存，并立即根据当前最新网页重新获取岗位"
          >
            <Trash2 className={`w-3 h-3 ${clearingPending ? 'animate-spin' : ''}`} />
            {clearingPending ? '重获中...' : '清空重获'}
          </button>

          <button
            type="button"
            onClick={handleTriggerAutoCollect}
            disabled={collectingJobs}
            className="px-2 py-1 rounded-md bg-white border border-primary/30 text-primary hover:bg-primary/5 text-[10px] font-medium transition flex items-center gap-1 shadow-2xs disabled:opacity-50 cursor-pointer"
            title="立即探测已开启平台的职位流并补充进待投队列"
          >
            <RotateCw className={`w-3 h-3 ${collectingJobs ? 'animate-spin' : ''}`} />
            {collectingJobs ? '探测中...' : '立即补仓'}
          </button>
        </div>
      </div>

      {/* 平台开关与登录授权区 */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-semibold text-text-secondary">
            平台轮转与登录授权
            <span className="ml-1 font-normal text-text-muted">· 点击右侧数量可改</span>
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleResetQuotas}
              className="text-[10px] text-text-muted hover:text-primary transition flex items-center gap-0.5 cursor-pointer"
              title="恢复各平台推荐默认投递数量"
            >
              <RotateCw className="w-2.5 h-2.5" />
              恢复默认
            </button>
            <button
              type="button"
              onClick={checkAuth}
              disabled={checkingAuth}
              className="text-[10px] text-text-muted hover:text-primary transition flex items-center gap-0.5 cursor-pointer"
              title="重新检查各平台登录 Cookie 授权"
            >
              <RotateCw className={`w-2.5 h-2.5 ${checkingAuth ? 'animate-spin' : ''}`} />
              刷新授权
            </button>
            <span className="text-[10px] text-text-muted">
              已开启 {Object.values(enabledPlatforms).filter(Boolean).length}/5
            </span>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-1.5">
          {PLATFORM_INFOS.map(({ id, name, icon }) => {
            const isEnabled = !!enabledPlatforms[id]
            const q = stats?.platformBreakdown?.[id]
            const applied = q?.applied ?? 0
            // 以用户保存的自定义数量为真源，后台运行中同步更新后也不会显示旧值
            const maxQuota = platformQuotas[id] ?? q?.quota ?? DEFAULT_PLATFORM_QUOTAS[id]
            const percent = Math.min(100, Math.round((applied / Math.max(1, maxQuota)) * 100))
            const auth = authInfo?.[id]

            return (
              <div
                key={id}
                className={`flex items-center justify-between p-2 rounded-lg border transition-all ${
                  isEnabled
                    ? 'bg-surface-dark/90 border-black/10'
                    : 'bg-gray-50/60 border-black/5 opacity-60'
                }`}
              >
                {/* 平台开关、名称与授权状态 */}
                <div className="flex items-center gap-2 min-w-0">
                  <button
                    type="button"
                    onClick={() => handleTogglePlatform(id)}
                    className={`w-7 h-4 rounded-full transition-colors relative flex items-center p-0.5 shrink-0 cursor-pointer ${
                      isEnabled ? 'bg-primary' : 'bg-gray-300'
                    }`}
                    title={isEnabled ? '点击禁用该平台' : '点击启用该平台'}
                  >
                    <span
                      className={`w-3 h-3 rounded-full bg-white shadow-sm transform transition-transform ${
                        isEnabled ? 'translate-x-3' : 'translate-x-0'
                      }`}
                    />
                  </button>

                  <span className="text-xs font-medium text-text-primary flex items-center gap-1 shrink-0">
                    <span>{icon}</span>
                    <span>{name}</span>
                  </span>

                  {/* 授权状态徽章 */}
                  {auth && (
                    auth.isLoggedIn ? (
                      <span
                        className="inline-flex items-center gap-0.5 text-[9px] px-1.5 py-0.2 rounded-full bg-emerald-50 text-emerald-600 border border-emerald-200 shrink-0 font-medium"
                        title="已检测到该招聘平台的有效登录凭证"
                      >
                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                        已授权
                      </span>
                    ) : (
                      <a
                        href={auth.loginUrl || PLATFORM_LOGIN_URLS[id]}
                        target="_blank"
                        rel="noreferrer"
                        onClick={(e) => {
                          e.stopPropagation()
                          if (chrome.tabs?.create) {
                            e.preventDefault()
                            chrome.tabs.create({ url: auth.loginUrl || PLATFORM_LOGIN_URLS[id] })
                          }
                        }}
                        className="inline-flex items-center gap-0.5 text-[9px] px-1.5 py-0.2 rounded-full bg-amber-50 hover:bg-amber-100 text-amber-700 border border-amber-300 shrink-0 font-medium transition cursor-pointer"
                        title="未检测到有效登录态，点击在新标签页打开登录"
                      >
                        <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
                        未登录 去登录 ↗
                      </a>
                    )
                  )}
                </div>

                {/* 进度条与可编辑的投递数量上限（5 个平台均可修改，含未开启的） */}
                <div className="flex items-center gap-2 text-right shrink-0">
                  {isEnabled && editingQuota !== id && (
                    <div className="w-16 bg-black/5 rounded-full h-1.5 overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all duration-300 ${
                          q?.exhausted ? 'bg-amber-500' : 'bg-primary'
                        }`}
                        style={{ width: `${percent}%` }}
                      />
                    </div>
                  )}
                  {!isEnabled && editingQuota !== id && (
                    <span className="text-[10px] text-text-muted italic">已关闭</span>
                  )}
                  <span className="text-[10px] text-text-muted font-mono min-w-[3.5rem] flex items-center justify-end gap-0.5">
                    {isEnabled && `${applied}/`}
                    {editingQuota === id ? (
                      <input
                        autoFocus
                        type="number"
                        min={MIN_PLATFORM_QUOTA}
                        max={MAX_PLATFORM_QUOTA}
                        value={quotaInput}
                        onChange={(e) => setQuotaInput(e.target.value)}
                        onBlur={() => {
                          if (cancelQuotaEditRef.current) {
                            cancelQuotaEditRef.current = false
                            setEditingQuota(null)
                            return
                          }
                          void commitQuota(id, quotaInput)
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') e.currentTarget.blur()
                          if (e.key === 'Escape') {
                            cancelQuotaEditRef.current = true
                            e.currentTarget.blur()
                          }
                        }}
                        className="w-10 px-0.5 py-0 text-[10px] text-center rounded border border-primary bg-white text-text-primary outline-none font-mono"
                        title={`回车保存，Esc 取消（${MIN_PLATFORM_QUOTA}-${MAX_PLATFORM_QUOTA}）`}
                      />
                    ) : (
                      <button
                        type="button"
                        onClick={() => {
                          cancelQuotaEditRef.current = false
                          setEditingQuota(id)
                          setQuotaInput(String(maxQuota))
                        }}
                        className="hover:text-primary underline decoration-dotted underline-offset-2 cursor-pointer"
                        title="点击修改该平台投递数量（每日风控上限同步生效）"
                      >
                        {maxQuota}
                      </button>
                    )}
                  </span>
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* 悬浮窗配置：与页面浮窗双向同步 */}
      <div className="border border-black/10 rounded-lg bg-white/70 p-2.5 space-y-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5 text-[11px] font-medium text-slate-700">
            <Sparkles className="w-3.5 h-3.5 text-primary" />
            悬浮窗配置
          </div>
          <span className="text-[10px] text-slate-400">与页面浮窗实时同步</span>
        </div>

        <p className="text-[10px] leading-relaxed text-text-muted rounded-md bg-primary/5 border border-primary/15 px-2 py-1.5">
          🔗 岗位、地点、薪资、AI 评分等<strong className="text-primary-light">沟通筛选条件与概览共用</strong>，
          请到「概览 → 沟通筛选条件」修改；此处改评分开关也会同步回概览。
        </p>

        <div className="flex items-center gap-1.5">
          <span className="text-[10px] text-slate-500 w-14 shrink-0">投递模式</span>
          <button onClick={() => updateAssistant({ applyMode: 'batch' })}
            className={`flex-1 py-1.5 rounded-md text-[11px] border transition ${assistant.applyMode === 'batch' ? 'bg-primary text-white border-primary' : 'bg-white text-slate-600 border-black/10 hover:bg-slate-50'}`}>
            ⚡ 批量沟通
          </button>
          <button onClick={() => updateAssistant({ applyMode: 'recommend' })}
            className={`flex-1 py-1.5 rounded-md text-[11px] border transition ${assistant.applyMode === 'recommend' ? 'bg-primary text-white border-primary' : 'bg-white text-slate-600 border-black/10 hover:bg-slate-50'}`}>
            🤖 AI自动确认
          </button>
        </div>

        <div className="flex items-center gap-1.5">
          <span className="text-[10px] text-slate-500 w-14 shrink-0">AI 评分</span>
          <button onClick={() => handleAiMatchChange(true)}
            className={`flex-1 py-1.5 rounded-md text-[11px] border transition ${assistant.enableAiMatch ? 'bg-primary text-white border-primary' : 'bg-white text-slate-600 border-black/10 hover:bg-slate-50'}`}>
            ⭐ 按分筛选
          </button>
          <button onClick={() => handleAiMatchChange(false)}
            className={`flex-1 py-1.5 rounded-md text-[11px] border transition ${!assistant.enableAiMatch ? 'bg-primary text-white border-primary' : 'bg-white text-slate-600 border-black/10 hover:bg-slate-50'}`}>
            🚀 不评分沟通
          </button>
        </div>

        <div className="flex items-center gap-1.5">
          <span className="text-[10px] text-slate-500 w-14 shrink-0">猎聘简历</span>
          <button onClick={() => updateAssistant({ liepinResumeMode: false })}
            className={`flex-1 py-1.5 rounded-md text-[11px] border transition ${!assistant.liepinResumeMode ? 'bg-primary text-white border-primary' : 'bg-white text-slate-600 border-black/10 hover:bg-slate-50'}`}>
            💬 直接沟通
          </button>
          <button onClick={() => updateAssistant({ liepinResumeMode: true })}
            className={`flex-1 py-1.5 rounded-md text-[11px] border transition ${assistant.liepinResumeMode ? 'bg-primary text-white border-primary' : 'bg-white text-slate-600 border-black/10 hover:bg-slate-50'}`}>
            📄 投简历
          </button>
        </div>

        <div className="space-y-1.5">
          <span className="text-[10px] text-slate-500">面板形态</span>
          <div className="grid grid-cols-2 gap-1.5">
            <button onClick={() => handlePanelState('expanded')}
              className={`py-1.5 rounded-md text-[11px] border transition ${assistant.panelState === 'expanded' ? 'bg-primary text-white border-primary' : 'bg-white text-slate-600 border-black/10 hover:bg-slate-50'}`}>
              整高侧栏
            </button>
            <button onClick={() => handlePanelState('bubble')}
              className={`py-1.5 rounded-md text-[11px] border transition ${assistant.panelState === 'bubble' ? 'bg-primary text-white border-primary' : 'bg-white text-slate-600 border-black/10 hover:bg-slate-50'}`}>
              半圆浮球
            </button>
          </div>
          <button onClick={() => handlePanelState('closed')}
            className="w-full py-1.5 rounded-md text-[11px] border border-rose-200 bg-white text-rose-600 hover:bg-rose-50 transition">
            停止并关闭 AIbot
          </button>
        </div>

        <button
          onClick={() => updateAssistant({ pinned: !assistant.pinned })}
          className={`w-full flex items-center justify-between px-2.5 py-2 rounded-md text-[11px] border transition ${
            assistant.pinned
              ? 'bg-primary/10 border-primary/30 text-primary'
              : 'bg-white border-black/10 text-slate-600 hover:bg-slate-50'
          }`}
        >
          <span className="flex items-center gap-1.5">📌 置顶常驻</span>
          <span className={`w-7 h-3.5 rounded-full relative transition ${assistant.pinned ? 'bg-primary' : 'bg-slate-300'}`}>
            <span className={`absolute top-0.5 w-2.5 h-2.5 rounded-full bg-white transition-all ${assistant.pinned ? 'left-3.5' : 'left-0.5'}`} />
          </span>
        </button>

        <p className="text-[10px] text-slate-400 leading-relaxed">
          点击浏览器工具栏的插件图标 → 网页右侧展开整高侧栏（完整助手面板）；点右上角 × → 收起成半圆浮球；再点浮球 → 还原整高侧栏。📌 置顶后新页面也保持展开、不再自动收起。
        </p>
      </div>

      {/* 控制操作栏 */}
      <div className="space-y-2 pt-1">
        <div className="flex items-center gap-2">
          {runtime.mode === 'manual' && (
            <div className="w-full rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-2 text-[11px] leading-relaxed text-amber-700">
              ✋ 概览的<strong>半自动</strong>沟通正在运行。两条流水线互斥，请先在概览页点「停止」再启动 AIbot 全自动。
            </div>
          )}
          {!isRunning && !isPaused && (
            <button
              onClick={handleStart}
              disabled={loading || runtime.mode === 'manual'}
              className="flex-1 py-2.5 px-3 rounded-lg bg-gradient-to-r from-brand-orange to-primary text-white font-medium text-xs flex items-center justify-center gap-1.5 shadow-sm hover:brightness-105 active:scale-[0.99] transition disabled:opacity-50 cursor-pointer"
            >
              <Play className="w-3.5 h-3.5 fill-current" />
              一键开跑 AIbot
            </button>
          )}

          {isRunning && (
            <button
              onClick={handlePause}
              disabled={loading}
              className="flex-1 py-2.5 px-3 rounded-lg bg-amber-500 hover:bg-amber-600 text-white font-medium text-xs flex items-center justify-center gap-1.5 shadow-sm active:scale-[0.99] transition disabled:opacity-50 cursor-pointer"
            >
              <Pause className="w-3.5 h-3.5" />
              暂停 AIbot
            </button>
          )}

          {isPaused && (
            <button
              onClick={handleResume}
              disabled={loading}
              className="flex-1 py-2.5 px-3 rounded-lg bg-gradient-to-r from-brand-orange to-primary text-white font-medium text-xs flex items-center justify-center gap-1.5 shadow-sm active:scale-[0.99] transition disabled:opacity-50 cursor-pointer"
            >
              <RotateCw className="w-3.5 h-3.5" />
              {isCaptchaPaused ? '已解验证码，继续' : '恢复执行'}
            </button>
          )}

          {(isRunning || isPaused) && (
            <button
              onClick={handleAbort}
              disabled={loading}
              className="py-2.5 px-3 rounded-lg bg-surface-dark hover:bg-rose-50 text-rose-600 border border-black/10 font-medium text-xs flex items-center justify-center gap-1 transition disabled:opacity-50 cursor-pointer"
            >
              <Square className="w-3 h-3 fill-current" />
              终止
            </button>
          )}
        </div>
      </div>

      {/* 每时每刻行为日志终端 */}
      <div className="border border-black/10 rounded-lg overflow-hidden bg-[#0F172A] text-slate-200">
        <div
          className="flex items-center justify-between px-2.5 py-1.5 bg-[#1E293B] cursor-pointer select-none text-[11px]"
          onClick={() => setLogExpanded(!logExpanded)}
        >
          <div className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
            <span className="font-semibold text-slate-100 flex items-center gap-1">
              <Terminal className="w-3 h-3 text-sky-400" />
              每时每刻行为日志
            </span>
            <span className="text-[10px] text-slate-400">
              ({stats?.logs?.length || 0} 条)
            </span>
          </div>

          <div className="flex items-center gap-1 text-slate-400">
            {isRunning && <span className="text-[10px] text-emerald-400 animate-pulse">实时监听中</span>}
            {logExpanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
          </div>
        </div>

        {logExpanded && (
          <div
            ref={logContainerRef}
            className="p-2.5 h-36 overflow-y-auto space-y-1.5 font-mono text-[11px] leading-relaxed select-text"
          >
            {stats?.logs && stats.logs.length > 0 ? (
              stats.logs.map((item) => {
                let badgeClass = 'text-sky-400'
                if (item.level === 'success') badgeClass = 'text-emerald-400 font-medium'
                if (item.level === 'warn') badgeClass = 'text-amber-400'
                if (item.level === 'error') badgeClass = 'text-rose-400 font-semibold'

                return (
                  <div key={item.id} className="flex items-start gap-1.5 hover:bg-slate-800/40 rounded px-1">
                    <span className="text-slate-500 shrink-0 select-none text-[10px]">
                      [{item.time}]
                    </span>
                    <span className={`${badgeClass} break-all flex-1`}>
                      {item.message}
                    </span>
                  </div>
                )
              })
            ) : (
              <div className="text-slate-500 text-center py-6 text-xs">
                AIbot 就绪后，此窗口将实时流水输出每时每刻的检索、AI筛岗、话术生成与投递动作...
              </div>
            )}
          </div>
        )}
      </div>

      {/* 拟人间歇自定义编辑卡片（满足用户：aibot 拟人间歇 45-180s 需要可配置） */}
      {showIntervalEditor && (
        <div className="bg-surface-dark border border-black/10 rounded-lg p-3 space-y-2.5 text-xs">
          <div className="flex items-center justify-between pb-1 border-b border-black/5">
            <span className="font-semibold text-text-primary flex items-center gap-1">
              <Sparkles className="w-3.5 h-3.5 text-brand-orange" />
              自定义 AIbot 拟人间歇
            </span>
            <button
              type="button"
              onClick={() => setShowIntervalEditor(false)}
              className="text-text-muted hover:text-text-primary p-0.5 rounded cursor-pointer"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>

          <p className="text-[10px] text-text-muted leading-relaxed">
            每次投递或与 HR 打招呼后，AIbot 将在此区间内随机休眠，模拟真人阅读与点击行为，规避平台风控。
          </p>

          {/* 快捷预设按钮 */}
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] text-text-muted">快捷预设:</span>
            <button
              type="button"
              onClick={() => applyIntervalPreset('fast')}
              className="px-1.5 py-0.5 rounded bg-white border border-black/10 text-[10px] hover:border-primary text-text-secondary cursor-pointer"
            >
              ⚡ 敏捷 (15-45s)
            </button>
            <button
              type="button"
              onClick={() => applyIntervalPreset('normal')}
              className="px-1.5 py-0.5 rounded bg-white border border-black/10 text-[10px] hover:border-primary text-text-secondary cursor-pointer"
            >
              🎯 标准 (45-180s)
            </button>
            <button
              type="button"
              onClick={() => applyIntervalPreset('safe')}
              className="px-1.5 py-0.5 rounded bg-white border border-black/10 text-[10px] hover:border-primary text-text-secondary cursor-pointer"
            >
              🛡️ 防封 (90-300s)
            </button>
          </div>

          {/* 自定义秒数输入 */}
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-text-secondary">随机间隔区间：</span>
            <div className="flex items-center gap-1.5">
              <input
                type="number"
                min="5"
                max="600"
                value={minSecInput}
                onChange={(e) => setMinSecInput(e.target.value)}
                className="w-14 px-1.5 py-0.5 text-xs text-center rounded border border-black/10 bg-white outline-none focus:border-primary font-mono"
              />
              <span className="text-text-muted text-[11px]">至</span>
              <input
                type="number"
                min="5"
                max="600"
                value={maxSecInput}
                onChange={(e) => setMaxSecInput(e.target.value)}
                className="w-14 px-1.5 py-0.5 text-xs text-center rounded border border-black/10 bg-white outline-none focus:border-primary font-mono"
              />
              <span className="text-text-muted text-[11px]">秒</span>
            </div>
          </div>

          {/* 保存按钮 */}
          <div className="flex justify-end gap-2 pt-1 border-t border-black/5">
            <button
              type="button"
              onClick={() => setShowIntervalEditor(false)}
              className="px-2.5 py-1 text-[11px] rounded bg-white border border-black/10 hover:bg-surface-medium text-text-secondary cursor-pointer"
            >
              取消
            </button>
            <button
              type="button"
              onClick={handleSaveInterval}
              className="px-3 py-1 text-[11px] rounded bg-primary text-white font-medium hover:bg-primary-light flex items-center gap-1 cursor-pointer"
            >
              <Save className="w-3 h-3" />
              保存间歇
            </button>
          </div>
        </div>
      )}

      {/* 工作时段自定义编辑卡片（满足用户：工作时段可修改） */}
      {showTimeEditor && (
        <div className="bg-surface-dark border border-black/10 rounded-lg p-3 space-y-2.5 text-xs">
          <div className="flex items-center justify-between pb-1 border-b border-black/5">
            <span className="font-semibold text-text-primary flex items-center gap-1">
              <Clock className="w-3.5 h-3.5 text-primary" />
              自定义投递工作时段
            </span>
            <button
              type="button"
              onClick={() => setShowTimeEditor(false)}
              className="text-text-muted hover:text-text-primary p-0.5 rounded cursor-pointer"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>

          {/* 快捷预设按钮 */}
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] text-text-muted">快捷预设:</span>
            <button
              type="button"
              onClick={() => applyPreset('standard')}
              className="px-1.5 py-0.5 rounded bg-white border border-black/10 text-[10px] hover:border-primary text-text-secondary cursor-pointer"
            >
              标准两段
            </button>
            <button
              type="button"
              onClick={() => applyPreset('relaxed')}
              className="px-1.5 py-0.5 rounded bg-white border border-black/10 text-[10px] hover:border-primary text-text-secondary cursor-pointer"
            >
              09:00-21:00
            </button>
            <button
              type="button"
              onClick={() => applyPreset('allDay')}
              className="px-1.5 py-0.5 rounded bg-white border border-black/10 text-[10px] hover:border-primary text-text-secondary cursor-pointer"
            >
              24小时不限
            </button>
          </div>

          {/* 时段1 */}
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-text-secondary">时段一：</span>
            <div className="flex items-center gap-1.5">
              <input
                type="time"
                value={start1}
                onChange={(e) => setStart1(e.target.value)}
                className="px-1.5 py-0.5 text-xs rounded border border-black/10 bg-white outline-none focus:border-primary"
              />
              <span className="text-text-muted text-[11px]">至</span>
              <input
                type="time"
                value={end1}
                onChange={(e) => setEnd1(e.target.value)}
                className="px-1.5 py-0.5 text-xs rounded border border-black/10 bg-white outline-none focus:border-primary"
              />
            </div>
          </div>

          {/* 时段2 */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <label className="flex items-center gap-1 text-[11px] text-text-secondary cursor-pointer">
                <input
                  type="checkbox"
                  checked={enableSecondWindow}
                  onChange={(e) => setEnableSecondWindow(e.target.checked)}
                  className="rounded border-black/20 text-primary focus:ring-0 w-3 h-3"
                />
                启用第二时段（如下午）
              </label>

              {enableSecondWindow && (
                <div className="flex items-center gap-1.5">
                  <input
                    type="time"
                    value={start2}
                    onChange={(e) => setStart2(e.target.value)}
                    className="px-1.5 py-0.5 text-xs rounded border border-black/10 bg-white outline-none focus:border-primary"
                  />
                  <span className="text-text-muted text-[11px]">至</span>
                  <input
                    type="time"
                    value={end2}
                    onChange={(e) => setEnd2(e.target.value)}
                    className="px-1.5 py-0.5 text-xs rounded border border-black/10 bg-white outline-none focus:border-primary"
                  />
                </div>
              )}
            </div>
          </div>

          {/* 保存按钮 */}
          <div className="flex justify-end gap-2 pt-1 border-t border-black/5">
            <button
              type="button"
              onClick={() => setShowTimeEditor(false)}
              className="px-2.5 py-1 text-[11px] rounded bg-white border border-black/10 hover:bg-surface-medium text-text-secondary cursor-pointer"
            >
              取消
            </button>
            <button
              type="button"
              onClick={handleSaveTimeWindows}
              className="px-3 py-1 text-[11px] rounded bg-primary text-white font-medium hover:bg-primary-light flex items-center gap-1 cursor-pointer"
            >
              <Save className="w-3 h-3" />
              保存时段
            </button>
          </div>
        </div>
      )}

      {/* 底部保护机制说明与修改时段/间歇按钮 */}
      <div className="flex items-center justify-between text-[10px] text-text-muted px-1 pt-0.5">
        <button
          type="button"
          onClick={() => {
            setShowTimeEditor(!showTimeEditor)
            if (showIntervalEditor) setShowIntervalEditor(false)
          }}
          className="flex items-center gap-1 text-primary hover:text-primary-light transition-colors group cursor-pointer"
          title="点击修改投递时段"
        >
          <Clock className="w-3 h-3 text-primary" />
          <span className="group-hover:underline">工作时段: {formatTimeWindows(timeWindows)}</span>
          <Edit2 className="w-2.5 h-2.5 opacity-70 group-hover:opacity-100" />
        </button>

        <button
          type="button"
          onClick={() => {
            setShowIntervalEditor(!showIntervalEditor)
            if (showTimeEditor) setShowTimeEditor(false)
          }}
          className="flex items-center gap-1 text-brand-orange hover:brightness-110 transition-colors group cursor-pointer"
          title="点击修改拟人间歇"
        >
          <Sparkles className="w-3 h-3 text-brand-orange" />
          <span className="group-hover:underline">
            拟人间歇: {intervalConfig.minSeconds}-{intervalConfig.maxSeconds}s
          </span>
          <Edit2 className="w-2.5 h-2.5 opacity-70 group-hover:opacity-100" />
        </button>
      </div>
    </div>
  )
}
