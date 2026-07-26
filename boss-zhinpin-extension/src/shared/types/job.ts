export interface JobCard {
  id: string
  title: string
  companyName: string
  companyLogo: string
  salary: string
  location: string
  experience: string
  education: string
  tags: string[]
  jobDescription: string
  bossName: string
  bossTitle: string
  bossOnline: boolean
  publishedAt: string
  url: string
}

export interface MatchResult {
  jobId: string
  score: number
  scoreBypassed?: boolean
  skillMatch: string[]
  skillGap: string[]
  recommendation: string
  isRecommended: boolean
}
