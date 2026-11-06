// 持久化投递任务队列与 Campaign 存储
// 基于 chrome.storage.local，实现跨 Service Worker 重启、跨标签页的可靠调度

import type { PlatformId, TimeWindow, IntervalConfig } from './quota'
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
  consecutiveRestCounter: number // 连投计数（用于每15-25份强制休息）
  restUntil?: number             // 强制休息到期时间戳
  logs: CampaignLog[]            // 每时每刻行为日志流水
}

const STORAGE_KEY_CAMPAIGN = 'apply_campaign_v1'

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
  const initialTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`

  const campaign: Campaign = {
    id: `cmp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    createdAt: new Date().toISOString(),
    status: 'running',
    tasks: [],
    quotas,
    windows: actualWindows,
    intervalConfig,
    aiBudgetUsed: 0,
    consecutiveRestCounter: 0,
    logs: [
      {
        id: `init_${Date.now()}`,
        time: initialTime,
        level: 'info',
        message: '🚀 AIbot 初始化完成，准备就绪',
      },
    ],
  }

  await saveCampaign(campaign)
  return campaign
}

/** 追加一条行为流水日志 */
export async function appendCampaignLog(
  message: string,
  level: CampaignLog['level'] = 'info',
): Promise<void> {
  const campaign = await getCampaign()
  if (!campaign) return

  const now = new Date()
  const time = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`

  if (!campaign.logs) campaign.logs = []
  campaign.logs.push({
    id: `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    time,
    level,
    message,
  })

  // 最多保留最近 120 条日志
  if (campaign.logs.length > 120) {
    campaign.logs = campaign.logs.slice(-120)
  }

  await saveCampaign(campaign)
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
export async function appendTasksToCampaign(tasks: Omit<ApplyTask, 'status' | 'attempts' | 'createdAt'>[]): Promise<number> {
  const campaign = await getCampaign()
  if (!campaign) return 0

  const existingIds = new Set(campaign.tasks.map((t) => t.id))
  const existingJobKeys = new Set(
    campaign.tasks
      .filter((t) => t.company && t.jobTitle)
      .map((t) => `${t.platform}:${t.company.trim()}:${t.jobTitle.trim()}`)
  )
  let addedCount = 0

  for (const t of tasks) {
    const key = t.company && t.jobTitle ? `${t.platform}:${t.company.trim()}:${t.jobTitle.trim()}` : ''
    if (!existingIds.has(t.id) && (!key || !existingJobKeys.has(key))) {
      campaign.tasks.push({
        ...t,
        status: 'pending',
        attempts: 0,
        createdAt: Date.now(),
      })
      existingIds.add(t.id)
      if (key) existingJobKeys.add(key)
      addedCount++
    }
  }

  if (addedCount > 0) {
    await saveCampaign(campaign)
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
