/**
 * 外部 AI 桥接客户端（运行在常驻 offscreen document）。
 *
 * MV3 的 Service Worker 会被休眠，无法维持长连接，所以把长轮询放在 offscreen 页面里。
 * 它只做三件事：配对 / 心跳上报工具清单 / 取命令 → 交给 background 执行 → 回传结果。
 * 所有业务判断（工具白名单、分级门禁、脱敏）都在 background，这里没有任何权限绕过逻辑。
 */
import {
  getExternalAiConfig, saveExternalAiConfig,
  patchExternalAiStatus, getExternalAiStatus,
} from '../shared/bridge/config'
import { buildManifest } from '../shared/bridge/tools'
import { MSG_EXTERNAL_AI_RPC } from '../shared/bridge/types'
import type { BridgeCommand, BridgeResult, ExternalAiConfig, PairResponse } from '../shared/bridge/types'

const VERSION = (() => {
  try { return chrome.runtime.getManifest().version } catch { return 'unknown' }
})()
const HELLO_INTERVAL_MS = 30_000
const IDLE_SLEEP_MS = 2_000
const ERROR_SLEEP_MS = 5_000

let lastHelloAt = 0
let stopped = false

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function authHeaders(config: ExternalAiConfig): Record<string, string> {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${config.token}` }
}

async function jsonFetch(url: string, init: RequestInit = {}, timeoutMs = 25_000): Promise<{ ok: boolean; status: number; body: Record<string, unknown> }> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
  const body = await res.json().catch(() => ({})) as Record<string, unknown>
  return { ok: res.ok, status: res.status, body }
}

async function ensurePaired(config: ExternalAiConfig): Promise<ExternalAiConfig> {
  if (config.paired && config.token) return config
  const res = await jsonFetch(`${config.bridgeUrl}/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client: 'chrome-extension', version: VERSION }),
  }, 8_000)
  const pair = res.body as unknown as PairResponse
  if (!res.ok || !pair?.ok || !pair.token) {
    throw new Error(pair?.error || `配对失败（HTTP ${res.status}）。若提示已完成配对，请在终端运行 node bridge/bin/cli.mjs pair-reset`)
  }
  const next = await saveExternalAiConfig({ token: pair.token, paired: true })
  await patchExternalAiStatus({ paired: true, connected: true, lastError: null })
  return next
}

async function sendHello(config: ExternalAiConfig, force = false): Promise<void> {
  if (!force && Date.now() - lastHelloAt < HELLO_INTERVAL_MS) return
  const res = await jsonFetch(`${config.bridgeUrl}/hello`, {
    method: 'POST',
    headers: authHeaders(config),
    body: JSON.stringify({ manifest: buildManifest(VERSION), client: 'offscreen' }),
  }, 10_000)
  if (!res.ok) throw new Error(`心跳失败（HTTP ${res.status}）：${String(res.body?.error || '')}`)
  lastHelloAt = Date.now()
  await patchExternalAiStatus({
    lastHelloAt, connected: true, lastError: null,
    extensionVersion: VERSION, bridgeUrl: config.bridgeUrl,
    enabled: config.enabled, paired: config.paired,
  })
}

async function executeAndReport(config: ExternalAiConfig, command: BridgeCommand): Promise<void> {
  let result: BridgeResult = { ok: false, error: '扩展未响应' }
  try {
    const response = await chrome.runtime.sendMessage({
      type: MSG_EXTERNAL_AI_RPC,
      payload: { tool: command.tool, args: command.args || {} },
    }) as BridgeResult
    result = response && typeof response === 'object' ? response : { ok: false, error: 'background 返回空响应' }
  } catch (err) {
    result = { ok: false, error: `执行失败：${String(err)}` }
  }
  await jsonFetch(`${config.bridgeUrl}/result`, {
    method: 'POST',
    headers: authHeaders(config),
    body: JSON.stringify({ id: command.id, ok: result.ok, data: result.data ?? null, error: result.error || null }),
  }, 10_000)
  await patchExternalAiStatus({ lastPollAt: Date.now(), connected: true })
}

async function tick(): Promise<void> {
  const config = await getExternalAiConfig()
  if (!config.enabled) {
    if ((await getExternalAiStatus()).connected) {
      await patchExternalAiStatus({ connected: false, enabled: false })
    }
    await sleep(IDLE_SLEEP_MS)
    return
  }

  const active = await ensurePaired(config)
  await sendHello(active)
  const poll = await jsonFetch(`${active.bridgeUrl}/poll?timeout=20`, {
    method: 'GET', headers: authHeaders(active),
  }, 25_000)
  if (!poll.ok) throw new Error(`取命令失败（HTTP ${poll.status}）：${String(poll.body?.error || '')}`)
  const command = poll.body?.command as BridgeCommand | null | undefined
  if (command && typeof command.id === 'string' && typeof command.tool === 'string') {
    await executeAndReport(active, command)
  } else {
    await patchExternalAiStatus({ lastPollAt: Date.now(), connected: true, lastError: null })
  }
}

async function loop(): Promise<void> {
  while (!stopped) {
    try {
      await tick()
    } catch (err) {
      const message = String((err as { message?: string })?.message || err)
      await patchExternalAiStatus({ connected: false, lastError: message }).catch(() => {})
      await sleep(ERROR_SLEEP_MS)
    }
  }
}

// 配置一变（用户在设置页开关 / 重置配对），立刻强制下一次心跳重报工具清单
try {
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.external_ai_config) lastHelloAt = 0
  })
} catch { /* ignore */ }

// 页面卸载时同步状态，避免设置页显示"已连接"但其实没有心跳
window.addEventListener('pagehide', () => {
  stopped = true
  void patchExternalAiStatus({ connected: false }).catch(() => {})
})

void loop()
