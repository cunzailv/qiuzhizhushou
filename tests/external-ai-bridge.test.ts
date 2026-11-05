import { describe, it, expect } from 'vitest'
import {
  TOOL_DEFINITIONS, TOOL_COUNTS, getTool, buildManifest, validateArgs,
  gateTool, redactSettings, toCsv,
} from '../src/shared/bridge/tools'
import { normalizeConfig } from '../src/shared/bridge/config'
import { DEFAULT_EXTERNAL_AI_CONFIG, DEFAULT_BRIDGE_URL } from '../src/shared/bridge/types'
import type { ExternalAiConfig, ToolDefinition } from '../src/shared/bridge/types'

const baseConfig: ExternalAiConfig = {
  enabled: true, allowWrite: true, allowDangerous: false,
  bridgeUrl: DEFAULT_BRIDGE_URL, token: 'abc', paired: true,
}

describe('外部 AI 工具清单', () => {
  it('工具名唯一且定义完整', () => {
    const names = TOOL_DEFINITIONS.map((t) => t.name)
    expect(new Set(names).size).toBe(names.length)
    for (const tool of TOOL_DEFINITIONS) {
      expect(tool.description.length).toBeGreaterThan(4)
      expect(tool.inputSchema.type).toBe('object')
      expect(['read', 'write', 'dangerous']).toContain(tool.risk)
    }
  })

  it('三级分级统计与总数一致', () => {
    expect(TOOL_COUNTS.total).toBe(TOOL_DEFINITIONS.length)
    expect(TOOL_COUNTS.read + TOOL_COUNTS.write + TOOL_COUNTS.dangerous).toBe(TOOL_COUNTS.total)
    expect(TOOL_COUNTS.read).toBeGreaterThan(15)
    expect(TOOL_COUNTS.dangerous).toBeGreaterThan(5)
  })

  it('覆盖项目主要能力域（简历/黑名单/面试/日报/诊断/导出/campaign）', () => {
    const names = new Set(TOOL_DEFINITIONS.map((t) => t.name))
    for (const required of [
      'get_status', 'get_campaign_stats', 'start_campaign', 'stop_campaign',
      'list_applications', 'list_resumes', 'get_default_resume', 'list_blacklist',
      'list_interviews', 'get_daily_report', 'get_fix_suggestions',
      'export_applications_csv', 'set_platform_quota', 'dispatch_butler_chat',
    ]) expect(names.has(required)).toBe(true)
  })

  it('buildManifest 带协议版本与扩展版本', () => {
    const manifest = buildManifest('1.2.3')
    expect(manifest.protocol).toBe('1')
    expect(manifest.extensionVersion).toBe('1.2.3')
    expect(manifest.tools.length).toBe(TOOL_COUNTS.total)
  })

  it('未知工具返回 undefined', () => {
    expect(getTool('not_exist')).toBeUndefined()
  })
})

describe('参数校验', () => {
  const tool = getTool('set_platform_quota') as ToolDefinition

  it('缺少必填参数时报错', () => {
    expect(validateArgs(tool, { platform: 'boss' })).toContain('quota')
    expect(validateArgs(tool, { quota: 20 })).toContain('platform')
  })

  it('类型不符时报错', () => {
    expect(validateArgs(tool, { platform: 123, quota: 20 })).toContain('类型')
    expect(validateArgs(tool, { platform: 'boss', quota: 'abc' })).toContain('类型')
  })

  it('合法参数通过', () => {
    expect(validateArgs(tool, { platform: 'boss', quota: 20 })).toBeNull()
  })

  it('enum 约束生效', () => {
    const withEnum: ToolDefinition = {
      ...tool,
      inputSchema: { type: 'object', properties: { mode: { type: 'string', enum: ['a', 'b'] } } },
    }
    expect(validateArgs(withEnum, { mode: 'c' })).toContain('只能是')
    expect(validateArgs(withEnum, { mode: 'a' })).toBeNull()
  })

  it('危险工具把 confirm 列为必填', () => {
    const start = getTool('start_campaign') as ToolDefinition
    expect(start.inputSchema.required).toContain('confirm')
    expect(validateArgs(start, {})).toContain('confirm')
  })
})

describe('安全门禁（fail-closed）', () => {
  const read = getTool('get_status') as ToolDefinition
  const write = getTool('add_blacklist') as ToolDefinition
  const dangerous = getTool('start_campaign') as ToolDefinition

  it('总开关关闭时连只读也拒绝', () => {
    const decision = gateTool(read, { ...baseConfig, enabled: false }, {})
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toContain('未开启')
  })

  it('默认配置就是 fail-closed', () => {
    expect(DEFAULT_EXTERNAL_AI_CONFIG.enabled).toBe(false)
    expect(DEFAULT_EXTERNAL_AI_CONFIG.allowDangerous).toBe(false)
    expect(normalizeConfig({})).toEqual(DEFAULT_EXTERNAL_AI_CONFIG)
    expect(gateTool(dangerous, DEFAULT_EXTERNAL_AI_CONFIG, { confirm: true }).allowed).toBe(false)
  })

  it('只读工具在开启后直接放行', () => {
    expect(gateTool(read, baseConfig, {}).allowed).toBe(true)
  })

  it('未授权写入时被拒绝', () => {
    const decision = gateTool(write, { ...baseConfig, allowWrite: false }, { companyName: 'X' })
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toContain('写入动作未授权')
  })

  it('危险动作默认拒绝，即使带 confirm', () => {
    const decision = gateTool(dangerous, baseConfig, { confirm: true })
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toContain('危险动作未授权')
  })

  it('授权后仍必须每次显式 confirm=true', () => {
    const cfg = { ...baseConfig, allowDangerous: true }
    expect(gateTool(dangerous, cfg, {}).allowed).toBe(false)
    expect(gateTool(dangerous, cfg, { confirm: false }).allowed).toBe(false)
    expect(gateTool(dangerous, cfg, { confirm: 'true' }).allowed).toBe(false)
    expect(gateTool(dangerous, cfg, { confirm: true }).allowed).toBe(true)
  })
})

describe('配置与脱敏', () => {
  it('非法桥接地址回退到本机默认地址', () => {
    expect(normalizeConfig({ bridgeUrl: 'https://evil.example.com' }).bridgeUrl).toBe(DEFAULT_BRIDGE_URL)
    expect(normalizeConfig({ bridgeUrl: 'http://192.168.1.9:18790' }).bridgeUrl).toBe(DEFAULT_BRIDGE_URL)
    expect(normalizeConfig({ bridgeUrl: 'http://localhost:18790/' }).bridgeUrl).toBe('http://localhost:18790')
    expect(normalizeConfig({ bridgeUrl: 'http://127.0.0.1:19000' }).bridgeUrl).toBe('http://127.0.0.1:19000')
  })

  it('脏配置不会意外开启权限', () => {
    const cfg = normalizeConfig({ enabled: 'true', allowDangerous: 1, allowWrite: 'no' })
    expect(cfg.enabled).toBe(false)
    expect(cfg.allowDangerous).toBe(false)
    expect(cfg.allowWrite).toBe(true)
  })

  it('敏感字段被脱敏，普通字段保留', () => {
    const out = redactSettings({
      modelPreset: 'deepseek',
      apiKey: 'sk-secret-123',
      nested: { token: 'abc', salaryFloor: 20000 },
      webhookUrl: 'https://example.com/hook',
    }) as Record<string, unknown>
    expect(out.modelPreset).toBe('deepseek')
    expect(out.apiKey).toBe('***已脱敏***')
    expect(out.webhookUrl).toBe('***已脱敏***')
    expect((out.nested as Record<string, unknown>).token).toBe('***已脱敏***')
    expect((out.nested as Record<string, unknown>).salaryFloor).toBe(20000)
  })

  it('脱敏不修改原对象', () => {
    const input = { apiKey: 'secret' }
    redactSettings(input)
    expect(input.apiKey).toBe('secret')
  })
})

describe('CSV 导出（纯文本，不下载）', () => {
  it('带 BOM 且转义逗号、引号、换行', () => {
    const csv = toCsv(['名称', '备注'], [['A,B', '他说 "你好"\n换行']])
    expect(csv.startsWith('\uFEFF')).toBe(true)
    expect(csv).toContain('"A,B"')
    expect(csv).toContain('"他说 ""你好""\n换行"')
  })

  it('空值转为空字符串', () => {
    expect(toCsv(['a', 'b'], [[null, undefined]])).toBe('\uFEFFa,b\r\n,')
  })
})
