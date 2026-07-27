import { db } from './index'
import type { Application, ApplicationStatus } from '../types/application'

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
  data: Omit<Application, 'id' | 'appliedAt' | 'updatedAt' | 'status' | 'notes'>
): Promise<Application> {
  const now = new Date().toISOString()
  const app: Application = {
    ...data,
    id: generateId(),
    status: 'applied',
    notes: '',
    appliedAt: now,
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
