/** 一键体检：检查 Node / 配置 / daemon / 扩展 / MCP 配置 / 端到端调用。 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { configPath, loadConfig, baseUrl, BRIDGE_VERSION } from './config.mjs'

async function fetchJson(url, init = {}, timeoutMs = 3000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { ...init, signal: controller.signal })
    return { status: res.status, body: await res.json().catch(() => null) }
  } finally { clearTimeout(timer) }
}

export async function runDoctor({ projectDir, home = os.homedir(), config = null } = {}) {
  const cfg = config || loadConfig().config
  const url = baseUrl(cfg)
  const checks = []
  const add = (name, ok, detail, fix) => checks.push({ name, ok: !!ok, detail, fix: ok ? '' : fix })

  const major = Number(process.versions.node.split('.')[0])
  add('Node.js ≥ 18', major >= 18, `当前 v${process.versions.node}`, '请升级 Node.js 到 18 或更高版本')

  add('桥接配置', fs.existsSync(configPath()), configPath(), '运行 node bridge/bin/cli.mjs setup')
  add('访问令牌', !!cfg.token && cfg.token.length >= 32, cfg.token ? `${cfg.token.slice(0, 6)}…${cfg.token.slice(-4)}` : '缺失', '删除配置后重新 setup')

  let health = null
  try {
    const res = await fetchJson(`${url}/health`)
    health = res.body
    add('桥接服务在线', res.status === 200 && health?.version === BRIDGE_VERSION, `${url}/health → ${res.status}`, '运行 node bridge/bin/cli.mjs start')
  } catch (err) {
    add('桥接服务在线', false, String(err?.message || err), '运行 node bridge/bin/cli.mjs start')
  }

  if (health) {
    add('扩展已连接', health.extensionConnected, health.extensionConnected ? `扩展版本 ${health.extensionVersion}` : 'offscreen 页面未上报心跳',
      '在 chrome://extensions 加载 dist，并在「设置 → 外部 AI 接入」开启并点击连接')
    add('工具清单已同步', health.toolsCount > 1, `${health.toolsCount} 个工具`, '扩展连接后会自动上报工具清单')
  }

  const distManifest = projectDir ? path.join(projectDir, 'dist', 'manifest.json') : null
  const distOk = distManifest ? fs.existsSync(distManifest) : false
  add('扩展产物 dist', distOk, distManifest || '未指定项目目录', '运行 npm install && npm run build')

  const clientFiles = [
    ['Claude Code', path.join(home, '.claude.json')],
    ['Codex CLI', path.join(home, '.codex', 'config.toml')],
    ['Cursor', path.join(home, '.cursor', 'mcp.json')],
  ]
  for (const [name, file] of clientFiles) {
    const exists = fs.existsSync(file) && fs.readFileSync(file, 'utf8').includes('qiuzhizhushou')
    add(`${name} MCP 配置`, exists, file, '运行 node bridge/bin/cli.mjs integrations --force')
  }

  let rpcOk = false
  let rpcDetail = '跳过（服务未在线）'
  if (health) {
    try {
      const res = await fetchJson(`${url}/rpc`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.token}` },
        body: JSON.stringify({ tool: 'bridge_status', args: {} }),
      }, 5000)
      rpcOk = res.status === 200 && res.body?.ok === true
      rpcDetail = `POST /rpc → ${res.status} · ok=${res.body?.ok}`
    } catch (err) { rpcDetail = String(err?.message || err) }
  }
  add('REST 端到端调用', rpcOk, rpcDetail, '检查 token 与 daemon 日志')

  let mcpOk = false
  let mcpDetail = '跳过（服务未在线）'
  if (health) {
    try {
      const res = await fetchJson(`${url}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.token}`, Accept: 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      }, 5000)
      mcpOk = res.status === 200 && Array.isArray(res.body?.result?.tools)
      mcpDetail = `POST /mcp tools/list → ${res.status} · ${res.body?.result?.tools?.length ?? 0} 个工具`
    } catch (err) { mcpDetail = String(err?.message || err) }
  }
  add('MCP 协议握手', mcpOk, mcpDetail, '检查 daemon 日志 ~/.qiuzhizhushou/bridge.log')

  return { checks, passed: checks.filter((c) => c.ok).length, total: checks.length, health }
}

export function formatDoctor(result) {
  const lines = result.checks.map((c) => {
    const icon = c.ok ? '✓' : '✗'
    let line = `  ${icon} ${c.name.padEnd(20)} ${c.detail}`
    if (c.fix) line += `\n      → 修复：${c.fix}`
    return line
  })
  return `${lines.join('\n')}\n\n  通过 ${result.passed}/${result.total} 项`
}
