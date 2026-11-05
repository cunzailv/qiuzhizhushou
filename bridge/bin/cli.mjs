#!/usr/bin/env node
/**
 * 智能求职助手 · 外部 AI 接入 CLI
 *
 *   node bridge/bin/cli.mjs setup          一条龙：下载依赖 → 构建扩展 → 生成配置 → 写 MCP → 启动服务 → 体检
 *   node bridge/bin/cli.mjs start|stop|restart|status
 *   node bridge/bin/cli.mjs doctor        逐项体检 + 修复建议
 *   node bridge/bin/cli.mjs integrations  只重新生成各 AI 客户端配置
 *   node bridge/bin/cli.mjs token        查看/重置访问令牌
 *   node bridge/bin/cli.mjs pair-reset   允许扩展重新配对
 *   node bridge/bin/cli.mjs mcp          以 stdio 方式运行 MCP Server（供客户端拉起）
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawn, execFileSync } from 'node:child_process'
import {
  configPath, pidPath, logPath, loadConfig, saveConfig, baseUrl,
  generateToken, redactToken, BRIDGE_VERSION,
} from '../src/config.mjs'
import { generateIntegrations, formatIntegrationReport } from '../src/integrations.mjs'
import { runDoctor, formatDoctor } from '../src/doctor.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PROJECT_DIR = path.resolve(HERE, '..', '..')
const SERVER_ENTRY = path.join(HERE, '..', 'src', 'server.mjs')
const MCP_ENTRY = path.join(HERE, '..', 'src', 'mcp-stdio.mjs')

function parseArgs(argv) {
  const out = { _: [], home: os.homedir() }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith('--')) { out._.push(arg); continue }
    const [key, inline] = arg.slice(2).split('=')
    if (['skip-build', 'skip-clients', 'no-start', 'force', 'rebuild', 'offline', 'quiet', 'json'].includes(key)) {
      out[key] = true
    } else {
      out[key] = inline ?? argv[++i]
    }
  }
  return out
}

function printBanner() {
  process.stdout.write(`\n智能求职助手 · 外部 AI 接入  v${BRIDGE_VERSION}\n项目目录：${PROJECT_DIR}\n\n`)
}

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, {
    cwd: PROJECT_DIR,
    stdio: opts.quiet ? 'pipe' : 'inherit',
    env: { ...process.env, ...(opts.env || {}) },
    encoding: 'utf8',
  })
}

function nodeOk() {
  const major = Number(process.versions.node.split('.')[0])
  if (major < 18) {
    process.stderr.write(`✗ 需要 Node.js ≥ 18，当前 v${process.versions.node}\n`)
    process.exit(1)
  }
  return true
}

/** 构建扩展产物；dist 已存在时默认跳过，避免重复清空目录 */
function ensureDist(args) {
  const manifest = path.join(PROJECT_DIR, 'dist', 'manifest.json')
  if (fs.existsSync(manifest) && !args.rebuild) {
    let version = '?'
    try { version = JSON.parse(fs.readFileSync(manifest, 'utf8')).version } catch { /* ignore */ }
    process.stdout.write(`✓ 扩展产物已存在 dist/（v${version}），跳过构建（加 --rebuild 可强制重建）\n`)
    return { built: false, version }
  }
  const viteBin = path.join(PROJECT_DIR, 'node_modules', '.bin', 'vite')
  if (!fs.existsSync(viteBin) && !args.offline) {
    process.stdout.write('→ 安装项目依赖（npm install）…\n')
    run('npm', ['install'], { quiet: args.quiet })
  }
  process.stdout.write('→ 类型检查 + 构建扩展（dist/）…\n')
  run('npx', ['tsc', '-b'], { quiet: args.quiet })
  run('npx', ['vite', 'build', '--outDir', 'dist', '--emptyOutDir'], { quiet: args.quiet })
  const version = JSON.parse(fs.readFileSync(manifest, 'utf8')).version
  process.stdout.write(`✓ 构建完成 dist/（v${version}）\n`)
  return { built: true, version }
}

async function waitHealth(url, timeoutMs = 6000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(800) })
      if (res.ok) return await res.json()
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 250))
  }
  return null
}

function isRunning() {
  try {
    const pid = Number(fs.readFileSync(pidPath(), 'utf8').trim())
    if (!pid) return false
    process.kill(pid, 0)
    return pid
  } catch { return false }
}

async function startDaemon(args = {}) {
  const existing = isRunning()
  if (existing) {
    process.stdout.write(`✓ 桥接服务已在运行（pid ${existing}）\n`)
    return true
  }
  const out = fs.openSync(logPath(), 'a')
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: PROJECT_DIR,
    detached: true,
    stdio: ['ignore', out, out],
    env: { ...process.env, QZZS_BRIDGE_QUIET: '1' },
  })
  child.unref()
  fs.closeSync(out)
  fs.mkdirSync(path.dirname(pidPath()), { recursive: true })
  fs.writeFileSync(pidPath(), String(child.pid))
  const health = await waitHealth(baseUrl(loadConfig().config))
  if (!health) {
    process.stderr.write(`✗ 服务启动后未通过健康检查，请查看日志：${logPath()}\n`)
    return false
  }
  process.stdout.write(`✓ 桥接服务已启动 ${health.url}（pid ${child.pid}）\n`)
  return true
}

async function stopDaemon() {
  const pid = isRunning()
  if (!pid) {
    try { fs.unlinkSync(pidPath()) } catch { /* ignore */ }
    process.stdout.write('· 桥接服务未运行\n')
    return true
  }
  try { process.kill(pid, 'SIGTERM') } catch { /* ignore */ }
  await new Promise((r) => setTimeout(r, 400))
  try { fs.unlinkSync(pidPath()) } catch { /* ignore */ }
  process.stdout.write(`✓ 已停止桥接服务（pid ${pid}）\n`)
  return true
}

async function setup(args) {
  printBanner()
  nodeOk()
  if (args.config) process.env.QZZS_BRIDGE_CONFIG = path.resolve(args.config)
  if (args.port) process.env.QZZS_BRIDGE_PORT = String(args.port)

  process.stdout.write('【1/6】检查环境与扩展产物\n')
  ensureDist(args)

  process.stdout.write('\n【2/6】生成桥接配置与访问令牌\n')
  const { config, created } = loadConfig()
  if (args.port) { config.port = Number(args.port); saveConfig(config) }
  config.projectDir = PROJECT_DIR
  saveConfig(config)
  process.stdout.write(`  ${created ? '新建' : '复用'}配置：${configPath()}\n`)
  process.stdout.write(`  监听地址：${baseUrl(config)}（仅本机）\n`)
  process.stdout.write(`  访问令牌：${redactToken(config.token)}\n`)

  process.stdout.write('\n【3/6】写入各 AI 客户端的 MCP 配置\n')
  if (args['skip-clients']) {
    process.stdout.write('  · 已跳过（--skip-clients）\n')
  } else {
    const report = generateIntegrations({
      projectDir: PROJECT_DIR, config, home: args.home,
      force: !!args.force,
      outDir: path.join(args.home, '.qiuzhizhushou'),
    })
    process.stdout.write(formatIntegrationReport(report) + '\n')
  }

  process.stdout.write('\n【4/6】启动本地桥接服务\n')
  const started = args['no-start'] ? true : await startDaemon(args)
  if (!started) return 1

  process.stdout.write('\n【5/6】体检\n')
  const doctor = await runDoctor({ projectDir: PROJECT_DIR, home: args.home, config })
  process.stdout.write(formatDoctor(doctor) + '\n')

  process.stdout.write('\n【6/6】最后两步（浏览器沙箱限制，脚本无法代劳）\n')
  process.stdout.write(`  1) 打开 chrome://extensions → 开发者模式 → 加载已解压的扩展程序 → 选择：\n     ${path.join(PROJECT_DIR, 'dist')}\n`)
  process.stdout.write('  2) 打开扩展「设置 → 外部 AI 接入」→ 开启接入 → 点「连接本地桥接」自动配对\n')
  process.stdout.write('     配对完成后状态变绿，Claude Code / Codex / 小龙虾即可直接调用。\n')
  process.stdout.write('\n  常用命令：node bridge/bin/cli.mjs doctor | status | restart | token\n')
  process.stdout.write(`  日志：${logPath()}\n\n`)
  return 0
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const [cmd = 'help', ...rest] = args._
  if (args.config) process.env.QZZS_BRIDGE_CONFIG = path.resolve(args.config)
  if (args.home) process.env.QZZS_BRIDGE_HOME = args.home

  switch (cmd) {
    case 'setup': process.exitCode = await setup(args); break
    case 'start': await startDaemon(args); break
    case 'stop': await stopDaemon(); break
    case 'restart': await stopDaemon(); await startDaemon(args); break
    case 'status': {
      const { config } = loadConfig()
      try {
        const health = await waitHealth(baseUrl(config), 1500)
        process.stdout.write(health ? JSON.stringify(health, null, 2) + '\n' : '· 桥接服务未运行\n')
      } catch { process.stdout.write('· 桥接服务未运行\n') }
      break
    }
    case 'doctor': {
      const { config } = loadConfig()
      const result = await runDoctor({ projectDir: PROJECT_DIR, home: args.home, config })
      process.stdout.write(formatDoctor(result) + '\n\n')
      process.exitCode = result.passed === result.total ? 0 : 1
      break
    }
    case 'integrations': {
      const { config } = loadConfig()
      const report = generateIntegrations({
        projectDir: PROJECT_DIR, config, home: args.home, force: !!args.force,
        outDir: path.join(args.home, '.qiuzhizhushou'),
      })
      process.stdout.write(formatIntegrationReport(report) + '\n')
      break
    }
    case 'token': {
      const { config } = loadConfig()
      if (rest[0] === 'reset') {
        config.token = generateToken()
        config.pairUsed = false
        saveConfig(config)
        process.stdout.write(`✓ 令牌已重置：${config.token}\n  请运行 pair-reset 已完成（pairUsed=false），并重新生成客户端配置：integrations --force\n`)
      } else {
        process.stdout.write(`${config.token}\n`)
      }
      break
    }
    case 'pair-reset': {
      const { config } = loadConfig()
      config.pairUsed = false
      saveConfig(config)
      process.stdout.write('✓ 已允许扩展重新配对（下一次「连接本地桥接」会成功）\n')
      break
    }
    case 'config': {
      const { config } = loadConfig()
      process.stdout.write(JSON.stringify({ ...config, token: redactToken(config.token) }, null, 2) + '\n')
      break
    }
    case 'mcp': {
      await import(MCP_ENTRY)
      break
    }
    default:
      process.stdout.write([
        '用法：node bridge/bin/cli.mjs <命令> [选项]',
        '',
        '  setup           一条龙安装配置（下载依赖 / 构建 / 生成 MCP 配置 / 启动 / 体检）',
        '  start           启动常驻桥接服务',
        '  stop            停止桥接服务',
        '  restart         重启',
        '  status          查看服务状态',
        '  doctor          逐项体检并给出修复建议',
        '  integrations    重新生成 Claude Code / Codex / Cursor / 小龙虾 的 MCP 配置',
        '  token [reset]   查看或重置访问令牌',
        '  pair-reset      允许扩展重新配对',
        '  config          查看配置（令牌脱敏）',
        '  mcp             以 stdio 运行 MCP Server（一般由客户端自动拉起）',
        '',
        '常用选项：--home <目录>  --config <文件>  --port <端口>  --force  --skip-build  --skip-clients  --no-start  --rebuild',
        '',
      ].join('\n'))
  }
}

main().catch((err) => {
  process.stderr.write(`✗ ${err?.stack || err}\n`)
  process.exitCode = 1
})
