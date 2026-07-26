import React, { Suspense, lazy, useState, useEffect } from 'react'
import { Tabs } from '../components/ui/tabs'
import { Toast } from '../components/ui/toast'
import type { ApplyFilters } from '../shared/types/filters'
import { log } from '../shared/utils/logger'
import { getSetting } from '../shared/db/settings-store'
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

const BOSS_URL_PATTERNS = [
  'https://www.zhipin.com/*',
  'https://zhipin.com/*',
]

const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds))

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

async function findSupportedBossTab(): Promise<chrome.tabs.Tab | undefined> {
  const tabs = await chrome.tabs.query({ url: BOSS_URL_PATTERNS })
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

async function createSupportedBossTab(): Promise<chrome.tabs.Tab> {
  const tab = await chrome.tabs.create({
    url: 'https://www.zhipin.com/web/geek/job-recommend',
    active: false,
  })
  if (!tab.id) throw new Error('无法创建 BOSS 岗位推荐页')

  for (let attempt = 0; attempt < 100; attempt++) {
    const current = await chrome.tabs.get(tab.id)
    if (current.status === 'complete') return current
    await wait(150)
  }
  throw new Error('BOSS 岗位推荐页加载超时')
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
  const [toast, setToast] = useState<ToastState>({
    visible: false,
    message: '',
    type: 'info',
  })

  // Honor the "一键投递默认" mode configured in Settings instead of always
  // forcing batch mode.
  useEffect(() => {
    getSetting<'batch' | 'recommend'>('applyMode', 'batch').then((m) => {
      setApplyMode(m === 'recommend' ? 'recommend' : 'batch')
    })
  }, [])

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

    showToast('正在连接 BOSS 页面…', 'info')
    try {
      let targetTab = await findSupportedBossTab()
      const createdTarget = !targetTab
      if (!targetTab) targetTab = await createSupportedBossTab()
      if (!targetTab.id) throw new Error('未找到可用的 BOSS 页面')

      log(MOD, 'handleStartApply', 'Sending EXECUTE_APPLY to zhipin.com tab', targetTab.id)
      const response = await sendMessageWithRecovery(targetTab.id, {
          type: 'EXECUTE_APPLY',
          payload: { mode: applyMode, filters },
      }) as { success?: boolean; error?: string } | undefined

      if (!response?.success) {
        throw new Error(response?.error || 'BOSS 页面未确认启动')
      }
      showToast('已连接 BOSS 页面，开始扫描岗位', 'success')
      if (createdTarget) await chrome.tabs.update(targetTab.id, { active: true })
    } catch (error) {
      const message = error instanceof Error ? error.message : '未知错误'
      log(MOD, 'handleStartApply', 'Failed to start apply', error)
      showToast(`启动失败：${message}。请刷新 BOSS 页面后重试`, 'error')
    }
  }

  return (
    <div className="w-[420px] max-h-[600px] overflow-y-auto bg-surface-darkest">
      {/* Header */}
      <div className="sticky top-0 z-10 bg-surface-darkest/80 backdrop-blur-md border-b border-white/5">
        <Tabs tabs={TABS} activeTab={activeTab} onTabChange={setActiveTab} className="m-3" />
      </div>

      {/* Content */}
      <Suspense fallback={<div className="p-6 text-center text-xs text-text-muted">加载中...</div>}>
        {activeTab === 'dashboard' && <Dashboard onStartApply={handleStartApply} />}
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
