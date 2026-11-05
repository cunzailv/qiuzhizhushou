/**
 * 外部 AI 接入配置的单一真源：chrome.storage.local。
 * offscreen（连接端）/ background（RPC 执行端）/ options（设置页）都读这一份。
 */
import { DEFAULT_EXTERNAL_AI_CONFIG, DEFAULT_BRIDGE_URL } from './types'
import type { ExternalAiConfig, ExternalAiStatus } from './types'
import { TOOL_COUNTS } from './tools'

export const CONFIG_KEY = 'external_ai_config'
export const STATUS_KEY = 'external_ai_status'
const CONFIG_CHANGED = 'EXTERNAL_AI_CONFIG_CHANGED'

function hasStorage(): boolean {
  try { return typeof chrome !== 'undefined' && !!chrome.storage?.local } catch { return false }
}

export function normalizeConfig(raw: unknown): ExternalAiConfig {
  const input = (raw && typeof raw === 'object' ? raw : {}) as Partial<ExternalAiConfig>
  let bridgeUrl = typeof input.bridgeUrl === 'string' && input.bridgeUrl.trim()
    ? input.bridgeUrl.trim().replace(/\/+$/, '')
    : DEFAULT_BRIDGE_URL
  // 只允许本机回环，避免把 token 发到任意远端
  if (!/^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(bridgeUrl)) {
    bridgeUrl = DEFAULT_BRIDGE_URL
  }
  return {
    enabled: input.enabled === true,
    allowWrite: input.allowWrite !== false,
    allowDangerous: input.allowDangerous === true,
    bridgeUrl,
    token: typeof input.token === 'string' ? input.token : '',
    paired: input.paired === true,
  }
}

export async function getExternalAiConfig(): Promise<ExternalAiConfig> {
  if (!hasStorage()) return { ...DEFAULT_EXTERNAL_AI_CONFIG }
  try {
    const res = await chrome.storage.local.get(CONFIG_KEY)
    return normalizeConfig(res[CONFIG_KEY])
  } catch {
    return { ...DEFAULT_EXTERNAL_AI_CONFIG }
  }
}

export async function saveExternalAiConfig(patch: Partial<ExternalAiConfig>): Promise<ExternalAiConfig> {
  const next = normalizeConfig({ ...(await getExternalAiConfig()), ...patch })
  if (hasStorage()) {
    await chrome.storage.local.set({ [CONFIG_KEY]: next })
    try { void chrome.runtime.sendMessage({ type: CONFIG_CHANGED, payload: next }).catch(() => {}) } catch { /* ignore */ }
  }
  return next
}

export function defaultStatus(): ExternalAiStatus {
  return {
    enabled: false,
    paired: false,
    connected: false,
    lastHelloAt: null,
    lastPollAt: null,
    lastError: null,
    bridgeUrl: DEFAULT_BRIDGE_URL,
    extensionVersion: 'unknown',
    toolsCount: TOOL_COUNTS.total,
  }
}

export async function getExternalAiStatus(): Promise<ExternalAiStatus> {
  if (!hasStorage()) return defaultStatus()
  try {
    const res = await chrome.storage.local.get(STATUS_KEY)
    return { ...defaultStatus(), ...(res[STATUS_KEY] || {}) }
  } catch { return defaultStatus() }
}

export async function patchExternalAiStatus(patch: Partial<ExternalAiStatus>): Promise<ExternalAiStatus> {
  const next = { ...(await getExternalAiStatus()), ...patch }
  if (hasStorage()) await chrome.storage.local.set({ [STATUS_KEY]: next })
  return next
}

/** 设置页订阅状态变化（storage.onChanged） */
export function subscribeExternalAiStatus(listener: (status: ExternalAiStatus) => void): () => void {
  try {
    if (typeof chrome === 'undefined' || !chrome.storage?.onChanged) return () => {}
    const handler = (changes: Record<string, chrome.storage.StorageChange>) => {
      if (changes[STATUS_KEY] || changes[CONFIG_KEY]) void getExternalAiStatus().then(listener)
    }
    chrome.storage.onChanged.addListener(handler)
    return () => chrome.storage.onChanged.removeListener(handler)
  } catch { return () => {} }
}

export function subscribeExternalAiConfig(listener: (config: ExternalAiConfig) => void): () => void {
  try {
    if (typeof chrome === 'undefined' || !chrome.storage?.onChanged) return () => {}
    const handler = (changes: Record<string, chrome.storage.StorageChange>) => {
      if (changes[CONFIG_KEY]) listener(normalizeConfig(changes[CONFIG_KEY].newValue))
    }
    chrome.storage.onChanged.addListener(handler)
    return () => chrome.storage.onChanged.removeListener(handler)
  } catch { return () => {} }
}
