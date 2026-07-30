import { db, type MatchAnalysisRecord } from './index'
import type { JobMatchAnalysis } from '../ai'

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

/** 保存一次匹配分析记录 */
export async function saveMatchAnalysis(params: {
  resumeId: string
  resumeName: string
  jobDescription: string
  jobTitle?: string
  result: JobMatchAnalysis
}): Promise<MatchAnalysisRecord> {
  const record: MatchAnalysisRecord = {
    id: generateId(),
    resumeId: params.resumeId,
    resumeName: params.resumeName,
    jobDescription: params.jobDescription,
    jobTitle: params.jobTitle,
    result: {
      overallScore: params.result.overallScore,
      skillMatch: params.result.skillMatch,
      skillGap: params.result.skillGap,
      strengths: params.result.strengths,
      weaknesses: params.result.weaknesses,
      improvementSuggestions: params.result.improvementSuggestions,
      recommendation: params.result.recommendation,
    },
    createdAt: new Date().toISOString(),
  }
  await db.matchAnalyses.put(record)
  return record
}

/** 获取所有分析记录，最新在前 */
export async function getAllMatchAnalyses(): Promise<MatchAnalysisRecord[]> {
  return db.matchAnalyses.orderBy('createdAt').reverse().toArray()
}

/** 按简历 ID 筛选分析记录 */
export async function getMatchAnalysesByResume(resumeId: string): Promise<MatchAnalysisRecord[]> {
  return db.matchAnalyses.where('resumeId').equals(resumeId).reverse().sortBy('createdAt')
}

/** 删除单条记录 */
export async function deleteMatchAnalysis(id: string): Promise<void> {
  await db.matchAnalyses.delete(id)
}

/** 删除某简历的所有分析记录 */
export async function deleteMatchAnalysesByResume(resumeId: string): Promise<void> {
  await db.matchAnalyses.where('resumeId').equals(resumeId).delete()
}

/** 获取记录总数 */
export async function getMatchAnalysisCount(): Promise<number> {
  return db.matchAnalyses.count()
}
