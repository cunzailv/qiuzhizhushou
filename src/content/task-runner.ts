// Content 侧流水线单任务执行器（DOM 交互、状态流转与现场复原）

import type { PlatformAdapter } from '../shared/platform/types'
import type { ApplyTask } from '../shared/agent/queue-store'
import type { Resume } from '../shared/types/resume'
import type { JobCard, MatchResult } from '../shared/types/job'
import { scanRisk, randomDelay } from '../shared/antiBot'
import { matchResumeToJob } from '../shared/ai/remote-matcher'
import { generateJobGreeting } from '../shared/ai/greeting'
import { getOptimalResumeForJob } from '../shared/ai/resume-router'
import { addSharedAppliedJobId } from '../shared/db/shared-state'
import { recordSelfHealingEvent } from '../shared/db/diagnostics-store'
import { appendSharedError, recordError } from '../shared/db/error-store'
import { dismissUnexpectedModals } from '../shared/platform/boss/action-simulator'
import { log, logWarn, logError } from '../shared/utils/logger'
import { getSetting } from '../shared/db/settings-store'
import { loadSharedApplyFilters } from '../shared/agent/filter-config'
import { CAPACITY_PRIORITY_THRESHOLD } from '../shared/agent/capacity-goal'
import { resolveMustAchieveMatchThreshold } from '../shared/agent/must-achieve'
import {
  collectApplyPageTexts,
  decideApplyVerification,
  hasNewCommunicationUi,
  isChatPageUrl,
  type ApplyVerification,
} from '../shared/agent/apply-verification'
import { isApplySuccessUrl } from '../shared/agent/apply-success'

const MOD = 'TaskRunner'

// ─────────── 投递门槛自适应 ───────────
// 连续多个岗位都因匹配分不足被跳过时，说明门槛与当前候选池不匹配，
// 逐级下调门槛保证产能；只要成功投递一次就立刻恢复到用户设定值。
const THRESHOLD_RELAX_KEY = 'aibot_threshold_relax_level'
const THRESHOLD_SKIP_STREAK_KEY = 'aibot_threshold_skip_streak'
const MAX_RELAX_LEVEL = 3
const RELAX_STEP = 10
const SKIP_STREAK_TO_RELAX = 5
const MIN_THRESHOLD = 30

async function readNumberSetting(key: string): Promise<number> {
  try {
    const res = await chrome.storage.local.get(key)
    const v = Number(res?.[key] ?? 0)
    return Number.isFinite(v) ? v : 0
  } catch {
    return 0
  }
}

async function writeNumberSetting(key: string, value: number): Promise<void> {
  try {
    await chrome.storage.local.set({ [key]: value })
  } catch {
    // 存储不可用时静默忽略
  }
}

async function getThresholdRelaxLevel(): Promise<number> {
  return Math.min(MAX_RELAX_LEVEL, Math.max(0, await readNumberSetting(THRESHOLD_RELAX_KEY)))
}

/**
 * 投递成功后只**回退一档**，不清零。
 * 旧版每次成功都把降档清零，造成「连跳 5 个 → 降档 → 刚投成功 1 个 → 门槛立刻弹回
 * → 又连跳 5 个」的震荡；在目标产能（要在时限内投满 N 份）下等于反复卡死产出。
 */
async function resetThresholdRelax(): Promise<void> {
  const level = await getThresholdRelaxLevel()
  await writeNumberSetting(THRESHOLD_RELAX_KEY, Math.max(0, level - 1))
  await writeNumberSetting(THRESHOLD_SKIP_STREAK_KEY, 0)
}

function notifyCampaignLog(message: string, level: 'info' | 'warn' = 'warn'): void {
  try {
    void chrome.runtime.sendMessage({
      type: 'APPEND_CAMPAIGN_LOG',
      payload: { message, level },
    })?.catch?.(() => {})
  } catch {
    // 后台不可达时忽略
  }
}

export interface TaskRunnerCallbacks {
  onProgress?: (message: string) => void
  /** 关闭 AIbot 时置为 true；在各阶段间隙中止当前任务，避免「停止无效」 */
  shouldCancel?: () => boolean
  /** 目标产能落后：匹配分只作排序，不再当否决闸门（采集层已做方向/技术栈硬筛） */
  capacityUrgent?: boolean
  /** 必达模式：匹配分彻底不否决（门槛 0），只用于排序；方向 / 技术栈硬约束仍在采集层 */
  mustAchieve?: boolean
}

/** 门槛放宽每个 content script 生命周期只播报一次，避免每个岗位刷一条日志 */
let mustAchieveThresholdAnnounced = false

interface RunnerErrorParams {
  source: string
  message: string
  stack?: string
  context?: string
}

/**
 * 后台休眠 / 无接收方时，不能让「岗位卡片找不到」这类关键诊断凭空消失。
 * 与统一上报入口一致：先写跨域共享队列，再退到本上下文的 Dexie。
 */
async function fallbackRecordRunnerError(params: RunnerErrorParams): Promise<void> {
  try {
    const stored = await appendSharedError({
      source: params.source,
      message: params.message,
      stack: params.stack,
      context: params.context,
    })
    if (!stored) {
      await recordError({
        source: params.source,
        message: params.message,
        stack: params.stack,
        context: params.context,
      })
    }
  } catch {
    // 留痕本身失败绝不阻塞主链路
  }
}

function reportRunnerError(params: RunnerErrorParams) {
  try {
    const sent = chrome.runtime.sendMessage({
      type: 'RECORD_ERROR',
      payload: params,
    })
    // MV3 的 sendMessage 返回 Promise；旧版 fire-and-forget 既不处理 rejection，
    // 也没有兜底，Service Worker 休眠时这条错误就丢了，诊断中心查不到。
    Promise.resolve(sent)
      .then((res) => {
        if (!(res as { success?: boolean } | undefined)?.success) {
          void fallbackRecordRunnerError(params)
        }
      })
      .catch(() => { void fallbackRecordRunnerError(params) })
  } catch {
    void fallbackRecordRunnerError(params)
  }
}

/**
 * 现场 DOM 诊断：岗位卡片定位失败时，光有「找不到」四个字无法判断
 * 是站点改版、页面没加载、还是任务来源页不对。这些数字会同时进
 * 诊断中心的 context 和 AIbot 行为日志。
 */
/**
 * 只把「真正的岗位详情页」算作详情链接。
 *
 * 旧口径 `a[href*="jobs.51job.com"]` 把公司页（/all/coXXX.html）、城市聚合页、
 * 页脚导航全算进去：真实现场曾报「85 个详情链接」，看着像有 85 个岗位，
 * 实际一张卡片都没有，反而误导排查。公司页必须先排除。
 */
export function isJobDetailHref(href: string): boolean {
  if (!href) return false
  if (/jobs\.51job\.com\/[^/]*\/co[A-Za-z0-9]+\.html|jobs\.51job\.com\/all\//i.test(href)) return false
  return /\/job_detail\/|\/job-detail\/|\/jobdetail\/|\/job\/\d+|\/position\/\d+|[?&](?:jobid|jobId|job_id|positionId)=\d+|jobs\.51job\.com\/[^/]+\/\d+\.html/i.test(href)
}

/** 51job 公司页链接：出现在搜索结果里是正常现象，但出现在「执行页」就说明 tab 跑偏了 */
export function isCompanyPageHref(href: string): boolean {
  return /jobs\.51job\.com\/[^/]*\/co[A-Za-z0-9]+\.html/i.test(href)
}

export function collectPageDomDiagnostics(): Record<string, unknown> {
  if (typeof document === 'undefined') return {}
  const count = (selector: string): number => {
    try { return document.querySelectorAll(selector).length } catch { return -1 }
  }
  const anchors = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]'))
  const detailAnchors = anchors.filter((a) => isJobDetailHref(a.href))
  const companyAnchors = anchors.filter((a) => isCompanyPageHref(a.href))
  // 优先采样岗位链接标题；一条岗位链接都没有时再退回普通链接。
  // 否则现场只会采到「求职招聘指南 / 我的51job」这类页脚文字，毫无排查价值。
  const samplePool = detailAnchors.length > 0 ? detailAnchors : anchors
  const sampleLinkTexts = samplePool
    .map((a) => (a.textContent || '').replace(/\s+/g, ' ').trim())
    .filter((t) => t.length > 4 && t.length < 60)
    .slice(0, 3)
  const pageUrl = typeof window !== 'undefined' ? window.location.href : ''
  let pageUrlShort = ''
  try {
    const u = new URL(pageUrl)
    pageUrlShort = `${u.host}${u.pathname}`
  } catch {
    pageUrlShort = pageUrl.split('?')[0]
  }
  return {
    pageUrl,
    /** 只保留域名 + 路径，去掉 query，便于日志里一眼看出当前是不是列表页 */
    pageUrlShort,
    listContainers: count('.joblist, [class*="joblist"], [class*="job-list"], [class*="job-card"]'),
    jobCards: count('.joblist-item, [class*="joblist-item"], [class*="job-card"], [class*="job-item"]'),
    anchors: anchors.length,
    detailLinks: detailAnchors.length,
    companyLinks: companyAnchors.length,
    buttons: count('button, [role="button"]'),
    visibleDialogs: count('[role="dialog"], [class*="dialog"], [class*="modal"]'),
    bodyTextLength: (document.body?.textContent || '').length,
    sampleLinkTexts,
  }
}

/**
 * 等列表页真正渲染出岗位卡片。
 *
 * 51job 搜索页是 SPA：`chrome.tabs` 的 status=complete 只代表文档加载完，
 * 岗位列表还要等 XHR + 前端渲染；后台非活跃标签页还会被浏览器节流，
 * 固定等 1.2 秒远远不够。现场日志 `we.51job.com/pc/search / 0 张岗位卡片 /
 * 0 个岗位详情链接 / 正文 1698 字 / 岗位样例：求职招聘指南` 就是渲染前的空壳。
 *
 * 投递成功页必须直接判未就绪：那是上一个任务的回执，不是本任务该执行的列表页。
 */
export async function waitForJobListReady(maxMs = 9000, currentHref?: string): Promise<boolean> {
  if (typeof document === 'undefined') return false
  const deadline = Date.now() + maxMs
  while (Date.now() < deadline) {
    const href = currentHref ?? (typeof window !== 'undefined' ? window.location.href : '')
    if (isApplySuccessUrl(href)) return false
    const diag = collectPageDomDiagnostics()
    if ((Number(diag.jobCards) || 0) > 0 || (Number(diag.detailLinks) || 0) > 0) return true
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
  return false
}

/** 给用户看的短诊断，直接进行为日志，不用再进诊断中心翻 */
export function describePageDomDiagnostics(diag: Record<string, unknown>): string {
  const where = diag.pageUrlShort ? `（页面 ${diag.pageUrlShort}）` : ''
  const company = Number(diag.companyLinks) || 0
  const companyNote = company > 0 ? ` / 公司页链接 ${company} 个` : ''
  return `当前页${where} ${diag.jobCards ?? 0} 张岗位卡片 / ${diag.detailLinks ?? 0} 个岗位详情链接${companyNote} / ${diag.buttons ?? 0} 个按钮 / 正文 ${diag.bodyTextLength ?? 0} 字`
}

export interface TaskExecutionResponse {
  taskId: string
  status: 'done' | 'skipped' | 'failed' | 'paused'
  matchScore?: number
  matchReason?: string
  greeting?: string
  riskDetected?: 'captcha' | 'rate' | 'block'
  failReason?: string
  appliedAt?: string
  /** 现场 DOM 诊断 JSON：定位失败时让后台日志与诊断中心都能看到「卡在哪一层」 */
  diagnostics?: string
  /** 平台侧确认证据；只有 level=confirmed 才允许记 done */
  verification?: ApplyVerification
}

function notifyLog(message: string, level: 'info' | 'success' | 'warn' | 'error' = 'info') {
  try {
    chrome.runtime.sendMessage({
      type: 'APPEND_CAMPAIGN_LOG',
      payload: { message, level },
    })
  } catch {
    // 忽略发送失败
  }
}

/** 轮询等待详情面板中的岗位描述文本渲染完成 */
async function waitForJobDescription(
  adapter: PlatformAdapter,
  detail: HTMLElement,
  current: string,
  timeoutMs = 2500,
): Promise<string> {
  const deadline = Date.now() + timeoutMs
  let best = current
  let stableRounds = 0
  while (Date.now() < deadline) {
    const text = adapter.extractJobDescriptionFromDetail(detail)
    if (text.length > best.length) {
      best = text
      stableRounds = 0
    } else if (text.length === best.length && text.length > 0) {
      stableRounds++
    }
    if (best.length > current.length && stableRounds >= 2) return best
    await new Promise((r) => setTimeout(r, 120))
  }
  return best
}

/** 现场复原：关闭可能弹出的聊天窗口、确认框、干扰弹窗或遮罩，强力解除页面阻塞 */
export async function cleanupUi(adapter?: PlatformAdapter): Promise<void> {
  try {
    if (adapter?.closeDetailPanel) {
      await adapter.closeDetailPanel()
    }
    // 关闭 Boss / 各平台弹窗通用关闭按钮
    const closeBtns = document.querySelectorAll<HTMLElement>(
      '.dialog-wrap .icon-close, .dialog-wrap .dialog-close, .chat-dialog .close, [aria-label="Close"], .boss-popup__close, .dialog-close',
    )
    for (const btn of Array.from(closeBtns)) {
      if (btn.offsetParent !== null || btn.offsetWidth > 0 || btn.offsetHeight > 0) {
        btn.click()
        await randomDelay(100, 250)
      }
    }

    // 探测并强力解除任何意外弹窗、半透明遮罩与视口冻结
    dismissUnexpectedModals(document)
  } catch {
    // 忽略清理异常
  } finally {
    // M3：二次兜底。即使上述 DOM 操作整体抛错，也必须恢复滚动与焦点，
    // 保证下一个岗位不会因残留的 body 锁死或焦点困在弹窗内而失败。
    try {
      if (typeof document !== 'undefined') {
        document.body.style.overflow = ''
        ;(document.activeElement as HTMLElement | null)?.blur?.()
      }
    } catch {
      // 忽略视口复原异常，绝不向主链路冒泡
    }
  }
}

/** 保存投递结果至后台 IndexedDB */
async function saveApplicationRecord(
  job: JobCard,
  match: MatchResult,
  resumeId: string,
  platformId: string,
): Promise<boolean> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      {
        type: 'SAVE_APPLICATION',
        payload: {
          job,
          match,
          resumeId,
          platformId,
          appliedAt: new Date().toISOString(),
        },
      },
      (response) => {
        if (chrome.runtime.lastError) {
          logError(MOD, 'saveApplicationRecord', chrome.runtime.lastError.message)
          resolve(false)
          return
        }
        resolve(response?.success === true)
      },
    )
  })
}

/** 执行单个 Campaign 投递任务（M3：try-finally 单岗位故障隔离边界） */
export async function executeCampaignTask(
  task: ApplyTask,
  adapter: PlatformAdapter,
  defaultResume: Resume,
  callbacks?: TaskRunnerCallbacks,
): Promise<TaskExecutionResponse> {
  log(MOD, 'executeCampaignTask', `Starting task ${task.id}: ${task.jobTitle} @ ${task.company}`)
  callbacks?.onProgress?.(`正在处理: ${task.jobTitle} @ ${task.company}`)

  let result: TaskExecutionResponse = {
    taskId: task.id,
    status: 'failed',
    failReason: '未知错误',
  }

  try {
    if (callbacks?.shouldCancel?.()) {
      return { taskId: task.id, status: 'failed', failReason: '已取消：AIbot 已关闭' }
    }

    // 1. 优先扫描页面风控状态
    const risk = scanRisk(adapter.getRiskConfig())
    if (risk) {
      logWarn(MOD, 'executeCampaignTask', `Risk detected: ${risk.type} - ${risk.message}`)
      callbacks?.onProgress?.(`风控告警: ${risk.message}`)
      let riskDetected: 'captcha' | 'rate' | 'block' = 'captcha'
      if (risk.type === 'rate_limit') riskDetected = 'rate'
      else if (risk.type === 'block') riskDetected = 'block'
      result = {
        taskId: task.id,
        status: 'paused',
        riskDetected,
        failReason: risk.message,
      }
      return result
    }

    // 2. 在页面中打开目标岗位详情（多阶自愈降级）
    callbacks?.onProgress?.(`打开岗位详情: ${task.jobTitle}`)
    notifyLog(`📄 正在展开岗位详情：${task.jobTitle} @ ${task.company}`)
    let detailEl: HTMLElement | null = null
    if (typeof adapter.activateJobCardWithFallback === 'function') {
      detailEl = await adapter.activateJobCardWithFallback(task.jobUrl, task.jobId, task.jobTitle, task.company)
    } else {
      detailEl = await adapter.activateJobCard(task.jobUrl, task.jobId, task.jobTitle, task.company)
    }
    if (!detailEl) {
      // 旧诊断只数 Boss 的 .job-card-box / .btn-startchat，对 51job 恒为 0，
      // 记录虽然进了诊断中心却没有任何排查价值。现在按平台无关的口径采现场。
      const firstDiag = collectPageDomDiagnostics()
      const onSuccessPage = typeof window !== 'undefined' && isApplySuccessUrl(window.location.href)
      const isEmptyShell =
        (Number(firstDiag.jobCards) || 0) === 0 &&
        (Number(firstDiag.detailLinks) || 0) === 0

      if (onSuccessPage || isEmptyShell) {
        // 页面根本不是可执行的列表页：可能停在上一单的投递成功回执页，
        // 也可能搜索页 SPA 还在等 XHR（后台标签会被浏览器节流）。
        // 先给渲染一个窗口，再重试一次卡片激活。
        notifyLog(
          `⏳ 列表页未就绪（${onSuccessPage ? '当前停在投递成功页' : '岗位卡片尚未渲染'}），等待页面就绪...`,
          'info',
        )
        const ready = await waitForJobListReady()
        if (ready) {
          detailEl = typeof adapter.activateJobCardWithFallback === 'function'
            ? await adapter.activateJobCardWithFallback(task.jobUrl, task.jobId, task.jobTitle, task.company)
            : await adapter.activateJobCard(task.jobUrl, task.jobId, task.jobTitle, task.company)
        }
        if (!detailEl) {
          // 关键：标 skipped 而不是 failed。failed 会被后台判成「连续未找到卡片」，
          // 触发 clearPendingTasks 自愈把新采到的岗位一起清掉（现场 156 次空转）。
          // skipped 走回收机制，任务保留、下一轮重试，队列不动。
          const latest = collectPageDomDiagnostics()
          notifyLog(`⏳ 页面仍未就绪：${task.jobTitle} ${describePageDomDiagnostics(latest)}（任务保留待重试）`, 'warn')
          result = {
            taskId: task.id,
            status: 'skipped',
            failReason: '列表页未就绪（页面无岗位卡片，等待渲染或重新导航）',
            diagnostics: JSON.stringify(latest),
          }
          return result
        }
      }

      if (!detailEl) {
        logWarn(MOD, 'executeCampaignTask', `Cannot open job detail element for: ${task.jobTitle}`)
        const diag = collectPageDomDiagnostics()
        const diagText = describePageDomDiagnostics(diag)
        notifyLog(`⚠️ 页面未找到岗位卡片：${task.jobTitle} ${diagText}`, 'warn')
        reportRunnerError({
          source: `runner.${task.platform}`,
          message: `页面中未找到对应岗位卡片或详情无法展开: [${task.platform}] ${task.jobTitle} @ ${task.company}`,
          context: JSON.stringify({
            jobUrl: task.jobUrl,
            jobId: task.jobId,
            jobTitle: task.jobTitle,
            company: task.company,
            currentUrl: window.location.href,
            diagText,
            ...diag,
          }),
        })
        result = {
          taskId: task.id,
          status: 'failed',
          failReason: '页面中未找到对应岗位卡片或详情无法展开',
          diagnostics: JSON.stringify(diag),
        }
        return result
      }
    }

    // 智能拦截：若详情面板提示职位已下线/已停止招聘，直接标记为跳过，避免作为执行失败计入
    const isOffline =
      detailEl.getAttribute('data-job-offline') === 'true' ||
      detailEl.dataset?.jobOffline === 'true' ||
      /该职位已关闭|职位已关闭|停止招聘|已停止招聘|职位已下线|已下架|已暂停招聘|无法沟通/.test(
        detailEl.innerText || detailEl.textContent || '',
      )
    if (isOffline) {
      logWarn(MOD, 'executeCampaignTask', `Job is offline or closed: ${task.jobTitle}`)
      notifyLog(`⏭️ 该岗位已停止招聘或下线，智能跳过：${task.jobTitle}`, 'info')
      result = {
        taskId: task.id,
        status: 'skipped',
        failReason: '该岗位已停止招聘或下线',
      }
      return result
    }

    await randomDelay(400, 800)

    // 3. 提取详情真实完整 JD
    const extractedJd = await waitForJobDescription(adapter, detailEl, '', 2000)
    notifyLog(`📑 成功提取职位完整描述（共 ${extractedJd.length} 字）`)
    let location = task.location || ''
    let experience = task.experience || ''
    let education = task.education || ''
    const tags = task.tags || []
    let bossName = task.bossName || ''
    let bossTitle = task.bossTitle || ''

    // 尝试从当前已展开的详情面板补充缺失的地点、经验、学历及 HR 字段
    if (!location || !experience || !education || !bossName) {
      const textDesc =
        detailEl.querySelector(
          '.text-desc, [class*="text-desc"], .job-status, [class*="job-status"], .job-banner',
        )?.textContent || ''
      const parts = textDesc.split(/[\s·•/]+/).map((s) => s.trim()).filter(Boolean)
      if (!experience) {
        experience = parts.find((p) => /(\d+[-\s]*年)|应届|经验|不限/.test(p)) || ''
      }
      if (!education) {
        education = parts.find((p) => /本科|硕士|大专|博士|中专|高中|学历|不限/.test(p)) || ''
      }
      if (!location) {
        location = parts.find((p) => p !== experience && p !== education && p.length <= 15) || ''
      }

      if (!bossName) {
        const bossEl = detailEl.querySelector('[class*="boss-name"], [class*="boss-info"]')
        bossName = (bossEl?.querySelector('[class*="name"]')?.textContent || bossEl?.textContent || '').trim()
        const titleEl = detailEl.querySelector('[class*="boss-title"], [class*="boss-job"]')
        bossTitle = (titleEl?.textContent || '').trim()
      }
    }

    const jobCard: JobCard = {
      id: task.jobId,
      title: task.jobTitle,
      companyName: task.company,
      companyLogo: '',
      url: task.jobUrl,
      salary: task.salary || '',
      jobDescription: extractedJd,
      platformId: task.platform,
      location,
      experience,
      education,
      tags,
      bossName,
      bossTitle,
      bossOnline: false,
      publishedAt: '',
    }

    // 4. 一人多面动态简历路由：挑选与该岗位最契合的简历版本
    let activeResume = defaultResume
    try {
      const routing = await getOptimalResumeForJob(jobCard)
      if (routing?.selectedResume) {
        activeResume = routing.selectedResume
        log(MOD, 'executeCampaignTask', `Dynamic resume routed: ${routing.routingReason}`)
      }
    } catch {
      // 保持 defaultResume
    }

    // AI 筛岗评分（如果已有缓存且有分直接用；否则现场计算）
    let matchScore = task.matchScore
    let matchReason = task.matchReason
    // 投递门槛：用用户设定的最低匹配分，而不是写死的 60。
    // AI 未启用时评分走本地规则，量纲偏低（常见 20-45 分），
    // 直接套 60 会把所有岗位判为不合格 → 队列一进来就全被跳过。
    // 投递门槛：用用户设定的最低匹配分，而不是写死的 60。
    // AI 未启用时评分走本地规则，量纲偏低（常见 20-45 分），
    // 直接套 60 会把所有岗位判为不合格 → 队列一进来就全被跳过。
    const applyFilters = await loadSharedApplyFilters().catch(() => null)
    const fastMode = await getSetting<boolean>('aibotFastMode', false)
    const aiMatchEnabled = await getSetting<boolean>('aiEnabled', false) && !fastMode
    const baseThreshold = applyFilters?.minMatchScore ?? 60
    const rawThreshold = aiMatchEnabled
      ? baseThreshold
      : Math.max(25, Math.round(baseThreshold * 0.55))

    // 自适应下调：长期零产出时逐级放宽，避免「候选都 30 分、门槛 60」的全跳过死局
    const relaxLevel = await getThresholdRelaxLevel()
    const adaptiveThreshold = Math.max(MIN_THRESHOLD, rawThreshold - relaxLevel * RELAX_STEP)

    /**
     * 产能优先：目标产能落后时，采集层已完成职业方向 / 语义 / 技术栈 / 活跃度硬筛，
     * 这里的本地评分只用来排序。现场案例：PHP 方向的「高级php工程师」本地评分 30 分，
     * 门槛 33 分（60*0.55），对口岗位被直接跳过，目标产能结构性不可达。
     * 保留 CAPACITY_PRIORITY_THRESHOLD 下限，仍能挡住评分极低的脏数据卡片。
     */
    const capacityUrgent = callbacks?.capacityUrgent === true
    const mustAchieve = callbacks?.mustAchieve === true
    const baseMatchThreshold = capacityUrgent
      ? Math.min(adaptiveThreshold, CAPACITY_PRIORITY_THRESHOLD)
      : adaptiveThreshold
    const matchThreshold = resolveMustAchieveMatchThreshold(baseMatchThreshold, mustAchieve)
    if (mustAchieve && baseMatchThreshold > 0 && !mustAchieveThresholdAnnounced) {
      mustAchieveThresholdAnnounced = true
      notifyCampaignLog(
        `🎯 必达模式：本地匹配分门槛从 ${baseMatchThreshold} 降到 ${matchThreshold}，只用于排序、不再否决岗位（采集层的方向 / 技术栈 / 黑名单硬约束仍生效，不虚报投递成功）`,
        'info',
      )
    }
    if (!mustAchieve && capacityUrgent && baseMatchThreshold < adaptiveThreshold) {
      notifyCampaignLog(
        `🎯 产能优先：本岗位已通过方向/技术栈硬筛，投递门槛临时从 ${adaptiveThreshold} 放宽到 ${baseMatchThreshold} 分（只保留脏数据下限，不再让本地评分量纲卡住目标产能）`,
        'info',
      )
    }

    let matchResult: MatchResult

    if (matchScore !== undefined) {
      matchResult = {
        jobId: task.jobId,
        score: matchScore,
        recommendation: matchReason || '已匹配',
        isRecommended: matchScore >= matchThreshold,
        skillMatch: [],
        skillGap: [],
      }
    } else {
      callbacks?.onProgress?.(fastMode ? `快速评分中: ${task.jobTitle}` : `AI 匹配分析中: ${task.jobTitle}`)
      matchResult = await matchResumeToJob(activeResume, jobCard, { forceLocal: fastMode })
      matchScore = matchResult.score
      matchReason = matchResult.recommendation
    }

    // 动态配额门槛：低于门槛判定为不合适，直接 skip，不浪费平台配额
    if ((matchScore ?? 0) < matchThreshold) {
      // 连续被跳过时逐级放宽门槛，保证长期空转下仍能产出
      const skipStreak = (await readNumberSetting(THRESHOLD_SKIP_STREAK_KEY)) + 1
      if (skipStreak >= SKIP_STREAK_TO_RELAX && relaxLevel < MAX_RELAX_LEVEL) {
        const nextLevel = relaxLevel + 1
        const nextThreshold = Math.max(MIN_THRESHOLD, rawThreshold - nextLevel * RELAX_STEP)
        await writeNumberSetting(THRESHOLD_RELAX_KEY, nextLevel)
        await writeNumberSetting(THRESHOLD_SKIP_STREAK_KEY, 0)
        notifyCampaignLog(
          `⚡ 已连续 ${skipStreak} 个岗位因匹配分不足被跳过，自动把投递门槛从 ${matchThreshold} 下调到 ${nextThreshold}，先保证有产出（成功投递一次后自动恢复）`,
          'warn',
        )
      } else {
        await writeNumberSetting(THRESHOLD_SKIP_STREAK_KEY, skipStreak)
      }

      log(MOD, 'executeCampaignTask', `Score ${matchScore} < ${matchThreshold}. Skipping: ${task.jobTitle}`)
      callbacks?.onProgress?.(`评分 ${matchScore} 不达标（门槛 ${matchThreshold}），已跳过`)
      result = {
        taskId: task.id,
        status: 'skipped',
        matchScore,
        matchReason,
        failReason: `评分 ${matchScore} 分低于门槛 ${matchThreshold} 分`,
      }
      return result
    }

    // 5. 生成或读取个性化打招呼话术（基于动态路由的专属画像简历）
    let greeting = task.greeting
    if (!greeting) {
      if (fastMode) {
        // 极速模式：跳过 AI 话术生成，直接用平台模板，省 3-8 秒/个
        greeting = adapter.getJobSpecificGreeting(
          activeResume.structuredData?.name || '您好',
          jobCard,
          matchResult,
        )
      } else {
        callbacks?.onProgress?.(`生成个性化招呼语: ${task.jobTitle}`)
        const greetRes = await generateJobGreeting(activeResume, jobCard, matchResult, adapter)
        greeting = greetRes.text
      }
    }

    // 6. 执行点击沟通 / 投递
    callbacks?.onProgress?.(`正在沟通投递: ${task.jobTitle}`)
    if (callbacks?.shouldCancel?.()) {
      result = { taskId: task.id, status: 'failed', failReason: '已取消：AIbot 已关闭' }
      return result
    }

    const commSnapshot = adapter.snapshotCommunicationUi()
    // 点击前的基线：排除「这个岗位之前就沟通过、按钮本来就是继续沟通」的旧状态
    const baselineTexts = collectApplyPageTexts(detailEl)
    const urlBeforeClick = typeof window !== 'undefined' ? window.location.href : ''
    const clicked = await adapter.clickApplyButton(detailEl)

    if (!clicked) {
      logWarn(MOD, 'executeCampaignTask', `Click apply button failed: ${task.jobTitle}`)
      reportRunnerError({
        source: `runner.${task.platform}`,
        message: `点击沟通/投递按钮失败: [${task.platform}] ${task.jobTitle} @ ${task.company}`,
        context: JSON.stringify({
          jobUrl: task.jobUrl,
          jobId: task.jobId,
          jobTitle: task.jobTitle,
          company: task.company,
          currentUrl: window.location.href,
        }),
      })
      result = {
        taskId: task.id,
        status: 'failed',
        matchScore,
        matchReason,
        greeting,
        failReason: '点击沟通/投递按钮失败',
      }
      return result
    }

    await randomDelay(600, 1200)

    // 6.1 点击后的平台侧证据：先采一次，避免稍后话术窗口被关闭导致证据丢失
    const postClickTexts = collectApplyPageTexts(detailEl)
    const commAfterClick = adapter.snapshotCommunicationUi()
    const communicationUiChanged = hasNewCommunicationUi(commSnapshot, commAfterClick)

    // 7. 发送问候语（返回值 = 是否真的出现了新输入框并点了发送）
    let greetingSent = false
    if (greeting) {
      greetingSent = await adapter.fillGreetingMessage(greeting, commSnapshot)
    }

    await randomDelay(500, 1000)

    // 关闭 bot 后不得再写库，避免留下「已沟通但未记录」的脏投递
    if (callbacks?.shouldCancel?.()) {
      result = { taskId: task.id, status: 'failed', failReason: '已取消：AIbot 已关闭' }
      return result
    }

    const pageTexts = collectApplyPageTexts(detailEl)
    const urlAfterClick = typeof window !== 'undefined' ? window.location.href : ''
    const verification = decideApplyVerification({
      clicked,
      greetingSent,
      baselineTexts,
      postClickTexts,
      pageTexts,
      communicationUiChanged,
      navigatedToChat: urlAfterClick !== urlBeforeClick && isChatPageUrl(urlAfterClick),
    })

    // 8. 只有平台侧确认才允许落盘。点击成功不等于沟通成立。
    if (verification.level !== 'confirmed') {
      const prefix = verification.level === 'blocked' ? '平台未受理' : '未确认'
      const failReason = `${prefix}：${verification.reason}`
      notifyCampaignLog(
        `[${task.platform}] ${task.company} - ${task.jobTitle} 未记为投递成功。${failReason}（不落盘、不去重、不计配额，请到平台聊天列表核对）`,
        'warn',
      )
      callbacks?.onProgress?.(`${prefix}，不记为成功: ${task.jobTitle}`)
      reportRunnerError({
        source: `runner.${task.platform}`,
        message: `投递未确认: [${task.platform}] ${task.jobTitle} @ ${task.company} (${verification.reason})`,
        context: JSON.stringify({
          jobUrl: task.jobUrl,
          jobId: task.jobId,
          platform: task.platform,
          level: verification.level,
          signals: verification.signals,
          blockers: verification.blockers,
          clicked,
          greetingSent,
          communicationUiChanged,
          currentUrl: urlAfterClick,
        }),
      })
      result = {
        taskId: task.id,
        status: 'failed',
        matchScore,
        matchReason,
        greeting,
        failReason,
        verification,
      }
      return result
    }

    await saveApplicationRecord(jobCard, matchResult, activeResume.id, adapter.id)
    await addSharedAppliedJobId(task.jobId)
    // 有产出即恢复用户设定的门槛，避免长期停留在放宽状态
    await resetThresholdRelax()

    callbacks?.onProgress?.(`平台已确认投递: ${task.jobTitle}`)
    result = {
      taskId: task.id,
      status: 'done',
      matchScore,
      matchReason,
      greeting,
      appliedAt: new Date().toISOString(),
      verification,
    }
    return result
  } catch (err) {
    logError(MOD, 'executeCampaignTask', err)
    reportRunnerError({
      source: `runner.${task.platform}`,
      message: `执行岗位投递任务异常: ${String(err)}`,
      stack: err instanceof Error ? err.stack : undefined,
      context: JSON.stringify({
        jobUrl: task.jobUrl,
        jobId: task.jobId,
        jobTitle: task.jobTitle,
        company: task.company,
        currentUrl: typeof window !== 'undefined' ? window.location.href : '',
      }),
    })

    // M4：单岗位不可逆异常归因入库，供管家「开发者待修清单」聚合
    void recordSelfHealingEvent({
      platform: task.platform,
      category: 'task_isolated',
      triggerDescription: String(err),
      bypassPath: 'skip_and_continue',
      taskId: task.id,
      jobTitle: task.jobTitle,
      success: false,
    }).catch(() => {})

    result = {
      taskId: task.id,
      status: 'failed',
      failReason: `任务执行异常: ${String(err)}`,
    }
    return result
  } finally {
    // M3：无论成功 / 业务失败 / 抛出异常，始终执行现场复原。
    // .catch(() => {}) 保证清理链路自身的异常也绝不阻断主流水线。
    await cleanupUi(adapter).catch(() => {})
  }
}
