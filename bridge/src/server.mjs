/**
 * 智能求职助手 · 本地 AI 桥接 daemon
 *
 * MV3 扩展不能监听端口，所以由扩展「主动出站」长轮询本服务：
 *   扩展 offscreen 页面 ──GET /poll──▶ daemon ──命令──▶ 扩展
 *   扩展 ──POST /result──▶ daemon ──结果──▶ MCP 客户端 / 脚本 / 小龙虾 bot
 *
 * 只监听 127.0.0.1，所有写接口需要 token（一次性配对分发）。
 * 零第三方依赖。
 */
import http from 'node:http'
import fs from 'node:fs'
import crypto from 'node:crypto'
import { pathToFileURL } from 'node:url'
import {
  configPath, loadConfig, saveConfig, baseUrl, logPath,
  tokenFromRequest, safeTokenEqual, redactToken,
  BRIDGE_NAME, BRIDGE_VERSION, PROTOCOL_VERSION,
} from './config.mjs'
import { FALLBACK_TOOLS, SERVER_INSTRUCTIONS, normalizeManifest } from './tools.mjs'

const COMMAND_TIMEOUT_MS = 90_000
const RPC_TIMEOUT_MS = 65_000
const HELLO_TTL_MS = 75_000
const MAX_QUEUE = 100
const MAX_BODY = 1024 * 1024

export function createBridgeServer({ config: initialConfig, onListen } = {}) {
  const config = initialConfig || loadConfig().config
  const state = {
    config,
    commands: new Map(),
    queue: [],
    pollWaiters: [],
    sseClients: new Set(),
    manifest: null,
    lastHelloAt: 0,
    startedAt: new Date().toISOString(),
    stats: { rpc: 0, results: 0, errors: 0, polls: 0 },
  }

  function log(level, message) {
    const line = `[${new Date().toISOString()}] [${level}] ${message}\n`
    try { fs.appendFileSync(logPath(), line) } catch { /* 日志失败不影响服务 */ }
    if (process.env.QZZS_BRIDGE_QUIET !== '1') process.stdout.write(line)
  }

  function broadcast(type, payload) {
    const chunk = `event: ${type}\ndata: ${JSON.stringify({ type, at: new Date().toISOString(), ...payload })}\n\n`
    for (const res of state.sseClients) {
      try { res.write(chunk) } catch { state.sseClients.delete(res) }
    }
  }

  function extensionConnected() {
    return !!state.manifest && Date.now() - state.lastHelloAt < HELLO_TTL_MS
  }

  function currentTools() {
    return state.manifest?.tools?.length ? state.manifest.tools : FALLBACK_TOOLS
  }

  function sendJson(res, status, body, req) {
    const payload = JSON.stringify(body)
    applyCors(res, req)
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(payload),
      'Cache-Control': 'no-store',
    })
    res.end(payload)
  }

  function applyCors(res, req) {
    res.setHeader('Access-Control-Allow-Origin', req?.headers?.origin || '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-QZZS-Token, Mcp-Session-Id, Accept, Last-Event-ID')
    res.setHeader('Access-Control-Allow-Private-Network', 'true')
    res.setHeader('Access-Control-Max-Age', '600')
    res.setHeader('Vary', 'Origin')
  }

  async function readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0
      const chunks = []
      req.on('data', (chunk) => {
        size += chunk.length
        if (size > MAX_BODY) {
          reject(new Error('请求体过大'))
          req.destroy()
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8')
        if (!raw) return resolve({})
        try { resolve(JSON.parse(raw)) } catch { reject(new Error('请求体不是合法 JSON')) }
      })
      req.on('error', reject)
    })
  }

  function requireToken(req, url, body) {
    const supplied = tokenFromRequest(req, url, body)
    return safeTokenEqual(supplied, state.config.token)
  }

  /** 把一条工具调用排入队列，返回 Promise<{ok,data,error}> */
  function enqueue(tool, args, meta = {}) {
    return new Promise((resolve) => {
      if (state.queue.length >= MAX_QUEUE) {
        resolve({ ok: false, error: '桥接命令队列已满，请稍后重试' })
        return
      }
      const id = crypto.randomUUID()
      const entry = {
        id, tool, args: args || {}, createdAt: Date.now(),
        status: 'pending', result: null, resolve, retries: 0, meta,
      }
      state.commands.set(id, entry)
      state.queue.push(id)
      const timer = setTimeout(() => {
        if (entry.status === 'done') return
        if (entry.retries < 1) {
          // 扩展可能重启了：把命令重新放回队列一次，避免静默丢失
          entry.retries += 1
          entry.status = 'pending'
          if (!state.queue.includes(id)) state.queue.push(id)
          deliverToPollWaiters()
          entry.timer = setTimeout(() => finishWithError(entry, '扩展未在 90 秒内响应'), COMMAND_TIMEOUT_MS)
        } else {
          finishWithError(entry, '扩展未在 90 秒内响应')
        }
      }, COMMAND_TIMEOUT_MS)
      entry.timer = timer
      deliverToPollWaiters()
      broadcast('command', { id, tool })
    })
  }

  function finishWithError(entry, error) {
    if (entry.status === 'done') return
    clearTimeout(entry.timer)
    entry.status = 'done'
    entry.result = { ok: false, error }
    state.commands.delete(entry.id)
    state.queue = state.queue.filter((x) => x !== entry.id)
    state.stats.errors += 1
    entry.resolve(entry.result)
  }

  function deliverToPollWaiters() {
    while (state.pollWaiters.length && state.queue.length) {
      const waiter = state.pollWaiters.shift()
      const command = takePending()
      if (!command) break
      clearTimeout(waiter.timer)
      sendJson(waiter.res, 200, { ok: true, command }, waiter.req)
    }
  }

  function takePending() {
    while (state.queue.length) {
      const id = state.queue.shift()
      const entry = state.commands.get(id)
      if (!entry || entry.status !== 'pending') continue
      entry.status = 'delivered'
      return { id: entry.id, tool: entry.tool, args: entry.args }
    }
    return null
  }

  function publicStatus() {
    return {
      ok: true,
      service: BRIDGE_NAME,
      version: BRIDGE_VERSION,
      protocol: PROTOCOL_VERSION,
      url: baseUrl(state.config),
      startedAt: state.startedAt,
      paired: state.config.pairUsed,
      extensionConnected: extensionConnected(),
      extensionVersion: state.manifest?.extensionVersion || null,
      toolsCount: currentTools().length,
      pendingCommands: state.queue.length,
      stats: { ...state.stats },
      configPath: configPath(),
    }
  }

  // ─── MCP JSON-RPC（stdio 与 Streamable HTTP 共用） ───
  async function handleMcpRpc(rpc) {
    const id = rpc?.id ?? null
    const method = rpc?.method
    const params = rpc?.params || {}
    const reply = (result) => ({ jsonrpc: '2.0', id, result })
    const fail = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } })

    switch (method) {
      case 'initialize':
        return reply({
          protocolVersion: params.protocolVersion || '2024-11-05',
          capabilities: { tools: { listChanged: true }, resources: {}, prompts: {} },
          serverInfo: { name: BRIDGE_NAME, version: BRIDGE_VERSION },
          instructions: SERVER_INSTRUCTIONS,
        })
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return null
      case 'ping':
        return reply({})
      case 'tools/list':
        return reply({
          tools: currentTools().map((t) => ({
            name: t.name,
            description: `[${t.risk === 'dangerous' ? '危险·需授权' : t.risk === 'write' ? '写入' : '只读'}] ${t.description}`,
            inputSchema: t.inputSchema,
          })),
          _bridge: { extensionConnected: extensionConnected(), source: state.manifest ? 'extension' : 'fallback' },
        })
      case 'tools/call': {
        const name = params.name
        const args = params.arguments || {}
        if (!name) return fail(-32602, '缺少工具名 name')
        if (name === 'bridge_status') return reply(mcpContent(publicStatus()))
        if (!extensionConnected()) {
          return reply(mcpContent({ ok: false, error: '扩展未连接：请在 Chrome 加载 dist 扩展，并在「设置 → 外部 AI 接入」点击连接。' }, true))
        }
        const tool = currentTools().find((t) => t.name === name)
        if (!tool) return fail(-32602, `未知工具：${name}`)
        try {
          const result = await enqueue(name, args, { source: 'mcp' })
          return reply(mcpContent(result, result.ok === false))
        } catch (err) {
          return reply(mcpContent({ ok: false, error: String(err?.message || err) }, true))
        }
      }
      case 'resources/list': return reply({ resources: [] })
      case 'resources/templates/list': return reply({ resourceTemplates: [] })
      case 'prompts/list': return reply({ prompts: [] })
      default:
        return fail(-32601, `不支持的方法：${method}`)
    }
  }

  function mcpContent(value, isError = false) {
    const out = { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] }
    if (isError) out.isError = true
    return out
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${state.config.host}:${state.config.port}`)
    const pathname = url.pathname

    if (req.method === 'OPTIONS') {
      applyCors(res, req)
      res.writeHead(204)
      res.end()
      return
    }

    let body = {}
    if (req.method === 'POST' || req.method === 'DELETE') {
      try { body = await readBody(req) } catch (err) { return sendJson(res, 400, { ok: false, error: err.message }, req) }
    }

    try {
      // ── 无需鉴权 ──
      if (pathname === '/health' && req.method === 'GET') return sendJson(res, 200, publicStatus(), req)

      if (pathname === '/pair' && req.method === 'POST') {
        if (state.config.pairUsed && !body.force) {
          return sendJson(res, 409, { ok: false, error: '已完成过一次性配对。如需重新配对，请运行：node bridge/bin/cli.mjs pair-reset' }, req)
        }
        state.config.pairUsed = true
        saveConfig(state.config)
        broadcast('paired', { at: new Date().toISOString() })
        log('info', '扩展完成一次性配对')
        return sendJson(res, 200, {
          ok: true, protocol: PROTOCOL_VERSION, token: state.config.token,
          url: baseUrl(state.config), host: state.config.host, port: state.config.port,
          pollPath: '/poll', resultPath: '/result', helloPath: '/hello',
        }, req)
      }

      // ── 以下均需 token ──
      if (!requireToken(req, url, body)) {
        return sendJson(res, 401, { ok: false, error: 'token 无效。请在扩展「设置 → 外部 AI 接入」重新配对，或检查 MCP 配置里的 Authorization。' }, req)
      }

      if (pathname === '/hello' && req.method === 'POST') {
        const manifest = normalizeManifest(body.manifest || body)
        if (manifest) state.manifest = manifest
        state.lastHelloAt = Date.now()
        broadcast('hello', { extensionVersion: state.manifest?.extensionVersion || 'unknown' })
        return sendJson(res, 200, {
          ok: true, serverTime: new Date().toISOString(), protocol: PROTOCOL_VERSION,
          toolsAccepted: state.manifest?.tools?.length || 0,
          pendingCommands: state.queue.length,
          instructions: SERVER_INSTRUCTIONS,
        }, req)
      }

      if (pathname === '/poll' && req.method === 'GET') {
        state.stats.polls += 1
        const timeoutSec = Math.min(30, Math.max(1, Number(url.searchParams.get('timeout')) || 20))
        const command = takePending()
        if (command) return sendJson(res, 200, { ok: true, command }, req)
        const waiter = { req, res, timer: null }
        waiter.timer = setTimeout(() => {
          const idx = state.pollWaiters.indexOf(waiter)
          if (idx >= 0) state.pollWaiters.splice(idx, 1)
          sendJson(res, 200, { ok: true, command: null }, req)
        }, timeoutSec * 1000)
        state.pollWaiters.push(waiter)
        res.on('close', () => {
          const idx = state.pollWaiters.indexOf(waiter)
          if (idx >= 0) state.pollWaiters.splice(idx, 1)
          clearTimeout(waiter.timer)
        })
        return
      }

      if (pathname === '/result' && req.method === 'POST') {
        const id = body.id
        const entry = state.commands.get(id)
        if (!entry || entry.status === 'done') {
          return sendJson(res, 404, { ok: false, error: '命令不存在或已结束' }, req)
        }
        clearTimeout(entry.timer)
        entry.status = 'done'
        entry.result = { ok: body.ok !== false, data: body.data ?? null, error: body.error || null }
        state.commands.delete(id)
        state.queue = state.queue.filter((x) => x !== id)
        state.stats.results += 1
        broadcast('result', { id, tool: entry.tool, ok: entry.result.ok })
        entry.resolve(entry.result)
        return sendJson(res, 200, { ok: true }, req)
      }

      if (pathname === '/rpc' && req.method === 'POST') {
        const tool = body.tool
        if (!tool) return sendJson(res, 400, { ok: false, error: '缺少 tool' }, req)
        if (!extensionConnected() && tool !== 'bridge_status') {
          return sendJson(res, 503, { ok: false, error: '扩展未连接（请在扩展设置页开启外部 AI 接入）' }, req)
        }
        if (tool === 'bridge_status') return sendJson(res, 200, { ok: true, data: publicStatus() }, req)
        state.stats.rpc += 1
        const result = await Promise.race([
          enqueue(tool, body.args || {}, { source: 'rest' }),
          new Promise((resolve) => setTimeout(() => resolve({ ok: false, error: '等待扩展响应超时（65s）' }), RPC_TIMEOUT_MS)),
        ])
        return sendJson(res, 200, result, req)
      }

      if (pathname === '/tools' && req.method === 'GET') {
        return sendJson(res, 200, { ok: true, tools: currentTools(), source: state.manifest ? 'extension' : 'fallback' }, req)
      }

      if (pathname === '/events' && req.method === 'GET') {
        applyCors(res, req)
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
        })
        res.write(`event: hello\ndata: ${JSON.stringify(publicStatus())}\n\n`)
        state.sseClients.add(res)
        const keepAlive = setInterval(() => { try { res.write(': ping\n\n') } catch { /* ignore */ } }, 20_000)
        req.on('close', () => { clearInterval(keepAlive); state.sseClients.delete(res) })
        return
      }

      if (pathname === '/mcp') {
        if (req.method === 'GET') {
          // Streamable HTTP 的 SSE 监听通道
          applyCors(res, req)
          res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive',
            'Mcp-Session-Id': crypto.randomUUID(),
          })
          state.sseClients.add(res)
          const keepAlive = setInterval(() => { try { res.write(': ping\n\n') } catch { /* ignore */ } }, 20_000)
          req.on('close', () => { clearInterval(keepAlive); state.sseClients.delete(res) })
          return
        }
        if (req.method === 'DELETE') return sendJson(res, 200, { ok: true }, req)
        if (req.method === 'POST') {
          const rpcBody = Array.isArray(body) ? body : [body]
          const replies = []
          for (const rpc of rpcBody) {
            const reply = await handleMcpRpc(rpc)
            if (reply) replies.push(reply)
          }
          if (replies.length === 0) {
            applyCors(res, req)
            res.writeHead(202)
            return res.end()
          }
          return sendJson(res, 200, Array.isArray(body) ? replies : replies[0], req)
        }
      }

      return sendJson(res, 404, { ok: false, error: `未知路由：${pathname}` }, req)
    } catch (err) {
      log('error', `${req.method} ${pathname} → ${err?.stack || err}`)
      return sendJson(res, 500, { ok: false, error: String(err?.message || err) }, req)
    }
  })

  server.on('error', (err) => log('error', `server error: ${err.message}`))

  return {
    server,
    state,
    config,
    start: () => new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(config.port, config.host, () => {
        log('info', `桥接服务已启动 ${baseUrl(config)} · token=${redactToken(config.token)} · config=${configPath()}`)
        resolve({ ...publicStatus(), url: baseUrl(config) })
        if (onListen) onListen(publicStatus())
      })
    }),
    close: () => new Promise((resolve) => {
      for (const waiter of state.pollWaiters) clearTimeout(waiter.timer)
      for (const entry of state.commands.values()) clearTimeout(entry.timer)
      for (const res of state.sseClients) { try { res.end() } catch { /* ignore */ } }
      server.close(() => resolve())
    }),
  }
}

// 直接运行时作为常驻 daemon
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const bridge = createBridgeServer()
  bridge.start().catch((err) => {
    process.stderr.write(`桥接服务启动失败：${err.message}\n`)
    process.exit(1)
  })
  const shutdown = () => { bridge.close().finally(() => process.exit(0)) }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}
