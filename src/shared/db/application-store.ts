import { db } from './index'
import type { Application, ApplicationStatus } from '../types/application'
import { sendWebhookNotification } from '../notification/webhook-notifier'
import { recordOutcomeEvent } from './outcome-store'
import type { OutcomeEventKind } from './outcome-store'

/** 状态变更 → L3 结果事件；applied 由 AIbot 单独记录，这里不重复 */
const STATUS_OUTCOME_KIND: Partial<Record<ApplicationStatus, OutcomeEventKind>> = {
  read: 'read',
  communicating: 'communicating',
  interview: 'interview',
  rejected: 'rejected',
  hired: 'hired',
}

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substring(2)
}

export async function getAllApplications(): Promise<Application[]> {
  return db.applications.orderBy('appliedAt').reverse().toArray()
}

export async function getApplicationById(id: string): Promise<Application | undefined> {
  return db.applications.get(id)
}

export async function getApplicationByJobId(jobId: string): Promise<Application | undefined> {
  return db.applications.where('jobId').equals(jobId).first()
}

export async function saveApplication(
  data: Omit<Application, 'id' | 'appliedAt' | 'updatedAt' | 'status' | 'notes'> & { appliedAt?: string }
): Promise<Application> {
  const now = new Date().toISOString()
  const app: Application = {
    ...data,
    id: generateId(),
    status: 'applied',
    notes: '',
    matchScore: data.matchScore ?? null,
    appliedAt: data.appliedAt ?? now,
    updatedAt: now,
  }
  await db.applications.add(app)
  return app
}

export async function updateApplicationStatus(id: string, status: ApplicationStatus, notes?: string): Promise<void> {
  const updates: Partial<Application> = {
    status,
    updatedAt: new Date().toISOString(),
  }
  if (notes !== undefined) {
    updates.notes = notes
  }
  await db.applications.update(id, updates)

  // L3 结果回流：用户/外部把投递状态改成「已读、沟通中、面试、不合适」时，
  // 同步落一条可复盘的真实结果事件，供 planner 按搜索方向统计回复率。
  const outcomeKind = STATUS_OUTCOME_KIND[status]
  if (outcomeKind) {
    void (async () => {
      try {
        const app = await db.applications.get(id)
        if (!app) return
        await recordOutcomeEvent({
          kind: outcomeKind,
          jobId: app.jobId,
          jobTitle: app.jobTitle,
          company: app.companyName,
          platform: app.platformId,
          snippet: notes,
        })
      } catch {
        // 复盘记录失败不能影响状态更新
      }
    })()
  }

  // 触发跨端实时推送通知（如 HR 面试邀约）
  if (status === 'interview') {
    db.applications.get(id).then((app) => {
      if (app) {
        sendWebhookNotification({
          title: `🎉 收到面试邀约: ${app.companyName}`,
          content: `恭喜！岗位【${app.jobTitle}】已进入面试邀约阶段！\n\n- **公司**：${app.companyName}\n- **薪资**：${app.salary || '面议'}\n- **备注**：${notes || app.notes || '暂无备注'}`,
          type: 'interview',
          extra: { applicationId: id, company: app.companyName, jobTitle: app.jobTitle },
        }).catch(() => {})
      }
    }).catch(() => {})
  }
}

export async function getTodayCount(): Promise<number> {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const todayStr = today.toISOString()
  return db.applications.where('appliedAt').startsWith(todayStr.substring(0, 10)).count()
}

export async function getStats(): Promise<{
  total: number
  today: number
  interview: number
  read: number
  passRate: number
}> {
  const all = await db.applications.toArray()
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const todayStr = today.toISOString().substring(0, 10)

  const todayApps = all.filter((a) => a.appliedAt.startsWith(todayStr))
  const interviews = all.filter((a) => a.status === 'interview' || a.status === 'hired')
  const read = all.filter((a) => a.status === 'read').length
  const passRate = all.length > 0
    ? Math.round((interviews.length / all.length) * 100)
    : 0

  return {
    total: all.length,
    today: todayApps.length,
    interview: interviews.length,
    read,
    passRate,
  }
}

export async function updateApplicationNotes(id: string, notes: string): Promise<void> {
  await db.applications.update(id, { notes, updatedAt: new Date().toISOString() })
}

export async function clearApplications(): Promise<void> {
  await db.applications.clear()
}
