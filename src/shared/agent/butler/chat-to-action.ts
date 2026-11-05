// 对话式管家智能中控 (Chat-to-Action) 调度核心
// 融合 CopilotKit Action 规范 + Vercel AI SDK 客户端工具调用 + 本地高精度确定性降级规则

import { findAction, getRegisteredActions, type ButlerActionResult } from './actions-registry'
import { chatCompletion } from '../../ai/api-client'
import { sanitizeJobText } from '../../utils/text-sanitizer'

export interface PendingApprovalAction {
  actionId: string
  actionName: string
  displayName: string
  args: any
  prompt: string
  createdAt: string
}

export interface ButlerChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  createdAt: string
  actionResult?: {
    actionName: string
    displayName: string
    success: boolean
    message: string
  }
  pendingApproval?: PendingApprovalAction
}

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substring(2)
}

/**
 * 确定性规则意图提取器 (Deterministic Intent Matcher)
 * 离线、0延迟、零Token成本，高精度匹配常用系统管理与数据库更新指令
 */
export function matchDeterministicAction(input: string): { actionName: string; args: any } | null {
  const text = input.trim()

  // 1. 修改期望薪资，如 "期望薪资改为 20-30K" / "薪资改成 18 到 25k"
  const salaryMatch = text.match(/(?:期望)?(?:薪资|月薪|待遇)(?:改成|设为|设置成|调成|改为|为)?\s*(\d+)\s*(?:-|至|到)\s*(\d+)\s*k/i)
  if (salaryMatch) {
    const min = parseInt(salaryMatch[1], 10)
    const max = parseInt(salaryMatch[2], 10)
    return {
      actionName: 'update_candidate_preferences',
      args: { expectedSalaryMin: min, expectedSalaryMax: max },
    }
  }

  // 2. 修改到岗时间与在职状态，如 "到岗时间设为最快1周到岗" / "改为离职随时到岗"
  if (/(最快\d+周到岗|最快\d+天到岗|1周内|2周内|1个月内|随时到岗)/.test(text)) {
    const allDaysMatches = Array.from(text.matchAll(/(最快\d+周到岗|最快\d+天到岗|1周内|2周内|1个月内|随时到岗)/g)).map((m) => m[0])
    // 优先选取更具体的如 "最快1周到岗"
    const availableDays = allDaysMatches.find((m) => m !== '随时到岗') || allDaysMatches[0] || '随时到岗'
    let employmentStatus: 'unemployed_immediate' | 'employed_month' | 'employed_exploring' | undefined
    if (text.includes('在职') && text.includes('月')) {
      employmentStatus = 'employed_month'
    } else if (text.includes('在职')) {
      employmentStatus = 'employed_exploring'
    } else if (text.includes('离职') || text.includes('随时到岗')) {
      employmentStatus = 'unemployed_immediate'
    }
    return {
      actionName: 'update_candidate_preferences',
      args: {
        availableDays,
        ...(employmentStatus ? { employmentStatus } : {}),
      },
    }
  }

  // 3. 修改求职底线，如 "增加底线：不接受单休" / "加一条底线 不接受外包"
  const bottomLineMatch = text.match(/(?:加|增|设置)?(?:一条)?底线[:：\s]+([^\n,，。！]+)/)
  if (bottomLineMatch) {
    return {
      actionName: 'update_candidate_preferences',
      args: { customBottomLines: bottomLineMatch[1].trim() },
    }
  }

  // 4. 更新简历技能栈，如 "简历增加技能 Docker、K8s" / "技能加上 React, Vue"
  const addSkillMatch = text.match(/(?:简历|技能)?(?:加上|增加|添加|增补)\s*(?:技能|技术栈)?\s*[:：]?\s*([a-zA-Z0-9.+#\s、，,]+)/i)
  if (addSkillMatch && !text.includes('底线')) {
    const skills = addSkillMatch[1]
      .split(/[,，、\s]+/)
      .map((s) => s.trim())
      .filter(Boolean)
    if (skills.length > 0) {
      return {
        actionName: 'update_resume_content',
        args: { addSkills: skills },
      }
    }
  }

  // 5. 调整工作时段窗口，如 "工作时间设为 09:30-18:00"
  const hoursMatch = text.match(/(?:工作时段|工作时间|运行时间)(?:改成|设为|改为)?\s*(\d{1,2}:\d{2})\s*(?:-|至|到)\s*(\d{1,2}:\d{2})/)
  if (hoursMatch) {
    const workingHours = `${hoursMatch[1]}-${hoursMatch[2]}`
    return {
      actionName: 'update_schedule_and_pacing',
      args: { workingHours },
    }
  }

  // 6. 调整拟人间歇，如 "拟人间歇设为 60-120 秒" / "间歇改成 45-180s"
  const intervalMatch = text.match(/(?:拟人间歇|拟人间隔|随机等待|间歇时间)(?:改成|设为|改为)?\s*(\d+)\s*(?:-|至|到)\s*(\d+)\s*(?:秒|s)/i)
  if (intervalMatch) {
    const minInterval = parseInt(intervalMatch[1], 10)
    const maxInterval = parseInt(intervalMatch[2], 10)
    return {
      actionName: 'update_schedule_and_pacing',
      args: { minInterval, maxInterval },
    }
  }

  // 7. 调整每日配额，如 "每日上限设为 50 次" / "配额改成 30"
  const quotaMatch = text.match(/(?:每日|每天)?(?:投递)?(?:上限|配额|额度)(?:改成|设为|改为)?\s*(\d+)\s*(?:次|个|家)?/)
  if (quotaMatch) {
    const dailyQuota = parseInt(quotaMatch[1], 10)
    return {
      actionName: 'update_schedule_and_pacing',
      args: { dailyQuota },
    }
  }

  // 8. 导出投递报表，如 "导出今天的投递记录为 CSV" / "下载投递报表"
  if (/(?:导出|下载).*(?:投递|记录|数据|报表|csv|表格)/i.test(text)) {
    let dateRange: 'today' | 'week' | 'all' = 'all'
    if (text.includes('今天') || text.includes('今日')) dateRange = 'today'
    else if (text.includes('本周') || text.includes('最近7天')) dateRange = 'week'
    return {
      actionName: 'export_applications_csv',
      args: { dateRange },
    }
  }

  // 9. 查询投递统计与漏斗，如 "今天投了多少家" / "分析今天投递" / "回复率怎么样" / "查看投递看板"
  if (/(?:投了多少|投递统计|投递漏斗|数据看板|回复率|战报|今日投递|面试统计|查一下投递|分析.*投递|投递分析|复盘.*投递)/.test(text)) {
    const isToday = text.includes('今天') || text.includes('今日')
    const isAnalyze = text.includes('分析') || text.includes('复盘')
    return {
      actionName: 'query_application_stats',
      args: {
        period: isToday ? 'today' : 'all',
        analyze: isAnalyze,
      },
    }
  }

  // 10. 拉黑公司或关键词，如 "把 XX科技加入公司黑名单" / "拉黑XX公司"
  const blacklistMatch =
    text.match(/(?:把|将)?\s*(.+?)\s*(?:加入|添加到|拉入|拉黑)\s*(?:公司)?黑名单/) ||
    text.match(/拉黑\s*([^\s,，。！]+)/)

  if (blacklistMatch) {
    const rawVal = (blacklistMatch[1] || blacklistMatch[2] || '').trim()
    const comp = rawVal.replace(/^(把|将)\s*/, '').replace(/(?:公司|企业|科技)$/, '').trim()
    if (comp && !['清空', '导出', '查询'].includes(comp)) {
      return {
        actionName: 'manage_blacklist',
        args: { type: 'company', value: comp },
      }
    }
  }

  // 11. 清空待投队列 / 重新获取岗位，如 "清空待投队列" / "清空待投" / "重新抓取" / "页面换了清空队列"
  if (
    /(?:清空|重置|清除).*(?:待投|待投队列|队列|未投)/.test(text) ||
    /(?:重新抓取|重新获取|重新采|重获|页面换了).*(?:岗位|职位|队列)?/.test(text)
  ) {
    return {
      actionName: 'clear_pending_queue',
      args: { recollect: true },
    }
  }

  // 12. 高危动作：清空投递记录，如 "清空投递记录" / "清除所有历史记录"
  if (/(?:清空|清除|重置).*(?:投递记录|所有记录|历史数据)/.test(text)) {
    return {
      actionName: 'clear_history_data',
      args: { scope: 'all' },
    }
  }

  return null
}

/**
 * 通过 LLM 语义识别复杂的复合指令 (LLM Tool Calling)
 */
async function parseIntentViaLLM(userInput: string): Promise<{ actionName: string; args: any; reply?: string } | null> {
  const tools = getRegisteredActions().map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }))

  const systemPrompt = `你是一个专业的求职 Bot 对话中控管家。
你可以理解求职者的自然语言指令，并将其映射到相应的系统操作 Action 中。
支持的 Actions 列表：
${JSON.stringify(tools, null, 2)}

如果用户的指令对应某个系统操作，请严格返回如下 JSON 结构（严禁包含其他说明文字）：
{"action": "action_name", "args": { ... }, "reply": "简短的确认人设口语"}

如果用户的输入只是日常闲聊或问候，不对应任何配置修改，请返回：
{"action": null, "args": {}, "reply": "你的友好回答"}`

  try {
    const raw = await chatCompletion(systemPrompt, userInput, 0.1)
    if (!raw) return null
    const jsonMatch = raw.match(/\{[\s\S]*\}/)
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0])
      if (parsed.action) {
        return {
          actionName: parsed.action,
          args: parsed.args || {},
          reply: parsed.reply,
        }
      } else if (parsed.reply) {
        return { actionName: '', args: {}, reply: parsed.reply }
      }
    }
  } catch {
    // 降级使用规则引擎
  }
  return null
}

/**
 * 对话即操作总入口 (Chat-to-Action Dispatcher)
 * 处理用户输入，执行工具并生成自然语言反馈卡片
 */
export async function dispatchButlerChatMessage(
  userInput: string,
  confirmedAction?: PendingApprovalAction,
): Promise<ButlerChatMessage> {
  const now = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })

  // ─── 场景 A：用户在界面中点击了「审批确认卡」继续执行 ───
  if (confirmedAction) {
    const action = findAction(confirmedAction.actionName)
    if (action) {
      const result = await action.handler(confirmedAction.args)
      return {
        id: generateId(),
        role: 'assistant',
        content: result.message,
        createdAt: now,
        actionResult: {
          actionName: action.name,
          displayName: action.displayName,
          success: result.success,
          message: result.message,
        },
      }
    }
  }

  // ─── 场景 B：全新输入指令 ───
  // 1. 先进行确定性规则匹配（0延迟、100%确定、无需API Key）
  let matched = matchDeterministicAction(userInput)

  // 2. 若规则未命中，尝试走 LLM 深度意图解析
  let llmCustomReply: string | undefined
  if (!matched) {
    const llmResult = await parseIntentViaLLM(userInput)
    if (llmResult?.actionName) {
      matched = { actionName: llmResult.actionName, args: llmResult.args }
      llmCustomReply = llmResult.reply
    } else if (llmResult?.reply) {
      return {
        id: generateId(),
        role: 'assistant',
        content: sanitizeJobText(llmResult.reply),
        createdAt: now,
      }
    }
  }

  // 3. 命中了具体的 Action
  if (matched?.actionName) {
    const action = findAction(matched.actionName)
    if (!action) {
      return {
        id: generateId(),
        role: 'assistant',
        content: `抱歉，暂未找到对应的功能操作【${matched.actionName}】。`,
        createdAt: now,
      }
    }

    // 🛡️ 人机协同安全护栏：若属于 isDangerous 操作，拦截执行并返回审批卡片
    if (action.isDangerous) {
      const pending: PendingApprovalAction = {
        actionId: generateId(),
        actionName: action.name,
        displayName: action.displayName,
        args: matched.args,
        prompt: `⚠️ **高风险破坏性操作审批提醒**\n您正在申请【${action.displayName}】。该操作将清空本地全部历史投递数据且不可撤销，请谨慎确认。`,
        createdAt: now,
      }
      return {
        id: generateId(),
        role: 'assistant',
        content: pending.prompt,
        createdAt: now,
        pendingApproval: pending,
      }
    }

    // 普通低风险操作直接执行
    try {
      const res: ButlerActionResult = await action.handler(matched.args)
      const replyContent = llmCustomReply
        ? `${llmCustomReply}\n\n${res.message}`
        : res.message
      return {
        id: generateId(),
        role: 'assistant',
        content: replyContent,
        createdAt: now,
        actionResult: {
          actionName: action.name,
          displayName: action.displayName,
          success: res.success,
          message: res.message,
        },
      }
    } catch (err: any) {
      return {
        id: generateId(),
        role: 'assistant',
        content: `执行操作【${action.displayName}】时遇到异常：${err?.message || err}`,
        createdAt: now,
      }
    }
  }

  // 4. 未匹配到任何系统动作时的通用温馨引导
  const fallbackGuide = `您好！我是您的求职 Bot 智能管家。您可以直接对我下达自然语言指令来管理系统与数据库，例如：
- 💰 *“帮我把期望薪资调成 20-30K”*
- 🕒 *“工作时间设为 09:30-18:00，拟人间歇 60-120秒”*
- 🛠️ *“简历加上技能 Docker、K8s”*
- 📊 *“导出今天的投递记录为 CSV”*
- 📈 *“查一下目前的投递漏斗与回复率”*
- 🚫 *“把 XX外包公司 加入黑名单”*`

  return {
    id: generateId(),
    role: 'assistant',
    content: fallbackGuide,
    createdAt: now,
  }
}
