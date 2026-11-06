import React, { Suspense, lazy, useState, useEffect } from 'react'
import { Tabs } from '../components/ui/tabs'
import { Toast } from '../components/ui/toast'
import type { ApplyFilters } from '../shared/types/filters'
import { log } from '../shared/utils/logger'
import { getSetting, setSetting, syncSettingsToSharedStorage, resolveSafetyProfile } from '../shared/db/settings-store'
import {
  getSupportedUrlPatterns,
  getPlatformsMeta,
} from '../shared/platform'
import {
  LayoutDashboard, FileText, ListChecks, Settings2, Bot, Sparkles, PanelRight,
} from 'lucide-react'
import logoUrl from '../assets/logo-transparent.png'
import PlatformShortcuts from './components/PlatformShortcuts'
import { CampaignPanel } from './components/CampaignPanel'
import { installGlobalErrorCapture } from '../shared/db/error-store'
import {
  DEFAULT_RUNTIME_STATE,
  getRuntimeState,
  subscribeRuntimeState,
  type AssistantRuntimeState,
} from '../shared/runtime-state'

installGlobalErrorCapture()
// 安全阀档位初始化（首次安装写保守档，老用户标记 custom 不覆盖）
void resolveSafetyProfile().catch(() => undefined)

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

const TABS = [
  { id: 'dashboard', label: '概览', icon: <LayoutDashboard className="w-4 h-4" /> },
  { id: 'pipeline', label: 'AIbot', icon: <Sparkles className="w-4 h-4" /> },
  { id: 'butler', label: '管家', icon: <Bot className="w-4 h-4" /> },
  { id: 'resumes', label: '简历', icon: <FileText className="w-4 h-4" /> },
  { id: 'tracker', label: '追踪', icon: <ListChecks className="w-4 h-4" /> },
  { id: 'settings', label: '设置', icon: <Settings2 className="w-4 h-4" /> },
]

export default function App() {
  const [activeTab, setActiveTab] = useState('dashboard')
  const [applyMode, setApplyMode] = useState<'batch' | 'recommend'>('batch')
  const [platformName, setPlatformName] = useState('')
  const [platformOverride, setPlatformOverride] = useState('auto')
  const [platforms, setPlatforms] = useState<Array<{ id: string; name: string; icon: string }>>([])
  const [applyRunning, setApplyRunning] = useState(false)
  const [runtime, setRuntime] = useState<AssistantRuntimeState>(DEFAULT_RUNTIME_STATE)
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

  // 全局运行状态（半自动 / 全自动互斥锁 + 进度），供概览台与按钮禁用使用
  useEffect(() => {
    getRuntimeState().then(setRuntime).catch(() => {})
    return subscribeRuntimeState(setRuntime)
  }, [])

  // 接收 content 脚本「运行结束」通知，复位「停止」按钮并释放 manual 锁。
  useEffect(() => {
    const listener = (message: { type?: string; stopped?: boolean }) => {
      if (message?.type === 'APPLY_ENDED') {
        setApplyRunning(false)
        setRunningTabId(null)
        void chrome.runtime.sendMessage({ type: 'RUNTIME_RELEASE', payload: { mode: 'manual' } }).catch(() => {})
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
    if (applyRunning) {
      showToast('批量沟通正在进行中，请先点「停止」再重新开始', 'info')
      return
    }
    // 半自动与全自动互斥：先向 background 申请 manual 锁
    try {
      const lock = await chrome.runtime.sendMessage({
        type: 'RUNTIME_ACQUIRE', payload: { mode: 'manual' },
      }) as { ok?: boolean; conflict?: string; error?: string } | undefined
      if (!lock?.ok) {
        showToast(
          lock?.conflict === 'autopilot'
            ? 'AIbot 全自动正在运行，请先在 AIbot 页终止后再开始半自动沟通'
            : `无法开始：${lock?.error || '运行状态未就绪'}`,
          'warning',
        )
        return
      }
    } catch (error) {
      log(MOD, 'handleStartApply', 'Failed to acquire manual lock', error)
      showToast('无法取得运行锁，请重试', 'error')
      return
    }

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
      const createdTarget = false

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
      void chrome.runtime.sendMessage({ type: 'RUNTIME_RELEASE', payload: { mode: 'manual' } }).catch(() => {})
      showToast(`启动失败：${message}。请刷新页面后重试`, 'error')
    }
  }

  // 内嵌在网页侧栏 iframe 里时，隐藏「打开侧栏」入口并铺满侧栏高度；
  // standalone=1 表示作为独立标签页打开（点图标时无法注入侧栏的兜底形态）。
  const inSidebarFrame = window.self !== window.top
  const standalone = new URLSearchParams(window.location.search).get('standalone') === '1'

  useEffect(() => {
    if (!inSidebarFrame) return
    document.documentElement.classList.add('app-embedded')
    return () => document.documentElement.classList.remove('app-embedded')
  }, [inSidebarFrame])

  useEffect(() => {
    if (!standalone) return
    document.body.classList.add('app-standalone')
    return () => document.body.classList.remove('app-standalone')
  }, [standalone])

  /** 在网页右侧展开侧栏 */
  const handleOpenSidebar = async () => {
    try {
      // 独立面板标签页本身是 chrome-extension:// 页面，注入不了侧栏；
      // 让 background 直接去招聘网站标签页展开（没有则新开一个）。
      if (standalone) {
        const result = await chrome.runtime.sendMessage({ type: 'OPEN_SIDEBAR_ON_JOB_SITE' })
        showToast(
          result?.success ? '已在招聘网站展开整高侧栏' : '展开侧栏失败，请手动打开招聘网站后点插件图标',
          result?.success ? 'success' : 'warning',
        )
        return
      }
      const result = await chrome.runtime.sendMessage({ type: 'OPEN_ASSISTANT_SIDEBAR' })
      if (result?.success) {
        showToast('已在网页右侧展开侧栏', 'success')
        setTimeout(() => window.close(), 500)
      } else {
        showToast('当前页面无法展开侧栏，请打开招聘网站页面后重试', 'warning')
      }
    } catch (error) {
      log(MOD, 'handleOpenSidebar', 'Failed to open sidebar', error)
      showToast('展开侧栏失败', 'error')
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
      void chrome.runtime.sendMessage({ type: 'RUNTIME_RELEASE', payload: { mode: 'manual' } }).catch(() => {})
    } catch (error) {
      const message = error instanceof Error ? error.message : '未知错误'
      log(MOD, 'handleStopApply', 'Failed to stop', error)
      showToast(`停止失败：${message}。如已停止请忽略`, 'error')
    }
  }

  return (
    <div
      className={
        inSidebarFrame
          ? 'w-full h-full overflow-y-auto bg-surface-darkest'
          : standalone
            ? 'w-full max-w-[520px] mx-auto min-h-screen overflow-y-auto bg-surface-darkest shadow-xl'
            : 'w-[440px] max-h-[600px] overflow-y-auto bg-surface-darkest'
      }
    >
      {/* Header */}
      <div className="sticky top-0 z-10 bg-surface-darkest border-b border-surface-hairline">
        {/* 品牌行 */}
        <div className="flex items-center gap-2.5 px-3.5 pt-3 pb-1.5">
          <img
            src={logoUrl}
            alt="求职投递助手"
            className="w-8 h-8 rounded-lg object-contain shrink-0"
          />
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <h1 className="text-[15px] font-medium leading-tight text-text-primary">
                求职投递助手
              </h1>
            </div>
            <p className="text-xs text-text-muted leading-tight truncate">
              岗位匹配 · 多平台投递 · 回复复盘
            </p>
          </div>
          <div className="ml-auto shrink-0 flex items-center gap-1.5">
            {/* 已经在网页右侧侧栏里运行时不再显示「打开侧栏」 */}
            {!inSidebarFrame && (
              <button
                onClick={handleOpenSidebar}
                title={standalone ? '去招聘网站展开整高侧栏' : '在网页右侧展开整高侧栏'}
                className="inline-flex items-center gap-1 rounded-md border border-surface-hairline bg-surface-dark px-2 py-0.5 text-xs font-medium text-accent hover:bg-surface-dark transition"
              >
                <PanelRight className="w-3 h-3" />
                {standalone ? '展开侧栏' : '侧栏'}
              </button>
            )}
            {effectivePlatformName ? (
              <span className="inline-flex items-center gap-1 rounded-md bg-surface-dark px-2 py-0.5 text-xs font-medium text-accent border border-surface-hairline">
                <span className="w-1.5 h-1.5 rounded-full bg-accent" />
                {effectivePlatformName}
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 rounded-md bg-surface-dark px-2 py-0.5 text-xs text-text-muted border border-surface-hairline">
                未检测到招聘平台
              </span>
            )}
          </div>
        </div>
        <Tabs tabs={TABS} activeTab={activeTab} onTabChange={setActiveTab} className="m-3.5 mt-1" />
        <div className="px-3.5 pb-2.5 -mt-1 flex items-center justify-between gap-2 text-xs text-text-muted">
          <label className="flex items-center gap-1.5">
            平台：
            <select
              value={platformOverride}
              onChange={(e) => handlePlatformChange(e.target.value)}
              className="rounded bg-surface-dark px-1.5 py-0.5 text-xs text-text-primary border border-surface-hairline outline-none focus:border-accent"
            >
              <option value="auto">自动识别</option>
              {platforms.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </label>
          <span className="truncate">
            {effectivePlatformName
              ? <span className="text-accent">{effectivePlatformName}</span>
              : '未检测到招聘平台页面'}
          </span>
        </div>
      </div>

      {standalone && (
        <div className="px-3.5 py-2 text-xs leading-relaxed text-text-secondary bg-surface-dark border-b border-surface-hairline">
          独立面板模式。点右上角「展开侧栏」可在招聘网站右侧展开整高侧栏。
        </div>
      )}

      {/* 平台官网直达：五个平台一键跳转，无需手动输网址 */}
      <PlatformShortcuts />

      {/* Content */}
      <Suspense fallback={<div className="p-6 text-center text-xs text-text-muted">加载中...</div>}>
        {activeTab === 'dashboard' && (
          <Dashboard
            onStartApply={handleStartApply}
            onStopApply={handleStopApply}
            applyRunning={applyRunning}
            runtime={runtime}
          />
        )}
        {activeTab === 'pipeline' && (
          <div className="px-3.5 pb-4 pt-3">
            <CampaignPanel onNotify={showToast} onNavigateTab={setActiveTab} />
          </div>
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
