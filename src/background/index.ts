// Background Service Worker
import {
  getInterviewEvents,
  markNotified,
} from '../shared/db/interview-store'
import { getDefaultResume } from '../shared/db/resume-store'
import { getApplicationByJobId, saveApplication } from '../shared/db/application-store'
import { setSharedResumeSummary } from '../shared/db/shared-state'
import { resetDailyCounter } from '../shared/antiBot'
import { log, logError, logGroup, logGroupEnd } from '../shared/utils/logger'
import type { JobCard, MatchResult } from '../shared/types/job'

const MOD = 'Background'

// Listen for installation
chrome.runtime.onInstalled.addListener(() => {
  log(MOD, 'installed', 'Extension installed')

  // Set up daily reset alarm
  chrome.alarms.create('daily-reset', {
    periodInMinutes: 1440, // 24 hours
  })

  // Set up interview check alarm (every 30 minutes)
  chrome.alarms.create('interview-check', {
    periodInMinutes: 30,
  })
  log(MOD, 'installed', 'Alarms created: daily-reset (24h), interview-check (30min)')
})

// Handle alarms
chrome.alarms.onAlarm.addListener(async (alarm) => {
  log(MOD, 'alarm', `Alarm fired: ${alarm.name}`)

  if (alarm.name === 'daily-reset') {
    await resetDailyCounter()
    log(MOD, 'alarm', 'Daily counter reset')
  }

  if (alarm.name === 'interview-check') {
    log(MOD, 'alarm', 'Checking upcoming interviews...')
    await checkUpcomingInterviews()
  }
})

// Check for upcoming interviews and send notifications
async function checkUpcomingInterviews(): Promise<void> {
  const events = await getInterviewEvents()
  const now = Date.now()
  log(MOD, 'interview-check', `Found ${events.length} events`)

  for (const event of events) {
    if (event.notified) continue

    const eventTime = new Date(event.interviewDate).getTime()
    const timeUntil = eventTime - now

    // Notify if interview is within 1 hour
    if (timeUntil > 0 && timeUntil <= 60 * 60 * 1000) {
      const minutesUntil = Math.round(timeUntil / 60000)
      log(MOD, 'interview-check', `Notifying: ${event.companyName} - ${event.jobTitle} in ${minutesUntil}min`)

      chrome.notifications.create(`interview-${event.id}`, {
        type: 'basic',
        iconUrl: 'icons/icon128.png',
        title: '面试提醒',
        message: `${event.companyName} - ${event.jobTitle} 面试将在 ${minutesUntil} 分钟后开始`,
        priority: 2,
      })

      await markNotified(event.id)
    }
  }
}

// Listen for messages from popup/content scripts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const senderInfo = sender.tab ? `tab:${sender.tab.id}` : sender.id ? `ext:${sender.id}` : 'unknown'
  log(MOD, 'onMessage', `Received: ${message.type} from ${senderInfo}`)

  // Handle various message types from popup
  if (message.type === 'GET_STATS') {
    log(MOD, 'GET_STATS', 'Handled by popup directly')
    sendResponse({ success: true })
  }

  if (message.type === 'NOTIFY') {
    log(MOD, 'NOTIFY', message.payload?.message || '')
    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: '智能求职助手',
      message: message.payload?.message || '',
      priority: 1,
    })
    sendResponse({ success: true })
  }

  // Content script requests default resume from extension's IndexedDB
  if (message.type === 'GET_DEFAULT_RESUME') {
    logGroup(MOD, 'GET_DEFAULT_RESUME')
    log(MOD, 'GET_DEFAULT_RESUME', 'Querying IndexedDB for default resume...')

    getDefaultResume().then(async (resume) => {
      if (resume) {
        log(MOD, 'GET_DEFAULT_RESUME', `Found in IndexedDB: ${resume.name} (id=${resume.id}, skills=${resume.structuredData?.skills?.length})`)
        await setSharedResumeSummary(resume)
        log(MOD, 'GET_DEFAULT_RESUME', 'Restored shared resume state')
        logGroupEnd()
        sendResponse({ success: true, data: resume })
        return
      }

      log(MOD, 'GET_DEFAULT_RESUME', 'Not found in IndexedDB, trying chrome.storage.local fallback...')
      // Fallback: try chrome.storage.local
      try {
        const stored = await chrome.storage.local.get('shared_default_resume_full')
        const fullResume = stored['shared_default_resume_full'] as Record<string, unknown> | undefined
        if (fullResume && typeof fullResume === 'object' && 'structuredData' in fullResume) {
          log(MOD, 'GET_DEFAULT_RESUME', `Found in chrome.storage fallback: ${(fullResume as { name?: string }).name}`)
          logGroupEnd()
          sendResponse({ success: true, data: fullResume })
          return
        }
        log(MOD, 'GET_DEFAULT_RESUME', 'Not found in chrome.storage either')
      } catch (e) {
        logError(MOD, 'GET_DEFAULT_RESUME', e, 'chrome.storage fallback failed')
      }

      log(MOD, 'GET_DEFAULT_RESUME', 'No resume found anywhere')
      logGroupEnd()
      sendResponse({ success: true, data: null })
    }).catch((err) => {
      logError(MOD, 'GET_DEFAULT_RESUME', err, 'IndexedDB query failed')
      logGroupEnd()
      sendResponse({ success: false, error: String(err) })
    })
    return true // Keep channel open for async response
  }

  if (message.type === 'SAVE_APPLICATION') {
    const payload = message.payload as {
      job?: JobCard
      match?: MatchResult
      resumeId?: string
      platformId?: string
    }
    const { job, match, resumeId, platformId } = payload
    if (!job || !match || !resumeId) {
      sendResponse({ success: false, error: 'Invalid application payload' })
      return false
    }

    getApplicationByJobId(job.id)
      .then((existing) => {
        if (existing) return existing
        return saveApplication({
          jobId: job.id,
          jobTitle: job.title,
          companyName: job.companyName,
          companyLogo: job.companyLogo,
          salary: job.salary,
          location: job.location,
          experience: job.experience,
          education: job.education,
          tags: job.tags,
          jobDescription: job.jobDescription,
          resumeId,
          matchScore: match.scoreBypassed ? null : match.score,
          matchReason: match.recommendation,
          bossName: job.bossName,
          bossTitle: job.bossTitle,
          platformId: platformId || job.platformId || 'unknown',
        })
      })
      .then((application) => sendResponse({ success: true, data: application }))
      .catch((error) => {
        logError(MOD, 'SAVE_APPLICATION', error)
        sendResponse({ success: false, error: String(error) })
      })
    return true
  }

  log(MOD, 'onMessage', `Unhandled message type: ${message.type}`)
  return true
})

// Keep service worker alive
self.addEventListener('activate', () => {
  log(MOD, 'lifecycle', 'Service Worker activated')
})

log(MOD, 'lifecycle', 'Background script loaded')
export {}
