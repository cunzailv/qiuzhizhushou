// 全流程自动化投递协调服务（Background 核心调度器）

import type { PlatformId, TimeWindow, IntervalConfig } from '../shared/agent/quota'
import {
  isWithinWindow,
  getDelayUntilNextWindow,
  getRandomInterval,
  formatTimeWindows,
  saveIntervalConfig,
  savePlatformQuotas,
  DEFAULT_INTERVAL_CONFIG,
  DEFAULT_WINDOWS,
  countUsableMinutesUntil,
} from '../shared/agent/quota'
import type { Campaign, ApplyTask } from '../shared/agent/queue-store'
import type { ApplyVerification } from '../shared/agent/apply-verification'
import {
  isApplySuccessUrl,
  parseApplySuccessJobId,
  findApplySuccessTask,
} from '../shared/agent/apply-success'
import {
  getCampaign,
  saveCampaign,
  claimNextTask,
  updateTaskResult,
  markPlatformExhausted,
  appendCampaignLog,
  togglePlatformEnabled,
  updateCampaignWindows,
  updateCampaignInterval,
  updateCampaignQuotas,
  clearPendingTasks,
  persistRestState,
  persistCapacityGoal,
  isRecyclableTask,
  clearPlatformExhausted,
  purgeStaleJobUrlTasks,
  TASK_RETRY_COOLDOWN_MS,
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
import {
  ensurePlatformTab,
  isForegroundMode,
  releaseDedicatedTabs,
  sendTabMessageWithRetry,
  openPlatformLoginTab,
} from './tab-manager'
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
  extractSearchKeywords,
  isQueueBelowThreshold,
  formatDiscoveryLogMessage,
} from '../shared/agent/job-discovery'
import type { ApplyFilters } from '../shared/types/filters'
import { releaseRunMode } from '../shared/runtime-state'
import { getSetting, setSetting } from '../shared/db/settings-store'
import { applyDeliveryStrategy, getDeliveryStrategy } from '../shared/agent/delivery-strategy'
import {
  DEFAULT_REST_ENABLED,
  REST_ENABLED_KEY,
  decideRest,
  pickInitialRestThreshold,
  resolveRestPolicy,
  type RestPolicy,
} from '../shared/agent/rest-policy'
import {
  CAPACITY_GOAL_KEY,
  DEFAULT_CAPACITY_GOAL,
  describeCapacityStatus,
  evaluateCapacityGoal,
  normalizeCapacityGoal,
  resolvePacingInterval,
  isCapacityUrgent,
  checkCapacityWindowFit,
  isMustAchieve,
  isGoalAchieved,
  describeMustAchieveTakeover,
  type CapacityEvaluation,
  type CapacityGoal,
} from '../shared/agent/capacity-goal'
import {
  planMustAchieveQuotas,
  shouldBypassWorkWindow,
  relaxFiltersForMustAchieve,
  shouldKeepCollectingOnNoSource,
  shouldMarkKeywordInvalid,
  resolveCollectMaxJobs,
  MUST_ACHIEVE_EXHAUSTED_COOLDOWN_MS,
  MUST_ACHIEVE_EXHAUSTED_RETRY_MS,
  MUST_ACHIEVE_WATCHDOG_ALARM,
  MUST_ACHIEVE_WATCHDOG_PERIOD_MINUTES,
  decideMustAchieveWatchdog,
} from '../shared/agent/must-achieve'
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
/** 连续「点了按钮但平台没确认」的次数，用于提示用户检查登录态 / 风控 / 页面结构 */
const consecutiveUnverifiedMap: Partial<Record<PlatformId, number>> = {}
const UNVERIFIED_ALERT_THRESHOLD = 3

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

/**
 * 本页没有新增岗位就翻页。
 *
 * 旧版只在 `collected === 0 && excludedOnPage > 0`（整页全是已投岗位）时翻页，
 * 而现场日志是「抓到 75 张卡、语义对口 35 个、added=0」——卡片还在、只是都
 * 被历史去重键挡住了，于是页码永远停在第 1 页，关键词轮转也只是在重复扫同一批卡片。
 * 这是「设了目标产能却一个都投不出去」的直接供给死锁。
 */
export function nextSearchPage(currentPage: number, maxPage = MAX_SEARCH_PAGE): number {
  return currentPage >= maxPage ? 1 : currentPage + 1
}

/** 方向诊断日志去重签名，避免每轮补仓重复刷同一条 */
let careerDiagnosticSig = ''
/** 技术栈约束可见化日志的去重签名，避免每轮刷屏 */
let lastStackNoticeSig = ''

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
 * 必达模式启动时清空 24 小时无效词标记。
 * 常规模式下这个机制能避免原地打转，但「目标必须达成」时它等于把当天所有词
 * 一次性锁死（日志会写「全部关键词无效 → AIbot 已暂停」），是明确的自设停机出口。
 */
async function clearInvalidKeywords(): Promise<void> {
  try {
    await chrome.storage.local.remove(INVALID_KEYWORDS_KEY)
  } catch {
    // 清不掉最多下一轮仍读到旧标记，采集层会把它们当作可用词处理
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
  /** 现场 DOM 诊断 JSON（content 侧采集），定位失败时写进后台日志与错误记录 */
  diagnostics?: string
  /** 平台侧确认证据；只有 level=confirmed 的任务才会走到 done */
  verification?: ApplyVerification
}

/** 把 content 侧回传的 DOM 诊断 JSON 压成一句人话，避免日志里塞一大段 JSON */
function describeRunnerDiagnostics(raw: string): string {
  try {
    const d = JSON.parse(raw) as Record<string, unknown>
    const cards = Number(d.jobCards) || 0
    const details = Number(d.detailLinks) || 0
    const parts = [
      `页面 ${String(d.pageUrlShort || '未知')}`,
      `${cards} 张岗位卡片`,
      `${details} 个岗位详情链接`,
      `${Number(d.buttons) || 0} 个按钮`,
      `正文 ${Number(d.bodyTextLength) || 0} 字`,
    ]
    const company = Number(d.companyLinks) || 0
    if (company > 0) {
      // 公司页链接成堆、岗位卡片为 0，几乎一定是后台 tab 停在详情页 / 公司页而非搜索列表页
      parts.push(`公司页链接 ${company} 个（疑似不是列表页）`)
    }
    if (cards === 0 && details > 0) {
      // 猎聘现场：0 张卡片 / 41 个详情链接 —— 页面有岗位，只是卡片容器选择器失配
      parts.push('有岗位链接但卡片容器未命中（疑似站点改版或目标岗位不在本页）')
    }
    if (Array.isArray(d.sampleLinkTexts) && d.sampleLinkTexts.length > 0) {
      parts.push(`岗位样例：${d.sampleLinkTexts.slice(0, 2).join(' / ')}`)
    }
    return parts.join(' / ')
  } catch {
    return '诊断信息不可用'
  }
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
  /** 本页因「已在队列 / 已投过」被跳过的卡片数（真实去重数） */
  excludedOnPage?: number
  /** 本页因采集上限被截断、根本没参与筛选的卡片数 */
  truncatedByCap?: number
  /** 通过采集层全部硬筛、真正提交入队的任务数 */
  tasksProduced?: number
  /** tasksProduced 里被队列去重挡下的数量（added = tasksProduced - duplicatesAtAppend） */
  duplicatesAtAppend?: number
  /** 其他硬条件（薪资 / 学历 / 未归类）筛掉的卡片数 */
  filteredOther?: number
  /** 与搜索关键词字符串命中的卡片数；-1 表示未传关键词（旧口径，仅用于对比） */
  keywordHits?: number
  /** L2 语义复核后真正对口的卡片数；-1 表示未传关键词 */
  relevantHits?: number
  /** 'ai' 表示 AI 语义复核，'local' 表示本地族谱判定（AI 未启用/失败/海投） */
  relevanceSource?: 'ai' | 'local'
  relevanceConfidence?: number
  relevanceReason?: string
  /** 被语义复核判定为不对口而剔除的岗位数 */
  filteredByRelevance?: number
  /** 被技术栈硬约束剔除的岗位数（如 PHP 方向下的 Java / 前端） */
  filteredByStack?: number
  /** 本轮生效的技术栈约束（中文标签），写进日志让用户能看到 */
  targetStackLabels?: string[]
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

/**
 * 「不在投递时段」日志的去重时间戳必须持久化。
 * 旧版用模块级内存变量，MV3 Service Worker 每次被回收后重置，
 * 5 分钟切片一醒就重复打一条一模一样的休眠日志。
 */
const WINDOW_SLEEP_LOG_KEY = 'aibot_last_window_sleep_log_at'

async function readWindowSleepLogAt(): Promise<number> {
  try {
    const res = await chrome.storage.local.get(WINDOW_SLEEP_LOG_KEY)
    const value = Number(res?.[WINDOW_SLEEP_LOG_KEY] ?? 0)
    return Number.isFinite(value) ? value : 0
  } catch {
    return 0
  }
}

async function markWindowSleepLogAt(at: number): Promise<void> {
  try {
    await chrome.storage.local.set({ [WINDOW_SLEEP_LOG_KEY]: at })
  } catch {
    // 去重标记写不进去最多多打一条日志，不影响业务
  }
}
/** 上次输出“休息中”日志的时间；5 分钟切片轮询时不重复刷屏 */
let lastRestNoticeAt = 0
/** 目标产能预警节流，避免每个 tick 都刷同一句 */
let lastCapacityNoticeAt = 0
/** 到点未达成只通知一次，按 campaignId 去重 */
let capacityMissedNotifiedFor = ''

/** 汇总已启用平台的今日配额进度，让「投不满」时用户能一眼看到卡在哪 */
function summarizeQuotaProgress(campaign: Campaign): {
  applied: number
  quota: number
  remaining: number
} {
  let applied = 0
  let quota = 0
  for (const pid of Object.keys(campaign.quotas) as PlatformId[]) {
    const q = campaign.quotas[pid]
    if (!q || q.enabled === false) continue
    quota += q.quota
    applied += q.applied
  }
  return { applied, quota, remaining: Math.max(0, quota - applied) }
}

/**
 * 「N 小时投满 M 份」的可达性评估。campaign.capacityGoal 是单一真源，
 * startedAt 随 campaign 持久化，Service Worker 重启 / 暂停都不会重置倒计时。
 */
function readCapacityEvaluation(
  campaign: Campaign,
  policy: RestPolicy,
  restEnabled: boolean,
): CapacityEvaluation | null {
  const stored = campaign.capacityGoal
  if (!stored?.enabled) return null
  const progress = summarizeQuotaProgress(campaign)
  const interval = campaign.intervalConfig || DEFAULT_INTERVAL_CONFIG
  const baseIntervalMs = ((interval.minSeconds + interval.maxSeconds) / 2) * 1000
  const now = Date.now()
  const deadlineMs = Math.max(0, stored.startedAt + stored.hours * 60 * 60_000 - now)
  // 只算真正落在工作时段内的分钟；否则 21:00 后设的「2 小时目标」会被误判成进度正常
  const usableMinutes = countUsableMinutesUntil(campaign.windows, new Date(now), deadlineMs)
  return evaluateCapacityGoal({
    goal: stored,
    now,
    startedAt: stored.startedAt,
    applied: progress.applied,
    totalQuota: progress.quota,
    baseIntervalMs,
    policy,
    restEnabled,
    usableMinutes,
    mustAchieve: isMustAchieve(stored),
  })
}

// ─────────── 必达模式：自动接管所有可控参数 ───────────
/** 「全平台日限耗尽」冷却时间戳必须持久化，SW 重启后不能立刻狂点被限流的平台 */
const MUST_ACHIEVE_EXHAUSTED_KEY = 'aibot_must_achieve_exhausted_at'
/** 最近一次流水线挂起时间：看门狗据此区分「刚手动暂停」与「已卡死很久」 */
const MUST_ACHIEVE_PAUSED_AT_KEY = 'aibot_must_achieve_paused_at'
/** 各类提示节流（只是提示，重启后重打一条无副作用） */
let lastMustAchieveWindowNoteAt = 0
let lastMustAchieveBlockNoteAt = 0
let capacityOverrunNotifiedFor = ''
/** 采集条件自动放宽只播报一次，避免每 30 秒刷同一条日志 */
let mustAchieveRelaxAnnounced = false
/** 看门狗与 tick 可能同时被唤醒，用一个内存锁避免重复复活 */
let ensuringAlive = false

async function readPausedAt(): Promise<number> {
  try {
    const res = await chrome.storage.local.get(MUST_ACHIEVE_PAUSED_AT_KEY)
    const value = Number(res?.[MUST_ACHIEVE_PAUSED_AT_KEY] ?? 0)
    return Number.isFinite(value) ? value : 0
  } catch {
    return 0
  }
}

async function markPausedAt(at: number): Promise<void> {
  try {
    await chrome.storage.local.set({ [MUST_ACHIEVE_PAUSED_AT_KEY]: at })
  } catch {
    // 写不进去时按「历史脏数据」处理：看门狗会立即复活，不会把目标卡死
  }
}

async function clearPausedAt(): Promise<void> {
  try {
    await chrome.storage.local.remove(MUST_ACHIEVE_PAUSED_AT_KEY)
  } catch {
    // 同上，无副作用
  }
}

async function readExhaustedResetAt(): Promise<number> {
  try {
    const res = await chrome.storage.local.get(MUST_ACHIEVE_EXHAUSTED_KEY)
    const value = Number(res?.[MUST_ACHIEVE_EXHAUSTED_KEY] ?? 0)
    return Number.isFinite(value) ? value : 0
  } catch {
    return 0
  }
}

async function markExhaustedResetAt(at: number): Promise<void> {
  try {
    await chrome.storage.local.set({ [MUST_ACHIEVE_EXHAUSTED_KEY]: at })
  } catch {
    // 写不进去最多多等一轮，不影响业务
  }
}

/**
 * 设定 / 启动目标时，把「系统自己能改的参数」一次性接管到位：
 * 切海投、抬配额、开全平台、解除日限标记。全部走各自存储函数，
 * 不直接改传入的 campaign 内存副本，避免被 appendCampaignLog 的旧副本写回覆盖。
 */
async function applyMustAchieveTakeover(
  campaign: Campaign,
  goal: CapacityGoal,
  source: 'start' | 'goal' | 'blocked' | 'watchdog',
  opts: { allowRevive?: boolean } = {},
): Promise<void> {
  if (!isMustAchieve(goal)) return

  const strategy = await getDeliveryStrategy()
  if (strategy !== 'volume') {
    await applyDeliveryStrategy('volume')
    await appendCampaignLog(
      `🎯 必达模式：已自动切换为【海投】（原策略：${strategy === 'precision' ? '精投' : '未选择'}）。${describeMustAchieveTakeover()}`,
      'warn',
    )
    sendNotification('目标必达 · 已自动切海投', describeMustAchieveTakeover())
  }

  const plan = planMustAchieveQuotas(campaign.quotas, goal.targetJobs, {
    allowRevive: opts.allowRevive,
  })
  if (Object.keys(plan.quotas).length > 0) {
    await savePlatformQuotas(plan.quotas)
    await updateCampaignQuotas(plan.quotas)
  }
  for (const pid of plan.enablePlatforms) {
    await togglePlatformEnabled(pid, true)
  }
  // 配额没变但被标 exhausted 的平台，updateCampaignQuotas 会跳过，这里单独解除
  const quotaOnly = plan.revivePlatforms.filter((pid) => !(pid in plan.quotas))
  if (quotaOnly.length > 0) await clearPlatformExhausted(quotaOnly)

  if (plan.changed) {
    await appendCampaignLog(
      `🎯 必达模式自动接管（${source}）：${plan.reasons.join('；')}；当前目标 ${goal.targetJobs} 份`,
      'info',
    )
  }
  // 清掉遗留的休息状态，必达模式全程不休息
  if (campaign.restUntil) {
    await persistRestState({ restUntil: null, consecutiveRestCounter: 0 })
  }
}

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
 * 目标必达的独立周期看门狗 alarm。
 *
 * `apply-tick` 是一次性 alarm：tick 只要早退一次（最常见是 campaign 被写成
 * paused / done），就再也没人重建它，整条流水线永久静默。
 * 这个周期 alarm 与 tick 完全解耦，浏览器会持久化，即使 SW 被回收也会每分钟
 * 把 Service Worker 唤醒一次来校验目标状态。
 */
export async function ensureWatchdogAlarm(): Promise<void> {
  try {
    const existing = await chrome.alarms.get(MUST_ACHIEVE_WATCHDOG_ALARM)
    if (existing) return
    chrome.alarms.create(MUST_ACHIEVE_WATCHDOG_ALARM, {
      delayInMinutes: MUST_ACHIEVE_WATCHDOG_PERIOD_MINUTES,
      periodInMinutes: MUST_ACHIEVE_WATCHDOG_PERIOD_MINUTES,
    })
  } catch (e) {
    logWarn(MOD, 'ensureWatchdogAlarm', e)
  }
}

/**
 * 目标必达看门狗：只要平台确认投递数没到目标，就把流水线拉回 running。
 *
 * 返回 true 表示本轮已复活，调用方应重新读一份 campaign 再继续，
 * 这样复活的这一轮就能立刻领任务投递，不白白浪费一个调度周期。
 * 进度一律来自平台确认投递数（quotas.applied），绝不因为「恢复运行」虚报成功。
 */
export async function ensureMustAchieveAlive(known?: Campaign | null): Promise<boolean> {
  if (ensuringAlive) return false
  ensuringAlive = true
  try {
    await ensureWatchdogAlarm()
    const campaign = known !== undefined ? known : await getCampaign()
    if (!campaign) return false

    const goal = campaign.capacityGoal
    const progress = summarizeQuotaProgress(campaign)
    const decision = decideMustAchieveWatchdog({
      status: campaign.status,
      pausedReason: campaign.pausedReason,
      pausedAt: await readPausedAt(),
      mustAchieve: isMustAchieve(goal),
      achieved: !!goal?.enabled && isGoalAchieved(goal, progress.applied),
      applied: progress.applied,
      targetJobs: goal?.targetJobs ?? 0,
      now: Date.now(),
    })

    if (decision.kind === 'resume') {
      await resumeAgentCampaign()
      await clearPausedAt()
      // 挂起期间遗留的休息态、无效词锁、日限标记都是系统自设的出口，
      // 不清掉的话复活后第一轮又会立刻停下来。
      await persistRestState({ restUntil: null, consecutiveRestCounter: 0 })
      await clearInvalidKeywords()
      const live = await getCampaign()
      if (live && goal) {
        await applyMustAchieveTakeover(live, goal, 'watchdog')
        const blocked = (Object.keys(live.quotas) as PlatformId[]).filter(
          (p) => live.quotas[p]?.exhausted,
        )
        if (blocked.length > 0) await clearPlatformExhausted(blocked)
      }
      await appendCampaignLog(
        `🔁 目标必达看门狗：${decision.reason}。已自动恢复运行、解除休息/无效词/日限标记并重新接管配额，本轮立即继续投递；只认平台确认投递数`,
        'warn',
      )
      scheduleNextTick(1_000)
      return true
    }

    if (decision.kind === 'idle' && campaign.status === 'running') {
      // running 但调度链断了（SW 被回收 / alarm 被清）：补挂一次 tick
      const tickAlarm = await chrome.alarms.get(ALARM_APPLY_TICK).catch(() => undefined)
      if (!tickAlarm && !scheduledTimer) scheduleNextTick(3_000)
    }
    return false
  } catch (e) {
    logWarn(MOD, 'ensureMustAchieveAlive', e)
    return false
  } finally {
    ensuringAlive = false
  }
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
    // 必达目标未达成时，即使 campaign 被写成 paused / done 也要先复活；
    // 旧版这里一见 status !== 'running' 就 return，冷启动后调度永久消失。
    await ensureWatchdogAlarm()
    const revived = await ensureMustAchieveAlive()
    if (revived) return
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
    let campaign = await getCampaign()
    if (!campaign) return

    // 0. 目标必达看门狗：调度链断了 / 状态被挂起，都先在这里自愈。
    // 旧版此处 `status !== 'running' ⇒ return`，而 apply-tick 是一次性 alarm，
    // 一次早退就再也不会有下一轮 tick —— 必达模式「未达成不停机」全成死代码。
    const revived = await ensureMustAchieveAlive(campaign)
    if (revived) campaign = await getCampaign()
    if (!campaign || campaign.status !== 'running') return

    // 0.1 清理历史脏任务：修复前 51job 把公司页链接当成岗位链接入队，
    // 这些任务永远定位不到卡片，还会触发「连续未定位 → 清空待投缓存」把新岗位一起清掉。
    // 幂等：清完后队列里不再有脏任务，后续 tick 只是一次无写盘的读取。
    const purged = await purgeStaleJobUrlTasks()
    if (purged > 0) {
      campaign = await getCampaign()
      if (!campaign || campaign.status !== 'running') return
      await appendCampaignLog(
        `🧹 已清理 ${purged} 条旧版 51job 公司页脏任务（jobUrl 是公司页而非岗位详情），这些任务从未投递成功，清掉后同名岗位可重新采集入队`,
        'warn',
      )
    }

    const goalNow = campaign.capacityGoal
    const progressNow = summarizeQuotaProgress(campaign)
    /** 目标已启用、必达、且平台确认投递数还没到目标 */
    const mustAchieveActive = isMustAchieve(goalNow) && !isGoalAchieved(goalNow!, progressNow.applied)
    const goalAchieved = !!goalNow?.enabled && isGoalAchieved(goalNow, progressNow.applied)
    const bypassWindow = shouldBypassWorkWindow(mustAchieveActive, goalAchieved)

    // 0. 必达目标达成：这是唯一允许「目标模式」主动停机的出口，明确留痕 + 通知
    if (goalAchieved && isMustAchieve(goalNow)) {
      await pauseAgentCampaign('user')
      // pauseAgentCampaign 会把状态写成 paused；必须重新读一份再落 done，
      // 否则只改内存副本会被 storage 里的旧值整份覆盖，面板会显示「已暂停」。
      const finished = await getCampaign()
      if (finished) {
        finished.status = 'done'
        finished.pausedReason = undefined
        await saveCampaign(finished)
      }
      await releaseRunMode('autopilot')
      await appendCampaignLog(
        `🏆 目标必达：平台已确认投递 ${progressNow.applied}/${goalNow!.targetJobs} 份，达成后自动停机。注意核对平台聊天列表里的实际沟通记录`,
        'success',
      )
      sendNotification('🏆 目标已达成', `平台已确认投递 ${progressNow.applied}/${goalNow!.targetJobs} 份，AIbot 已停机`)
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
    // 必达模式下工作时段是「系统自己能改的参数」，不能拿它当停机理有：
    // 设定目标即视为授权临时放行，直到平台确认投递数达标。用户设置本身不被改写。
    if (bypassWindow && !isWithinWindow(campaign.windows)) {
      if (Date.now() - lastMustAchieveWindowNoteAt > 30 * 60_000) {
        lastMustAchieveWindowNoteAt = Date.now()
        await appendCampaignLog(
          `🎯 必达模式：当前不在投递时段（${formatTimeWindows(campaign.windows)}），已自动临时放行，不休眠；今日已确认投递 ${progressNow.applied}/${goalNow!.targetJobs}，未达成前持续投递`,
          'info',
        )
      }
    } else if (!isWithinWindow(campaign.windows)) {
      const waitMs = getDelayUntilNextWindow(campaign.windows)
      const waitMins = Math.max(1, Math.round(waitMs / 60_000))
      log(MOD, 'runCampaignTick', `Outside window. Sleeping for ${waitMins} minutes`)
      // 分片轮询会频繁命中这里，日志每 30 分钟最多提示一次；标记持久化，SW 重启也不刷屏
      if (Date.now() - (await readWindowSleepLogAt()) > 30 * 60_000) {
        await markWindowSleepLogAt(Date.now())
        const sleepProgress = summarizeQuotaProgress(campaign)
        const goal = campaign.capacityGoal
        let goalNote = ''
        if (goal?.enabled) {
          const goalDeadlineMs = Math.max(0, goal.startedAt + goal.hours * 60 * 60_000 - now)
          const usable = countUsableMinutesUntil(campaign.windows, new Date(now), goalDeadlineMs)
          goalNote = usable <= 0
            ? ` ⚠️ 目标产能【${goal.hours} 小时投满 ${goal.targetJobs} 份】与工作时段完全冲突：目标剩余 ${Math.ceil(goalDeadlineMs / 60_000)} 分钟内 0 分钟可投，而 AIbot 要休眠约 ${waitMins} 分钟，目标无法按时达成。请立即把【工作时段】设为「24小时不限」`
            : ` 目标产能剩余 ${Math.ceil(goalDeadlineMs / 60_000)} 分钟，其中仅 ${usable} 分钟落在允许时段；不想中断就把【工作时段】设为「24小时不限」`
        }
        await appendCampaignLog(
          `🌙 当前不在投递时段内 (允许时段: ${formatTimeWindows(campaign.windows)})，AIbot 进入静默休眠；今日已确认投递 ${sleepProgress.applied}/${sleepProgress.quota}，还差 ${sleepProgress.remaining} 份。目标产能按墙钟计时，休眠期间倒计时不会暂停。要立刻继续，请在首屏目标产能卡片点【解除时段限制并继续】，或点底部【工作时段】→ 选【24小时不限】→ 点【保存时段】。${goalNote}`,
          goalNote.includes('完全冲突') ? 'warn' : 'info',
        )
      }
      // 切片等待：到点后最多 5 分钟内自动醒来，不再依赖单个长延时 alarm
      scheduleNextTick(waitMs)
      return
    }

    // 已进入允许时段：清掉持久化的休眠日志标记，下次真正休眠时能立刻再提示一次。
    // 不清的话，30 分钟内「休眠→唤醒→再休眠」会被去重吞掉第二条提示。
    if ((await readWindowSleepLogAt()) !== 0) await markWindowSleepLogAt(0)

    // 3. 模拟真人作息休息（状态机 + 原子落盘）
    //
    // 旧版只改内存里的 campaign 就 appendCampaignLog()，日志会从 storage 读旧副本
    // 整份写回，restUntil 从未落盘、连投计数从未清零 —— 每个 5 分钟切片 tick
    // 都重新触发一次休息，AIbot 永远卡在「休息中」，一天都投不满配额。
    // 现在所有状态变化都走 persistRestState() 串行链，且阈值一次生成后固定。
    const strategy = await getDeliveryStrategy()
    const restPolicy = resolveRestPolicy(strategy)
    const userRestEnabled = (await getSetting<boolean>(REST_ENABLED_KEY, DEFAULT_REST_ENABLED)) === true
    const capacity = readCapacityEvaluation(campaign, restPolicy, userRestEnabled)
    /**
     * 「产能优先」是整条流水线的统一开关：补仓不降频、跳过历史去重冷却、
     * 执行层放宽匹配分门槛。必达模式下**全程**开启，不再等状态变成 at-risk。
     */
    const capacityUrgent = mustAchieveActive || isCapacityUrgent(capacity?.status)
    // 必达模式全程不休息；常规模式在进度落后时自动跳过休息
    const restEnabled =
      userRestEnabled && !mustAchieveActive && !capacity?.shouldSkipRest
    const restDecision = decideRest({
      now,
      restUntil: campaign.restUntil,
      consecutiveRestCounter: campaign.consecutiveRestCounter || 0,
      restThreshold: campaign.restThreshold,
      lastRestNoticeAt,
      policy: restPolicy,
      enabled: restEnabled,
    })
    const progress = summarizeQuotaProgress(campaign)

    // 必达模式没有「超时」：设定时限只是进度参考，报一次进度事实后继续投递。
    // 不用 warn 级别、不叫预警，避免用户误以为目标失败或系统要放弃。
    if (
      mustAchieveActive && capacity && capacity.remainingMs <= 0 &&
      capacityOverrunNotifiedFor !== campaign.id
    ) {
      capacityOverrunNotifiedFor = campaign.id
      await appendCampaignLog(
        `🎯 目标必达进行中：当前平台已确认投递 ${progressNow.applied}/${goalNow!.targetJobs}，还差 ${Math.max(0, goalNow!.targetJobs - progressNow.applied)} 份；必达模式继续投递，不设到点放弃，未达成不停机`,
        'info',
      )
      sendNotification(
        '目标必达 · 继续投递',
        `目标仍在进行中，继续投到 ${goalNow!.targetJobs} 份为止（当前 ${progressNow.applied} 份）`,
      )
    }

    // 目标产能：到点未达成一次性诊断；赶不上时每 10 分钟给一次可操作建议
    if (capacity?.status === 'missed' && capacityMissedNotifiedFor !== campaign.id) {
      capacityMissedNotifiedFor = campaign.id
      await appendCampaignLog(`⚠️ 目标产能未达成：${capacity.advice}`, 'warn')
      sendNotification('目标产能未达成', capacity.advice, 2)
    } else if (
      capacityUrgent && Date.now() - lastCapacityNoticeAt > 10 * 60_000
    ) {
      lastCapacityNoticeAt = Date.now()
      // 必达模式全程 capacityUrgent，这是常态进度播报而不是预警；
      // 只有显式关掉必达后的「赶不上」才是真正的 warning。
      const isMustAchieveProgress = isMustAchieve(campaign.capacityGoal)
      await appendCampaignLog(
        isMustAchieveProgress
          ? `🎯 目标进度：${describeCapacityStatus(capacity!, campaign.capacityGoal!)}。${capacity!.advice}；产能优先全程开启（锁定高频补仓、回收历史跳过岗位、匹配分只排序不否决）`
          : `🎯 目标产能预警：${describeCapacityStatus(capacity!, campaign.capacityGoal!)}。${capacity!.advice}；已启用产能优先（锁定高频补仓、回收历史跳过岗位、放宽匹配分门槛）`,
        isMustAchieveProgress ? 'info' : 'warn',
      )
    }

    if (restDecision.kind === 'resume') {
      // 休息到期 / 用户关掉休息：清状态，并且本轮立刻继续投递，不再空跑一整轮
      await persistRestState({
        restUntil: null,
        consecutiveRestCounter: 0,
        restThreshold: pickInitialRestThreshold(restPolicy),
      })
      await appendCampaignLog(
        `☕ 休息结束，立即恢复投递（今日已确认投递 ${progress.applied}/${progress.quota}，还差 ${progress.remaining} 份）`,
        'success',
      )
      lastRestNoticeAt = 0
      // 刻意不 return：继续往下领任务，把刚浪费的这一轮补回来
    } else if (restDecision.kind === 'waiting') {
      const restMins = Math.max(1, Math.round(restDecision.remainingMs / 60_000))
      if (restDecision.shouldLog) {
        lastRestNoticeAt = now
        await appendCampaignLog(
          `☕ 模拟真人休息中（${restPolicy.label}节奏），还剩约 ${restMins} 分钟；今日已确认投递 ${progress.applied}/${progress.quota}`,
          'info',
        )
      }
      log(MOD, 'runCampaignTick', `Taking human-like rest. Remaining: ${restMins} min`)
      scheduleNextTick(Math.min(restDecision.remainingMs, MAX_SLEEP_CHUNK_MS))
      return
    } else if (restDecision.kind === 'start-rest') {
      const restMins = Math.round(restDecision.durationMs / 60_000)
      await persistRestState({
        restUntil: now + restDecision.durationMs,
        consecutiveRestCounter: 0,
        restThreshold: restDecision.nextThreshold,
      })
      log(MOD, 'runCampaignTick', `Reached threshold ${restDecision.threshold}. Resting for ${restMins} min`)
      await appendCampaignLog(
        `☕ 已连投 ${restDecision.threshold} 份（${restPolicy.label}节奏），休息 ${restMins} 分钟防止风控；今日已确认投递 ${progress.applied}/${progress.quota}，还差 ${progress.remaining} 份`,
        'info',
      )
      sendNotification(
        '☕ AIbot 休息中',
        `已连投 ${restDecision.threshold} 份，休息 ${restMins} 分钟后继续（今日 ${progress.applied}/${progress.quota}）。`,
      )
      lastRestNoticeAt = now
      scheduleNextTick(restDecision.durationMs)
      return
    } else if (restDecision.restThreshold !== undefined) {
      // 旧 campaign 没有持久化阈值：补写一次，之后每轮共用，不再每 tick 重随机。
      // 同时把历史累积的连投计数归零 —— 死锁期间它可能已经涨到几十，
      // 不归零的话升级后第一次 tick 会立刻又触发一次十几分钟的休息。
      await persistRestState({
        restThreshold: restDecision.restThreshold,
        consecutiveRestCounter: 0,
      })
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

      if (activePlatforms.length === 0 && mustAchieveActive) {
        /**
         * 必达模式绝不因为「配额打满 / 平台被标日限」就宣告完成：
         * 这些都是插件自己能改的参数，改完继续投，直到目标达成。
         * 只有全平台真的被平台侧日限挡死时，才按冷却节奏重试，而不是退出。
         */
        const enabledIds = (Object.keys(campaign.quotas) as PlatformId[]).filter(
          (p) => campaign.quotas[p].enabled !== false,
        )
        const exhaustedPlatforms = enabledIds.filter((p) => campaign.quotas[p].exhausted)
        const lastReset = await readExhaustedResetAt()
        const sinceReset = Date.now() - lastReset

        /**
         * 旧版在「所有平台都被标 exhausted」时直接 return 等 10 分钟冷却，
         * 这 10 分钟里既不采集也不投递 —— 进度就停在这里，用户看到的就是
         * 「16/80 一直不动」。exhausted 是插件自己写的标记，属于可控参数，
         * 必达模式不能拿它当停机理有：每轮都接管、每轮都解除、每轮都重试。
         * 冷却只用来控制日志频率，不再阻塞调度。
         */
        await applyMustAchieveTakeover(campaign, goalNow!, 'blocked', { allowRevive: true })
        if (exhaustedPlatforms.length > 0) {
          await clearPlatformExhausted(exhaustedPlatforms)
          if (sinceReset >= MUST_ACHIEVE_EXHAUSTED_COOLDOWN_MS) {
            await markExhaustedResetAt(Date.now())
          }
        }
        if (Date.now() - lastMustAchieveBlockNoteAt > 10 * 60_000) {
          lastMustAchieveBlockNoteAt = Date.now()
          await appendCampaignLog(
            `🔁 必达模式：配额/日限标记已自动接管并解除，已确认投递 ${progressNow.applied}/${goalNow!.targetJobs}，未达成前持续换平台/翻页补仓，不空等冷却。建议同时确认各平台登录态`,
            'info',
          )
        }
        scheduleNextTick(MUST_ACHIEVE_EXHAUSTED_RETRY_MS)
        return
      }

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
      const hasAdded = await autoCollectJobsForCampaign(campaign, activePlatforms, {
        capacityUrgent,
        mustAchieve: mustAchieveActive,
        managePageCursor: true,
      })
      if (hasAdded) {
        emptyDiscoveryStreak = 0
        scheduleNextTick(1000) // 抓取入队成功，1 秒后立即执行新入队任务！
      } else {
        emptyDiscoveryStreak++
        // 目标产能未达成时绝不降频：队列空 + 进度落后还把巡检拉到 5 分钟一轮，
        // 等于主动放弃目标。旧版这里完全没接管目标产能，是「设了目标却没实现」的直接原因之一。
        const nextMs = capacityUrgent
          ? 30_000
          : emptyDiscoveryStreak <= 2 ? 30_000
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
          if (capacityUrgent) {
            tips.push('目标产能未达成，已锁定每 30 秒高频巡检补仓（不再降频到 5 分钟）')
          }
          // 「投了一天还没投满」时，必须让用户看到数字卡在哪一层，而不是只看到一句空转提示
          const progress = summarizeQuotaProgress(campaign)
          const failedAttempts = campaign.tasks.filter((t) => t.status === 'failed').length
          tips.push(
            `今日已确认投递 ${progress.applied}/${progress.quota}，还差 ${progress.remaining} 份；未计入配额的失败尝试 ${failedAttempts} 次`,
          )
          if (failedAttempts > 0) {
            tips.push('若日志出现「未记为投递成功」，先到平台聊天列表核对，再检查登录态 / 风控')
          }

          const cadence = capacityUrgent
            ? '目标产能未达成，保持每 30 秒高频巡检补仓'
            : `自动降频为每 ${Math.max(1, Math.round(nextMs / 60_000))} 分钟巡检一次（一有新岗位立即恢复高频）`
          await appendCampaignLog(
            `💤 已连续 ${emptyDiscoveryStreak} 轮没有发现新岗位，${cadence}。诊断建议：${tips.join('；')}`,
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
    // 执行前必须回到该任务被采集时的「关键词 + 页码」列表页。
    // 旧版只传 platform：步骤 8 的异步补仓会把同一个后台 tab 导航到别的关键词/页，
    // 下一个任务就落在错误的列表页上，执行器报「未找到对应岗位卡片」→ failed，
    // 于是投了很多轮进度却不涨。URL 已一致时 ensurePlatformTab 不会重复导航。
    const taskKeyword = (task.searchKeyword || '').trim()
    const taskPage = taskKeyword ? (task.searchPage || 1) : 1
    await appendCampaignLog(`🌐 正在连接 ${task.platform} 平台标签页...`, 'info')
    const tab = await ensurePlatformTab(task.platform, taskKeyword || undefined, taskPage, {
      // 51job 点岗位链接会整页跳到详情页；上一个任务结束后后台 tab 可能停在那里，
      // 必须导航回列表页再下发任务，否则 0 张卡片、必然报「未找到对应岗位卡片」。
      requireListPage: true,
    })
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
          // 产能优先 / 必达必须随任务一起下发到页面执行层，
          // 否则评分门槛还是会把已过硬筛的对口岗位全跳过
          payload: { task, capacityUrgent, mustAchieve: mustAchieveActive },
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
        autoCollectJobsForCampaign(campaign, activePlatforms, {
          capacityUrgent,
          mustAchieve: mustAchieveActive,
        }).catch(() => {})
      }
    }

    // 9. 计算拟人随机延迟；设了目标产能且进度偏紧时自动压缩（不低于防风控下限）
    const rawInterval = getRandomInterval(task.platform, undefined, campaign.intervalConfig)
    const nextInterval = capacity ? resolvePacingInterval(rawInterval, capacity) : rawInterval
    const paced = nextInterval < rawInterval
    const nextSeconds = Math.round(nextInterval / 1000)
    log(MOD, 'runCampaignTick', `Task executed. Next tick in ${nextSeconds}s`)
    const capacityNote = !capacity
      ? ''
      : paced
        ? `（目标产能 ${capacity.targetJobs} 份 / ${campaign.capacityGoal?.hours} 小时：已从 ${Math.round(rawInterval / 1000)} 秒压缩到 ${nextSeconds} 秒，最低不低于 8 秒）`
        : `（目标产能 ${capacity.progressPercent}%，还差 ${capacity.remainingJobs} 份；当前 ${nextSeconds} 秒/份已在目标允许节奏内，无需再压缩。真正卡住产出的是岗位供给与投递门槛，不是间隔）`
    await appendCampaignLog(
      `⏳ 触发拟人安全间隔，随机等待 ${nextSeconds} 秒后处理下一个岗位...${capacityNote}`,
      'info',
    )
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

interface CollectJobsOptions {
  /** 目标产能落后：跳过历史回收冷却、锁定高频补仓、放宽匹配分门槛 */
  capacityUrgent?: boolean
  /** 必达模式：放宽活跃时间 / 语义闸门 / 采集上限，且关键词无效时不停机 */
  mustAchieve?: boolean
  /** 只有「队列空」的主补仓路径可以推进页码；步骤 8 的机会性预取不该抢游标 */
  managePageCursor?: boolean
}

/** 自动为队列中无可用任务的平台巡检并抓取新岗位 */
async function autoCollectJobsForCampaign(
  campaign: Campaign,
  activePlatforms: PlatformId[],
  opts: CollectJobsOptions = {},
): Promise<boolean> {
  // 产能落后时不等 30 分钟冷却，立刻把「因门槛被跳过」的同栈岗位拿回来重评；
  // 常规节奏仍保留冷却，避免在少量候选里反复打转。
  const retryCooldownMs = opts.capacityUrgent ? 0 : TASK_RETRY_COOLDOWN_MS
  // 只把「真占位」的任务传给 content 做采集去重。
  // 过冷却期的 skipped 记录会在 appendTasksToCampaign 里回收，
  // 若这里仍把它们当已存在排除，页面侧就根本不会把岗位交回来，回收形同虚设。
  const nowForDedupe = Date.now()
  const blockingTasks = campaign.tasks.filter(
    (t) => !isRecyclableTask(t, nowForDedupe, retryCooldownMs),
  )
  const existingJobIds = Array.from(new Set([
    ...blockingTasks.map((t) => t.id),
    ...blockingTasks.filter((t) => t.jobId).map((t) => t.jobId),
    ...blockingTasks.filter((t) => t.company && t.jobTitle).map((t) => `${t.company.trim()}:${t.jobTitle.trim()}`),
    ...blockingTasks.filter((t) => t.company && t.jobTitle).map((t) => `${t.platform}:${t.company.trim()}:${t.jobTitle.trim()}`),
  ]))

  // 1. 获取默认简历与用户筛选偏好（与概览共用同一份配置，不再硬编码评分开关/最低分）
  const defaultResume = await getDefaultResume()
  const userFilters: ApplyFilters = await loadSharedApplyFilters()
  const mustAchieve = opts.mustAchieve === true
  /**
   * 必达模式只放宽「下发给采集层的副本」，用户设置本身不改写：
   * 活跃时间、语义闸门、采集上限都是系统自己能改的参数，不能拿它们当投不满的理由。
   */
  const relaxedFilters = relaxFiltersForMustAchieve(userFilters, mustAchieve)
  const filters = relaxedFilters.filters
  if (mustAchieve && relaxedFilters.relaxed.length > 0 && !mustAchieveRelaxAnnounced) {
    mustAchieveRelaxAnnounced = true
    await appendCampaignLog(
      `🎯 必达模式自动放宽采集条件：${relaxedFilters.relaxed.join('；')}（仅本轮生效，你的筛选设置保持不变；技术栈 / 方向 / 黑名单硬约束仍保留）`,
      'info',
    )
  }

  // 2. 依据简历与筛选偏好提取意向职业清单与轮转关键词 (Feature D)
  //    常规模式跳过「24 小时内被判定搜不到相关岗位」的关键词；
  //    必达模式忽略这份标记，否则当天所有词会被自己一次性锁死。
  const invalidKeywords = await loadInvalidKeywords()
  let keywordInfo = await getNextSearchKeyword(
    defaultResume,
    undefined,
    filters,
    shouldMarkKeywordInvalid(mustAchieve) ? Object.keys(invalidKeywords) : [],
  )
  if (keywordInfo.exhausted) {
    if (keywordInfo.reason === 'no_keywords') {
      if (mustAchieve) {
        /**
         * 旧版在必达模式下也走这条分支：打一条 error + 通知就 return false，
         * 主循环继续每 30 秒巡检却永远不采集，进度就静止了。
         * 必达模式改从平台推荐流继续找岗位（技术栈 / 方向 / 黑名单硬约束仍生效，
         * 不凭空猜「前端」这类通用词）；用户补填岗位名称后下一轮自动切回精准搜索。
         */
        keywordInfo = {
          ...keywordInfo,
          exhausted: false,
          keyword: '',
          index: 0,
          total: 1,
          reason: 'ok',
        }
        await appendCampaignLog(
          '⚠️ 必达模式没读到搜索词：本轮改从平台推荐流补仓（技术栈硬约束仍生效，不会乱投跨栈岗位）。建议到「设置 → 岗位名称」补充职位名，例如「php开发, 后端开发, AI 全栈开发」，下一轮自动切回精准搜索',
          'warn',
        )
      } else {
        // 一个可信关键词都没有时，绝不替用户猜「前端 / 全栈」之类的通用词去乱搜。
        // 保持 running，让用户填完期望职位后下一轮自动恢复，比直接暂停更不容易让人以为坏了。
        await appendCampaignLog(
          '⛔ 没有可用的搜索词：没在「期望职位」里读到职位名，简历技能 / 项目技术栈里也没解析出 PHP、AI 开发、全栈这类词。请到「设置 → 岗位名称」填写，例如「php 后台开发, AI 全栈开发」（用逗号或顿号分隔）。本轮不采集推荐流岗位，填好后下一轮自动恢复',
          'error',
        )
        sendNotification(
          '需要填写期望职位',
          '没读到可用的搜索关键词，本轮不采集岗位。请到设置里填写岗位名称，例如「php 后台开发」。',
          2,
        )
      }
    } else if (shouldKeepCollectingOnNoSource(mustAchieve)) {
      // 必达模式：关键词全被标无效属于「系统自己加的锁」，解锁后继续巡检，绝不暂停活动。
      await clearInvalidKeywords()
      await appendCampaignLog(
        `🔁 必达模式：${keywordInfo.allKeywords.length} 个关键词曾被标记为无效，已解除标记并重新启用全部搜索词；目标未达成前不停机，继续换词 / 翻页 / 换平台补仓。若仍零命中，请核对各平台登录态`,
        'warn',
      )
    } else {
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
    }
    // 必达模式 no_keywords 已在上面降级为「推荐流继续采」，不能在这里 return
    if (keywordInfo.exhausted) return false
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

  // 连续多轮被“职业方向”过滤到零新增时自动放宽，改由 AI 匹配分把关，避免永远补不到货。
  // 必达模式直接全程放宽同义匹配严格度（方向白名单与技术栈硬约束仍保留，不清空）。
  const relaxCareerFilter = mustAchieve || careerFilterMissStreak >= CAREER_RELAX_THRESHOLD
  if (!mustAchieve && relaxCareerFilter && !careerRelaxAnnounced) {
    careerRelaxAnnounced = true
    await appendCampaignLog(
      `🔓 已连续 ${careerFilterMissStreak} 轮因职业方向过滤导致零新增，本轮起放宽同义匹配严格度（方向白名单仍保留，明确跨技术栈岗位继续硬拦），先保证有岗位可投。建议同步检查「期望职位」是否填成了长句`,
      'warn',
    )
  }

  // 必达模式放大每轮候选池：目标 80 份时，每平台每轮只抓 35 个很容易供给不足
  const collectMaxJobs = resolveCollectMaxJobs(35, mustAchieve)

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
        const foreground = await isForegroundMode()
        const opened = await openPlatformLoginTab(platform)
        const where = foreground ? '已自动为你打开登录页' : '已在后台标签页打开登录页（不会切走你当前的页面）'
        await appendCampaignLog(
          opened
            ? `🔐 【${pName}】登录已失效，${where}。完成登录后该平台会自动恢复投递（在此之前每 10 分钟复查一次，不再反复提醒）`
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

    const keywordSourceLabel = (filters.jobTitles || '').trim()
      ? '设置里的「岗位名称」'
      : '简历职位 / 技能 / 项目技术栈'
    log(MOD, 'autoCollect', `Connecting to ${platform} for autonomous job collection targeting: ${primaryCareerKeyword} (page ${currentPage})...`)
    await appendCampaignLog(
      `🔍 本轮搜索词【${primaryCareerKeyword}】(${keywordInfo.index + 1}/${keywordInfo.total}，来源：${keywordSourceLabel})，目标方向【${careerLabel}】，正在连接【${pName}】精准补仓（第 ${currentPage} 页）...`,
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
            maxJobs: collectMaxJobs,
            existingJobIds,
            targetCareers,
            relaxCareerFilter,
            mustAchieve,
            keyword: primaryCareerKeyword,
            page: currentPage,
            filters,
            retryCooldownMs,
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
              maxJobs: collectMaxJobs,
              existingJobIds,
              targetCareers,
              relaxCareerFilter: true,
              mustAchieve,
              keyword: primaryCareerKeyword,
              page: currentPage,
              filters,
              retryCooldownMs,
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
        // 本地语义闸门（精投）同样会剔除岗位，没配 AI Key 的用户也必须看得到原因
        const gateActive = collectRes.relevanceSource === 'ai' || dropped > 0
        if (gateActive && (diverged || effectiveRelevantHits === 0 || dropped > 0)) {
          const reason = (collectRes.relevanceReason || '').slice(0, 120)
          const sourceLabel = collectRes.relevanceSource === 'ai' ? 'AI 语义复核' : '本地语义复核'
          await appendCampaignLog(
            `🧠 【${pName}】${sourceLabel}【${primaryCareerKeyword}】：本页 ${finalCollected} 个岗位里 ${effectiveRelevantHits} 个真正对口（字符串命中 ${stringHits}），已剔除 ${dropped} 个不对口岗位${reason ? `｜${reason}` : ''}`,
            effectiveRelevantHits === 0 ? 'warn' : 'info',
          )
        }
      }

      // 技术栈约束可见化：用户要能确认「PHP 方向确实把 Java / 前端挡在队列外」
      const stackNames = collectRes?.targetStackLabels || []
      const stackDropped = collectRes?.filteredByStack ?? 0
      const stackSig = `${platform}:${primaryCareerKeyword}:${stackNames.join(',')}`
      if (collectRes?.success && stackNames.length > 0 && stackSig !== lastStackNoticeSig) {
        lastStackNoticeSig = stackSig
        await appendCampaignLog(
          `🎯 【${pName}】技术栈约束【${stackNames.join(' / ')}】已生效：本页剔除 ${stackDropped} 个明确不对口岗位（如 Java / 前端），只保留同栈或通用后端岗位`,
          'info',
        )
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

        const truncatedByCap = collectRes?.truncatedByCap ?? 0
        const tasksProduced = collectRes?.tasksProduced ?? 0
        const duplicatesAtAppend = collectRes?.duplicatesAtAppend ?? 0
        const filteredOther = collectRes?.filteredOther ?? 0

        // 搜索关键词零命中：这批卡片与目标方向完全无关，通常意味着搜索页没生效
        //（被重定向到推荐流 / 未登录降级）。继续按方向过滤只会无限空转，
        // 因此把这个词标记为无效（24 小时），让下一轮自动换词，而不是原地打转。
        if (
          collected > 0 && primaryCareerKeyword && effectiveRelevantHits === 0 &&
          shouldMarkKeywordInvalid(mustAchieve)
        ) {
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
        // 诊断必须说清「到底卡在哪一层」：0 个岗位产出 = 筛选问题；
        // 有岗位产出却 added=0 = 队列去重 / 历史跳过占位问题。
        // 旧版把 maxJobs*2 的截断数当成「已投过」，日志会凭空写出「其中 5 个已投过」。
        const detail = pageCardTotal === 0
          ? '页面未解析到任何岗位卡片（搜索结果为空或页面未加载完成）'
          : `本页 ${pageCardTotal} 张卡片，去重跳过 ${excludedOnPage} 张、采集上限截断 ${truncatedByCap} 张，实际筛选 ${collected} 张；职业方向筛掉 ${byCareer} 个、活跃时间筛掉 ${byTime} 个、黑名单筛掉 ${byBlacklist} 个、其他条件筛掉 ${filteredOther} 个${relevanceNote}；通过全部筛选可入队 ${tasksProduced} 个，其中 ${duplicatesAtAppend} 个是历史已处理岗位被去重挡下`
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

        // 本页零新增 = 这一页已经挖尽，必须翻页。
        // 旧版只在「整页全是已投岗位」时翻页，现场日志 35 个对口岗位全部被
        // 历史 skipped 去重键挡住却 collected>0，于是永远停在第 1 页无限空转。
        if (opts.managePageCursor && collectRes?.success && pageCardTotal > 0) {
          const nextPage = nextSearchPage(currentPage)
          await setSearchPageCursor(pageKey, nextPage)
          // 不清 careerFilterMissStreak：连续多页都因方向白名单过窄零产出时，
          // 原有的「自动放宽方向」机制仍要能累计生效
          await appendCampaignLog(
            `📄 【${pName}】关键词【${primaryCareerKeyword}】第 ${currentPage} 页本轮 0 新增，本页挖尽；下次自动${nextPage === 1 ? '回到第 1 页并换关键词轮转' : `翻到第 ${nextPage} 页`}${retryCooldownMs === 0 ? '（产能优先：已同时解除历史跳过岗位的回收冷却）' : ''}`,
            'info',
          )
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
  const current = await getCampaign()
  const progress = current ? summarizeQuotaProgress(current) : null
  const mustAchieveActive =
    !!current?.capacityGoal &&
    isMustAchieve(current.capacityGoal) &&
    !isGoalAchieved(current.capacityGoal, progress?.applied ?? 0)

  // 1. 验证码挂起处理
  if (result.riskDetected === 'captcha') {
    logWarn(MOD, 'handleTaskExecutionResult', `Captcha detected on ${task.platform}!`)

    if (mustAchieveActive) {
      /**
       * 必达模式不整体停机：验证码是「这个平台此刻被挡住」，不是「目标可以放弃」。
       * 把该平台临时标为耗尽（后台 10 分钟冷却后自动解除重试），其他平台继续投；
       * 任务标 skipped 而不是 paused，冷却过后还能回收重投。
       */
      await updateTaskResult(task.id, {
        status: 'skipped',
        failReason: '命中验证码，本平台临时冷却，待重试',
      })
      await markPlatformExhausted(task.platform)
      await appendCampaignLog(
        `🚨 [${task.platform}] 检测到安全验证码！必达模式不整体停机：本平台已临时冷却（约 10 分钟后自动解除并重试），其它平台继续投递；当前平台已确认投递 ${progress?.applied ?? 0}/${current!.capacityGoal!.targetJobs}。请在浏览器中解除验证码。若页面上看不到验证码，多半是岗位描述/页脚字样导致的误判——直接点「继续」或重载扩展即可恢复`,
        'error',
      )
      sendNotification(
        '⚠️ 命中安全验证码 · 必达继续',
        `平台 [${task.platform}] 已临时冷却，其余平台继续投递直到达标。请在浏览器里解除验证码。`,
        2,
      )
      scheduleNextTick(30_000)
    } else {
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
    }
    sendWebhookNotification({
      title: `🚨 命中安全验证码 (${task.platform})`,
      content: mustAchieveActive
        ? `⚠️ 平台【${task.platform}】触发图形验证码，该平台已临时冷却，其余平台继续投递直到目标达成。\n\n- **当前岗位**：${task.jobTitle} (${task.company})\n- **处理方式**：请在浏览器中完成验证码滑块/点选；冷却结束后会自动重试。`
        : `⚠️ 平台【${task.platform}】触发图形验证码，AIbot 已安全挂起投递保护账号。\n\n- **当前岗位**：${task.jobTitle} (${task.company})\n- **处理方式**：请在浏览器中完成验证码滑块/点选，然后在插件面板点击“继续”。`,
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
    if (mustAchieveActive) {
      /**
       * 旧版必达模式下也走 abortAgentCampaign('blocked')：一次性把 status 写成
       * aborted，而调度只认 running —— 目标没达成却再也不会有人推进。
       * 现在只熔断「出问题的这一个平台」（账号安全仍然优先），其它平台继续投，
       * 30 秒后由必达分支自动解除标记重试，看门狗保证调度一直活着。
       */
      await markPlatformExhausted(task.platform)
      await appendCampaignLog(
        `🛑 [${task.platform}] 账号受限告警！已熔断该平台（继续猛点会加重账号处罚），其余平台继续投递直到目标达成；当前已确认投递 ${progress?.applied ?? 0}/${current!.capacityGoal!.targetJobs}。约 30 秒后自动解除标记重试。请登录官方 APP 核对账号状态`,
        'error',
      )
      sendNotification(
        '⛔ 账号受限 · 必达继续',
        `平台 [${task.platform}] 已熔断，其余平台继续投递直到目标达成；请核对账号状态。`,
        2,
      )
    } else {
      await abortAgentCampaign('blocked')
      await appendCampaignLog(
        `🛑 [${task.platform}] 账号受限告警！已紧急终止全平台投递！继续点击会加重账号处罚，因此账号安全优先；人工解除账号异常后可重新启动`,
        'error',
      )
      sendNotification('⛔ 账号受限告警', `平台 [${task.platform}] 检测到账号受限文案，已紧急停止全部投递！`, 2)
    }
    sendWebhookNotification({
      title: `⛔ 账号受限告警 (${task.platform})`,
      content: mustAchieveActive
        ? `🛑 平台【${task.platform}】检测到账号受限或违规文案，已熔断该平台，其余平台继续投递直到目标达成。请登录官方 APP 检查账号状态！`
        : `🛑 平台【${task.platform}】检测到账号受限或违规文案，AIbot 已紧急全量熔断并终止投递，请登录官方 APP 检查账号状态！`,
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
    consecutiveUnverifiedMap[task.platform] = 0
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
    const evidence = result.verification?.reason || '平台侧状态已确认'
    await appendCampaignLog(
      `✅ 投递成功：已向 [${task.platform}]「${task.company} - ${task.jobTitle}」发起沟通（${evidence}）`,
      'success',
    )
  } else if (result.status === 'skipped') {
    if (result.failReason?.includes('列表页未就绪')) {
      // 空壳页 / 投递成功遗留页：岗位本身没问题，只是页面还没渲染好。
      // 标 skipped 让任务按回收机制重试，**不**计入「连续找不到卡片」自愈，
      // 否则会误判成站点改版去 clearPendingTasks，把新采到的岗位一起清掉。
      await appendCampaignLog(
        `⏳ [${task.platform}] ${task.jobTitle} 暂缓：${result.failReason}（任务保留待重试，不清空队列）${result.diagnostics ? `｜现场：${describeRunnerDiagnostics(result.diagnostics)}` : ''}`,
        'info',
      )
      consecutiveNotFoundMap[task.platform] = 0
    } else {
      await appendCampaignLog(
        `⏭️ 智能跳过：[${task.platform}] ${task.jobTitle} (匹配分: ${result.matchScore ?? '低'}，未达到投递门槛)`,
        'info',
      )
    }
  } else if (result.status === 'failed') {
    const unverified = !!result.verification && result.verification.level !== 'confirmed'

    if (unverified) {
      // 「点了按钮但平台没确认」不能虚报成功，也不能虚报为普通失败。
      // content 侧已写诊断留痕，这里只做可见日志与连续告警。
      consecutiveUnverifiedMap[task.platform] = (consecutiveUnverifiedMap[task.platform] || 0) + 1
      await appendCampaignLog(
        `⚠️ 未记为投递成功：[${task.platform}] ${task.jobTitle} — ${result.verification!.reason}（不落盘、不去重、不计配额，请到平台聊天列表核对）`,
        'warn',
      )
      const streak = consecutiveUnverifiedMap[task.platform] || 0
      if (streak === UNVERIFIED_ALERT_THRESHOLD) {
        await appendCampaignLog(
          `⚠️ [${task.platform}] 已连续 ${streak} 个岗位「点了按钮但平台没确认」。多半是登录态失效、被风控拦截或平台改版导致按钮点错；请到平台页面人工核对一次。AIbot 会继续尝试其他岗位，但不会虚报成功`,
          'error',
        )
        sendNotification(
          '未记为投递成功',
          `[${task.platform}] 连续 ${streak} 次未拿到平台确认，请检查登录态与聊天列表。`,
          2,
        )
      }
    } else {
      consecutiveUnverifiedMap[task.platform] = 0
      await recordError({
        source: `campaign.${task.platform}`,
        message: `投递未完成: [${task.platform}] ${task.jobTitle} @ ${task.company} (原因: ${result.failReason || '未知'})`,
        context: JSON.stringify({
          taskId: task.id,
          jobId: task.jobId,
          jobUrl: task.jobUrl,
          platform: task.platform,
          failReason: result.failReason,
          diagnostics: result.diagnostics,
        }),
      })
      // 定位失败时把现场 DOM 数字直接摊在 AIbot 日志里，
      // 不用再进诊断中心翻 context 才知道是「页面没加载」还是「选择器失配」。
      const diagNote = result.diagnostics
        ? `｜现场：${describeRunnerDiagnostics(result.diagnostics)}`
        : ''
      await appendCampaignLog(
        `❌ 投递未完成：[${task.platform}] ${task.jobTitle} (原因: ${result.failReason || '未知'})${diagNote}`,
        'warn',
      )
    }

    // 核心自动感知：若连续找不到卡片/无法展开（说明用户切换了搜索关键词、城市、翻页或刷新页面，待投缓存已脱节）
    const isCardNotFound = !unverified && (
      result.failReason?.includes('未找到对应岗位卡片') ||
      result.failReason?.includes('详情无法展开')
    )

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
            const mustAchieve = isMustAchieve(campaign.capacityGoal)
            await autoCollectJobsForCampaign(campaign, [task.platform], {
              mustAchieve,
              capacityUrgent: mustAchieve,
            })
            scheduleNextTick(1000)
          }
        }
      }
    } else {
      consecutiveNotFoundMap[task.platform] = 0
    }
  }
}

/**
 * 补记 51job 整页跳转型投递成功。
 *
 * 51job 点「投递」会导航到 applysuccess.php?jobid=XXX，content script 上下文随之销毁，
 * 正常的「点击 → 采集平台确认 → 回传 done」链路跑不完。后台监听 tab URL 变化后调这里，
 * 复用 handleTaskExecutionResult 统一落配额 / 日志 / 去重 / L3 回流，不另开一套记账。
 *
 * 幂等：findApplySuccessTask 排除已 done 的任务，同一成功页重复触发不会重复计数。
 */
export async function recordApplySuccessFromUrl(url: string): Promise<boolean> {
  if (!isApplySuccessUrl(url)) return false
  const campaign = await getCampaign()
  if (!campaign || campaign.status !== 'running') return false
  const task = findApplySuccessTask(campaign.tasks, url)
  if (!task) return false

  const jobId = parseApplySuccessJobId(url)
  log(MOD, 'recordApplySuccessFromUrl', `Apply-success page detected: ${url} -> task ${task.id}`)
  await handleTaskExecutionResult(task, {
    taskId: task.id,
    status: 'done',
    appliedAt: new Date().toISOString(),
    verification: {
      level: 'confirmed',
      signals: ['投递成功页'],
      blockers: [],
      reason: `平台确认依据：投递成功页${jobId ? ` (jobid=${jobId})` : ''}`,
    },
  })
  await appendCampaignLog(
    `🧾 已从平台投递成功页补记：[51job] ${task.jobTitle} @ ${task.company}（整页跳转导致 content 回执丢失，后台按 URL 确认）`,
    'success',
  )
  return true
}

// 统一服务导出接口
export const campaignService = {
  start: async (
    customQuotas?: Partial<Record<PlatformId, number>>,
    enabledPlatforms?: PlatformId[],
    windows?: TimeWindow[],
  ) => {
    const cmp = await startAgentCampaign(customQuotas, enabledPlatforms, windows)
    // 把「N 小时投满 M 份」写进本轮 campaign（参数不变则沿用原倒计时）
    const savedGoal = normalizeCapacityGoal(
      await getSetting<unknown>(CAPACITY_GOAL_KEY, DEFAULT_CAPACITY_GOAL),
    )
    await persistCapacityGoal(savedGoal)
    if (savedGoal.enabled) {
      await appendCampaignLog(
        isMustAchieve(savedGoal)
          ? `🎯 目标必达已设定：${savedGoal.hours} 小时内投满 ${savedGoal.targetJobs} 份（只认平台确认投递）。${describeMustAchieveTakeover()}`
          : `🎯 目标产能已设定：${savedGoal.hours} 小时内投满 ${savedGoal.targetJobs} 份；AIbot 会按剩余时间自动压缩间隔，赶不上时明确预警`,
        'info',
      )
    }
    // 设定目标即视为授权自动接管：先把策略 / 配额 / 平台 / 日限标记一次性拉到位，
    // 再启动调度，避免第一轮 tick 就因为「配额打满」宣告完成。
    if (isMustAchieve(savedGoal)) {
      const live = (await getCampaign()) || cmp
      if (live) await applyMustAchieveTakeover(live, savedGoal, 'start')
      await clearInvalidKeywords()
      capacityOverrunNotifiedFor = ''
    }
    // 启动即说明运行模式，避免用户以为插件又要把浏览器抢回前台
    await appendCampaignLog(
      (await isForegroundMode())
        ? '🖥 前台可见模式：AIbot 运行时会切回招聘网站标签页（仅建议排查采集问题时开启）'
        : '🔇 后台静默运行：AIbot 只在专用后台标签页工作，不抢标签页、不聚焦窗口、不改动你正在看的页面',
      'info',
    )
    // 启动即校验时段：非时段立刻给出明确提示，避免“开了却一直没动静”。
    // 必达模式会自动放行工作时段，这里不能再写「X 分钟后自动开始」误导用户。
    if (cmp && !isMustAchieve(savedGoal) && !isWithinWindow(cmp.windows)) {
      const waitMins = Math.max(1, Math.round(getDelayUntilNextWindow(cmp.windows) / 60_000))
      const tip = `⏸ AIbot 已启动，但当前不在投递时段（${formatTimeWindows(cmp.windows)}），约 ${waitMins} 分钟后自动开始。如需立刻投递，请点击底部【工作时段】改为「24小时不限」后保存。`
      await appendCampaignLog(tip, 'warn')
      sendNotification('⏸ AIbot 已启动 · 当前不在投递时段', tip, 2)
    }
    // 启动即把「岗位名称 → 实际搜索词」摊开给用户看。
    // 填完最常问的是「到底生效没有」，不能等到日志滚到第一轮补仓才说明。
    try {
      const startFilters = await loadSharedApplyFilters()
      const startResume = await getDefaultResume()
      const startKeywords = extractSearchKeywords(startResume, undefined, startFilters)
      const rawTitles = (startFilters.jobTitles || '').trim()
      if (startKeywords.length > 0) {
        await appendCampaignLog(
          `🔎 已读取岗位名称【${rawTitles || '未填写，以下来自简历'}】，解析出 ${startKeywords.length} 个搜索词：${startKeywords.join(' / ')}。每轮轮转 1 个词去各平台精准搜索（不是一次性全搜），下方「🔍 本轮搜索词」可看到当前用的是哪个`,
          'info',
        )
      } else {
        await appendCampaignLog(
          '⚠️ 还没有可用的搜索词：请到「设置 → 岗位名称」填写职位名，例如「php开发, 后端开发, AI 全栈开发」。没读到词时不会按岗位名称搜索，只会停在平台推荐流',
          'warn',
        )
      }
    } catch (err) {
      logWarn(MOD, 'start', err)
    }
    // 启动即挂上看门狗，不等第一次 tick：即使这一轮就因为验证码 / 日限被挂起，
    // 也有独立的周期 alarm 会在下一分钟把流水线拉回来。
    await ensureWatchdogAlarm()
    scheduleNextTick(1000) // 1 秒后立即启动
    return cmp
  },
  pause: async (reason: Campaign['pausedReason'] = 'user') => {
    // 必达目标未达成时，人工暂停只是「宽限」而非终止：记下时间让周期看门狗
    // 5 分钟后自动拉回 running。想彻底停就在目标卡片里关掉「必达模式」。
    const before = await getCampaign()
    const unfinished = !!before && isMustAchieve(before.capacityGoal) &&
      !isGoalAchieved(before.capacityGoal!, summarizeQuotaProgress(before).applied)
    const cmp = await pauseAgentCampaign(reason)
    if (unfinished) {
      await markPausedAt(Date.now())
      await appendCampaignLog(
        '⏸ 已暂停，但目标必达仍未达成：5 分钟后看门狗会自动恢复投递，不需要手动重启。若想彻底停止，请关闭「必达模式」',
        'info',
      )
    }
    if (scheduledTimer) clearTimeout(scheduledTimer)
    scheduledTimer = null
    // 暂停/终止后必须同时清掉 alarm 保底，否则 Service Worker 被唤醒后仍会跑下一 tick；
    // 独立的周期看门狗 alarm 不清，它负责按必达规则按时把流水线拉回来。
    try { await chrome.alarms.clear(ALARM_APPLY_TICK) } catch { /* 预期内异常，安全忽略 */ }
    return cmp
  },
  resume: async () => {
    const cmp = await resumeAgentCampaign()
    scheduleNextTick(1000)
    return cmp
  },
  abort: async () => {
    const before = await getCampaign()
    const unfinished = !!before && isMustAchieve(before.capacityGoal) &&
      !isGoalAchieved(before.capacityGoal!, summarizeQuotaProgress(before).applied)
    const cmp = await abortAgentCampaign()
    if (unfinished) {
      await markPausedAt(Date.now())
      await appendCampaignLog(
        '⏹ 已终止，但目标必达仍未达成：账号安全冷却 15 分钟后看门狗会自动恢复投递。若想彻底停止，请关闭「必达模式」',
        'info',
      )
    }
    if (scheduledTimer) clearTimeout(scheduledTimer)
    scheduledTimer = null
    try { await chrome.alarms.clear(ALARM_APPLY_TICK) } catch { /* 预期内异常，安全忽略 */ }
    // 回收 AIbot 专用后台标签页；用户已点开的标签页会被保留
    const closed = await releaseDedicatedTabs()
    if (closed > 0) {
      await appendCampaignLog(`🧹 已回收 ${closed} 个 AIbot 专用后台标签页`, 'info')
    }
    return cmp
  },
  /** 用户在面板设定 / 修改「N 小时投满 M 份」：设置与 campaign 一起落盘 */
  setCapacityGoal: async (raw: unknown): Promise<CapacityGoal> => {
    const goal = normalizeCapacityGoal(raw)
    await setSetting(CAPACITY_GOAL_KEY, goal)
    await persistCapacityGoal(goal)
    lastCapacityNoticeAt = 0
    capacityMissedNotifiedFor = ''
    capacityOverrunNotifiedFor = ''
    await appendCampaignLog(
      goal.enabled
        ? isMustAchieve(goal)
          ? `🎯 目标必达已更新：${goal.hours} 小时内投满 ${goal.targetJobs} 份（重新计时）。${describeMustAchieveTakeover()}`
          : `🎯 目标产能已更新：${goal.hours} 小时内投满 ${goal.targetJobs} 份（重新计时，AIbot 会自动调速）`
        : '🎯 已关闭目标产能，恢复常规拟人节奏',
      'info',
    )
    const current = await getCampaign()

    // 运行中改目标也要立刻接管，不能等下一轮「配额已满」才发现目标被卡住。
    if (isMustAchieve(goal)) {
      if (current) await applyMustAchieveTakeover(current, goal, 'goal')
      await clearInvalidKeywords()
    }

    // 设定时立刻做「有效工时」预检：墙钟 2 小时不代表有 120 分钟能投。
    // 现场案例：19:15 设 2 小时目标，工作时段 09:00-21:00，21:00 之后 AIbot
    // 静默休眠，目标被宣告完成不了，用户到 21:15 才从日志里发现。
    // 必达模式下工作时段已被自动放行，冲突只作为知情提示，不再报「无法达成」。
    if (goal.enabled && current) {
      const now = Date.now()
      const usableMinutes = countUsableMinutesUntil(
        current.windows || DEFAULT_WINDOWS,
        new Date(now),
        goal.hours * 60 * 60_000,
      )
      const fit = checkCapacityWindowFit({ hours: goal.hours, usableMinutes, now })
      if (isMustAchieve(goal)) {
        await appendCampaignLog(
          fit.conflict
            ? `🎯 目标必达：目标窗口有 ${fit.wallMinutes - fit.usableMinutes} 分钟落在原投递时段外，已自动放行、不休眠，继续投到 ${goal.targetJobs} 份为止`
            : `🎯 目标必达：未来 ${fit.wallMinutes} 分钟全部落在允许投递时段内，无需额外放行`,
          'info',
        )
      } else if (fit.conflict) {
        await appendCampaignLog(`🎯 目标产能可达性预检：${fit.advice}`, 'warn')
        sendNotification('目标产能与工作时段冲突', fit.advice, 2)
      } else {
        await appendCampaignLog(
          `🎯 目标产能可达性预检：未来 ${fit.wallMinutes} 分钟全部落在允许投递时段内`,
          'info',
        )
      }
    }

    if (current?.status === 'running') scheduleNextTick(1000)
    return goal
  },
  /** 用户点「立即继续」/ 关掉休息开关：立刻清掉休息状态并唤醒下一轮投递 */
  skipRest: async () => {
    const current = await getCampaign()
    if (!current) return null
    const policy = resolveRestPolicy(await getDeliveryStrategy())
    await persistRestState({
      restUntil: null,
      consecutiveRestCounter: 0,
      restThreshold: pickInitialRestThreshold(policy),
    })
    await appendCampaignLog('⏭ 已手动跳过本次模拟休息，立即恢复投递', 'info')
    lastRestNoticeAt = 0
    if (current.status === 'running') scheduleNextTick(1000)
    return getCampaign()
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
