import { db, type InterviewEvent } from './index'

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substring(2)
}

export async function getInterviewEvents(): Promise<InterviewEvent[]> {
  return db.interviewEvents.orderBy('interviewDate').toArray()
}

export async function getUpcomingInterviews(): Promise<InterviewEvent[]> {
  const now = new Date().toISOString()
  return db.interviewEvents
    .where('interviewDate')
    .above(now)
    .toArray()
}

export async function saveInterviewEvent(
  data: Omit<InterviewEvent, 'id' | 'notified' | 'createdAt'>
): Promise<InterviewEvent> {
  const event: InterviewEvent = {
    ...data,
    id: generateId(),
    notified: false,
    createdAt: new Date().toISOString(),
  }
  await db.interviewEvents.add(event)
  return event
}

export async function markNotified(id: string): Promise<void> {
  await db.interviewEvents.update(id, { notified: true })
}

export async function deleteInterviewEvent(id: string): Promise<void> {
  await db.interviewEvents.delete(id)
}
