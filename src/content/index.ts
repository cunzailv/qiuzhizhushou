// Content script entry point - injected into Boss Zhipin pages
import { getActivePlatform } from '../shared/platform'
import type { PlatformAdapter } from '../shared/platform/types'
import { setPlatformName } from './inject-ui'

// 当前活动平台适配器（由 PlatformManager 按网址自动识别，或按设置手动覆盖）。
let adapter: PlatformAdapter
import { createFloatingPanel, updatePanelContent, showPanelToast } from './inject-ui'
import { randomDelay, scanRisk, checkDailyLimit, incrementCounter } from '../shared/antiBot'
import { matchResumeToJob } from '../shared/ai'
import { getSharedResumeSummary, getSharedFullResume, getSharedAppliedJobIds, addSharedAppliedJobId } from '../shared/db/shared-state'
import { log, logWarn, logError, logGroup, logGroupEnd } from '../shared/utils/logger'
import { getSetting } from '../shared/db/settings-store'
import type { ApplyFilters } from '../shared/types/filters'
import { DEFAULT_FILTERS, parseSalaryRange } from '../shared/types/filters'
import type { JobCard, MatchResult } from '../shared/types/job'
import type { Resume } from '../shared/types/resume'

const MOD = 'ContentScript'

// ------ State ------
let isApplying = false
let runStopped = false
let currentMode: 'batch' | 'recommend' = 'recommend'
let panelHost: HTMLElement | null = null
let matchResults: Array<{
  title: string
  companyName: string
  score: number
  recommended: boolean
  scoreBypassed?: boolean
}> = []
let defaultResume: Resume | undefined = undefined
let currentFilters: ApplyFilters = { ...DEFAULT_FILTERS }
let lastRiskWarning = ''

// ------ Fetch full resume: try chrome.storage.local first, fallback to background ------
async function fetchFullResume(): Promise<Resume | undefined> {
  // Try chrome.storage.local first (fast, no message passing)
  const stored = await getSharedFullResume()
  if (stored) {
    log(MOD, 'fetchFullResume', `From chrome.storage: ${stored.name} (skills=${stored.structuredData?.skills?.length})`)
    // Reconstruct full Resume (fileData is not needed for AI matching)
    return { ...stored, fileData: new ArrayBuffer(0) } as Resume
  }

  // Fallback: ask background to read from IndexedDB
  log(MOD, 'fetchFullResume', 'chrome.storage empty, trying background...')
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'GET_DEFAULT_RESUME' }, (response) => {
      if (chrome.runtime.lastError) {
        logError(MOD, 'fetchFullResume', chrome.runtime.lastError.message)
        resolve(undefined)
        return
      }
      if (response?.success && response?.data) {
        log(MOD, 'fetchFullResume', `From background: ${response.data.name}`)
        resolve(response.data as Resume)
      } else {
        logWarn(MOD, 'fetchFullResume', 'Background returned no resume', response)
        resolve(undefined)
      }
    })
  })
}

// Pull the global "one-click apply defaults" from settings so the floating
// panel follows the user's configured mode (批量/推荐) and scoring preference
// instead of always defaulting to recommend + scoring.
async function loadApplyDefaultsFromSettings(): Promise<void> {
  try {
    const mode = await getSetting<'batch' | 'recommend'>('applyMode', 'batch')
    currentMode = mode === 'recommend' ? 'recommend' : 'batch'
    const enableAiMatch = await getSetting<boolean>('enableAiMatch', true)
    currentFilters = { ...currentFilters, enableAiMatch }
    log(MOD, 'loadApplyDefaultsFromSettings', `mode=${currentMode}, enableAiMatch=${enableAiMatch}`)
  } catch (e) {
    logWarn(MOD, 'loadApplyDefaultsFromSettings', 'Failed to load defaults, using built-ins', e)
  }
}

// ------ Initialization ------
async function init(): Promise<void> {
  logGroup(MOD, 'init')
  // 按网址自动识别平台（或按设置手动选择），后续所有解析/动作均通过该适配器执行。
  adapter = await getActivePlatform()
  setPlatformName(adapter.name)
  const pageType = adapter.detectPageType()
  log(MOD, 'init', `Platform: ${adapter.name} | Page type: ${pageType} | url: ${window.location.href}`)

  if (pageType === 'search' || pageType === 'recommend' || pageType === 'detail') {
    // Step 1: Quick check from chrome.storage.local — does a default resume exist?
    const summary = await getSharedResumeSummary()
    log(MOD, 'init', `Resume summary: ${summary ? `${summary.name} (id=${summary.id}, skills=${summary.skills.length})` : 'NOT FOUND'}`)

    // Always try the background fallback so resumes created by older versions
    // remain available even when the shared chrome.storage copy is missing.
    defaultResume = await fetchFullResume()

    // Apply the user's configured one-click defaults before showing the panel.
    await loadApplyDefaultsFromSettings()

    if (defaultResume) {
      log(MOD, 'init', `Resume loaded: ${defaultResume.name}`)
    } else {
      logWarn(MOD, 'init', 'NO resume found. User needs to upload in popup first.')
    }

    panelHost = createFloatingPanel()
    updatePanelContent(panelHost, {
      mode: currentMode,
      status: 'idle',
      filters: currentFilters,
    })
    log(MOD, 'init', 'Floating panel created')
  } else {
    log(MOD, 'init', `Skipping — page type "${pageType}" not supported`)
  }
  logGroupEnd()
}

// ------ Listen for popup messages ------
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'EXECUTE_APPLY') {
    const mode = message.payload?.mode || 'recommend'
    const filters = message.payload?.filters
    const pageType = adapter.detectPageType()
    // 只排除纯聊天页；首页、搜索、推荐、详情均可启动
    if (pageType === 'chat') {
      sendResponse({ success: false, error: '当前是聊天页面，请切换到岗位列表或推荐页' })
      return true
    }
    log(MOD, 'onMessage', `EXECUTE_APPLY from popup, mode: ${mode}`, filters ? `filters: ${JSON.stringify(filters)}` : 'no filters')
    startApply(mode, filters)
    sendResponse({ success: true })
  }
  if (message.type === 'EXECUTE_STOP') {
    log(MOD, 'onMessage', 'EXECUTE_STOP')
    stopApply()
    sendResponse({ success: true })
  }
  if (message.type === 'GET_PAGE_INFO') {
    const pageType = adapter.detectPageType()
    sendResponse({
      url: window.location.href,
      title: document.title,
      pageType,
      platformId: adapter.id,
      platformName: adapter.name,
    })
  }
  return true
})

// ------ Listen for panel UI messages ------
window.addEventListener('message', (event) => {
  if (event.source !== window) return

  const data = event.data
  if (data?.type === 'BOSS_ASSISTANT_START_APPLY') {
    log(MOD, 'panelMessage', `START_APPLY, mode: ${data.mode || currentMode}`)
    startApply(data.mode || currentMode, data.filters || currentFilters)
  }
  if (data?.type === 'BOSS_ASSISTANT_STOP_APPLY') {
    log(MOD, 'panelMessage', 'STOP_APPLY')
    stopApply()
  }
  if (data?.type === 'BOSS_ASSISTANT_CHANGE_MODE') {
    log(MOD, 'panelMessage', `CHANGE_MODE: ${data.mode}`)
    currentMode = data.mode
    updatePanelContent(panelHost!, {
      mode: currentMode,
      status: 'idle',
      filters: currentFilters,
    })
  }
  if (data?.type === 'BOSS_ASSISTANT_CHANGE_SCORING') {
    currentFilters = {
      ...currentFilters,
      enableAiMatch: data.enabled !== false,
    }
    updatePanelContent(panelHost!, {
      mode: currentMode,
      status: 'idle',
      filters: currentFilters,
    })
  }
})

// ------ Filter Logic ------
function filterJobs(jobs: JobCard[], filters: ApplyFilters): { passed: JobCard[]; skipped: number } {
  const passed: JobCard[] = []
  let skipped = 0

  const titleKeywords = filters.jobTitles.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const locationKeywords = filters.locations.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const excludeKeywords = filters.excludeKeywords.trim().toLowerCase().split(/\s+/).filter(Boolean)

  for (const job of jobs) {
    let skip = false

    if (!skip && titleKeywords.length > 0) {
      const jobTitleLower = job.title.toLowerCase()
      if (!titleKeywords.every(kw => jobTitleLower.includes(kw))) skip = true
    }

    if (!skip && locationKeywords.length > 0) {
      const locLower = (job.location || '').toLowerCase()
      if (!locationKeywords.some(kw => locLower.includes(kw))) skip = true
    }

    if (!skip && (filters.salaryMin !== null || filters.salaryMax !== null)) {
      const range = parseSalaryRange(job.salary)
      if (range) {
        const [jMin] = range
        if (filters.salaryMin !== null && jMin < filters.salaryMin) skip = true
        if (!skip && filters.salaryMax !== null && jMin > filters.salaryMax) skip = true
      }
    }

    if (!skip && filters.experience) {
      const expLower = (job.experience || '').toLowerCase()
      if (!expLower.includes(filters.experience.toLowerCase())) skip = true
    }

    if (!skip && filters.education) {
      const eduLower = (job.education || '').toLowerCase()
      if (!eduLower.includes(filters.education.toLowerCase())) skip = true
    }

    if (!skip && excludeKeywords.length > 0) {
      const targets = [job.companyName, job.title, job.jobDescription, ...job.tags].join(' ').toLowerCase()
      if (excludeKeywords.some(kw => targets.includes(kw))) skip = true
    }

    if (skip) {
      skipped++
    } else {
      passed.push(job)
    }
  }

  return { passed, skipped }
}

// ------ Apply Logic ------
async function startApply(mode: 'batch' | 'recommend', filters?: ApplyFilters): Promise<void> {
  if (isApplying) {
    log(MOD, 'startApply', 'Ignored — already applying')
    return
  }
  isApplying = true
  runStopped = false
  currentMode = mode
  filters = { ...currentFilters, ...filters }
  currentFilters = filters
  lastRiskWarning = ''
  if (!panelHost?.isConnected) panelHost = createFloatingPanel()
  updatePanelContent(panelHost, {
    mode: currentMode,
    status: 'scanning',
    message: '已收到启动指令，正在读取简历并扫描岗位…',
    filters,
  })

  logGroup(MOD, 'startApply')
  log(MOD, 'startApply', `Mode: ${mode} | hasResume: ${!!defaultResume}`)

  // Check resume — re-fetch from shared state if needed
  if (!defaultResume) {
    const summary = await getSharedResumeSummary()
    log(MOD, 'startApply', `Re-checking resume: ${summary ? 'FOUND' : 'NOT FOUND'}`)
    defaultResume = await fetchFullResume()
  }

  if (!defaultResume) {
    const msg = '请先在插件中上传并设置默认简历\n\n打开扩展 → 简历管理 → 上传简历'
    logWarn(MOD, 'startApply', 'BLOCKED: no default resume')
    showPanelToast(panelHost!, msg, 'warning')
    isApplying = false
    logGroupEnd()
    return
  }

  log(MOD, 'startApply', `Resume: ${defaultResume.name} (skills=${defaultResume.structuredData?.skills?.length})`)

  // 读取用户配置的「单次扫描数量」。<=0 表示不限制（扫描到页面无更多为止）。
  const maxScanCount = await getSetting<number>('maxScanCount', 50)
  const maxJobs = maxScanCount > 0 ? maxScanCount : undefined
  log(MOD, 'startApply', `Max scan count: ${maxJobs ?? 'unlimited'}`)

  // BOSS initially renders only a small first batch. Scroll and keep collecting
  // newly loaded cards before filtering/matching them.
  const allJobs = await adapter.collectJobCards(adapter.parseJobCardsFromSearchPage, {
    maxJobs,
    onCountChange: (count) => {
      updatePanelContent(panelHost!, {
        mode: currentMode,
        status: 'scanning',
        message: `正在下滑加载更多岗位，已发现 ${count} 个…`,
        filters,
      })
    },
    // 用户在「扫描」阶段点击「停止」时立即中止采集。
    shouldCancel: () => !isApplying,
  })
  log(MOD, 'startApply', `Parsed ${allJobs.length} job cards`)

  if (allJobs.length === 0) {
    log(MOD, 'startApply', 'No job cards found on page')
    updatePanelContent(panelHost!, {
      mode: currentMode,
      status: 'idle',
      message: '未找到岗位卡片，请确保在招聘平台搜索页或推荐页',
      filters,
    })
    isApplying = false
    logGroupEnd()
    return
  }

  // Apply filters
  let jobs = allJobs
  if (filters) {
    const result = filterJobs(allJobs, filters)
    jobs = result.passed
    log(MOD, 'startApply', `Filters: ${jobs.length} passed / ${result.skipped} filtered (total ${allJobs.length})`)
  }

  if (jobs.length === 0) {
    log(MOD, 'startApply', `All ${allJobs.length} jobs filtered out`)
    updatePanelContent(panelHost!, {
      mode: currentMode,
      status: 'idle',
      message: `找到 ${allJobs.length} 个岗位，但均不符合筛选条件`,
      filters,
    })
    showPanelToast(panelHost!, '没有符合筛选条件的岗位', 'warning')
    isApplying = false
    logGroupEnd()
    return
  }

  // Get already-applied job IDs from shared storage
  const appliedJobIds = await getSharedAppliedJobIds()
  log(MOD, 'startApply', `Already applied: ${appliedJobIds.length} jobs`)

  updatePanelContent(panelHost!, {
    mode: currentMode,
    stats: { total: jobs.length, processed: 0, matched: 0 },
    status: 'matching',
    message: filters?.enableAiMatch === false
      ? `筛选后 ${jobs.length} 个岗位，准备沟通...`
      : `筛选后 ${jobs.length} 个岗位，开始匹配分析...`,
    filters,
  })

  matchResults = []
  let matchedCount = 0
  let appliedCount = 0
  let processedCount = 0

  for (const job of jobs) {
    if (!isApplying) break

    // Check risk. Most signals are non-fatal (just warn), but a `block`
    // (account anomaly OR daily communication cap) is fatal — we must stop
    // the whole run, otherwise we keep hammering a wall and risk the account.
    const risk = scanRisk(adapter.getRiskConfig())
    if (risk) {
      if (risk.type === 'block') {
        showPanelToast(panelHost!, risk.message, 'error')
        logWarn(MOD, 'startApply', `Fatal risk — stopping run: ${risk.message}`)
        isApplying = false
        logGroupEnd()
        return
      }
      if (risk.message !== lastRiskWarning) {
        lastRiskWarning = risk.message
        showPanelToast(panelHost!, risk.message, 'warning')
      }
      log(MOD, 'startApply', `Risk signal (ignored, continuing): ${risk.message}`)
      continue
    }

    // Check if already applied (via shared storage)
    if (appliedJobIds.includes(job.id)) {
      processedCount++
      log(MOD, 'startApply', `Skip (already applied): ${job.title}`)
      continue
    }

    // Check daily limit before processing this job
    const limitCheck = await checkDailyLimit()
    if (!limitCheck.allowed) {
      showPanelToast(panelHost!, `今日投递次数已达上限，剩余 ${limitCheck.remaining} 次`, 'warning')
      logWarn(MOD, 'startApply', `Daily limit reached — stopping run (${limitCheck.remaining} remaining)`)
      break
    }

    const scoreBypassed = filters?.enableAiMatch === false
    let evaluatedMatch: MatchResult
    if (scoreBypassed) {
      log(MOD, 'startApply', `Direct apply without scoring: ${job.title} @ ${job.companyName}`)
      evaluatedMatch = {
        jobId: job.id,
        score: 0,
        scoreBypassed: true,
        skillMatch: [],
        skillGap: [],
        recommendation: '未启用匹配评分（直接沟通）',
        isRecommended: true,
      }
    } else {
      log(MOD, 'startApply', `Matching: ${job.title} @ ${job.companyName} (${job.salary})`)
      const match = await matchResumeToJob(defaultResume, job)
      const isRecommended = filters
        ? match.score >= filters.minMatchScore
        : match.isRecommended
      evaluatedMatch = { ...match, isRecommended }
    }
    processedCount++
    matchResults.push({
      title: job.title,
      companyName: job.companyName,
      score: evaluatedMatch.score,
      recommended: evaluatedMatch.isRecommended,
      scoreBypassed,
    })

    if (evaluatedMatch.isRecommended) matchedCount++

    updatePanelContent(panelHost!, {
      mode: currentMode,
      stats: { total: jobs.length, processed: processedCount, matched: matchedCount },
      status: 'matching',
      matchResults,
      message: scoreBypassed
        ? `筛选通过: ${job.title}`
        : `分析: ${job.title} — ${evaluatedMatch.score}分 ${evaluatedMatch.isRecommended ? '✓推荐' : '×跳过'}`,
      filters: currentFilters,
    })

    // Apply if batch mode + recommended
    if (currentMode === 'batch' && evaluatedMatch.isRecommended) {
      const applied = await applyToJob(job, evaluatedMatch)
      if (applied) {
        appliedCount++
        await incrementCounter()
      }
    }

    // Delay between processing
    await randomDelay(500, 1500)
  }

  log(MOD, 'startApply', `Done: ${matchedCount} matched / ${processedCount} processed / ${jobs.length} total`)
  // When the UI says the run is complete, a new run must be accepted immediately.
  isApplying = false
  const finishedByStop = runStopped
  updatePanelContent(panelHost!, {
    mode: currentMode,
    stats: { total: jobs.length, processed: processedCount, matched: matchedCount },
    status: finishedByStop ? 'pause' : 'done',
    matchResults,
    message: finishedByStop
      ? '已停止沟通'
      : (currentMode === 'batch'
          ? `沟通完成！成功 ${appliedCount}/${processedCount} 个岗位`
          : currentFilters.enableAiMatch
            ? `分析完成！发现 ${matchedCount} 个匹配岗位`
            : `筛选完成！共 ${matchedCount} 个岗位可直投`),
    filters: currentFilters,
  })

  if (currentMode === 'batch') {
    showPanelToast(
      panelHost!,
      appliedCount > 0 ? `沟通完成！成功 ${appliedCount} 个` : '未完成任何沟通，请检查岗位页面',
      appliedCount > 0 ? 'success' : 'warning',
    )
  }
  // 通知 popup「本次运行已结束」，使其复位「停止」按钮状态。
  try {
    chrome.runtime.sendMessage({ type: 'APPLY_ENDED', stopped: finishedByStop })
  } catch {
    // popup 未打开时忽略
  }
  logGroupEnd()
}

async function applyToJob(job: JobCard, match: MatchResult): Promise<boolean> {
  log(MOD, 'applyToJob', `Applying: ${job.title} @ ${job.companyName} (score=${match.score})`)

  updatePanelContent(panelHost!, {
    mode: currentMode,
    status: 'applying',
    message: `正在沟通：${job.title} @ ${job.companyName}`,
    filters: currentFilters,
  })

  const jobDetail = await adapter.activateJobCard(job.url, job.id, job.title, job.companyName)
  if (!jobDetail) {
    logWarn(MOD, 'applyToJob', `Could not activate job detail: ${job.title}`)
    return false
  }

  // Backfill the full job description from the opened detail view so it gets
  // persisted and exported. The JD block often renders a touch after the apply
  // button, so give it a beat before reading.
  await new Promise((r) => setTimeout(r, 350))
  const fullDesc = adapter.extractJobDescriptionFromDetail(jobDetail)
  if (fullDesc && fullDesc.length > (job.jobDescription || '').length) {
    job.jobDescription = fullDesc
  }

  // Click apply button
  const communicationUiBeforeClick = adapter.snapshotCommunicationUi()
  const applied = await adapter.clickApplyButton(jobDetail)
  if (applied) {
    // Fill greeting message
    const name = defaultResume?.structuredData?.name || '求职者'
    const greeting = adapter.getJobSpecificGreeting(name, job, match)
    const greetingSent = await adapter.fillGreetingMessage(greeting, communicationUiBeforeClick)
    if (!greetingSent) {
      logWarn(MOD, 'applyToJob', `Greeting was not sent: ${job.title}`)
      return false
    }
    await randomDelay(500, 1000)

    const saved = await saveApplication(job, match)
    if (!saved) {
      logWarn(MOD, 'applyToJob', `Application was sent but could not be persisted: ${job.title}`)
      return false
    }

    // Track as applied (chrome.storage.local — accessible cross-context)
    await addSharedAppliedJobId(job.id)
    log(MOD, 'applyToJob', `Applied & tracked: ${job.title} @ ${job.companyName}`)
    return true
  } else {
    logWarn(MOD, 'applyToJob', `Apply button not found: ${job.title}`)
    return false
  }
}

async function saveApplication(job: JobCard, match: MatchResult): Promise<boolean> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({
      type: 'SAVE_APPLICATION',
      payload: {
        job,
        match,
        resumeId: defaultResume?.id || '',
        platformId: adapter?.id || 'unknown',
      },
    }, (response) => {
      if (chrome.runtime.lastError) {
        logError(MOD, 'saveApplication', chrome.runtime.lastError.message)
        resolve(false)
        return
      }
      resolve(response?.success === true)
    })
  })
}

function stopApply(): void {
  if (!isApplying) return
  isApplying = false
  runStopped = true
  log(MOD, 'stopApply', 'Stopped by user')
  if (panelHost) {
    updatePanelContent(panelHost!, {
      mode: currentMode,
      status: 'pause',
      message: '已停止沟通',
      filters: currentFilters,
    })
    showPanelToast(panelHost!, '已停止', 'warning')
  }
}

// ------ Start ------
log(MOD, 'bootstrap', 'Content script loaded — running init()')
init()
