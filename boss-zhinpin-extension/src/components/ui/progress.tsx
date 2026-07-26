import React from 'react'

interface ProgressProps {
  value: number
  className?: string
  color?: string
}

export function Progress({ value, className = '', color }: ProgressProps) {
  const clampedValue = Math.min(100, Math.max(0, value))

  return (
    <div className={`w-full bg-surface-darkest rounded-full h-2 overflow-hidden ${className}`}>
      <div
        className="h-full rounded-full transition-all duration-500 ease-out"
        style={{
          width: `${clampedValue}%`,
          background: color || `linear-gradient(90deg, #6366F1, #8B5CF6)`,
        }}
      />
    </div>
  )
}
