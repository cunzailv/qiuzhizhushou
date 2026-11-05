// Background Service Worker
import {
  getInterviewEvents,
  markNotified,
} from '../shared/db/interview-store'
import { getDefaultResume } from '../shared/db/resume-store'
import { getApplicationByJobId, saveApplication } from '../shared/db/application-store'
import { setSharedResumeSummary } from '../shared/db/shared-state'
import { resetDailyCounter } from '../shared/antiBot'
import { log, logError, logGroup, logGroupEnd } from '../shared/utils/logger'
import { butlerRunDaily, getActiveFollowUps } from '../shared/agent/butler'
import { campaignService } from './campaign-service'
import {
  acquireRunMode,
  getRuntimeState,
  patchRuntimeState,
  releaseRunMode,
  type RunMode,
} from '../shared/runtime-state'
import { appendTasksToCampaign } from '../shared/agent/queue-store'
import { checkAllPlatformsAuth } from '../shared/platform/auth-checker'
import {
  generateDailyButlerReport,
  getTodayDateStr,
} from '../shared/agent/butler/daily-report-generator'
import {
  getDailyReport,
  listDailyReports,
  getDailyReportConfig,
  saveDailyReportConfig,
  listEvolutionProposals,
  acceptEvolutionProposal,
  rejectEvolutionProposal,
} from '../shared/db/butler-evolution-store'
import { runInductionAnalysis } from '../shared/agent/butler/induction-engine'
import {
  recordError,
  listErrors,
  clearErrors,
  getErrorCount,
  installGlobalErrorCapture,
} from '../shared/db/error-store'
import { sanitizeJobCard, sanitizeJobText } from '../shared/utils/text-sanitizer'
import { dispatchButlerChatMessage } from '../shared/agent/butler/chat-to-action'
import {
  findBestSkillDirect,
  upsertSkillDirect,
  recordSkillFailDirect,
} from '../shared/agent/skill-memory'
import type { AgentSkill } from '../shared/agent/types'
import type { JobCard, MatchResult } from '../shared/types/job'
import { getAssistantState, patchAssistantState } from '../shared/assistant-state'
import { getPlatformEntries } from '../shared/platform'
import {
  findAssistantTabId,
  findJobSiteTabId,
  runAssistantEntry,
} from '../shared/assistant-entry'
import { handleExternalAiRpc } from './external-ai-rpc'
import {
  getExternalAiConfig, saveExternalAiConfig, getExternalAiStatus,
} from '../shared/bridge/config'
import {
  MSG_EXTERNAL_AI_RPC, MSG_EXTERNAL_AI_STATUS, MSG_EXTERNAL_AI_CONTROL,
} from '../shared/bridge/types'

const MOD = 'Background'
const APPLY_TICK_ALARM = 'apply-tick'
const OFFSCREEN_URL = 'src/offscreen/bridge.html'

let offscreenCreating: Promise<void> | null = null

/**
 * 创建（或确保存在）常驻 offscreen document，用来维持对本地桥接服务的长轮询。
 * Service Worker 会被休眠，不能承担长连接；offscreen 页面是扩展上下文，可以。
 * createDocument 在已存在时会抛错，直接忽略即可（Chrome 只允许一个 offscreen 文档）。
 */
async function ensureOffscreenDocument(): Promise<void> {
  if (offscreenCreating) return offscreenCreating
  offscreenCreating = (async () => {
    try {
      await chrome.offscreen.createDocument({
        url: chrome.runtime.getURL(OFFSCREEN_URL),
        reasons: ['WORKERS' as chrome.offscreen.Reason],
        justification: '维持与外部 AI 桥接服务的长轮询连接，让 Claude Code / Codex / 小龙虾能调用扩展能力',
      })
      log(MOD, 'external-ai', 'offscreen bridge document ready')
    } catch (err) {
      // 已存在或当前 Chrome 不支持 offscreen：不阻断任何既有逻辑
      log(MOD, 'external-ai', `offscreen create skipped: ${String(err)}`)
    }
  })().finally(() => { offscreenCreating = null })
  return offscreenCreating
}

// 全局捕获 background 抛出的异常与未处理 Promise rejection
installGlobalErrorCapture()

// Listen for installation
chrome.runtime.onInstalled.addListener(() => {
  log(MOD, 'installed', 'Extension installed')

  // Set up daily reset alarm
  chrome.alarms.create('daily-reset', {
    periodInMinutes: 1440, // 24 hours
  })

  // Set up interview check alarm (every 30 minutes)
  chrome.alarms.create('interview-check', {
    periodInMinutes: 30,
  })

  // Set up butler daily scan alarm (every 24 hours)
  chrome.alarms.create('butler-daily', {
    periodInMinutes: 1440,
  })

  // 定时检查是否到达设定的 xx 点生成“管家日报”
  chrome.alarms.create('butler-daily-report-check', {
    periodInMinutes: 10,
  })

  // 外部 AI 桥接：保活检查（offscreen 页面被浏览器回收时自动重建）
  chrome.alarms.create('external-ai-keepalive', { periodInMinutes: 1 })

  void getExternalAiConfig().then((cfg) => {
    if (cfg.enabled) return ensureOffscreenDocument()
  }).catch(() => {})

  log(MOD, 'installed', 'Alarms created: daily-reset, interview-check, butler-daily, butler-daily-report-check, external-ai-keepalive')
})

// 浏览器启动（Service Worker 首次被唤醒）时恢复桥接长连接
chrome.runtime.onStartup.addListener(() => {
  void getExternalAiConfig().then((cfg) => {
    if (cfg.enabled) return ensureOffscreenDocument()
  }).catch(() => {})
})

// Handle alarms
chrome.alarms.onAlarm.addListener(async (alarm) => {
  log(MOD, 'alarm', `Alarm fired: ${alarm.name}`)

  if (alarm.name === 'external-ai-keepalive') {
    const cfg = await getExternalAiConfig().catch(() => null)
    if (cfg?.enabled) await ensureOffscreenDocument()
    return
  }

  if (alarm.name === 'daily-reset') {
    await resetDailyCounter()
    log(MOD, 'alarm', 'Daily counter reset')
  }

  if (alarm.name === 'interview-check') {
    log(MOD, 'alarm', 'Checking upcoming interviews...')
    await checkUpcomingInterviews()
  }

  if (alarm.name === 'butler-daily') {
    log(MOD, 'alarm', 'Running butler daily scan...')
    await runButlerScan()
  }

  if (alarm.name === 'apply-tick') {
    log(MOD, 'alarm', 'Running campaign tick...')
    await campaignService.tick()
  }

  if (alarm.name === 'butler-daily-report-check') {
    await checkDailyReportSchedule()
  }
})

/** 检查是否到达预设的 xx 点自动生成“管家日报” */
async function checkDailyReportSchedule(): Promise<void> {
  try {
    const config = await getDailyReportConfig()
    if (!config.autoGenerate) return

    const today = getTodayDateStr()
    if (config.lastGeneratedDate === today) return

    const [targetHour, targetMin] = (config.scheduledTime || '18:00').split(':').map((s) => parseInt(s, 10))
    const now = new Date()
    const currentHour = now.getHours()
    const currentMin = now.getMinutes()

    // 若当前时间已到达或超过设定的定时点（如 18:00）
    if (currentHour > targetHour || (currentHour === targetHour && currentMin >= targetMin)) {
      log(MOD, 'daily-report-alarm', `Triggering scheduled daily report at ${config.scheduledTime} for ${today}`)
      await generateDailyButlerReport('scheduled', today)
    }
  } catch (err) {
    logError(MOD, 'checkDailyReportSchedule', err)
  }
}

/** 管家每日扫描：跟进建议生成 → 通知（建议+确认，不自动发送） */
async function runButlerScan(): Promise<{ success: boolean; data?: unknown; error?: string }> {
  try {
    const result = await butlerRunDaily()
    const followUps = await getActiveFollowUps()
    log(MOD, 'butler-daily', `Scan done: ${followUps.length} follow-ups, report: ${result.reportSummary.slice(0, 60)}`)
    if (followUps.length > 0) {
      const first = followUps[0]
      chrome.notifications.create({
        type: 'basic',
        iconUrl: 'icons/icon128.png',
        title: '求职管家 · 跟进提醒',
        message: `${followUps.length} 条跟进建议，如「${first.companyName} - ${first.jobTitle}」投递 ${first.daysSince} 天未回复`,
        priority: 1,
      })
    }
    return { success: true, data: result }
  } catch (error) {
    logError(MOD, 'butler-daily', error, 'Butler scan failed')
    return { success: false, error: String(error) }
  }
}

// Check for upcoming interviews and send notifications
async function checkUpcomingInterviews(): Promise<void> {
  const events = await getInterviewEvents()
  const now = Date.now()
  log(MOD, 'interview-check', `Found ${events.length} events`)

  for (const event of events) {
    if (event.notified) continue

    const eventTime = new Date(event.interviewDate).getTime()
    const timeUntil = eventTime - now

    // Notify if interview is within 1 hour
    if (timeUntil > 0 && timeUntil <= 60 * 60 * 1000) {
      const minutesUntil = Math.round(timeUntil / 60000)
      log(MOD, 'interview-check', `Notifying: ${event.companyName} - ${event.jobTitle} in ${minutesUntil}min`)

      chrome.notifications.create(`interview-${event.id}`, {
        type: 'basic',
        iconUrl: 'icons/icon128.png',
        title: '面试提醒',
        message: `${event.companyName} - ${event.jobTitle} 面试将在 ${minutesUntil} 分钟后开始`,
        priority: 2,
      })

      await markNotified(event.id)
    }
  }
}

// Listen for messages from popup/content scripts
/** 广播取消信号，让正在执行的 campaign 任务尽快中止 */
async function broadcastAssistantCancel(): Promise<void> {
  try {
    const tabs = await chrome.tabs.query({})
    await Promise.all(
      tabs
        .filter((tab) => typeof tab.id === 'number')
        .map((tab) =>
          Promise.resolve(
            chrome.tabs.sendMessage(tab.id as number, { type: 'ASSISTANT_CANCEL' }),
          ).catch(() => {}),
        ),
    )
  } catch {
    // 忽略无法送达的页面
  }
}

/** 关闭浮窗 = 关闭 bot：终止流水线、清定时器/alarm、取消当前任务、同步三方状态 */
async function shutdownAssistant() {
  const campaign = await campaignService.abort()
  try { await chrome.alarms.clear(APPLY_TICK_ALARM) } catch { /* 预期内异常，安全忽略 */ }
  await patchAssistantState({ panelState: 'closed' })
  // 全局停止：无论当前是半自动还是全自动，都释放互斥锁
  await releaseRunMode('idle')
  await broadcastAssistantCancel()
  return { campaign, state: await getAssistantState() }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const senderInfo = sender.tab ? `tab:${sender.tab.id}` : sender.id ? `ext:${sender.id}` : 'unknown'
  log(MOD, 'onMessage', `Received: ${message.type} from ${senderInfo}`)

  // ─── 外部 AI 接入（Claude Code / Codex / OpenClaw 小龙虾 / 任意 MCP 客户端）───
  // 只接受扩展自身上下文发来的 RPC；网页/外部进程无法直接调用。
  if (message.type === MSG_EXTERNAL_AI_RPC) {
    if (sender.id && sender.id !== chrome.runtime.id) {
      sendResponse({ ok: false, error: '拒绝来自扩展外部的消息' })
      return false
    }
    handleExternalAiRpc(message.payload || {}, { shutdownAssistant })
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }))
    return true
  }

  // ─── 半自动 / 全自动互斥锁（单一真源：setting_runtimeState）───
  if (message.type === 'RUNTIME_GET') {
    getRuntimeState().then((state) => sendResponse({ ok: true, state })).catch(() => sendResponse({ ok: false }))
    return true
  }
  if (message.type === 'RUNTIME_ACQUIRE') {
    const mode = message.payload?.mode as RunMode
    if (mode !== 'manual' && mode !== 'autopilot') {
      sendResponse({ ok: false, error: '无效的运行模式' })
      return true
    }
    acquireRunMode(mode)
      .then((result) => sendResponse({ ok: result.ok, state: result.state, conflict: result.conflict }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }))
    return true
  }
  if (message.type === 'RUNTIME_RELEASE') {
    const mode = (message.payload?.mode ?? 'idle') as RunMode
    releaseRunMode(mode).then((state) => sendResponse({ ok: true, state })).catch(() => sendResponse({ ok: false }))
    return true
  }
  if (message.type === 'RUNTIME_PATCH') {
    patchRuntimeState(message.payload?.patch ?? {})
      .then((state) => sendResponse({ ok: true, state }))
      .catch(() => sendResponse({ ok: false }))
    return true
  }

  if (message.type === MSG_EXTERNAL_AI_STATUS) {
    getExternalAiStatus()
      .then((status) => sendResponse({ success: true, data: status }))
      .catch((err) => sendResponse({ success: false, error: String(err) }))
    return true
  }

  if (message.type === MSG_EXTERNAL_AI_CONTROL) {
    const action = message.payload?.action
    if (action === 'set-config') {
      saveExternalAiConfig(message.payload?.patch || {})
        .then(async (cfg) => {
          if (cfg.enabled) await ensureOffscreenDocument()
          sendResponse({ success: true, data: cfg })
        })
        .catch((err) => sendResponse({ success: false, error: String(err) }))
      return true
    }
    if (action === 'ensure') {
      ensureOffscreenDocument()
        .then(() => sendResponse({ success: true }))
        .catch((err) => sendResponse({ success: false, error: String(err) }))
      return true
    }
    if (action === 'reset') {
      saveExternalAiConfig({ paired: false, token: '' })
        .then((cfg) => sendResponse({ success: true, data: cfg }))
        .catch((err) => sendResponse({ success: false, error: String(err) }))
      return true
    }
    if (action === 'status') {
      getExternalAiStatus()
        .then((status) => sendResponse({ success: true, data: status }))
        .catch((err) => sendResponse({ success: false, error: String(err) }))
      return true
    }
  }

  // Handle various message types from popup
  if (message.type === 'GET_STATS') {
    log(MOD, 'GET_STATS', 'Handled by popup directly')
    sendResponse({ success: true })
  }

  if (message.type === 'OPEN_ASSISTANT_SIDEBAR') {
    void openSidebarInActiveTab()
      .then(async (success) => {
        // 当前页不是招聘网站时自动去招聘网站展开侧栏，避免按钮「点了没反应」
        if (!success) await openJobSiteWithSidebar()
        sendResponse({ success: true })
      })
      .catch(() => sendResponse({ success: false }))
    return true
  }

  if (message.type === 'OPEN_ASSISTANT_PANEL') {
    void focusOrCreateAssistantPanel()
      .then(() => sendResponse({ success: true }))
      .catch((err) => sendResponse({ success: false, error: String(err) }))
    return true
  }

  if (message.type === 'OPEN_SIDEBAR_ON_JOB_SITE') {
    void openJobSiteWithSidebar()
      .then((success) => sendResponse({ success }))
      .catch(() => sendResponse({ success: false }))
    return true
  }

  if (message.type === 'OPEN_OPTIONS') {
    chrome.tabs.create({ url: chrome.runtime.getURL('src/options/index.html') })
    sendResponse({ success: true })
    return true
  }

  if (message.type === 'NOTIFY') {
    log(MOD, 'NOTIFY', message.payload?.message || '')
    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: '智能求职助手',
      message: message.payload?.message || '',
      priority: 1,
    })
    sendResponse({ success: true })
  }

  // 管家扫描（popup「管家」页手动触发 / 测试触发；与 butler-daily alarm 同逻辑）
  if (message.type === 'BUTLER_SCAN') {
    log(MOD, 'BUTLER_SCAN', 'Running butler scan from popup')
    runButlerScan().then((result) => sendResponse(result))
    return true // Keep channel open for async response
  }

  // Campaign 自动化流水线控制消息
  if (message.type === 'START_CAMPAIGN') {
    log(MOD, 'START_CAMPAIGN', 'Starting campaign from popup/options')
    // 二次校验：Popup 已申请锁，这里兜住外部 AI / 旧客户端绕过 UI 的情况
    getRuntimeState()
      .then((rt) => {
        if (rt.mode !== 'autopilot') {
          sendResponse({ success: false, error: rt.mode === 'manual'
            ? '概览的半自动沟通正在运行，请先停止后再启动 AIbot'
            : '未取得全自动运行锁，请从 AIbot 页启动' })
          return
        }
        campaignService.start(
          message.payload?.quotas,
          message.payload?.enabledPlatforms,
          message.payload?.windows,
        )
          .then(async (cmp) => {
            // 侧栏正文就是完整助手面板（含 AIbot 实时日志），开跑后保持展开，
            // 不再像旧浮窗版本那样自动收起成半圆浮球。
            const state = await getAssistantState()
            if (state.panelState !== 'expanded') await patchAssistantState({ panelState: 'expanded' })
            sendResponse({ success: true, data: cmp })
          })
          .catch(async (err) => {
            await releaseRunMode('autopilot')
            sendResponse({ success: false, error: String(err) })
          })
      })
      .catch((err) => sendResponse({ success: false, error: String(err) }))
    return true
  }

  if (message.type === 'TOGGLE_PLATFORM') {
    const { platform, enabled } = message.payload || {}
    campaignService.togglePlatform(platform, enabled)
      .then((cmp) => sendResponse({ success: true, data: cmp }))
      .catch((err) => sendResponse({ success: false, error: String(err) }))
    return true
  }

  if (message.type === 'APPEND_CAMPAIGN_LOG') {
    const { message: logMsg, level } = message.payload || {}
    campaignService.log(logMsg, level)
      .then(() => sendResponse({ success: true }))
      .catch((err) => sendResponse({ success: false, error: String(err) }))
    return true
  }

  if (message.type === 'UPDATE_CAMPAIGN_WINDOWS') {
    const windows = message.payload?.windows || []
    campaignService.updateWindows(windows)
      .then((cmp) => sendResponse({ success: true, data: cmp }))
      .catch((err) => sendResponse({ success: false, error: String(err) }))
    return true
  }

  if (message.type === 'UPDATE_CAMPAIGN_INTERVAL') {
    const interval = message.payload?.interval
    campaignService.updateInterval(interval)
      .then((cmp) => sendResponse({ success: true, data: cmp }))
      .catch((err) => sendResponse({ success: false, error: String(err) }))
    return true
  }

  // 用户在 AIbot 面板修改各平台投递数量：持久化 + 运行中即时生效
  if (message.type === 'UPDATE_CAMPAIGN_QUOTAS') {
    const quotas = message.payload?.quotas || {}
    campaignService.updateQuotas(quotas)
      .then((cmp) => sendResponse({ success: true, data: cmp }))
      .catch((err) => sendResponse({ success: false, error: String(err) }))
    return true
  }

  if (message.type === 'CHECK_PLATFORMS_AUTH') {
    checkAllPlatformsAuth()
      .then((authMap) => sendResponse({ success: true, data: authMap }))
      .catch((err) => sendResponse({ success: false, error: String(err) }))
    return true
  }

  if (message.type === 'TRIGGER_AUTO_COLLECT') {
    campaignService.triggerAutoCollect()
      .then((res) => sendResponse({ success: true, data: res }))
      .catch((err) => sendResponse({ success: false, error: String(err) }))
    return true
  }

  if (message.type === 'CLEAR_PENDING_TASKS') {
    campaignService.clearPending(message.payload?.platform, message.payload?.recollect !== false)
      .then((res) => sendResponse({ success: true, data: res }))
      .catch((err) => sendResponse({ success: false, error: String(err) }))
    return true
  }

  if (message.type === 'PAUSE_CAMPAIGN') {
    log(MOD, 'PAUSE_CAMPAIGN', 'Pausing campaign')
    campaignService.pause(message.payload?.reason || 'user')
      .then(async (cmp) => {
        // 暂停即让出互斥锁，用户可切到概览跑半自动；恢复时再重新申请。
        await releaseRunMode('autopilot')
        sendResponse({ success: true, data: cmp })
      })
      .catch((err) => sendResponse({ success: false, error: String(err) }))
    return true
  }

  if (message.type === 'RESUME_CAMPAIGN') {
    log(MOD, 'RESUME_CAMPAIGN', 'Resuming campaign')
    ;(async () => {
      // 恢复等同重新启动：必须重新取得 autopilot 锁，防止与概览半自动并行
      const lock = await acquireRunMode('autopilot')
      if (!lock.ok) {
        sendResponse({
          success: false,
          error: lock.conflict === 'manual'
            ? '概览的半自动沟通正在运行，请先停止后再恢复 AIbot'
            : '无法取得全自动运行锁，请重试',
        })
        return
      }
      try {
        const cmp = await campaignService.resume()
        const state = await getAssistantState()
        if (state.panelState !== 'expanded') await patchAssistantState({ panelState: 'expanded' })
        sendResponse({ success: true, data: cmp })
      } catch (err) {
        await releaseRunMode('autopilot')
        sendResponse({ success: false, error: String(err) })
      }
    })().catch((err) => sendResponse({ success: false, error: String(err) }))
    return true
  }

  if (message.type === 'ABORT_CAMPAIGN') {
    log(MOD, 'ABORT_CAMPAIGN', 'Aborting campaign')
    shutdownAssistant()
      .then(({ campaign }) => sendResponse({ success: true, data: campaign }))
      .catch((err) => sendResponse({ success: false, error: String(err) }))
    return true
  }

  // 悬浮窗 / bot 配置页的统一控制入口
  if (message.type === 'ASSISTANT_CONTROL') {
    const action = message.payload?.action
    if (action === 'shutdown') {
      shutdownAssistant()
        .then(({ state }) => sendResponse({ success: true, data: state }))
        .catch((err) => sendResponse({ success: false, error: String(err) }))
    } else if (action === 'patch') {
      patchAssistantState(message.payload?.patch || {})
        .then((state) => sendResponse({ success: true, data: state }))
        .catch((err) => sendResponse({ success: false, error: String(err) }))
    } else {
      getAssistantState()
        .then((state) => sendResponse({ success: true, data: state }))
        .catch((err) => sendResponse({ success: false, error: String(err) }))
    }
    return true
  }

  if (message.type === 'GET_CAMPAIGN_STATS') {
    campaignService.getStats()
      .then((stats) => sendResponse({ success: true, data: stats }))
      .catch((err) => sendResponse({ success: false, error: String(err) }))
    return true
  }

  if (message.type === 'APPEND_CAMPAIGN_TASKS') {
    const tasks = message.payload?.tasks || []
    appendTasksToCampaign(tasks)
      .then((count) => sendResponse({ success: true, count }))
      .catch((err) => sendResponse({ success: false, error: String(err) }))
    return true
  }

  // ─── 管家日报与复盘消息路由 ───
  if (message.type === 'GET_DAILY_REPORT') {
    getDailyReport(message.payload?.date)
      .then((report) => sendResponse({ success: true, data: report }))
      .catch((err) => sendResponse({ success: false, error: String(err) }))
    return true
  }

  if (message.type === 'LIST_DAILY_REPORTS') {
    listDailyReports(message.payload?.limit || 14)
      .then((reports) => sendResponse({ success: true, data: reports }))
      .catch((err) => sendResponse({ success: false, error: String(err) }))
    return true
  }

  if (message.type === 'GENERATE_DAILY_REPORT') {
    generateDailyButlerReport('manual', message.payload?.date)
      .then((report) => sendResponse({ success: true, data: report }))
      .catch((err) => sendResponse({ success: false, error: String(err) }))
    return true
  }

  if (message.type === 'GET_DAILY_REPORT_CONFIG') {
    getDailyReportConfig()
      .then((cfg) => sendResponse({ success: true, data: cfg }))
      .catch((err) => sendResponse({ success: false, error: String(err) }))
    return true
  }

  if (message.type === 'UPDATE_DAILY_REPORT_CONFIG') {
    saveDailyReportConfig(message.payload || {})
      .then((cfg) => sendResponse({ success: true, data: cfg }))
      .catch((err) => sendResponse({ success: false, error: String(err) }))
    return true
  }

  // ─── 高级进化策略提案消息路由 ───
  if (message.type === 'LIST_EVOLUTION_PROPOSALS') {
    listEvolutionProposals(message.payload?.status || 'all')
      .then((proposals) => sendResponse({ success: true, data: proposals }))
      .catch((err) => sendResponse({ success: false, error: String(err) }))
    return true
  }

  if (message.type === 'ACCEPT_EVOLUTION_PROPOSAL') {
    acceptEvolutionProposal(message.payload?.id, message.payload?.note)
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ success: false, error: String(err) }))
    return true
  }

  if (message.type === 'REJECT_EVOLUTION_PROPOSAL') {
    rejectEvolutionProposal(message.payload?.id, message.payload?.note)
      .then(() => sendResponse({ success: true }))
      .catch((err) => sendResponse({ success: false, error: String(err) }))
    return true
  }

  if (message.type === 'RUN_INDUCTION_ANALYSIS') {
    runInductionAnalysis()
      .then((proposals) => sendResponse({ success: true, data: proposals }))
      .catch((err) => sendResponse({ success: false, error: String(err) }))
    return true
  }

  // ─── 页面端悬浮管家中控对话路由 ───
  if (message.type === 'DISPATCH_BUTLER_CHAT') {
    dispatchButlerChatMessage(message.payload?.text || '', message.payload?.pendingApproval)
      .then((reply) => sendResponse({ success: true, data: reply }))
      .catch((err) => sendResponse({ success: false, error: String(err?.message || err) }))
    return true
  }

  // ─── 异常与 Bug 日志留痕路由 ───
  if (message.type === 'RECORD_ERROR') {
    recordError(message.payload || {})
      .then(() => sendResponse({ success: true }))
      .catch((err) => sendResponse({ success: false, error: String(err) }))
    return true
  }

  if (message.type === 'LIST_ERRORS') {
    listErrors(message.payload?.limit || 100)
      .then((records) => sendResponse({ success: true, data: records }))
      .catch((err) => sendResponse({ success: false, error: String(err) }))
    return true
  }

  if (message.type === 'CLEAR_ERRORS') {
    clearErrors()
      .then(() => sendResponse({ success: true }))
      .catch((err) => sendResponse({ success: false, error: String(err) }))
    return true
  }

  if (message.type === 'GET_ERROR_COUNT') {
    getErrorCount()
      .then((count) => sendResponse({ success: true, count }))
      .catch((err) => sendResponse({ success: false, error: String(err) }))
    return true
  }

  // ─── 自愈韧性智能体技能热修复路由 (Self-Healing Skill Memory) ───
  if (message.type === 'GET_BEST_SKILL') {
    const { platform, pageType, goal } = (message.payload || {}) as {
      platform: string
      pageType: string
      goal: string
    }
    findBestSkillDirect(platform, pageType, goal)
      .then((skill) => sendResponse({ success: true, data: skill }))
      .catch((err) => {
        logError(MOD, 'GET_BEST_SKILL', err)
        sendResponse({ success: false, error: String(err?.message || err) })
      })
    return true
  }

  if (message.type === 'UPSERT_SKILL') {
    upsertSkillDirect(message.payload || {})
      .then((saved) => sendResponse({ success: true, data: saved }))
      .catch((err) => {
        logError(MOD, 'UPSERT_SKILL', err)
        sendResponse({ success: false, error: String(err?.message || err) })
      })
    return true
  }

  if (message.type === 'RECORD_SKILL_FAIL') {
    const skill = (message.payload?.skill || message.payload) as AgentSkill
    recordSkillFailDirect(skill)
      .then(() => sendResponse({ success: true }))
      .catch((err) => {
        logError(MOD, 'RECORD_SKILL_FAIL', err)
        sendResponse({ success: false, error: String(err?.message || err) })
      })
    return true
  }

  // Content script requests default resume from extension's IndexedDB
  if (message.type === 'GET_DEFAULT_RESUME') {
    logGroup(MOD, 'GET_DEFAULT_RESUME')
    log(MOD, 'GET_DEFAULT_RESUME', 'Querying IndexedDB for default resume...')

    getDefaultResume().then(async (resume) => {
      if (resume) {
        log(MOD, 'GET_DEFAULT_RESUME', `Found in IndexedDB: ${resume.name} (id=${resume.id}, skills=${resume.structuredData?.skills?.length})`)
        await setSharedResumeSummary(resume)
        log(MOD, 'GET_DEFAULT_RESUME', 'Restored shared resume state')
        logGroupEnd()
        sendResponse({ success: true, data: resume })
        return
      }

      log(MOD, 'GET_DEFAULT_RESUME', 'Not found in IndexedDB, trying chrome.storage.local fallback...')
      // Fallback: try chrome.storage.local
      try {
        const stored = await chrome.storage.local.get('shared_default_resume_full')
        const fullResume = stored['shared_default_resume_full'] as Record<string, unknown> | undefined
        if (fullResume && typeof fullResume === 'object' && 'structuredData' in fullResume) {
          log(MOD, 'GET_DEFAULT_RESUME', `Found in chrome.storage fallback: ${(fullResume as { name?: string }).name}`)
          logGroupEnd()
          sendResponse({ success: true, data: fullResume })
          return
        }
        log(MOD, 'GET_DEFAULT_RESUME', 'Not found in chrome.storage either')
      } catch (e) {
        logError(MOD, 'GET_DEFAULT_RESUME', e, 'chrome.storage fallback failed')
      }

      log(MOD, 'GET_DEFAULT_RESUME', 'No resume found anywhere')
      logGroupEnd()
      sendResponse({ success: true, data: null })
    }).catch((err) => {
      logError(MOD, 'GET_DEFAULT_RESUME', err, 'IndexedDB query failed')
      logGroupEnd()
      sendResponse({ success: false, error: String(err) })
    })
    return true // Keep channel open for async response
  }

  if (message.type === 'SAVE_APPLICATION') {
    const payload = message.payload as {
      job?: JobCard
      match?: MatchResult
      resumeId?: string
      platformId?: string
      appliedAt?: string
    }
    const { job, match, resumeId, platformId, appliedAt } = payload
    if (!job || !match) {
      sendResponse({ success: false, error: 'Invalid application payload' })
      return false
    }

    getApplicationByJobId(job.id)
      .then((existing) => {
        if (existing) return existing
        const cleanCard = sanitizeJobCard(job)
        return saveApplication({
          jobId: cleanCard.id,
          jobTitle: cleanCard.title,
          companyName: cleanCard.companyName,
          companyLogo: cleanCard.companyLogo,
          salary: cleanCard.salary,
          location: cleanCard.location,
          experience: cleanCard.experience,
          education: cleanCard.education,
          tags: cleanCard.tags,
          jobDescription: sanitizeJobText(cleanCard.jobDescription),
          resumeId: resumeId || 'default-resume',
          matchScore: match.scoreBypassed ? null : (match.score ?? null),
          matchReason: sanitizeJobText(match.recommendation),
          bossName: sanitizeJobText(cleanCard.bossName),
          bossTitle: sanitizeJobText(cleanCard.bossTitle),
          platformId: platformId || cleanCard.platformId || 'unknown',
          appliedAt,
        })
      })
      .then((application) => sendResponse({ success: true, data: application }))
      .catch((error) => {
        logError(MOD, 'SAVE_APPLICATION', error)
        sendResponse({ success: false, error: String(error) })
      })
    return true
  }

  log(MOD, 'onMessage', `Unhandled message type: ${message.type}`)
  return true
})

// ─── 点击扩展图标 / 后台「返回助手」：永远回到助手，绝不把用户困在后台 ───
const POPUP_PAGE_URL = chrome.runtime.getURL('src/popup/index.html')

function extensionOrigin(): string {
  try {
    return new URL(chrome.runtime.getURL('')).origin
  } catch {
    return ''
  }
}

/** 复用已打开的独立助手面板；没有才新建。绝不重复打开管理后台 */
async function focusOrCreateAssistantPanel(): Promise<void> {
  const tabs = await chrome.tabs.query({ currentWindow: true })
  const existingId = findAssistantTabId(tabs, POPUP_PAGE_URL)
  if (existingId !== null) {
    await chrome.tabs.update(existingId, { active: true })
    return
  }
  await chrome.tabs.create({ url: `${POPUP_PAGE_URL}?standalone=1` })
}

/** 「返回助手侧栏」：激活已有招聘网站标签页并展开侧栏；没有则新开平台首页 */
async function openJobSiteWithSidebar(): Promise<boolean> {
  const entries = getPlatformEntries()
  const isJobSite = (url: string) => entries.some((entry) => entry.matchesUrl(url))
  const tabs = await chrome.tabs.query({ currentWindow: true })
  const existingId = findJobSiteTabId(tabs, isJobSite)

  // 写统一控制状态，所有招聘网站标签页会通过 storage.onChanged 同步展开
  await patchAssistantState({ panelState: 'expanded' })

  if (existingId !== null) {
    await chrome.tabs.update(existingId, { active: true })
    return true
  }
  const homeUrl = entries[0]?.homeUrl || 'https://www.zhipin.com/'
  await chrome.tabs.create({ url: homeUrl })
  return true
}

async function toggleAssistantPanelInTab(tabId: number): Promise<boolean> {
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'TOGGLE_ASSISTANT_PANEL' })
    return true
  } catch {
    // content script 尚未注入（非招聘页 / 刚装扩展），动态注入后重试一次
    const scripts = (chrome.runtime.getManifest().content_scripts ?? [])
      .flatMap((entry) => entry.js ?? [])
    if (scripts.length === 0) return false
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: scripts })
      await new Promise((resolve) => setTimeout(resolve, 300))
      await chrome.tabs.sendMessage(tabId, { type: 'TOGGLE_ASSISTANT_PANEL' })
      return true
    } catch (error) {
      logError(MOD, 'action.onClicked', 'Unable to inject assistant panel', error)
      return false
    }
  }
}

// 「侧栏」按钮：在网页右侧唤起整高侧栏（面板正文就是完整的助手面板）
// 受限页面（chrome:// / 扩展页）注入不了时由调用方去招聘网站展开，绝不打开管理后台
async function openSidebarInActiveTab(): Promise<boolean> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!tab?.id) return false
  const url = tab.url ?? ''
  // chrome:// 等受限页面无法注入脚本
  if (!/^https?:/i.test(url)) return false
  return toggleAssistantPanelInTab(tab.id)
}

chrome.action.onClicked.addListener((tab) => {
  void runAssistantEntry(tab.url ?? '', extensionOrigin(), {
    tryToggleSidebar: () =>
      tab.id ? toggleAssistantPanelInTab(tab.id) : Promise.resolve(false),
    openAssistantPanel: focusOrCreateAssistantPanel,
  }).catch((error) => logError(MOD, 'action.onClicked', 'Unable to open assistant', error))
})

// Keep service worker alive
self.addEventListener('activate', () => {
  log(MOD, 'lifecycle', 'Service Worker activated')
})

log(MOD, 'lifecycle', 'Background script loaded')
export {}
