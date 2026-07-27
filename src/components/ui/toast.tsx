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
    success: 'bg-success/20 border-success/50 text-success',
    error: 'bg-danger/20 border-danger/50 text-danger',
    warning: 'bg-warning/20 border-warning/50 text-warning',
    info: 'bg-info/20 border-info/50 text-info',
  }

  return (
    <div className="fixed bottom-4 right-4 z-[9999] animate-in slide-in-from-bottom-4">
      <div className={`flex items-center gap-2 px-4 py-3 rounded-xl border ${colors[type]} shadow-lg backdrop-blur-md`}>
        <span className="text-sm font-medium">{message}</span>
        <button onClick={onClose} className="ml-2 opacity-60 hover:opacity-100">
          ×
        </button>
      </div>
    </div>
  )
}
