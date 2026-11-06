import React, { Suspense, lazy, useState, useEffect } from 'react'
import {
  LayoutDashboard, CalendarDays, Ban, Download, Settings2, Activity, Bot, Brain, Send, FileText,
  ArrowLeft, PanelRight,
} from 'lucide-react'
import logoUrl from '../assets/logo-transparent.png'

interface NavItem {
  id: string
  label: string
  icon: React.ReactNode
}

const Dashboard = lazy(() => import('./pages/Dashboard'))
const InterviewCalendar = lazy(() => import('./pages/InterviewCalendar'))
const Blacklist = lazy(() => import('./pages/Blacklist'))
const Export = lazy(() => import('./pages/Export'))
const Audit = lazy(() => import('./pages/Audit'))
const Agent = lazy(() => import('./pages/Agent'))
const Memory = lazy(() => import('./pages/Memory'))
const Applications = lazy(() => import('./pages/Applications'))
const Resumes = lazy(() => import('./pages/Resumes'))
const Settings = lazy(() => import('./pages/Settings'))

const NAV_ITEMS: NavItem[] = [
  { id: 'dashboard', label: '仪表盘', icon: <LayoutDashboard className="w-5 h-5" /> },
  { id: 'calendar', label: '面试日历', icon: <CalendarDays className="w-5 h-5" /> },
  { id: 'applications', label: '投递记录', icon: <Send className="w-5 h-5" /> },
  { id: 'memory', label: '记忆中心', icon: <Brain className="w-5 h-5" /> },
  { id: 'resumes', label: '简历管理', icon: <FileText className="w-5 h-5" /> },
  { id: 'blacklist', label: '黑名单', icon: <Ban className="w-5 h-5" /> },
  { id: 'audit', label: '审计中心', icon: <Activity className="w-5 h-5" /> },
  { id: 'agent', label: '智能体', icon: <Bot className="w-5 h-5" /> },
  { id: 'export', label: '导出中心', icon: <Download className="w-5 h-5" /> },
  { id: 'settings', label: '设置', icon: <Settings2 className="w-5 h-5" /> },
]

export default function App() {
  const [activeNav, setActiveNav] = useState('dashboard')

  const sendToBackground = async (type: string) => {
    try {
      await chrome.runtime.sendMessage({ type })
    } catch {
      // 扩展上下文异常时静默降级，不打断后台页本身
    }
  }

  // 后台页是 chrome-extension:// 协议，注入不了网页侧栏，
  // 因此必须给出明确的「回助手」入口：直接去招聘网站展开侧栏 / 打开独立助手面板。
  const handleBackToSidebar = () => void sendToBackground('OPEN_SIDEBAR_ON_JOB_SITE')
  const handleOpenAssistantPanel = () => void sendToBackground('OPEN_ASSISTANT_PANEL')

  // H5：后台安装全局错误捕获
  useEffect(() => {
    void import('../shared/db/error-store').then((m) => m.installGlobalErrorCapture()).catch(() => undefined)
    // 安全阀档位初始化：首次安装写入「保守」档；老用户标记 custom 不覆盖原值
    void import('../shared/db/settings-store').then((m) => m.resolveSafetyProfile()).catch(() => undefined)
  }, [])

  return (
    <div className="flex h-screen bg-surface-darkest">
      {/* Sidebar */}
      <aside className="w-56 bg-surface-dark/80 border-r border-surface-hairline flex flex-col p-4 shrink-0">
        {/* Logo */}
        <div className="mb-5 px-2 flex items-center gap-2.5">
          <img
            src={logoUrl}
            alt="求职投递助手"
            className="w-10 h-10 rounded-xl object-contain shrink-0"
          />
          <div className="min-w-0">
            <h1 className="text-lg font-medium leading-tight gradient-text">求职投递助手</h1>
            <p className="text-xs text-text-muted mt-0.5 leading-tight">智能求职 · 管理后台</p>
          </div>
        </div>

        {/* 返回助手：后台页无法注入网页侧栏，这里是唯一的主界面入口 */}
        <div className="mb-5 space-y-2 rounded-xl border border-surface-hairline bg-surface-dark p-2.5">
          <button
            onClick={handleBackToSidebar}
            className="w-full flex items-center justify-center gap-2 rounded-lg bg-text-primary px-3 py-2.5 text-xs font-medium text-white hover:brightness-105 active:scale-[0.98] transition"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            返回助手侧栏
          </button>
          <button
            onClick={handleOpenAssistantPanel}
            className="w-full flex items-center justify-center gap-2 rounded-lg border border-surface-hairline bg-surface-darkest px-3 py-2 text-xs font-medium text-text-secondary hover:bg-surface-dark transition"
          >
            <PanelRight className="w-3.5 h-3.5" />
            打开独立助手面板
          </button>
          <p className="text-xs leading-relaxed text-text-muted px-0.5">
            在招聘网站页面点浏览器工具栏的插件图标，即可展开右侧整高侧栏。
          </p>
        </div>

        {/* Navigation */}
        <nav className="flex-1 space-y-1">
          {NAV_ITEMS.map((item) => (
            <button
              key={item.id}
              onClick={() => setActiveNav(item.id)}
              className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-colors duration-200 ${
                activeNav === item.id
                  ? 'bg-surface-dark text-primary-light shadow-card'
                  : 'text-text-secondary hover:text-text-primary hover:bg-surface-dark'
              }`}
            >
              {item.icon}
              {item.label}
            </button>
          ))}
        </nav>

        {/* Footer */}
        <div className="border-t border-surface-hairline pt-3 mt-4">
          <p className="text-xs text-text-muted text-center">
            v1.0.0 · 智能求职助手
          </p>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 overflow-y-auto p-8">
        <Suspense fallback={<div className="text-sm text-text-muted">加载中...</div>}>
          {activeNav === 'dashboard' && <Dashboard onNavigate={setActiveNav} />}
          {activeNav === 'calendar' && <InterviewCalendar />}
          {activeNav === 'blacklist' && <Blacklist />}
          {activeNav === 'audit' && <Audit />}
          {activeNav === 'agent' && <Agent />}
          {activeNav === 'memory' && <Memory />}
          {activeNav === 'applications' && <Applications />}
          {activeNav === 'resumes' && <Resumes />}
          {activeNav === 'export' && <Export />}
          {activeNav === 'settings' && <Settings />}
        </Suspense>
      </main>
    </div>
  )
}
