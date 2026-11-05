// 悬浮窗与 AIbot 的统一控制状态。
// 单一真源是 chrome.storage.local（settings-store 的 setting_ 前缀），
// popup / options / content / background 都通过 storage.onChanged 订阅，
// 任意一侧修改都会同步到另外两侧。
import { getSetting, setSetting } from './db/settings-store'

/**
 * 侧栏/浮窗形态：
 * - expanded：网页右侧整高侧栏展开
 * - bubble：收起为右侧浮球（AIbot 继续运行，点击浮球或插件图标可再次展开）
 * - collapsed：沿右边缘的窄把手（旧形态，仅兼容历史数据）
 * - closed：关闭并停止 AIbot
 */
export type PanelState = 'expanded' | 'collapsed' | 'closed' | 'bubble'
export type AssistantApplyMode = 'batch' | 'recommend'

export interface AssistantControlState {
  /** 悬浮窗形态：侧栏展开 / 浮球收起 / 窄把手 / 关闭 */
  panelState: PanelState
  /** 置顶常驻：开启后不再自动收起，新页面也直接展开侧栏 */
  pinned: boolean
  /** 投递模式：批量沟通 / AI 自动确认 */
  applyMode: AssistantApplyMode
  /** 是否启用 AI 评分 */
  enableAiMatch: boolean
  /** 猎聘是否走「投简历」模式 */
  liepinResumeMode: boolean
}

export const DEFAULT_ASSISTANT_STATE: AssistantControlState = {
  panelState: 'expanded',
  pinned: false,
  applyMode: 'batch',
  enableAiMatch: true,
  liepinResumeMode: false,
}

const STATE_KEYS = Object.keys(DEFAULT_ASSISTANT_STATE) as Array<keyof AssistantControlState>

export async function getAssistantState(): Promise<AssistantControlState> {
  const [panelState, pinned, applyMode, enableAiMatch, liepinResumeMode] = await Promise.all([
    getSetting<PanelState>('panelState', DEFAULT_ASSISTANT_STATE.panelState),
    getSetting<boolean>('pinned', DEFAULT_ASSISTANT_STATE.pinned),
    getSetting<AssistantApplyMode>('applyMode', DEFAULT_ASSISTANT_STATE.applyMode),
    getSetting<boolean>('enableAiMatch', DEFAULT_ASSISTANT_STATE.enableAiMatch),
    getSetting<boolean>('liepinResumeMode', DEFAULT_ASSISTANT_STATE.liepinResumeMode),
  ])
  return { panelState, pinned, applyMode, enableAiMatch, liepinResumeMode }
}

/** 只写真正变化的字段，避免 storage.onChanged 回环刷新 */
export async function patchAssistantState(
  patch: Partial<AssistantControlState>,
): Promise<AssistantControlState> {
  const current = await getAssistantState()
  for (const key of STATE_KEYS) {
    const value = patch[key]
    if (value === undefined || current[key] === value) continue
    await setSetting(key, value)
  }
  return getAssistantState()
}

/** 订阅统一控制状态变化；返回取消订阅函数 */
export function subscribeAssistantState(
  listener: (state: AssistantControlState) => void,
): () => void {
  try {
    if (typeof chrome === 'undefined' || !chrome.storage?.onChanged) return () => {}
    const watched = new Set(STATE_KEYS.map((key) => `setting_${key}`))
    const handler = (
      changes: Record<string, chrome.storage.StorageChange>,
      areaName: string,
    ) => {
      if (areaName !== 'local') return
      if (!Object.keys(changes).some((key) => watched.has(key))) return
      getAssistantState().then(listener).catch(() => {})
    }
    chrome.storage.onChanged.addListener(handler)
    return () => chrome.storage.onChanged.removeListener(handler)
  } catch {
    return () => {}
  }
}

/**
 * 判断当前 campaign 任务是否应中止。
 * 同时检查本地取消标记与统一状态的 closed 形态：后者用于兜住
 * 「关闭广播尚未送达 / 后台恰好又派发了一个任务」的竞态窗口。
 */
export function isAssistantTaskCancelled(
  state: AssistantControlState,
  cancelFlag: boolean,
): boolean {
  return cancelFlag || state.panelState === 'closed'
}

/**
 * 「收起浮球 / 关闭 AIbot」都是一次性运行时动作，不是跨页面的永久偏好：
 * - 置顶常驻：新页面直接展开侧栏
 * - 其余情况：残留的 closed / bubble 恢复为展开，避免刷新后助手一直不可见
 */
export function normalizeInitialPanelState(
  state: AssistantControlState,
): AssistantControlState {
  if (state.pinned) return { ...state, panelState: 'expanded' }
  if (state.panelState === 'closed' || state.panelState === 'bubble') {
    return { ...state, panelState: 'expanded' }
  }
  return state
}
