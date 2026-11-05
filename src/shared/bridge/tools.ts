/**
 * 外部 AI 可调用的工具清单（单一真源）。
 *
 * 这里把扩展里散落的功能统一暴露出来：AIbot 流水线、管家、投递记录、简历、
 * 黑名单、面试日历、日报、诊断、导出、设置……都由 background 的 RPC handler 分发。
 * offscreen 客户端会把这份清单上报给 daemon，MCP 的 tools/list 直接以它为准。
 */
import type { ToolDefinition, ToolRisk, BridgeManifest, ExternalAiConfig } from './types'
import { BRIDGE_PROTOCOL_VERSION } from './types'

type Prop = { type: string; description?: string; enum?: string[]; default?: unknown }
type Props = Record<string, Prop>

const s = (description = ''): Prop => ({ type: 'string', description })
const n = (description = ''): Prop => ({ type: 'number', description })
const b = (description = ''): Prop => ({ type: 'boolean', description })
const o = (description = ''): Prop => ({ type: 'object', description })
const arr = (description = ''): Prop => ({ type: 'array', description })

function t(name: string, description: string, risk: ToolRisk, properties: Props = {}, required: string[] = []): ToolDefinition {
  return {
    name, description, risk,
    inputSchema: {
      type: 'object', properties,
      ...(required.length ? { required } : {}),
      additionalProperties: false,
    },
  }
}

const CONFIRM_PROP = b('危险动作二次确认，必须显式传 true 才会执行')

/** 全部工具；新增功能时只需在这里加一条，并在 background/external-ai-rpc.ts 加对应 handler */
export const TOOL_DEFINITIONS: ToolDefinition[] = [
  // ───────── 只读：状态与统计 ─────────
  t('get_status', '读取扩展状态：版本、开关、配对、AIbot 是否运行、各平台配额。', 'read'),
  t('get_campaign_stats', '读取 AIbot 全自动投递流水线的战报（已投/待投/成功/失败、平台分布、最近日志）。', 'read'),
  t('get_campaign_state', '读取 campaign 队列的完整状态（status、配额、时间窗、任务数）。', 'read'),
  t('get_assistant_state', '读取悬浮窗与 AIbot 的统一控制状态（展开/收缩/关闭、投递模式、AI 评分开关）。', 'read'),
  t('get_dashboard_stats', '读取投递漏斗统计（总数、今日、已读、沟通中、邀约、回复率）。', 'read'),
  t('get_platform_quotas', '读取 5 个平台各自的每日投递数量与开关。', 'read'),
  t('get_settings', '读取扩展设置（已脱敏：API Key、令牌等敏感值不会返回）。', 'read'),

  // ───────── 只读：业务数据 ─────────
  t('list_applications', '列出投递记录，可按数量、状态、平台过滤。', 'read', {
    limit: n('返回条数，默认 50，最大 500'), status: s('状态过滤，如 applied / viewed / chatting / interview'), platform: s('平台 ID：boss / liepin / 51job / zhaopin / maimai'),
  }),
  t('get_application', '按 id 或 jobId 读取单条投递记录。', 'read', { id: s('记录 id'), jobId: s('岗位 id') }),
  t('list_resumes', '列出全部简历（含结构化画像，可用 limit 控制）。', 'read', { limit: n('返回条数，默认 20') }),
  t('get_default_resume', '读取当前默认简历全文。', 'read'),
  t('list_blacklist', '列出公司/关键词黑名单。', 'read'),
  t('list_interviews', '列出面试日历事件。', 'read', { upcomingOnly: b('仅返回未来事件') }),
  t('get_daily_report', '读取指定日期的管家日报（不传 date 则取今天）。', 'read', { date: s('YYYY-MM-DD') }),
  t('list_daily_reports', '列出最近的管家日报。', 'read', { limit: n('默认 14') }),
  t('get_daily_report_config', '读取日报生成配置（定时、自动生成开关）。', 'read'),
  t('list_evolution_proposals', '列出管家进化提案/策略建议。', 'read', { status: s('pending / accepted / rejected / all') }),
  t('list_errors', '列出本地错误日志。', 'read', { limit: n('默认 100') }),
  t('get_error_count', '读取错误日志条数。', 'read'),
  t('get_fix_suggestions', '读取自愈架构聚合出的「开发者待修清单」。', 'read'),
  t('list_self_healing_events', '列出最近的自愈/降级事件。', 'read', { limit: n('默认 50') }),
  t('get_page_info', '读取当前打开的招聘页信息（平台、页面类型、URL）。需要浏览器已打开对应页面。', 'read'),
  t('export_applications_csv', '把投递记录导出成 CSV 文本返回（不触发浏览器下载，适合 AI 直接读取/落盘）。', 'read', { limit: n('默认全部') }),
  t('export_blacklist_csv', '把黑名单导出成 CSV 文本返回。', 'read'),

  // ───────── 写入：配置与内容 ─────────
  t('set_platform_quota', '修改某个平台的每日投递数量（1–500）。会同步到面板、campaign 配额与每日风控上限。', 'write', {
    platform: s('boss / liepin / 51job / zhaopin / maimai'), quota: n('目标数量，1–500'),
  }, ['platform', 'quota']),
  t('set_platform_enabled', '开关某个平台是否参与自动投递。', 'write', { platform: s('平台 ID'), enabled: b('是否开启') }, ['platform', 'enabled']),
  t('update_assistant_state', '修改侧栏形态 / 置顶常驻 / 投递模式 / AI 评分开关（与网页右侧侧栏双向同步）。', 'write', {
    panelState: s('expanded（右侧整高侧栏） / bubble（右侧半圆浮球） / collapsed（旧窄把手） / closed（停止）'), pinned: b('是否置顶常驻'), applyMode: s('batch / recommend'), enableAiMatch: b('是否启用 AI 评分'), liepinResumeMode: b('猎聘是否走投简历模式'),
  }),
  t('update_daily_report_config', '更新管家日报配置。', 'write', { config: o('完整配置对象') }, ['config']),
  t('generate_daily_report', '立即生成管家日报。', 'write', { date: s('YYYY-MM-DD') }),
  t('dispatch_butler_chat', '把一句自然语言交给扩展内置的求职管家执行（如「统计本周投递」「把 XX 公司拉黑」）。', 'write', { text: s('自然语言指令') }, ['text']),
  t('add_blacklist', '添加公司/关键词到黑名单。', 'write', { companyName: s('公司名称'), reason: s('原因') }, ['companyName']),
  t('remove_blacklist', '从黑名单移除一条。', 'write', { id: s('黑名单记录 id') }, ['id']),
  t('add_interview', '新增一条面试日历事件。', 'write', { event: o('面试事件对象，含 companyName / jobTitle / interviewDate') }, ['event']),
  t('delete_interview', '删除一条面试日历事件。', 'write', { id: s('事件 id') }, ['id']),
  t('accept_evolution_proposal', '采纳一条管家进化提案。', 'write', { id: s('提案 id'), note: s('备注') }, ['id']),
  t('reject_evolution_proposal', '驳回一条管家进化提案。', 'write', { id: s('提案 id'), note: s('备注') }, ['id']),
  t('append_campaign_log', '往 AIbot 行为日志写一条备注。', 'write', { message: s('日志内容'), level: s('info / success / warn / error') }, ['message']),
  t('clear_errors', '清空本地错误日志。', 'write'),
  t('check_platforms_auth', '检查 5 个招聘平台的登录态（会短暂打开后台标签页）。', 'write'),

  // ───────── 危险：真实投递 / 破坏性操作 ─────────
  t('start_campaign', '启动 AIbot 全自动投递流水线，会向真实招聘平台发起沟通/投递。', 'dangerous', {
    quotas: o('可选：各平台数量覆盖'), enabledPlatforms: arr('可选：只跑这些平台'), confirm: CONFIRM_PROP,
  }, ['confirm']),
  t('pause_campaign', '暂停 AIbot 流水线。', 'dangerous', { reason: s('暂停原因'), confirm: CONFIRM_PROP }, ['confirm']),
  t('resume_campaign', '恢复 AIbot 流水线，会继续真实投递。', 'dangerous', { confirm: CONFIRM_PROP }, ['confirm']),
  t('stop_campaign', '彻底停止 AIbot：终止 campaign、清除定时器、关闭浮窗、取消当前任务。', 'dangerous', { confirm: CONFIRM_PROP }, ['confirm']),
  t('trigger_auto_collect', '立即采集岗位加入待投队列（会打开/操作招聘页面标签）。', 'dangerous', { confirm: CONFIRM_PROP }, ['confirm']),
  t('clear_pending_tasks', '清空待投队列，可选重新采集。', 'dangerous', { platform: s('只清某个平台'), recollect: b('是否重新采集'), confirm: CONFIRM_PROP }, ['confirm']),
  t('clear_all_applications', '清空全部投递记录（不可恢复）。', 'dangerous', { confirm: CONFIRM_PROP }, ['confirm']),
  t('run_butler_scan', '立即执行管家每日扫描（跟进建议 + 通知）。', 'dangerous', { confirm: CONFIRM_PROP }, ['confirm']),
]

const BY_NAME = new Map(TOOL_DEFINITIONS.map((tool) => [tool.name, tool]))

export function getTool(name: string): ToolDefinition | undefined {
  return BY_NAME.get(name)
}

export function buildManifest(extensionVersion: string): BridgeManifest {
  return {
    protocol: BRIDGE_PROTOCOL_VERSION,
    extensionVersion,
    tools: TOOL_DEFINITIONS,
  }
}

/** 参数校验：只做类型与必填检查，具体业务校验交给 handler */
export function validateArgs(tool: ToolDefinition, args: Record<string, unknown>): string | null {
  const schema = tool.inputSchema
  for (const key of schema.required || []) {
    if (args[key] === undefined || args[key] === null || args[key] === '') {
      return `缺少必填参数 ${key}`
    }
  }
  for (const [key, value] of Object.entries(args)) {
    const prop = schema.properties[key]
    if (!prop || value === undefined || value === null) continue
    const expected = prop.type
    const actual = Array.isArray(value) ? 'array' : typeof value
    const normalized = expected === 'number' && actual === 'number' ? 'number'
      : expected === 'boolean' && actual === 'boolean' ? 'boolean'
        : expected === 'string' && actual === 'string' ? 'string'
          : expected === 'array' && actual === 'array' ? 'array'
            : expected === 'object' && actual === 'object' ? 'object' : null
    if (!normalized) return `参数 ${key} 类型应为 ${expected}`
    if (prop.enum && !prop.enum.includes(String(value))) return `参数 ${key} 只能是 ${prop.enum.join(' / ')}`
  }
  return null
}

export interface GateDecision { allowed: boolean; reason?: string }

/**
 * 安全门禁（fail-closed）：
 *  - 总开关关闭 → 一律拒绝
 *  - write → 需要 allowWrite
 *  - dangerous → 需要 allowDangerous + 每次 confirm=true
 */
export function gateTool(tool: ToolDefinition, config: ExternalAiConfig, args: Record<string, unknown>): GateDecision {
  if (!config.enabled) return { allowed: false, reason: '外部 AI 接入未开启：请在扩展「设置 → 外部 AI 接入」打开总开关。' }
  if (tool.risk === 'dangerous') {
    if (!config.allowDangerous) return { allowed: false, reason: '危险动作未授权：请在扩展设置页打开「允许外部 AI 执行危险动作」。' }
    if (args.confirm !== true) return { allowed: false, reason: '危险动作需要在参数里显式传 confirm=true，并先取得用户同意。' }
  }
  if (tool.risk === 'write' && !config.allowWrite) {
    return { allowed: false, reason: '写入动作未授权：请在扩展设置页打开「允许外部 AI 修改配置」。' }
  }
  return { allowed: true }
}

/** 设置里敏感 key 的脱敏（外部 AI 永远拿不到密钥） */
const SENSITIVE_KEY = /(apikey|api_key|token|secret|password|authorization|webhook.*url|cookie)/i

export function redactSettings(settings: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(settings)) {
    if (SENSITIVE_KEY.test(key)) {
      out[key] = value ? '***已脱敏***' : value
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      out[key] = redactSettings(value as Record<string, unknown>)
    } else {
      out[key] = value
    }
  }
  return out
}

/** CSV 序列化（不触发浏览器下载，便于外部 AI 直接消费；纯函数，可单测） */
export function toCsv(headers: string[], rows: unknown[][]): string {
  const esc = (cell: unknown) => {
    const text = cell === null || cell === undefined ? '' : String(cell)
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
  }
  return '\uFEFF' + [headers, ...rows].map((row) => row.map(esc).join(',')).join('\r\n')
}

export const TOOL_COUNTS = {
  read: TOOL_DEFINITIONS.filter((x) => x.risk === 'read').length,
  write: TOOL_DEFINITIONS.filter((x) => x.risk === 'write').length,
  dangerous: TOOL_DEFINITIONS.filter((x) => x.risk === 'dangerous').length,
  total: TOOL_DEFINITIONS.length,
}
