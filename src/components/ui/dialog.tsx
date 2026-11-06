import React from 'react'

interface DialogProps {
  open: boolean
  onClose: () => void
  title?: string
  children: React.ReactNode
  className?: string
}

export function Dialog({ open, onClose, title, children, className = '' }: DialogProps) {
  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="fixed inset-0 bg-black/40" onClick={onClose} />
      <div className={`relative bg-surface-darkest border border-surface-hairline rounded-2xl shadow-float p-6 max-w-lg w-full mx-4 max-h-[80vh] overflow-y-auto ${className}`}>
        {title && (
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-base font-medium text-text-primary">{title}</h2>
            <button onClick={onClose} className="text-text-muted hover:text-text-primary text-xl leading-none transition-colors" aria-label="关闭弹窗">
              ×
            </button>
          </div>
        )}
        {children}
      </div>
    </div>
  )
}
