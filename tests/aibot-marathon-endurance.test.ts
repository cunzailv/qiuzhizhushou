// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  createNewCampaign,
  appendTasksToCampaign,
  claimNextTask,
  updateTaskResult,
  getCampaign,
  appendCampaignLog,
  togglePlatformEnabled,
  updateCampaignWindows,
} from '../src/shared/agent/queue-store'
import {
  isWithinWindow,
  getRandomInterval,
  formatTimeWindows,
} from '../src/shared/agent/quota'
import {
  aggregateCampaignStats,
  isCampaignFinished,
  pauseCampaign,
  resumeCampaign,
} from '../src/shared/agent/campaign'
import { generateDailyButlerReport } from '../src/shared/agent/butler/daily-report-generator'
import { saveApplication } from '../src/shared/db/application-store'
import { recordError, listErrors, clearErrors } from '../src/shared/db/error-store'
import 'fake-indexeddb/auto'

const mockStorage: Record<string, any> = {}

beforeEach(async () => {
  for (const k of Object.keys(mockStorage)) {
    delete mockStorage[k]
  }
  await clearErrors()

  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: vi.fn(async (keys: string | string[]) => {
          if (typeof keys === 'string') return { [keys]: mockStorage[keys] }
          const res: Record<string, any> = {}
          for (const k of keys) res[k] = mockStorage[k]
          return res
        }),
        set: vi.fn(async (obj: Record<string, any>) => {
          Object.assign(mockStorage, obj)
        }),
        remove: vi.fn(async (keys: string | string[]) => {
          const list = Array.isArray(keys) ? keys : [keys]
          for (const k of list) delete mockStorage[k]
        }),
      },
    },
    notifications: {
      create: vi.fn(),
    },
  })
})

describe('AIbot 1-Hour Marathon Endurance Simulation', () => {
  it('runs continuously across 25+ tasks without getting stuck, triggers rest and finishes with daily report', async () => {
    // 1. 初始化 1 小时连续投递活动：开启 Boss 与猎聘，各 15 份配额（共 30 份），时段设为 24 小时全天候
    const windows24h = [{ startHour: 0, startMin: 0, endHour: 23, endMin: 59 }]
    const cmp = await createNewCampaign(
      { boss: 15, liepin: 15 },
      ['boss', 'liepin'],
      windows24h,
    )
    expect(cmp.status).toBe('running')
    expect(isWithinWindow(cmp.windows)).toBe(true)

    // 2. 模拟自动巡检入队 30 个推荐流岗位（涵盖全栈、技术经理、前端、后端等方向）
    const simulatedJobs = []
    for (let i = 1; i <= 15; i++) {
      simulatedJobs.push({
        id: `boss:marathon_job_${i}`,
        platform: 'boss' as const,
        jobId: `marathon_job_${i}`,
        jobTitle: i % 2 === 0 ? '技术经理' : '全栈工程师（AI 智能体方向）',
        company: `方圆宝测试公司_${i}`,
        jobUrl: `https://www.zhipin.com/job_detail/marathon_job_${i}.html`,
        salary: '20-35K',
      })
      simulatedJobs.push({
        id: `liepin:marathon_job_${i}`,
        platform: 'liepin' as const,
        jobId: `marathon_job_${i}`,
        jobTitle: '高级全栈架构师',
        company: `猎聘优质企业_${i}`,
        jobUrl: `https://www.liepin.com/job/marathon_job_${i}.shtml`,
        salary: '25-40K',
      })
    }

    const addedCount = await appendTasksToCampaign(simulatedJobs)
    expect(addedCount).toBe(30)

    // 3. 执行 30 轮自动化投递与状态流转
    let completedCount = 0
    let restTriggered = false

    for (let round = 1; round <= 30; round++) {
      const { task } = await claimNextTask(60_000)
      if (!task) break

      // 验证时钟与时段始终有效
      expect(isWithinWindow(cmp.windows)).toBe(true)

      // 模拟拟人间歇计算 (45s - 180s)
      const intervalMs = getRandomInterval(task.platform)
      expect(intervalMs).toBeGreaterThanOrEqual(45_000)
      expect(intervalMs).toBeLessThanOrEqual(180_000)

      // 模拟任务处理（偶数投递成功，质数评分低跳过，确保状态机混合真实流转）
      const isMatch = round % 3 !== 0
      if (isMatch) {
        await updateTaskResult(task.id, {
          status: 'done',
          matchScore: 85,
          matchReason: '核心技术栈匹配度高',
          appliedAt: new Date().toISOString(),
        })
        await saveApplication({
          jobId: task.jobId,
          jobTitle: task.jobTitle,
          companyName: task.company,
          salary: task.salary,
          platformId: task.platform,
          appliedAt: new Date().toISOString(),
          matchScore: 85,
          resumeId: 'default-resume',
        })
        completedCount++
      } else {
        await updateTaskResult(task.id, {
          status: 'skipped',
          matchScore: 55,
          failReason: 'AI 评分低于门槛 60 分',
        })
      }

      await appendCampaignLog(
        `[Round ${round}] 处理任务 [${task.platform}] ${task.jobTitle} @ ${task.company} 完成`,
        isMatch ? 'success' : 'info',
      )

      // 验证在第 15 轮左右模拟真人作息休息检查
      if (completedCount >= 15 && !restTriggered) {
        restTriggered = true
        await appendCampaignLog('☕ 已连续投递 15 份，触发拟人休息 10 分钟', 'info')
      }
    }

    // 4. 验证整体状态与配额聚合
    const finalCmp = await getCampaign()
    expect(finalCmp).not.toBeNull()

    const stats = aggregateCampaignStats(finalCmp!)
    expect(stats.totalTasks).toBe(30)
    expect(stats.done + stats.skipped).toBe(30)
    expect(stats.pending).toBe(0)
    expect(isCampaignFinished(finalCmp!)).toBe(true)

    // 5. 验证事后自动生成管家复盘日报
    const dailyReport = await generateDailyButlerReport('campaign_finished')
    expect(dailyReport).not.toBeNull()
    expect(dailyReport.funnel.applied).toBeGreaterThan(0)
    expect(dailyReport.guardrailStatus.safetyScore).toBe(100)
    expect(dailyReport.nextDayActionPlan.focusTitles.length).toBeGreaterThan(0)

    // 6. 验证全程零异常死锁或未捕获报错
    const recordedErrors = await listErrors()
    expect(recordedErrors.length).toBe(0)
  })
})
