// AIbot 全自动投递控制面板与每时每刻行为日志终端

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react'
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
  Zap,
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
  countUsableMinutesUntil,
} from '../../shared/agent/quota'
import type { PlatformAuthInfo } from '../../shared/platform/auth-checker'
import { PLATFORM_LOGIN_URLS } from '../../shared/platform/auth-checker'
import { getSetting, setSetting } from '../../shared/db/settings-store'
import { persistSharedFilters } from '../../shared/agent/filter-config'
import {
  getDeliveryStrategy,
  applyDeliveryStrategy,
  STRATEGY_PROFILES,
  type DeliveryStrategy,
} from '../../shared/agent/delivery-strategy'
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
import { Disclosure } from '../../components/ui/disclosure'
import { getCampaignLogHistory, type CampaignLog } from '../../shared/agent/queue-store'
import {
  DEFAULT_FOREGROUND_MODE,
  FOREGROUND_MODE_KEY,
} from '../../shared/agent/stealth-mode'
import {
  DEFAULT_REST_ENABLED,
  REST_ENABLED_KEY,
  resolveRestPolicy,
} from '../../shared/agent/rest-policy'
import {
  CAPACITY_GOAL_KEY,
  DEFAULT_CAPACITY_GOAL,
  MAX_CAPACITY_HOURS,
  MAX_CAPACITY_TARGET,
  MIN_CAPACITY_HOURS,
  MIN_CAPACITY_TARGET,
  describeCapacityStatus,
  evaluateCapacityGoal,
  normalizeCapacityGoal,
  hasWindowConflict,
  checkCapacityWindowFit,
  isMustAchieve,
  describeMustAchieveTakeover,
  type CapacityGoal,
} from '../../shared/agent/capacity-goal'

const PLATFORM_INFOS: Array<{ id: PlatformId; name: string }> = [
  { id: 'boss', name: 'Boss直聘' },
  { id: 'liepin', name: '猎聘' },
  { id: 'zhaopin', name: '智联招聘' },
  { id: '51job', name: '前程无忧' },
  { id: 'maimai', name: '脉脉' },
]

/** 折叠组里的低频动作共用同一套安静按钮样式 */
const MAINTENANCE_BUTTON =
  'flex items-center justify-center gap-1 rounded-md border border-surface-hairline bg-surface-darkest px-2 py-1.5 text-xs text-text-secondary hover:bg-surface-dark hover:text-text-primary transition-colors disabled:opacity-50 cursor-pointer'

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
  // 投递方式（精投 / 海投）：必须由用户自己选，系统不预设
  const [strategy, setStrategy] = useState<DeliveryStrategy | null>(null)
  const [showStrategyPicker, setShowStrategyPicker] = useState(false)
  const [minSecInput, setMinSecInput] = useState('45')
  const [maxSecInput, setMaxSecInput] = useState('180')

  // 各平台投递数量：可直接在平台行内编辑，持久化后运行中即时生效
  const [platformQuotas, setPlatformQuotas] = useState<Record<PlatformId, number>>({
    ...DEFAULT_PLATFORM_QUOTAS,
  })
  const [editingQuota, setEditingQuota] = useState<PlatformId | null>(null)
  const [quotaInput, setQuotaInput] = useState('')
  const cancelQuotaEditRef = useRef(false)

  // 前台可见模式：默认关闭 = AIbot 只在专用后台标签页跑，不抢焦点、不导航用户当前页面
  const [foregroundMode, setForegroundMode] = useState(DEFAULT_FOREGROUND_MODE)
  // 模拟真人作息休息：默认开启防风控；嫌慢可关掉，海投策略下批次更长、休息更短
  const [restEnabled, setRestEnabled] = useState(DEFAULT_REST_ENABLED)
  // 目标产能：N 小时内投满 M 份；必达模式默认开启（设定目标 = 必须达成）
  const [capacityGoal, setCapacityGoal] = useState<CapacityGoal>(DEFAULT_CAPACITY_GOAL)
  const [capacityHoursInput, setCapacityHoursInput] = useState(String(DEFAULT_CAPACITY_GOAL.hours))
  const [capacityJobsInput, setCapacityJobsInput] = useState(String(DEFAULT_CAPACITY_GOAL.targetJobs))
  const [mustAchieveInput, setMustAchieveInput] = useState(
    DEFAULT_CAPACITY_GOAL.mustAchieve !== false,
  )
  const [capacitySaving, setCapacitySaving] = useState(false)

  const [logExpanded, setLogExpanded] = useState(true)
  /** 用户往上翻看历史时暂停自动跟随，不再每 2 秒被强行拉回底部 */
  const [logAutoFollow, setLogAutoFollow] = useState(true)
  const [showLogHistory, setShowLogHistory] = useState(false)
  const [historyLogs, setHistoryLogs] = useState<CampaignLog[]>([])
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
        setStrategy(await getDeliveryStrategy())
        setForegroundMode(
          (await getSetting<boolean>(FOREGROUND_MODE_KEY, DEFAULT_FOREGROUND_MODE)) === true,
        )
        setRestEnabled(
          (await getSetting<boolean>(REST_ENABLED_KEY, DEFAULT_REST_ENABLED)) !== false,
        )
        const savedGoal = normalizeCapacityGoal(
          await getSetting<unknown>(CAPACITY_GOAL_KEY, DEFAULT_CAPACITY_GOAL),
        )
        setCapacityGoal(savedGoal)
        setCapacityHoursInput(String(savedGoal.hours))
        setCapacityJobsInput(String(savedGoal.targetJobs))
        setMustAchieveInput(savedGoal.mustAchieve !== false)

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

  // 3. 只在「用户本来就贴着底部」时跟随最新日志；往上看历史时不再抢滚动条
  useEffect(() => {
    if (!logAutoFollow || !logExpanded) return
    if (logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight
    }
  }, [stats?.logs, historyLogs, showLogHistory, logAutoFollow, logExpanded])

  // 切到「全部历史」时拉取跨 campaign 归档
  useEffect(() => {
    if (!showLogHistory) return
    void getCampaignLogHistory().then(setHistoryLogs).catch(() => setHistoryLogs([]))
  }, [showLogHistory, stats?.logs?.length])

  const handleLogScroll = () => {
    const el = logContainerRef.current
    if (!el) return
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24
    setLogAutoFollow(nearBottom)
  }

  const jumpToLatest = () => {
    setShowLogHistory(false)
    setLogAutoFollow(true)
    if (logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight
    }
  }

  /**
   * 前后台模式切换。默认静默：AIbot 在专用后台标签页采集 / 投递，
   * 不激活标签页、不聚焦 Chrome 窗口、不导航用户当前正在看的页面。
   * 只有后台标签页被浏览器节流导致采不到岗位时，才需要临时打开前台可见模式。
   */
  const handleForegroundModeChange = async (enabled: boolean) => {
    setForegroundMode(enabled)
    try {
      await setSetting(FOREGROUND_MODE_KEY, enabled)
      onNotify?.(
        enabled
          ? '已切到前台可见模式：AIbot 运行时会切回招聘页，适合排查采集问题'
          : '已恢复后台静默运行：AIbot 不再抢焦点，也不改动你当前的页面',
        'success',
      )
    } catch {
      onNotify?.('运行模式保存失败，请重试', 'error')
    }
  }

  /** 保存「N 小时投满 M 份」；后台同时写设置与本轮 campaign，运行中立刻生效 */
  const handleSaveCapacityGoal = async (enabled: boolean) => {
    const hours = Number(capacityHoursInput)
    const jobs = Number(capacityJobsInput)
    if (
      !Number.isFinite(hours) || hours < MIN_CAPACITY_HOURS || hours > MAX_CAPACITY_HOURS ||
      !Number.isFinite(jobs) || jobs < MIN_CAPACITY_TARGET || jobs > MAX_CAPACITY_TARGET
    ) {
      onNotify?.(
        `请填写 ${MIN_CAPACITY_HOURS}-${MAX_CAPACITY_HOURS} 小时、${MIN_CAPACITY_TARGET}-${MAX_CAPACITY_TARGET} 份`,
        'warning',
      )
      return
    }
    setCapacitySaving(true)
    try {
      const next: CapacityGoal = {
        enabled,
        hours,
        targetJobs: Math.round(jobs),
        mustAchieve: mustAchieveInput,
      }
      const res = (await chrome.runtime.sendMessage({
        type: 'SET_CAPACITY_GOAL',
        payload: { goal: next },
      })) as { success?: boolean; data?: CapacityGoal; error?: string }
      if (res?.success) {
        const applied = normalizeCapacityGoal(res.data || next)
        setCapacityGoal(applied)
        setCapacityHoursInput(String(applied.hours))
        setCapacityJobsInput(String(applied.targetJobs))
        setMustAchieveInput(applied.mustAchieve !== false)
        if (applied.enabled) {
          const effectiveWindows = stats && Array.isArray(stats.windows) ? stats.windows : timeWindows
          const usableMinutes = countUsableMinutesUntil(
            effectiveWindows,
            new Date(),
            applied.hours * 60 * 60_000,
          )
          const fit = checkCapacityWindowFit({
            hours: applied.hours,
            usableMinutes,
            now: Date.now(),
          })
          onNotify?.(
            isMustAchieve(applied)
              ? `目标已设定：${applied.hours} 小时内投满 ${applied.targetJobs} 份（必达）。${describeMustAchieveTakeover()}；只认平台确认投递数`
              : fit.conflict
                ? `已设定目标，但${fit.advice}`
                : `已设定：${applied.hours} 小时内投满 ${applied.targetJobs} 份，AIbot 会自动调速`,
            'success',
          )
        } else {
          onNotify?.('已关闭目标产能，恢复常规节奏', 'success')
        }
        await fetchStats()
      } else {
        onNotify?.(`目标产能保存失败：${res?.error || '后台暂不可达'}`, 'warning')
      }
    } catch {
      onNotify?.('目标产能保存失败：后台暂不可达', 'warning')
    } finally {
      setCapacitySaving(false)
    }
  }

  /** 关闭模拟休息：后台下一轮 tick 会立即 resume，不再白等十几分钟 */
  const handleRestEnabledChange = async (enabled: boolean) => {
    setRestEnabled(enabled)
    try {
      await setSetting(REST_ENABLED_KEY, enabled)
      if (!enabled) {
        // 若此刻正卡在休息里，别让用户再等十几分钟，直接唤醒
        void chrome.runtime.sendMessage({ type: 'SKIP_REST' }).catch(() => {})
      }
      onNotify?.(
        enabled
          ? '已开启模拟真人作息休息（防风控）'
          : '已关闭模拟休息，AIbot 将连续投递；若正在休息，已立即恢复',
        'success',
      )
    } catch {
      onNotify?.('运行节奏设置保存失败，请重试', 'error')
    }
  }

  /** 一键跳过当前这次休息，立刻恢复投递 */
  const handleSkipRest = async () => {
    try {
      const res = (await chrome.runtime.sendMessage({ type: 'SKIP_REST' })) as {
        success?: boolean
        error?: string
      }
      if (res?.success) {
        onNotify?.('已跳过本次休息，AIbot 正在恢复投递', 'success')
        await fetchStats()
      } else {
        onNotify?.(`跳过休息失败：${res?.error || '后台暂不可达'}`, 'warning')
      }
    } catch {
      onNotify?.('跳过休息失败：后台暂不可达', 'warning')
    }
  }

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

  /**
   * 目标产能与工作时段冲突时的一键放行。
   * 折叠组里的「24小时不限」只是**填表单**，仍需点「保存时段」；旧版日志却写
   * 「一键设为 24小时不限 立即唤醒」，用户点了没反应。这里才是真正落盘并唤醒后台。
   */
  const handleReleaseWindowLimit = async () => {
    const windows: TimeWindow[] = [{ startHour: 0, startMin: 0, endHour: 23, endMin: 59 }]
    setTimeWindows(windows)
    setStart1('00:00')
    setEnd1('23:59')
    setEnableSecondWindow(false)
    await saveTimeWindows(windows)
    try {
      await chrome.runtime.sendMessage({
        type: 'UPDATE_CAMPAIGN_WINDOWS',
        payload: { windows },
      })
      await fetchStats()
    } catch {
      // 后台暂不可达时本地设置已保存，下一轮 tick 会读到
    }
    setShowTimeEditor(false)
    onNotify?.('已解除工作时段限制，AIbot 立即恢复投递（全天可投，风控风险请自行确认）', 'success')
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

  // 用户选定投递方式后：成套应用配置（间隔/门槛/AI 评分/话术），并自动继续启动
  const handlePickStrategy = async (next: DeliveryStrategy) => {
    const profile = await applyDeliveryStrategy(next)
    setStrategy(next)
    setIntervalConfig({ minSeconds: profile.minSeconds, maxSeconds: profile.maxSeconds })
    setMinSecInput(String(profile.minSeconds))
    setMaxSecInput(String(profile.maxSeconds))
    setShowStrategyPicker(false)
    onNotify?.(
      `已选择「${profile.label}」：${profile.minSeconds}-${profile.maxSeconds} 秒/个，匹配门槛 ${profile.minMatchScore} 分`,
      'success',
    )
    setTimeout(() => { void handleStart(next) }, 120)
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
        onNotify?.('已向各开启平台发起全自主职位探测与补仓', 'info')
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
        onNotify?.(`已清空 ${count} 个旧页面待投缓存，正在重新抓取当前最新页面岗位`, 'success')
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
  const handleStart = async (forcedStrategy?: DeliveryStrategy) => {
    // 首次启动必须先让用户自己选投递方式，不替用户决定
    const activeStrategy = forcedStrategy ?? strategy
    if (!activeStrategy) {
      setShowStrategyPicker(true)
      onNotify?.('请先选择投递方式：精投（AI 逐岗判断）或海投（快速铺量）', 'info')
      return
    }
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
      onNotify?.('请至少开启一个要投递的招聘平台', 'warning')
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
        onNotify?.(`AIbot 已启动，正在调度 [${activePlatformIds.join(', ')}]`, 'success')
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
  const displayLogs: CampaignLog[] = showLogHistory ? historyLogs : (stats?.logs ?? [])
  /** 只看已开启平台，用户才知道「80」到底指的是哪些平台加起来的目标 */
  const totalQuota = stats
    ? (Object.keys(stats.platformBreakdown) as PlatformId[])
        .filter((pid) => stats.platformBreakdown[pid]?.enabled !== false)
        .reduce((sum, pid) => sum + (stats.platformBreakdown[pid]?.quota || 0), 0)
    : 0

  /** 目标产能实时可达性：面板与后台用同一套纯函数，文案不会漂移 */
  const capacityEvaluation = useMemo(() => {
    const stored = stats?.capacityGoal
    if (!stored?.enabled) return null
    const iv = stats?.intervalConfig || DEFAULT_INTERVAL_CONFIG
    const now = Date.now()
    const deadlineMs = Math.max(0, stored.startedAt + stored.hours * 60 * 60_000 - now)
    // 面板必须与后台用同一套「有效工时」口径，否则 21:00 之后仍显示进度正常。
    // 优先读 campaign 真正生效的时段（空数组 = 24 小时不限），表单状态只作兜底。
    const effectiveWindows = stats && Array.isArray(stats.windows) ? stats.windows : timeWindows
    const usableMinutes = countUsableMinutesUntil(effectiveWindows, new Date(now), deadlineMs)
    return evaluateCapacityGoal({
      goal: stored,
      now,
      startedAt: stored.startedAt,
      applied: stats?.done ?? 0,
      totalQuota,
      baseIntervalMs: ((iv.minSeconds + iv.maxSeconds) / 2) * 1000,
      policy: resolveRestPolicy(strategy),
      restEnabled,
      usableMinutes,
      // 与后台同口径：必达模式超时不停机，面板不能显示「未达成/missed」
      mustAchieve: stored.mustAchieve !== false,
    })
  }, [stats, totalQuota, strategy, restEnabled, timeWindows])

  return (
    <div className="bg-surface-darkest rounded-xl border border-surface-hairline shadow-sm overflow-hidden text-text-primary space-y-3.5 p-3.5">
      {/* 头部：品牌与状态指示 */}
      <div className="flex items-center justify-between pb-2 border-b border-surface-hairline">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-surface-dark border border-surface-hairline flex items-center justify-center text-primary">
            <Bot className="w-5 h-5" />
          </div>
          <div>
            <h3 className="font-medium text-[13px] flex items-center gap-1.5 text-text-primary">
              AIbot 全自动投递流水线
              <span className="text-xs px-1.5 py-0.2 rounded bg-surface-dark text-primary border border-surface-hairline font-medium">
                无人值守
              </span>
            </h3>
            <p className="text-xs text-text-muted">多平台轮转 · AI 筛岗 + 话术 · 拟人防封</p>
          </div>
        </div>

        {/* 运行状态胶囊 */}
        <div>
          {isRunning && (
            <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-md bg-surface-dark text-success border border-surface-hairline font-medium">
              <span className="w-1.5 h-1.5 rounded-full bg-success" />
              运行中
            </span>
          )}
          {isCaptchaPaused && (
            <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-md bg-surface-dark text-warning border border-surface-hairline font-medium">
              <AlertTriangle className="w-3.5 h-3.5" />
              等验证码
            </span>
          )}
          {isPaused && !isCaptchaPaused && (
            <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-md bg-surface-dark text-text-secondary border border-surface-hairline font-medium">
              <Pause className="w-3.5 h-3.5" />
              已暂停
            </span>
          )}
          {!stats && (
            <span className="text-xs text-text-muted px-2 py-0.5 rounded bg-surface-dark border border-surface-hairline font-medium">
              待就绪
            </span>
          )}
        </div>
      </div>

      {/* 验证码警报通知条 */}
      {isCaptchaPaused && (
        <div className="bg-surface-dark border border-surface-hairline rounded-lg p-2.5 text-xs text-amber-800 flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 text-warning shrink-0 mt-0.5" />
          <div className="flex-1">
            <p className="font-medium text-amber-900">检测到安全验证码，AIbot 已安全挂起</p>
            <p className="text-warning text-xs mt-0.5">
              请在招聘网站标签页手动通过滑块或短信验证，完成后点击下方「已解验证码，继续」。
            </p>
          </div>
        </div>
      )}

      {/* 模拟真人休息提示条：显示配额进度，并给一个立刻恢复的出口 */}
      {stats?.restUntil && stats.restUntil > Date.now() && (
        <div className="bg-surface-dark border border-surface-hairline rounded-lg p-2 flex items-center gap-2">
          <Coffee className="w-4 h-4 text-info shrink-0" />
          <span className="flex-1 min-w-0 text-xs text-text-secondary">
            模拟真人休息中，剩余约{' '}
            <strong className="text-text-primary font-medium">
              {Math.max(1, Math.round((stats.restUntil - Date.now()) / 60000))}
            </strong>{' '}
            分钟 · 今日已投 {stats.done}/{totalQuota}
          </span>
          <button
            type="button"
            onClick={() => void handleSkipRest()}
            className="shrink-0 rounded-md border border-surface-hairline bg-surface-darkest px-2 py-1 text-xs text-text-secondary hover:text-text-primary transition-colors cursor-pointer"
          >
            立即继续
          </button>
        </div>
      )}

      {/* 目标产能：设定后常驻显示进度与可达性，赶不上会明确说明原因 */}
      {capacityEvaluation && (
        <div className="bg-surface-dark border border-surface-hairline rounded-lg p-2.5">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-text-secondary">
              目标产能 · {capacityGoal.hours} 小时投满 {capacityGoal.targetJobs} 份
              {isMustAchieve(capacityGoal) && (
                <span className="ml-1 text-primary">必达 · 未达成不停机</span>
              )}
            </span>
            <span
              className={`text-xs font-medium ${
                capacityEvaluation.status === 'at-risk' ||
                capacityEvaluation.status === 'missed' ||
                capacityEvaluation.status === 'blocked'
                  ? 'text-warning'
                  : capacityEvaluation.status === 'achieved' ? 'text-success' : 'text-text-primary'
              }`}
            >
              {describeCapacityStatus(capacityEvaluation, capacityGoal)}
            </span>
          </div>
          <div className="queue-rule mt-2">
            <div
              className="queue-rule-fill"
              style={{ width: `${capacityEvaluation.progressPercent}%` }}
            />
          </div>
          <div className="text-xs text-text-muted mt-1.5 leading-relaxed">
            已确认投递 {stats?.done ?? 0}/{capacityEvaluation.targetJobs} ·{' '}
            {isMustAchieve(capacityGoal) && capacityEvaluation.remainingMs <= 0
              ? '已超时，必达模式继续投递直到达成'
              : `距截止约 ${Math.round(capacityEvaluation.remainingMs / 60_000)} 分钟`}
            {hasWindowConflict(capacityEvaluation) &&
              (isMustAchieve(capacityGoal)
                ? '（工作时段已自动放行）'
                : `（其中只有 ${capacityEvaluation.usableMinutes} 分钟落在允许时段）`)}
            {capacityEvaluation.remainingJobs > 0 &&
              ` · 每份最多 ${Math.max(8, Math.round(capacityEvaluation.requiredIntervalMs / 1000))} 秒`}
            {capacityEvaluation.advice && ` · ${capacityEvaluation.advice}`}
          </div>
          {capacityEvaluation.remainingJobs > 0 && hasWindowConflict(capacityEvaluation) && isMustAchieve(capacityGoal) && (
            <div className="mt-2">
              <span className="text-xs text-text-secondary">
                必达模式已自动放行原工作时段，不休眠；供给或登录态受阻时会持续换词 / 翻页 / 换平台重试
              </span>
            </div>
          )}
          {capacityEvaluation.remainingJobs > 0 && hasWindowConflict(capacityEvaluation) && !isMustAchieve(capacityGoal) && (
            <div className="mt-2 flex items-center gap-2">
              <span className="text-xs text-warning flex-1">
                目标按墙钟倒计时，休眠不暂停；当前工作时段会吃掉目标时限
              </span>
              <button
                type="button"
                onClick={() => void handleReleaseWindowLimit()}
                className="shrink-0 rounded-md border border-surface-hairline bg-surface-darkest px-2 py-1 text-xs text-text-secondary hover:text-text-primary transition-colors cursor-pointer"
              >
                解除时段限制并继续
              </button>
            </div>
          )}
        </div>
      )}

      {/* 核心指标看板 */}
      <div className="grid grid-cols-4 gap-2 text-center bg-surface-dark p-2 rounded-lg border border-surface-hairline">
        <div>
          <div className="text-xs text-text-muted">待投队列</div>
          <div className="text-sm font-medium text-text-primary mt-0.5">
            {stats?.pending ?? 0}
            {collectingJobs ? (
              <span className="block text-xs text-primary font-normal">探测扫描中</span>
            ) : isRunning && (stats?.pending ?? 0) === 0 ? (
              <span className="block text-xs text-warning font-normal">自动补仓中</span>
            ) : null}
          </div>
        </div>
        <div>
          <div className="text-xs text-success font-medium">已成功投递</div>
          <div className="text-sm font-medium text-success mt-0.5">{stats?.done ?? 0}</div>
          {totalQuota > 0 && (
            <div className="text-xs text-text-muted font-normal">目标 {totalQuota}</div>
          )}
        </div>
        <div>
          <div className="text-xs text-text-muted">AI筛岗跳过</div>
          <div className="text-sm font-medium text-text-secondary mt-0.5">{stats?.skipped ?? 0}</div>
        </div>
        <div>
          <div className="text-xs text-rose-500">失败重试</div>
          <div className="text-sm font-medium text-rose-500 mt-0.5">{stats?.failed ?? 0}</div>
        </div>
      </div>

      {/* 控制操作栏：首屏只留「现在做什么」 */}
      <div className="flex items-center gap-2">
        {runtime.mode === 'manual' && (
          <div className="w-full rounded-lg border border-surface-hairline bg-surface-dark px-2.5 py-2 text-xs leading-relaxed text-warning">
            概览的<strong>半自动</strong>沟通正在运行。两条流水线互斥，请先在概览页点「停止」再启动 AIbot 全自动。
          </div>
        )}
        {!isRunning && !isPaused && (
          <button
            onClick={() => void handleStart()}
            disabled={loading || runtime.mode === 'manual'}
            className="flex-1 py-2.5 px-3 rounded-lg bg-accent text-white font-medium text-xs flex items-center justify-center gap-1.5 shadow-sm hover:brightness-105 transition-colors disabled:opacity-50 cursor-pointer"
          >
            <Play className="w-3.5 h-3.5 fill-current" />
            一键开跑 AIbot
          </button>
        )}
        {isRunning && (
          <button
            onClick={handlePause}
            disabled={loading}
            className="flex-1 py-2.5 px-3 rounded-lg bg-warning hover:bg-amber-600 text-white font-medium text-xs flex items-center justify-center gap-1.5 shadow-sm transition-colors disabled:opacity-50 cursor-pointer"
          >
            <Pause className="w-3.5 h-3.5" />
            暂停 AIbot
          </button>
        )}
        {isPaused && (
          <button
            onClick={handleResume}
            disabled={loading}
            className="flex-1 py-2.5 px-3 rounded-lg bg-accent text-white font-medium text-xs flex items-center justify-center gap-1.5 shadow-sm transition-colors disabled:opacity-50 cursor-pointer"
          >
            <RotateCw className="w-3.5 h-3.5" />
            {isCaptchaPaused ? '已解验证码，继续' : '恢复执行'}
          </button>
        )}
        {(isRunning || isPaused) && (
          <button
            onClick={handleAbort}
            disabled={loading}
            className="py-2.5 px-3 rounded-lg bg-surface-dark hover:bg-rose-50 text-rose-600 border border-surface-hairline font-medium text-xs flex items-center justify-center gap-1 transition-colors disabled:opacity-50 cursor-pointer"
          >
            <Square className="w-3 h-3 fill-current" />
            终止
          </button>
        )}
      </div>

      {/* 低频动作统一收纳：复盘跳转 / 补仓 / 配额 / 授权，功能一个不删 */}
      <Disclosure label="复盘与维护工具" hint="跳转 · 补仓 · 配额 · 授权">
        <div className="grid grid-cols-2 gap-1.5">
          {onNavigateTab && (
            <>
              <button type="button" onClick={() => onNavigateTab('butler')} className={MAINTENANCE_BUTTON}>
                管家日报
              </button>
              <button type="button" onClick={() => onNavigateTab('butler')} className={MAINTENANCE_BUTTON}>
                策略进化
              </button>
            </>
          )}
          <button
            type="button"
            onClick={handleClearPending}
            disabled={clearingPending}
            className={MAINTENANCE_BUTTON}
            title="清空旧页面残留的待投缓存，并立即根据当前最新网页重新获取岗位"
          >
            <Trash2 className={`w-3 h-3 ${clearingPending ? 'animate-spin' : ''}`} />
            {clearingPending ? '重获中...' : '清空重获'}
          </button>
          <button
            type="button"
            onClick={handleTriggerAutoCollect}
            disabled={collectingJobs}
            className={MAINTENANCE_BUTTON}
            title="立即探测已开启平台的职位流并补充进待投队列"
          >
            <RotateCw className={`w-3 h-3 ${collectingJobs ? 'animate-spin' : ''}`} />
            {collectingJobs ? '探测中...' : '立即补仓'}
          </button>
          <button
            type="button"
            onClick={handleResetQuotas}
            className={MAINTENANCE_BUTTON}
            title="恢复各平台推荐默认投递数量"
          >
            恢复默认配额
          </button>
          <button
            type="button"
            onClick={checkAuth}
            disabled={checkingAuth}
            className={MAINTENANCE_BUTTON}
            title="重新检查各平台登录 Cookie 授权"
          >
            <RotateCw className={`w-3 h-3 ${checkingAuth ? 'animate-spin' : ''}`} />
            刷新授权
          </button>
        </div>

        {/* 运行模式：默认后台静默，不抢用户焦点；前台可见模式仅作排查兜底 */}
        <label className="mt-2 flex items-start gap-2 rounded-md border border-surface-hairline bg-surface-dark px-2.5 py-2 cursor-pointer">
          <input
            type="checkbox"
            checked={foregroundMode}
            onChange={(event) => void handleForegroundModeChange(event.target.checked)}
            className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-accent"
          />
          <span className="min-w-0">
            <span className="block text-xs text-text-secondary">前台可见模式（会抢焦点）</span>
            <span className="block text-xs text-text-muted mt-0.5 leading-relaxed">
              默认关闭：AIbot 在专用后台标签页运行，不切换标签页、不聚焦窗口、不改动你正在看的页面。
              若后台标签页被浏览器节流导致采不到岗位，可临时打开此项排查。
            </span>
          </span>
        </label>

        {/* 休息节奏：默认开启防风控；关掉后 AIbot 连续投递，不再插入十几分钟空档 */}
        <label className="mt-2 flex items-start gap-2 rounded-md border border-surface-hairline bg-surface-dark px-2.5 py-2 cursor-pointer">
          <input
            type="checkbox"
            checked={restEnabled}
            onChange={(event) => void handleRestEnabledChange(event.target.checked)}
            className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-accent"
          />
          <span className="min-w-0">
            <span className="block text-xs text-text-secondary">模拟真人作息休息（防风控）</span>
            <span className="block text-xs text-text-muted mt-0.5 leading-relaxed">
              精投连投 15-25 份休息 8-20 分钟，海投连投 30-45 份只休息 3-6 分钟。
              嫌慢可关掉连续投递；若正在休息，关掉或点提示条「立即继续」都会马上恢复。
            </span>
          </span>
        </label>

        {/* 目标产能：N 小时投满 M 份 */}
        <div className="mt-2 rounded-md border border-surface-hairline bg-surface-dark px-2.5 py-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-text-secondary">目标产能（设定即承诺）</span>
            <span className="text-xs text-text-muted">
              {capacityGoal.enabled
                ? isMustAchieve(capacityGoal) ? '已开启 · 必达' : '已开启 · 尽力而为'
                : '未开启'}
            </span>
          </div>
          <div className="mt-2 flex items-center gap-1.5">
            <input
              type="number"
              min={MIN_CAPACITY_HOURS}
              max={MAX_CAPACITY_HOURS}
              step={0.5}
              value={capacityHoursInput}
              onChange={(event) => setCapacityHoursInput(event.target.value)}
              aria-label="目标小时数"
              className="w-16 rounded-md border border-surface-hairline bg-surface-darkest px-2 py-1 text-xs text-text-primary"
            />
            <span className="text-xs text-text-muted">小时内投满</span>
            <input
              type="number"
              min={MIN_CAPACITY_TARGET}
              max={MAX_CAPACITY_TARGET}
              value={capacityJobsInput}
              onChange={(event) => setCapacityJobsInput(event.target.value)}
              aria-label="目标份数"
              className="w-16 rounded-md border border-surface-hairline bg-surface-darkest px-2 py-1 text-xs text-text-primary"
            />
            <span className="text-xs text-text-muted">份</span>
          </div>
          <label className="mt-2 flex items-start gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={mustAchieveInput}
              onChange={(event) => setMustAchieveInput(event.target.checked)}
              aria-label="必达模式"
              className="mt-0.5 shrink-0"
            />
            <span className="text-xs text-text-secondary leading-relaxed">
              必达模式（默认开启）：目标未达成前不停机，系统自动接管可控参数
            </span>
          </label>
          <div className="mt-2 grid grid-cols-2 gap-1.5">
            <button
              type="button"
              onClick={() => void handleSaveCapacityGoal(true)}
              disabled={capacitySaving}
              className={MAINTENANCE_BUTTON}
            >
              {capacitySaving ? '保存中...' : '保存并启用'}
            </button>
            <button
              type="button"
              onClick={() => void handleSaveCapacityGoal(false)}
              disabled={capacitySaving || !capacityGoal.enabled}
              className={MAINTENANCE_BUTTON}
            >
              关闭目标
            </button>
          </div>
          <p className="text-xs text-text-muted mt-1.5 leading-relaxed">
            必达模式：{describeMustAchieveTakeover()}。超时继续投递、不停机，只认平台确认投递数，绝不把点击算成功。
            间隔压缩仍守 8 秒防风控下限；技术栈 / 岗位方向 / 黑名单硬约束保留，不会乱投前端或 Java。
            关闭必达后恢复「尽力而为」节奏：赶不上会预警、到点未达成给诊断，但不承诺达标。
            平台登录失效、风控验证码与账号受限属于平台侧阻断，会明确留痕并持续重试，不会虚报成功。
          </p>
        </div>
      </Disclosure>

      {/* 全自主无人值守队列说明：补仓按钮已收进「复盘与维护工具」 */}
      <div className="bg-surface-dark border border-surface-hairline rounded-lg p-2.5 flex items-center text-xs gap-2">
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <Sparkles className="w-4 h-4 text-primary shrink-0" />
          <div className="min-w-0">
            <div className="text-xs font-medium text-text-primary flex items-center gap-1">
              全自主无人值守队列
              <span className="text-xs px-1 py-0.2 rounded bg-surface-dark text-success border border-surface-hairline font-medium shrink-0">
                免手动
              </span>
            </div>
            <div className="text-xs text-text-muted mt-0.5 truncate">
              待投队列由 AIbot 自主巡检补仓 ·{' '}
              {foregroundMode ? '前台可见模式（会切回招聘页）' : '后台静默运行，不抢焦点'}
            </div>
          </div>
        </div>
      </div>

      {/* 平台开关与登录授权区：默认收起，展开后仍是完整的 5 个平台 */}
      <Disclosure
        label="平台与配额"
        hint={`已开启 ${Object.values(enabledPlatforms).filter(Boolean).length}/5 · 点击数量可改`}
      >
        <div className="grid grid-cols-1 gap-1.5">
          {PLATFORM_INFOS.map(({ id, name }) => {
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
                className={`flex items-center justify-between p-2 rounded-lg border transition-colors ${
                  isEnabled
                    ? 'bg-surface-dark border-surface-hairline'
                    : 'bg-surface-page border-surface-hairline opacity-60'
                }`}
              >
                {/* 平台开关、名称与授权状态 */}
                <div className="flex items-center gap-2 min-w-0">
                  <button
                    type="button"
                    onClick={() => handleTogglePlatform(id)}
                    className={`w-7 h-4 rounded-full transition-colors relative flex items-center p-0.5 shrink-0 cursor-pointer ${
                      isEnabled ? 'bg-primary' : 'bg-surface-light'
                    }`}
                    title={isEnabled ? '点击禁用该平台' : '点击启用该平台'}
                  >
                    <span
                      className={`w-3 h-3 rounded-full bg-surface-darkest shadow-sm transform transition-transform ${
                        isEnabled ? 'translate-x-3' : 'translate-x-0'
                      }`}
                    />
                  </button>

                  <span className="text-xs font-medium text-text-primary flex items-center gap-1 shrink-0">
                    <span>{name}</span>
                  </span>

                  {/* 授权状态徽章 */}
                  {auth && (
                    auth.isLoggedIn ? (
                      <span
                        className="inline-flex items-center gap-0.5 text-xs px-1.5 py-0.2 rounded-md bg-surface-dark text-success border border-surface-hairline shrink-0 font-medium"
                        title="已检测到该招聘平台的有效登录凭证"
                      >
                        <span className="w-1.5 h-1.5 rounded-full bg-success" />
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
                        className="inline-flex items-center gap-0.5 text-xs px-1.5 py-0.2 rounded-md bg-surface-dark hover:bg-surface-medium text-warning border border-amber-300 shrink-0 font-medium transition cursor-pointer"
                        title="未检测到有效登录态，点击在新标签页打开登录"
                      >
                        <span className="w-1.5 h-1.5 rounded-full bg-warning" />
                        未登录 去登录
                      </a>
                    )
                  )}
                </div>

                {/* 进度条与可编辑的投递数量上限（5 个平台均可修改，含未开启的） */}
                <div className="flex items-center gap-2 text-right shrink-0">
                  {isEnabled && editingQuota !== id && (
                    <div className="w-16 queue-rule">
                      <div
                        className="queue-rule-fill"
                        style={{ width: `${percent}%`, backgroundColor: q?.exhausted ? '#B45309' : '#C2410C' }}
                      />
                    </div>
                  )}
                  {!isEnabled && editingQuota !== id && (
                    <span className="text-xs text-text-muted">已关闭</span>
                  )}
                  <span className="text-xs text-text-muted font-mono min-w-[3.5rem] flex items-center justify-end gap-0.5">
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
                        className="w-10 px-0.5 py-0 text-xs text-center rounded border border-primary bg-surface-darkest text-text-primary outline-none font-mono"
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
      </Disclosure>

      {/* 悬浮窗配置：低频开关统一收起 */}
      <Disclosure label="悬浮窗配置" hint="投递模式 · 评分 · 面板形态">
        <div className="space-y-2">
          <p className="text-xs leading-relaxed text-text-muted rounded-md bg-surface-dark border border-surface-hairline px-2 py-1.5">
            岗位、地点、薪资、AI 评分等<strong className="text-accent">沟通筛选条件与概览共用</strong>，
            请到「概览 → 沟通筛选条件」修改；此处改评分开关也会同步回概览。
          </p>

          <div className="flex items-center gap-1.5">
            <span className="text-xs text-text-secondary w-14 shrink-0">投递模式</span>
            <button onClick={() => updateAssistant({ applyMode: 'batch' })}
              className={`flex-1 py-1.5 rounded-md text-xs border transition ${assistant.applyMode === 'batch' ? 'bg-primary text-white border-primary' : 'bg-surface-darkest text-text-secondary border-surface-hairline hover:bg-surface-page'}`}>
              批量沟通
            </button>
            <button onClick={() => updateAssistant({ applyMode: 'recommend' })}
              className={`flex-1 py-1.5 rounded-md text-xs border transition ${assistant.applyMode === 'recommend' ? 'bg-primary text-white border-primary' : 'bg-surface-darkest text-text-secondary border-surface-hairline hover:bg-surface-page'}`}>
              AI自动确认
            </button>
          </div>

          <div className="flex items-center gap-1.5">
            <span className="text-xs text-text-secondary w-14 shrink-0">AI 评分</span>
            <button onClick={() => handleAiMatchChange(true)}
              className={`flex-1 py-1.5 rounded-md text-xs border transition ${assistant.enableAiMatch ? 'bg-primary text-white border-primary' : 'bg-surface-darkest text-text-secondary border-surface-hairline hover:bg-surface-page'}`}>
              按分筛选
            </button>
            <button onClick={() => handleAiMatchChange(false)}
              className={`flex-1 py-1.5 rounded-md text-xs border transition ${!assistant.enableAiMatch ? 'bg-primary text-white border-primary' : 'bg-surface-darkest text-text-secondary border-surface-hairline hover:bg-surface-page'}`}>
              不评分沟通
            </button>
          </div>

          <div className="flex items-center gap-1.5">
            <span className="text-xs text-text-secondary w-14 shrink-0">猎聘简历</span>
            <button onClick={() => updateAssistant({ liepinResumeMode: false })}
              className={`flex-1 py-1.5 rounded-md text-xs border transition ${!assistant.liepinResumeMode ? 'bg-primary text-white border-primary' : 'bg-surface-darkest text-text-secondary border-surface-hairline hover:bg-surface-page'}`}>
              直接沟通
            </button>
            <button onClick={() => updateAssistant({ liepinResumeMode: true })}
              className={`flex-1 py-1.5 rounded-md text-xs border transition ${assistant.liepinResumeMode ? 'bg-primary text-white border-primary' : 'bg-surface-darkest text-text-secondary border-surface-hairline hover:bg-surface-page'}`}>
              投简历
            </button>
          </div>

          <div className="space-y-1.5">
            <span className="text-xs text-text-secondary">面板形态</span>
            <div className="grid grid-cols-2 gap-1.5">
              <button onClick={() => handlePanelState('expanded')}
                className={`py-1.5 rounded-md text-xs border transition ${assistant.panelState === 'expanded' ? 'bg-primary text-white border-primary' : 'bg-surface-darkest text-text-secondary border-surface-hairline hover:bg-surface-page'}`}>
                整高侧栏
              </button>
              <button onClick={() => handlePanelState('bubble')}
                className={`py-1.5 rounded-md text-xs border transition ${assistant.panelState === 'bubble' ? 'bg-primary text-white border-primary' : 'bg-surface-darkest text-text-secondary border-surface-hairline hover:bg-surface-page'}`}>
                半圆浮球
              </button>
            </div>
            <button onClick={() => handlePanelState('closed')}
              className="w-full py-1.5 rounded-md text-xs border border-rose-200 bg-surface-darkest text-rose-600 hover:bg-rose-50 transition">
              停止并关闭 AIbot
            </button>
          </div>

          <button
            onClick={() => updateAssistant({ pinned: !assistant.pinned })}
            className={`w-full flex items-center justify-between px-2.5 py-2 rounded-md text-xs border transition ${
              assistant.pinned
                ? 'bg-surface-dark border-surface-hairline text-primary'
                : 'bg-surface-darkest border-surface-hairline text-text-secondary hover:bg-surface-page'
            }`}
          >
            <span className="flex items-center gap-1.5">置顶常驻</span>
            <span className={`w-7 h-3.5 rounded-full relative transition ${assistant.pinned ? 'bg-primary' : 'bg-surface-light'}`}>
              <span className={`absolute top-0.5 w-2.5 h-2.5 rounded-full bg-surface-darkest transition-colors ${assistant.pinned ? 'left-3.5' : 'left-0.5'}`} />
            </span>
          </button>

          <p className="text-xs text-text-muted leading-relaxed">
            工具栏图标展开整高侧栏，右上角 × 收成半圆浮球；置顶后新页面保持展开。
          </p>
        </div>
      </Disclosure>

      {/* 每时每刻行为日志终端 */}
      <div className="border border-surface-hairline rounded-lg overflow-hidden bg-[#0F172A] text-slate-200">
        <div
          className="flex items-center justify-between px-2.5 py-1.5 bg-[#1E293B] cursor-pointer select-none text-xs"
          onClick={() => setLogExpanded(!logExpanded)}
        >
          <div className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-emerald-400" />
            <span className="font-medium text-slate-100 flex items-center gap-1">
              <Terminal className="w-3 h-3 text-sky-400" />
              每时每刻行为日志
            </span>
            <span className="text-xs text-text-muted">
              ({displayLogs.length} 条{showLogHistory ? ' · 全部历史' : ''})
            </span>
          </div>

          <div className="flex items-center gap-1 text-text-muted">
            {isRunning && !showLogHistory && <span className="text-xs text-emerald-400">实时监听中</span>}
            {!logAutoFollow && (
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); jumpToLatest() }}
                className="px-1.5 py-0.5 rounded border border-slate-600 text-xs text-slate-200 hover:bg-slate-700 transition-colors"
                title="回到本轮最新日志"
              >
                回到最新
              </button>
            )}
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); setShowLogHistory((v) => !v) }}
              className="px-1.5 py-0.5 rounded border border-slate-600 text-xs text-slate-200 hover:bg-slate-700 transition-colors"
              title="查看跨轮次归档的全部动作，或只看本轮"
            >
              {showLogHistory ? '只看本轮' : '全部历史'}
            </button>
            {logExpanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
          </div>
        </div>

        {logExpanded && (
          <div
            ref={logContainerRef}
            onScroll={handleLogScroll}
            className="p-2.5 h-64 overflow-y-auto space-y-1.5 font-mono text-xs leading-relaxed select-text"
          >
            {displayLogs.length > 0 ? (
              displayLogs.map((item) => {
                let badgeClass = 'text-sky-400'
                if (item.level === 'success') badgeClass = 'text-emerald-400 font-medium'
                if (item.level === 'warn') badgeClass = 'text-amber-400'
                if (item.level === 'error') badgeClass = 'text-rose-400 font-medium'

                return (
                  <div key={item.id} className="flex items-start gap-1.5 hover:bg-slate-800/40 rounded px-1">
                    <span className="text-text-secondary shrink-0 select-none text-xs">
                      [{item.date ? `${item.date} ` : ''}{item.time}]
                    </span>
                    <span className={`${badgeClass} break-all flex-1`}>
                      {item.message}
                    </span>
                  </div>
                )
              })
            ) : (
              <div className="text-text-secondary text-center py-6 text-xs">
                AIbot 就绪后，此窗口将实时流水输出每时每刻的检索、AI筛岗、话术生成与投递动作...
              </div>
            )}
          </div>
        )}
      </div>

      {/* 三个常驻调节入口：展开的编辑器紧随其后，不用反向滚动 */}
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs text-text-muted px-1 pt-0.5">
        <button
          type="button"
          onClick={() => {
            setShowTimeEditor(!showTimeEditor)
            if (showIntervalEditor) setShowIntervalEditor(false)
          }}
          className="flex items-center gap-1 text-primary hover:text-accent transition-colors group cursor-pointer"
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

        <button
          type="button"
          onClick={() => setShowStrategyPicker(true)}
          className={`flex items-center gap-1 font-medium transition-colors cursor-pointer ${
            strategy ? 'text-brand-orange' : 'text-primary'
          }`}
          title="选择投递方式：精投（AI 逐岗判断）或海投（快速铺量）"
        >
          <Zap className="w-3 h-3" />
          <span>投递方式：{strategy ? STRATEGY_PROFILES[strategy].label : '未选择'}</span>
          <Edit2 className="w-2.5 h-2.5 opacity-70 group-hover:opacity-100" />
        </button>
      </div>

      {/* 拟人间歇自定义编辑卡片（满足用户：aibot 拟人间歇 45-180s 需要可配置） */}
      {showIntervalEditor && (
        <div className="bg-surface-dark border border-surface-hairline rounded-lg p-3 space-y-2.5 text-xs">
          <div className="flex items-center justify-between pb-1 border-b border-surface-hairline">
            <span className="font-medium text-text-primary flex items-center gap-1">
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

          <p className="text-xs text-text-muted leading-relaxed">
            每次投递或与 HR 打招呼后，AIbot 将在此区间内随机休眠，模拟真人阅读与点击行为，规避平台风控。
          </p>

          {/* 快捷预设按钮 */}
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-text-muted">快捷预设:</span>
            <button
              type="button"
              onClick={() => applyIntervalPreset('fast')}
              className="px-1.5 py-0.5 rounded bg-surface-darkest border border-surface-hairline text-xs hover:border-primary text-text-secondary cursor-pointer"
            >
              敏捷 (15-45s)
            </button>
            <button
              type="button"
              onClick={() => applyIntervalPreset('normal')}
              className="px-1.5 py-0.5 rounded bg-surface-darkest border border-surface-hairline text-xs hover:border-primary text-text-secondary cursor-pointer"
            >
              标准 (45-180s)
            </button>
            <button
              type="button"
              onClick={() => applyIntervalPreset('safe')}
              className="px-1.5 py-0.5 rounded bg-surface-darkest border border-surface-hairline text-xs hover:border-primary text-text-secondary cursor-pointer"
            >
              防封 (90-300s)
            </button>
          </div>

          {/* 自定义秒数输入 */}
          <div className="flex items-center justify-between">
            <span className="text-xs text-text-secondary">随机间隔区间：</span>
            <div className="flex items-center gap-1.5">
              <input
                type="number"
                min="5"
                max="600"
                value={minSecInput}
                onChange={(e) => setMinSecInput(e.target.value)}
                className="w-14 px-1.5 py-0.5 text-xs text-center rounded border border-surface-hairline bg-surface-darkest outline-none focus:border-primary font-mono"
              />
              <span className="text-text-muted text-xs">至</span>
              <input
                type="number"
                min="5"
                max="600"
                value={maxSecInput}
                onChange={(e) => setMaxSecInput(e.target.value)}
                className="w-14 px-1.5 py-0.5 text-xs text-center rounded border border-surface-hairline bg-surface-darkest outline-none focus:border-primary font-mono"
              />
              <span className="text-text-muted text-xs">秒</span>
            </div>
          </div>

          {/* 保存按钮 */}
          <div className="flex justify-end gap-2 pt-1 border-t border-surface-hairline">
            <button
              type="button"
              onClick={() => setShowIntervalEditor(false)}
              className="px-2.5 py-1 text-xs rounded bg-surface-darkest border border-surface-hairline hover:bg-surface-medium text-text-secondary cursor-pointer"
            >
              取消
            </button>
            <button
              type="button"
              onClick={handleSaveInterval}
              className="px-3 py-1 text-xs rounded bg-primary text-white font-medium hover:bg-primary-light flex items-center gap-1 cursor-pointer"
            >
              <Save className="w-3 h-3" />
              保存间歇
            </button>
          </div>
        </div>
      )}

      {/* 工作时段自定义编辑卡片（满足用户：工作时段可修改） */}
      {showTimeEditor && (
        <div className="bg-surface-dark border border-surface-hairline rounded-lg p-3 space-y-2.5 text-xs">
          <div className="flex items-center justify-between pb-1 border-b border-surface-hairline">
            <span className="font-medium text-text-primary flex items-center gap-1">
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
            <span className="text-xs text-text-muted">快捷预设:</span>
            <button
              type="button"
              onClick={() => applyPreset('standard')}
              className="px-1.5 py-0.5 rounded bg-surface-darkest border border-surface-hairline text-xs hover:border-primary text-text-secondary cursor-pointer"
            >
              标准两段
            </button>
            <button
              type="button"
              onClick={() => applyPreset('relaxed')}
              className="px-1.5 py-0.5 rounded bg-surface-darkest border border-surface-hairline text-xs hover:border-primary text-text-secondary cursor-pointer"
            >
              09:00-21:00
            </button>
            <button
              type="button"
              onClick={() => applyPreset('allDay')}
              className="px-1.5 py-0.5 rounded bg-surface-darkest border border-surface-hairline text-xs hover:border-primary text-text-secondary cursor-pointer"
            >
              24小时不限
            </button>
          </div>

          {/* 时段1 */}
          <div className="flex items-center justify-between">
            <span className="text-xs text-text-secondary">时段一：</span>
            <div className="flex items-center gap-1.5">
              <input
                type="time"
                value={start1}
                onChange={(e) => setStart1(e.target.value)}
                className="px-1.5 py-0.5 text-xs rounded border border-surface-hairline bg-surface-darkest outline-none focus:border-primary"
              />
              <span className="text-text-muted text-xs">至</span>
              <input
                type="time"
                value={end1}
                onChange={(e) => setEnd1(e.target.value)}
                className="px-1.5 py-0.5 text-xs rounded border border-surface-hairline bg-surface-darkest outline-none focus:border-primary"
              />
            </div>
          </div>

          {/* 时段2 */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <label className="flex items-center gap-1 text-xs text-text-secondary cursor-pointer">
                <input
                  type="checkbox"
                  checked={enableSecondWindow}
                  onChange={(e) => setEnableSecondWindow(e.target.checked)}
                  className="rounded border-surface-hairline text-primary focus:ring-0 w-3 h-3"
                />
                启用第二时段（如下午）
              </label>

              {enableSecondWindow && (
                <div className="flex items-center gap-1.5">
                  <input
                    type="time"
                    value={start2}
                    onChange={(e) => setStart2(e.target.value)}
                    className="px-1.5 py-0.5 text-xs rounded border border-surface-hairline bg-surface-darkest outline-none focus:border-primary"
                  />
                  <span className="text-text-muted text-xs">至</span>
                  <input
                    type="time"
                    value={end2}
                    onChange={(e) => setEnd2(e.target.value)}
                    className="px-1.5 py-0.5 text-xs rounded border border-surface-hairline bg-surface-darkest outline-none focus:border-primary"
                  />
                </div>
              )}
            </div>
          </div>

          {/* 保存按钮 */}
          <div className="flex justify-end gap-2 pt-1 border-t border-surface-hairline">
            <button
              type="button"
              onClick={() => setShowTimeEditor(false)}
              className="px-2.5 py-1 text-xs rounded bg-surface-darkest border border-surface-hairline hover:bg-surface-medium text-text-secondary cursor-pointer"
            >
              取消
            </button>
            <button
              type="button"
              onClick={handleSaveTimeWindows}
              className="px-3 py-1 text-xs rounded bg-primary text-white font-medium hover:bg-primary-light flex items-center gap-1 cursor-pointer"
            >
              <Save className="w-3 h-3" />
              保存时段
            </button>
          </div>
        </div>
      )}

      {/* 投递方式选择：由用户自己决定精投还是海投，系统不预设 */}
      {showStrategyPicker && (
        <div className="bg-surface-dark border border-surface-hairline rounded-lg p-3 space-y-2.5 text-xs">
          <div className="flex items-center justify-between pb-1 border-b border-surface-hairline">
            <span className="font-medium text-text-primary flex items-center gap-1">
              <Zap className="w-3.5 h-3.5 text-primary" />
              选择投递方式
            </span>
            <button
              type="button"
              onClick={() => setShowStrategyPicker(false)}
              className="text-text-muted hover:text-text-primary p-0.5 rounded cursor-pointer"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>

          {(Object.keys(STRATEGY_PROFILES) as DeliveryStrategy[]).map((key) => {
            const profile = STRATEGY_PROFILES[key]
            const active = strategy === key
            return (
              <button
                key={key}
                type="button"
                onClick={() => void handlePickStrategy(key)}
                className={`w-full text-left rounded-lg border p-2.5 transition cursor-pointer ${
                  active
                    ? 'border-primary bg-surface-dark'
                    : 'border-surface-hairline bg-surface-darkest hover:border-surface-hairline'
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="font-medium text-text-primary">{profile.label}</span>
                  <span className="text-xs text-text-muted">
                    {profile.minSeconds}-{profile.maxSeconds}s/个 · 门槛 {profile.minMatchScore} 分
                  </span>
                </div>
                <p className="mt-1 text-xs leading-relaxed text-text-secondary">
                  {profile.description}
                </p>
              </button>
            )
          })}

          <p className="text-xs text-text-muted leading-relaxed">
            选定后自动应用对应配置并开始投递；两套参数成套切换，不会出现「海投的间隔配精投的门槛」这种混搭。
          </p>
        </div>
      )}

    </div>
  )
}
