import Dexie, { type Table } from 'dexie'
import type { Resume } from '../types/resume'
import type { Application } from '../types/application'
import type { AgentSkill } from '../agent/types'
import type { CompanyMemory, DecisionLog, FollowUpSuggestion } from '../types/butler'
import type { AuditRecord } from './audit-store'
import type { CareerProfile } from './career-store'

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

/** 岗位匹配分析记录 */
export interface MatchAnalysisRecord {
  id: string
  resumeId: string
  resumeName: string
  jobDescription: string
  jobTitle?: string
  result: {
    overallScore: number
    skillMatch: string[]
    skillGap: string[]
    strengths: string[]
    weaknesses: string[]
    improvementSuggestions: string[]
    recommendation: string
  }
  createdAt: string
}

export class BossZhipinDB extends Dexie {
  resumes!: Table<Resume, string>
  applications!: Table<Application, string>
  blacklist!: Table<BlacklistItem, string>
  interviewEvents!: Table<InterviewEvent, string>
  settings!: Table<{ key: string; value: unknown }, string>
  matchAnalyses!: Table<MatchAnalysisRecord, string>
  agentSkills!: Table<AgentSkill, string>
  companyMemories!: Table<CompanyMemory, string>
  decisionLogs!: Table<DecisionLog, string>
  followUps!: Table<FollowUpSuggestion, string>
  auditLogs!: Table<AuditRecord, string>
  careerProfiles!: Table<CareerProfile, string>

  constructor() {
    super('BossZhipinAssistant')

    this.version(1).stores({
      resumes: 'id, name, isDefault, createdAt',
      applications: 'id, jobId, companyName, status, appliedAt, matchScore',
      blacklist: 'id, companyName',
      interviewEvents: 'id, applicationId, interviewDate',
      settings: 'key',
    })

    this.version(2).stores({
      matchAnalyses: 'id, resumeId, createdAt',
    })

    this.version(3).stores({
      agentSkills: 'id, platform, pageType, goal, [platform+pageType+goal], lastUsedAt, expiresAt',
    })

    this.version(4).stores({
      companyMemories: 'id, companyName, jobTitle, updatedAt',
      decisionLogs: 'id, source, subject, createdAt',
      followUps: 'id, applicationId, companyName, createdAt, dismissed',
    })

    this.version(5).stores({
      auditLogs: 'id, createdAt, source, platform, result',
      careerProfiles: 'id',
    })

    this.version(6).stores({
      agentSkills: 'id, platform, pageType, goal, [platform+pageType+goal], lastUsedAt, expiresAt',
    }).upgrade(async (tx) => {
      // F3：为存量技能补齐 enabled 标记（旧记录默认启用）
      await tx
        .table<AgentSkill, string>('agentSkills')
        .toCollection()
        .modify((skill: AgentSkill) => {
          if (skill.enabled === undefined) skill.enabled = true
        })
    })
  }
}

export const db = new BossZhipinDB()
