import React, { useState } from 'react'
import { ChevronDown } from 'lucide-react'

interface DisclosureProps {
  label: string
  hint?: string
  defaultOpen?: boolean
  children: React.ReactNode
  className?: string
}

/**
 * 分层收纳：默认只露出一行标题，展开后才是完整控件。
 * 用于把低频设置从首屏移走，功能本身一个不删。
 */
export function Disclosure({
  label,
  hint,
  defaultOpen = false,
  children,
  className = '',
}: DisclosureProps) {
  const [open, setOpen] = useState(defaultOpen)

  return (
    <section className={`border border-surface-hairline rounded-xl bg-surface-darkest ${className}`}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="w-full flex items-center justify-between gap-2 px-3 py-2 text-left rounded-xl hover:bg-surface-dark transition-colors"
      >
        <span className="flex items-center gap-2 min-w-0">
          <span className="text-xs font-medium text-text-primary shrink-0">{label}</span>
          {hint && <span className="text-xs text-text-muted truncate">{hint}</span>}
        </span>
        <ChevronDown
          className={`w-3.5 h-3.5 shrink-0 text-text-muted transition-transform duration-150 ${open ? 'rotate-180' : ''}`}
        />
      </button>
      {open && (
        <div className="px-3 pb-3 pt-2 border-t border-surface-hairline">
          {children}
        </div>
      )}
    </section>
  )
}
