/**
 * 全局运行状态（单一真源：chrome.storage.local 的 setting_runtimeState）。
 *
 * 核心职责是「互斥锁」：概览的「开始批量沟通」是半自动（manual，页面内扫描 + 逐个沟通），
 * AIbot 是全自动（autopilot，后台调度多平台流水线）。二者绝不能同时跑，否则会抢同一个
 * 页面的 DOM、重复打招呼。任何一侧启动前都必须先向 background 申请锁，失败就禁用入口。
 *
 * popup / content / background / options 都通过 storage.onChanged 订阅同一份状态，
 * 因此按钮禁用、进度展示、运行徽标天然同步。
 */
import { getSetting, setSetting } from './db/settings-store'

export type RunMode = 'idle' | 'manual' | 'autopilot'
export type RunStatus = 'idle' | 'scanning' | 'matching' | 'applying' | 'paused' | 'done'

export interface RuntimeStats {
  processed: number
  total: number
  matched: number
}

/** 概览「批量沟通控制台」展示的最近匹配结果（只留最近 3 条，完整记录在追踪页） */
export interface RuntimeMatchItem {
  title: string
  companyName: string
  score: number
  recommended: boolean
  scoreBypassed?: boolean
  prefiltered?: boolean
}

export interface AssistantRuntimeState {
  /** 当前持锁的运行模式，idle 表示空闲 */
  mode: RunMode
  status: RunStatus
  stats: RuntimeStats
  message: string
  dailyRemaining: number | null
  /** 最近匹配结果（最新在前，最多 3 条） */
  recentMatches: RuntimeMatchItem[]
  /** 持锁起始时间，用于陈旧锁兜底 */
  startedAt: number | null
}

export const DEFAULT_RUNTIME_STATE: AssistantRuntimeState = {
  mode: 'idle',
  status: 'idle',
  stats: { processed: 0, total: 0, matched: 0 },
  message: '',
  dailyRemaining: null,
  recentMatches: [],
  startedAt: null,
}

/** 超过 2 小时的锁视为陈旧（刷新 / 崩溃后残留），允许被抢占 */
export const RUNTIME_STALE_MS = 2 * 60 * 60 * 1000

const STORAGE_KEY = 'runtimeState'
const WATCHED_KEY = `setting_${STORAGE_KEY}`

export function isRuntimeLockStale(state: AssistantRuntimeState, now = Date.now()): boolean {
  if (state.mode === 'idle' || state.startedAt === null) return false
  return now - state.startedAt > RUNTIME_STALE_MS
}

export async function getRuntimeState(): Promise<AssistantRuntimeState> {
  const stored = await getSetting<Partial<AssistantRuntimeState>>(STORAGE_KEY, {})
  return {
    ...DEFAULT_RUNTIME_STATE,
    ...stored,
    stats: { ...DEFAULT_RUNTIME_STATE.stats, ...(stored.stats ?? {}) },
    recentMatches: Array.isArray(stored.recentMatches) ? stored.recentMatches.slice(0, 3) : [],
  }
}

/** 只写变化的字段，避免 storage.onChanged 回环刷新 */
export async function patchRuntimeState(
  patch: Partial<AssistantRuntimeState>,
): Promise<AssistantRuntimeState> {
  const current = await getRuntimeState()
  const next: AssistantRuntimeState = { ...current, ...patch }
  const changed = (Object.keys(next) as Array<keyof AssistantRuntimeState>).some(
    (key) => JSON.stringify(next[key]) !== JSON.stringify(current[key]),
  )
  if (changed) await setSetting(STORAGE_KEY, next)
  return next
}

/**
 * 原子申请运行锁。只允许在 background 里调用（由消息入口串行化）。
 * - 空闲或自己的锁 → 成功
 * - 别人的锁且未过期 → 冲突
 * - 别人的锁但已陈旧 → 抢占成功
 */
export async function acquireRunMode(mode: Exclude<RunMode, 'idle'>): Promise<{
  ok: boolean
  state: AssistantRuntimeState
  conflict?: RunMode
  staleTakenOver?: boolean
}> {
  const current = await getRuntimeState()
  const stale = isRuntimeLockStale(current)
  if (current.mode !== 'idle' && current.mode !== mode && !stale) {
    return { ok: false, state: current, conflict: current.mode }
  }
  const state = await patchRuntimeState({
    mode,
    status: 'scanning',
    stats: { processed: 0, total: 0, matched: 0 },
    message: mode === 'manual' ? '半自动批量沟通已启动' : 'AIbot 全自动流水线已启动',
    recentMatches: [],
    dailyRemaining: null,
    startedAt: Date.now(),
  })
  return { ok: true, state, staleTakenOver: stale && current.mode !== 'idle' }
}

/** 释放自己持有的锁；不是自己的锁不动作，避免误清对方状态 */
export async function releaseRunMode(mode: RunMode): Promise<AssistantRuntimeState> {
  const current = await getRuntimeState()
  if (mode !== 'idle' && current.mode !== mode) return current
  return patchRuntimeState({
    mode: 'idle',
    status: current.status === 'paused' ? 'paused' : 'done',
    message: '',
    startedAt: null,
  })
}

/**
 * content 侧上报半自动批量沟通进度（概览控制台据此渲染状态 / 进度 / 最近匹配）。
 * 只在「未处于全自动」时写，避免干扰 AIbot 的 runtime 状态；不会修改 mode / startedAt，
 * 因此不会复活已经释放的互斥锁。
 */
export async function reportBatchProgress(
  patch: Partial<Pick<AssistantRuntimeState, 'status' | 'stats' | 'message' | 'dailyRemaining' | 'recentMatches'>>,
): Promise<void> {
  const current = await getRuntimeState()
  if (current.mode === 'autopilot') return
  await patchRuntimeState(patch)
}

/** 订阅全局运行状态；返回取消订阅函数 */
export function subscribeRuntimeState(
  listener: (state: AssistantRuntimeState) => void,
): () => void {
  try {
    if (typeof chrome === 'undefined' || !chrome.storage?.onChanged) return () => {}
    const handler = (
      changes: Record<string, chrome.storage.StorageChange>,
      areaName: string,
    ) => {
      if (areaName !== 'local' || !changes[WATCHED_KEY]) return
      getRuntimeState().then(listener).catch(() => {})
    }
    chrome.storage.onChanged.addListener(handler)
    return () => chrome.storage.onChanged.removeListener(handler)
  } catch {
    return () => {}
  }
}
