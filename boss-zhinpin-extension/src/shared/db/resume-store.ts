import { db } from './index'
import type { Resume } from '../types/resume'

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substring(2)
}

export async function getAllResumes(): Promise<Resume[]> {
  const list = await db.resumes.orderBy('createdAt').reverse().toArray()
  return list
}

export async function getResumeById(id: string): Promise<Resume | undefined> {
  return db.resumes.get(id)
}

export async function getDefaultResume(): Promise<Resume | undefined> {
  // Boolean values are not valid IndexedDB keys, so query in memory.
  const all = await db.resumes.toArray()
  const existingDefault = all.find(r => r.isDefault === true)
  if (existingDefault) return existingDefault

  // Repair legacy data that has uploaded resumes but no default marker.
  const fallback = all.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
  if (!fallback) return undefined

  const updatedAt = new Date().toISOString()
  await db.resumes.update(fallback.id, { isDefault: true, updatedAt })
  return { ...fallback, isDefault: true, updatedAt }
}

export async function saveResume(resume: Omit<Resume, 'id' | 'createdAt' | 'updatedAt'>): Promise<Resume> {
  const now = new Date().toISOString()
  const newResume: Resume = {
    ...resume,
    id: generateId(),
    createdAt: now,
    updatedAt: now,
  }
  await db.resumes.add(newResume)
  return newResume
}

export async function updateResume(id: string, updates: Partial<Resume>): Promise<void> {
  await db.resumes.update(id, { ...updates, updatedAt: new Date().toISOString() })
}

export async function deleteResume(id: string): Promise<void> {
  await db.resumes.delete(id)
}

export async function setDefaultResume(id: string): Promise<void> {
  await db.transaction('rw', db.resumes, async () => {
    const all = await db.resumes.toArray()
    for (const r of all) {
      await db.resumes.update(r.id, { isDefault: r.id === id })
    }
  })
}

export async function getResumeCount(): Promise<number> {
  return db.resumes.count()
}
