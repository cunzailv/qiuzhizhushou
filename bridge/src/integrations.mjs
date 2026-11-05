/**
 * 一条龙配置生成器：把桥接服务自动写进各类 AI 客户端的 MCP 配置。
 *
 * 原则：
 *  - 所有写入都先备份原文件到同目录 .bak.<时间戳>
 *  - 同名 server 已存在时默认跳过（--force 才覆盖），绝不破坏用户已有配置
 *  - 支持 home 覆盖，便于在临时目录里做无副作用的验收
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { baseUrl, BRIDGE_NAME } from './config.mjs'

function stamp() {
  return new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
}

function backup(file) {
  if (!fs.existsSync(file)) return null
  const target = `${file}.bak.${stamp()}`
  fs.copyFileSync(file, target)
  return target
}

function writeJsonMerged(file, serverName, serverConfig, { force = false, home } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  let data = {}
  let existed = false
  if (fs.existsSync(file)) {
    existed = true
    try { data = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { data = {} }
  }
  if (!data.mcpServers || typeof data.mcpServers !== 'object') data.mcpServers = {}
  const action = data.mcpServers[serverName] ? (force ? 'overwritten' : 'skipped') : 'added'
  if (action !== 'skipped') data.mcpServers[serverName] = serverConfig
  const bak = action === 'skipped' ? null : backup(file)
  if (action !== 'skipped') fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n')
  return { file, action, existed, backup: bak, home }
}

function upsertTomlBlock(file, block, { force = false } = {}) {
  const START = `# >>> ${BRIDGE_NAME}-bridge >>>`
  const END = `# <<< ${BRIDGE_NAME}-bridge <<<`
  fs.mkdirSync(path.dirname(file), { recursive: true })
  let text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
  const hasBlock = text.includes(START)
  if (hasBlock && !force) return { file, action: 'skipped', existed: true, backup: null }
  let bak = null
  if (hasBlock) {
    const begin = text.indexOf(START)
    const end = text.indexOf(END)
    text = (text.slice(0, begin) + text.slice(end + END.length)).replace(/^\n{3,}/m, '\n\n')
  }
  bak = backup(file)
  const next = text.trimEnd() + `\n\n${START}\n${block}\n${END}\n`
  fs.writeFileSync(file, next)
  return { file, action: hasBlock ? 'overwritten' : 'added', existed: fs.existsSync(file), backup: bak }
}

export function buildServerConfigs({ projectDir, config, nodeBin = 'node' }) {
  const url = baseUrl(config)
  const stdioPath = path.join(projectDir, 'bridge', 'src', 'mcp-stdio.mjs')
  const env = { QZZS_BRIDGE_URL: url, QZZS_BRIDGE_TOKEN: config.token }
  return {
    stdio: { command: nodeBin, args: [stdioPath], env },
    http: {
      type: 'http',
      url: `${url}/mcp`,
      headers: { Authorization: `Bearer ${config.token}` },
    },
    rest: {
      baseUrl: url,
      token: config.token,
      endpoints: {
        health: 'GET /health',
        tools: 'GET /tools',
        call: 'POST /rpc  { "tool": "...", "args": {...} }',
        events: 'GET /events (SSE)',
      },
    },
  }
}

/**
 * @param {object} opts
 * @param {string} opts.projectDir 项目根目录（绝对路径）
 * @param {object} opts.config daemon 配置
 * @param {string[]} opts.targets claude-code | codex | cursor | universal | openclaw
 * @param {boolean} opts.force 覆盖同名配置
 * @param {string} opts.home 覆盖用户主目录（自测用）
 * @param {string} opts.outDir 生成通用片段的输出目录，默认 ~/.qiuzhizhushou
 */
export function generateIntegrations(opts) {
  const {
    projectDir, config,
    targets = ['claude-code', 'codex', 'cursor', 'universal', 'openclaw'],
    force = false,
    home = os.homedir(),
    outDir = path.join(home, '.qiuzhizhushou'),
  } = opts
  const servers = buildServerConfigs({ projectDir, config })
  const name = 'qiuzhizhushou'
  const results = []

  fs.mkdirSync(outDir, { recursive: true })

  if (targets.includes('claude-code')) {
    results.push({
      target: 'Claude Code',
      ...writeJsonMerged(path.join(home, '.claude.json'), name, servers.stdio, { force, home }),
    })
  }

  if (targets.includes('cursor')) {
    results.push({
      target: 'Cursor',
      ...writeJsonMerged(path.join(home, '.cursor', 'mcp.json'), name, servers.stdio, { force, home }),
    })
  }

  if (targets.includes('codex')) {
    const toml = [
      '[mcp_servers.qiuzhizhushou]',
      `command = ${JSON.stringify(servers.stdio.command)}`,
      `args = ${JSON.stringify(servers.stdio.args)}`,
      `env = { QZZS_BRIDGE_URL = ${JSON.stringify(servers.stdio.env.QZZS_BRIDGE_URL)}, QZZS_BRIDGE_TOKEN = ${JSON.stringify(servers.stdio.env.QZZS_BRIDGE_TOKEN)} }`,
    ].join('\n')
    results.push({
      target: 'Codex CLI',
      ...upsertTomlBlock(path.join(home, '.codex', 'config.toml'), toml, { force }),
    })
  }

  if (targets.includes('universal')) {
    const file = path.join(outDir, 'mcp-config.json')
    const payload = {
      _comment: '通用 MCP 配置片段：可粘贴到任意支持 MCP 的客户端（Cline / Windsurf / ChatWise / Cherry Studio 等）',
      stdio: { mcpServers: { [name]: servers.stdio } },
      http: { mcpServers: { [name]: servers.http } },
    }
    fs.writeFileSync(file, JSON.stringify(payload, null, 2) + '\n', { mode: 0o600 })
    results.push({ target: '通用 MCP 片段', file, action: 'written', backup: null })
  }

  if (targets.includes('openclaw')) {
    const file = path.join(outDir, 'openclaw-bridge.json')
    fs.writeFileSync(file, JSON.stringify({
      _comment: 'OpenClaw / 小龙虾 bot 接入：优先用 HTTP MCP；若你的小龙虾只支持 HTTP 工具，用下面的 rest 端点。',
      httpMcp: servers.http,
      rest: servers.rest,
      skillDoc: path.join(projectDir, 'bridge', 'integrations', 'openclaw-skill.md'),
    }, null, 2) + '\n', { mode: 0o600 })
    results.push({ target: 'OpenClaw 小龙虾', file, action: 'written', backup: null })
  }

  return { results, servers }
}

export function formatIntegrationReport(report) {
  return report.results.map((r) => {
    const action = { added: '新增', overwritten: '覆盖', skipped: '已存在·跳过', written: '已生成' }[r.action] || r.action
    let line = `  [${action}] ${r.target.padEnd(16)} ${r.file}`
    if (r.backup) line += `\n         备份：${r.backup}`
    return line
  }).join('\n')
}
