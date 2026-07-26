import React from 'react'

interface TabsProps {
  tabs: Array<{ id: string; label: string; icon?: React.ReactNode }>
  activeTab: string
  onTabChange: (id: string) => void
  className?: string
}

export function Tabs({ tabs, activeTab, onTabChange, className = '' }: TabsProps) {
  return (
    <div className={`flex gap-1 p-1 bg-surface-darkest rounded-xl ${className}`}>
      {tabs.map((tab) => (
        <button
          key={tab.id}
          onClick={() => onTabChange(tab.id)}
          className={`tab-button flex items-center gap-1.5 flex-1 justify-center ${
            activeTab === tab.id ? 'tab-button-active' : 'tab-button-inactive'
          }`}
        >
          {tab.icon}
          {tab.label}
        </button>
      ))}
    </div>
  )
}
