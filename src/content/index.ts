// Content script entry point - injected into Boss Zhipin pages
import { getActivePlatform } from '../shared/platform'
import type { PlatformAdapter } from '../shared/platform/types'
import { resolvePanelPresence } from '../shared/assistant-entry'
import { executeCampaignTask } from './task-runner'
import { appendTasksToCampaign } from '../shared/agent/queue-store'
import {
  collectApplyPageTexts,
  decideApplyVerification,
  hasNewCommunicationUi,
  isChatPageUrl,
  type ApplyVerification,
} from '../shared/agent/apply-verification'
import { setPlatformName } from './inject-ui'
import { setLiepinResumeMode, fetchJobDetailDescription, prefilterLiepinJob } from '../shared/platform/liepin'
import {
  getChatContacts,
  clickContact,
  hasResumeSentInChat,
  clickSendResume,
  selectAndSendResume,
  closeChatDialog,
  getLastHrMessageFromChat,
  fillChatInputAndSend,
} from '../shared/platform/boss'
import { generateHrReplyCopilot } from '../shared/ai/hr-copilot'
import { getCandidatePreferences } from '../shared/db/settings-store'

// 当前活动平台适配器（由 PlatformManager 按网址自动识别，或按设置手动覆盖）。
let adapter: PlatformAdapter
import { createFloatingPanel, updatePanelContent, showPanelToast, setPanelState, setPinned, type ChatCopilotData } from './inject-ui'
import {
  DEFAULT_ASSISTANT_STATE,
  getAssistantState,
  isAssistantTaskCancelled,
  normalizeInitialPanelState,
  patchAssistantState,
  subscribeAssistantState,
  type AssistantControlState,
  type PanelState,
} from '../shared/assistant-state'
import { randomDelay, scanRisk, checkDailyLimit, incrementCounter } from '../shared/antiBot'
import { matchResumeToJob, assessJobRelevance } from '../shared/ai'
import { recordOutcomeEvent } from '../shared/db/outcome-store'
import { reactLoop } from '../shared/agent'
import { transition, recordMachineTransition, saveApplyRun, clearApplyRun, type ApplyState, type ApplyEvent } from '../shared/agent/apply-state-machine'
import { getSharedResumeSummary, getSharedFullResume, getSharedAppliedJobIds, addSharedAppliedJobId } from '../shared/db/shared-state'
import { log, logWarn, logError, logGroup, logGroupEnd } from '../shared/utils/logger'
import { getSetting } from '../shared/db/settings-store'
import { CONSERVATIVE_VALUES } from '../shared/types/safety-preset'
import type { ApplyFilters } from '../shared/types/filters'
import { DEFAULT_FILTERS, parseSalaryRange } from '../shared/types/filters'
import type { JobCard, MatchResult } from '../shared/types/job'
import type { Resume } from '../shared/types/resume'
import {
  extractTargetCareers,
  evaluateJobCandidate,
  isJobMatchingCareer,
  isJobMatchingFreshness,
} from '../shared/agent/job-filter'
import { getBlacklist } from '../shared/db/blacklist-store'
import { getRuntimeState, reportBatchProgress } from '../shared/runtime-state'

const MOD = 'ContentScript'

/**
 * 半自动批量沟通结束：先落最终进度，再释放 manual 互斥锁。
 * 两处释放（这里 + popup 收到 APPLY_ENDED 时）幂等，不会误清对方的锁。
 */
async function endManualRun(
  patch: Parameters<typeof reportBatchProgress>[0],
  stopped = false,
): Promise<void> {
  try {
    await reportBatchProgress({ status: 'done', ...patch })
  } catch { /* 进度上报失败不影响主链路 */ }
  // 所有出口（含无简历 / 无岗位 / 风控中断等提前 return）都统一通知 popup，
  // 避免「停止」按钮卡在运行态；两处释放锁幂等。
  try {
    await chrome.runtime.sendMessage({ type: 'RUNTIME_RELEASE', payload: { mode: 'manual' } })
  } catch { /* popup 未打开时忽略 */ }
  try {
    void chrome.runtime.sendMessage({ type: 'APPLY_ENDED', stopped }).catch(() => {})
  } catch { /* 预期内异常，安全忽略 */ }
}

// ------ State ------
let isApplying = false
let runStopped = false
let assistantState: AssistantControlState = DEFAULT_ASSISTANT_STATE
let campaignTaskCancelled = false

// Content 侧全局未捕获异常上报至 Background
if (typeof window !== 'undefined') {
  window.addEventListener('error', (e) => {
    try {
      chrome.runtime.sendMessage({
        type: 'RECORD_ERROR',
        payload: {
          source: 'content.window',
          message: e.message || String(e.error?.message ?? e.error ?? 'unknown'),
          stack: e.error?.stack,
          context: window.location.href,
        },
      })
    } catch { /* 预期内异常，安全忽略 */ }
  })
}
let currentMode: 'batch' | 'recommend' = 'recommend'
let panelHost: HTMLElement | null = null
let matchResults: Array<{
  title: string
  companyName: string
  score: number
  recommended: boolean
  scoreBypassed?: boolean
  /** 猎聘两阶段：未通过卡片粗筛（分数为粗筛分，未做 AI 精评） */
  prefiltered?: boolean
}> = []
let defaultResume: Resume | undefined = undefined
let currentFilters: ApplyFilters = { ...DEFAULT_FILTERS }
let lastRiskWarning = ''
let liepinResumeMode = false

// E3：权限确认桥（content 侧持有，reactLoop 的 onConfirm 等待用户点击）
let confirmBridge: { desc: string; resolve: (decision: boolean) => void } | null = null

/** 发起一次用户确认：渲染确认卡片并等待用户决策（超时 30s 默认拒绝） */
function requestUserConfirm(desc: string): Promise<boolean> {
  if (!panelHost) return Promise.resolve(false)
  return new Promise((resolve) => {
    confirmBridge = { desc, resolve }
    updatePanelContent(panelHost!, {
      mode: currentMode,
      status: 'pause',
      message: '等待确认...',
      filters: currentFilters, resumeMode: liepinResumeMode,
      confirmRequest: { desc },
    })
    // 30 秒未操作视为拒绝，避免流程卡死
    setTimeout(() => {
      if (confirmBridge) {
        const bridge = confirmBridge
        confirmBridge = null
        updatePanelContent(panelHost!, {
          mode: currentMode,
          status: 'applying',
          message: '⏸ 确认超时，已跳过该动作',
          filters: currentFilters, resumeMode: liepinResumeMode,
          confirmRequest: null,
        })
        bridge.resolve(false)
      }
    }, 30_000)
  })
}

function settleConfirm(decision: boolean): void {
  const bridge = confirmBridge
  if (!bridge) return
  confirmBridge = null
  updatePanelContent(panelHost!, {
    mode: currentMode,
    status: 'applying',
    message: decision ? '✅ 已确认，继续执行' : '✖ 已取消该动作',
    filters: currentFilters, resumeMode: liepinResumeMode,
    confirmRequest: null,
  })
  bridge.resolve(decision)
}

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

/** 把统一控制状态同步到 content 本地变量与浮窗形态 */
function syncFromAssistantState(state: AssistantControlState): void {
  // bot 重新展开/收缩即视为再次启动，解除上一轮的取消标记
  const reopened = assistantState.panelState === 'closed' && state.panelState !== 'closed'
  assistantState = state
  if (reopened) campaignTaskCancelled = false
  currentMode = state.applyMode === 'recommend' ? 'recommend' : 'batch'
  currentFilters = { ...currentFilters, enableAiMatch: state.enableAiMatch }
  liepinResumeMode = state.liepinResumeMode
  setLiepinResumeMode(liepinResumeMode)
  if (panelHost) {
    setPanelState(panelHost, state.panelState)
    setPinned(panelHost, state.pinned)
  }
}

/** 写统一控制状态（后台负责广播给 popup / 其他 tab） */
function writeAssistantState(patch: Partial<AssistantControlState>): void {
  // 直接写 storage 单一真源，避免经 background 消息往返产生竞态
  // （例如关闭后立刻点恢复入口，旧值可能覆盖新值）
  void patchAssistantState(patch).catch(() => {})
}

/** 关闭浮窗 = 关闭 bot：立即中止本地链路并通知后台终止流水线 */
/** 关闭动作在本地立即生效，不等 storage.onChanged 回传，避免关闭后仍有任务被派发执行 */
function markAssistantShutdown(): void {
  campaignTaskCancelled = true
  isApplying = false
  runStopped = true
  assistantState = { ...assistantState, panelState: 'closed' }
}

function shutdownAssistantFromPanel(): void {
  markAssistantShutdown()
  if (panelHost) setPanelState(panelHost, 'closed')
  try {
    Promise.resolve(
      chrome.runtime.sendMessage({ type: 'ASSISTANT_CONTROL', payload: { action: 'shutdown' } }),
    ).catch(() => {})
  } catch { /* 预期内异常，安全忽略 */ }
}

/**
 * 点击扩展图标：展开侧栏 ⇄ 收起为浮球。
 * ensureExpanded=true 时只展开不切换，供「去招聘网站展开侧栏」的兜底路径使用：
 * 此时 background 已写入 expanded，若再 toggle 反而会把侧栏收成浮球。
 * 非招聘页（init 因 pageType 不支持而跳过）也会兜底创建面板。
 */
async function toggleAssistantPanelPresence(ensureExpanded = false): Promise<void> {
  if (!adapter) adapter = await getActivePlatform()
  if (!panelHost?.isConnected) {
    panelHost = createFloatingPanel()
    const pageType = adapter.detectPageType()
    updatePanelContent(panelHost, {
      mode: currentMode,
      status: 'idle',
      filters: currentFilters,
      resumeMode: liepinResumeMode,
      pageType,
      isChatPage: pageType === 'chat',
    })
  }
  const next: PanelState = resolvePanelPresence(assistantState.panelState, ensureExpanded)
  setPanelState(panelHost, next)
  writeAssistantState({ panelState: next })
}

// ------ Initialization ------
async function init(): Promise<void> {
  logGroup(MOD, 'init')
  // 按网址自动识别平台（或按设置手动选择），后续所有解析/动作均通过该适配器执行。
  adapter = await getActivePlatform()
  setPlatformName(adapter.name)
  const pageType = adapter.detectPageType()
  log(MOD, 'init', `Platform: ${adapter.name} | Page type: ${pageType} | url: ${window.location.href}`)

  if (pageType === 'search' || pageType === 'recommend' || pageType === 'detail' || pageType === 'chat') {
    // Step 1: Quick check from chrome.storage.local — does a default resume exist?
    const summary = await getSharedResumeSummary()
    log(MOD, 'init', `Resume summary: ${summary ? `${summary.name} (id=${summary.id}, skills=${summary.skills.length})` : 'NOT FOUND'}`)

    // Always try the background fallback so resumes created by older versions
    // remain available even when the shared chrome.storage copy is missing.
    defaultResume = await fetchFullResume()

    // Apply the user's configured one-click defaults before showing the panel.
    await loadApplyDefaultsFromSettings()
    const storedState = await getAssistantState()
    assistantState = normalizeInitialPanelState(storedState)
    if (assistantState.panelState === 'expanded' && storedState.panelState !== 'expanded') {
      // 上次「关闭 / 收起浮球」不应让本次打开页面继续隐藏；同步写回，配置页也会跟着恢复
      await patchAssistantState({ panelState: 'expanded' }).catch(() => {})
    }

    if (defaultResume) {
      log(MOD, 'init', `Resume loaded: ${defaultResume.name}`)
    } else {
      logWarn(MOD, 'init', 'NO resume found. User needs to upload in popup first.')
    }

    panelHost = createFloatingPanel()
    subscribeAssistantState(syncFromAssistantState)
    syncFromAssistantState(assistantState)
    const initPageType = adapter.detectPageType()
    updatePanelContent(panelHost, {
      mode: currentMode,
      status: 'idle',
      filters: currentFilters, resumeMode: liepinResumeMode,
      pageType: initPageType,
      isChatPage: initPageType === 'chat',
    })
    log(MOD, 'init', 'Floating panel created')

    if (initPageType === 'chat') {
      startChatCopilotObserver()
    }
  } else {
    log(MOD, 'init', `Skipping — page type "${pageType}" not supported`)
  }
  logGroupEnd()
}

// ------ Listen for popup messages ------
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  // 点击扩展图标：展开侧栏 ⇄ 收起为浮球
  if (message.type === 'TOGGLE_ASSISTANT_PANEL') {
    const ensureExpanded = message.payload?.ensureExpanded === true
    log(MOD, 'onMessage', `TOGGLE_ASSISTANT_PANEL ensureExpanded=${ensureExpanded}`)
    void toggleAssistantPanelPresence(ensureExpanded).catch(() => {})
    sendResponse({ success: true })
    return true
  }
  if (message.type === 'EXECUTE_APPLY') {
    const mode = message.payload?.mode || currentMode
    const filters = message.payload?.filters
    ;(async () => {
      const pageType = adapter.detectPageType()
      // 只排除纯聊天页；首页、搜索、推荐、详情均可启动
      if (pageType === 'chat') {
        sendResponse({ success: false, error: '当前是聊天页面，请切换到岗位列表或推荐页' })
        return
      }
      // 互斥二次校验：popup 已在 background 申请 manual 锁，这里兜住外部 AI / 旧客户端
      // 绕过 UI 直接派发的情况。只拦截「全自动正在跑」的真实冲突，不强制要求持锁，
      // 以兼容网页浮窗旧入口与 E2E 直接派发。
      const rt = await getRuntimeState().catch(() => null)
      if (rt?.mode === 'autopilot') {
        sendResponse({ success: false, error: 'AIbot 全自动正在运行，请先终止后再开始半自动沟通' })
        return
      }
      log(MOD, 'onMessage', `EXECUTE_APPLY from popup, mode: ${mode}`, filters ? `filters: ${JSON.stringify(filters)}` : 'no filters')
      startApply(mode, filters)
      sendResponse({ success: true })
    })().catch(() => sendResponse({ success: false, error: '运行状态校验失败，请重试' }))
    return true
  }
  if (message.type === 'EXECUTE_SEND_RESUMES') {
    log(MOD, 'onMessage', 'EXECUTE_SEND_RESUMES from popup')
    sendResumesOnChatPage()
    sendResponse({ success: true })
  }
  if (message.type === 'EXECUTE_STOP') {
    log(MOD, 'onMessage', 'EXECUTE_STOP')
    stopApply()
    sendResponse({ success: true })
  }
  if (message.type === 'ASSISTANT_CANCEL') {
    // 关闭 bot 的广播：中止当前任务，也停掉老链路的主循环
    log(MOD, 'onMessage', 'ASSISTANT_CANCEL')
    markAssistantShutdown()
    sendResponse({ success: true })
  }
  if (message.type === 'EXECUTE_CAMPAIGN_TASK') {
    const task = message.payload?.task
    ;(async () => {
      if (!adapter) adapter = await getActivePlatform()
      if (!defaultResume) defaultResume = await fetchFullResume()
      if (!defaultResume) {
        sendResponse({
          taskId: task?.id,
          status: 'failed',
          failReason: '未找到默认简历，请在扩展中上传设置',
        })
        return
      }
      if (!panelHost?.isConnected) panelHost = createFloatingPanel()
      // 自愈清理可能隐藏浮窗，每个任务开始时按统一状态恢复形态
      setPanelState(panelHost!, assistantState.panelState)
      if (assistantState.panelState === 'closed') {
        sendResponse({ taskId: task?.id, status: 'failed', failReason: 'AIbot 已关闭' })
        return
      }
      // 互斥二次校验：概览半自动正在跑时，绝不执行全自动投递任务（防抢同一页面 DOM）
      const rt = await getRuntimeState().catch(() => null)
      if (rt?.mode === 'manual') {
        sendResponse({
          taskId: task?.id,
          status: 'failed',
          failReason: '概览半自动批量沟通正在运行，AIbot 任务已跳过（互斥保护）',
        })
        return
      }
      campaignTaskCancelled = false
      const result = await executeCampaignTask(task, adapter, defaultResume, {
        shouldCancel: () => isAssistantTaskCancelled(assistantState, campaignTaskCancelled),
        onProgress: (msg) => {
          updatePanelContent(panelHost!, {
            mode: currentMode,
            status: 'applying',
            message: `🤖 [AI流水线] ${msg}`,
            filters: currentFilters,
            resumeMode: liepinResumeMode,
          })
        },
      })
      sendResponse(result)
    })().catch((err) => {
      try {
        chrome.runtime.sendMessage({
          type: 'RECORD_ERROR',
          payload: {
            source: 'content.campaign_task',
            message: `执行任务未捕获异常: ${String(err)}`,
            stack: err instanceof Error ? err.stack : undefined,
            context: JSON.stringify({ taskId: task?.id, url: window.location.href }),
          },
        })
      } catch { /* 预期内异常，安全忽略 */ }
      sendResponse({
        taskId: task?.id,
        status: 'failed',
        failReason: String(err),
      })
    })
    return true
  }
  if (message.type === 'COLLECT_PLATFORM_JOBS') {
    const maxJobs = message.payload?.maxJobs || 25
    const existingJobIdsList: string[] = message.payload?.existingJobIds || []
    const excludeJobIds = new Set<string>(existingJobIdsList)

    ;(async () => {
      if (!adapter) adapter = await getActivePlatform()

      // 等待页面职位卡片渲染（最多等待 8 秒）
      for (let attempt = 0; attempt < 16; attempt++) {
        const preview = adapter.parseJobCardsFromSearchPage()
        if (preview.length > 0) break
        await new Promise((r) => setTimeout(r, 500))
      }

      // 提取目标职业清单与筛选配置
      const defaultResume = await fetchFullResume()
      const effectiveFilters: ApplyFilters = message.payload?.filters || currentFilters
      const targetCareers: string[] =
        message.payload?.relaxCareerFilter === true
          ? []
          : message.payload?.targetCareers && message.payload.targetCareers.length > 0
            ? message.payload.targetCareers
            : extractTargetCareers(defaultResume, effectiveFilters)

      let blacklistSet = new Set<string>()
      try {
        const bl = await getBlacklist()
        blacklistSet = new Set(bl.map((b) => b.companyName.trim()))
      } catch {
        // 忽略黑名单读取失败
      }

      const careerLabel = targetCareers.length > 0 ? targetCareers.join(' / ') : '全量职业'
      const freshnessLabel =
        effectiveFilters.publishTime === 'today'
          ? '今日活跃'
          : effectiveFilters.publishTime === '3days'
          ? '3日内活跃'
          : effectiveFilters.publishTime === 'month'
          ? '本月活跃'
          : effectiveFilters.publishTime === 'all'
          ? '不限时间'
          : '本周活跃'

      if (!panelHost?.isConnected) panelHost = createFloatingPanel()
      updatePanelContent(panelHost!, {
        mode: currentMode,
        status: 'scanning',
        message: `🤖 AIbot 正在按【${careerLabel} · ${freshnessLabel}】精准扫描最新职位入队…`,
        filters: effectiveFilters,
        resumeMode: liepinResumeMode,
      })

      const rawJobs = await adapter.collectJobCards(adapter.parseJobCardsFromSearchPage, {
        maxJobs: maxJobs * 2,
        excludeJobIds,
        onCountChange: (count) => {
          updatePanelContent(panelHost!, {
            mode: currentMode,
            status: 'scanning',
            message: `🤖 AIbot 正在扫描推荐流，已初筛 ${count} 个岗位卡片…`,
            filters: effectiveFilters,
            resumeMode: liepinResumeMode,
          })
        },
      })

      // 本页实际渲染出的卡片总数（含已投递过的），用于判断“这一页是否已经挖干净、该翻页了”
      const pageCardTotal = adapter.parseJobCardsFromSearchPage().length
      const excludedOnPage = Math.max(0, pageCardTotal - rawJobs.length)

      // 采集有效性校验：这批卡片里有没有与当前搜索关键词相关的岗位。
      // 全部不相关往往意味着搜索没生效（被重定向到推荐流 / 未登录降级），
      // 此时继续过滤只会一直空转，必须让调度层知道。
      const searchKeyword = String(message.payload?.keyword || '').trim()
      const keywordHits = searchKeyword
        ? rawJobs.filter((j) => `${j.title} ${(j.tags || []).join(' ')}`.includes(searchKeyword)).length
        : -1

      // L2 过程自检：字符串命中不等于真的相关。
      // 精投模式让 AI 一次性审阅整页标题，识别「PHP技术支持」这类含词但不对口的岗位，
      // 以及「后端开发」搜出「PHP开发工程师」这类不同字但同义的好岗位。
      // 海投（极速）/ 未启用 AI 时只跑本地语义，不消耗 AI 预算。
      const [aiEnabledForRelevance, fastModeForRelevance] = await Promise.all([
        getSetting<boolean>('aiEnabled', false),
        getSetting<boolean>('aibotFastMode', false),
      ])
      const relevanceInput = {
        keyword: searchKeyword,
        targetCareers,
        jobs: rawJobs,
        platform: adapter.id,
      }
      // 没有搜索关键词时不发 AI 判定：模型在「目标方向未指定」下会把整页都判成不相关
      let relevance = await assessJobRelevance(relevanceInput, {
        useAi: !!searchKeyword && aiEnabledForRelevance && !fastModeForRelevance,
      })
      // 模型自己给的置信度过低时不采信，退回本地语义结论，避免误杀一整页好岗位
      if (relevance.source === 'ai' && relevance.confidence < 0.6) {
        relevance = await assessJobRelevance(relevanceInput, { useAi: false })
      }
      // 只有高置信度的 AI 结论才有权把岗位从队列里剔掉；
      // 本地语义判定只用于统计与提示，绝不单方面否决岗位。
      const aiRelevanceGate = relevance.source === 'ai' && relevance.confidence >= 0.6
      const irrelevantJobIds = new Set(relevance.irrelevantJobIds)

      // 对采集到的卡片进行过滤。
      // 关键策略：只有「硬条件」（黑名单、无关行业、时间/薪资等）才直接丢弃；
      // 「职业方向不匹配」降级为软过滤 —— 先记下来，严格通过的不够时再用它补足名额。
      // 否则方向白名单会一刀切掉 80%+ 的候选，AI 匹配分根本没机会参与判断，
      // 表现为「抓了 60 个岗位却只入队 1 个」的长期空转。
      const filteredJobs: JobCard[] = []
      const softMatchedJobs: JobCard[] = []
      let filteredByCareer = 0
      let filteredByTime = 0
      let filteredByBlacklist = 0
      let filteredByRelevance = 0

      for (const job of rawJobs) {
        // AI 语义复核判定为「不是这个方向的岗位」→ 直接丢弃，不再进队列浪费投递额度
        if (aiRelevanceGate && irrelevantJobIds.has(job.id)) {
          filteredByRelevance++
          continue
        }
        const evalRes = evaluateJobCandidate(job, {
          filters: effectiveFilters,
          targetCareers,
          blacklist: blacklistSet,
        })
        if (!evalRes.pass) {
          if (evalRes.reason?.includes('职业方向')) {
            filteredByCareer++
            if (evalRes.soft) {
              softMatchedJobs.push(job)
            }
          } else if (evalRes.reason?.includes('活跃度') || evalRes.reason?.includes('时间')) filteredByTime++
          else if (evalRes.reason?.includes('黑名单')) filteredByBlacklist++
          continue
        }
        filteredJobs.push(job)
        if (filteredJobs.length >= maxJobs) break
      }

      // 严格通过的不够时，用「方向不匹配但其他硬条件都合格」的岗位补足名额，
      // 最终是否投递仍由 AI 匹配分决定（不相关岗位会被低分自然淘汰）。
      if (filteredJobs.length < maxJobs && softMatchedJobs.length > 0) {
        for (const job of softMatchedJobs) {
          if (filteredJobs.length >= maxJobs) break
          filteredJobs.push(job)
        }
      }

      const tasks = filteredJobs.map((j) => ({
        id: `${adapter.id}:${j.id}`,
        platform: adapter.id as any,
        jobId: j.id,
        jobTitle: j.title,
        company: j.companyName,
        jobUrl: j.url,
        salary: j.salary,
        location: j.location,
        experience: j.experience,
        education: j.education,
        tags: j.tags,
        bossName: j.bossName,
        bossTitle: j.bossTitle,
        // L3 结果复盘：把「这条岗位是哪个搜索方向找来的」带进任务，
        // 投递成功后才能按方向统计真实回复率，而不是只按岗位名事后瞎猜。
        searchKeyword: searchKeyword || undefined,
      }))
      const added = await appendTasksToCampaign(tasks)
      sendResponse({
        success: true,
        collected: rawJobs.length,
        added,
        filteredByCareer,
        filteredByTime,
        filteredByBlacklist,
        filteredByRelevance,
        pageCardTotal,
        excludedOnPage,
        keywordHits,
        relevantHits: searchKeyword ? relevance.hits : -1,
        relevanceSource: relevance.source,
        relevanceConfidence: relevance.confidence,
        relevanceReason: relevance.reason,
      })
    })().catch((err) => {
      sendResponse({ success: false, error: String(err) })
    })
    return true
  }
  // 页面级登录态探测：cookie 名被平台改名后，用真实渲染结果复核一次
  if (message.type === 'CHECK_PLATFORM_LOGIN') {
    ;(async () => {
      try {
        if (!adapter) adapter = await getActivePlatform()
        const state = adapter?.detectLoginState?.() ?? 'unknown'
        sendResponse({ success: true, state, platform: adapter?.id ?? null })
      } catch (err) {
        sendResponse({ success: false, state: 'unknown', error: String(err) })
      }
    })()
    return true
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
  if (data?.type === 'BOSS_ASSISTANT_CONFIRM') {
    log(MOD, 'panelMessage', `CONFIRM decision=${data.decision}`)
    settleConfirm(data.decision === true)
  }
  if (data?.type === 'BOSS_ASSISTANT_CONFIRM_TEST' && typeof data.desc === 'string' && data.desc.startsWith('TEST:')) {
    // 测试钩子：仅用于浏览器验收时渲染确认卡片（前缀保护，普通页面无法误触发）
    log(MOD, 'panelMessage', `CONFIRM_TEST ${data.desc}`)
    requestUserConfirm(data.desc.slice(5))
  }
  if (data?.type === 'BOSS_ASSISTANT_START_APPLY') {
    log(MOD, 'panelMessage', `START_APPLY, mode: ${data.mode || currentMode}`)
    startApply(data.mode || currentMode, data.filters || currentFilters)
  }
  if (data?.type === 'BOSS_ASSISTANT_STOP_APPLY' || data?.type === 'BOSS_ASSISTANT_SHUTDOWN') {
    log(MOD, 'panelMessage', 'SHUTDOWN (close panel = close bot)')
    shutdownAssistantFromPanel()
  }
  if (data?.type === 'BOSS_ASSISTANT_SET_PANEL_STATE') {
    const state = data.state as PanelState
    const allowed: PanelState[] = ['expanded', 'bubble', 'collapsed', 'closed']
    if (allowed.includes(state)) {
      if (panelHost) setPanelState(panelHost, state)
      // 「关闭」仍然等价于关闭 bot；「收起为浮球 / 小浮窗」只改形态，bot 继续跑
      if (state === 'closed') shutdownAssistantFromPanel()
      else writeAssistantState({ panelState: state })
    }
  }
  if (data?.type === 'BOSS_ASSISTANT_TOGGLE_PIN') {
    const pinned = !assistantState.pinned
    log(MOD, 'panelMessage', `TOGGLE_PIN ${pinned}`)
    if (panelHost) setPinned(panelHost, pinned)
    writeAssistantState({ pinned })
  }
  if (data?.type === 'BOSS_ASSISTANT_OPEN_OPTIONS') {
    log(MOD, 'panelMessage', 'OPEN_OPTIONS')
    try {
      Promise.resolve(chrome.runtime.sendMessage({ type: 'OPEN_OPTIONS' })).catch(() => {})
    } catch { /* 预期内异常，安全忽略 */ }
  }
  if (data?.type === 'BOSS_ASSISTANT_CHANGE_MODE') {
    log(MOD, 'panelMessage', `CHANGE_MODE: ${data.mode}`)
    currentMode = data.mode === 'recommend' ? 'recommend' : 'batch'
    if (panelHost) {
      updatePanelContent(panelHost, {
        mode: currentMode,
        status: 'idle',
        filters: currentFilters, resumeMode: liepinResumeMode,
      })
    }
    writeAssistantState({ applyMode: currentMode })
  }
  if (data?.type === 'BOSS_ASSISTANT_CHANGE_SCORING') {
    currentFilters = {
      ...currentFilters,
      enableAiMatch: data.enabled !== false,
    }
    updatePanelContent(panelHost!, {
      mode: currentMode,
      status: 'idle',
      filters: currentFilters, resumeMode: liepinResumeMode,
    })
    writeAssistantState({ enableAiMatch: currentFilters.enableAiMatch })
  }
  if (data?.type === 'BOSS_ASSISTANT_CHANGE_RESUME_MODE') {
    liepinResumeMode = data.enabled === true
    setLiepinResumeMode(liepinResumeMode)
    updatePanelContent(panelHost!, {
      mode: currentMode,
      status: 'idle',
      filters: currentFilters, resumeMode: liepinResumeMode,
    })
    writeAssistantState({ liepinResumeMode })
  }
  if (data?.type === 'BOSS_ASSISTANT_SEND_RESUMES') {
    console.log('[求职助手] BOSS_ASSISTANT_SEND_RESUMES received')
    log(MOD, 'panelMessage', 'SEND_RESUMES')
    sendResumesOnChatPage()
  }
  if (data?.type === 'BOSS_ASSISTANT_SETTINGS_CHANGED') {
    log(MOD, 'panelMessage', 'SETTINGS_CHANGED via in-page Butler Chat, reloading filters...')
    loadApplyDefaultsFromSettings().then(() => {
      if (panelHost) {
        updatePanelContent(panelHost, {
          mode: currentMode,
          status: 'idle',
          filters: currentFilters,
          resumeMode: liepinResumeMode,
        })
      }
    })
  }
  if (data?.type === 'BOSS_ASSISTANT_COPILOT_FILL') {
    const text = data.text || ''
    fillChatInputAndSend(text, false)
    if (panelHost) showPanelToast(panelHost, '已填入输入框，可在网页中编辑或发送', 'success')
  }
  if (data?.type === 'BOSS_ASSISTANT_COPILOT_SEND') {
    const text = data.text || ''
    fillChatInputAndSend(text, true)
    if (panelHost) showPanelToast(panelHost, '已通过 Copilot 发送回复', 'success')
  }
})

// ------ Filter Logic ------
function filterJobs(jobs: JobCard[], filters: ApplyFilters): { passed: JobCard[]; skipped: number } {
  const passed: JobCard[] = []
  let skipped = 0

  const titleKeywords = filters.jobTitles.trim().toLowerCase().split(/[,;\s|]+/).filter(Boolean)
  const locationKeywords = filters.locations.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const excludeKeywords = filters.excludeKeywords.trim().toLowerCase().split(/\s+/).filter(Boolean)

  for (const job of jobs) {
    let skip = false

    if (!skip && titleKeywords.length > 0) {
      if (!isJobMatchingCareer(job.title, titleKeywords)) skip = true
    }

    if (!skip && filters.publishTime) {
      if (!isJobMatchingFreshness(job.publishedAt, filters.publishTime)) skip = true
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
  matchResults = []

  // 概览「批量沟通控制台」的实时进度来源（不影响原有浮窗渲染链路）
  const report = (patch: Parameters<typeof reportBatchProgress>[0]) =>
    reportBatchProgress(patch).catch(() => {})
  /** 概览控制台只展示最近 3 条，避免与「追踪」页的完整列表重复 */
  const toRecentMatches = () => matchResults.slice(-3).reverse().map((r) => ({
    title: r.title,
    companyName: r.companyName,
    score: r.score,
    recommended: r.recommended,
    scoreBypassed: r.scoreBypassed,
    prefiltered: r.prefiltered,
  }))
  await report({
    status: 'scanning',
    stats: { total: 0, processed: 0, matched: 0 },
    recentMatches: [],
    dailyRemaining: null,
    message: '已收到启动指令，正在读取简历并扫描岗位…',
  })

  if (!panelHost?.isConnected) panelHost = createFloatingPanel()
  updatePanelContent(panelHost, {
    mode: currentMode,
    status: 'scanning',
    message: '已收到启动指令，正在读取简历并扫描岗位…',
    filters, resumeMode: liepinResumeMode,
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
    void endManualRun({ message: '未设置默认简历，请先在「简历」页上传' })
    logGroupEnd()
    return
  }

  log(MOD, 'startApply', `Resume: ${defaultResume.name} (skills=${defaultResume.structuredData?.skills?.length})`)

  // 读取用户配置的「单次扫描数量」。<=0 表示不限制（扫描到页面无更多为止）。
  const maxScanCount = await getSetting<number>('maxScanCount', CONSERVATIVE_VALUES.maxScanCount)
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
        filters, resumeMode: liepinResumeMode,
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
      filters, resumeMode: liepinResumeMode,
    })
    isApplying = false
    void endManualRun({ message: '未找到岗位卡片，请到搜索页或推荐页再试' })
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
      filters, resumeMode: liepinResumeMode,
    })
    showPanelToast(panelHost!, '没有符合筛选条件的岗位', 'warning')
    isApplying = false
    void endManualRun({ message: `找到 ${allJobs.length} 个岗位，均不符合筛选条件` })
    logGroupEnd()
    return
  }

  // Get already-applied job IDs from shared storage
  const appliedJobIds = await getSharedAppliedJobIds()
  log(MOD, 'startApply', `Already applied: ${appliedJobIds.length} jobs`)

  // ── 方案A：猎聘两阶段评分 ──
  // 猎聘搜索卡片没有 JD 正文（只有"标题+薪资+年限+学历"摘要），直接送 AI 评分
  // 只能得到 34-40 分的低分且毫无区分度。因此：
  //  阶段1 用本地规则（语言家族/标题/薪资/年限/学历/城市）粗筛全部岗位，取 topN 为候选；
  //  阶段2 仅对候选 fetch 详情页真实 JD（SSR JSON-LD，免跳转）再走 AI/本地精评。
  let liepinPrefilter: { candidates: Set<string>; scores: Map<string, number> } | null = null
  const isLiepin = adapter.id === 'liepin'
  if (isLiepin && filters?.enableAiMatch !== false) {
    const prefilterLimit = await getSetting<number>('liepinDetailReviewLimit', 20)
    const scored: Array<{ job: JobCard; pre: { pass: boolean; score: number; reasons: string[] } }> = jobs.map((job) => ({
      job,
      pre: prefilterLiepinJob(job, defaultResume!, filters),
    }))
    const passed = scored
      .filter((x) => x.pre.pass)
      .sort((a, b) => b.pre.score - a.pre.score)
      .slice(0, prefilterLimit)
    liepinPrefilter = {
      candidates: new Set(passed.map((x) => x.job.id)),
      scores: new Map(scored.map((x) => [x.job.id, x.pre.score])),
    }
    log(MOD, 'startApply', `Liepin two-stage: ${passed.length}/${jobs.length} candidates (limit ${prefilterLimit})`)
  }

  updatePanelContent(panelHost!, {
    mode: currentMode,
    stats: { total: jobs.length, processed: 0, matched: 0 },
    status: 'matching',
    message: filters?.enableAiMatch === false
      ? `筛选后 ${jobs.length} 个岗位，准备沟通...`
      : isLiepin && liepinPrefilter
        ? `粗筛完成：${liepinPrefilter.candidates.size}/${jobs.length} 个进入详情精评…`
        : `筛选后 ${jobs.length} 个岗位，开始匹配分析...`,
    filters, resumeMode: liepinResumeMode,
  })
  await report({
    status: 'matching',
    stats: { total: jobs.length, processed: 0, matched: 0 },
    message: `筛选后 ${jobs.length} 个岗位，开始匹配分析…`,
  })

  let matchedCount = 0
  let appliedCount = 0
  let processedCount = 0
  let dailyRemaining: number | null = null

  for (const job of jobs) {
    if (!isApplying) break

    // Check risk on every iteration — rate limits or captchas may appear
    // mid-run after a few successful communications. When any risk is
    // detected we stop the whole loop: non-block risks would cause every
    // remaining job to be skipped anyway, and continuing one-by-one
    // produces a misleading "0/0" result.
    const risk = scanRisk(adapter.getRiskConfig())
    if (risk) {
      if (risk.type === 'block') {
        showPanelToast(panelHost!, risk.message, 'error')
        logWarn(MOD, 'startApply', `Fatal risk — stopping run: ${risk.message}`)
        updatePanelContent(panelHost!, {
          mode: currentMode,
          stats: { total: jobs.length, processed: processedCount, matched: matchedCount },
          status: 'done',
          matchResults,
          message: `沟通中断：${risk.message}`,
          filters: currentFilters, resumeMode: liepinResumeMode,
        })
        isApplying = false
        void endManualRun({
          message: `沟通中断：${risk.message}`,
          stats: { total: jobs.length, processed: processedCount, matched: matchedCount },
          recentMatches: toRecentMatches(),
        })
        logGroupEnd()
        return
      }
      // Non-block risk (rate_limit / captcha): stop the loop instead of
      // silently skipping every remaining job.
      if (risk.message !== lastRiskWarning) {
        lastRiskWarning = risk.message
        showPanelToast(panelHost!, risk.message, 'warning')
      }
      logWarn(MOD, 'startApply', `Risk detected — stopping loop: ${risk.message}`)
      break
    }

    // Check if already applied (via shared storage)
    if (appliedJobIds.includes(job.id)) {
      processedCount++
      log(MOD, 'startApply', `Skip (already applied): ${job.title}`)
      continue
    }

    // Check daily limit before processing this job
    const limitCheck = await checkDailyLimit()
    dailyRemaining = limitCheck.remaining
    if (!limitCheck.allowed) {
      showPanelToast(panelHost!, `今日投递次数已达上限，剩余 ${limitCheck.remaining} 次`, 'warning')
      logWarn(MOD, 'startApply', `Daily limit reached — stopping run (${limitCheck.remaining} remaining)`)
      break
    }

    // 猎聘两阶段：未通过卡片粗筛的岗位直接落结果（展示粗筛分），不调 AI、不抓详情
    if (isLiepin && liepinPrefilter && !liepinPrefilter.candidates.has(job.id)) {
      const preScore = liepinPrefilter.scores.get(job.id) ?? 0
      processedCount++
      matchResults.push({
        title: job.title,
        companyName: job.companyName,
        score: preScore,
        recommended: false,
        prefiltered: true,
      })
      updatePanelContent(panelHost!, {
        mode: currentMode,
        stats: { total: jobs.length, processed: processedCount, matched: matchedCount },
        status: 'matching',
        matchResults,
        message: `粗筛未过: ${job.title} (${preScore}分)`,
        filters: currentFilters, resumeMode: liepinResumeMode,
      })
      await report({
        status: 'matching',
        stats: { total: jobs.length, processed: processedCount, matched: matchedCount },
        recentMatches: toRecentMatches(),
        dailyRemaining,
        message: `粗筛未过：${job.title} (${preScore}分)`,
      })
      await randomDelay(200, 500)
      continue
    }

    const scoreBypassed = filters?.enableAiMatch === false
    let evaluatedMatch: MatchResult
    let preOpenedDetail: HTMLElement | null = null  // 批量模式下预打开的详情面板

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

      // 猎聘两阶段精评前置：候选岗 fetch 详情页真实 JD（SSR JSON-LD），失败回退卡片文本
      if (isLiepin && liepinPrefilter) {
        updatePanelContent(panelHost!, {
          mode: currentMode,
          stats: { total: jobs.length, processed: processedCount, matched: matchedCount },
          status: 'matching',
          matchResults,
          message: `📄 抓取JD: ${job.title}`,
          filters: currentFilters, resumeMode: liepinResumeMode,
        })
        await randomDelay(300, 800)
        const jd = await fetchJobDetailDescription(job.url)
        if (jd && jd.length > (job.jobDescription || '').length) {
          job.jobDescription = jd
          log(MOD, 'startApply', `Liepin JD fetched (${jd.length} chars) for ${job.title}`)
        } else {
          logWarn(MOD, 'startApply', `Liepin JD fetch failed, fallback to card text: ${job.title}`)
        }
      }

      // 批量模式：先打开详情面板获取真实 JD，再做 AI 匹配评分。
      // 列表页卡片的 jobDescription 只是预览（可能为空），评分由 matchingText 拼凑文本兜底；
      // 真实 JD 在详情面板中，轮询提取成功后写入 jobDescription（评分与落库都更准确）。
      if (currentMode === 'batch') {
        preOpenedDetail = await adapter.activateJobCard(job.url, job.id, job.title, job.companyName)
        if (preOpenedDetail) {
          const fullDesc = await waitForJobDescription(preOpenedDetail, job.jobDescription || '', 2500)
          if (fullDesc && fullDesc.length > (job.jobDescription || '').length) {
            job.jobDescription = fullDesc
            log(MOD, 'startApply', `Real JD extracted (${fullDesc.length} chars) for scoring`)
          }
        }
      }

      const match = await matchResumeToJob(defaultResume, job)
      // 本地规则分与 AI 语义分不在同一量纲：本地分普遍偏低（常见 20-45 分），
      // 若直接套用 AI 的 60 分门槛，会把几乎所有岗位判为不合格 → 一个都投不出去。
      // 因此 AI 未启用时按比例折算门槛，保证纯本地模式仍能正常推进。
      const aiMatchEnabled = await getSetting<boolean>('aiEnabled', false)
      const effectiveThreshold = filters
        ? (aiMatchEnabled
            ? filters.minMatchScore
            : Math.max(25, Math.round(filters.minMatchScore * 0.55)))
        : 60
      const isRecommended = filters
        ? match.score >= effectiveThreshold
        : match.isRecommended
      evaluatedMatch = { ...match, isRecommended }

      // 非推荐且已打开详情面板 → 关闭节省资源
      if (!evaluatedMatch.isRecommended && preOpenedDetail) {
        await adapter.closeDetailPanel?.()
        preOpenedDetail = null
      }
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
      filters: currentFilters, resumeMode: liepinResumeMode,
    })
    await report({
      status: evaluatedMatch.isRecommended ? 'applying' : 'matching',
      stats: { total: jobs.length, processed: processedCount, matched: matchedCount },
      recentMatches: toRecentMatches(),
      dailyRemaining,
      message: scoreBypassed
        ? `筛选通过：${job.title}`
        : `分析：${job.title} — ${evaluatedMatch.score}分 ${evaluatedMatch.isRecommended ? '✓推荐' : '×跳过'}`,
    })

    // Apply if batch mode + recommended  OR  AI自动确认 mode
    if (evaluatedMatch.isRecommended) {
      if (currentMode === 'batch') {
        // 批量沟通：走固定选择器（快）
        const applied = await applyToJob(job, evaluatedMatch, preOpenedDetail)
        if (applied) { appliedCount++; await incrementCounter() }
      } else {
        // AI自动确认：智能体观察→推理→执行→沉淀
        const applied = await agentApplyToJob(job, evaluatedMatch)
        if (applied) { appliedCount++; await incrementCounter() }
      }
    }

    // Delay between processing
    await randomDelay(500, 1500)
  }

  log(MOD, 'startApply', `Done: ${matchedCount} matched / ${processedCount} processed / ${jobs.length} total`)
  // When the UI says the run is complete, a new run must be accepted immediately.
  isApplying = false
  const finishedByStop = runStopped
  const finalMessage = finishedByStop
    ? '已停止沟通'
    : (currentMode === 'batch'
        ? `沟通完成！成功 ${appliedCount}/${processedCount} 个岗位`
        : currentFilters.enableAiMatch
          ? `分析完成！发现 ${matchedCount} 个匹配岗位`
          : `筛选完成！共 ${matchedCount} 个岗位可直投`)
  updatePanelContent(panelHost!, {
    mode: currentMode,
    stats: { total: jobs.length, processed: processedCount, matched: matchedCount },
    status: finishedByStop ? 'pause' : 'done',
    matchResults,
    message: finalMessage,
    filters: currentFilters, resumeMode: liepinResumeMode,
  })

  // 落最终进度并释放 manual 互斥锁；放在 APPLY_ENDED 之前，
  // 保证所有进度上报都已完成，不会与释放动作产生写入竞态。
  await endManualRun({
    status: finishedByStop ? 'paused' : 'done',
    stats: { total: jobs.length, processed: processedCount, matched: matchedCount },
    recentMatches: toRecentMatches(),
    dailyRemaining,
    message: finalMessage,
  }, finishedByStop)

  if (currentMode === 'batch') {
    showPanelToast(
      panelHost!,
      appliedCount > 0 ? `沟通完成！成功 ${appliedCount} 个` : '未完成任何沟通，请检查岗位页面',
      appliedCount > 0 ? 'success' : 'warning',
    )
  }
  // 「本次运行已结束」已由 endManualRun 统一通知 popup，这里不再重复发送。
  logGroupEnd()
}

/**
 * 轮询等待详情面板真实 JD 出现：
 * 固定延时在 JD 异步加载慢时容易抓到空；这里每 120ms 提取一次，
 * 直到连续两轮稳定且长度超过当前文本，或超时返回当前最佳。
 */
async function waitForJobDescription(
  detail: HTMLElement,
  current: string,
  timeoutMs = 2500,
): Promise<string> {
  const deadline = Date.now() + timeoutMs
  let best = ''
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

/**
 * 点击了按钮但没有拿到平台确认时，绝不落盘、不加入去重。
 * 浮窗明确告知 + 诊断中心留痕，让用户能去平台聊天列表核对。
 */
function reportUnverifiedApply(job: JobCard, verification: ApplyVerification, path: string): void {
  const prefix = verification.level === 'blocked' ? '平台未受理' : '未确认'
  updatePanelContent(panelHost!, {
    mode: currentMode,
    status: 'applying',
    message: `${prefix}：${job.title} 未记为投递成功\n${verification.reason}\n请到平台聊天列表核对`,
    filters: currentFilters, resumeMode: liepinResumeMode,
  })
  try {
    chrome.runtime.sendMessage({
      type: 'RECORD_ERROR',
      payload: {
        source: `content.apply.${path}`,
        message: `投递未确认: ${job.title} @ ${job.companyName} (${verification.reason})`,
        context: JSON.stringify({
          jobId: job.id,
          jobUrl: job.url,
          level: verification.level,
          signals: verification.signals,
          blockers: verification.blockers,
          currentUrl: window.location.href,
        }),
      },
    })
  } catch { /* 留痕失败不影响业务 */ }
  logWarn(MOD, path, `Apply not confirmed: ${job.title} - ${verification.reason}`)
}

async function applyToJob(job: JobCard, match: MatchResult, preOpenedDetail?: HTMLElement | null): Promise<boolean> {
  log(MOD, 'applyToJob', `Applying: ${job.title} @ ${job.companyName} (score=${match.score})`)

  updatePanelContent(panelHost!, {
    mode: currentMode,
    status: 'applying',
    message: `🎯 正在沟通：${job.title} @ ${job.companyName}`,
    filters: currentFilters, resumeMode: liepinResumeMode,
  })

  const jobDetail = preOpenedDetail || await adapter.activateJobCard(job.url, job.id, job.title, job.companyName)
  if (!jobDetail) {
    const allLinks = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href*="job_detail"]'))
    updatePanelContent(panelHost!, {
      mode: currentMode, status: 'applying',
      message: `❌ 无法打开详情: ${job.title}\n链接数=${allLinks.length} | url=${job.url?.slice(-30)}`,
      filters: currentFilters, resumeMode: liepinResumeMode,
    })
    logWarn(MOD, 'applyToJob', `Could not activate job detail: ${job.title}`)
    return false
  }

  // 如果详情是新打开的（非预打开），补充提取 JD
  if (!preOpenedDetail) {
    const fullDesc = await waitForJobDescription(jobDetail, job.jobDescription || '', 2500)
    if (fullDesc && fullDesc.length > (job.jobDescription || '').length) {
      job.jobDescription = fullDesc
    }
  }

  // Click apply button
  const communicationUiBeforeClick = adapter.snapshotCommunicationUi()
  const baselineTexts = collectApplyPageTexts(jobDetail)
  const urlBeforeClick = window.location.href
  const applied = await adapter.clickApplyButton(jobDetail)
  if (applied) {
    // 点击后先采一次：话术窗口稍后可能被 fillGreetingMessage 关闭，证据会丢
    const postClickTexts = collectApplyPageTexts(jobDetail)
    const communicationUiChanged = hasNewCommunicationUi(
      communicationUiBeforeClick,
      adapter.snapshotCommunicationUi(),
    )

    // Boss 点"立即沟通"后通常自动发送默认问候语，但「没有 textarea」不再等于成功：
    // 必须另有平台侧状态变化，否则一律记为未确认。
    const name = defaultResume?.structuredData?.name || '求职者'
    const greeting = adapter.getJobSpecificGreeting(name, job, match)
    const greetingSent = await adapter.fillGreetingMessage(greeting, communicationUiBeforeClick)
    if (!greetingSent) {
      log(MOD, 'applyToJob', `Greeting fill skipped (Boss auto-sent or no textarea): ${job.title}`)
    }
    await randomDelay(500, 1000)

    const verification = decideApplyVerification({
      clicked: applied,
      greetingSent,
      baselineTexts,
      postClickTexts,
      pageTexts: collectApplyPageTexts(jobDetail),
      communicationUiChanged,
      navigatedToChat:
        window.location.href !== urlBeforeClick && isChatPageUrl(window.location.href),
    })
    if (verification.level !== 'confirmed') {
      reportUnverifiedApply(job, verification, 'batch')
      return false
    }

    const saved = await saveApplication(job, match)
    if (!saved) {
      logWarn(MOD, 'applyToJob', `Application was sent but could not be persisted: ${job.title}`)
      return false
    }

    // Track as applied (chrome.storage.local — accessible cross-context)
    await addSharedAppliedJobId(job.id)
    log(MOD, 'applyToJob', `Applied & tracked: ${job.title} @ ${job.companyName} (${verification.reason})`)
    return true
  } else {
    // Show button texts in panel so user can see what's available
    const allBtns = Array.from(jobDetail.querySelectorAll('button, [role="button"], a.btn'))
    const btnTexts = allBtns.map(b => (b.textContent || '').trim()).filter(t => t.length >= 2 && t.length <= 15)
    updatePanelContent(panelHost!, {
      mode: currentMode, status: 'applying',
      message: `❌ 未找到沟通按钮: ${job.title}\n面板按钮: [${btnTexts.slice(0, 8).join(', ')}]`,
      filters: currentFilters, resumeMode: liepinResumeMode,
    })
    logWarn(MOD, 'applyToJob', `Apply button not found: ${job.title}`)
    return false
  }
}

/** AI自动确认模式：智能体观察页面、推理操作、沉淀技能（E5：全程状态机编排 + 审计） */
async function agentApplyToJob(job: JobCard, match: MatchResult): Promise<boolean> {
  const pageType = adapter.detectPageType()
  const platformId = adapter.id
  let machineState: ApplyState = 'matched'
  const track = async (event: ApplyEvent, extra?: { verified?: boolean; error?: string }) => {
    const next = transition(machineState, event)
    if (next) {
      await recordMachineTransition({
        jobTitle: job.title, jobCompany: job.companyName, platform: platformId,
        stateFrom: machineState, stateTo: next, eventType: event.type,
        verified: extra?.verified, error: extra?.error,
      })
      // H3：每步迁移落盘，重启后可从非终态恢复
      await saveApplyRun(job.id, next, {
        jobTitle: job.title,
        companyName: job.companyName,
        platform: platformId,
        resumeId: defaultResume?.id ?? '',
        score: match.score,
      })
      machineState = next
    }
  }

  // Goal 1: 打开详情 — 优先用固定选择器，失败则 AI 接管
  await track({ type: 'START' })
  let detailEl: HTMLElement | null = null
  const fixedDetail = await adapter.activateJobCard(job.url, job.id, job.title, job.companyName)
  if (fixedDetail) {
    detailEl = fixedDetail
    await track({ type: 'DETAIL_OPENED' }, { verified: true })
    log(MOD, 'agentApplyToJob', `Fixed selector opened detail: ${job.title}`)
  } else {
    log(MOD, 'agentApplyToJob', `Fixed selector failed, delegating to AI agent...`)
    updatePanelContent(panelHost!, {
      mode: currentMode, status: 'applying',
      message: `🤖 AI思考中: 打开详情 "${job.title}"`,
      filters: currentFilters, resumeMode: liepinResumeMode,
    })
    const r1 = await reactLoop(platformId, pageType, 'open_detail', {
      title: job.title,
      company: job.companyName,
      url: job.url,
    }, (thinking) => {
      updatePanelContent(panelHost!, {
        mode: currentMode, status: 'applying',
        message: `🤖 ${thinking}`,
        filters: currentFilters, resumeMode: liepinResumeMode,
      })
    }, {
      onConfirm: async (desc) => requestUserConfirm(`AI 即将执行：${desc}`),
    })
    await track(r1.success
      ? { type: 'DETAIL_OPENED' }
      : { type: 'DETAIL_FAILED', reason: r1.error || 'AI 无法打开详情', fallbackAvailable: false },
    { verified: r1.success, error: r1.error })
    if (!r1.success) {
      logWarn(MOD, 'agentApplyToJob', `Agent failed goal 1: ${r1.error}`)
      updatePanelContent(panelHost!, {
        mode: currentMode, status: 'applying',
        message: `❌ AI无法打开详情: ${job.title}`,
        filters: currentFilters, resumeMode: liepinResumeMode,
      })
      return false
    }
    log(MOD, 'agentApplyToJob', `Agent opened detail in ${r1.attempts} steps (cached=${r1.usedCachedSkill})`)
  }
  await randomDelay(400, 800)

  if (detailEl) {
    const desc = await waitForJobDescription(detailEl, job.jobDescription || '', 1800)
    if (desc && desc.length > (job.jobDescription || '').length) {
      job.jobDescription = desc
    }
  }

  // Goal 2: 点击沟通/发简历
  const commUiBefore = adapter.snapshotCommunicationUi()
  const baselineTexts = collectApplyPageTexts(detailEl ?? document)
  const urlBeforeClick = window.location.href
  const fixedClick = await adapter.clickApplyButton(detailEl || job as any)
  if (fixedClick) {
    await track({ type: 'CHAT_CLICKED' }, { verified: true })
    log(MOD, 'agentApplyToJob', `Fixed selector clicked apply: ${job.title}`)
  } else {
    log(MOD, 'agentApplyToJob', `Fixed click failed, delegating to AI...`)
    updatePanelContent(panelHost!, {
      mode: currentMode, status: 'applying',
      message: `🤖 AI思考中: 发起沟通 "${job.title}"`,
      filters: currentFilters, resumeMode: liepinResumeMode,
    })
    const r2 = await reactLoop(platformId, pageType, 'click_chat', {
      title: job.title,
      company: job.companyName,
    }, (thinking) => {
      updatePanelContent(panelHost!, {
        mode: currentMode, status: 'applying',
        message: `🤖 ${thinking}`,
        filters: currentFilters, resumeMode: liepinResumeMode,
      })
    }, {
      onConfirm: async (desc) => requestUserConfirm(`AI 即将执行：${desc}`),
    })
    await track(r2.success
      ? { type: 'CHAT_CLICKED' }
      : { type: 'CHAT_FAILED', reason: r2.error || 'AI 无法发起沟通', fallbackAvailable: false },
    { verified: r2.success, error: r2.error })
    if (!r2.success) {
      logWarn(MOD, 'agentApplyToJob', `Agent failed goal 2: ${r2.error}`)
      updatePanelContent(panelHost!, {
        mode: currentMode, status: 'applying',
        message: `❌ AI无法发起沟通: ${job.title}`,
        filters: currentFilters, resumeMode: liepinResumeMode,
      })
      return false
    }
    log(MOD, 'agentApplyToJob', `Agent clicked chat in ${r2.attempts} steps (cached=${r2.usedCachedSkill})`)
  }
  // 点击后的平台侧证据：话术窗口稍后会被关闭，先采一次
  const postClickTexts = collectApplyPageTexts(detailEl ?? document)
  const communicationUiChanged = hasNewCommunicationUi(
    commUiBefore,
    adapter.snapshotCommunicationUi(),
  )
  await randomDelay(500, 1000)

  // Goal 3: 发送问候语（best effort）
  const name = defaultResume?.structuredData?.name || '求职者'
  const greeting = adapter.getJobSpecificGreeting(name, job, match)
  const greetingSent = await adapter.fillGreetingMessage(greeting, commUiBefore)
  if (!greetingSent) {
    log(MOD, 'agentApplyToJob', `Greeting fill skipped (auto-sent or no textarea)`)
  }
  await track({ type: 'GREETING_SENT' }, { verified: greetingSent })
  await randomDelay(500, 1000)

  const verification = decideApplyVerification({
    clicked: true,
    greetingSent,
    baselineTexts,
    postClickTexts,
    pageTexts: collectApplyPageTexts(detailEl ?? document),
    communicationUiChanged,
    navigatedToChat:
      window.location.href !== urlBeforeClick && isChatPageUrl(window.location.href),
  })
  if (verification.level !== 'confirmed') {
    reportUnverifiedApply(job, verification, 'agent')
    return false
  }

  // 保存
  const saved = await saveApplication(job, match)
  if (!saved) {
    logWarn(MOD, 'agentApplyToJob', `Application was sent but could not be persisted: ${job.title}`)
    return false
  }
  await addSharedAppliedJobId(job.id)
  // E4：投递成功后更新职业状态记忆（画像快照 + 差距沉淀）
  try {
    const { recordCareerMatch, absorbGapSuggestions } = await import('../shared/db/career-store')
    await recordCareerMatch({
      overallScore: match.score, recommendation: match.recommendation,
      jobTitle: job.title, jobCompany: job.companyName,
    })
    if (match.skillGap && match.skillGap.length > 0) {
      await absorbGapSuggestions(match.skillGap.slice(0, 3))
    }
  } catch (err: any) {
    logWarn(MOD, 'agentApplyToJob', `Career memory update failed: ${err?.message}`)
  }
  await clearApplyRun(job.id)
  log(MOD, 'agentApplyToJob', `Done: ${job.title}`)
  return true
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

// ─── Boss 聊天页：批量发送简历 ───
async function sendResumesOnChatPage(): Promise<void> {
  console.log('[求职助手] sendResumesOnChatPage called, isApplying=', isApplying)
  if (isApplying) { console.log('[求职助手] Already applying, returning'); return }
  isApplying = true
  runStopped = false

  if (!panelHost?.isConnected) { console.log('[求职助手] Creating new panel'); panelHost = createFloatingPanel() }
  updatePanelContent(panelHost!, {
    mode: currentMode,
    status: 'scanning',
    message: '等待页面渲染…',
    resumeMode: liepinResumeMode, isChatPage: true,
    filters: currentFilters,
  })

  // Boss 聊天页联系人列表可能是懒加载，等待几秒
  await new Promise((r) => setTimeout(r, 2000))

  const contacts = getChatContacts()
  log(MOD, 'sendResumes', `Found ${contacts.length} contacts`)

  if (contacts.length === 0) {
    // 调试：搜索所有有多个相似子元素的大容器（可能是联系人列表）
    const allDivs = document.querySelectorAll('div, section, ul, ol, main, article')
    let debugHtml = ''
    let found = 0
    allDivs.forEach((c) => {
      if (found >= 10) return
      const childCount = c.children.length
      if (childCount < 3) return
      const cls = c.className?.toString?.()?.slice(0, 50) || ''
      // 检查子元素是否有文本内容（排除纯图标/空元素）
      let textChildren = 0
      for (let j = 0; j < Math.min(childCount, 5); j++) {
        if ((c.children[j]?.textContent || '').trim().length > 2) textChildren++
      }
      if (textChildren < 2) return
      const text = (c.textContent || '').trim().slice(0, 80)
      debugHtml += `${c.tagName}.${cls} (${childCount}子): ${text}\n`
      found++
    })
    updatePanelContent(panelHost!, {
      mode: currentMode, status: 'idle',
      message: `❌ 未找到联系人(${found}容器):\n${debugHtml || '无'}`,
      filters: currentFilters, resumeMode: liepinResumeMode, isChatPage: true,
    })
    isApplying = false
    return
  }

  let sent = 0
  let skippedSent = 0
  let skippedNoBtn = 0
  const results: string[] = []

  for (let i = 0; i < contacts.length; i++) {
    if (!isApplying) break
    const contact = contacts[i]

    // 点击联系人
    await clickContact(contact)
    await randomDelay(1000, 1500)

    // DEBUG: 第一个联系人时展示按钮列表（2秒），然后正常继续
    if (i === 0) {
      const allBtns = document.querySelectorAll('button, [role="button"], [class*="btn"], span[class*="action"]')
      const btnTexts: string[] = []
      allBtns.forEach(b => {
        const t = (b.textContent || '').trim()
        if (t && t.length >= 2 && t.length <= 10 && !btnTexts.includes(t)) btnTexts.push(t)
      })
      updatePanelContent(panelHost!, {
        mode: currentMode, status: 'applying',
        message: `按钮: ${btnTexts.slice(0, 12).join(' ')}`,
        stats: { total: contacts.length, processed: i, matched: 0 },
        resumeMode: liepinResumeMode, isChatPage: true,
        filters: currentFilters,
      })
    }

    // 检查是否已发过简历
    if (hasResumeSentInChat()) {
      log(MOD, 'sendResumes', `Skip (already sent): ${contact.name}`)
      skippedSent++
      results.push(`⏭ ${contact.name}: 已发过`)
      continue
    }

    // 点击发简历
    const clicked = await clickSendResume()
    if (!clicked) {
      log(MOD, 'sendResumes', `发简历 button not found: ${contact.name}`)
      skippedNoBtn++
      results.push(`❌ ${contact.name}: 无发简历按钮`)
      continue
    }

    // 选择简历并发送
    const sentOk = await selectAndSendResume()
    if (sentOk) {
      sent++
      results.push(`✅ ${contact.name}: 已发送`)
      log(MOD, 'sendResumes', `Resume sent: ${contact.name}`)
    } else {
      skippedNoBtn++
      results.push(`❌ ${contact.name}: 发送失败`)
      log(MOD, 'sendResumes', `Send failed: ${contact.name}`)
    }

    // 关闭弹窗
    await closeChatDialog()
    await randomDelay(1000, 2500)

    updatePanelContent(panelHost!, {
      mode: currentMode, status: 'applying',
      message: `[${i + 1}/${contacts.length}] ${contact.name}`,
      stats: { total: contacts.length, processed: i + 1, matched: sent },
      resumeMode: liepinResumeMode, isChatPage: true,
      filters: currentFilters,
    })
  }

  isApplying = false
  const summary = results.slice(-5).join('\n')
  updatePanelContent(panelHost!, {
    mode: currentMode, status: 'done',
    message: `完成！发送${sent} 已发过${skippedSent} 无按钮${skippedNoBtn}\n${summary}`,
    stats: { total: contacts.length, processed: contacts.length, matched: sent },
    resumeMode: liepinResumeMode, isChatPage: true,
    filters: currentFilters,
  })
}

// ─── Boss 聊天页：HR 经典追问智能应答 Copilot ───
let chatObserverInterval: number | null = null
let lastObservedHrText = ''
let isAnalyzingHrMessage = false
let currentCopilotData: ChatCopilotData | null = null

export async function checkAndTriggerChatCopilot(): Promise<void> {
  if (!panelHost?.isConnected) return
  const isChat = adapter?.detectPageType?.() === 'chat' || window.location.href.includes('/web/geek/chat')
  if (!isChat) return

  const hrMsgObj = getLastHrMessageFromChat()
  if (!hrMsgObj || !hrMsgObj.text) return

  const currentText = hrMsgObj.text.trim()
  if (currentText === lastObservedHrText || isAnalyzingHrMessage) {
    return
  }

  lastObservedHrText = currentText
  isAnalyzingHrMessage = true

  // 1. 设置思考态
  currentCopilotData = {
    hrMessage: currentText,
    loading: true,
  }
  updatePanelContent(panelHost, {
    mode: currentMode,
    status: 'idle',
    filters: currentFilters,
    resumeMode: liepinResumeMode,
    isChatPage: true,
    chatCopilot: currentCopilotData,
  })

  try {
    // 2. 加载用户预设画像与底线、完整简历
    const [preferences, sharedResume] = await Promise.all([
      getCandidatePreferences(),
      defaultResume ? Promise.resolve(defaultResume) : fetchFullResume(),
    ])

    // 3. 提取当前聊天上下文中的职位与公司名称（若页面中有渲染）
    let jobTitle = '目标岗位'
    let companyName = '贵司'
    const titleEl = document.querySelector<HTMLElement>(
      '.chat-conversation .job-title, [class*="job-name"], .chat-user .job, .chat-user-header [class*="job"]',
    )
    if (titleEl?.textContent?.trim()) jobTitle = titleEl.textContent.trim()
    const compEl = document.querySelector<HTMLElement>(
      '.chat-conversation .company-name, [class*="company-title"], .chat-user .company, .chat-user-header [class*="company"]',
    )
    if (compEl?.textContent?.trim()) companyName = compEl.textContent.trim()

    // L3 结果回流：聊天页观察到的 HR 新消息是「投递之后真实发生了什么」的第一手证据。
    // outcome-store 按消息内容哈希去重，2.5 秒轮询不会把同一句话记成几十条。
    await recordOutcomeEvent({
      kind: 'hr_reply',
      jobTitle,
      company: companyName,
      snippet: currentText,
    })

    // 4. 调用 HR Copilot 引擎生成高情商建议
    const result = await generateHrReplyCopilot({
      hrMessage: currentText,
      jobTitle,
      companyName,
      resume: sharedResume || null,
      preferences,
    })

    currentCopilotData = {
      hrMessage: currentText,
      replyText: result.replyText,
      matchedFact: result.matchedFact,
      bottomLineAlert: result.bottomLineAlert,
      intent: result.intent,
      confidence: result.confidence,
      loading: false,
    }

    updatePanelContent(panelHost, {
      mode: currentMode,
      status: 'idle',
      filters: currentFilters,
      resumeMode: liepinResumeMode,
      isChatPage: true,
      chatCopilot: currentCopilotData,
    })
  } catch (err) {
    logError(MOD, 'ChatCopilot', err)
  } finally {
    isAnalyzingHrMessage = false
  }
}

export function startChatCopilotObserver(): void {
  if (chatObserverInterval !== null) return
  // 周期轮询感知会话区的 HR 最新追问（2.5 秒感知一次）
  chatObserverInterval = window.setInterval(() => {
    checkAndTriggerChatCopilot()
  }, 2500)
  // 初次即时触发一次感知
  setTimeout(checkAndTriggerChatCopilot, 1000)
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
      filters: currentFilters, resumeMode: liepinResumeMode,
    })
    showPanelToast(panelHost!, '已停止', 'warning')
  }
  // 立即把概览控制台切到暂停态；真正的锁释放在 startApply 收尾时统一处理
  void reportBatchProgress({ status: 'paused', message: '已停止沟通' }).catch(() => {})
}

// ------ Start ------
log(MOD, 'bootstrap', 'Content script loaded — running init()')
init()
