/**
 * 外部 AI 接入协议（v1）
 *
 * 本地桥接 daemon 与 Chrome 扩展之间约定的数据结构。
 * 扩展主动出站：GET /poll 取命令 → chrome.runtime.sendMessage 执行 → POST /result 回传。
 */
export const BRIDGE_PROTOCOL_VERSION = '1'
export const DEFAULT_BRIDGE_URL = 'http://127.0.0.1:18790'

export type ToolRisk = 'read' | 'write' | 'dangerous'

export interface ToolDefinition {
  name: string
  description: string
  risk: ToolRisk
  inputSchema: {
    type: 'object'
    properties: Record<string, { type: string; description?: string; enum?: string[]; default?: unknown }>
    required?: string[]
    additionalProperties?: boolean
  }
}

export interface BridgeManifest {
  protocol: string
  extensionVersion: string
  tools: ToolDefinition[]
}

export interface BridgeCommand {
  id: string
  tool: string
  args: Record<string, unknown>
}

export interface BridgeResult {
  ok: boolean
  data?: unknown
  error?: string | null
}

export interface ExternalAiConfig {
  /** 总开关：默认关闭，fail-closed */
  enabled: boolean
  /** 允许写入类工具（改配置、加黑名单等） */
  allowWrite: boolean
  /** 允许危险类工具（真实投递、清空数据等）；同时要求每次调用 confirm=true */
  allowDangerous: boolean
  bridgeUrl: string
  token: string
  /** 是否已完成一次性配对 */
  paired: boolean
}

export const DEFAULT_EXTERNAL_AI_CONFIG: ExternalAiConfig = {
  enabled: false,
  allowWrite: true,
  allowDangerous: false,
  bridgeUrl: DEFAULT_BRIDGE_URL,
  token: '',
  paired: false,
}

export interface ExternalAiStatus {
  enabled: boolean
  paired: boolean
  connected: boolean
  lastHelloAt: number | null
  lastPollAt: number | null
  lastError: string | null
  bridgeUrl: string
  extensionVersion: string
  toolsCount: number
}

export interface PairResponse {
  ok: boolean
  protocol?: string
  token?: string
  url?: string
  host?: string
  port?: number
  error?: string
}

/** 消息：offscreen ↔ background */
export const MSG_EXTERNAL_AI_RPC = 'EXTERNAL_AI_RPC'
export const MSG_EXTERNAL_AI_STATUS = 'EXTERNAL_AI_STATUS'
export const MSG_EXTERNAL_AI_CONTROL = 'EXTERNAL_AI_CONTROL'

export interface RpcRequest {
  tool: string
  args?: Record<string, unknown>
}

export interface ControlRequest {
  action: 'status' | 'set-config' | 'pair' | 'test' | 'reset'
  patch?: Partial<ExternalAiConfig>
}
