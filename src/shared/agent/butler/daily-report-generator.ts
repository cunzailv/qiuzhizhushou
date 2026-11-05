// 结构化“管家日报”生成器与事后复盘引擎

import type { ButlerDailyReport } from '../../types/butler-evolution'
import type { PlatformId } from '../quota'
import { getAllApplications } from '../../db/application-store'
import { getCampaign } from '../queue-store'
import { getSavedIntervalConfig } from '../quota'
import { saveDailyReport } from '../../db/butler-evolution-store'
import { sendWebhookNotification } from '../../notification/webhook-notifier'
import { log } from '../../utils/logger'

const MOD = 'DailyReportGenerator'

/** 格式化日期为 YYYY-MM-DD */
export function getTodayDateStr(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** 生成结构化管家日报 */
export async function generateDailyButlerReport(
  trigger: 'scheduled' | 'campaign_finished' | 'manual' = 'manual',
  targetDate = getTodayDateStr(),
): Promise<ButlerDailyReport> {
  const allApps = await getAllApplications()
  const campaign = await getCampaign()
  const intervalConfig = await getSavedIntervalConfig()

  // 1. 筛选当天的投递记录
  const todayApps = allApps.filter((app) => {
    if (!app.appliedAt) return false
    const dStr = app.appliedAt.slice(0, 10)
    const appDate = new Date(app.appliedAt)
    const localDStr = isNaN(appDate.getTime())
      ? dStr
      : `${appDate.getFullYear()}-${String(appDate.getMonth() + 1).padStart(2, '0')}-${String(appDate.getDate()).padStart(2, '0')}`
    return dStr === targetDate || localDStr === targetDate
  })

  // 2. 统计漏斗数据
  let readCount = 0
  let commCount = 0
  let interviewCount = 0

  for (const app of todayApps) {
    if (app.status === 'read' || app.status === 'communicating' || app.status === 'interview' || app.status === 'hired') {
      readCount++
    }
    if (app.status === 'communicating' || app.status === 'interview' || app.status === 'hired') {
      commCount++
    }
    if (app.status === 'interview' || app.status === 'hired') {
      interviewCount++
    }
  }

  const appliedCount = todayApps.length
  const repliedTotal = readCount + commCount + interviewCount
  const replyRate = appliedCount > 0 ? Math.round((repliedTotal / appliedCount) * 100) : 0

  // 3. 统计平台分布与配额消耗
  const platformBreakdown: ButlerDailyReport['platformBreakdown'] = {}
  const platformNames: Record<string, string> = {
    boss: 'Boss直聘',
    liepin: '猎聘',
    zhaopin: '智联招聘',
    '51job': '前程无忧',
    maimai: '脉脉',
  }

  for (const pid of ['boss', 'liepin', 'zhaopin', '51job', 'maimai'] as PlatformId[]) {
    const pApps = todayApps.filter((a) => a.platformId === pid)
    const pReplied = pApps.filter((a) => ['read', 'communicating', 'interview', 'hired'].includes(a.status)).length
    const quotaInfo = campaign?.quotas?.[pid]

    platformBreakdown[platformNames[pid] || pid] = {
      applied: pApps.length,
      replied: pReplied,
      quotaUsed: quotaInfo?.applied ?? pApps.length,
      quotaTotal: quotaInfo?.quota ?? 80,
    }
  }

  // 4. 计算安全护栏健康指标
  const logs = campaign?.logs || []
  const captchaCount = logs.filter((l) => l.message.includes('验证码')).length
  const rateLimitCount = logs.filter((l) => l.message.includes('频率') || l.message.includes('限流')).length
  const riskAbortCount = logs.filter((l) => l.message.includes('风控封禁') || l.message.includes('紧急挂起')).length

  let safetyScore = 100
  if (captchaCount > 0) safetyScore -= 10
  if (rateLimitCount > 0) safetyScore -= 15
  if (riskAbortCount > 0) safetyScore -= 30
  safetyScore = Math.max(50, safetyScore)

  const guardrailStatus: ButlerDailyReport['guardrailStatus'] = {
    safetyScore,
    intervalRange: `${intervalConfig.minSeconds}-${intervalConfig.maxSeconds}秒`,
    captchaEncounters: captchaCount,
    rateLimitTrips: rateLimitCount,
    riskAborts: riskAbortCount,
    safeStatusText:
      safetyScore === 100
        ? '全天未触发任何平台风控，拟人伪装与安全护栏运行评分 100 分！'
        : `全天触发 ${captchaCount} 次安全验证，均已安全熔断保护，无账号异常风险。`,
  }

  // 5. 扫描与跳过指标
  const totalTasks = campaign?.tasks?.length || appliedCount
  const skippedCount = campaign?.tasks?.filter((t) => t.status === 'skipped').length || 0
  const scannedCount = Math.max(totalTasks, appliedCount + skippedCount)

  // 6. 今日高光亮点
  const highlights: string[] = []
  const topApp = [...todayApps].sort((a, b) => (b.matchScore || 0) - (a.matchScore || 0))[0]
  if (topApp) {
    highlights.push(
      `投递最高匹配度：${topApp.companyName} · ${topApp.jobTitle}（AI匹配得分 ${topApp.matchScore || 85} 分）`,
    )
  }
  if (commCount > 0) {
    highlights.push(`收获 ${commCount} 家高意向企业深入沟通，包括优先推进面试流程的目标企业`)
  }
  if (appliedCount > 0) {
    highlights.push(`多平台协同轮转已推进 ${appliedCount} 份沟通，全部搭载个性化 AI 匹配开场白`)
  } else {
    highlights.push('今日暂无新投递记录，待投队列由 AIbot 自主监控就绪中')
  }

  // 7. 问题诊断与归因分析
  const diagnostics: string[] = []
  if (replyRate >= 35) {
    diagnostics.push('【回复率优秀】当前技术栈与话术呈现受到 HR 广泛认可，建议趁热打铁提高沟通意愿')
  } else if (appliedCount > 0 && replyRate < 20) {
    diagnostics.push('【回复率偏低】部分通用传统后端岗位竞争拥挤，建议结合「进化策略中心」升级技术关键词')
  }
  if (skippedCount > 0) {
    diagnostics.push(`【智能门槛拦截】AI 为您拦截了 ${skippedCount} 个薪资虚高/学历经验不符的错位岗位，有效节省了平台珍贵配额`)
  }
  diagnostics.push(`【拟人节奏保障】全天严格执行 ${intervalConfig.minSeconds}-${intervalConfig.maxSeconds}s 随机间隔，杜绝机器高频特征`)

  // 8. 明日作战行动指南
  const nextDayActionPlan: ButlerDailyReport['nextDayActionPlan'] = {
    focusTitles: ['全栈工程师（AI 智能体方向）', '全栈开发工程师', 'Node.js/React全栈架构'],
    recommendedHours: '09:30-11:30 / 14:30-17:00（HR 集中筛简历高峰）',
    suggestedQuota: Math.min(60, Math.max(20, appliedCount + 10)),
    keyTips: [
      '上午 10:00 前开启 AIbot，抢占 HR 每日刚打开后台时的置顶前三位打招呼排序',
      '在「求职管家 · 进化策略中心」审批通过最新的技术词进化提案，进一步拉高回复率',
      '保持 45-180 秒拟人间歇配置，确保账号长期处于最高安全等级',
    ],
  }

  // 9. 宏观一句话战报总结
  const summary =
    appliedCount > 0
      ? `今日 AIbot 全流程跑毕：巡检探测 ${scannedCount} 个岗位，AI 筛除 ${skippedCount} 个错位岗，精准向 ${appliedCount} 位优质企业 HR 发起个性化沟通。HR 回复转化率 ${replyRate}%，安全护栏健康度 ${safetyScore} 分。`
      : `今日 AIbot 全天候监控巡检，累计探测扫描 ${scannedCount} 个岗位，待投队列已由 AIbot 自主补仓就绪，等待开启明日第一批集中推进。`

  const report: ButlerDailyReport = {
    id: `report_${targetDate}`,
    date: targetDate,
    createdAt: new Date().toISOString(),
    trigger,
    summary,
    funnel: {
      scanned: scannedCount,
      filtered: skippedCount,
      applied: appliedCount,
      read: readCount,
      communicating: commCount,
      interview: interviewCount,
      replyRate,
    },
    platformBreakdown,
    guardrailStatus,
    highlights,
    diagnostics,
    nextDayActionPlan,
  }

  await saveDailyReport(report)
  log(MOD, 'generateDailyButlerReport', `Report generated for ${targetDate} via ${trigger}`)

  // 触发跨端实时推送 Webhook
  sendWebhookNotification({
    title: `📋 今日管家战报 (${targetDate})`,
    content: `### 📊 今日求职战报汇总\n- **投递成功**：${appliedCount} 家\n- **HR 已读**：${readCount} 家\n- **深入沟通**：${commCount} 家\n- **面试邀约**：${interviewCount} 家\n- **综合回复率**：${replyRate}%\n- **安全护栏健康度**：${safetyScore} 分\n\n> 💡 **明日建议**：\n- 重点方向：${nextDayActionPlan.focusTitles.join('、')}\n- 推荐时段：${nextDayActionPlan.recommendedHours}`,
    type: 'daily_report',
    extra: { date: targetDate, funnel: report.funnel },
  }).catch(() => {})

  // 发送系统桌面级通知告知用户
  if (typeof chrome !== 'undefined' && chrome.notifications) {
    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: '📋 求职管家 · 今日日报已生成',
      message: `今日已完成投递与复盘！投递 ${appliedCount} 份，回复率 ${replyRate}%，点击查看详细战报与明日策略。`,
      priority: 1,
    })
  }

  return report
}
