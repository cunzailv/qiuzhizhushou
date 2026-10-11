// F1+F2 单测：提示词注册表（默认值完整性/覆盖回退）+ 智能体角色预设（参数映射）
import { describe, it, expect } from 'vitest'
import { PROMPT_REGISTRY, getPrompt, getPromptOverrides, PROMPT_DEFAULTS } from '../src/shared/db/prompt-store'
import { AGENT_ROLES, getAgentRole } from '../src/shared/agent/agent-role'

describe('F1 提示词注册表', () => {
  it('注册表包含 8 个提示词，覆盖三类（AI/管家/自动化）', () => {
    const keys = PROMPT_REGISTRY.map((p) => p.key)
    for (const key of ['ai.match', 'ai.resumeEnrich', 'ai.jdAnalyze', 'ai.gapReport', 'ai.resumeAnalyze', 'butler.greeting', 'butler.reply', 'agent.system']) {
      expect(keys).toContain(key)
    }
    expect(new Set(PROMPT_REGISTRY.map((p) => p.category))).toEqual(new Set(['ai', 'butler', 'agent']))
  })

  it('每个提示词都有非空默认值与面向后台的 label/描述', () => {
    for (const def of PROMPT_REGISTRY) {
      const minLen = def.key === 'butler.reply' ? 10 : 50
      expect(def.default.length, def.key).toBeGreaterThan(minLen)
      expect(def.label.length).toBeGreaterThan(0)
      expect(def.description.length).toBeGreaterThan(0)
    }
  })

  it('默认提示词包含对应角色的关键指令（不因注册化丢失语义）', () => {
    expect(PROMPT_DEFAULTS['ai.match']).toMatch(/维度打分/)
    expect(PROMPT_DEFAULTS['ai.resumeEnrich']).toMatch(/yearsOfExperience/)
    expect(PROMPT_DEFAULTS['ai.jdAnalyze']).toMatch(/hardRequirements/)
    expect(PROMPT_DEFAULTS['ai.gapReport']).toMatch(/resumeTailoringPoints/)
    expect(PROMPT_DEFAULTS['butler.greeting']).toMatch(/打招呼/)
    expect(PROMPT_DEFAULTS['agent.system']).toMatch(/button_text/)
  })

  it('getPrompt：无存储环境下回退传入的 fallback（与旧代码行为一致）', async () => {
    const fallback = '旧内置提示词'
    const got = await getPrompt('ai.match', fallback)
    expect(got).toBe(fallback)
  })

  it('getPrompt：未注册 key 且无 fallback 返回空串', async () => {
    expect(await getPrompt('no.such.key')).toBe('')
  })

  it('getPromptOverrides：无存储时返回空对象', async () => {
    const overrides = await getPromptOverrides()
    expect(overrides).toEqual({})
  })
})

describe('F2 智能体角色预设', () => {
  it('三个角色齐全：激进海投 / 保守精投 / 自定义', () => {
    const ids = AGENT_ROLES.map((r) => r.id)
    expect(ids).toEqual(['aggressive', 'conservative', 'custom'])
    for (const r of AGENT_ROLES) {
      expect(r.name.length).toBeGreaterThan(0)
      expect(r.description.length).toBeGreaterThan(10)
    }
  })

  it('激进海投：不评分 + 批量沟通（快速铺量）', () => {
    const aggressive = AGENT_ROLES.find((r) => r.id === 'aggressive')
    expect(aggressive?.params).toMatchObject({ enableAiMatch: false, applyMode: 'batch' })
  })

  it('保守精投：AI 评分 + 推荐确认（精准打击）', () => {
    const conservative = AGENT_ROLES.find((r) => r.id === 'conservative')
    expect(conservative?.params).toMatchObject({ enableAiMatch: true, applyMode: 'recommend' })
  })

  it('自定义：不改动任何参数', () => {
    const custom = AGENT_ROLES.find((r) => r.id === 'custom')
    expect(custom?.params).toBeNull()
  })

  it('角色参数不含安全护栏键（权限三档不受角色影响）', () => {
    for (const r of AGENT_ROLES) {
      const keys = Object.keys(r.params ?? {})
      expect(keys).not.toContain('permission_apply')
      expect(keys).not.toContain('permission_send')
    }
  })

  it('getAgentRole：无存储时默认 custom', async () => {
    expect(await getAgentRole()).toBe('custom')
  })
})
