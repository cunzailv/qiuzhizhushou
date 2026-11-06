import React from 'react'

interface ProgressProps {
  value: number
  className?: string
  color?: string
}

export function Progress({ value, className = '', color }: ProgressProps) {
  const clampedValue = Math.min(100, Math.max(0, value))

  return (
    <div className={`queue-rule h-2 rounded ${className}`}>
      <div
        className="queue-rule-fill h-full rounded transition-[width] duration-300"
        style={{
          width: `${clampedValue}%`,
          backgroundColor: color || '#C2410C',
        }}
      />
    </div>
  )
}
