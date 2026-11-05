/**
 * MCP 工具清单兜底。
 *
 * 权威清单在扩展侧 src/shared/bridge/tools.ts，由 offscreen 客户端在 /hello 心跳时
 * 上报给 daemon（manifest.tools），daemon 缓存后用于 MCP tools/list。
 * 这里只保留「扩展还没连上」时的最小可用工具，避免两份清单各自漂移。
 */
export const FALLBACK_TOOLS = [
  {
    name: 'bridge_status',
    description: '查询本地桥接服务与智能求职助手扩展的连接状态。若返回 extensionConnected=false，请先安装扩展并在「设置 → 外部 AI 接入」点击连接。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    risk: 'read',
  },
]

export const SERVER_INSTRUCTIONS = [
  '你是「智能求职助手」的 AI 操作端，通过本地桥接服务读写浏览器扩展里的求职数据。',
  '数据全部存放在用户本机浏览器，不会上传云端。',
  '读类工具可自由调用；写类工具会改动用户配置；dangerous 类工具（启动/恢复真实投递、清空记录等）默认被拒绝，必须用户在扩展设置页显式授权，并在调用时传 confirm=true。',
  '涉及真实投递或删除数据时，先用自然语言向用户确认，不要擅自执行。',
  '返回结果是 JSON：{ ok, data } 或 { ok:false, error }。',
].join('\n')

export function normalizeManifest(manifest) {
  if (!manifest || typeof manifest !== 'object') return null
  const tools = Array.isArray(manifest.tools) ? manifest.tools : null
  if (!tools || tools.length === 0) return null
  const seen = new Set()
  const normalized = []
  for (const tool of tools) {
    if (!tool || typeof tool.name !== 'string' || !tool.name.trim()) continue
    if (seen.has(tool.name)) continue
    seen.add(tool.name)
    normalized.push({
      name: tool.name,
      description: String(tool.description || ''),
      inputSchema: tool.inputSchema && typeof tool.inputSchema === 'object'
        ? tool.inputSchema
        : { type: 'object', properties: {}, additionalProperties: false },
      risk: ['read', 'write', 'dangerous'].includes(tool.risk) ? tool.risk : 'read',
    })
  }
  return {
    protocol: String(manifest.protocol || '1'),
    extensionVersion: String(manifest.extensionVersion || 'unknown'),
    tools: normalized,
    receivedAt: new Date().toISOString(),
  }
}
