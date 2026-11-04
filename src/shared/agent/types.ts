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

export type SkillPatchSource = 'heuristic' | 'llm' | 'manual'

export interface SelectorFingerprint {
  /** 发现的有效 CSS 选择器路径（如 button.btn-startchat 或 [ka*="startchat"]） */
  cssSelector: string
  /** 按钮文字特征 */
  buttonText: string
  /** 目标容器类名或上下文特征 */
  containerClass?: string
  /** 复合哈希或指纹签名字符串 */
  signature: string
  /** 元素标签（可选，如 'button', 'a'） */
  tag?: string
  /** 元素关键属性（可选） */
  attributes?: Record<string, string>
}

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
  /** F3：后台启停开关；false 时 findBestSkill 不再命中 */
  enabled?: boolean
  /** 结构化选择器指纹详情（可选补充） */
  fingerprint?: SelectorFingerprint
  /** 技能来源：启发式探索 / LLM感知 / 手工注入 */
  patchSource?: SkillPatchSource
  /** 建议修改固化的规则或说明（供 R5 事后归因与待修清单消费） */
  remediationNotes?: string
}
