/**
 * 外部 AI 统一 RPC handler（运行在 background Service Worker）。
 *
 * 所有外部工具调用先过 tools.ts 的白名单 + 分级门禁，再分发到既有 store / service。
 * 不新增第二套业务逻辑：能复用现有消息背后的函数就直接复用。
 */
import { getExternalAiConfig } from '../shared/bridge/config'
import { recordError } from '../shared/db/error-store'
import { getTool, validateArgs, gateTool, redactSettings, toCsv, TOOL_COUNTS } from '../shared/bridge/tools'
import type { RpcRequest, BridgeResult } from '../shared/bridge/types'
import { campaignService } from './campaign-service'
import { getAssistantState, patchAssistantState } from '../shared/assistant-state'
import { getAllApplications, getApplicationById, getStats as getApplicationStats, clearApplications } from '../shared/db/application-store'
import { getAllResumes, getDefaultResume } from '../shared/db/resume-store'
import { getBlacklist, addToBlacklist, removeFromBlacklist } from '../shared/db/blacklist-store'
import { getInterviewEvents, getUpcomingInterviews, saveInterviewEvent, deleteInterviewEvent } from '../shared/db/interview-store'
import { getAllSettings } from '../shared/db/settings-store'
import {
  getDailyReport, listDailyReports, getDailyReportConfig, saveDailyReportConfig,
  listEvolutionProposals, acceptEvolutionProposal, rejectEvolutionProposal,
} from '../shared/db/butler-evolution-store'
import { listErrors, getErrorCount, clearErrors } from '../shared/db/error-store'
import { getDeveloperFixSuggestions, listSelfHealingEvents } from '../shared/db/diagnostics-store'
import { getSavedPlatformQuotas, savePlatformQuotas, normalizePlatformQuotas, PLATFORM_IDS } from '../shared/agent/quota'
import { getCampaign } from '../shared/agent/queue-store'
import { readUserStopped, isAutomationStartTool } from '../shared/agent/user-intent'
import { checkAllPlatformsAuth } from '../shared/platform/auth-checker'
import { generateDailyButlerReport } from '../shared/agent/butler/daily-report-generator'
import { dispatchButlerChatMessage } from '../shared/agent/butler/chat-to-action'
import { butlerRunDaily } from '../shared/agent/butler'
import { appendCampaignLog } from '../shared/agent/queue-store'
import type { PlatformId } from '../shared/agent/quota'

export interface RpcDeps {
  /** 由 background 注入，保证「停止」与 UI 的终止动作是同一条链路 */
  shutdownAssistant: () => Promise<unknown>
}

type Args = Record<string, unknown>
type Handler = (a: Args) => unknown | Promise<unknown>

function str(a: Args, key: string): string | undefined {
  const v = a[key]
  return typeof v === 'string' && v.trim() ? v.trim() : undefined
}
function num(a: Args, key: string, fallback: number): number {
  const v = a[key]
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN
  return Number.isFinite(n) ? n : fallback
}
function bool(a: Args, key: string): boolean | undefined {
  const v = a[key]
  return typeof v === 'boolean' ? v : undefined
}
function obj(a: Args, key: string): Record<string, unknown> {
  const v = a[key]
  return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}
}

function applicationsCsv(rows: Array<Record<string, unknown>>): string {
  const headers = ['投递时间', '岗位名称', '公司名称', '薪资', '地点', '状态', '匹配分数', '平台']
  const data = rows.map((r) => [
    r.appliedAt, r.jobTitle, r.companyName, r.salary, r.location,
    r.status, r.matchScore ?? '未评分', r.platformId,
  ])
  return toCsv(headers, data)
}

function buildHandlers(deps: RpcDeps): Record<string, Handler> {
  return {
    // ── 只读：状态 ──
    get_status: async () => {
      const [config, campaign, assistant, quotas] = await Promise.all([
        getExternalAiConfig(), getCampaign(), getAssistantState(), getSavedPlatformQuotas(),
      ])
      return {
        extension: '智能求职助手',
        protocol: 1,
        enabled: config.enabled,
        paired: config.paired,
        allowWrite: config.allowWrite,
        allowDangerous: config.allowDangerous,
        campaignStatus: campaign?.status ?? 'idle',
        assistant,
        quotas,
        tools: TOOL_COUNTS,
        serverTime: new Date().toISOString(),
      }
    },
    get_campaign_stats: () => campaignService.getStats(),
    get_campaign_state: () => getCampaign(),
    get_assistant_state: () => getAssistantState(),
    get_dashboard_stats: () => getApplicationStats(),
    get_platform_quotas: async () => ({ quotas: await getSavedPlatformQuotas(), platforms: PLATFORM_IDS }),
    get_settings: async () => redactSettings(await getAllSettings()),

    // ── 只读：业务数据 ──
    list_applications: async (a) => {
      let rows = await getAllApplications()
      const status = str(a, 'status')
      const platform = str(a, 'platform')
      if (status) rows = rows.filter((r) => r.status === status)
      if (platform) rows = rows.filter((r) => r.platformId === platform)
      return { total: rows.length, items: rows.slice(0, Math.min(500, Math.max(1, num(a, 'limit', 50)))) }
    },
    get_application: async (a) => {
      const id = str(a, 'id')
      if (!id) return null
      return (await getApplicationById(id)) ?? null
    },
    list_resumes: async (a) => {
      const rows = await getAllResumes()
      return { total: rows.length, items: rows.slice(0, Math.max(1, num(a, 'limit', 20))) }
    },
    get_default_resume: () => getDefaultResume(),
    list_blacklist: () => getBlacklist(),
    list_interviews: (a) => (bool(a, 'upcomingOnly') ? getUpcomingInterviews() : getInterviewEvents()),
    get_daily_report: (a) => getDailyReport(str(a, 'date')),
    list_daily_reports: (a) => listDailyReports(Math.max(1, num(a, 'limit', 14))),
    get_daily_report_config: () => getDailyReportConfig(),
    list_evolution_proposals: (a) => listEvolutionProposals((str(a, 'status') || 'all') as 'pending' | 'accepted' | 'rejected' | 'all'),
    list_errors: (a) => listErrors(Math.max(1, num(a, 'limit', 100))),
    get_error_count: () => getErrorCount(),
    get_fix_suggestions: () => getDeveloperFixSuggestions(),
    list_self_healing_events: (a) => listSelfHealingEvents(Math.max(1, num(a, 'limit', 50))),
    get_page_info: async () => {
      try {
        const tabs = await chrome.tabs.query({})
        const target = tabs.find((tab) => tab.url && /(zhipin|liepin|51job|zhaopin|maimai)\./.test(tab.url))
        if (!target || typeof target.id !== 'number') return { available: false, reason: '未打开招聘平台页面' }
        const info = await chrome.tabs.sendMessage(target.id, { type: 'GET_PAGE_INFO' })
        return { available: true, tabUrl: target.url, ...(info || {}) }
      } catch (err) {
        return { available: false, reason: String(err) }
      }
    },
    export_applications_csv: async (a) => {
      const rows = await getAllApplications()
      const limit = num(a, 'limit', rows.length)
      return { fileName: `投递记录_${new Date().toISOString().slice(0, 10)}.csv`, csv: applicationsCsv(rows.slice(0, limit) as unknown as Array<Record<string, unknown>>), rows: Math.min(rows.length, limit) }
    },
    export_blacklist_csv: async () => {
      const rows = await getBlacklist()
      return {
        fileName: `黑名单_${new Date().toISOString().slice(0, 10)}.csv`,
        csv: toCsv(['公司名称', '拉黑原因'], rows.map((r) => [r.companyName, r.reason])),
        rows: rows.length,
      }
    },

    // ── 写入 ──
    set_platform_quota: async (a) => {
      const platform = str(a, 'platform') as PlatformId | undefined
      if (!platform || !PLATFORM_IDS.includes(platform)) throw new Error(`不支持的平台：${platform ?? '(空)'}`)
      const quota = Math.round(num(a, 'quota', 0))
      if (quota < 1 || quota > 500) throw new Error('配额必须在 1–500 之间')
      const saved = await savePlatformQuotas({ [platform]: quota })
      await campaignService.updateQuotas(saved)
      return { platform, quota, quotas: saved }
    },
    set_platform_enabled: async (a) => {
      const platform = str(a, 'platform') as PlatformId | undefined
      const enabled = bool(a, 'enabled')
      if (!platform || enabled === undefined) throw new Error('需要 platform 与 enabled')
      return campaignService.togglePlatform(platform, enabled)
    },
    update_assistant_state: (a) => patchAssistantState({
      ...(str(a, 'panelState') ? { panelState: str(a, 'panelState') as 'expanded' | 'bubble' | 'collapsed' | 'closed' } : {}),
      ...(bool(a, 'pinned') !== undefined ? { pinned: bool(a, 'pinned') } : {}),
      ...(str(a, 'applyMode') ? { applyMode: str(a, 'applyMode') as 'batch' | 'recommend' } : {}),
      ...(bool(a, 'enableAiMatch') !== undefined ? { enableAiMatch: bool(a, 'enableAiMatch') } : {}),
      ...(bool(a, 'liepinResumeMode') !== undefined ? { liepinResumeMode: bool(a, 'liepinResumeMode') } : {}),
    }),
    update_daily_report_config: (a) => saveDailyReportConfig(obj(a, 'config')),
    generate_daily_report: (a) => generateDailyButlerReport('manual', str(a, 'date')),
    dispatch_butler_chat: (a) => dispatchButlerChatMessage(String(a.text || '')),
    add_blacklist: (a) => addToBlacklist(String(a.companyName || ''), str(a, 'reason') || '由外部 AI 添加'),
    remove_blacklist: (a) => removeFromBlacklist(String(a.id || '')),
    add_interview: (a) => saveInterviewEvent(obj(a, 'event') as Parameters<typeof saveInterviewEvent>[0]),
    delete_interview: (a) => deleteInterviewEvent(String(a.id || '')),
    accept_evolution_proposal: (a) => acceptEvolutionProposal(String(a.id || ''), str(a, 'note')),
    reject_evolution_proposal: (a) => rejectEvolutionProposal(String(a.id || ''), str(a, 'note')),
    append_campaign_log: (a) => appendCampaignLog(String(a.message || ''), (str(a, 'level') as 'info' | 'success' | 'warn' | 'error') || 'info'),
    clear_errors: () => clearErrors(),
    check_platforms_auth: () => checkAllPlatformsAuth(),

    // ── 危险 ──
    start_campaign: async (a) => {
      const quotas = obj(a, 'quotas')
      const enabled = Array.isArray(a.enabledPlatforms) ? a.enabledPlatforms as PlatformId[] : undefined
      const cmp = await campaignService.start(
        Object.keys(quotas).length ? normalizePlatformQuotas(quotas) : undefined,
        enabled,
      )
      await patchAssistantState({ panelState: 'collapsed' })
      return cmp
    },
    pause_campaign: (a) => campaignService.pause((str(a, 'reason') as 'user') || 'user'),
    resume_campaign: async () => {
      const cmp = await campaignService.resume()
      await patchAssistantState({ panelState: 'collapsed' })
      return cmp
    },
    stop_campaign: () => deps.shutdownAssistant(),
    trigger_auto_collect: () => campaignService.triggerAutoCollect(),
    clear_pending_tasks: (a) => campaignService.clearPending(str(a, 'platform') as PlatformId | undefined, bool(a, 'recollect') !== false),
    clear_all_applications: () => clearApplications(),
    run_butler_scan: () => butlerRunDaily(),
  }
}

/**
 * 智能中控对话台专用执行入口。
 *
 * 与 handleExternalAiRpc 的区别：这里代表「用户本人在扩展界面里下指令」，
 * 因此不走外部 AI 的 fail-closed 总开关（用户本来就能在 UI 里改配置），
 * 但保留参数校验，并对 dangerous 工具强制 confirm=true 作为第二道防线——
 * 即使模型绕过 UI 审批卡，也执行不了真实投递 / 清空数据。
 */
export async function executeToolForButler(
  toolName: string,
  args: Record<string, unknown>,
  deps: RpcDeps,
): Promise<BridgeResult> {
  // 工具执行失败也要在管家「异常留痕」里看得见；只记工具名与错误，绝不写 args
  // （args 可能含简历正文、黑名单关键词或 confirm 标记）。
  const fail = (error: string): BridgeResult => {
    void recordError({
      source: 'butler.tool',
      message: `[${toolName}] ${error.slice(0, 240)}`,
      context: JSON.stringify({ tool: toolName, via: 'BUTLER_EXEC_TOOL' }),
      dedupeWindowMs: 60_000,
    })
    return { ok: false, error }
  }
  const tool = getTool(toolName)
  if (!tool) return fail(`未知工具：${toolName}`)
  const invalid = validateArgs(tool, args)
  if (invalid) return fail(invalid)
  if (tool.risk === 'dangerous' && args.confirm !== true) {
    return fail('危险动作必须经用户确认（confirm=true）后才能执行')
  }
  try {
    const handler = buildHandlers(deps)[tool.name]
    if (!handler) return fail(`工具 ${tool.name} 尚未实现 handler`)
    const data = await handler(args)
    return { ok: true, data: data ?? null }
  } catch (err) {
    return fail(String((err as { message?: string })?.message || err))
  }
}

export async function handleExternalAiRpc(request: RpcRequest, deps: RpcDeps): Promise<BridgeResult> {
  const tool = getTool(request?.tool)
  if (!tool) return { ok: false, error: `未知工具：${request?.tool ?? '(空)'}` }

  const args = (request.args && typeof request.args === 'object' ? request.args : {}) as Args
  const invalid = validateArgs(tool, args)
  if (invalid) return { ok: false, error: invalid }

  const config = await getExternalAiConfig()
  const gate = gateTool(tool, config, args)
  if (!gate.allowed) return { ok: false, error: gate.reason || '操作被拒绝' }

  // 用户显式关闭 AIbot 后，外部 AI / offscreen 长轮询里排队或迟到的启动类指令
  // 不许把 bot 拉起来：这些工具最终会调 campaignService.start/resume 并清掉停机锁。
  // 停机意图只能由用户本人在扩展里点「开始投递」解除（对话台是用户本人，不走这道闸）。
  if (isAutomationStartTool(tool.name) && (await readUserStopped())) {
    return {
      ok: false,
      error: 'AIbot 已被用户关闭：外部指令不能自动启动投递。请先在扩展里点「开始投递」',
    }
  }

  try {
    const handler = buildHandlers(deps)[tool.name]
    if (!handler) return { ok: false, error: `工具 ${tool.name} 尚未实现 handler` }
    const data = await handler(args)
    return { ok: true, data: data ?? null }
  } catch (err) {
    return { ok: false, error: String((err as { message?: string })?.message || err) }
  }
}
