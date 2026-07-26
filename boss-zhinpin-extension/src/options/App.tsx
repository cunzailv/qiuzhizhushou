import React, { Suspense, lazy, useState } from 'react'
import {
  LayoutDashboard, CalendarDays, Ban, Download, Settings2,
} from 'lucide-react'

interface NavItem {
  id: string
  label: string
  icon: React.ReactNode
}

const Dashboard = lazy(() => import('./pages/Dashboard'))
const InterviewCalendar = lazy(() => import('./pages/InterviewCalendar'))
const Blacklist = lazy(() => import('./pages/Blacklist'))
const Export = lazy(() => import('./pages/Export'))
const Settings = lazy(() => import('./pages/Settings'))

const NAV_ITEMS: NavItem[] = [
  { id: 'dashboard', label: '仪表盘', icon: <LayoutDashboard className="w-5 h-5" /> },
  { id: 'calendar', label: '面试日历', icon: <CalendarDays className="w-5 h-5" /> },
  { id: 'blacklist', label: '黑名单', icon: <Ban className="w-5 h-5" /> },
  { id: 'export', label: '导出中心', icon: <Download className="w-5 h-5" /> },
  { id: 'settings', label: '设置', icon: <Settings2 className="w-5 h-5" /> },
]

export default function App() {
  const [activeNav, setActiveNav] = useState('dashboard')

  return (
    <div className="flex h-screen bg-surface-darkest">
      {/* Sidebar */}
      <aside className="w-56 bg-surface-dark/80 border-r border-white/5 flex flex-col p-4 shrink-0">
        {/* Logo */}
        <div className="mb-8 px-2">
          <h1 className="text-lg font-bold gradient-text">求职助手</h1>
          <p className="text-[10px] text-text-muted mt-0.5">Boss直聘 · 管理后台</p>
        </div>

        {/* Navigation */}
        <nav className="flex-1 space-y-1">
          {NAV_ITEMS.map((item) => (
            <button
              key={item.id}
              onClick={() => setActiveNav(item.id)}
              className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-all duration-200 ${
                activeNav === item.id
                  ? 'bg-primary/20 text-primary-light shadow-glow'
                  : 'text-text-secondary hover:text-text-primary hover:bg-white/5'
              }`}
            >
              {item.icon}
              {item.label}
            </button>
          ))}
        </nav>

        {/* Footer */}
        <div className="border-t border-white/5 pt-3 mt-4">
          <p className="text-[10px] text-text-muted text-center">
            v1.0.0 · Boss直聘智能求职助手
          </p>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 overflow-y-auto p-8">
        <Suspense fallback={<div className="text-sm text-text-muted">加载中...</div>}>
          {activeNav === 'dashboard' && <Dashboard />}
          {activeNav === 'calendar' && <InterviewCalendar />}
          {activeNav === 'blacklist' && <Blacklist />}
          {activeNav === 'export' && <Export />}
          {activeNav === 'settings' && <Settings />}
        </Suspense>
      </main>
    </div>
  )
}
