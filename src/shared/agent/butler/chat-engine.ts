// 智能中控对话台 · 真正的 Tool-Calling Agent 引擎
//
// 旧实现（chat-to-action.ts）是「12 条正则 + 8 个写死动作 + 固定兜底文案」，
// 只认指令、不认问题，没有上下文，也不会自己查数据。这里把它换成：
//   - 复用扩展侧 47 个 TOOL_DEFINITIONS（read / write / dangerous 三级）作为模型可调用工具；
//   - AI SDK 7 的 generateText + tools + stepCountIs 自动多步工具循环；
//   - 多轮上下文持久化到 chrome.storage.local；
//   - dangerous 工具一律先挂起，由 UI 审批卡确认后才带 confirm=true 执行；
//   - 模型不支持 function calling / 网络失败 → 退化到结构化 JSON 工具循环；
//   - AI 完全不可用时明确告知「当前是本地规则模式」，再降级到旧规则引擎（离线仍可用）。
//
// 设计约束：引擎本身不直接 import background 模块，工具执行通过可注入的 execTool，
// 默认实现走 chrome.runtime.sendMessage，便于在 popup / 侧栏 / 单测里复用。

import { generateText, tool, jsonSchema, stepCountIs, type ToolSet } from 'ai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { TOOL_DEFINITIONS, getTool } from '../../bridge/tools'
import { BUTLER_EXEC_TOOL_MSG } from '../../bridge/types'
import type { BridgeResult, ToolRisk } from '../../bridge/types'
import { getSetting } from '../../db/settings-store'
import { getPresetById } from '../../ai/model-presets'
import { chatCompletion, markAiFailure, clearAiFailure } from '../../ai/api-client'
import { consumeAiCall, isAiBudgetExhausted, getAiBudgetLimit, getAiUsageToday } from '../../ai/ai-budget'
import { reportErrorAsync } from '../../db/error-report'
import type { AiFailureMark } from '../../ai/api-client'
import { dispatchButlerChatMessage, type ButlerChatMessage } from './chat-to-action'

/** 对话台异常统一写入管家「异常留痕」诊断中心，60 秒同因去重防刷屏 */
const BUTLER_ERROR_SOURCE = 'butler.agent'
const BUTLER_DEDUPE_MS = 60_000

/** 只记录可诊断信息：绝不把 apiKey / baseUrl / 简历正文写进日志 */
function logButlerFailure(
  kind: string,
  detail: string,
  extra: { model?: string; mode?: string; tool?: string } = {},
): void {
  reportErrorAsync({
    source: BUTLER_ERROR_SOURCE,
    message: `[${kind}] ${clip(detail || '未知原因', 240)}`,
    context: JSON.stringify({ kind, ...extra }),
    dedupeWindowMs: BUTLER_DEDUPE_MS,
  })
}

/** 把对话台的 AI 失败同步到 AIbot 可见的降级标记（同一个 key，避免两套口径） */
function syncAiFailureMark(reason: string, modelName: string): void {
  const kind: AiFailureMark['kind'] = /HTTP\s*[4-5]\d\d|401|403|429/i.test(reason)
    ? 'http'
    : /tools|model|模型|function calling/i.test(reason)
      ? 'model'
      : 'network'
  void markAiFailure(kind, reason, modelName)
}

/** background 侧工具执行路由，见 src/background/index.ts */
export { BUTLER_EXEC_TOOL_MSG }
export const BUTLER_CHAT_HISTORY_KEY = 'butler_chat_history_v1'

/** 最多保留的历史消息数（约 6 轮），避免 token 无限膨胀 */
export const MAX_HISTORY_TURNS = 12
/** 单条历史消息最大字符数 */
const MAX_HISTORY_CHARS = 800
/** 工具循环最多步数，防止模型无限调用 */
const MAX_TOOL_STEPS = 5
/** 数据快照缓存时长 */
const SNAPSHOT_TTL_MS = 60_000

/** 会把自己递归回旧对话台的工具，不能暴露给新引擎 */
const EXCLUDED_TOOLS = new Set(['dispatch_butler_chat'])

export interface ButlerChatTurn {
  role: 'user' | 'assistant'
  content: string
  at: number
}

export interface ButlerToolCall {
  name: string
  displayName: string
  risk: ToolRisk
  ok: boolean
  summary: string
}

export interface ButlerPendingApproval {
  tool: string
  displayName: string
  args: Record<string, unknown>
  prompt: string
  createdAt: string
}

export type ButlerAgentMode = 'agent' | 'json_fallback' | 'offline'

export interface ButlerAgentReply {
  content: string
  mode: ButlerAgentMode
  toolTrace: ButlerToolCall[]
  /** 降级/异常原因，必须在 UI 里可见，不允许静默 */
  notice?: string
  pendingApproval?: ButlerPendingApproval
  history: ButlerChatTurn[]
}

export interface ButlerEngineDeps {
  execTool?: (name: string, args: Record<string, unknown>) => Promise<BridgeResult>
  loadHistory?: () => Promise<ButlerChatTurn[]>
  saveHistory?: (history: ButlerChatTurn[]) => Promise<void>
  resolveSettings?: () => Promise<{ apiKey: string; baseUrl: string; modelName: string }>
  /** 注入后可绕开真实模型调用，供单测覆盖循环/审批/降级逻辑 */
  runModel?: (ctx: {
    system: string
    history: ButlerChatTurn[]
    input: string
    settings: { apiKey: string; baseUrl: string; modelName: string }
    execTool: (name: string, args: Record<string, unknown>) => Promise<BridgeResult>
  }) => Promise<{ text: string; toolTrace: ButlerToolCall[]; pendingApproval?: ButlerPendingApproval }>
  /** 注入后可绕开真实 JSON 兜底调用 */
  runJsonFallback?: (ctx: {
    system: string
    history: ButlerChatTurn[]
    input: string
    execTool: (name: string, args: Record<string, unknown>) => Promise<BridgeResult>
  }) => Promise<{ text: string; toolTrace: ButlerToolCall[]; pendingApproval?: ButlerPendingApproval }>
}

export interface AgentDispatchOptions {
  /** 用户在审批卡点了「确认执行」 */
  approved?: ButlerPendingApproval
  deps?: ButlerEngineDeps
  now?: number
}

function nowMs(): number {
  return Date.now()
}

function clip(text: string, max: number): string {
  const clean = (text || '').replace(/\s+/g, ' ').trim()
  return clean.length > max ? `${clean.slice(0, max)}…` : clean
}

function summarizeToolResult(res: BridgeResult): string {
  if (!res?.ok) return `失败：${res?.error || '未知错误'}`
  try {
    return clip(JSON.stringify(res.data ?? null), 220)
  } catch {
    return '已返回结果'
  }
}

function toolDisplayName(name: string): string {
  const def = getTool(name)
  return def ? def.description.split(/[：:。]/)[0].slice(0, 24) : name
}

// ─────────── 历史持久化 ───────────

export async function getButlerChatHistory(): Promise<ButlerChatTurn[]> {
  try {
    if (typeof chrome === 'undefined' || !chrome.storage?.local) return []
    const res = await chrome.storage.local.get(BUTLER_CHAT_HISTORY_KEY)
    const list = res?.[BUTLER_CHAT_HISTORY_KEY]
    if (!Array.isArray(list)) return []
    return list
      .filter((t) => t && (t.role === 'user' || t.role === 'assistant') && typeof t.content === 'string')
      .slice(-MAX_HISTORY_TURNS)
  } catch {
    return []
  }
}

/** 纯函数：把一轮对话追加进历史并裁剪，便于单测覆盖 */
export function buildNextHistory(
  prev: ButlerChatTurn[],
  userText: string,
  assistantText: string,
  at = nowMs(),
): ButlerChatTurn[] {
  const turns: ButlerChatTurn[] = [
    ...prev,
    { role: 'user', content: clip(userText, MAX_HISTORY_CHARS), at },
    { role: 'assistant', content: clip(assistantText, MAX_HISTORY_CHARS), at: at + 1 },
  ]
  return turns.slice(-MAX_HISTORY_TURNS)
}

export async function persistButlerChatHistory(history: ButlerChatTurn[]): Promise<void> {
  try {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      await chrome.storage.local.set({ [BUTLER_CHAT_HISTORY_KEY]: history })
    }
  } catch (err) {
    logButlerFailure('history_write_failed', String((err as { message?: string })?.message || err))
  }
}

export async function appendButlerChatHistory(
  userText: string,
  assistantText: string,
  at = nowMs(),
): Promise<ButlerChatTurn[]> {
  const prev = await getButlerChatHistory()
  const next = buildNextHistory(prev, userText, assistantText, at)
  await persistButlerChatHistory(next)
  return next
}

export async function clearButlerChatHistory(): Promise<void> {
  try {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      await chrome.storage.local.remove(BUTLER_CHAT_HISTORY_KEY)
    }
  } catch {
    // ignore
  }
}

// ─────────── 默认依赖 ───────────

async function defaultExecTool(name: string, args: Record<string, unknown>): Promise<BridgeResult> {
  try {
    if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) {
      return { ok: false, error: '扩展消息通道不可用' }
    }
    const res = await chrome.runtime.sendMessage({
      type: BUTLER_EXEC_TOOL_MSG,
      payload: { tool: name, args },
    })
    return (res || { ok: false, error: '后台未返回结果' }) as BridgeResult
  } catch (err) {
    return { ok: false, error: String((err as { message?: string })?.message || err) }
  }
}

async function defaultResolveSettings(): Promise<{ apiKey: string; baseUrl: string; modelName: string }> {
  const modelPreset = await getSetting<string>('modelPreset', 'deepseek')
  const apiKey = await getSetting<string>('apiKey', '')
  if (modelPreset === 'custom') {
    return {
      apiKey,
      baseUrl: await getSetting<string>('apiBaseUrl', 'https://api.openai.com/v1'),
      modelName: await getSetting<string>('modelName', 'gpt-4o-mini'),
    }
  }
  const preset = getPresetById(modelPreset)
  const baseUrl = (await getSetting<string>('apiBaseUrl', '')) || preset?.baseUrl || 'https://api.deepseek.com/v1'
  const modelName = (await getSetting<string>('modelName', '')) || preset?.modelName || 'deepseek-flash'
  return { apiKey, baseUrl, modelName }
}

// ─────────── 真实数据快照（让开放问题也有据可依） ───────────

let snapshotCache: { at: number; text: string } | null = null

/** 测试用：清掉进程内的数据快照缓存 */
export function resetButlerEngineState(): void {
  snapshotCache = null
}

export async function buildContextSnapshot(
  execTool: ButlerEngineDeps['execTool'],
  now = nowMs(),
): Promise<string> {
  if (snapshotCache && now - snapshotCache.at < SNAPSHOT_TTL_MS) return snapshotCache.text
  const run = execTool
  if (!run) return ''
  const probes: Array<[string, Record<string, unknown>]> = [
    ['get_dashboard_stats', {}],
    ['get_campaign_stats', {}],
    ['list_errors', { limit: 3 }],
  ]
  // 三个只读探针并发取数，避免串行把每轮对话白白拖慢 3 次 RPC
  const parts = (await Promise.all(probes.map(async ([name, args]) => {
    try {
      const res = await run(name, args)
      return res?.ok ? `${name}: ${clip(JSON.stringify(res.data ?? null), 500)}` : ''
    } catch (err) {
      logButlerFailure('snapshot_probe_failed', String((err as { message?: string })?.message || err), { tool: name })
      return ''
    }
  }))).filter((part): part is string => !!part)
  const text = parts.length > 0 ? parts.join('\n') : ''
  snapshotCache = { at: now, text }
  return text
}

const SYSTEM_PROMPT = [
  '你是「智能求职助手」Chrome 扩展里的求职中控 Agent，直接面对求职者本人。',
  '你不是问答机器人：你可以调用工具读取真实投递数据、错误日志、简历、黑名单、配额，也可以调用工具修改配置、导出报表、启动或暂停投递。',
  '',
  '硬性规则：',
  '1. 涉及具体数字（投了几份、回复率、失败原因、配额、错误次数）时，必须先调用工具查真实数据，严禁凭空编造或估算。',
  '2. 用户只是聊天/问候/问建议时，直接用中文自然回答，不要为了用工具而用工具。',
  '3. 用户要改配置或执行动作时，调用对应工具；危险工具会被自动挂起并要求用户确认，不要谎称已执行。',
  '4. 工具返回失败时，如实说明并给出可操作的下一步，不要假装成功。',
  '5. 回答简洁、口语化，可用 markdown 列表或加粗；不要输出工具原始 JSON。',
].join('\n')

/** 模型可见的工具清单（47 个里排除会造成自我递归的那个） */
export function getAvailableButlerTools() {
  return TOOL_DEFINITIONS.filter((d) => !EXCLUDED_TOOLS.has(d.name))
}

// ─────────── 模型调用：AI SDK tool loop ───────────

async function runAiSdkToolLoop(ctx: Parameters<NonNullable<ButlerEngineDeps['runModel']>>[0]): Promise<{
  text: string
  toolTrace: ButlerToolCall[]
  pendingApproval?: ButlerPendingApproval
}> {
  const { settings, system, history, input, execTool } = ctx
  // 与项目其它 AI 调用共用同一份每日预算计数，避免对话台绕开成本护栏无限烧钱
  const remaining = await consumeAiCall()
  if (remaining < 0) throw new Error('今日 AI 调用预算已用尽')
  const provider = createOpenAICompatible({
    name: 'job-assistant-openai-compatible',
    baseURL: settings.baseUrl.replace(/\/$/, ''),
    apiKey: settings.apiKey,
  })

  const toolTrace: ButlerToolCall[] = []
  let pendingApproval: ButlerPendingApproval | undefined

  const tools: ToolSet = {}
  for (const def of getAvailableButlerTools()) {
    tools[def.name] = tool({
      description: `[${def.risk}] ${def.description}`,
      inputSchema: jsonSchema(def.inputSchema as Parameters<typeof jsonSchema>[0]),
      execute: async (rawArgs: unknown) => {
        const args = (rawArgs && typeof rawArgs === 'object' ? rawArgs : {}) as Record<string, unknown>
        const displayName = toolDisplayName(def.name)

        // danger 工具一律不在模型循环里直接执行：挂起 → UI 审批卡 → 确认后重放
        if (def.risk === 'dangerous' && args.confirm !== true) {
          pendingApproval = {
            tool: def.name,
            displayName,
            args,
            prompt: `⚠️ **高风险操作需要确认**\n即将执行【${displayName}】。该操作会影响真实投递或清空数据，请确认后再执行。`,
            createdAt: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
          }
          toolTrace.push({ name: def.name, displayName, risk: def.risk, ok: false, summary: '已挂起，等待用户确认' })
          return { ok: false, requiresApproval: true, message: '该操作已挂起等待用户确认，请如实告诉用户「需要确认」，不要声称已执行' }
        }

        const res = await execTool(def.name, args)
        const summary = summarizeToolResult(res)
        if (!res?.ok) {
          logButlerFailure('tool_failed', res?.error || '执行失败', { tool: def.name, model: settings.modelName })
        }
        toolTrace.push({ name: def.name, displayName, risk: def.risk, ok: !!res?.ok, summary })
        return res?.ok ? { ok: true, data: res.data ?? null } : { ok: false, error: res?.error || '执行失败' }
      },
    })
  }

  const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [
    ...history.map((t) => ({ role: t.role, content: t.content })),
    { role: 'user' as const, content: input },
  ]

  const result = await generateText({
    model: provider.chatModel(settings.modelName),
    system,
    messages,
    tools,
    stopWhen: stepCountIs(MAX_TOOL_STEPS),
    temperature: 0.2,
    abortSignal: AbortSignal.timeout(45_000),
  })

  // 模型最后一步只调工具、没给总结时，用真实执行轨迹兜底，
  // 否则会被上层当成「模型未返回内容」一路降级到离线固定文案。
  const text = result.text || (toolTrace.length > 0
    ? `已按你的要求执行 ${toolTrace.length} 次工具调用：\n${toolTrace.map((t) => `- ${t.displayName}：${t.ok ? '成功' : '未完成'}（${t.summary}）`).join('\n')}`
    : '')
  return { text, toolTrace, pendingApproval }
}

// ─────────── 模型调用：JSON 模式兜底（模型不支持 function calling 时） ───────────

function buildJsonFallbackPrompt(): string {
  const lines = getAvailableButlerTools().map((d) => {
    const props = Object.keys(d.inputSchema.properties || {})
    return `- ${d.name} [${d.risk}] ${d.description} 参数: ${props.join(',') || '无'}`
  })
  return [
    SYSTEM_PROMPT,
    '',
    '当前模型不支持原生 function calling，改用结构化 JSON 协议与工具交互。',
    '需要调用工具时，只输出：{"tool":"工具名","args":{...}}',
    '不需要调用工具、或已经拿到足够结果要给最终答复时，只输出：{"reply":"给用户的中文回答"}',
    '不要输出 markdown 代码块，不要输出多余文字。',
    '',
    '可用工具：',
    ...lines,
  ].join('\n')
}

export function parseJsonFallbackResponse(raw: string): { tool?: string; args?: Record<string, unknown>; reply?: string } | null {
  if (!raw) return null
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const obj = JSON.parse(raw.slice(start, end + 1)) as {
      tool?: unknown
      args?: unknown
      reply?: unknown
    }
    if (typeof obj.reply === 'string') return { reply: obj.reply }
    if (typeof obj.tool === 'string' && obj.tool) {
      const args = obj.args && typeof obj.args === 'object' && !Array.isArray(obj.args)
        ? obj.args as Record<string, unknown>
        : {}
      return { tool: obj.tool, args }
    }
  } catch {
    return null
  }
  return null
}

async function runJsonToolLoop(ctx: Parameters<NonNullable<ButlerEngineDeps['runJsonFallback']>>[0]): Promise<{
  text: string
  toolTrace: ButlerToolCall[]
  pendingApproval?: ButlerPendingApproval
}> {
  const { system, history, input, execTool } = ctx
  const toolTrace: ButlerToolCall[] = []
  let pendingApproval: ButlerPendingApproval | undefined
  const transcript = history.map((t) => `${t.role === 'user' ? '用户' : '助手'}：${t.content}`).join('\n')
  let userMessage = `${transcript ? `${transcript}\n` : ''}用户：${input}`
  let finalText = ''

  for (let step = 0; step < MAX_TOOL_STEPS; step++) {
    const raw = await chatCompletion(system, userMessage, 0.1)
    // 旧实现在这里静默 return 空串，上层只能一路掉到离线固定文案，
    // 用户完全看不出「第二层兜底为什么也失败」。改成抛可读错误，由上层合并进提示。
    if (!raw) {
      throw new Error('结构化 JSON 兜底调用返回空（AI 未配置 / 预算耗尽 / 请求失败）')
    }
    const parsed = parseJsonFallbackResponse(raw)
    if (!parsed) {
      if (!finalText) throw new Error('结构化 JSON 兜底返回了无法解析的内容')
      break
    }
    if (typeof parsed.reply === 'string') {
      finalText = parsed.reply
      break
    }
    const name = parsed.tool || ''
    const def = getTool(name)
    if (!def || EXCLUDED_TOOLS.has(name)) {
      userMessage += `\n系统：工具 ${name} 不存在，请改用其他工具或直接给出 reply。`
      continue
    }
    const args = parsed.args || {}
    const displayName = toolDisplayName(name)
    if (def.risk === 'dangerous' && args.confirm !== true) {
      pendingApproval = {
        tool: name,
        displayName,
        args,
        prompt: `⚠️ **高风险操作需要确认**\n即将执行【${displayName}】，请确认后再执行。`,
        createdAt: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
      }
      toolTrace.push({ name, displayName, risk: def.risk, ok: false, summary: '已挂起，等待用户确认' })
      break
    }
    const res = await execTool(name, args)
    if (!res?.ok) logButlerFailure('json_tool_failed', res?.error || '执行失败', { tool: name, mode: 'json_fallback' })
    toolTrace.push({ name, displayName, risk: def.risk, ok: !!res?.ok, summary: summarizeToolResult(res) })
    userMessage += `\n系统：工具 ${name} 的执行结果是 ${JSON.stringify(res).slice(0, 600)}。请据此给最终答复，或继续调用其它工具。`
  }

  return { text: finalText, toolTrace, pendingApproval }
}

// ─────────── 离线降级：旧规则引擎（保留可用，并且把降级原因说清楚） ───────────

async function runOfflineRules(input: string): Promise<{ text: string; pendingApproval?: ButlerPendingApproval }> {
  const old: ButlerChatMessage = await dispatchButlerChatMessage(input)
  const pendingApproval = old.pendingApproval
    ? {
        tool: `legacy:${old.pendingApproval.actionName}`,
        displayName: old.pendingApproval.displayName,
        args: { __legacyAction: old.pendingApproval.actionName, __legacyArgs: old.pendingApproval.args },
        prompt: old.pendingApproval.prompt || old.content,
        createdAt: old.pendingApproval.createdAt,
      }
    : undefined
  return { text: old.content, pendingApproval }
}

// ─────────── 审批确认后的重放 ───────────

async function replayApprovedTool(
  approved: ButlerPendingApproval,
  execTool: ButlerEngineDeps['execTool'],
): Promise<{ text: string; toolTrace: ButlerToolCall[] }> {
  const toolTrace: ButlerToolCall[] = []
  const isLegacy = approved.tool.startsWith('legacy:')
  let res: BridgeResult
  if (isLegacy) {
    const legacyAction = String(approved.args.__legacyAction || '')
    const legacyArgs = (approved.args.__legacyArgs || {}) as Record<string, unknown>
    const old = await dispatchButlerChatMessage('', {
      actionId: `${Date.now()}`,
      actionName: legacyAction,
      displayName: approved.displayName,
      args: legacyArgs,
      prompt: approved.prompt,
      createdAt: approved.createdAt,
    })
    res = { ok: !!old.actionResult?.success, data: old.content }
  } else {
    res = await (execTool || defaultExecTool)(approved.tool, { ...approved.args, confirm: true })
  }
  const summary = summarizeToolResult(res)
  if (!res?.ok) {
    logButlerFailure('approval_replay_failed', res?.error || '未知错误', { tool: approved.tool })
  }
  toolTrace.push({
    name: approved.tool,
    displayName: approved.displayName,
    risk: 'dangerous',
    ok: !!res?.ok,
    summary,
  })
  const text = res?.ok
    ? `✅ 已执行【${approved.displayName}】。\n\n执行结果：${summary}`
    : `❌ 执行【${approved.displayName}】失败：${res?.error || '未知错误'}`
  return { text, toolTrace }
}

// ─────────── 总入口 ───────────

export async function dispatchButlerAgentMessage(
  input: string,
  options: AgentDispatchOptions = {},
): Promise<ButlerAgentReply> {
  const deps = options.deps || {}
  const execTool = deps.execTool || defaultExecTool
  const loadHistory = deps.loadHistory || getButlerChatHistory
  const saveHistory = deps.saveHistory || persistButlerChatHistory
  const resolveSettings = deps.resolveSettings || defaultResolveSettings
  const at = options.now ?? nowMs()

  // 审批确认：不再问模型，直接重放，避免二次调用把上下文带偏
  if (options.approved) {
    const { text, toolTrace } = await replayApprovedTool(options.approved, execTool)
    const history = buildNextHistory(
      await loadHistory(),
      `确认执行：${options.approved.displayName}`,
      text,
      at,
    )
    await saveHistory(history)
    return { content: text, mode: 'agent', toolTrace, history }
  }

  const history = await loadHistory()
  const settings = await resolveSettings()
  const snapshot = await buildContextSnapshot(execTool, options.now ?? nowMs())
  const system = snapshot ? `${SYSTEM_PROMPT}\n\n【当前真实数据快照】（仅供参考，需要细节请调用工具）\n${snapshot}` : SYSTEM_PROMPT

  // 没配 API Key：直接明确告知并走本地规则，不浪费一次必然失败的请求
  if (!settings.apiKey || !settings.baseUrl) {
    logButlerFailure('ai_not_configured', '缺少 API Key 或接口地址', { model: settings.modelName, mode: 'offline' })
    syncAiFailureMark('AI 未配置（缺少 API Key 或接口地址）', settings.modelName)
    const offline = await runOfflineRules(input)
    const nextHistory = buildNextHistory(history, input, offline.text, at)
    await saveHistory(nextHistory)
    return {
      content: offline.text,
      mode: 'offline',
      toolTrace: [],
      notice: 'AI 未配置（缺少 API Key 或接口地址），当前是本地规则模式：只能执行固定指令，无法自由对话或自己查数据。请到设置页配置模型后重试。',
      pendingApproval: offline.pendingApproval,
      history: nextHistory,
    }
  }

  // 预算耗尽：不要白跑一次必然被拒的请求，直接明确告知并走本地规则
  if (await isAiBudgetExhausted()) {
    const [used, limit] = await Promise.all([getAiUsageToday(), getAiBudgetLimit()])
    logButlerFailure('ai_budget_exhausted', `今日 AI 预算 ${used}/${limit} 已用尽`, { model: settings.modelName, mode: 'offline' })
    syncAiFailureMark(`今日 AI 预算已用尽（${used}/${limit}）`, settings.modelName)
    const offline = await runOfflineRules(input)
    const nextHistory = buildNextHistory(history, input, offline.text, at)
    await saveHistory(nextHistory)
    return {
      content: offline.text,
      mode: 'offline',
      toolTrace: [],
      notice: `今日 AI 预算已用尽（${used}/${limit} 次），当前是本地规则模式。可在设置页调高「每日 AI 调用上限」或重置今日用量后重试。`,
      pendingApproval: offline.pendingApproval,
      history: nextHistory,
    }
  }

  const modelCtx = { system, history, input, settings, execTool }

  // 主路径：AI SDK 原生 function calling + 多步工具循环
  try {
    const run = deps.runModel || runAiSdkToolLoop
    const result = await run(modelCtx)
    if (result.text || result.pendingApproval) {
      // 主路径成功：清掉 AIbot 侧可见的降级标记，避免上一次失败一直挂在日志里
      void clearAiFailure()
      const content = result.text || result.pendingApproval?.prompt || '（本次没有生成回复）'
      const nextHistory = buildNextHistory(history, input, content, at)
      await saveHistory(nextHistory)
      return {
        content,
        mode: 'agent',
        toolTrace: result.toolTrace,
        pendingApproval: result.pendingApproval,
        history: nextHistory,
      }
    }
    throw new Error('模型未返回内容')
  } catch (err) {
    const reason = String((err as { message?: string })?.message || err)
    logButlerFailure('agent_call_failed', reason, { model: settings.modelName, mode: 'agent' })
    syncAiFailureMark(reason, settings.modelName)
    let jsonReason = ''

    // 兜底路径：结构化 JSON 工具循环（模型不支持 tools / 请求失败时）
    try {
      const runJson = deps.runJsonFallback || runJsonToolLoop
      const result = await runJson({
        system: buildJsonFallbackPrompt(),
        history,
        input,
        execTool,
      })
      if (result.text || result.pendingApproval) {
        logButlerFailure('json_fallback_used', reason, { model: settings.modelName, mode: 'json_fallback' })
        const content = result.text || result.pendingApproval?.prompt || '（本次没有生成回复）'
        const nextHistory = buildNextHistory(history, input, content, at)
        await saveHistory(nextHistory)
        return {
          content,
          mode: 'json_fallback',
          toolTrace: result.toolTrace,
          pendingApproval: result.pendingApproval,
          notice: `原生工具调用不可用（${clip(reason, 100)}），已切换到结构化 JSON 工具模式，功能不受影响但准确率略低。异常已写入管家「异常留痕」。`,
          history: nextHistory,
        }
      }
      jsonReason = '结构化 JSON 兜底未产出回复'
      logButlerFailure('json_fallback_empty', jsonReason, { model: settings.modelName, mode: 'json_fallback' })
    } catch (jsonErr) {
      jsonReason = String((jsonErr as { message?: string })?.message || jsonErr)
      logButlerFailure('json_fallback_failed', jsonReason, { model: settings.modelName, mode: 'json_fallback' })
    }

    // 最终降级：本地规则引擎，且明确告诉用户「现在是本地模式」
    logButlerFailure('offline_fallback_used', jsonReason ? `${reason} | ${jsonReason}` : reason, { model: settings.modelName, mode: 'offline' })
    const offline = await runOfflineRules(input)
    const nextHistory = buildNextHistory(history, input, offline.text, at)
    await saveHistory(nextHistory)
    return {
      content: offline.text,
      mode: 'offline',
      toolTrace: [],
      notice: `AI 调用失败（${clip(reason, 120)}）${jsonReason ? `；结构化 JSON 兜底同样失败（${clip(jsonReason, 100)}）` : ''}，当前已降级为本地规则模式：只能执行固定指令。请检查设置页「测试连接」、API Key 余额与当日 AI 预算。异常已写入管家「异常留痕」。`,
      pendingApproval: offline.pendingApproval,
      history: nextHistory,
    }
  }
}
