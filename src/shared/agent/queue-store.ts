// 持久化投递任务队列与 Campaign 存储
// 基于 chrome.storage.local，实现跨 Service Worker 重启、跨标签页的可靠调度

import type { PlatformId, TimeWindow, IntervalConfig } from './quota'
import type { CapacityGoal } from './capacity-goal'
import {
  DEFAULT_PLATFORM_CONFIGS,
  getSavedTimeWindows,
  getSavedIntervalConfig,
  getSavedPlatformQuotas,
  MIN_PLATFORM_QUOTA,
  MAX_PLATFORM_QUOTA,
} from './quota'

const QUOTA_PLATFORM_NAMES: Record<PlatformId, string> = {
  boss: 'Boss直聘',
  liepin: '猎聘',
  zhaopin: '智联招聘',
  '51job': '前程无忧',
  maimai: '脉脉',
}

export type TaskStatus =
  | 'pending'    // 待执行
  | 'running'    // content 执行中（带 lease 租约超时）
  | 'done'       // 投递成功
  | 'skipped'    // AI / 规则判断不符合，跳过
  | 'failed'     // 尝试用尽后失败
  | 'paused'     // 遇到验证码等原因等待人工处理

export interface ApplyTask {
  id: string                  // 平台前缀唯一标识：`${platform}:${jobId}`
  platform: PlatformId
  jobId: string
  jobTitle: string
  company: string
  jobUrl: string
  salary?: string
  location?: string
  experience?: string
  education?: string
  tags?: string[]
  bossName?: string
  bossTitle?: string
  /** L3 结果复盘：该岗位由哪个搜索关键词采集而来，用于按方向统计真实回复率 */
  searchKeyword?: string
  /** 采集来源页码：执行任务时据此把后台标签页导航回同一页，否则会「找不到岗位卡片」 */
  searchPage?: number
  status: TaskStatus
  attempts: number            // 已尝试次数，上限 2
  leaseUntil?: number         // running 态租约到期时间戳（毫秒）

  // AI 筛岗与个性化话术缓存
  matchScore?: number
  matchReason?: string
  greeting?: string
  aiCostTokens?: number

  appliedAt?: string
  failReason?: string
  createdAt: number
}

export interface PlatformCampaignQuota {
  quota: number               // 本次 campaign 的计划上限
  applied: number
  skipped: number
  failed: number
  exhausted: boolean          // 命中平台日限标记
  enabled: boolean            // 用户是否开启该平台投递
}

export interface CampaignLog {
  id: string
  time: string
  /** YYYY-MM-DD；跨天回看时才知道是哪天发生 */
  date?: string
  /** 归属的 campaign，便于区分「上一轮」和「本轮」 */
  campaignId?: string
  level: 'info' | 'success' | 'warn' | 'error'
  message: string
}

export interface Campaign {
  id: string
  createdAt: string
  status: 'running' | 'paused' | 'done' | 'aborted'
  pausedReason?: 'captcha' | 'user' | 'rate' | 'blocked' | 'no_source'
  tasks: ApplyTask[]
  quotas: Record<PlatformId, PlatformCampaignQuota>
  windows: TimeWindow[]
  intervalConfig: IntervalConfig
  lastTickAt?: number
  aiBudgetUsed: number
  consecutiveRestCounter: number // 连投计数（达到 restThreshold 后触发休息）
  restUntil?: number             // 强制休息到期时间戳
  /** 本批休息阈值，必须落盘；否则每轮 tick 重新随机会导致行为不可复现 */
  restThreshold?: number
  /** 「N 小时投满 M 份」目标产能；startedAt 随 campaign 持久化，暂停重启不重置倒计时 */
  capacityGoal?: CapacityGoal & { startedAt: number }
  logs: CampaignLog[]            // 每时每刻行为日志流水
}

const STORAGE_KEY_CAMPAIGN = 'apply_campaign_v1'
/** 独立于 campaign 的日志归档：新开一轮 / 清空队列都不会抹掉历史动作 */
const STORAGE_KEY_LOG_HISTORY = 'campaign_log_history_v1'
const MAX_CAMPAIGN_LOGS = 500
const MAX_LOG_HISTORY = 2000

function formatLogStamp(now: Date): { date: string; time: string } {
  const pad = (n: number) => String(n).padStart(2, '0')
  return {
    date: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
    time: `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`,
  }
}

/**
 * Campaign 写入串行链：所有 get-modify-set 排队执行，避免并发覆盖吞掉历史。
 * 休息状态也走同一条链，否则「先改内存再写日志」会被日志里的旧副本整份覆盖。
 */
let logWriteChain: Promise<unknown> = Promise.resolve()

/** 获取当前活动的 Campaign，若无或格式损坏则返回 null */
export async function getCampaign(): Promise<Campaign | null> {
  try {
    const result = await chrome.storage.local.get(STORAGE_KEY_CAMPAIGN)
    const campaign = result[STORAGE_KEY_CAMPAIGN] as Campaign | undefined
    return campaign && campaign.id ? campaign : null
  } catch {
    return null
  }
}

/** 保存或更新 Campaign 完整对象 */
export async function saveCampaign(campaign: Campaign): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY_CAMPAIGN]: campaign })
}

/** 清理当前 Campaign */
export async function clearCampaign(): Promise<void> {
  await chrome.storage.local.remove(STORAGE_KEY_CAMPAIGN)
}

/** 初始化一个全新的 Campaign */
export async function createNewCampaign(
  customQuotas?: Partial<Record<PlatformId, number>>,
  enabledPlatforms?: PlatformId[],
  windows?: TimeWindow[],
): Promise<Campaign> {
  const actualWindows = windows && windows.length > 0 ? windows : await getSavedTimeWindows()
  const intervalConfig = await getSavedIntervalConfig()
  // 以用户保存的自定义数量为底，调用方显式传入的部分再覆盖（后台独立启动也不会回落硬编码默认值）
  const effectiveQuotas: Partial<Record<PlatformId, number>> = {
    ...(await getSavedPlatformQuotas()),
    ...(customQuotas ?? {}),
  }
  const isPlatformEnabled = (pid: PlatformId): boolean => {
    if (!enabledPlatforms || enabledPlatforms.length === 0) return true
    return enabledPlatforms.includes(pid)
  }

  const quotas: Record<PlatformId, PlatformCampaignQuota> = {
    boss: {
      quota: effectiveQuotas?.boss ?? DEFAULT_PLATFORM_CONFIGS.boss.quota,
      applied: 0,
      skipped: 0,
      failed: 0,
      exhausted: false,
      enabled: isPlatformEnabled('boss'),
    },
    liepin: {
      quota: effectiveQuotas?.liepin ?? DEFAULT_PLATFORM_CONFIGS.liepin.quota,
      applied: 0,
      skipped: 0,
      failed: 0,
      exhausted: false,
      enabled: isPlatformEnabled('liepin'),
    },
    zhaopin: {
      quota: effectiveQuotas?.zhaopin ?? DEFAULT_PLATFORM_CONFIGS.zhaopin.quota,
      applied: 0,
      skipped: 0,
      failed: 0,
      exhausted: false,
      enabled: isPlatformEnabled('zhaopin'),
    },
    '51job': {
      quota: effectiveQuotas?.['51job'] ?? DEFAULT_PLATFORM_CONFIGS['51job'].quota,
      applied: 0,
      skipped: 0,
      failed: 0,
      exhausted: false,
      enabled: isPlatformEnabled('51job'),
    },
    maimai: {
      quota: effectiveQuotas?.maimai ?? DEFAULT_PLATFORM_CONFIGS.maimai.quota,
      applied: 0,
      skipped: 0,
      failed: 0,
      exhausted: false,
      enabled: isPlatformEnabled('maimai'),
    },
  }

  const now = new Date()
  const stamp = formatLogStamp(now)
  const campaignId = `cmp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
  const initLog: CampaignLog = {
    id: `init_${Date.now()}`,
    date: stamp.date,
    time: stamp.time,
    campaignId,
    level: 'info',
    message: '🚀 AIbot 初始化完成，准备就绪',
  }

  const campaign: Campaign = {
    id: campaignId,
    createdAt: now.toISOString(),
    status: 'running',
    tasks: [],
    quotas,
    windows: actualWindows,
    intervalConfig,
    aiBudgetUsed: 0,
    consecutiveRestCounter: 0,
    logs: [initLog],
  }

  // 初始日志同样进串行链，避免和紧随其后的 appendCampaignLog 互相覆盖
  const task = logWriteChain.then(async () => {
    await saveCampaign(campaign)
    await archiveLogEntry(initLog)
  })
  logWriteChain = task.catch(() => {})
  await task
  return campaign
}

/**
 * 追加一条行为流水日志。
 *
 * 修复两个「看不到之前干了什么」的根因：
 * 1) 旧版只留 120 条且新一轮 campaign 会清空 logs；
 * 2) 多条异步日志并发 get-modify-set 会互相覆盖，写进去的条目凭空消失。
 * 现在统一走串行链，同时写当前 campaign 与跨轮次归档。
 */
export function appendCampaignLog(
  message: string,
  level: CampaignLog['level'] = 'info',
): Promise<void> {
  const task = logWriteChain.then(() => appendCampaignLogInternal(message, level))
  logWriteChain = task.catch(() => {})
  return task
}

export interface RestStatePatch {
  /** null / undefined 表示清除休息状态 */
  restUntil?: number | null
  consecutiveRestCounter?: number
  restThreshold?: number
}

/**
 * 原子持久化休息状态。
 *
 * 必须在同一条串行写入链里执行：旧实现直接在内存改 `campaign.restUntil` 然后
 * `appendCampaignLog()`，日志内部会读一份 storage 里的旧 campaign 并整份写回，
 * 把休息状态覆盖掉，AIbot 于是每 5 分钟「重新休息一次」，永远投不满配额。
 */
async function persistRestStateInternal(patch: RestStatePatch): Promise<Campaign | null> {
  const campaign = await getCampaign()
  if (!campaign) return null

  if ('restUntil' in patch) {
    if (patch.restUntil == null) delete campaign.restUntil
    else campaign.restUntil = patch.restUntil
  }
  if (typeof patch.consecutiveRestCounter === 'number' && Number.isFinite(patch.consecutiveRestCounter)) {
    campaign.consecutiveRestCounter = Math.max(0, Math.round(patch.consecutiveRestCounter))
  }
  if (typeof patch.restThreshold === 'number' && Number.isFinite(patch.restThreshold)) {
    campaign.restThreshold = patch.restThreshold
  }

  await saveCampaign(campaign)
  return campaign
}

export function persistRestState(patch: RestStatePatch): Promise<Campaign | null> {
  const task = logWriteChain.then(() => persistRestStateInternal(patch))
  logWriteChain = task.catch(() => {})
  return task
}

/**
 * 写入目标产能。参数不变则沿用原 startedAt（暂停 / 重启不重置倒计时），
 * 参数被用户改过则重新计时，避免「改了目标却按旧截止算」。
 */
async function persistCapacityGoalInternal(goal: CapacityGoal | null): Promise<Campaign | null> {
  const campaign = await getCampaign()
  if (!campaign) return null
  if (!goal || !goal.enabled) {
    delete campaign.capacityGoal
  } else {
    const prev = campaign.capacityGoal
    const unchanged =
      prev && prev.hours === goal.hours && prev.targetJobs === goal.targetJobs
    campaign.capacityGoal = {
      ...goal,
      startedAt: unchanged ? prev.startedAt : Date.now(),
    }
  }
  await saveCampaign(campaign)
  return campaign
}

export function persistCapacityGoal(goal: CapacityGoal | null): Promise<Campaign | null> {
  const task = logWriteChain.then(() => persistCapacityGoalInternal(goal))
  logWriteChain = task.catch(() => {})
  return task
}

async function appendCampaignLogInternal(
  message: string,
  level: CampaignLog['level'],
): Promise<void> {
  const campaign = await getCampaign()
  if (!campaign) return

  const stamp = formatLogStamp(new Date())
  const entry: CampaignLog = {
    id: `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    date: stamp.date,
    time: stamp.time,
    campaignId: campaign.id,
    level,
    message,
  }

  if (!campaign.logs) campaign.logs = []
  campaign.logs.push(entry)
  if (campaign.logs.length > MAX_CAMPAIGN_LOGS) {
    campaign.logs = campaign.logs.slice(-MAX_CAMPAIGN_LOGS)
  }
  await saveCampaign(campaign)

  await archiveLogEntry(entry)
}

/** 把单条日志追加到跨轮次归档（必须在 logWriteChain 内调用） */
async function archiveLogEntry(entry: CampaignLog): Promise<void> {
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEY_LOG_HISTORY)
    const history: CampaignLog[] = Array.isArray(stored[STORAGE_KEY_LOG_HISTORY])
      ? stored[STORAGE_KEY_LOG_HISTORY] as CampaignLog[]
      : []
    history.push(entry)
    await chrome.storage.local.set({
      [STORAGE_KEY_LOG_HISTORY]: history.slice(-MAX_LOG_HISTORY),
    })
  } catch {
    // 忽略归档写入异常，主链路照常
  }
}

/** 读取跨 campaign 的完整行为日志归档（按时间正序） */
export async function getCampaignLogHistory(): Promise<CampaignLog[]> {
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEY_LOG_HISTORY)
    const history = stored[STORAGE_KEY_LOG_HISTORY]
    return Array.isArray(history) ? history as CampaignLog[] : []
  } catch {
    return []
  }
}

/** 手动清空归档（仅由诊断中心的「清空历史」调用） */
export async function clearCampaignLogHistory(): Promise<void> {
  await chrome.storage.local.remove(STORAGE_KEY_LOG_HISTORY)
}

/** 动态切换某个平台的开启/关闭状态 */
export async function togglePlatformEnabled(
  platform: PlatformId,
  enabled: boolean,
): Promise<Campaign | null> {
  const campaign = await getCampaign()
  if (!campaign) return null
  if (campaign.quotas[platform]) {
    campaign.quotas[platform].enabled = enabled
    await appendCampaignLog(
      `${enabled ? '🟢 已启用' : '⚪ 已禁用'} 平台：${platform}`,
      enabled ? 'info' : 'warn',
    )
    await saveCampaign(campaign)
  }
  return campaign
}

/** 动态更新 Campaign 的工作时段窗口 */
export async function updateCampaignWindows(windows: TimeWindow[]): Promise<Campaign | null> {
  const campaign = await getCampaign()
  if (!campaign) return null
  campaign.windows = windows
  await saveCampaign(campaign)
  return campaign
}

/**
 * 动态更新各平台的计划投递数量（AIbot 面板可随时修改，运行中即时生效）。
 * - 调大数量后，若该平台此前被标记为「耗尽」且已投数未达新上限，则解除耗尽标记继续调度。
 * - 调小数量后，若已投数已超过新上限，下一 tick 会自然判定该平台完成。
 */
export async function updateCampaignQuotas(
  quotas: Partial<Record<PlatformId, number>>,
): Promise<Campaign | null> {
  const campaign = await getCampaign()
  if (!campaign) return null

  const changes: string[] = []
  for (const pid of Object.keys(campaign.quotas) as PlatformId[]) {
    const candidate = quotas[pid]
    if (candidate === undefined || !Number.isFinite(candidate)) continue
    const q = campaign.quotas[pid]
    const nextQuota = Math.min(
      MAX_PLATFORM_QUOTA,
      Math.max(MIN_PLATFORM_QUOTA, Math.round(candidate)),
    )
    if (q.quota === nextQuota) continue
    q.quota = nextQuota
    if (q.exhausted && q.applied < nextQuota) q.exhausted = false
    changes.push(`${QUOTA_PLATFORM_NAMES[pid]} ${nextQuota}`)
  }
  if (changes.length === 0) return campaign

  await saveCampaign(campaign)
  // appendCampaignLog 会重新读取并保存 campaign，必须放在 saveCampaign 之后，避免覆盖本次修改
  await appendCampaignLog(`🎯 已更新投递数量：${changes.join('、')}`, 'info')
  return campaign
}

/** 动态更新 Campaign 的拟人间歇配置 */
export async function updateCampaignInterval(interval: IntervalConfig): Promise<Campaign | null> {
  const campaign = await getCampaign()
  if (!campaign) return null
  campaign.intervalConfig = interval
  await saveCampaign(campaign)
  return campaign
}

/** 批量添加任务到队列中（双重去重：ID + 平台/公司/职位名指纹） */
/** 历史 skipped 记录多久之后允许重新入队评估 */
export const TASK_RETRY_COOLDOWN_MS = 30 * 60_000
/**
 * 同一个岗位最多被回收 3 次。
 * 没有上限时，一个永远不达标的岗位会在「跳过 → 回收 → 再跳过」里无限循环，
 * 把目标产能的时间全部耗在同一张卡片上。
 */
export const MAX_TASK_RECYCLES = 3

export interface AppendTasksOptions {
  /** 覆盖回收冷却期；目标产能落后时传 0 立即重新评估 */
  retryCooldownMs?: number
}

/**
 * 只回收 `skipped`（匹配分 / 方向不达标）的历史任务。
 *
 * **绝不回收 `failed`**：failed 包含「平台未确认投递」，而「未确认」有可能其实已经
 * 在平台侧建立了沟通，只是 DOM 没采到证据；重新入队会造成对同一岗位重复打招呼。
 * done / pending / running / paused 同样占位不动。
 */
export function isRecyclableTask(
  task: Pick<ApplyTask, 'status' | 'createdAt' | 'attempts'>,
  now: number,
  cooldownMs: number = TASK_RETRY_COOLDOWN_MS,
  maxRecycles: number = MAX_TASK_RECYCLES,
): boolean {
  if (task.status !== 'skipped') return false
  if ((Number(task.attempts) || 0) >= maxRecycles) return false
  const createdAt = Number(task.createdAt) || 0
  return now - createdAt >= cooldownMs
}

/**
 * 旧版 51job 适配器把**公司页链接**当成岗位详情链接入队，现场队列里长这样：
 *   jobId = jobUrl = "https://jobs.51job.com/all/coUzxRPVA2VmkAYQdlVjY.html"
 * 这类任务永远不可能定位到岗位卡片：每次认领都报「未找到对应岗位卡片」→ failed，
 * 又触发「连续未能定位，清空待投缓存」自愈，把新采到的岗位一起清掉，
 * 流水线反复空转。适配器修好之后这些**历史脏任务仍在队列里**，必须显式清掉。
 *
 * 只识别 51job 公司页 / 整条 URL 当 ID 的旧数据；新版空 jobUrl 走 data-jobid
 * 的老结构任务、以及数字 ID 岗位详情 URL 都不受影响。
 */
export function isStaleNonJobUrlTask(
  task: Pick<ApplyTask, 'platform' | 'jobUrl' | 'jobId'>,
): boolean {
  if (task.platform !== '51job') return false
  const url = (task.jobUrl || '').trim()
  const id = (task.jobId || '').trim()
  if (!url) return false
  const isCompanyPage = /jobs\.51job\.com\/[^/]*\/co[A-Za-z0-9]+\.html/i.test(url)
    || /jobs\.51job\.com\/all\//i.test(url)
    || /jobs\.51job\.com\/[^/]*\/co[A-Za-z0-9]+\.html/i.test(id)
  const isJobDetail = /jobs\.51job\.com\/[^/]+\/\d+\.html/i.test(url)
    || /[?&](?:jobid|jobId|job_id)=\d+/i.test(url)
  // 旧版 extractIdFromUrl 会把整条 URL 当 jobId
  const urlUsedAsId = /^https?:\/\//i.test(id) && id === url && !isJobDetail
  return isCompanyPage || urlUsedAsId
}

/**
 * 清掉历史遗留的 51job 公司页脏任务。返回删除条数（0 表示无需写盘）。
 * 这些任务从未成功投递过，删除既不会造成重复投递，也能让同名岗位重新入队。
 */
export async function purgeStaleJobUrlTasks(): Promise<number> {
  const campaign = await getCampaign()
  if (!campaign || !Array.isArray(campaign.tasks)) return 0
  const before = campaign.tasks.length
  campaign.tasks = campaign.tasks.filter((t) => !isStaleNonJobUrlTask(t))
  const purged = before - campaign.tasks.length
  if (purged > 0) await saveCampaign(campaign)
  return purged
}

export async function appendTasksToCampaign(
  tasks: Omit<ApplyTask, 'status' | 'attempts' | 'createdAt'>[],
  opts: AppendTasksOptions = {},
): Promise<number> {
  const campaign = await getCampaign()
  if (!campaign) return 0

  // 采集层已修好 URL 分类，这里再拦一道：任何历史路径都不能把公司页链接
  // 重新写成 51job 任务，否则又会回到「反复认领 → 找不到卡片 → 清空队列」的死循环。
  tasks = tasks.filter((t) => !isStaleNonJobUrlTask(t))
  if (tasks.length === 0) return 0

  const now = Date.now()
  const cooldownMs = Math.max(0, opts.retryCooldownMs ?? TASK_RETRY_COOLDOWN_MS)

  // 旧版把 **所有** 历史任务（含 skipped / failed）都当成永久去重键。
  // 结果：被门槛跳过的岗位永远占着 company:title，同一页再采时
  // 35 个对口岗位全部「已存在」→ added=0 → 队列只减不增 → AIbot 无限空转，
  // 用户设了目标产能也一个都投不出去。
  // 现在：done / pending / running / paused / failed 仍占位；skipped 过冷却期后回收，
  // 并且把已尝试次数带过去，超过 MAX_TASK_RECYCLES 就永久占位。
  const existingIds = new Set<string>()
  const existingJobKeys = new Set<string>()
  const recyclableIds = new Set<string>()
  /** 回收任务的「已尝试次数」，按同一批去重键映射给重新入队的任务 */
  const recycledAttempts = new Map<string, number>()

  for (const t of campaign.tasks) {
    const key = t.company && t.jobTitle
      ? `${t.platform}:${t.company.trim()}:${t.jobTitle.trim()}`
      : ''
    if (isRecyclableTask(t, now, cooldownMs)) {
      recyclableIds.add(t.id)
      const carried = (Number(t.attempts) || 0) + 1
      for (const idKey of [t.id, t.jobId, key]) {
        if (!idKey) continue
        recycledAttempts.set(idKey, Math.max(recycledAttempts.get(idKey) || 0, carried))
      }
      continue
    }
    existingIds.add(t.id)
    if (key) existingJobKeys.add(key)
  }

  let recycled = 0
  if (recyclableIds.size > 0) {
    const before = campaign.tasks.length
    campaign.tasks = campaign.tasks.filter((t) => !recyclableIds.has(t.id))
    recycled = before - campaign.tasks.length
  }

  let addedCount = 0
  for (const t of tasks) {
    const key = t.company && t.jobTitle ? `${t.platform}:${t.company.trim()}:${t.jobTitle.trim()}` : ''
    if (!existingIds.has(t.id) && (!key || !existingJobKeys.has(key))) {
      const carried = Math.max(
        recycledAttempts.get(t.id) || 0,
        (t.jobId && recycledAttempts.get(t.jobId)) || 0,
        (key && recycledAttempts.get(key)) || 0,
      )
      campaign.tasks.push({
        ...t,
        status: 'pending',
        attempts: Math.min(carried, MAX_TASK_RECYCLES),
        createdAt: now,
      })
      existingIds.add(t.id)
      if (key) existingJobKeys.add(key)
      addedCount++
    }
  }

  if (addedCount > 0 || recycled > 0) {
    await saveCampaign(campaign)
  }
  if (recycled > 0) {
    await appendCampaignLog(
      `♻️ 已回收 ${recycled} 条历史跳过岗位记录（冷却 ${Math.round(cooldownMs / 60_000)} 分钟，最多重试 ${MAX_TASK_RECYCLES} 次），按当前门槛与策略重新评估入队（新增 ${addedCount} 个）`,
      'info',
    )
  }
  return addedCount
}

/**
 * 清空待投队列中未执行的 pending 任务（可按平台或全量清空）
 * 保留已完成 (done)、已跳过 (skipped) 和已失败 (failed) 的审计历史，只清除挂起中的 pending 任务
 */
export async function clearPendingTasks(platform?: PlatformId): Promise<number> {
  const campaign = await getCampaign()
  if (!campaign) return 0

  const prevPending = campaign.tasks.filter((t) => t.status === 'pending' && (!platform || t.platform === platform)).length
  if (prevPending === 0) return 0

  campaign.tasks = campaign.tasks.filter((t) => {
    if (t.status !== 'pending') return true
    if (platform && t.platform !== platform) return true
    return false
  })

  await saveCampaign(campaign)
  await appendCampaignLog(
    `🧹 已清空 ${platform ? `[${platform}] ` : ''}${prevPending} 个旧页面的待投缓存任务，准备同步当前最新页面岗位...`,
    'info',
  )
  return prevPending
}

/**
 * 领取下一个可执行的任务
 * 1. 自动回收过期的 running 租约（防卡死，超期 3 分钟且 attempts < 2 退回 pending，否则标记 failed）
 * 2. 找到第一个处于已启用(enabled)、未满额且未 exhausted 平台的 pending 任务
 * 3. 标记为 running 并附带租约时间戳
 */
export async function claimNextTask(leaseDurationMs = 180_000): Promise<{ task: ApplyTask | null; campaign: Campaign | null }> {
  const campaign = await getCampaign()
  if (!campaign || campaign.status !== 'running') {
    return { task: null, campaign }
  }

  const now = Date.now()

  // 1. 租约回收检查
  for (const t of campaign.tasks) {
    if (t.status === 'running' && t.leaseUntil && t.leaseUntil <= now) {
      if (t.attempts < 2) {
        t.status = 'pending'
        t.leaseUntil = undefined
      } else {
        t.status = 'failed'
        t.failReason = '任务执行租约超时且重试超限'
        t.leaseUntil = undefined
        const pQuota = campaign.quotas[t.platform]
        if (pQuota) pQuota.failed++
      }
    }
  }

  // 2. 查找可调度的任务（必须该平台已启用 enabled !== false）
  const nextTask = campaign.tasks.find((t) => {
    if (t.status !== 'pending') return false
    const quota = campaign.quotas[t.platform]
    if (!quota) return false
    if (!quota.enabled) return false // 用户未开启此平台，跳过！
    if (quota.exhausted) return false
    if (quota.applied >= quota.quota) return false
    return true
  })

  if (!nextTask) {
    await saveCampaign(campaign)
    return { task: null, campaign }
  }

  // 3. 标记为 running 并锁定
  nextTask.status = 'running'
  nextTask.attempts++
  nextTask.leaseUntil = now + leaseDurationMs
  campaign.lastTickAt = now

  await saveCampaign(campaign)
  return { task: nextTask, campaign }
}

/** 更新特定任务的结果 */
export async function updateTaskResult(
  taskId: string,
  updates: Partial<Pick<ApplyTask, 'status' | 'matchScore' | 'matchReason' | 'greeting' | 'appliedAt' | 'failReason' | 'aiCostTokens'>>,
): Promise<Campaign | null> {
  const campaign = await getCampaign()
  if (!campaign) return null

  const task = campaign.tasks.find((t) => t.id === taskId)
  if (!task) return campaign

  const prevStatus = task.status
  Object.assign(task, updates)
  task.leaseUntil = undefined // 清除租约

  // 同步更新统计指标
  const pQuota = campaign.quotas[task.platform]
  if (pQuota && prevStatus !== task.status) {
    if (task.status === 'done') {
      pQuota.applied++
      campaign.consecutiveRestCounter = (campaign.consecutiveRestCounter || 0) + 1
    } else if (task.status === 'skipped') {
      pQuota.skipped++
    } else if (task.status === 'failed') {
      pQuota.failed++
    }
  }

  if (updates.aiCostTokens) {
    campaign.aiBudgetUsed = (campaign.aiBudgetUsed || 0) + updates.aiCostTokens
  }

  await saveCampaign(campaign)
  return campaign
}

/** 标记某平台日限已耗尽 */
export async function markPlatformExhausted(platform: PlatformId): Promise<void> {
  const campaign = await getCampaign()
  if (!campaign) return
  if (campaign.quotas[platform]) {
    campaign.quotas[platform].exhausted = true
    await appendCampaignLog(`⚠️ 平台 ${platform} 今日投递上限已耗尽，已自动切出`, 'warn')
  }
  await saveCampaign(campaign)
}

/**
 * 解除指定平台的日限耗尽标记，让它重新参与调度。
 * 必达模式下「所有平台都 exhausted」不能成为停机理有 —— 冷却一段时间后
 * 由后台显式调用此函数重试，而不是永远退出。
 */
export async function clearPlatformExhausted(platforms: PlatformId[]): Promise<number> {
  if (!platforms || platforms.length === 0) return 0
  const ids = new Set(platforms)
  const campaign = await getCampaign()
  if (!campaign) return 0
  let cleared = 0
  for (const pid of Object.keys(campaign.quotas) as PlatformId[]) {
    const q = campaign.quotas[pid]
    if (ids.has(pid) && q?.exhausted) {
      q.exhausted = false
      cleared++
    }
  }
  if (cleared > 0) await saveCampaign(campaign)
  return cleared
}
