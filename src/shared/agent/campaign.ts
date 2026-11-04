// Campaign 生命周期控制与战报聚合

import type { Campaign, CampaignLog } from './queue-store'
import {
  getCampaign,
  saveCampaign,
  createNewCampaign,
  appendCampaignLog,
} from './queue-store'
import type { PlatformId, TimeWindow, IntervalConfig } from './quota'
import { isWithinWindow, getSavedTimeWindows, getSavedIntervalConfig, DEFAULT_INTERVAL_CONFIG } from './quota'

export interface CampaignStats {
  id: string
  status: Campaign['status']
  pausedReason?: Campaign['pausedReason']
  totalTasks: number
  pending: number
  running: number
  done: number
  skipped: number
  failed: number
  paused: number
  platformBreakdown: Record<
    PlatformId,
    {
      quota: number
      applied: number
      skipped: number
      failed: number
      exhausted: boolean
      enabled: boolean
    }
  >
  aiBudgetUsed: number
  isWithinWindow: boolean
  intervalConfig: IntervalConfig
  restUntil?: number
  logs: CampaignLog[]
}

/** 聚合当前 Campaign 的战报与统计信息 */
export function aggregateCampaignStats(campaign: Campaign): CampaignStats {
  let pending = 0
  let running = 0
  let done = 0
  let skipped = 0
  let failed = 0
  let paused = 0

  for (const t of campaign.tasks) {
    switch (t.status) {
      case 'pending':
        pending++
        break
      case 'running':
        running++
        break
      case 'done':
        done++
        break
      case 'skipped':
        skipped++
        break
      case 'failed':
        failed++
        break
      case 'paused':
        paused++
        break
    }
  }

  return {
    id: campaign.id,
    status: campaign.status,
    pausedReason: campaign.pausedReason,
    totalTasks: campaign.tasks.length,
    pending,
    running,
    done,
    skipped,
    failed,
    paused,
    platformBreakdown: campaign.quotas,
    aiBudgetUsed: campaign.aiBudgetUsed,
    isWithinWindow: isWithinWindow(campaign.windows),
    intervalConfig: campaign.intervalConfig || DEFAULT_INTERVAL_CONFIG,
    restUntil: campaign.restUntil,
    logs: campaign.logs || [],
  }
}

/** 启动全新的投递活动或复用已有的未完成活动 */
export async function startCampaign(
  customQuotas?: Partial<Record<PlatformId, number>>,
  enabledPlatforms?: PlatformId[],
  windows?: TimeWindow[],
): Promise<Campaign> {
  const actualWindows = windows && windows.length > 0 ? windows : await getSavedTimeWindows()
  const savedInterval = await getSavedIntervalConfig()
  const existing = await getCampaign()
  if (existing && (existing.status === 'running' || existing.status === 'paused')) {
    existing.status = 'running'
    existing.pausedReason = undefined
    existing.windows = actualWindows
    existing.intervalConfig = savedInterval
    if (enabledPlatforms && enabledPlatforms.length > 0) {
      for (const pid of Object.keys(existing.quotas) as PlatformId[]) {
        existing.quotas[pid].enabled = enabledPlatforms.includes(pid)
      }
    }
    await saveCampaign(existing)
    await appendCampaignLog('🚀 AIbot 流水线启动，开始全自动巡检与调度投递...', 'info')
    return existing
  }
  const cmp = await createNewCampaign(customQuotas, enabledPlatforms, actualWindows)
  await appendCampaignLog('🚀 AIbot 流水线创建并开跑...', 'info')
  return cmp
}

/** 暂停 Campaign（可附带挂起原因：验证码/风控/人工等） */
export async function pauseCampaign(reason: Campaign['pausedReason'] = 'user'): Promise<Campaign | null> {
  const campaign = await getCampaign()
  if (!campaign) return null
  campaign.status = 'paused'
  campaign.pausedReason = reason
  await appendCampaignLog(`⏸️ AIbot 已暂停 (原因: ${reason})`, 'warn')
  await saveCampaign(campaign)
  return campaign
}

/** 恢复 Campaign（人工解除验证码后从断点继续） */
export async function resumeCampaign(): Promise<Campaign | null> {
  const campaign = await getCampaign()
  if (!campaign) return null
  campaign.status = 'running'
  campaign.pausedReason = undefined
  // 将处于 paused 态的任务恢复为 pending
  for (const t of campaign.tasks) {
    if (t.status === 'paused') {
      t.status = 'pending'
    }
  }
  await appendCampaignLog('▶️ AIbot 已恢复执行，继续派发投递任务', 'success')
  await saveCampaign(campaign)
  return campaign
}

/** 终止 Campaign */
export async function abortCampaign(reason?: string): Promise<Campaign | null> {
  const campaign = await getCampaign()
  if (!campaign) return null
  campaign.status = 'aborted'
  if (reason) campaign.pausedReason = 'blocked'
  await appendCampaignLog(`⏹️ AIbot 流水线已终止${reason ? ` (${reason})` : ''}`, 'error')
  await saveCampaign(campaign)
  return campaign
}

/** 检查 Campaign 是否所有已启用的平台配额都已经达成或任务已空 */
export function isCampaignFinished(campaign: Campaign): boolean {
  if (campaign.status === 'done' || campaign.status === 'aborted') return true

  // 只检查已启用的平台
  const platforms = (Object.keys(campaign.quotas) as PlatformId[]).filter(
    (p) => campaign.quotas[p].enabled !== false,
  )
  if (platforms.length === 0) return true

  const allPlatformsCompleted = platforms.every((p) => {
    const q = campaign.quotas[p]
    return q.exhausted || q.applied >= q.quota
  })
  if (allPlatformsCompleted) return true

  // 检查是否已无 pending 且无 running 任务（只统计已启用的平台）
  const hasPending = campaign.tasks.some(
    (t) =>
      (t.status === 'pending' || t.status === 'running') &&
      campaign.quotas[t.platform]?.enabled !== false,
  )
  return !hasPending && campaign.tasks.length > 0
}
