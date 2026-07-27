import Dexie, { type Table } from 'dexie'
import type { Resume } from '../types/resume'
import type { Application } from '../types/application'

export interface InterviewEvent {
  id: string
  applicationId: string
  companyName: string
  jobTitle: string
  interviewDate: string
  location: string
  notes: string
  notified: boolean
  createdAt: string
}

export interface BlacklistItem {
  id: string
  companyName: string
  reason: string
  addedAt: string
}

export class BossZhipinDB extends Dexie {
  resumes!: Table<Resume, string>
  applications!: Table<Application, string>
  blacklist!: Table<BlacklistItem, string>
  interviewEvents!: Table<InterviewEvent, string>
  settings!: Table<{ key: string; value: unknown }, string>

  constructor() {
    super('BossZhipinAssistant')

    this.version(1).stores({
      resumes: 'id, name, isDefault, createdAt',
      applications: 'id, jobId, companyName, status, appliedAt, matchScore',
      blacklist: 'id, companyName',
      interviewEvents: 'id, applicationId, interviewDate',
      settings: 'key',
    })
  }
}

export const db = new BossZhipinDB()
