/**
 * 智能求职助手 · 本地 AI 桥接服务 —— 配置与状态持久化
 *
 * 零第三方依赖，只用 Node 内置模块。配置文件默认位于 ~/.qiuzhizhushou/bridge.json，
 * 可用环境变量 QZZS_BRIDGE_CONFIG 覆盖（自测用）。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'

export const DEFAULT_PORT = 18790
export const DEFAULT_HOST = '127.0.0.1'
export const BRIDGE_NAME = 'qiuzhizhushou'
export const BRIDGE_VERSION = '1.2.0'
export const PROTOCOL_VERSION = '1'

export function configPath() {
  return process.env.QZZS_BRIDGE_CONFIG || path.join(os.homedir(), '.qiuzhizhushou', 'bridge.json')
}

export function stateDir() {
  return path.dirname(configPath())
}

export function pidPath() {
  return path.join(stateDir(), 'bridge.pid')
}

export function logPath() {
  return path.join(stateDir(), 'bridge.log')
}

export function generateToken() {
  return crypto.randomBytes(24).toString('hex')
}

export function defaultConfig() {
  return {
    version: 1,
    host: DEFAULT_HOST,
    port: DEFAULT_PORT,
    token: generateToken(),
    pairUsed: false,
    createdAt: new Date().toISOString(),
    projectDir: '',
  }
}

/** 读取配置；不存在时创建一份并返回 { config, created: true } */
export function loadConfig({ create = true } = {}) {
  const file = configPath()
  try {
    const raw = fs.readFileSync(file, 'utf8')
    const parsed = JSON.parse(raw)
    return { config: { ...defaultConfig(), ...parsed }, created: false }
  } catch {
    if (!create) return { config: defaultConfig(), created: false }
    const config = defaultConfig()
    saveConfig(config)
    return { config, created: true }
  }
}

export function saveConfig(config) {
  const file = configPath()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  // token 属于本机凭据，尽量收紧权限（Windows 忽略 mode）
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 })
  try { fs.chmodSync(file, 0o600) } catch { /* Windows 无 chmod，忽略 */ }
  return config
}

export function baseUrl(config = loadConfig().config) {
  return `http://${config.host}:${config.port}`
}

/** 从 Authorization 头 / query / body 中提取 token，做恒定时间比较 */
export function tokenFromRequest(req, url, body) {
  const header = req.headers['authorization'] || ''
  const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : ''
  const queryToken = url.searchParams.get('token') || ''
  const bodyToken = typeof body?.token === 'string' ? body.token : ''
  const headerToken = req.headers['x-qzzs-token'] || ''
  return bearer || queryToken || bodyToken || String(headerToken)
}

export function safeTokenEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) return false
  return crypto.timingSafeEqual(bufA, bufB)
}

export function redactToken(token) {
  if (!token) return '(未设置)'
  return `${token.slice(0, 6)}…${token.slice(-4)}`
}
