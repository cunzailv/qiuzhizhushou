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
import { dismissUnexpectedModals } from '../shared/platform/boss/action-simulator'
import { log, logWarn, logError } from '../shared/utils/logger'

const MOD = 'TaskRunner'

export interface TaskRunnerCallbacks {
  onProgress?: (message: string) => void
}

function reportRunnerError(params: {
  source: string
  message: string
  stack?: string
  context?: string
}) {
  try {
    chrome.runtime.sendMessage({
      type: 'RECORD_ERROR',
      payload: params,
    })
  } catch {
    // 忽略异常上报失败
  }
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
      logWarn(MOD, 'executeCampaignTask', `Cannot open job detail element for: ${task.jobTitle}`)
      notifyLog(`⚠️ 页面未找到岗位卡片：${task.jobTitle}`, 'warn')
      const domCardCount = document.querySelectorAll(
        'li.job-card-box, .job-card-wrapper, .recommend-job-card, li, [class*="job-card"]'
      ).length
      const applyBtnCount = document.querySelectorAll(
        '.btn-startchat, [class*="btn-startchat"], [class*="btn-chat"], [class*="start-chat"]'
      ).length
      reportRunnerError({
        source: `runner.${task.platform}`,
        message: `页面中未找到对应岗位卡片或详情无法展开: [${task.platform}] ${task.jobTitle} @ ${task.company}`,
        context: JSON.stringify({
          jobUrl: task.jobUrl,
          jobId: task.jobId,
          jobTitle: task.jobTitle,
          company: task.company,
          currentUrl: window.location.href,
          domCardCount,
          applyBtnCount,
        }),
      })
      result = {
        taskId: task.id,
        status: 'failed',
        failReason: '页面中未找到对应岗位卡片或详情无法展开',
      }
      return result
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
    let tags = task.tags || []
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
    let matchResult: MatchResult

    if (matchScore !== undefined) {
      matchResult = {
        jobId: task.jobId,
        score: matchScore,
        recommendation: matchReason || '已匹配',
        isRecommended: matchScore >= 60,
        skillMatch: [],
        skillGap: [],
      }
    } else {
      callbacks?.onProgress?.(`AI 匹配分析中: ${task.jobTitle}`)
      matchResult = await matchResumeToJob(activeResume, jobCard)
      matchScore = matchResult.score
      matchReason = matchResult.recommendation
    }

    // 动态配额门槛：< 60 分判定为不合适，直接 skip，不浪费平台配额
    if (matchScore < 60) {
      log(MOD, 'executeCampaignTask', `Score ${matchScore} < 60. Skipping: ${task.jobTitle}`)
      callbacks?.onProgress?.(`评分 ${matchScore} 不达标，已跳过`)
      result = {
        taskId: task.id,
        status: 'skipped',
        matchScore,
        matchReason,
        failReason: `AI 评分 ${matchScore} 分低于门槛 60 分`,
      }
      return result
    }

    // 5. 生成或读取个性化打招呼话术（基于动态路由的专属画像简历）
    let greeting = task.greeting
    if (!greeting) {
      callbacks?.onProgress?.(`生成个性化招呼语: ${task.jobTitle}`)
      const greetRes = await generateJobGreeting(activeResume, jobCard, matchResult, adapter)
      greeting = greetRes.text
    }

    // 6. 执行点击沟通 / 投递
    callbacks?.onProgress?.(`正在沟通投递: ${task.jobTitle}`)
    const commSnapshot = adapter.snapshotCommunicationUi()
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

    // 7. 发送问候语
    if (greeting) {
      await adapter.fillGreetingMessage(greeting, commSnapshot)
    }

    await randomDelay(500, 1000)

    // 8. 投递成功，记录落盘与去重
    await saveApplicationRecord(jobCard, matchResult, activeResume.id, adapter.id)
    await addSharedAppliedJobId(task.jobId)

    callbacks?.onProgress?.(`投递成功: ${task.jobTitle}`)
    result = {
      taskId: task.id,
      status: 'done',
      matchScore,
      matchReason,
      greeting,
      appliedAt: new Date().toISOString(),
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
