/**
 * MCP stdio Server —— 给 Claude Code / Codex / Cursor / Cline 等使用。
 *
 * 协议：MCP over stdio（newline-delimited JSON-RPC 2.0）。
 * 本进程不常驻，由 AI 客户端按需启动；真正的状态与命令队列在常驻 daemon 里。
 * 注意：stdout 只能写 JSON-RPC，任何日志都必须走 stderr。
 */
import readline from 'node:readline'
import { loadConfig, baseUrl, BRIDGE_NAME, BRIDGE_VERSION } from './config.mjs'
import { SERVER_INSTRUCTIONS } from './tools.mjs'

const { config } = loadConfig()
const BASE = process.env.QZZS_BRIDGE_URL || baseUrl(config)
const TOKEN = process.env.QZZS_BRIDGE_TOKEN || config.token

function stderr(message) {
  process.stderr.write(`[qzzs-mcp] ${message}\n`)
}

async function postToDaemon(rpc) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 75_000)
  try {
    const res = await fetch(`${BASE}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TOKEN}`,
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify(rpc),
      signal: controller.signal,
    })
    const text = await res.text()
    if (!text) return null
    // 兼容返回 SSE 的实现：只取第一个 data: 行
    const dataLine = text.split('\n').find((line) => line.startsWith('data:'))
    const raw = dataLine ? dataLine.slice(5).trim() : text
    return JSON.parse(raw)
  } finally {
    clearTimeout(timer)
  }
}

function makeError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } }
}

async function handle(rpc) {
  if (!rpc || typeof rpc !== 'object' || !rpc.method) {
    return makeError(rpc?.id ?? null, -32600, '无效请求')
  }
  const { id = null, method } = rpc

  if (method === 'initialize') {
    // 本地响应，保证 daemon 未启动时客户端也能完成握手并看到明确指引
    return {
      jsonrpc: '2.0', id,
      result: {
        protocolVersion: rpc.params?.protocolVersion || '2024-11-05',
        capabilities: { tools: { listChanged: true }, resources: {}, prompts: {} },
        serverInfo: { name: BRIDGE_NAME, version: BRIDGE_VERSION },
        instructions: SERVER_INSTRUCTIONS,
      },
    }
  }
  if (method.startsWith('notifications/')) return null
  if (method === 'ping') return { jsonrpc: '2.0', id, result: {} }

  try {
    const reply = await postToDaemon(rpc)
    if (!reply) return null
    return reply
  } catch (err) {
    const hint = `无法连接本地桥接服务 ${BASE}。请运行 ./scripts/install.sh 或 node bridge/bin/cli.mjs start（原始错误：${err?.message || err}）`
    stderr(hint)
    if (method === 'tools/call') {
      return {
        jsonrpc: '2.0', id,
        result: { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: hint }) }], isError: true },
      }
    }
    if (method === 'tools/list') {
      return { jsonrpc: '2.0', id, result: { tools: [] } }
    }
    return makeError(id, -32000, hint)
  }
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
stderr(`stdio MCP 已就绪 → ${BASE}`)

rl.on('line', async (line) => {
  const trimmed = line.trim()
  if (!trimmed) return
  let rpc
  try { rpc = JSON.parse(trimmed) } catch { stderr(`忽略非 JSON 行：${trimmed.slice(0, 80)}`); return }
  try {
    const reply = await handle(rpc)
    if (reply) process.stdout.write(JSON.stringify(reply) + '\n')
  } catch (err) {
    stderr(`处理失败：${err?.stack || err}`)
    process.stdout.write(JSON.stringify(makeError(rpc.id ?? null, -32603, String(err?.message || err))) + '\n')
  }
})

process.on('SIGINT', () => process.exit(0))
process.on('SIGTERM', () => process.exit(0))
