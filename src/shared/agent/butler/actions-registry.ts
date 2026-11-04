// 标准 Action 规范与注册表 (借鉴 CopilotKit 声明式 Action 设计)
import { saveCandidatePreferences, getCandidatePreferences, getSetting, setSetting } from '../../db/settings-store'
import { getDefaultResume, updateResume } from '../../db/resume-store'
import { setSharedResumeSummary } from '../../db/shared-state'
import { getAllApplications, getStats, clearApplications } from '../../db/application-store'
import { exportApplications } from '../../export/csv-export'
import { addToBlacklist } from '../../db/blacklist-store'
import {
  saveIntervalConfig,
  getSavedIntervalConfig,
  saveTimeWindows,
  parseTimeString,
  type TimeWindow,
} from '../quota'
import type { CandidateProfilePreferences } from '../../types/candidate-profile'
import type { ApplyFilters } from '../../types/filters'

export interface ButlerActionResult {
  success: boolean
  message: string
  data?: any
}

export interface ButlerAction<T = any> {
  name: string
  displayName: string
  description: string
  parameters: Record<string, any> // JSON Schema
  isDangerous?: boolean
  handler: (args: T) => Promise<ButlerActionResult>
}

// ─── 1. 更新求职者画像与底线 (薪资、到岗、求职状态、底线) ───
const updateCandidatePreferencesAction: ButlerAction<Partial<CandidateProfilePreferences>> = {
  name: 'update_candidate_preferences',
  displayName: '修改求职画像与底线',
  description: '更新求职者的在职状态、最快到岗周期、期望薪资范围或硬性底线要求',
  parameters: {
    type: 'object',
    properties: {
      expectedSalaryMin: { type: 'number', description: '期望薪资下限(K)' },
      expectedSalaryMax: { type: 'number', description: '期望薪资上限(K)' },
      employmentStatus: {
        type: 'string',
        enum: ['unemployed_immediate', 'employed_month', 'employed_exploring'],
        description: '在职状态：离职随时到岗、在职月内到岗、在职看新机会',
      },
      availableDays: { type: 'string', description: '最快到岗周期，如 随时到岗、最快1周到岗' },
      bottomLines: { type: 'array', items: { type: 'string' }, description: '底线ID列表' },
      customBottomLines: { type: 'string', description: '自定义底线文本' },
    },
  },
  handler: async (args) => {
    const updated = await saveCandidatePreferences(args)
    const details: string[] = []
    if (args.expectedSalaryMin !== undefined || args.expectedSalaryMax !== undefined) {
      details.push(`期望薪资设为 ${updated.expectedSalaryMin ?? '?'}-${updated.expectedSalaryMax ?? '?'}K`)
    }
    if (args.availableDays) {
      details.push(`到岗周期设为【${updated.availableDays}】`)
    }
    if (args.employmentStatus) {
      const statusLabel =
        updated.employmentStatus === 'employed_month'
          ? '在职-月内到岗'
          : updated.employmentStatus === 'employed_exploring'
          ? '在职-看新机会'
          : '离职-随时到岗'
      details.push(`求职状态更新为【${statusLabel}】`)
    }
    if (args.customBottomLines) {
      details.push(`新增底线【${args.customBottomLines}】`)
    }
    return {
      success: true,
      message: details.length > 0 ? `已成功为您更新求职画像：${details.join('，')}。` : '求职画像已更新。',
      data: updated,
    }
  },
}

// ─── 2. 更新默认简历内容与技能栈 ───
interface UpdateResumeArgs {
  addSkills?: string[]
  removeSkills?: string[]
  summary?: string
}

const updateResumeContentAction: ButlerAction<UpdateResumeArgs> = {
  name: 'update_resume_content',
  displayName: '更新简历技能与简介',
  description: '在当前默认简历中添加或删除技能标签，或者修改自我评价/个人亮点',
  parameters: {
    type: 'object',
    properties: {
      addSkills: { type: 'array', items: { type: 'string' }, description: '需要增加的技术技能' },
      removeSkills: { type: 'array', items: { type: 'string' }, description: '需要移除的技能' },
      summary: { type: 'string', description: '更新后的个人总结或核心亮点' },
    },
  },
  handler: async (args) => {
    const resume = await getDefaultResume()
    if (!resume) {
      return { success: false, message: '未找到默认简历，请先在「简历库」上传一份简历后再试。' }
    }

    const currentSkills = new Set<string>(resume.structuredData?.skills || [])

    if (args.addSkills && args.addSkills.length > 0) {
      args.addSkills.forEach((s) => currentSkills.add(s.trim()))
    }
    if (args.removeSkills && args.removeSkills.length > 0) {
      args.removeSkills.forEach((s) => currentSkills.delete(s.trim()))
    }

    const updatedSkillsList: string[] = Array.from(currentSkills)
    const newStructuredData = {
      ...(resume.structuredData || {
        name: resume.name,
        phone: '',
        email: '',
        city: '',
        yearsOfExperience: 0,
        education: [],
        workExperience: [],
        projects: [],
        skills: [],
        summary: '',
      }),
      skills: updatedSkillsList,
      summary: args.summary ? args.summary : resume.structuredData?.summary || '',
    }

    let newProfile = resume.profile
    if (args.summary) {
      newProfile = resume.profile
        ? { ...resume.profile, profile: args.summary }
        : {
            yearsOfExperience: resume.structuredData?.yearsOfExperience || 0,
            skillLevels: [],
            profile: args.summary,
            achievementHighlights: [],
            source: 'local' as const,
            generatedAt: new Date().toISOString(),
          }
    }

    await updateResume(resume.id, {
      structuredData: newStructuredData,
      profile: newProfile,
    })

    const updatedResume: typeof resume = {
      ...resume,
      structuredData: newStructuredData,
      profile: newProfile,
    }
    await setSharedResumeSummary(updatedResume)

    const changes: string[] = []
    if (args.addSkills && args.addSkills.length > 0) changes.push(`增补技能【${args.addSkills.join('、')}】`)
    if (args.removeSkills && args.removeSkills.length > 0) changes.push(`移除技能【${args.removeSkills.join('、')}】`)
    if (args.summary) changes.push(`更新个人亮点`)

    return {
      success: true,
      message: `已为您在默认简历《${resume.name}》中成功${changes.join('，')}！现有核心技能数：${updatedSkillsList.length} 个。`,
      data: { skills: updatedSkillsList },
    }
  },
}

// ─── 3. 调整 Bot 调度工作时间与拟人间歇 ───
interface UpdateScheduleArgs {
  workingHours?: string // 如 "09:30-18:00"
  minInterval?: number // 如 60
  maxInterval?: number // 如 150
  dailyQuota?: number // 如 40
}

const updateScheduleAndPacingAction: ButlerAction<UpdateScheduleArgs> = {
  name: 'update_schedule_and_pacing',
  displayName: '调整工作时段与拟人节奏',
  description: '配置 AIbot 的运行工作时段窗口、拟人间歇随机等待秒数以及每日最大投递限额',
  parameters: {
    type: 'object',
    properties: {
      workingHours: { type: 'string', description: '工作时段，格式为 HH:mm-HH:mm，如 09:30-18:00' },
      minInterval: { type: 'number', description: '拟人最小间歇等待秒数' },
      maxInterval: { type: 'number', description: '拟人最大间歇等待秒数' },
      dailyQuota: { type: 'number', description: '每日投递安全限额' },
    },
  },
  handler: async (args) => {
    const feedback: string[] = []

    // 1. 拟人间歇
    if (args.minInterval !== undefined || args.maxInterval !== undefined) {
      const current = await getSavedIntervalConfig()
      const minSec = args.minInterval ?? current.minSeconds
      const maxSec = args.maxInterval ?? current.maxSeconds
      if (minSec > 0 && maxSec >= minSec) {
        await saveIntervalConfig({ minSeconds: minSec, maxSeconds: maxSec })
        feedback.push(`拟人间歇更新为【${minSec}-${maxSec} 秒】随机等待`)
      }
    }

    // 2. 工作时段窗口
    if (args.workingHours) {
      const parts = args.workingHours.split('-')
      if (parts.length === 2) {
        const start = parseTimeString(parts[0].trim())
        const end = parseTimeString(parts[1].trim())
        if (start && end) {
          const newWin: TimeWindow = {
            startHour: start.hour,
            startMin: start.min,
            endHour: end.hour,
            endMin: end.min,
          }
          await saveTimeWindows([newWin])
          feedback.push(`工作时间窗口设为【${args.workingHours}】`)
        }
      }
    }

    // 3. 每日限额
    if (args.dailyQuota !== undefined && args.dailyQuota > 0) {
      await setSetting('dailyQuota', args.dailyQuota)
      feedback.push(`每日投递配额设为【${args.dailyQuota} 次】`)
    }

    return {
      success: true,
      message: feedback.length > 0 ? `已成功调整运行策略：${feedback.join('，')}。` : '运行参数已更新。',
      data: args,
    }
  },
}

// ─── 4. 一键导出投递数据报表 (CSV) ───
interface ExportApplicationsArgs {
  dateRange?: 'today' | 'week' | 'all'
}

const exportApplicationsCsvAction: ButlerAction<ExportApplicationsArgs> = {
  name: 'export_applications_csv',
  displayName: '导出投递数据报表',
  description: '将投递历史记录过滤并导出为标准 CSV 电子表格，触发浏览器本地下载',
  parameters: {
    type: 'object',
    properties: {
      dateRange: { type: 'string', enum: ['today', 'week', 'all'], description: '导出范围：今天、本周或全部' },
    },
  },
  handler: async (args) => {
    const all = await getAllApplications()
    if (all.length === 0) {
      return { success: false, message: '当前数据库中暂无投递记录，投递产生数据后即可随时导出。' }
    }

    let targetApps = all
    const range = args.dateRange || 'all'
    const todayStr = new Date().toISOString().substring(0, 10)

    if (range === 'today') {
      targetApps = all.filter((a) => a.appliedAt && a.appliedAt.startsWith(todayStr))
    } else if (range === 'week') {
      const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString()
      targetApps = all.filter((a) => a.appliedAt && a.appliedAt >= sevenDaysAgo)
    }

    if (targetApps.length === 0) {
      return { success: false, message: `在选定周期（${range}）内未检索到投递记录，现有总记录数为 ${all.length} 条。` }
    }

    const fileName = `求职助手投递明细_${range}_${todayStr}.csv`
    exportApplications({
      applications: targetApps,
      format: 'csv',
      fileName,
    })

    return {
      success: true,
      message: `已为您生成并导出【${targetApps.length} 条】投递记录报表（文件名: ${fileName}），已开始下载！`,
      data: { count: targetApps.length },
    }
  },
}

// ─── 5. 查询实时投递漏斗与深度分析 ───
interface QueryStatsArgs {
  period?: 'today' | 'all'
  analyze?: boolean
}

const queryApplicationStatsAction: ButlerAction<QueryStatsArgs> = {
  name: 'query_application_stats',
  displayName: '分析投递数据与漏斗',
  description: '查询并统计系统中的投递总数、今日投递、已读数、面试邀约数以及深度分析转化漏斗与策略建议',
  parameters: {
    type: 'object',
    properties: {
      period: { type: 'string', enum: ['today', 'all'], description: '查询周期：今日 或 全量' },
      analyze: { type: 'boolean', description: '是否生成深度诊断与策略建议' },
    },
  },
  handler: async (args) => {
    const stats = await getStats()
    const all = await getAllApplications()
    const todayStr = new Date().toISOString().substring(0, 10)
    const todayApps = all.filter((a) => a.appliedAt && a.appliedAt.startsWith(todayStr))
    const repliedCount = all.filter(
      (a) => a.status === 'communicating' || a.status === 'interview' || a.status === 'hired',
    ).length
    const replyRate = stats.total > 0 ? Math.round((repliedCount / stats.total) * 100) : 0

    // 若指定了今日或分析模式
    if (args.period === 'today' || args.analyze) {
      if (todayApps.length === 0) {
        const noAppsMessage = `📊 **今日投递分析简报**（${todayStr}）：

📅 **今日数据**：
- 今日发起沟通/投递：**0** 家
- 历史累计投递：${stats.total} 家（综合回复率 ${replyRate}%）
- 历史面试邀约：${stats.interview} 家（面试转化率 ${stats.passRate}%）

💡 **管家诊断与建议**：
1. **启动投递**：今日尚未执行新的自动化投递，可前往首页点击「🚀 开始智能沟通」或开启后台 Campaign。
2. **黄金时段建议**：目前推荐的最佳沟通时段为 **09:30-11:30** 与 **14:00-17:30**，HR 在线率最高。
3. **快速调整**：如需微调策略，可直接对我吩咐：*“工作时间设为 09:30-18:00”* 或 *“期望薪资改成 20-30K”*。`

        return {
          success: true,
          message: noAppsMessage,
          data: { stats, todayCount: 0 },
        }
      }

      // 今日有投递数据：输出详细转化漏斗与具体岗位追踪
      const todayRead = todayApps.filter((a) => a.status === 'read').length
      const todayReplied = todayApps.filter(
        (a) => a.status === 'communicating' || a.status === 'interview' || a.status === 'hired',
      ).length
      const todayInterviews = todayApps.filter((a) => a.status === 'interview' || a.status === 'hired').length
      const scores = todayApps.map((a) => a.matchScore).filter((s): s is number => typeof s === 'number' && s > 0)
      const avgScore = scores.length > 0 ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : '未记录'

      const sampleJobs = todayApps.slice(0, 5).map((a) => {
        const scoreStr = a.matchScore ? ` (${a.matchScore}分)` : ''
        const statusMap: Record<string, string> = {
          applied: '已投递',
          read: 'HR已读👀',
          communicating: '沟通中💬',
          interview: '面试邀约🏆',
          rejected: '不合适❌',
          hired: '已录用🎉',
        }
        const st = statusMap[a.status] || a.status
        return `  - 【${a.companyName}】${a.jobTitle}${scoreStr} ➔ 状态: **${st}**`
      }).join('\n')

      const todayAnalysis = `📊 **今日投递深度分析报告**（${todayStr}）：

📈 **今日转化漏斗**：
- 🎯 **今日投递**：${todayApps.length} 家
- 📨 **HR已读**：${todayRead} 家（阅读率 ${Math.round((todayRead / todayApps.length) * 100)}%）
- 💬 **积极互动/沟通**：${todayReplied} 家（回复率 ${Math.round((todayReplied / todayApps.length) * 100)}%）
- 🏆 **面试邀约**：${todayInterviews} 家
- ⭐ **平均匹配分**：${avgScore}

📋 **今日投递岗位明细**：
${sampleJobs}
${todayApps.length > 5 ? `  *(另有 ${todayApps.length - 5} 家岗位记录在此省略)*\n` : ''}
💡 **管家智能洞察与策略建议**：
1. **已读跟进建议**：对于已读未回的岗位，建议在次日早 09:30-10:00 黄金时段发起礼貌追问，提醒 HR 注意。
2. **岗位精准度**：今日平均匹配分为 ${avgScore}，${typeof avgScore === 'number' && avgScore >= 75 ? '岗位相关度极高，符合主攻方向' : '建议适当优化过滤关键词以提升匹配精准度'}。
3. **数据报表导出**：如需完整表格，可随时对我说：*“导出今天的投递记录为 CSV”*。`

      return {
        success: true,
        message: todayAnalysis,
        data: { stats, todayCount: todayApps.length, todayApps },
      }
    }

    // 全量统计看板
    const summary = `📊 **全量投递数据统计看板**：
- 🎯 **累计投递**：${stats.total} 家
- 📅 **今日投递**：${stats.today} 家
- 💬 **积极互动/回复**：${repliedCount} 家（回复率约 ${replyRate}%）
- 🏆 **面试邀约**：${stats.interview} 家（转化率 ${stats.passRate}%）
- 📨 **HR已读**：${stats.read} 家

💡 提示：对我说 *“分析今天投递”* 可获取今日专项转化漏斗与策略建议！`

    return {
      success: true,
      message: summary,
      data: { stats, replyRate, repliedCount },
    }
  },
}

// ─── 6. 黑名单运维 (公司 / 关键词) ───
interface ManageBlacklistArgs {
  type: 'company' | 'keyword'
  value: string
  reason?: string
}

const manageBlacklistAction: ButlerAction<ManageBlacklistArgs> = {
  name: 'manage_blacklist',
  displayName: '添加黑名单',
  description: '将目标企业或岗位敏感关键词加入黑名单，自动在扫描沟通时跳过',
  parameters: {
    type: 'object',
    required: ['value'],
    properties: {
      type: { type: 'string', enum: ['company', 'keyword'], description: '类型：公司名 或 关键词' },
      value: { type: 'string', description: '要拉黑的公司全称或关键词' },
      reason: { type: 'string', description: '拉黑原因说明' },
    },
  },
  handler: async (args) => {
    const val = (args.value || '').trim()
    if (!val) return { success: false, message: '请提供要拉黑的具体公司名称或关键词。' }

    if (args.type === 'company' || !args.type) {
      await addToBlacklist(val, args.reason || '通过管家对话助手添加')
      return {
        success: true,
        message: `已成功将公司【${val}】加入黑名单，Bot 后续扫描与打招呼时将永久跳过该公司。`,
        data: { company: val },
      }
    } else {
      const filters = await getSetting<Partial<ApplyFilters>>('applyFilters', {})
      const currentExcluded = (filters.excludeKeywords || '').split(/\s+/).filter(Boolean)
      if (!currentExcluded.includes(val)) {
        currentExcluded.push(val)
        await setSetting('applyFilters', {
          ...filters,
          excludeKeywords: currentExcluded.join(' '),
        })
      }
      return {
        success: true,
        message: `已成功将关键词【${val}】追加到过滤排除列表中，后续将自动过滤包含该词的岗位。`,
        data: { keyword: val },
      }
    }
  },
}

// ─── 7. 高危动作：清空历史数据 (需审批确认) ───
const clearHistoryDataAction: ButlerAction<{ scope?: 'all' }> = {
  name: 'clear_history_data',
  displayName: '清空历史投递数据',
  description: '彻底清空本地数据库中的投递记录与跟踪状态（不可逆操作，需人工二次审批确认）',
  isDangerous: true, // ⚠️ 标记为高危操作，调度器拦截并生成审批卡片
  parameters: {
    type: 'object',
    properties: {
      scope: { type: 'string', enum: ['all'] },
    },
  },
  handler: async () => {
    await clearApplications()
    return {
      success: true,
      message: '已为您清空本地数据库中的全部历史投递记录。',
    }
  },
}

// ─── 8. 清空待投队列并重获 ───
const clearPendingQueueAction: ButlerAction<{ recollect?: boolean }> = {
  name: 'clear_pending_queue',
  displayName: '清空待投队列并重获',
  description: '清空当前待投队列中未执行的旧页面缓存岗位，并立即根据当前最新网页重新探测获取岗位',
  parameters: {
    type: 'object',
    properties: {
      recollect: { type: 'boolean', description: '是否清空后立即重新采集，默认为 true' },
    },
  },
  handler: async (args) => {
    try {
      const res = (await chrome.runtime.sendMessage({
        type: 'CLEAR_PENDING_TASKS',
        payload: { recollect: args.recollect !== false },
      })) as { success: boolean; data?: { cleared: number; recollected: boolean } }
      const count = res?.data?.cleared ?? 0
      return {
        success: true,
        message: `已为您清空 ${count} 个旧页面残留的待投任务，并触发按当前最新页面重新抓取新岗位！`,
        data: res?.data,
      }
    } catch {
      return {
        success: true,
        message: '已通知后台清空过期待投队列并重新获取当前页面岗位。',
      }
    }
  },
}

// ─── 动作注册表中心 ───
const registeredActions = new Map<string, ButlerAction<any>>([
  [updateCandidatePreferencesAction.name, updateCandidatePreferencesAction],
  [updateResumeContentAction.name, updateResumeContentAction],
  [updateScheduleAndPacingAction.name, updateScheduleAndPacingAction],
  [exportApplicationsCsvAction.name, exportApplicationsCsvAction],
  [queryApplicationStatsAction.name, queryApplicationStatsAction],
  [manageBlacklistAction.name, manageBlacklistAction],
  [clearHistoryDataAction.name, clearHistoryDataAction],
  [clearPendingQueueAction.name, clearPendingQueueAction],
])

export function getRegisteredActions(): ButlerAction[] {
  return Array.from(registeredActions.values())
}

export function findAction(name: string): ButlerAction | undefined {
  return registeredActions.get(name)
}
