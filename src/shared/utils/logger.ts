/**
 * Centralized logging utility.
 * All logs prefixed with [求职助手] for easy filtering in DevTools.
 *
 * Usage:
 *   import { log, logError, logWarn, logGroup, logGroupEnd } from '../shared/utils/logger'
 *   log('ContentScript', 'init', 'page type:', pageType)
 *   logError('Popup', 'upload', err)
 *   logGroup('ContentScript', 'apply-flow')
 *   logGroupEnd()
 */

const PREFIX = '[求职助手]'

function timestamp(): string {
  const d = new Date()
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}.${d.getMilliseconds().toString().padStart(3, '0')}`
}

export function log(module: string, action: string, ...args: unknown[]): void {
  console.log(`${PREFIX} [${timestamp()}] [${module}] ${action}:`, ...args)
}

export function logInfo(module: string, action: string, ...args: unknown[]): void {
  console.info(`${PREFIX} [${timestamp()}] [${module}] ${action}:`, ...args)
}

export function logWarn(module: string, action: string, ...args: unknown[]): void {
  console.warn(`${PREFIX} [${timestamp()}] [${module}] ⚠️ ${action}:`, ...args)
}

export function logError(module: string, action: string, error?: unknown, ...args: unknown[]): void {
  console.error(`${PREFIX} [${timestamp()}] [${module}] ❌ ${action}:`, error, ...args)
}

export function logGroup(module: string, label: string): void {
  console.group(`${PREFIX} [${timestamp()}] [${module}] ▶ ${label}`)
}

export function logGroupEnd(): void {
  console.groupEnd()
}

export function logTable(module: string, action: string, data: unknown): void {
  console.log(`${PREFIX} [${timestamp()}] [${module}] ${action}:`)
  console.table(data)
}

/** Log a separator line for visual clarity */
export function logSeparator(module: string, label: string): void {
  console.log(`${PREFIX} [${timestamp()}] [${module}] ─── ${label} ───`)
}
