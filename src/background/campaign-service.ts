// 全流程自动化投递协调服务（Background 核心调度器）

import type { PlatformId, TimeWindow, IntervalConfig } from '../shared/agent/quota'
import {
  isWithinWindow,
  getDelayUntilNextWindow,
  getRandomInterval,
  formatTimeWindows,
  saveIntervalConfig,
  savePlatformQuotas,
} from '../shared/agent/quota'
import type { Campaign, ApplyTask } from '../shared/agent/queue-store'
import {
  getCampaign,
  claimNextTask,
  updateTaskResult,
  markPlatformExhausted,
  appendCampaignLog,
  togglePlatformEnabled,
  updateCampaignWindows,
  updateCampaignInterval,
  updateCampaignQuotas,
  clearPendingTasks,
} from '../shared/agent/queue-store'
import {
  startCampaign as startAgentCampaign,
  pauseCampaign as pauseAgentCampaign,
  resumeCampaign as resumeAgentCampaign,
  abortCampaign as abortAgentCampaign,
  aggregateCampaignStats,
  isCampaignFinished,
} from '../shared/agent/campaign'
import { prefetchNextTasksAI } from '../shared/ai/prefetch'
import { AI_FAILURE_KEY, type AiFailureMark } from '../shared/ai/api-client'
import { getDefaultResume } from '../shared/db/resume-store'
import { ensurePlatformTab, sendTabMessageWithRetry, openPlatformLoginTab } from './tab-manager'
import { checkPlatformAuth, checkAllPlatformsAuth } from '../shared/platform/auth-checker'
import { generateDailyButlerReport } from '../shared/agent/butler/daily-report-generator'
import { getDailyReportConfig } from '../shared/db/butler-evolution-store'
import { recordError } from '../shared/db/error-store'
import { extractTargetCareers, diagnoseCareerTokens, normalizeCareerTokens } from '../shared/agent/job-filter'
import { loadSharedApplyFilters } from '../shared/agent/filter-config'
import { replanIfNeeded } from '../shared/agent/planner'
import { sendWebhookNotification } from '../shared/notification/webhook-notifier'
import { recordOutcomeEvent } from '../shared/db/outcome-store'
import {
  getNextSearchKeyword,
  isQueueBelowThreshold,
  formatDiscoveryLogMessage,
} from '../shared/agent/job-discovery'
import type { ApplyFilters } from '../shared/types/filters'
import { releaseRunMode } from '../shared/runtime-state'
import { getSetting, setSetting } from '../shared/db/settings-store'
import { log, logWarn, logError } from '../shared/utils/logger'

const MOD = 'CampaignService'
const ALARM_APPLY_TICK = 'apply-tick'

const PLATFORM_NAMES: Record<PlatformId, string> = {
  boss: 'Boss直聘',
  liepin: '猎聘',
  zhaopin: '智联招聘',
  '51job': '前程无忧',
  maimai: '脉脉',
}

let isTicking = false
let scheduledTimer: ReturnType<typeof setTimeout> | null = null
const consecutiveNotFoundMap: Partial<Record<PlatformId, number>> = {}

/**
 * 连续因“职业方向”过滤导致零新增的轮次。
 * 达到阈值后自动放宽方向限制，改由 AI 匹配分把关，避免方向清单配置不当把产量打成 0。
 */
let careerFilterMissStreak = 0
let careerRelaxAnnounced = false
const CAREER_RELAX_THRESHOLD = 3

/**
 * 每个「平台:关键词」的搜索页码游标（持久化到 storage）。
 * 之前只存内存，Service Worker 被回收后游标归零，
 * 于是每次重启都会重新扫第 1 页（全是投过的岗位）再逐页往后挪，白白空转好几轮。
 */
const SEARCH_PAGE_CURSOR_KEY = 'aibot_search_page_cursor'
const MAX_SEARCH_PAGE = 5
/** 超过这个时间的游标作废，回到第 1 页（新岗位通常出现在搜索结果前部） */
const PAGE_CURSOR_TTL_MS = 12 * 60 * 60 * 1000

interface PageCursorEntry {
  page: number
  at: number
}

export async function getSearchPageCursor(pageKey: string): Promise<number> {
  try {
    const res = await chrome.storage.local.get(SEARCH_PAGE_CURSOR_KEY)
    const map = (res?.[SEARCH_PAGE_CURSOR_KEY] || {}) as Record<string, PageCursorEntry>
    const entry = map[pageKey]
    if (!entry || !entry.page) return 1
    if (Date.now() - (entry.at || 0) > PAGE_CURSOR_TTL_MS) return 1
    return Math.min(Math.max(1, entry.page), MAX_SEARCH_PAGE)
  } catch {
    return 1
  }
}

export async function setSearchPageCursor(pageKey: string, page: number): Promise<void> {
  try {
    const res = await chrome.storage.local.get(SEARCH_PAGE_CURSOR_KEY)
    const map = (res?.[SEARCH_PAGE_CURSOR_KEY] || {}) as Record<string, PageCursorEntry>
    map[pageKey] = { page, at: Date.now() }
    await chrome.storage.local.set({ [SEARCH_PAGE_CURSOR_KEY]: map })
  } catch {
    // 持久化失败时退化为本轮内存行为，不影响采集
  }
}

/** 方向诊断日志去重签名，避免每轮补仓重复刷同一条 */
let careerDiagnosticSig = ''

/** 已上报过的 AI 失败时间戳，保证同一次失败只提示一次 */
let lastReportedAiFailureAt = 0

/**
 * AI 降级可见化：AI 调用失败会被静默回退到本地规则，
 * 用户完全感知不到「AI 其实没工作」。这里把失败标记读出来写进 AIbot 日志。
 */
async function reportAiDegradeIfAny(): Promise<void> {
  try {
    const res = await chrome.storage.local.get(AI_FAILURE_KEY)
    const mark = res?.[AI_FAILURE_KEY] as AiFailureMark | undefined
    if (!mark || !mark.at || mark.at <= lastReportedAiFailureAt) return
    lastReportedAiFailureAt = mark.at

    const reason =
      mark.kind === 'model' ? '模型名可能无效或已停用'
        : mark.kind === 'http' ? '接口返回错误'
        : '网络请求失败'

    await appendCampaignLog(
      `⚠️ AI 调用失败（${reason}）｜模型：${mark.model || '未知'}｜${mark.message}。当前已降级为本地规则评分与话术，请到设置页点「测试连接」排查`,
      'warn',
    )
  } catch {
    // 读取失败不影响主流程
  }
}

/** 连续多轮补仓零新增的次数，用于空转退避（没事干就少折腾） */
let emptyDiscoveryStreak = 0

/** 各平台上次提示“未登录”的时间戳，10 分钟内静默跳过，避免刷屏 */
const authWarnedAt: Partial<Record<PlatformId, number>> = {}
/** 已自动拉起过登录页的平台，只打扰一次 */
const loginTabOpened: Partial<Record<PlatformId, boolean>> = {}
const AUTH_RECHECK_INTERVAL = 10 * 60_000

// ─────────── 关键词自愈：记住「搜不到相关岗位」的词 ───────────
// 之前的行为是：搜索页返回一批无关岗位 → 逐个过滤掉 → 下轮再搜同一个词 → 无限循环。
// 这里让系统自己记住「这个词无效」，24 小时内不再使用，把机会让给其他词。
const INVALID_KEYWORDS_KEY = 'aibot_invalid_keywords'
const INVALID_KEYWORD_TTL_MS = 24 * 60 * 60 * 1000

async function loadInvalidKeywords(): Promise<Record<string, number>> {
  try {
    const res = await chrome.storage.local.get(INVALID_KEYWORDS_KEY)
    const map = (res?.[INVALID_KEYWORDS_KEY] || {}) as Record<string, number>
    const now = Date.now()
    const alive: Record<string, number> = {}
    for (const [k, at] of Object.entries(map)) {
      if (now - (at || 0) < INVALID_KEYWORD_TTL_MS) alive[k] = at
    }
    return alive
  } catch {
    return {}
  }
}

async function markKeywordInvalid(keyword: string): Promise<void> {
  if (!keyword) return
  try {
    const map = await loadInvalidKeywords()
    map[keyword] = Date.now()
    await chrome.storage.local.set({ [INVALID_KEYWORDS_KEY]: map })
  } catch {
    // 持久化失败不影响本轮
  }
}

/**
 * 各平台连续采集通信失败的次数。
 * content script 丢失 / 页面被关 / 平台改版 都会表现成 "Receiving end does not exist"，
 * 连续多次说明不是偶发抖动，必须主动告警，否则用户只会看到一直「没有新岗位」。
 */
const collectErrorStreak: Partial<Record<PlatformId, number>> = {}
const COLLECT_ERROR_ALERT_THRESHOLD = 3

export interface ExecuteTaskResult {
  taskId: string
  status: 'done' | 'skipped' | 'failed' | 'paused'
  matchScore?: number
  matchReason?: string
  greeting?: string
  riskDetected?: 'captcha' | 'rate' | 'block'
  failReason?: string
  appliedAt?: string
}

/** Content Script 采集岗位后回传的统计结果 */
interface CollectJobsResult {
  success: boolean
  collected?: number
  added?: number
  filteredByCareer?: number
  filteredByTime?: number
  filteredByBlacklist?: number
  pageCardTotal?: number
  excludedOnPage?: number
  /** 与搜索关键词字符串命中的卡片数；-1 表示未传关键词（旧口径，仅用于对比） */
  keywordHits?: number
  /** L2 语义复核后真正对口的卡片数；-1 表示未传关键词 */
  relevantHits?: number
  /** 'ai' 表示 AI 语义复核，'local' 表示本地族谱判定（AI 未启用/失败/海投） */
  relevanceSource?: 'ai' | 'local'
  relevanceConfidence?: number
  relevanceReason?: string
  /** 被 AI 判定为不对口而剔除的岗位数 */
  filteredByRelevance?: number
  error?: string
}

/** 触发通知提醒 */
function sendNotification(title: string, message: string, priority = 1) {
  try {
    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title,
      message,
      priority,
    })
  } catch {
    // 忽略通知失败
  }
}

/**
 * 单次最长休眠分片（5 分钟）。
 * MV3 的 Service Worker 会被浏览器回收，内存 setTimeout 随之丢失；长延时 alarm 在
 * 系统休眠 / 扩展重载 / 浏览器重启后也可能被清空，一旦两处都失效就会永久静默。
 * 因此任何长等待都切成分片轮询，最坏情况下 5 分钟内必定重新校验一次时段。
 */
const MAX_SLEEP_CHUNK_MS = 5 * 60_000

/** 上次输出“不在投递时段”日志的时间，用于分片轮询时的日志去重 */
let lastWindowSleepLogAt = 0

/** 设定下一次 tick 触发（结合 setTimeout 与 Alarm 机制双重保险） */
export function scheduleNextTick(delayMs = 60_000) {
  if (scheduledTimer) {
    clearTimeout(scheduledTimer)
    scheduledTimer = null
  }

  // 长等待切片：保证任何异常导致 alarm 丢失时都能在 5 分钟内自愈
  const safeDelay = Math.max(1_000, Math.min(delayMs, MAX_SLEEP_CHUNK_MS))

  // 1. 设置内存定时器（快速响应）
  scheduledTimer = setTimeout(() => {
    runCampaignTick().catch((e) => logError(MOD, 'scheduleNextTick', e))
  }, safeDelay)

  // 2. 同时使用 chrome.alarms 保底（防止 Service Worker 休眠错过）
  const delayMinutes = Math.max(1, Math.ceil(safeDelay / 60_000))
  chrome.alarms.create(ALARM_APPLY_TICK, { delayInMinutes: delayMinutes })
}

/**
 * 一次性修复历史脏数据：把「岗位名称」里被 AI 进化提案 / 简历项目名污染的长句清洗成干净短词。
 * 典型脏数据：「刚刚好智创网站 全栈独立开发 / AI全栈:后台开发 / 全栈」
 * 清洗后：「全栈独立开发 AI全栈 后台开发 全栈」
 */
export async function cleanupDirtyJobTitles(): Promise<void> {
  try {
    const filters = (await getSetting<Record<string, unknown>>('applyFilters', {})) || {}
    const raw = String(filters.jobTitles || '').trim()
    if (!raw) return

    const cleaned = normalizeCareerTokens(raw)
    if (cleaned.length === 0) return

    const joined = cleaned.join(' ')
    const normalizedRaw = raw.replace(/\s+/g, ' ').trim()
    if (joined === normalizedRaw) return

    filters.jobTitles = joined
    await setSetting('applyFilters', filters)
    log(MOD, 'cleanupDirtyJobTitles', `Cleaned jobTitles: "${raw}" -> "${joined}"`)
    await appendCampaignLog(
      `🧽 已自动清洗「岗位名称」中的非法方向词：${normalizedRaw} → ${joined}`,
      'success',
    )
  } catch (e) {
    logWarn(MOD, 'cleanupDirtyJobTitles', e)
  }
}

/**
 * 解除「验证码误报」造成的挂起。
 * 验证码检测已收窄为只看可见浮层，历史上因为整页文本命中而挂起的活动
 * 在扩展重载时自动恢复一次；若确实存在验证码，下一轮会再次挂起。
 */
export async function resumeFalseCaptchaPauseIfNeeded(): Promise<void> {
  try {
    const campaign = await getCampaign()
    if (!campaign || campaign.status !== 'paused' || campaign.pausedReason !== 'captcha') return

    await resumeAgentCampaign()
    await appendCampaignLog(
      '🔄 上次因验证码挂起，已自动恢复投递。如果页面确实弹了验证码，下一轮会再次挂起',
      'info',
    )
    scheduleNextTick(2_000)
  } catch (e) {
    logWarn(MOD, 'resumeFalseCaptchaPauseIfNeeded', e)
  }
}

/**
 * Service Worker / 浏览器冷启动自愈。
 * 扩展被重新加载或浏览器重启后，上一轮注册的 tick alarm 会被清空，
 * 若此时流水线仍处于 running 状态，必须重新挂上调度，否则会永久不再推进。
 */
export async function resumeSchedulerIfNeeded(): Promise<void> {
  try {
    const existing = await chrome.alarms.get(ALARM_APPLY_TICK)
    if (existing) return
    const campaign = await getCampaign()
    if (!campaign || campaign.status !== 'running') return
    log(MOD, 'resumeSchedulerIfNeeded', 'Tick alarm missing while campaign running, rescheduling')
    await appendCampaignLog('🔁 检测到调度定时器丢失，已自动恢复 AIbot 流水线', 'info')
    scheduleNextTick(3_000)
  } catch (e) {
    logWarn(MOD, 'resumeSchedulerIfNeeded', e)
  }
}

/**
 * 推进一次投递队列执行（核心 Tick 循环）
 */
export async function runCampaignTick(): Promise<void> {
  if (isTicking) return
  isTicking = true

  try {
    const campaign = await getCampaign()
    if (!campaign || campaign.status !== 'running') {
      return
    }

    // 1. 检查是否整体已完成
    if (isCampaignFinished(campaign)) {
      campaign.status = 'done'
      await pauseAgentCampaign('user')
      // 自然完成也要让出互斥锁，否则概览半自动会被永久锁住
      await releaseRunMode('autopilot')
      await appendCampaignLog('🎉 所有已启用平台的投递任务均已圆满完成！', 'success')
      sendNotification('🎉 投递活动已完成', '所有已开启平台的投递配额已达成或岗位已投完！')

      // 事后自动触发生成今日“管家日报”
      try {
        const reportCfg = await getDailyReportConfig()
        if (reportCfg.triggerOnCampaignFinished) {
          await generateDailyButlerReport('campaign_finished')
        }
      } catch (e) {
        logWarn(MOD, 'autoGenerateDailyReport', e)
      }
      return
    }

    const now = Date.now()

    // 2. 检查工作时间窗
    if (!isWithinWindow(campaign.windows)) {
      const waitMs = getDelayUntilNextWindow(campaign.windows)
      const waitMins = Math.max(1, Math.round(waitMs / 60_000))
      log(MOD, 'runCampaignTick', `Outside window. Sleeping for ${waitMins} minutes`)
      // 分片轮询会频繁命中这里，日志每 30 分钟最多提示一次，避免刷屏
      if (Date.now() - lastWindowSleepLogAt > 30 * 60_000) {
        lastWindowSleepLogAt = Date.now()
        await appendCampaignLog(
          `🌙 当前不在投递时段内 (允许时段: ${formatTimeWindows(campaign.windows)})，AIbot 进入静默休眠。您可点击底部【工作时段】随时修改或一键设为【24小时不限】立即唤醒`,
          'info',
        )
      }
      // 切片等待：到点后最多 5 分钟内自动醒来，不再依赖单个长延时 alarm
      scheduleNextTick(waitMs)
      return
    }

    // 已进入允许时段，重置休眠日志去重标记，便于下次休眠时再次提示
    lastWindowSleepLogAt = 0

    // 3. 检查强制休息时间（模拟真人离开电脑休息）
    if (campaign.restUntil && campaign.restUntil > now) {
      const restWait = campaign.restUntil - now
      const restMins = Math.round(restWait / 60_000)
      log(MOD, 'runCampaignTick', `Taking human-like rest. Remaining: ${restMins} min`)
      await appendCampaignLog(`☕ 模拟真人休息中，还剩约 ${restMins} 分钟后自动继续`, 'info')
      scheduleNextTick(restWait)
      return
    }

    // 如果连续投递达到 15-25 份，触发 8-20 分钟随机休息
    const restThreshold = 15 + Math.floor(Math.random() * 10)
    if ((campaign.consecutiveRestCounter || 0) >= restThreshold) {
      const restDuration = (8 + Math.floor(Math.random() * 12)) * 60_000
      campaign.restUntil = now + restDuration
      campaign.consecutiveRestCounter = 0
      const durationMins = Math.round(restDuration / 60_000)
      log(MOD, 'runCampaignTick', `Reached threshold ${restThreshold}. Resting for ${durationMins} min`)
      await appendCampaignLog(
        `☕ 已连续投递 ${restThreshold} 份，模拟真人作息休息 ${durationMins} 分钟，防止平台风控`,
        'info',
      )
      sendNotification('☕ AIbot 休息中', `已连续投递 ${restThreshold} 份，模拟真人休息 ${durationMins} 分钟后继续。`)
      scheduleNextTick(restDuration)
      return
    }

    // 3.5 自主重规划：按真实复盘 + 经验记忆调整今日策略（失败静默降级，不影响原流水线）
    await reportAiDegradeIfAny()
    await replanIfNeeded(campaign)

    // 4. 从队列领取下一个任务
    const { task } = await claimNextTask()
    if (!task) {
      // 检查当前是否有启用的平台且尚未达到配额上限
      const activePlatforms = (Object.keys(campaign.quotas) as PlatformId[]).filter((p) => {
        const q = campaign.quotas[p]
        return q && q.enabled !== false && !q.exhausted && q.applied < q.quota
      })

      if (activePlatforms.length === 0) {
        log(MOD, 'runCampaignTick', 'All enabled platforms completed their quota')
        await appendCampaignLog('🎉 所有已开启平台的投递配额均已达成！', 'success')
        campaign.status = 'done'
        await pauseAgentCampaign('user')
        await releaseRunMode('autopilot')
        sendNotification('🎉 投递活动已完成', '所有开启平台的配额已全部投完！')

        // 事后自动触发生成今日“管家日报”
        try {
          const reportCfg = await getDailyReportConfig()
          if (reportCfg.triggerOnCampaignFinished) {
            await generateDailyButlerReport('campaign_finished')
          }
        } catch (e) {
          logWarn(MOD, 'autoGenerateDailyReport', e)
        }
        return
      }

      // 全自动巡检已开启的招聘平台并抓取全新岗位入队
      const hasAdded = await autoCollectJobsForCampaign(campaign, activePlatforms)
      if (hasAdded) {
        emptyDiscoveryStreak = 0
        scheduleNextTick(1000) // 抓取入队成功，1 秒后立即执行新入队任务！
      } else {
        emptyDiscoveryStreak++
        // 空转退避：没有新岗位时逐步拉长巡检间隔，避免每 30 秒扫同一批页面白耗
        const nextMs =
          emptyDiscoveryStreak <= 2 ? 30_000
            : emptyDiscoveryStreak <= 5 ? 2 * 60_000
            : 5 * 60_000

        // 空转 3 轮时给一次“到底卡在哪”的整体诊断，而不是无限重复同一句话
        if (emptyDiscoveryStreak === 3 || emptyDiscoveryStreak === 6) {
          const authMap = await checkAllPlatformsAuth().catch(() => null)
          const offline = authMap
            ? (Object.keys(campaign.quotas) as PlatformId[])
                .filter((p) => campaign.quotas[p]?.enabled !== false && authMap && !authMap[p].isLoggedIn)
                .map((p) => PLATFORM_NAMES[p])
            : []

          const tips: string[] = []
          if (offline.length > 0) tips.push(`登录失效：${offline.join('、')}`)
          tips.push('可将「活跃时间」放宽到本月，或在「岗位名称」里补充更多短职位词')

          await appendCampaignLog(
            `💤 已连续 ${emptyDiscoveryStreak} 轮没有发现新岗位，自动降频为每 ${Math.round(nextMs / 60_000)} 分钟巡检一次（一有新岗位立即恢复高频）。诊断建议：${tips.join('；')}`,
            'info',
          )
        }
        scheduleNextTick(nextMs)
      }
      return
    }

    log(MOD, 'runCampaignTick', `Claimed task: [${task.platform}] ${task.jobTitle} @ ${task.company}`)
    await appendCampaignLog(
      `🎯 认领任务：[${task.platform}] ${task.jobTitle} @ ${task.company}`,
      'info',
    )

    // 5. 确保目标平台 Tab 已就绪
    await appendCampaignLog(`🌐 正在连接 ${task.platform} 平台标签页...`, 'info')
    const tab = await ensurePlatformTab(task.platform)
    if (!tab || !tab.id) {
      logWarn(MOD, 'runCampaignTick', `Cannot open or connect to tab for ${task.platform}`)
      await updateTaskResult(task.id, {
        status: 'failed',
        failReason: `无法打开或连接 ${task.platform} 页面`,
      })
      await appendCampaignLog(`❌ 无法建立与 ${task.platform} 页面的连接，任务跳过`, 'error')
      scheduleNextTick(30_000)
      return
    }

    // 6. 派发任务给 Content Script 执行
    try {
      await appendCampaignLog(`🚀 正在向页面下发投递指令并执行 DOM 交互...`, 'info')
      const execResult = await sendTabMessageWithRetry<ExecuteTaskResult>(
        tab.id,
        {
          type: 'EXECUTE_CAMPAIGN_TASK',
          payload: { task },
        },
        3,
      )

      await handleTaskExecutionResult(task, execResult)
    } catch (err) {
      logError(MOD, 'runCampaignTick', err, `Failed to execute task on tab ${tab.id}`)
      await recordError({
        source: `campaign.tab_comm`,
        message: `向页面派发投递任务通信异常: ${String(err)}`,
        stack: err instanceof Error ? err.stack : undefined,
        context: JSON.stringify({ taskId: task.id, platform: task.platform, tabId: tab.id }),
      })
      await updateTaskResult(task.id, {
        status: 'failed',
        failReason: `任务通信异常: ${String(err)}`,
      })
      await appendCampaignLog(`❌ 任务执行通信异常: ${String(err)}`, 'error')
    }

    // 7. 异步预取接下来 2-3 个岗位的 AI 产出
    try {
      const defaultResume = await getDefaultResume()
      if (defaultResume) {
        prefetchNextTasksAI(defaultResume, 2).then((count) => {
          if (count > 0) {
            appendCampaignLog(`⚡ 后台异步预取：已完成下 ${count} 个岗位的 AI 评分与话术生成`, 'info')
          }
        }).catch(() => {})
      }
    } catch {
      // 忽略预取失败
    }

    // 8. 待投队列全自主搜寻采集中枢：当待投任务 < 5 时，后台静默自动启动补仓
    if (isQueueBelowThreshold(campaign, 5)) {
      const activePlatforms = (Object.keys(campaign.quotas) as PlatformId[]).filter((p) => {
        const q = campaign.quotas[p]
        return q && q.enabled !== false && !q.exhausted && q.applied < q.quota
      })
      if (activePlatforms.length > 0) {
        autoCollectJobsForCampaign(campaign, activePlatforms).catch(() => {})
      }
    }

    // 9. 计算拟人随机延迟，安排下一轮调度
    const nextInterval = getRandomInterval(task.platform, undefined, campaign.intervalConfig)
    const nextSeconds = Math.round(nextInterval / 1000)
    log(MOD, 'runCampaignTick', `Task executed. Next tick in ${nextSeconds}s`)
    await appendCampaignLog(`⏳ 触发拟人安全间隔，随机等待 ${nextSeconds} 秒后处理下一个岗位...`, 'info')
    scheduleNextTick(nextInterval)
  } catch (err) {
    logError(MOD, 'runCampaignTick', err, 'Tick loop error')
    await recordError({
      source: `campaign.tick`,
      message: `流水线调度循环异常: ${String(err)}`,
      stack: err instanceof Error ? err.stack : undefined,
    })
    await appendCampaignLog(`⚠️ 调度异常: ${String(err)}，稍后 60 秒重试`, 'error')
    scheduleNextTick(60_000)
  } finally {
    isTicking = false
  }
}

/** 自动为队列中无可用任务的平台巡检并抓取新岗位 */
async function autoCollectJobsForCampaign(
  campaign: Campaign,
  activePlatforms: PlatformId[],
): Promise<boolean> {
  const existingJobIds = Array.from(new Set([
    ...campaign.tasks.map((t) => t.id),
    ...campaign.tasks.filter((t) => t.jobId).map((t) => t.jobId),
    ...campaign.tasks.filter((t) => t.company && t.jobTitle).map((t) => `${t.company.trim()}:${t.jobTitle.trim()}`),
    ...campaign.tasks.filter((t) => t.company && t.jobTitle).map((t) => `${t.platform}:${t.company.trim()}:${t.jobTitle.trim()}`),
  ]))

  // 1. 获取默认简历与用户筛选偏好（与概览共用同一份配置，不再硬编码评分开关/最低分）
  const defaultResume = await getDefaultResume()
  const filters: ApplyFilters = await loadSharedApplyFilters()

  // 2. 依据简历与筛选偏好提取意向职业清单与轮转关键词 (Feature D)
  //    自动跳过「24 小时内被判定搜不到相关岗位」的关键词
  const invalidKeywords = await loadInvalidKeywords()
  const keywordInfo = await getNextSearchKeyword(
    defaultResume,
    undefined,
    filters,
    Object.keys(invalidKeywords),
  )
  if (keywordInfo.exhausted) {
    await appendCampaignLog(
      `⛔ ${keywordInfo.allKeywords.length} 个关键词全部搜不到相关岗位，24 小时内已标记为无效。请检查：①平台是否已登录 ②账号是否被降权 ③到设置里换成更通用的职位词（如把「PHP开发」改成「PHP」）`,
      'error',
    )
    await pauseAgentCampaign('no_source')
    sendNotification(
      '⚠️ 没有可用的岗位来源',
      '所有搜索关键词都拿不到相关岗位，AIbot 已暂停。请检查平台登录状态与关键词设置。',
      2,
    )
    return false
  }
  const targetCareers = extractTargetCareers(defaultResume, filters)
  const primaryCareerKeyword =
    keywordInfo.keyword ||
    targetCareers[0] ||
    (filters.jobTitles || '').split(/[,，、;；\s|]+/).filter(Boolean)[0] ||
    ''
  const careerLabel = targetCareers.length > 0 ? targetCareers.join(' / ') : keywordInfo.keyword

  // 方向来源与清洗透明度：让用户看清系统实际使用的方向，以及哪些词因“公司名/长句”被剔除
  const rawJobTitles = (filters.jobTitles || '').trim()
  const rawResumePos = (defaultResume?.structuredData?.workExperience?.[0]?.position || '').trim()
  const careerSourceRaw = rawJobTitles || rawResumePos
  const careerSourceLabel = rawJobTitles ? '「岗位名称」设置' : '简历最近工作职位'
  const diagSig = `${careerSourceRaw}||${careerLabel}`
  if (careerSourceRaw && diagSig !== careerDiagnosticSig) {
    careerDiagnosticSig = diagSig
    const diag = diagnoseCareerTokens(careerSourceRaw)
    if (diag.dropped.length > 0) {
      await appendCampaignLog(
        `🧹 目标方向来源：${careerSourceLabel}｜已剔除 ${diag.dropped.length} 个非职位词：${diag.dropped.map((d) => `「${d}」`).join('、')}（公司名/项目名/长句不能当职业方向）`,
        'warn',
      )
    }
  }

  // 连续多轮被“职业方向”过滤到零新增时自动放宽，改由 AI 匹配分把关，避免永远补不到货
  const relaxCareerFilter = careerFilterMissStreak >= CAREER_RELAX_THRESHOLD
  if (relaxCareerFilter && !careerRelaxAnnounced) {
    careerRelaxAnnounced = true
    await appendCampaignLog(
      `🔓 已连续 ${careerFilterMissStreak} 轮因职业方向过滤导致零新增，本轮起自动放宽方向限制（改由 AI 匹配分把关），先保证有岗位可投。建议同步检查「期望职位」是否填成了长句`,
      'warn',
    )
  }

  // 本轮真正可用的平台数（登录正常），用于区分“没岗位”和“平台都用不了”
  let usablePlatforms = 0

  for (const platform of activePlatforms) {
    const pName = PLATFORM_NAMES[platform] || platform
    // 先检查该平台登录状态
    const auth = await checkPlatformAuth(platform)
    if (!auth.isLoggedIn) {
      const lastWarn = authWarnedAt[platform] || 0
      // 10 分钟内已提示过：静默跳过，不刷屏也不重复弹登录页
      if (Date.now() - lastWarn < AUTH_RECHECK_INTERVAL) continue

      authWarnedAt[platform] = Date.now()

      // 首次发现失效时主动拉起登录页，用户扫码登录后自动恢复，不需要到处找入口
      if (!loginTabOpened[platform]) {
        loginTabOpened[platform] = true
        const opened = await openPlatformLoginTab(platform)
        await appendCampaignLog(
          opened
            ? `🔐 【${pName}】登录已失效，已自动为你打开登录页。完成登录后该平台会自动恢复投递（在此之前每 10 分钟复查一次，不再反复提醒）`
            : `🔐 【${pName}】登录已失效，请手动登录后该平台会自动恢复（每 10 分钟复查一次）`,
          'warn',
        )
        sendNotification(`🔐 ${pName} 需要重新登录`, `已为你打开登录页，登录完成后 AIbot 会自动恢复该平台投递。`)
      }
      continue
    }

    // 登录正常：清除该平台的告警与引导标记，下次失效时能重新提醒
    delete authWarnedAt[platform]
    delete loginTabOpened[platform]
    usablePlatforms++

    const pageKey = `${platform}:${primaryCareerKeyword}`
    const currentPage = await getSearchPageCursor(pageKey)

    log(MOD, 'autoCollect', `Connecting to ${platform} for autonomous job collection targeting: ${primaryCareerKeyword} (page ${currentPage})...`)
    await appendCampaignLog(
      `🔍 待投队列待补充，全自主采集中枢轮转启动关键词【${primaryCareerKeyword}】(${keywordInfo.index + 1}/${keywordInfo.total})，正在连接【${pName}】精准补仓（第 ${currentPage} 页）...`,
      'info',
    )

    // 传入目标搜索关键词与页码，优先打开或定位到目标职业的搜索页面
    const tab = await ensurePlatformTab(platform, primaryCareerKeyword, currentPage)
    if (!tab || !tab.id) {
      logWarn(MOD, 'autoCollect', `Cannot open or connect tab for ${platform}`)
      await appendCampaignLog(`⚠️ 无法建立与【${pName}】页面的连接，尝试下一个平台...`, 'warn')
      continue
    }

    try {
      let collectRes = await sendTabMessageWithRetry<CollectJobsResult>(
        tab.id,
        {
          type: 'COLLECT_PLATFORM_JOBS',
          payload: {
            maxJobs: 35,
            existingJobIds,
            targetCareers,
            relaxCareerFilter,
            keyword: primaryCareerKeyword,
            filters,
          },
        },
        3,
      )

      // 命中率过低时「同轮放宽重采」：
      // 抓了 50 个岗位却因为方向白名单过窄只入队 0~1 个，没必要干等好几轮退避，
      // 直接本轮放宽方向再采一次（AI 匹配分仍会把关，不会乱投不相关岗位）。
      const collectedCount = collectRes?.collected ?? 0
      const filteredByCareerCount = collectRes?.filteredByCareer ?? 0
      const hitRateTooLow =
        (collectRes?.added ?? 0) === 0 &&
        filteredByCareerCount >= 5 &&
        filteredByCareerCount >= collectedCount * 0.5

      if (hitRateTooLow && !relaxCareerFilter) {
        await appendCampaignLog(
          `🔓 【${pName}】${collectedCount} 个岗位里有 ${filteredByCareerCount} 个被职业方向筛掉（白名单过窄），本轮立即放宽方向限制重采一次`,
          'warn',
        )
        collectRes = await sendTabMessageWithRetry<CollectJobsResult>(
          tab.id,
          {
            type: 'COLLECT_PLATFORM_JOBS',
            payload: {
              maxJobs: 35,
              existingJobIds,
              targetCareers,
              relaxCareerFilter: true,
              keyword: primaryCareerKeyword,
              filters,
            },
          },
          3,
        )
        careerFilterMissStreak = 0
      }

      // 通信成功（无论是否新增岗位）都应清空该平台的连续失败计数
      if (collectRes) collectErrorStreak[platform] = 0

      // L2 语义复核结论：AI 判过时以 AI 为准（能识破「PHP技术支持」这类含词不对口），
      // AI 不可用/海投模式则退到本地族谱判定；旧的字符串命中数只作为对比口径保留。
      const effectiveRelevantHits = typeof collectRes?.relevantHits === 'number'
        ? collectRes.relevantHits
        : (collectRes?.keywordHits ?? -1)

      // 把 AI 的「判断过程」写进可见日志：字符串命中几个、真正对口几个、剔除了什么、为什么。
      // 只在结论与旧口径不一致 / 零命中 / 有剔除时输出，避免每轮刷屏。
      if (collectRes?.success && primaryCareerKeyword) {
        const finalCollected = collectRes.collected ?? 0
        const stringHits = collectRes.keywordHits ?? -1
        const dropped = collectRes.filteredByRelevance ?? 0
        const diverged = effectiveRelevantHits >= 0 && stringHits >= 0 && effectiveRelevantHits !== stringHits
        if (collectRes.relevanceSource === 'ai' && (diverged || effectiveRelevantHits === 0 || dropped > 0)) {
          const reason = (collectRes.relevanceReason || '').slice(0, 120)
          await appendCampaignLog(
            `🧠 【${pName}】AI 语义复核【${primaryCareerKeyword}】：本页 ${finalCollected} 个岗位里 ${effectiveRelevantHits} 个真正对口（字符串命中 ${stringHits}），已剔除 ${dropped} 个不对口岗位${reason ? `｜${reason}` : ''}`,
            effectiveRelevantHits === 0 ? 'warn' : 'info',
          )
        }
      }

      if (collectRes?.success && (collectRes.added ?? 0) > 0) {
        careerFilterMissStreak = 0
        careerRelaxAnnounced = false
        const pendingCount = campaign.tasks.filter((t) => t.status === 'pending').length
        const logMsg = formatDiscoveryLogMessage({
          keyword: primaryCareerKeyword,
          platform: pName,
          discovered: collectRes.collected || 0,
          added: collectRes.added ?? 0,
          pendingCount,
        })
        await appendCampaignLog(logMsg, 'success')
        return true
      } else {
        // 明细诊断：区分“页面根本没抓到岗位”与“抓到了但被筛掉”，避免无脑循环看不到原因
        const collected = collectRes?.collected ?? 0
        const byCareer = collectRes?.filteredByCareer ?? 0
        const byTime = collectRes?.filteredByTime ?? 0
        const byBlacklist = collectRes?.filteredByBlacklist ?? 0
        const excludedOnPage = collectRes?.excludedOnPage ?? 0
        const pageCardTotal = collectRes?.pageCardTotal ?? 0

        // 本页卡片全部是被排除的已投岗位 → 这一页挖尽了，必须翻页，否则会永远原地空转
        if (collected === 0 && excludedOnPage > 0) {
          const nextPage = currentPage >= MAX_SEARCH_PAGE ? 1 : currentPage + 1
          await setSearchPageCursor(pageKey, nextPage)
          careerFilterMissStreak = 0 // 这不是方向过滤问题，不计入放宽计数
          await appendCampaignLog(
            `📄 【${pName}】关键词【${primaryCareerKeyword}】第 ${currentPage} 页的 ${pageCardTotal} 个岗位全部已投过，本页挖尽，下次自动${nextPage === 1 ? '回到第 1 页（关键词轮转）' : `翻到第 ${nextPage} 页`}`,
            'info',
          )
          continue
        }

        // 搜索关键词零命中：这批卡片与目标方向完全无关，通常意味着搜索页没生效
        //（被重定向到推荐流 / 未登录降级）。继续按方向过滤只会无限空转，
        // 因此把这个词标记为无效（24 小时），让下一轮自动换词，而不是原地打转。
        if (collected > 0 && primaryCareerKeyword && effectiveRelevantHits === 0) {
          await markKeywordInvalid(primaryCareerKeyword)
          const verdict = collectRes?.relevanceSource === 'ai' ? 'AI 语义复核判定' : '本地职业族谱判定'
          const reason = (collectRes?.relevanceReason || '').slice(0, 100)
          await appendCampaignLog(
            `🚫 【${pName}】关键词【${primaryCareerKeyword}】的 ${collected} 个岗位经${verdict}后没有一个真正对口（字符串命中 ${collectRes?.keywordHits ?? -1} 个），已标记为无效（24 小时内跳过），下一轮自动换词重试${reason ? `｜${reason}` : ''}。若页面被降级成推荐流，请确认该平台已登录`,
            'warn',
          )
          continue
        }

        const freshnessLabel =
          filters.publishTime === 'today' ? '今日活跃'
            : filters.publishTime === '3days' ? '3日内活跃'
            : filters.publishTime === 'month' ? '本月活跃'
            : filters.publishTime === 'all' ? '不限时间'
            : '本周活跃'
        const relevanceNote = typeof collectRes?.relevantHits === 'number' && collectRes.relevantHits >= 0
          ? `、语义复核判定对口 ${collectRes.relevantHits} 个（${collectRes.relevanceSource === 'ai' ? 'AI' : '本地规则'}，剔除不对口 ${collectRes.filteredByRelevance ?? 0} 个）`
          : ''
        const detail = pageCardTotal === 0
          ? '页面未解析到任何岗位卡片（搜索结果为空或页面未加载完成）'
          : `抓到 ${collected + excludedOnPage} 个卡片（其中 ${excludedOnPage} 个已投过），职业方向筛掉 ${byCareer} 个、活跃时间筛掉 ${byTime} 个、黑名单筛掉 ${byBlacklist} 个${relevanceNote}`
        await appendCampaignLog(
          `ℹ️ 【${pName}】本轮未新增岗位：${detail}。目标【${careerLabel} · ${freshnessLabel} · 来源：${careerSourceLabel}】${relaxCareerFilter ? '（本轮已放宽方向限制）' : ''}`,
          'info',
        )
        // 统计“被职业方向砍到零产出”的连续轮次，用于自动放宽
        if (collected > 0 && byCareer > 0 && (collectRes?.added ?? 0) === 0) {
          careerFilterMissStreak++
        } else if (collected > 0 && byCareer === 0) {
          // 放宽后已无方向过滤仍无新增：说明确实没新岗位，不必继续加码
          careerFilterMissStreak = 0
        }
      }
    } catch (err) {
      logWarn(MOD, 'autoCollect', err)
      await recordError({
        source: `campaign.auto_collect`,
        message: `【${pName}】自动扫描岗位异常: ${String(err)}`,
        stack: err instanceof Error ? err.stack : undefined,
        context: JSON.stringify({ platform, careerLabel }),
      })
      await appendCampaignLog(`⚠️ 【${pName}】自动扫描通信异常: ${String(err)}，尝试下一平台...`, 'warn')

      const streak = (collectErrorStreak[platform] || 0) + 1
      collectErrorStreak[platform] = streak
      if (streak === COLLECT_ERROR_ALERT_THRESHOLD) {
        await appendCampaignLog(
          `🚨 【${pName}】已连续 ${streak} 次无法与平台页面通信，通常是页面被关闭、扩展未注入或平台页面改版。请打开该平台页面确认后再继续`,
          'error',
        )
        sendNotification(
          `⚠️ ${pName} 采集中断`,
          `已连续 ${streak} 次无法与该平台页面通信，可能是页面已关闭或平台改版。请打开平台页面检查。`,
          2,
        )
      }
    }
  }

  if (usablePlatforms === 0) {
    await appendCampaignLog(
      '⛔ 所有已启用平台当前都无法使用（未登录 / 授权失效），本轮补仓已跳过。完成登录后 AIbot 会自动恢复，无需重新启动',
      'warn',
    )
    return false
  }

  await appendCampaignLog(
    'ℹ️ 可用平台本轮均无更多全新岗位，AIbot 将按自适应频率继续巡检补仓（连续无进展会自动降频，一有新岗位立刻恢复）',
    'info',
  )
  return false
}

/** 处理 Content Script 返回的单任务执行结果 */
async function handleTaskExecutionResult(task: ApplyTask, result: ExecuteTaskResult) {
  // 1. 验证码挂起处理
  if (result.riskDetected === 'captcha') {
    logWarn(MOD, 'handleTaskExecutionResult', `Captcha detected on ${task.platform}! Pausing campaign.`)
    await updateTaskResult(task.id, {
      status: 'paused',
      failReason: '命中验证码，等待人工解除',
    })
    await pauseAgentCampaign('captcha')
    await appendCampaignLog(
      `🚨 [${task.platform}] 检测到安全验证码！AIbot 已紧急挂起，等待人工验证。若页面上看不到验证码，多半是岗位描述/页脚出现「验证码」「安全验证」等字样导致的误判——直接点「继续」或重载扩展即可恢复`,
      'error',
    )
    sendNotification('⚠️ 命中安全验证码', `平台 [${task.platform}] 触发验证码，已自动挂起投递。请在浏览器中解除后点击“继续”。`, 2)
    sendWebhookNotification({
      title: `🚨 命中安全验证码 (${task.platform})`,
      content: `⚠️ 平台【${task.platform}】触发图形验证码，AIbot 已安全挂起投递保护账号。\n\n- **当前岗位**：${task.jobTitle} (${task.company})\n- **处理方式**：请在浏览器中完成验证码滑块/点选，然后在插件面板点击“继续”。`,
      type: 'risk_warning',
      extra: { platform: task.platform, taskId: task.id },
    }).catch(() => {})
    return
  }

  // 2. 账号封禁处理
  if (result.riskDetected === 'block') {
    logError(MOD, 'handleTaskExecutionResult', `Account block risk detected on ${task.platform}! Aborting.`)
    await updateTaskResult(task.id, {
      status: 'failed',
      failReason: '账号异常/被风控封禁',
    })
    await abortAgentCampaign('blocked')
    await appendCampaignLog(`🛑 [${task.platform}] 账号受限告警！已紧急终止全平台投递！`, 'error')
    sendNotification('⛔ 账号受限告警', `平台 [${task.platform}] 检测到账号受限文案，已紧急停止全部投递！`, 2)
    sendWebhookNotification({
      title: `⛔ 账号受限告警 (${task.platform})`,
      content: `🛑 平台【${task.platform}】检测到账号受限或违规文案，AIbot 已紧急全量熔断并终止投递，请登录官方 APP 检查账号状态！`,
      type: 'risk_warning',
      extra: { platform: task.platform, taskId: task.id },
    }).catch(() => {})
    return
  }

  // 3. 平台日限处理
  if (result.riskDetected === 'rate') {
    logWarn(MOD, 'handleTaskExecutionResult', `Daily limit reached on ${task.platform}`)
    await markPlatformExhausted(task.platform)
    await updateTaskResult(task.id, {
      status: 'pending', // 退回待执行，留待次日或切平台
    })
    await appendCampaignLog(`⚠️ [${task.platform}] 今日投递已达上限，已自动轮转至下一平台`, 'warn')
    sendNotification('ℹ️ 平台日限已达', `平台 [${task.platform}] 今日投递已达上限，已自动轮转至下一平台。`)
    sendWebhookNotification({
      title: `ℹ️ 平台日限已达 (${task.platform})`,
      content: `平台【${task.platform}】今日沟通额度已达到上限，AIbot 已自动轮转至下一有效平台继续推进。`,
      type: 'risk_warning',
      extra: { platform: task.platform },
    }).catch(() => {})
    return
  }

  // 4. 正常更新任务结果
  await updateTaskResult(task.id, {
    status: result.status,
    matchScore: result.matchScore,
    matchReason: result.matchReason,
    greeting: result.greeting,
    failReason: result.failReason,
    appliedAt: result.appliedAt || (result.status === 'done' ? new Date().toISOString() : undefined),
  })

  if (result.status === 'done') {
    consecutiveNotFoundMap[task.platform] = 0
    log(MOD, 'handleTaskExecutionResult', `Successfully applied: ${task.jobTitle} @ ${task.company}`)
    // L3 结果回流：记录「哪个搜索方向投出去的」，后续 HR 回复才能按方向算真实回复率
    await recordOutcomeEvent({
      kind: 'applied',
      jobId: task.jobId,
      jobTitle: task.jobTitle,
      company: task.company,
      platform: task.platform,
      direction: task.searchKeyword,
    })
    await appendCampaignLog(
      `✅ 投递成功！已向 [${task.platform}]「${task.company} - ${task.jobTitle}」发起沟通并发送个性化话术`,
      'success',
    )
  } else if (result.status === 'skipped') {
    await appendCampaignLog(
      `⏭️ 智能跳过：[${task.platform}] ${task.jobTitle} (匹配分: ${result.matchScore ?? '低'}，未达到投递门槛)`,
      'info',
    )
  } else if (result.status === 'failed') {
    await recordError({
      source: `campaign.${task.platform}`,
      message: `投递未完成: [${task.platform}] ${task.jobTitle} @ ${task.company} (原因: ${result.failReason || '未知'})`,
      context: JSON.stringify({
        taskId: task.id,
        jobId: task.jobId,
        jobUrl: task.jobUrl,
        platform: task.platform,
        failReason: result.failReason,
      }),
    })
    await appendCampaignLog(
      `❌ 投递未完成：[${task.platform}] ${task.jobTitle} (原因: ${result.failReason || '未知'})`,
      'warn',
    )

    // 核心自动感知：若连续找不到卡片/无法展开（说明用户切换了搜索关键词、城市、翻页或刷新页面，待投缓存已脱节）
    const isCardNotFound =
      result.failReason?.includes('未找到对应岗位卡片') ||
      result.failReason?.includes('详情无法展开')

    if (isCardNotFound) {
      const currentCount = (consecutiveNotFoundMap[task.platform] || 0) + 1
      consecutiveNotFoundMap[task.platform] = currentCount
      if (currentCount >= 2) {
        const pName = PLATFORM_NAMES[task.platform] || task.platform
        logWarn(MOD, 'handleTaskExecutionResult', `Platform ${task.platform} consecutive card not found! Page likely changed. Auto-clearing pending tasks and re-collecting...`)
        await appendCampaignLog(
          `🔄 检测到【${pName}】连续未能定位岗位卡片，判定页面已跳转/刷新/更换筛选词（待投缓存已失效）！正在自动清空旧页面的过期待投队列，并根据当前最新页面重新获取岗位...`,
          'warn',
        )
        consecutiveNotFoundMap[task.platform] = 0
        const cleared = await clearPendingTasks(task.platform)
        if (cleared > 0) {
          const campaign = await getCampaign()
          if (campaign) {
            await autoCollectJobsForCampaign(campaign, [task.platform])
            scheduleNextTick(1000)
          }
        }
      }
    } else {
      consecutiveNotFoundMap[task.platform] = 0
    }
  }
}

// 统一服务导出接口
export const campaignService = {
  start: async (
    customQuotas?: Partial<Record<PlatformId, number>>,
    enabledPlatforms?: PlatformId[],
    windows?: TimeWindow[],
  ) => {
    const cmp = await startAgentCampaign(customQuotas, enabledPlatforms, windows)
    // 启动即校验时段：非时段立刻给出明确提示，避免“开了却一直没动静”
    if (cmp && !isWithinWindow(cmp.windows)) {
      const waitMins = Math.max(1, Math.round(getDelayUntilNextWindow(cmp.windows) / 60_000))
      const tip = `⏸ AIbot 已启动，但当前不在投递时段（${formatTimeWindows(cmp.windows)}），约 ${waitMins} 分钟后自动开始。如需立刻投递，请点击底部【工作时段】改为「24小时不限」后保存。`
      await appendCampaignLog(tip, 'warn')
      sendNotification('⏸ AIbot 已启动 · 当前不在投递时段', tip, 2)
    }
    scheduleNextTick(1000) // 1 秒后立即启动
    return cmp
  },
  pause: async (reason: Campaign['pausedReason'] = 'user') => {
    const cmp = await pauseAgentCampaign(reason)
    if (scheduledTimer) clearTimeout(scheduledTimer)
    scheduledTimer = null
    // 暂停/终止后必须同时清掉 alarm 保底，否则 Service Worker 被唤醒后仍会跑下一 tick
    try { await chrome.alarms.clear(ALARM_APPLY_TICK) } catch { /* 预期内异常，安全忽略 */ }
    return cmp
  },
  resume: async () => {
    const cmp = await resumeAgentCampaign()
    scheduleNextTick(1000)
    return cmp
  },
  abort: async () => {
    const cmp = await abortAgentCampaign()
    if (scheduledTimer) clearTimeout(scheduledTimer)
    scheduledTimer = null
    try { await chrome.alarms.clear(ALARM_APPLY_TICK) } catch { /* 预期内异常，安全忽略 */ }
    return cmp
  },
  togglePlatform: async (platform: PlatformId, enabled: boolean) => {
    return togglePlatformEnabled(platform, enabled)
  },
  updateWindows: async (windows: TimeWindow[]) => {
    const cmp = await updateCampaignWindows(windows)
    await appendCampaignLog(
      `🕒 已更新工作时段：${formatTimeWindows(windows)}`,
      'info',
    )
    if (cmp?.status === 'running') {
      scheduleNextTick(1000)
    }
    return cmp
  },
  updateInterval: async (interval: IntervalConfig) => {
    await saveIntervalConfig(interval)
    const cmp = await updateCampaignInterval(interval)
    await appendCampaignLog(
      `⏱️ 已更新拟人间歇：${interval.minSeconds}-${interval.maxSeconds} 秒随机等待`,
      'info',
    )
    return cmp
  },
  /** 保存并即时应用各平台投递数量；运行中立刻重新调度，未启动时仅落盘待下次开跑生效 */
  updateQuotas: async (quotas: Partial<Record<PlatformId, number>>) => {
    const saved = await savePlatformQuotas(quotas)
    const cmp = await updateCampaignQuotas(saved)
    if (cmp?.status === 'running') {
      scheduleNextTick(1000)
    }
    return cmp
  },
  triggerAutoCollect: async () => {
    let cmp = await getCampaign()
    if (!cmp) {
      // 尚未创建活动时，先初始化一个处于 paused 状态的活动用于承载待投队列
      cmp = await startAgentCampaign()
      await pauseAgentCampaign('user')
    }
    const activePlatforms = (Object.keys(cmp.quotas) as PlatformId[]).filter((p) => {
      const q = cmp.quotas[p]
      return q && q.enabled !== false && !q.exhausted && q.applied < q.quota
    })
    const res = await autoCollectJobsForCampaign(cmp, activePlatforms)
    if (cmp.status === 'running') {
      scheduleNextTick(1000)
    }
    return res
  },
  clearPending: async (platform?: PlatformId, recollect = true) => {
    const cleared = await clearPendingTasks(platform)
    let recollected = false
    if (recollect) {
      const cmp = await getCampaign()
      if (cmp) {
        const activePlatforms = (Object.keys(cmp.quotas) as PlatformId[]).filter((p) => {
          if (platform && p !== platform) return false
          const q = cmp.quotas[p]
          return q && q.enabled !== false && !q.exhausted && q.applied < q.quota
        })
        if (activePlatforms.length > 0) {
          recollected = await autoCollectJobsForCampaign(cmp, activePlatforms)
          if (cmp.status === 'running') {
            scheduleNextTick(1000)
          }
        }
      }
    }
    return { cleared, recollected }
  },
  log: async (message: string, level?: 'info' | 'success' | 'warn' | 'error') => {
    return appendCampaignLog(message, level)
  },
  getStats: async () => {
    const cmp = await getCampaign()
    if (!cmp) return null
    return aggregateCampaignStats(cmp)
  },
  tick: runCampaignTick,
}
