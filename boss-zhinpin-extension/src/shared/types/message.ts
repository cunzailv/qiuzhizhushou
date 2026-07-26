// Chrome extension messaging types
import type { JobCard } from './job'

export type MessageType =
  // Popup -> Background
  | 'START_APPLY'
  | 'STOP_APPLY'
  | 'GET_STATS'
  | 'GET_SETTINGS'
  | 'GET_DEFAULT_RESUME'
  | 'SAVE_APPLICATION'
  | 'UPDATE_SETTINGS'
  | 'TEST_API'
  // Background -> Content
  | 'EXECUTE_APPLY'
  | 'EXECUTE_STOP'
  | 'EXTRACT_JOB_CARDS'
  | 'SIMULATE_APPLY'
  | 'GET_PAGE_INFO'
  // Content -> Background
  | 'JOB_CARDS_EXTRACTED'
  | 'APPLY_RESULT'
  | 'PAGE_INFO'
  // Common
  | 'NOTIFY'
  | 'ERROR'

export interface ChromeMessage {
  type: MessageType
  payload?: unknown
}

export interface StatsPayload {
  totalApplications: number
  todayApplications: number
  interviewCount: number
  readCount: number
  passRate: number
  recentApplications: Array<{
    id: string
    jobTitle: string
    companyName: string
    status: string
    appliedAt: string
  }>
}

export interface ApplyResultPayload {
  success: boolean
  jobId: string
  error?: string
}

export interface PageInfoPayload {
  url: string
  title: string
  pageType: 'search' | 'detail' | 'chat' | 'other'
}

export interface ExtractedJobCardsPayload {
  cards: JobCard[]
  total: number
}

export interface ApiTestPayload {
  success: boolean
  message: string
}
