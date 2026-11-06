import React from 'react'

interface BadgeProps {
  children: React.ReactNode
  variant?: 'default' | 'success' | 'danger' | 'warning' | 'info'
  className?: string
}

export function Badge({ children, variant = 'default', className = '' }: BadgeProps) {
  // 徽章是安静的文字标签，不是发光药丸；语义色只在文字上表达
  const variants = {
    default: 'bg-surface-dark text-text-secondary',
    success: 'bg-success/10 text-success',
    danger: 'bg-danger/10 text-danger',
    warning: 'bg-warning/10 text-warning',
    info: 'bg-info/10 text-info',
  }

  return (
    <span className={`badge ${variants[variant]} ${className}`}>
      {children}
    </span>
  )
}
