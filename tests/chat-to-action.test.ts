import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  matchDeterministicAction,
  dispatchButlerChatMessage,
} from '../src/shared/agent/butler/chat-to-action'
import {
  findAction,
  getRegisteredActions,
} from '../src/shared/agent/butler/actions-registry'
import { getCandidatePreferences } from '../src/shared/db/settings-store'
import { getSavedIntervalConfig, getSavedTimeWindows } from '../src/shared/agent/quota'
import { getBlacklist } from '../src/shared/db/blacklist-store'
import { getAllApplications, saveApplication } from '../src/shared/db/application-store'

// Mock chrome storage
const storageMap: Record<string, any> = {}
;(globalThis as any).chrome = {
  storage: {
    local: {
      get: vi.fn(async (keys: any, cb?: (res: any) => void) => {
        let res: Record<string, any> = {}
        if (typeof keys === 'string') {
          res = { [keys]: storageMap[keys] }
        } else if (Array.isArray(keys)) {
          keys.forEach((k) => (res[k] = storageMap[k]))
        } else if (typeof keys === 'object' && keys !== null) {
          Object.keys(keys).forEach((k) => (res[k] = storageMap[k] !== undefined ? storageMap[k] : keys[k]))
        } else {
          res = { ...storageMap }
        }
        if (cb) cb(res)
        return res
      }),
      set: vi.fn(async (items: any, cb?: () => void) => {
        Object.assign(storageMap, items)
        if (cb) cb()
      }),
      remove: vi.fn(async (keys: any, cb?: () => void) => {
        const arr = Array.isArray(keys) ? keys : [keys]
        arr.forEach((k) => delete storageMap[k])
        if (cb) cb()
      }),
      clear: vi.fn(async (cb?: () => void) => {
        Object.keys(storageMap).forEach((k) => delete storageMap[k])
        if (cb) cb()
      }),
    },
  },
  runtime: {
    lastError: null,
  },
}

describe('对话式管家智能中控 (Chat-to-Action) 全流程测试', () => {
  beforeEach(() => {
    Object.keys(storageMap).forEach((k) => delete storageMap[k])
  })

  describe('1. 动作注册表 (Actions Registry)', () => {
    it('正确注册 8 大标准 Actions，符合 CopilotKit 规范', () => {
      const actions = getRegisteredActions()
      expect(actions.length).toBe(8)

      const names = actions.map((a) => a.name)
      expect(names).toContain('update_candidate_preferences')
      expect(names).toContain('update_resume_content')
      expect(names).toContain('update_schedule_and_pacing')
      expect(names).toContain('export_applications_csv')
      expect(names).toContain('query_application_stats')
      expect(names).toContain('manage_blacklist')
      expect(names).toContain('clear_history_data')
      expect(names).toContain('clear_pending_queue')

      const clearAction = findAction('clear_history_data')
      expect(clearAction?.isDangerous).toBe(true)
    })
  })

  describe('2. 高精度确定性规则解析器 (matchDeterministicAction)', () => {
    it('精准提取期望薪资修改指令', () => {
      const match = matchDeterministicAction('帮我把期望薪资改成 20-30K')
      expect(match).not.toBeNull()
      expect(match?.actionName).toBe('update_candidate_preferences')
      expect(match?.args.expectedSalaryMin).toBe(20)
      expect(match?.args.expectedSalaryMax).toBe(30)
    })

    it('精准提取到岗时间与求职状态', () => {
      const match = matchDeterministicAction('目前离职随时到岗，最快1周到岗')
      expect(match).not.toBeNull()
      expect(match?.actionName).toBe('update_candidate_preferences')
      expect(match?.args.availableDays).toBe('最快1周到岗')
      expect(match?.args.employmentStatus).toBe('unemployed_immediate')
    })

    it('精准提取求职底线', () => {
      const match = matchDeterministicAction('加一条底线：不接受大小周单休')
      expect(match).not.toBeNull()
      expect(match?.actionName).toBe('update_candidate_preferences')
      expect(match?.args.customBottomLines).toBe('不接受大小周单休')
    })

    it('精准提取简历增补技能', () => {
      const match = matchDeterministicAction('简历加上技能 Docker、K8s、Next.js')
      expect(match).not.toBeNull()
      expect(match?.actionName).toBe('update_resume_content')
      expect(match?.args.addSkills).toEqual(['Docker', 'K8s', 'Next.js'])
    })

    it('精准提取工作时段窗口', () => {
      const match = matchDeterministicAction('工作时间设为 09:30-18:00')
      expect(match).not.toBeNull()
      expect(match?.actionName).toBe('update_schedule_and_pacing')
      expect(match?.args.workingHours).toBe('09:30-18:00')
    })

    it('精准提取拟人间歇与每日配额', () => {
      const matchInterval = matchDeterministicAction('拟人间歇设为 60-150 秒')
      expect(matchInterval?.actionName).toBe('update_schedule_and_pacing')
      expect(matchInterval?.args.minInterval).toBe(60)
      expect(matchInterval?.args.maxInterval).toBe(150)

      const matchQuota = matchDeterministicAction('每日上限设为 50 次')
      expect(matchQuota?.actionName).toBe('update_schedule_and_pacing')
      expect(matchQuota?.args.dailyQuota).toBe(50)
    })

    it('精准提取报表导出与统计查询及分析', () => {
      const matchExport = matchDeterministicAction('导出今天的投递记录为 CSV 表格')
      expect(matchExport?.actionName).toBe('export_applications_csv')
      expect(matchExport?.args.dateRange).toBe('today')

      const matchStats = matchDeterministicAction('查一下今天的投递统计与回复率')
      expect(matchStats?.actionName).toBe('query_application_stats')
      expect(matchStats?.args.period).toBe('today')

      const matchAnalyze = matchDeterministicAction('分析今天投递')
      expect(matchAnalyze?.actionName).toBe('query_application_stats')
      expect(matchAnalyze?.args.period).toBe('today')
      expect(matchAnalyze?.args.analyze).toBe(true)
    })

    it('精准提取黑名单添加与高危清空', () => {
      const matchBlacklist = matchDeterministicAction('把 某某人力派遣公司 加入黑名单')
      expect(matchBlacklist?.actionName).toBe('manage_blacklist')
      expect(matchBlacklist?.args.value).toBe('某某人力派遣')

      const matchClear = matchDeterministicAction('帮我清空所有投递记录')
      expect(matchClear?.actionName).toBe('clear_history_data')

      const matchClearPending = matchDeterministicAction('页面换了，帮我清空待投队列并重新获取')
      expect(matchClearPending?.actionName).toBe('clear_pending_queue')
      expect(matchClearPending?.args.recollect).toBe(true)
    })
  })

  describe('3. 对话即操作调度与数据库持久化 (dispatchButlerChatMessage)', () => {
    it('执行期望薪资修改：真实写入 settings-store', async () => {
      const msg = await dispatchButlerChatMessage('把期望薪资调成 22-28K')
      expect(msg.role).toBe('assistant')
      expect(msg.actionResult?.success).toBe(true)
      expect(msg.content).toContain('22-28K')

      const prefs = await getCandidatePreferences()
      expect(prefs.expectedSalaryMin).toBe(22)
      expect(prefs.expectedSalaryMax).toBe(28)
    })

    it('执行拟人间歇修改：真实写入 aibot_interval_config', async () => {
      const msg = await dispatchButlerChatMessage('拟人间歇设为 50-160 秒')
      expect(msg.actionResult?.success).toBe(true)
      expect(msg.content).toContain('50-160 秒')

      const interval = await getSavedIntervalConfig()
      expect(interval.minSeconds).toBe(50)
      expect(interval.maxSeconds).toBe(160)
    })

    it('执行工作时间修改：真实写入 aibot_time_windows', async () => {
      const msg = await dispatchButlerChatMessage('工作时间设为 10:00-19:00')
      expect(msg.actionResult?.success).toBe(true)
      expect(msg.content).toContain('10:00-19:00')

      const windows = await getSavedTimeWindows()
      expect(windows[0].startHour).toBe(10)
      expect(windows[0].endHour).toBe(19)
    })

    it('执行公司拉黑：真实写入 blacklist 数据库', async () => {
      const msg = await dispatchButlerChatMessage('把 无良外包 科技公司加入黑名单')
      expect(msg.actionResult?.success).toBe(true)
      expect(msg.content).toContain('无良外包')

      const list = await getBlacklist()
      const found = list.find((item) => item.companyName.includes('无良外包'))
      expect(found).toBeDefined()
    })

    it('执行「分析今天投递」：完整输出转化漏斗与策略建议，绝不仅是口语敷衍', async () => {
      const msg = await dispatchButlerChatMessage('分析今天投递')
      expect(msg.actionResult?.success).toBe(true)
      expect(msg.content).toContain('今日投递分析')
      expect(msg.content).toContain('管家诊断与建议')
    })

    it('高危动作安全护栏：清空记录时拦截并返回待确认审批卡，未确认前不执行清空', async () => {
      // 预先存入一条投递数据
      await saveApplication({
        jobId: 'job_test_01',
        jobTitle: '全栈架构师',
        companyName: '测试科技',
        salary: '25-35K',
        location: '深圳',
        experience: '5年',
        education: '本科',
        tags: ['React'],
        jobDescription: '测试',
        resumeId: 'res_01',
        matchReason: '匹配',
        bossName: '张总',
        bossTitle: 'CTO',
      })

      const beforeApps = await getAllApplications()
      expect(beforeApps.length).toBeGreaterThan(0)

      // 发起清空指令
      const warningMsg = await dispatchButlerChatMessage('清空所有投递记录')
      expect(warningMsg.pendingApproval).toBeDefined()
      expect(warningMsg.pendingApproval?.actionName).toBe('clear_history_data')
      expect(warningMsg.content).toContain('高风险')

      // 验证未批准前数据依然完好无损
      const middleApps = await getAllApplications()
      expect(middleApps.length).toBe(beforeApps.length)

      // 用户在 UI 中点击「确认执行」
      const confirmMsg = await dispatchButlerChatMessage('', warningMsg.pendingApproval)
      expect(confirmMsg.actionResult?.success).toBe(true)
      expect(confirmMsg.content).toContain('已为您清空')

      // 验证此时已真正清空
      const afterApps = await getAllApplications()
      expect(afterApps.length).toBe(0)
    })
  })
})
