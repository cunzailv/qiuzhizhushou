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

const MOD = 'Background'
const APPLY_TICK_ALARM = 'apply-tick'

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

  log(MOD, 'installed', 'Alarms created: daily-reset, interview-check, butler-daily, butler-daily-report-check')
})

// Handle alarms
chrome.alarms.onAlarm.addListener(async (alarm) => {
  log(MOD, 'alarm', `Alarm fired: ${alarm.name}`)

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
  await broadcastAssistantCancel()
  return { campaign, state: await getAssistantState() }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const senderInfo = sender.tab ? `tab:${sender.tab.id}` : sender.id ? `ext:${sender.id}` : 'unknown'
  log(MOD, 'onMessage', `Received: ${message.type} from ${senderInfo}`)

  // Handle various message types from popup
  if (message.type === 'GET_STATS') {
    log(MOD, 'GET_STATS', 'Handled by popup directly')
    sendResponse({ success: true })
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
    campaignService.start(
      message.payload?.quotas,
      message.payload?.enabledPlatforms,
      message.payload?.windows,
    )
      .then(async (cmp) => {
        // bot 启动后浮窗自动收缩到右侧，不遮挡页面（用户可随时展开）
        await patchAssistantState({ panelState: 'collapsed' })
        sendResponse({ success: true, data: cmp })
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
      .then((cmp) => sendResponse({ success: true, data: cmp }))
      .catch((err) => sendResponse({ success: false, error: String(err) }))
    return true
  }

  if (message.type === 'RESUME_CAMPAIGN') {
    log(MOD, 'RESUME_CAMPAIGN', 'Resuming campaign')
    campaignService.resume()
      .then(async (cmp) => {
        await patchAssistantState({ panelState: 'collapsed' })
        sendResponse({ success: true, data: cmp })
      })
      .catch((err) => sendResponse({ success: false, error: String(err) }))
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

// Keep service worker alive
self.addEventListener('activate', () => {
  log(MOD, 'lifecycle', 'Service Worker activated')
})

log(MOD, 'lifecycle', 'Background script loaded')
export {}
