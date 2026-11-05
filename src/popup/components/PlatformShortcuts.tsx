import React, { useCallback, useEffect, useState } from 'react'
import { getPlatformEntries, getSupportedUrlPatterns } from '../../shared/platform'
import type { PlatformEntry } from '../../shared/platform'
import { log } from '../../shared/utils/logger'

const MOD = 'Popup:PlatformShortcuts'

// 各平台品牌色（用于图标底色与 hover 高亮），未登记的平台回退主题橙。
const BRAND_COLORS: Record<string, string> = {
  boss: '#00BEBD',
  liepin: '#FF6A00',
  '51job': '#0D8CE8',
  zhaopin: '#2F6BFF',
  maimai: '#0E7CE0',
}

const FALLBACK_COLOR = '#F97316'

// 查询当前窗口已打开的招聘平台标签页，用于点亮「已打开」小圆点。
async function collectOpenedPlatformIds(entries: PlatformEntry[]): Promise<string[]> {
  try {
    const tabs = await chrome.tabs.query({ url: getSupportedUrlPatterns() })
    return entries
      .filter((entry) => tabs.some((tab) => tab.url && entry.matchesUrl(tab.url)))
      .map((entry) => entry.id)
  } catch (error) {
    log(MOD, 'collectOpenedPlatformIds', 'Unable to inspect open tabs', error)
    return []
  }
}

export default function PlatformShortcuts() {
  const entries = getPlatformEntries()
  const [openedIds, setOpenedIds] = useState<string[]>([])

  useEffect(() => {
    collectOpenedPlatformIds(getPlatformEntries()).then(setOpenedIds)
  }, [])

  // 点击直达：若该平台已有标签页则切回，否则新开平台官网。
  const handleOpen = useCallback(async (entry: PlatformEntry) => {
    try {
      const tabs = await chrome.tabs.query({ url: getSupportedUrlPatterns() })
      const existing = tabs.find((tab) => tab.id && tab.url && entry.matchesUrl(tab.url))

      if (existing?.id) {
        await chrome.tabs.update(existing.id, { active: true })
        if (typeof existing.windowId === 'number') {
          await chrome.windows.update(existing.windowId, { focused: true })
        }
        window.close()
        return
      }

      await chrome.tabs.create({ url: entry.homeUrl })
      window.close()
    } catch (error) {
      log(MOD, 'handleOpen', `Failed to open ${entry.name}`, error)
      // 兜底：退化为当前窗口打开，避免点击无反馈。
      window.open(entry.homeUrl, '_blank', 'noopener,noreferrer')
    }
  }, [])

  return (
    <div className="px-3.5 pt-3 pb-3">
      <div className="mb-2 flex items-center justify-between px-0.5">
        <span className="text-[11px] font-semibold text-text-secondary">平台直达</span>
        <span className="text-[10px] text-text-muted">点击跳转官网 · 已打开会自动切回</span>
      </div>
      <div className="grid grid-cols-5 gap-2">
        {entries.map((entry) => {
          const color = BRAND_COLORS[entry.id] ?? FALLBACK_COLOR
          const isOpen = openedIds.includes(entry.id)
          return (
            <button
              key={entry.id}
              type="button"
              onClick={() => handleOpen(entry)}
              title={`打开 ${entry.name} — ${entry.homeUrl}`}
              aria-label={`打开 ${entry.name} 官网`}
              style={{ '--brand': color } as React.CSSProperties}
              className="group relative flex flex-col items-center gap-1.5 rounded-xl border border-black/10 bg-white px-1.5 py-2 transition-all hover:-translate-y-0.5 hover:border-[color:var(--brand)] hover:shadow-sm active:translate-y-0"
            >
              {isOpen && (
                <span
                  className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full"
                  style={{ backgroundColor: color }}
                  title="已有打开的页面"
                />
              )}
              <span
                className="flex h-6 w-6 items-center justify-center rounded-md text-[13px] leading-none"
                style={{ backgroundColor: `${color}1A` }}
              >
                {entry.icon}
              </span>
              <span className="max-w-full truncate text-[11px] font-medium leading-tight text-text-primary group-hover:text-[color:var(--brand)]">
                {entry.name}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
