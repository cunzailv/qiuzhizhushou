export type ApplicationStatus =
  | 'applied'
  | 'read'
  | 'communicating'
  | 'interview'
  | 'rejected'
  | 'hired'

export const APPLICATION_STATUS_LABELS: Record<ApplicationStatus, string> = {
  applied: '已投递',
  read: 'HR已读',
  communicating: '沟通中',
  interview: '面试邀约',
  rejected: '不合适',
  hired: '已录用',
}

export const APPLICATION_STATUS_COLORS: Record<ApplicationStatus, string> = {
  applied: '#6366F1',
  read: '#3B82F6',
  communicating: '#F59E0B',
  interview: '#10B981',
  rejected: '#EF4444',
  hired: '#A78BFA',
}

export interface Application {
  id: string
  jobId: string
  jobTitle: string
  companyName: string
  companyLogo?: string
  salary: string
  location: string
  experience: string
  education: string
  tags: string[]
  jobDescription: string
  status: ApplicationStatus
  resumeId: string
  matchScore: number | null
  matchReason: string
  notes: string
  bossName: string
  bossTitle: string
  appliedAt: string
  updatedAt: string
  // 所属平台 id（如 boss / liepin），用于多平台区分投递记录
  platformId?: string
}
