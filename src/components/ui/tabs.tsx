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
    <div className={`flex gap-1 p-1 bg-surface-dark border border-surface-hairline rounded-xl ${className}`}>
      {tabs.map((tab) => {
        const isActive = activeTab === tab.id
        return (
          <button
            key={tab.id}
            type="button"
            onClick={() => onTabChange(tab.id)}
            aria-current={isActive ? 'page' : undefined}
            className={`flex flex-1 items-center justify-center rounded-lg transition-colors duration-150 select-none ${
              isCol ? 'flex-col py-1.5 px-0.5 gap-1' : 'flex-row py-1.5 px-2 gap-1.5'
            } ${
              isActive
                ? 'bg-surface-darkest text-text-primary shadow-card border border-surface-hairline'
                : 'text-text-muted hover:text-text-secondary hover:bg-surface-darkest border border-transparent'
            }`}
          >
            {tab.icon && (
              <span className={`flex items-center justify-center shrink-0 ${isActive ? 'text-text-primary' : 'text-text-muted'}`}>
                {tab.icon}
              </span>
            )}
            <span className="text-xs leading-tight truncate">
              {tab.label}
            </span>
          </button>
        )
      })}
    </div>
  )
}
