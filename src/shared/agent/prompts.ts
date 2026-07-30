import type { PageState, AgentStep } from './types'

export const SYSTEM_PROMPT = `你是网页自动化Agent。分析当前页面状态，决定下一步操作。

规则：
1. 优先用按钮文字匹配（button_text），class名不稳定易变
2. 点按钮前确保元素可见，需要时可先用scroll滚动到底部
3. 每次只返回一个动作
4. 任务已完成返回 type:"done"
5. 如果找不到精确按钮，可以用button_index尝试候选按钮
6. 输入框用input_index匹配

返回格式（严格JSON，不要markdown包裹）：
{"thinking":"中文推理20字内","action":{"type":"click","target":{"kind":"button_text","value":"立即沟通"}}}`

export function buildUserPrompt(
  state: PageState,
  previousSteps: AgentStep[],
  lastError: string,
  context: Record<string, string>
): string {
  const parts: string[] = []

  parts.push(`【平台】${state.platform}`)
  parts.push(`【页面类型】${state.pageType}`)

  const goalLabels: Record<string, string> = {
    open_detail: '打开岗位详情面板',
    click_chat: '点击"立即沟通"/"聊一聊"按钮发起沟通',
    send_greeting: '在输入框中填入招呼语并发送',
  }
  parts.push(`【任务目标】${goalLabels[state.goal] || state.goal}`)

  if (Object.keys(context).length > 0) {
    parts.push(`【上下文】${Object.values(context).filter(Boolean).join(' | ')}`)
  }

  if (state.buttons.length > 0) {
    parts.push(`\n【可见按钮】(共${state.buttons.length}个)`)
    parts.push(state.buttons.slice(0, 25).map(b =>
      `[${b.index}] <${b.tag}> "${b.text}" ${b.visible ? 'visible' : 'hidden'} ${b.enabled ? '' : 'disabled'}`
    ).join('\n'))
  }

  if (state.inputs.length > 0) {
    parts.push(`\n【输入框】`)
    parts.push(state.inputs.map(i =>
      `[${i.index}] <${i.tag}> placeholder="${i.placeholder}" ${i.visible ? 'visible' : 'hidden'}`
    ).join('\n'))
  }

  if (state.dialogs.length > 0) {
    parts.push(`\n【弹窗】`)
    parts.push(state.dialogs.map(d => `[${d.index}] "${d.textSample}"`).join('\n'))
  }

  if (state.keyTexts.length > 0) {
    parts.push(`\n【页面关键文本】`)
    parts.push(state.keyTexts.slice(0, 5).join(' | '))
  }

  if (previousSteps.length > 0) {
    parts.push(`\n【已尝试步骤】`)
    parts.push(previousSteps.map((s, i) =>
      `${i + 1}. 思考: ${s.thinking} → 动作: ${s.action.type} ${s.action.target?.value || ''}`
    ).join('\n'))
  }

  if (lastError) {
    parts.push(`\n【上一步失败原因】${lastError}`)
  }

  return parts.join('\n')
}
