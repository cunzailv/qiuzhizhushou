import React, { useCallback, useEffect, useState } from 'react'
import { getPlatformEntries, getSupportedUrlPatterns } from '../../shared/platform'
import type { PlatformEntry } from '../../shared/platform'
import { log } from '../../shared/utils/logger'
import { Disclosure } from '../../components/ui/disclosure'

const MOD = 'Popup:PlatformShortcuts'

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
      <Disclosure label="打开平台" hint="官网直达 · 已打开会自动切回">
        <div className="grid grid-cols-5 gap-2">
          {entries.map((entry) => {
            const isOpen = openedIds.includes(entry.id)
            return (
              <button
                key={entry.id}
                type="button"
                onClick={() => handleOpen(entry)}
                title={`打开 ${entry.name} — ${entry.homeUrl}`}
                aria-label={`打开 ${entry.name} 官网`}
                className="group relative flex flex-col items-center gap-1.5 rounded-xl border border-surface-hairline bg-surface-darkest px-1.5 py-2 transition-colors hover:bg-surface-dark"
              >
                {isOpen && (
                  <span
                    className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-success"
                    title="已有打开的页面"
                  />
                )}
                <span className="flex h-6 w-6 items-center justify-center rounded-md text-[13px] leading-none bg-surface-dark">
                  {entry.icon}
                </span>
                <span className="max-w-full truncate text-xs font-medium leading-tight text-text-primary">
                  {entry.name}
                </span>
              </button>
            )
          })}
        </div>
      </Disclosure>
    </div>
  )
}
