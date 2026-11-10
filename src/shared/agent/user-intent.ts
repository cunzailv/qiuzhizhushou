/**
 * 用户显式意图锁 —— 目标必达模式**不得接管**的硬约束。
 *
 * 现场问题（2026-11-10）：
 *  1、插件关闭了，有时候自动打开
 *  2、平台关闭了投递了，总是自动打开，一开启投递又自动打开了
 *
 * 根因是必达模式把「用户关掉的东西」也当成了可控参数：
 *  - `planMustAchieveQuotas()` 每轮规划都把 `enabled === false` 的平台列进 enablePlatforms，
 *    `applyMustAchieveTakeover()` 在 start / goal / blocked / watchdog / tick 里反复
 *    `togglePlatformEnabled(pid, true)`，用户刚关掉就被拉回来；
 *  - 周期 `must-achieve-watchdog` alarm 在 shutdown 时**故意没清**（注释写「负责按必达规则
 *    按时把流水线拉回来」），15 分钟冷却一过就 resume，后台复活后又下发任务，
 *    content 侧 `EXECUTE_CAMPAIGN_TASK` 会 `createFloatingPanel()` → 浮窗自己冒出来。
 *
 * 所以意图不能存在 campaign.quotas 里（会被接管覆盖），必须单独持久化。
 * 规则很简单：**用户手动关的，系统不许开；用户自己重新开，才算解除。**
 */
import type { PlatformId } from './quota'

/** 用户是否主动关闭了 AIbot（true = 彻底停机，看门狗不得复活） */
export const USER_STOPPED_KEY = 'aibot_user_stopped'
/** 用户手动关闭的平台列表 */
export const USER_DISABLED_PLATFORMS_KEY = 'aibot_user_disabled_platforms'

export async function readUserStopped(): Promise<boolean> {
  try {
    const res = await chrome.storage.local.get(USER_STOPPED_KEY)
    return res?.[USER_STOPPED_KEY] === true
  } catch {
    return false
  }
}

export async function setUserStopped(stopped: boolean): Promise<void> {
  try {
    if (stopped) await chrome.storage.local.set({ [USER_STOPPED_KEY]: true })
    else await chrome.storage.local.remove(USER_STOPPED_KEY)
  } catch {
    // 写不进去最多退化成旧行为，不阻断关闭/启动
  }
}

export async function readUserDisabledPlatforms(): Promise<PlatformId[]> {
  try {
    const res = await chrome.storage.local.get(USER_DISABLED_PLATFORMS_KEY)
    const raw = res?.[USER_DISABLED_PLATFORMS_KEY]
    return Array.isArray(raw)
      ? raw.filter((p): p is PlatformId => typeof p === 'string')
      : []
  } catch {
    return []
  }
}

/** 用户手动关平台 → 记入保护名单；手动开回来 → 移出保护名单 */
export async function setUserDisabledPlatform(
  platform: PlatformId,
  disabled: boolean,
): Promise<void> {
  try {
    const current = await readUserDisabledPlatforms()
    const next = disabled
      ? Array.from(new Set([...current, platform]))
      : current.filter((p) => p !== platform)
    if (next.length > 0) {
      await chrome.storage.local.set({ [USER_DISABLED_PLATFORMS_KEY]: next })
    } else {
      await chrome.storage.local.remove(USER_DISABLED_PLATFORMS_KEY)
    }
  } catch {
    // 忽略存储异常
  }
}

/** 纯函数：按「本次启动勾选的平台」推导出应被保护的平台，便于单测 */
export function resolveUserDisabledPlatforms(
  allPlatforms: readonly PlatformId[],
  enabledPlatforms?: readonly PlatformId[] | null,
): PlatformId[] {
  if (!enabledPlatforms || enabledPlatforms.length === 0) return []
  return allPlatforms.filter((p) => !enabledPlatforms.includes(p))
}

/** 启动时用户只勾选了部分平台，其余也算「用户显式关闭」，同步进保护名单 */
export async function syncUserDisabledPlatforms(
  allPlatforms: readonly PlatformId[],
  enabledPlatforms?: readonly PlatformId[] | null,
): Promise<void> {
  if (!enabledPlatforms || enabledPlatforms.length === 0) return
  const disabled = resolveUserDisabledPlatforms(allPlatforms, enabledPlatforms)
  try {
    if (disabled.length > 0) {
      await chrome.storage.local.set({ [USER_DISABLED_PLATFORMS_KEY]: disabled })
    } else {
      await chrome.storage.local.remove(USER_DISABLED_PLATFORMS_KEY)
    }
  } catch {
    // 忽略存储异常
  }
}
