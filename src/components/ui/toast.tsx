import React from 'react'

interface ToastProps {
  message: string
  type?: 'success' | 'error' | 'warning' | 'info'
  visible: boolean
  onClose: () => void
}

export function Toast({ message, type = 'info', visible, onClose }: ToastProps) {
  if (!visible) return null

  const colors = {
    success: 'border-success/25 text-success',
    error: 'border-danger/25 text-danger',
    warning: 'border-warning/25 text-warning',
    info: 'border-surface-hairline text-text-primary',
  }

  return (
    <div className="fixed bottom-4 right-4 z-[9999] animate-in fade-in-0 slide-in-from-bottom-2 duration-200">
      <div className={`flex items-center gap-2 px-4 py-3 rounded-lg border bg-surface-darkest shadow-float ${colors[type]}`}>
        <span className="text-sm font-medium">{message}</span>
        <button onClick={onClose} className="ml-2 text-text-muted hover:text-text-primary transition-colors" aria-label="关闭提示">
          ×
        </button>
      </div>
    </div>
  )
}
