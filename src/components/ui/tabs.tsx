import React from 'react'

export interface TabItem {
  id: string
  label: string
  icon?: React.ReactNode
}

interface TabsProps {
  tabs: TabItem[]
  activeTab: string
  onTabChange: (id: string) => void
  className?: string
  layout?: 'row' | 'col'
}

export function Tabs({ tabs, activeTab, onTabChange, className = '', layout = 'col' }: TabsProps) {
  const isCol = layout === 'col'

  return (
    <div className={`flex gap-1 p-1 bg-surface-dark border border-black/5 rounded-xl ${className}`}>
      {tabs.map((tab) => {
        const isActive = activeTab === tab.id
        return (
          <button
            key={tab.id}
            type="button"
            onClick={() => onTabChange(tab.id)}
            className={`flex flex-1 items-center justify-center rounded-lg transition-all duration-200 select-none ${
              isCol ? 'flex-col py-1 px-0.5 gap-0.5' : 'flex-row py-1.5 px-2 gap-1.5'
            } ${
              isActive
                ? 'bg-white text-primary font-semibold shadow-xs border border-black/5'
                : 'text-text-muted hover:text-text-secondary hover:bg-black/5'
            }`}
          >
            {tab.icon && (
              <span className={`flex items-center justify-center shrink-0 ${isActive ? 'text-primary' : 'text-text-muted'}`}>
                {tab.icon}
              </span>
            )}
            <span className="text-[11px] leading-tight truncate">
              {tab.label}
            </span>
          </button>
        )
      })}
    </div>
  )
}
