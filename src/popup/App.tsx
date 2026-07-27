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
  LayoutDashboard, FileText, ListChecks, Settings2,
} from 'lucide-react'

const MOD = 'Popup:App'
const Dashboard = lazy(() => import('./pages/Dashboard'))
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
        p.toLowerCase().includes(preferredPlatformId === 'boss' ? 'zhipin' : 'liepin'),
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
      if (message?.type === 'APPLY_ENDED') setApplyRunning(false)
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
          return
        }

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
          if (/zhipin\.com/i.test(url)) {
            setPlatformName('Boss直聘')
          } else if (/liepin\.com/i.test(url)) {
            setPlatformName('猎聘')
          } else if (getSupportedUrlPatterns().some((p) => {
            // 简单的 glob 风格匹配：将 * 替换为正则
            const regex = new RegExp('^' + p.replace(/\*/g, '.*') + '$', 'i')
            return regex.test(url)
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
        : effectivePlatformName === '猎聘'
          ? 'liepin'
          : effectivePlatformName === 'Boss直聘'
            ? 'boss'
            : undefined
    const platformLabel = effectivePlatformName || '招聘平台'
    showToast(`正在连接 ${platformLabel} 页面…`, 'info')
    try {
      let targetTab = await findSupportedBossTab(preferred)
      const createdTarget = !targetTab
      if (!targetTab) targetTab = await createSupportedBossTab(preferred)
      if (!targetTab.id) throw new Error('未找到可用的页面')

      log(MOD, 'handleStartApply', 'Sending EXECUTE_APPLY', { tabId: targetTab.id, preferred })
      const response = await sendMessageWithRecovery(targetTab.id, {
          type: 'EXECUTE_APPLY',
          payload: { mode: applyMode, filters },
      }) as { success?: boolean; error?: string } | undefined

      if (!response?.success) {
        throw new Error(response?.error || '页面未确认启动')
      }
      showToast(`已连接 ${platformLabel} 页面，开始扫描岗位`, 'success')
      setApplyRunning(true)
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
      const preferred =
        platformOverride !== 'auto'
          ? platformOverride
          : effectivePlatformName === '猎聘'
            ? 'liepin'
            : effectivePlatformName === 'Boss直聘'
              ? 'boss'
              : undefined
      const targetTab = await findSupportedBossTab(preferred)
      if (!targetTab?.id) throw new Error('未找到运行中的页面')
      await sendMessageWithRecovery(targetTab.id, { type: 'EXECUTE_STOP' })
      showToast('已发送停止指令', 'success')
      setApplyRunning(false)
    } catch (error) {
      const message = error instanceof Error ? error.message : '未知错误'
      showToast(`停止失败：${message}`, 'error')
    }
  }

  return (
    <div className="w-[420px] max-h-[600px] overflow-y-auto bg-surface-darkest">
      {/* Header */}
      <div className="sticky top-0 z-10 bg-surface-darkest/80 backdrop-blur-md border-b border-white/5">
        <Tabs tabs={TABS} activeTab={activeTab} onTabChange={setActiveTab} className="m-3" />
        <div className="px-3 pb-2 -mt-1 flex items-center justify-between gap-2 text-[11px] text-text-muted">
          <label className="flex items-center gap-1.5">
            平台：
            <select
              value={platformOverride}
              onChange={(e) => handlePlatformChange(e.target.value)}
              className="rounded bg-surface-dark px-1.5 py-0.5 text-[11px] text-text-normal border border-white/10 outline-none focus:border-emerald-500"
            >
              <option value="auto">自动识别</option>
              {platforms.map((p) => (
                <option key={p.id} value={p.id}>{p.icon} {p.name}</option>
              ))}
            </select>
          </label>
          <span className="truncate">
            {effectivePlatformName
              ? <span className="text-emerald-400">{effectivePlatformName}</span>
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
