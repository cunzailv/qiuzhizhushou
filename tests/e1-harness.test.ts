// E1+E3 单测：工具协议化（校验/映射）+ 权限三档（分级/覆盖）+ 审计 CSV
import { describe, it, expect } from 'vitest'
import { actionToToolCall, getTool, listTools, type ToolDefinition } from '../src/shared/agent/tool-registry'
import { decidePermission } from '../src/shared/agent/permission'
import { auditToCsv } from '../src/shared/db/audit-store'
import type { AgentAction } from '../src/shared/agent/types'

describe('E1 工具协议化', () => {
  it('注册表包含全部 7 类基础工具', () => {
    const tools = listTools()
    for (const name of ['click', 'type', 'wait', 'scroll', 'press_enter', 'press_escape', 'done']) {
      expect(tools).toContain(name)
    }
  })

  it('click 缺合法 target 时校验失败', () => {
    const click = getTool('click') as ToolDefinition
    const err = click.validate?.({})
    expect(err).toMatch(/target/)
  })

  it('type 缺 text 时校验失败', () => {
    const type = getTool('type') as ToolDefinition
    const err = type.validate?.({ target: { kind: 'css_selector', value: '#input' }, text: '' })
    expect(err).toMatch(/text/)
  })

  it('type 合法入参通过校验', () => {
    const type = getTool('type') as ToolDefinition
    const err = type.validate?.({ target: { kind: 'css_selector', value: '#input' }, text: '你好' })
    expect(err).toBeNull()
  })

  it('AgentAction 正确映射到工具调用', () => {
    const click: AgentAction = { type: 'click', target: { kind: 'button_text', value: '投递' } }
    const call = actionToToolCall(click)
    expect(call?.tool).toBe('click')
    expect(call?.payload).toEqual({ kind: 'button_text', value: '投递' })

    const done: AgentAction = { type: 'done' }
    expect(actionToToolCall(done)?.tool).toBe('done')

    const unknown = actionToToolCall({ type: 'hack' } as any)
    expect(unknown).toBeNull()
  })
})

describe('E3 权限三档', () => {
  it('投递动作默认 confirm，可配置为 auto/denied', async () => {
    const d1 = await decidePermission('click', { goal: '投递简历', targetValue: '投递' }, { apply: 'confirm' })
    expect(d1.level).toBe('confirm')
    expect(d1.message).toBeTruthy()

    const d2 = await decidePermission('click', { goal: '投递简历' }, { apply: 'auto' })
    expect(d2.level).toBe('auto')

    const d3 = await decidePermission('click', { goal: '投递简历' }, { apply: 'denied' })
    expect(d3.level).toBe('denied')
  })

  it('发送消息（带文本）按 send 档位，默认 confirm', async () => {
    const d = await decidePermission('press_enter', { goal: '发送打招呼', text: '您好' }, { send: 'confirm' })
    expect(d.level).toBe('confirm')

    const auto = await decidePermission('press_enter', { goal: '发送打招呼', text: '您好' }, { send: 'auto' })
    expect(auto.level).toBe('auto')
  })

  it('普通点击（打开详情）自动执行', async () => {
    const d = await decidePermission('click', { goal: 'open_detail', targetValue: '职位详情' }, { apply: 'confirm', send: 'confirm' })
    expect(d.level).toBe('auto')
  })

  it('读取/等待类动作自动执行', async () => {
    for (const tool of ['wait', 'scroll', 'done', 'press_escape']) {
      const d = await decidePermission(tool, { goal: 'open_detail' })
      expect(d.level).toBe('auto')
    }
  })

  it('覆盖参数只作用于显式场景，不污染其他动作', async () => {
    const d = await decidePermission('click', { goal: 'open_detail' }, { apply: 'denied' })
    expect(d.level).toBe('auto')
  })
})

describe('E6 审计 CSV（纯函数）', () => {
  it('生成带表头的 CSV', () => {
    const csv = auditToCsv([
      {
        id: 'a', createdAt: '2026-10-12T00:00:00Z', source: 'agent', platform: 'boss',
        goal: 'click_chat', tool: 'click', permissionLevel: 'auto', result: 'success',
        durationMs: 120, verified: true, stateFrom: 'matched', stateTo: 'applied',
      },
    ])
    expect(csv).toContain('时间,来源,平台,目标,动作,权限,结果,耗时ms,验证,错误,状态迁移')
    expect(csv).toContain('2026-10-12T00:00:00Z,agent,boss,click_chat,click,auto,success,120,true,,matched->applied')
  })

  it('错误信息中的逗号/换行被清洗', () => {
    const csv = auditToCsv([
      { id: 'a', createdAt: 't', source: 'agent', result: 'failed', error: 'a,b\nc' },
    ])
    expect(csv).not.toContain('a,b')
    expect(csv).toContain('a b c')
  })
})
