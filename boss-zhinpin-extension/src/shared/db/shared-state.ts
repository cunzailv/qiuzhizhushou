/**
 * Shared state via chrome.storage.local — accessible from ALL extension contexts
 * (popup, background, content script, options page)
 *
 * Unlike IndexedDB (which uses the page origin for content scripts),
 * chrome.storage.local always belongs to the extension.
 *
 * We store the FULL resume data here (minus fileData ArrayBuffer which is not
 * JSON-serializable) so the content script can read it directly without
 * depending on the background service worker.
 */
import type { Resume } from '../types/resume'
import { log, logError, logGroup, logGroupEnd } from '../utils/logger'

const MOD = 'SharedState'
const RESUME_KEY = 'shared_default_resume_meta'
const RESUME_FULL_KEY = 'shared_default_resume_full'
const APPLICATION_IDS_KEY = 'shared_applied_job_ids'

/** Lightweight resume summary for cross-context sharing */
export interface ResumeSummary {
  id: string
  name: string
  fileName: string
  skills: string[]
  yearsOfExperience: number
  hasFullData: boolean
  updatedAt: string
}

// --------------- Resume Summary (quick check) ---------------

export async function setSharedResumeSummary(resume: Resume): Promise<void> {
  logGroup(MOD, 'setSharedResumeSummary')
  const summary: ResumeSummary = {
    id: resume.id,
    name: resume.name,
    fileName: resume.fileName,
    skills: resume.structuredData?.skills || [],
    yearsOfExperience: resume.structuredData?.yearsOfExperience || 0,
    hasFullData: true,
    updatedAt: resume.updatedAt,
  }
  await chrome.storage.local.set({ [RESUME_KEY]: summary })
  log(MOD, 'setSummary', `Summary synced: ${summary.name} (id=${summary.id}, skills=${summary.skills.length})`)

  // Also store the full resume (minus fileData) for content script direct access
  const resumeWithoutFileData = { ...resume } as Partial<Resume>
  delete resumeWithoutFileData.fileData
  await chrome.storage.local.set({ [RESUME_FULL_KEY]: resumeWithoutFileData })
  log(MOD, 'setSummary', `Full resume synced: ${resume.name} (rawText=${resume.rawText?.length || 0} chars)`)
  logGroupEnd()
}

export async function getSharedResumeSummary(): Promise<ResumeSummary | null> {
  try {
    const result = await chrome.storage.local.get(RESUME_KEY)
    const data = result[RESUME_KEY] as ResumeSummary | undefined
    if (data && data.hasFullData) {
      log(MOD, 'getSummary', `Found: ${data.name} (id=${data.id}, skills=${data.skills.length})`)
      return data
    }
    log(MOD, 'getSummary', 'No resume summary in chrome.storage')
    return null
  } catch (err) {
    logError(MOD, 'getSummary', err)
    return null
  }
}

export async function clearSharedResumeSummary(): Promise<void> {
  await chrome.storage.local.remove([RESUME_KEY, RESUME_FULL_KEY])
  log(MOD, 'clearSummary', 'Resume summary + full resume cleared')
}

// --------------- Full Resume (for AI matching) ---------------

/**
 * Get the full resume data from chrome.storage.local.
 * Returns everything except fileData (ArrayBuffer is not JSON-serializable).
 */
export async function getSharedFullResume(): Promise<Omit<Resume, 'fileData'> | null> {
  try {
    const result = await chrome.storage.local.get(RESUME_FULL_KEY)
    const data = result[RESUME_FULL_KEY] as Omit<Resume, 'fileData'> | undefined
    if (data && data.structuredData) {
      log(MOD, 'getFullResume', `Found: ${data.name} (skills=${data.structuredData.skills?.length}, rawText=${data.rawText?.length || 0} chars)`)
      return data
    }
    log(MOD, 'getFullResume', 'No full resume in chrome.storage')
    return null
  } catch (err) {
    logError(MOD, 'getFullResume', err)
    return null
  }
}

// --------------- Applied Jobs ---------------

export async function addSharedAppliedJobId(jobId: string): Promise<void> {
  const result = await chrome.storage.local.get(APPLICATION_IDS_KEY)
  const ids: string[] = (result[APPLICATION_IDS_KEY] as string[]) || []
  if (!ids.includes(jobId)) {
    ids.push(jobId)
    await chrome.storage.local.set({ [APPLICATION_IDS_KEY]: ids })
    log(MOD, 'addAppliedJob', `Added: ${jobId} (total: ${ids.length})`)
  } else {
    log(MOD, 'addAppliedJob', `Already exists: ${jobId}`)
  }
}

export async function getSharedAppliedJobIds(): Promise<string[]> {
  const result = await chrome.storage.local.get(APPLICATION_IDS_KEY)
  const ids = (result[APPLICATION_IDS_KEY] as string[]) || []
  log(MOD, 'getAppliedJobs', `Found ${ids.length} applied job IDs`)
  return ids
}
