import { chatCompletion } from '../ai/api-client'
import { capturePageState } from './page-observer'
import { executeAction } from './action-executor'
import { findBestSkill, upsertSkill, computeSignature, recordSkillFail } from './skill-memory'
import { buildUserPrompt, SYSTEM_PROMPT } from './prompts'
import type { AgentGoalResult, AgentStep, PageState } from './types'
import { randomDelay } from '../antiBot'

const MAX_ATTEMPTS = 5

function verifyGoal(goal: string, _before: PageState, after: PageState): boolean {
  switch (goal) {
    case 'open_detail':
      // 新弹窗出现 或 沟通/收藏按钮出现
      return after.dialogs.length > 0
        || after.buttons.some(b => b.text.includes('沟通') || b.text.includes('收藏') || b.text.includes('投递'))
    case 'click_chat':
      // 输入框出现 或 新弹窗
      return after.inputs.length > 0
        || after.dialogs.length > 0
    case 'send_greeting':
      // 弹窗消失 或 成功文本出现
      return after.keyTexts.some(t => t.includes('发送成功') || t.includes('已发送') || t.includes('投递成功'))
        || (after.inputs.length === 0 && after.dialogs.length === 0)
    default:
      return false
  }
}

function parseAIResponse(raw: string): AgentStep | null {
  try {
    // 提取 JSON
    const match = raw.match(/\{[\s\S]*\}/)
    if (!match) return null
    const parsed = JSON.parse(match[0])
    if (!parsed.action || !parsed.action.type) return null
    return {
      thinking: parsed.thinking || '',
      action: parsed.action,
    }
  } catch {
    return null
  }
}

/**
 * ReAct 循环：采集页面 → 问 AI → 执行 → 验证 → 重复。
 * 先查 Skill 缓存，命中直接回放。
 */
export async function reactLoop(
  platform: string,
  pageType: string,
  goal: string,
  context: Record<string, string>,
  onThinking?: (text: string) => void
): Promise<AgentGoalResult> {
  // 1. 查 Skill 缓存
  const cachedSkill = await findBestSkill(platform, pageType, goal)
  if (cachedSkill) {
    const currentState = capturePageState(platform, goal, pageType)
    const currentSig = computeSignature(currentState)
    // 页面结构变了 → 跳过缓存
    if (currentSig === cachedSkill.selectorSignature || currentSig.split('|').length >= cachedSkill.selectorSignature.split('|').length * 0.5) {
      onThinking?.('使用缓存技能...')
      let allOk = true
      for (const step of cachedSkill.steps) {
        const res = await executeAction(step.action)
        if (!res.ok) { allOk = false; break }
        await randomDelay(400, 800)
      }
      if (allOk) {
        await upsertSkill({
          platform, pageType, goal,
          steps: cachedSkill.steps,
          selectorSignature: cachedSkill.selectorSignature,
        })
        return { success: true, goal, steps: cachedSkill.steps, attempts: 1, usedCachedSkill: true }
      }
      await recordSkillFail(cachedSkill)
      onThinking?.('缓存技能失效，切换到AI推理...')
    }
  }

  // 2. ReAct 循环
  const steps: AgentStep[] = []
  let lastError = ''

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const pageState = capturePageState(platform, goal, pageType)

    // 构建 prompt
    const userPrompt = buildUserPrompt(pageState, steps, lastError, context)

    // 调 AI
    onThinking?.(`AI思考中 (${attempt + 1}/${MAX_ATTEMPTS})...`)
    const rawResponse = await chatCompletion(SYSTEM_PROMPT, userPrompt, 0.1)

    // 解析
    const step = parseAIResponse(rawResponse)
    if (!step) {
      lastError = 'AI响应解析失败'
      continue
    }
    onThinking?.(step.thinking)

    // 如果 AI 说完成了
    if (step.action.type === 'done') {
      steps.push(step)
      return { success: true, goal, steps, attempts: attempt + 1, usedCachedSkill: false }
    }

    // 执行
    const result = await executeAction(step.action)
    if (!result.ok) {
      lastError = result.error || '执行失败'
      steps.push(step)
      continue
    }
    steps.push(step)
    await randomDelay(500, 1200)

    // 验证
    const newState = capturePageState(platform, goal, pageType)
    if (verifyGoal(goal, pageState, newState)) {
      // 保存 Skill
      const sig = computeSignature(pageState)
      await upsertSkill({ platform, pageType, goal, steps: [...steps], selectorSignature: sig })
      return { success: true, goal, steps, attempts: attempt + 1, usedCachedSkill: false }
    }

    lastError = ''
  }

  return {
    success: false,
    goal,
    steps,
    attempts: MAX_ATTEMPTS,
    error: lastError || '已达最大尝试次数',
    usedCachedSkill: false,
  }
}
