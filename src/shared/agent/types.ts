// ─── Page State (发给 AI 的页面快照) ───

export interface ButtonInfo {
  index: number
  text: string
  tag: string
  visible: boolean
  enabled: boolean
}

export interface InputInfo {
  index: number
  tag: string
  placeholder: string
  visible: boolean
}

export interface DialogInfo {
  index: number
  textSample: string   // 前 150 字符
  classes: string      // className 前 60 字符
}

export interface PageState {
  platform: string
  pageType: string
  goal: string
  buttons: ButtonInfo[]
  inputs: InputInfo[]
  dialogs: DialogInfo[]
  keyTexts: string[]
  url: string
}

// ─── Agent Actions ───

export type ActionType = 'click' | 'type' | 'wait' | 'scroll' | 'press_enter' | 'press_escape' | 'done'

export interface ActionTarget {
  kind: 'button_text' | 'button_index' | 'input_index' | 'css_selector'
  value: string
}

export interface AgentAction {
  type: ActionType
  target?: ActionTarget
  text?: string      // for 'type'
  duration?: number  // for 'wait' (ms)
  scrollTo?: 'bottom' | 'top'
}

export interface AgentStep {
  thinking: string
  action: AgentAction
}

export interface AgentGoalResult {
  success: boolean
  goal: string
  steps: AgentStep[]
  attempts: number
  error?: string
  usedCachedSkill: boolean
}

// ─── Skill Memory ───

export interface AgentSkill {
  id: string
  platform: string
  pageType: string
  goal: string
  steps: AgentStep[]
  successCount: number
  failCount: number
  createdAt: number
  lastUsedAt: number
  expiresAt: number
  selectorSignature: string
}
