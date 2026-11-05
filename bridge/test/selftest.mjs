/**
 * 桥接服务端到端自测（零依赖）。
 *
 * 起一个临时端口的 daemon + 一个模拟「扩展 offscreen 页面」的客户端，
 * 验证：配对 → 工具清单上报 → 长轮询取命令 → 结果回传 → MCP / REST 拿到结果。
 *
 * 运行：node bridge/test/selftest.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import net from 'node:net'
import { pathToFileURL, fileURLToPath } from 'node:url'

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qzzs-bridge-test-'))
const CONFIG = path.join(TMP, 'bridge.json')
process.env.QZZS_BRIDGE_CONFIG = CONFIG
process.env.QZZS_BRIDGE_QUIET = '1'

async function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer()
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)) })
  })
}

const port = await freePort()
fs.writeFileSync(CONFIG, JSON.stringify({
  version: 1, host: '127.0.0.1', port,
  token: 'test-token-0123456789abcdef0123456789abcdef',
  pairUsed: false, createdAt: new Date().toISOString(), projectDir: PROJECT,
}) + '\n')

const { createBridgeServer } = await import(pathToFileURL(path.join(PROJECT, 'bridge', 'src', 'server.mjs')).href)
const bridge = createBridgeServer()
await bridge.start()
const url = `http://127.0.0.1:${port}`
const token = bridge.config.token
const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }

async function get(p, init = {}) {
  const res = await fetch(url + p, init)
  return { status: res.status, body: await res.json().catch(() => null) }
}
async function post(p, body, headers = auth) {
  return get(p, { method: 'POST', headers, body: JSON.stringify(body) })
}

const passed = []
let failed = false
function check(name, condition, detail = '') {
  if (condition) { passed.push(name); process.stdout.write(`  ✓ ${name}\n`) }
  else { failed = true; process.stdout.write(`  ✗ ${name} ${detail}\n`) }
}

// 模拟扩展：配对 → 上报工具清单 → 持续长轮询 → 回传结果
let running = true
const seen = []
async function fakeExtension() {
  const pair = await post('/pair', { clientId: 'selftest' }, { 'Content-Type': 'application/json' })
  assert.equal(pair.status, 200)
  assert.equal(pair.body.token, token)
  const manifest = {
    protocol: '1', extensionVersion: '1.2.0-selftest',
    tools: [
      { name: 'get_status', description: '读取状态', risk: 'read', inputSchema: { type: 'object', properties: {} } },
      { name: 'start_campaign', description: '启动投递', risk: 'dangerous', inputSchema: { type: 'object', properties: { confirm: { type: 'boolean' } } } },
    ],
  }
  await post('/hello', { manifest })
  while (running) {
    let command = null
    try {
      const r = await get(`/poll?timeout=1&token=${token}`)
      command = r.body?.command
    } catch { /* 服务关闭时忽略 */ }
    if (command) {
      seen.push(command)
      await post('/result', {
        id: command.id, ok: true,
        data: { tool: command.tool, args: command.args, servedBy: 'fake-extension' },
      })
    }
  }
}
const extLoop = fakeExtension()
await new Promise((r) => setTimeout(r, 300))

process.stdout.write('\n桥接服务端到端自测\n')
const health = await get('/health')
check('GET /health 返回 200 且无需鉴权', health.status === 200 && health.body.ok === true)
check('扩展心跳后 extensionConnected=true', health.body.extensionConnected === true, JSON.stringify(health.body))
check('工具清单已由扩展上报', health.body.toolsCount === 2, `toolsCount=${health.body.toolsCount}`)

const unauthorized = await get('/tools')
check('无 token 访问受保护端点返回 401', unauthorized.status === 401)

const secondPair = await post('/pair', { clientId: 'intruder' }, { 'Content-Type': 'application/json' })
check('一次性配对第二次被拒绝（409）', secondPair.status === 409)

const tools = await get('/tools', { headers: auth })
check('GET /tools 返回扩展上报的工具', tools.body?.tools?.length === 2 && tools.body.source === 'extension')

const init = await post('/mcp', { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } })
check('MCP initialize 握手', init.body?.result?.serverInfo?.name === 'qiuzhizhushou')

const list = await post('/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
check('MCP tools/list 带风险分级标注', list.body?.result?.tools?.length === 2 && list.body.result.tools[1].description.includes('危险'))

const call = await post('/mcp', { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_status', arguments: { foo: 1 } } })
const callData = JSON.parse(call.body?.result?.content?.[0]?.text || '{}')
check('MCP tools/call 经长轮询拿到扩展结果', callData.ok === true && callData.data?.tool === 'get_status' && callData.data?.args?.foo === 1, JSON.stringify(call.body))

const rpc = await post('/rpc', { tool: 'start_campaign', args: { confirm: true } })
check('REST /rpc 端到端调用', rpc.body?.ok === true && rpc.body?.data?.tool === 'start_campaign', JSON.stringify(rpc.body))
check('两条命令都被扩展消费', seen.length === 2, `seen=${seen.length}`)

const unknown = await post('/mcp', { jsonrpc: '2.0', id: 4, method: 'no/such/method' })
check('未知 MCP 方法返回 -32601', unknown.body?.error?.code === -32601)

running = false
await extLoop.catch(() => {})
await bridge.close()
try { fs.rmSync(TMP, { recursive: true, force: true }) } catch { /* ignore */ }

process.stdout.write(`\n结果：${passed.length} 项通过${failed ? '，存在失败项' : '，全部通过'}\n\n`)
process.exit(failed ? 1 : 0)
