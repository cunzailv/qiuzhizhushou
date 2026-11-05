// 悬浮窗与 AIbot 的统一控制状态。
// 单一真源是 chrome.storage.local（settings-store 的 setting_ 前缀），
// popup / options / content / background 都通过 storage.onChanged 订阅，
// 任意一侧修改都会同步到另外两侧。
import { getSetting, setSetting } from './db/settings-store'

export type PanelState = 'expanded' | 'collapsed' | 'closed'
export type AssistantApplyMode = 'batch' | 'recommend'

export interface AssistantControlState {
  /** 悬浮窗形态：展开 / 贴右侧收缩 / 关闭 */
  panelState: PanelState
  /** 投递模式：批量沟通 / AI 自动确认 */
  applyMode: AssistantApplyMode
  /** 是否启用 AI 评分 */
  enableAiMatch: boolean
  /** 猎聘是否走「投简历」模式 */
  liepinResumeMode: boolean
}

export const DEFAULT_ASSISTANT_STATE: AssistantControlState = {
  panelState: 'expanded',
  applyMode: 'batch',
  enableAiMatch: true,
  liepinResumeMode: false,
}

const STATE_KEYS = Object.keys(DEFAULT_ASSISTANT_STATE) as Array<keyof AssistantControlState>

export async function getAssistantState(): Promise<AssistantControlState> {
  const [panelState, applyMode, enableAiMatch, liepinResumeMode] = await Promise.all([
    getSetting<PanelState>('panelState', DEFAULT_ASSISTANT_STATE.panelState),
    getSetting<AssistantApplyMode>('applyMode', DEFAULT_ASSISTANT_STATE.applyMode),
    getSetting<boolean>('enableAiMatch', DEFAULT_ASSISTANT_STATE.enableAiMatch),
    getSetting<boolean>('liepinResumeMode', DEFAULT_ASSISTANT_STATE.liepinResumeMode),
  ])
  return { panelState, applyMode, enableAiMatch, liepinResumeMode }
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
 * 「关闭浮窗 = 关闭 AIbot」是一次运行时动作，不是永久偏好。
 * 页面重新加载 / 扩展重启时，残留的 closed 应恢复为展开，AIbot 仍保持停止。
 */
export function normalizeInitialPanelState(
  state: AssistantControlState,
): AssistantControlState {
  return state.panelState === 'closed'
    ? { ...state, panelState: 'expanded' }
    : state
}
