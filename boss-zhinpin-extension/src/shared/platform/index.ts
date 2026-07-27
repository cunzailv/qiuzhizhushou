// 平台注册表与运行时管理器。
// - 按当前网址自动识别平台（默认行为）
// - 支持 storage 中的手动覆盖（设置页可选），满足「自动识别 + 手动可选」
import { bossAdapter } from './boss'
import { liepinAdapter } from './liepin'
import { getSetting } from '../db/settings-store'
import type { PlatformAdapter } from './types'

export const PLATFORMS: PlatformAdapter[] = [bossAdapter, liepinAdapter]

// 手动覆盖策略的 storage key；值为 'auto' 或某个平台 id（如 'boss' / 'liepin'）。
export const PLATFORM_OVERRIDE_KEY = 'platformOverride'

export function detectPlatformByUrl(url: string): PlatformAdapter | null {
  return PLATFORMS.find((p) => p.matchesUrl(url)) ?? null
}

// 获取当前活动平台：优先使用手动覆盖，其次按网址自动识别，兜底为 Boss。
export async function getActivePlatform(): Promise<PlatformAdapter> {
  try {
    const override = await getSetting<string>(PLATFORM_OVERRIDE_KEY, 'auto')
    if (override && override !== 'auto') {
      const forced = PLATFORMS.find((p) => p.id === override)
      if (forced) return forced
    }
  } catch {
    // 读取失败则回退到自动识别
  }
  return detectPlatformByUrl(window.location.href) ?? bossAdapter
}

export function getPlatformsMeta(): Array<{ id: string; name: string; icon: string }> {
  return PLATFORMS.map((p) => ({ id: p.id, name: p.name, icon: p.icon }))
}

export function getPlatformById(id: string): PlatformAdapter | undefined {
  return PLATFORMS.find((p) => p.id === id)
}

// 各平台在 manifest 中声明的 content_scripts 匹配模式，供 popup 查找当前已打开的招聘页面。
export function getSupportedUrlPatterns(): string[] {
  return [
    'https://www.zhipin.com/*',
    'https://zhipin.com/*',
    'https://*.zhipin.com/*',
    'https://www.liepin.com/*',
    'https://liepin.com/*',
    'https://*.liepin.com/*',
  ]
}
