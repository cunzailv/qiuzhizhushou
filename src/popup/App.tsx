import React, { Suspense, lazy, useState, useEffect } from 'react'
import { Tabs } from '../components/ui/tabs'
import { Toast } from '../components/ui/toast'
import type { ApplyFilters } from '../shared/types/filters'
import { log } from '../shared/utils/logger'
import { getSetting, setSetting, syncSettingsToSharedStorage } from '../shared/db/settings-store'
import {
  getSupportedUrlPatterns,
  getPlatformsMeta,
  getPlatformById,
} from '../shared/platform'
import {
  LayoutDashboard, FileText, ListChecks, Settings2, Bot,
} from 'lucide-react'
import logoUrl from '../assets/logo-transparent.png'

const MOD = 'Popup:App'
const Dashboard = lazy(() => import('./pages/Dashboard'))
const Butler = lazy(() => import('./pages/Butler'))
const Resumes = lazy(() => import('./pages/Resumes'))
const Tracker = lazy(() => import('./pages/Tracker'))
const Settings = lazy(() => import('./pages/Settings'))
type ToastState = {
  visible: boolean
  message: string
  type: 'success' | 'error' | 'warning' | 'info'
}

const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds))

// 默认用于「没有可用标签页时自动打开」的目标平台（当前以 Boss 推荐页为默认入口）。
const DEFAULT_TARGET_URL = 'https://www.zhipin.com/web/geek/job-recommend'

// 平台 id → URL 关键词映射（用于 findSupportedBossTab 的 URL 过滤）
const PLATFORM_URL_KEYS: Array<{ id: string; key: string }> = [
  { id: 'boss', key: 'zhipin' },
  { id: 'liepin', key: 'liepin' },
  { id: '51job', key: '51job' },
  { id: 'zhaopin', key: 'zhaopin' },
  { id: 'maimai', key: 'maimai' },
]

// 从 URL 推断平台名（通用，覆盖全部已注册平台）
function inferPlatformNameFromUrl(url: string): string | undefined {
  if (!url) return undefined
  const matched = getPlatformsMeta().map((p) => p).find((p) => {
    const key = PLATFORM_URL_KEYS.find((k) => k.id === p.id)?.key
    return key ? url.toLowerCase().includes(key) : false
  })
  return matched?.name
}

// 从平台名反查平台 id
function inferPlatformIdFromName(name: string): string | undefined {
  const meta = getPlatformsMeta().find((p) => p.name === name)
  return meta?.id
}

async function sendMessageWithRecovery(tabId: number, message: unknown): Promise<unknown> {
  try {
    return await chrome.tabs.sendMessage(tabId, message)
  } catch (firstError) {
    log(MOD, 'sendMessageWithRecovery', 'Content script unavailable, injecting current build', firstError)
    const scripts = chrome.runtime.getManifest().content_scripts?.[0]?.js ?? []
    if (scripts.length === 0) throw firstError

    await chrome.scripting.executeScript({
      target: { tabId },
      files: scripts,
    })

    let lastError: unknown = firstError
    for (let attempt = 0; attempt < 10; attempt++) {
      await wait(150)
      try {
        return await chrome.tabs.sendMessage(tabId, message)
      } catch (error) {
        lastError = error
      }
    }
    throw lastError
  }
}

async function findSupportedBossTab(
  preferredPlatformId?: string,
): Promise<chrome.tabs.Tab | undefined> {
  const patterns = preferredPlatformId
    ? getSupportedUrlPatterns().filter((p) =>
        p.toLowerCase().includes(
          PLATFORM_URL_KEYS.find((k) => k.id === preferredPlatformId)?.key ?? 'zhipin',
        ),
      )
    : getSupportedUrlPatterns()
  const tabs = await chrome.tabs.query({ url: patterns })
  const orderedTabs = [...tabs].sort((left, right) => {
    if (left.active !== right.active) return left.active ? -1 : 1
    return (right.lastAccessed ?? 0) - (left.lastAccessed ?? 0)
  })

  for (const tab of orderedTabs) {
    if (!tab.id) continue
    try {
      const response = await sendMessageWithRecovery(tab.id, { type: 'GET_PAGE_INFO' }) as {
        pageType?: string
      }
      if (response?.pageType && !['other', 'chat'].includes(response.pageType)) return tab
    } catch (error) {
      log(MOD, 'findSupportedBossTab', `Unable to inspect tab ${tab.id}`, error)
    }
  }
}

async function createSupportedBossTab(platformId?: string): Promise<chrome.tabs.Tab> {
  const url = (platformId ? getPlatformById(platformId)?.homeUrl : undefined) ?? DEFAULT_TARGET_URL
  const tab = await chrome.tabs.create({
    url,
    active: false,
  })
  if (!tab.id) throw new Error('无法创建岗位推荐页')

  for (let attempt = 0; attempt < 100; attempt++) {
    const current = await chrome.tabs.get(tab.id)
    if (current.status === 'complete') return current
    await wait(150)
  }
  throw new Error('岗位推荐页加载超时')
}

const TABS = [
  { id: 'dashboard', label: '概览', icon: <LayoutDashboard className="w-3.5 h-3.5" /> },
  { id: 'butler', label: '管家', icon: <Bot className="w-3.5 h-3.5" /> },
  { id: 'resumes', label: '简历', icon: <FileText className="w-3.5 h-3.5" /> },
  { id: 'tracker', label: '追踪', icon: <ListChecks className="w-3.5 h-3.5" /> },
  { id: 'settings', label: '设置', icon: <Settings2 className="w-3.5 h-3.5" /> },
]

export default function App() {
  const [activeTab, setActiveTab] = useState('dashboard')
  const [applyMode, setApplyMode] = useState<'batch' | 'recommend'>('batch')
  const [platformName, setPlatformName] = useState('')
  const [platformOverride, setPlatformOverride] = useState('auto')
  const [platforms, setPlatforms] = useState<Array<{ id: string; name: string; icon: string }>>([])
  const [applyRunning, setApplyRunning] = useState(false)
  const [runningTabId, setRunningTabId] = useState<number | null>(null)
  const [activeTabId, setActiveTabId] = useState<number | null>(null)
  const [toast, setToast] = useState<ToastState>({
    visible: false,
    message: '',
    type: 'info',
  })

  // 启动时把 Dexie 中的历史设置迁移到 chrome.storage.local，
  // 保证 content script 能读到用户配置（content 的 IndexedDB 属于网页域）。
  useEffect(() => {
    syncSettingsToSharedStorage()
  }, [])

  // Honor the "一键沟通默认" mode configured in Settings instead of always
  // forcing batch mode.
  useEffect(() => {
    getSetting<'batch' | 'recommend'>('applyMode', 'batch').then((m) => {
      setApplyMode(m === 'recommend' ? 'recommend' : 'batch')
    })
  }, [])

  // 加载平台列表与用户手动选择的平台覆盖项。
  useEffect(() => {
    setPlatforms(getPlatformsMeta())
    getSetting<string>('platformOverride', 'auto').then((o) => setPlatformOverride(o || 'auto'))
  }, [])

  // 接收 content 脚本「运行结束」通知，复位「停止」按钮。
  useEffect(() => {
    const listener = (message: { type?: string; stopped?: boolean }) => {
      if (message?.type === 'APPLY_ENDED') {
        setApplyRunning(false)
        setRunningTabId(null)
      }
    }
    chrome.runtime.onMessage.addListener(listener)
    return () => chrome.runtime.onMessage.removeListener(listener)
  }, [])

  // 探测当前活动标签页所属招聘平台，并在头部展示平台状态。
  // 策略：先通过 content script 获取平台信息，失败时用 URL 兜底推断。
  useEffect(() => {
    (async () => {
      try {
        // 查询当前活动标签页（不限制 URL，避免因 match pattern 遗漏导致检测失败）
        const [tab] = await chrome.tabs.query({
          active: true,
          currentWindow: true,
        })
        if (!tab?.id || !tab.url) {
          setPlatformName('')
          setActiveTabId(null)
          return
        }

        setActiveTabId(tab.id)

        // 先尝试通过 content script 获取精确的平台信息
        let detectedName = ''
        try {
          const info = await sendMessageWithRecovery(tab.id, { type: 'GET_PAGE_INFO' }) as {
            platformName?: string
          }
          detectedName = info?.platformName ?? ''
        } catch {
          // content script 无响应，继续用 URL 兜底
        }

        // 兜底：如果 content script 返回了平台名则用；否则从 URL 推断
        if (detectedName) {
          setPlatformName(detectedName)
        } else {
          const url = tab.url
          const inferred = inferPlatformNameFromUrl(url ?? '')
          if (inferred) {
            setPlatformName(inferred)
          } else if (getSupportedUrlPatterns().some((p) => {
            // 简单的 glob 风格匹配：将 * 替换为正则
            const regex = new RegExp('^' + p.replace(/\*/g, '.*') + '$', 'i')
            return regex.test(url ?? '')
          })) {
            // URL 匹配我们的支持列表但不是已知平台，留空让 content script 决定
            setPlatformName('')
          } else {
            setPlatformName('')
          }
        }
      } catch {
        setPlatformName('')
      }
    })()
  }, [])

  // 头部展示的平台名：手动选择时优先显示所选平台，否则显示自动识别结果。
  const effectivePlatformName =
    platformOverride !== 'auto'
      ? (platforms.find((p) => p.id === platformOverride)?.name ?? platformName)
      : platformName

  const showToast = (message: string, type: ToastState['type']) => {
    setToast({ visible: true, message, type })
  }

  const handleStartApply = async (filters: ApplyFilters) => {
    log(MOD, 'handleStartApply', 'User clicked 开始投递', {
      jobTitles: filters.jobTitles,
      locations: filters.locations,
      salaryMin: filters.salaryMin,
      salaryMax: filters.salaryMax,
      experience: filters.experience,
      education: filters.education,
      excludeKeywords: filters.excludeKeywords,
      enableAiMatch: filters.enableAiMatch,
      minMatchScore: filters.minMatchScore,
    })

    // 推断目标平台：手动选择优先，否则从检测到的平台名反查
    const preferred =
      platformOverride !== 'auto'
        ? platformOverride
        : inferPlatformIdFromName(effectivePlatformName) ?? undefined
    const platformLabel = effectivePlatformName || '招聘平台'
    showToast(`正在连接 ${platformLabel} 页面…`, 'info')
    try {
      // 优先使用 popup 检测到的当前活动 tab（用户在哪个平台就操作哪个平台）
      // 注意：扩展 popup 页自身也可能被识别为「活动 tab」，必须跳过非 http(s) 页面
      let targetTab: chrome.tabs.Tab | undefined
      let createdTarget = false

      if (activeTabId) {
        try {
          targetTab = await chrome.tabs.get(activeTabId)
        } catch {
          // tab 已关闭
        }
      }

      // 如果当前 tab 不是目标平台（或本身就是扩展页），再查找其他 tab
      if (!targetTab?.id || !/^https?:/i.test(targetTab.url ?? '')) {
        targetTab = await findSupportedBossTab(preferred)
      }

      // 不要自动创建新 tab —— 用户已经在平台页面上，应该直接操作当前页
      if (!targetTab?.id) {
        throw new Error(`未找到 ${platformLabel} 页面。请打开 ${platformLabel} 后重试`)
      }

      log(MOD, 'handleStartApply', 'Sending EXECUTE_APPLY', { tabId: targetTab.id, preferred })
      const response = await sendMessageWithRecovery(targetTab.id, {
          type: 'EXECUTE_APPLY',
          payload: { mode: applyMode, filters },
      }) as { success?: boolean; error?: string } | undefined

      if (!response?.success) {
        throw new Error(response?.error || '页面未确认启动')
      }
      // 成功连接后，用目标 tab 的实际 URL 推断平台名（popup 自身是扩展页时更准确）
      const resolvedPlatformLabel =
        inferPlatformNameFromUrl(targetTab.url ?? '') ?? platformLabel
      showToast(`已连接 ${resolvedPlatformLabel} 页面，开始扫描岗位`, 'success')
      setApplyRunning(true)
      if (targetTab.id) setRunningTabId(targetTab.id)
      if (createdTarget) await chrome.tabs.update(targetTab.id, { active: true })
    } catch (error) {
      const message = error instanceof Error ? error.message : '未知错误'
      log(MOD, 'handleStartApply', 'Failed to start apply', error)
      showToast(`启动失败：${message}。请刷新页面后重试`, 'error')
    }
  }

  const handlePlatformChange = async (value: string) => {
    setPlatformOverride(value)
    await setSetting('platformOverride', value)
  }

  const handleStopApply = async () => {
    showToast('正在停止…', 'info')
    try {
      // 优先使用启动时记录的 tabId，避免重新查找时找不到
      const tabId = runningTabId
      if (!tabId) throw new Error('未找到运行中的页面')
      await sendMessageWithRecovery(tabId, { type: 'EXECUTE_STOP' })
      showToast('已发送停止指令', 'success')
      setApplyRunning(false)
      setRunningTabId(null)
    } catch (error) {
      const message = error instanceof Error ? error.message : '未知错误'
      log(MOD, 'handleStopApply', 'Failed to stop', error)
      showToast(`停止失败：${message}。如已停止请忽略`, 'error')
    }
  }

  return (
    <div className="w-[420px] max-h-[600px] overflow-y-auto bg-surface-darkest">
      {/* Header */}
      <div className="sticky top-0 z-10 bg-white/85 backdrop-blur-md border-b border-black/10">
        {/* 品牌行 */}
        <div className="flex items-center gap-2.5 px-3 pt-3 pb-1.5">
          <img
            src={logoUrl}
            alt="求职投递助手"
            className="w-8 h-8 rounded-lg object-contain shrink-0"
          />
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <h1 className="text-[15px] font-bold leading-tight bg-gradient-to-r from-brand-orange to-primary-light bg-clip-text text-transparent">
                求职投递助手
              </h1>
            </div>
            <p className="text-[10px] text-text-muted leading-tight truncate">
              AI 匹配评估 · 多平台一键投递
            </p>
          </div>
          <div className="ml-auto shrink-0">
            {effectivePlatformName ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-primary/15 px-2 py-0.5 text-[10px] font-medium text-primary-light border border-primary/20">
                <span className="w-1.5 h-1.5 rounded-full bg-primary-light animate-pulse" />
                {effectivePlatformName}
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 rounded-full bg-black/5 px-2 py-0.5 text-[10px] text-text-muted border border-black/10">
                未检测到招聘平台
              </span>
            )}
          </div>
        </div>
        <Tabs tabs={TABS} activeTab={activeTab} onTabChange={setActiveTab} className="m-3 mt-1" />
        <div className="px-3 pb-2 -mt-1 flex items-center justify-between gap-2 text-[11px] text-text-muted">
          <label className="flex items-center gap-1.5">
            平台：
            <select
              value={platformOverride}
              onChange={(e) => handlePlatformChange(e.target.value)}
              className="rounded bg-surface-dark px-1.5 py-0.5 text-[11px] text-text-primary border border-black/10 outline-none focus:border-primary"
            >
              <option value="auto">自动识别</option>
              {platforms.map((p) => (
                <option key={p.id} value={p.id}>{p.icon} {p.name}</option>
              ))}
            </select>
          </label>
          <span className="truncate">
            {effectivePlatformName
              ? <span className="text-primary-light">{effectivePlatformName}</span>
              : '未检测到招聘平台页面'}
          </span>
        </div>
      </div>

      {/* Content */}
      <Suspense fallback={<div className="p-6 text-center text-xs text-text-muted">加载中...</div>}>
        {activeTab === 'dashboard' && (
          <Dashboard
            onStartApply={handleStartApply}
            onStopApply={handleStopApply}
            platformName={effectivePlatformName}
            applyRunning={applyRunning}
          />
        )}
        {activeTab === 'butler' && <Butler />}
        {activeTab === 'resumes' && <Resumes />}
        {activeTab === 'tracker' && <Tracker />}
        {activeTab === 'settings' && <Settings />}
      </Suspense>
      <Toast
        {...toast}
        onClose={() => setToast((current) => ({ ...current, visible: false }))}
      />
    </div>
  )
}
