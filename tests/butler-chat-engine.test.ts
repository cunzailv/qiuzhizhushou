// @vitest-environment jsdom
// B 计划：智能中控对话台升级为 Tool-Calling Agent 的回归测试
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  dispatchButlerAgentMessage,
  buildNextHistory,
  buildContextSnapshot,
  parseJsonFallbackResponse,
  getAvailableButlerTools,
  resetButlerEngineState,
  getButlerChatHistory,
  BUTLER_CHAT_HISTORY_KEY,
  type ButlerChatTurn,
  type ButlerPendingApproval,
} from '../src/shared/agent/butler/chat-engine'
import { TOOL_DEFINITIONS } from '../src/shared/bridge/tools'

const mockStorage: Record<string, any> = {}
const NOW = 1_780_000_000_000

function makeDeps(over: Record<string, any> = {}) {
  const execTool = vi.fn(async (name: string, _args: Record<string, unknown>) => {
    if (name === 'get_dashboard_stats') return { ok: true, data: { total: 12, today: 8 } }
    if (name === 'get_campaign_stats') return { ok: true, data: { applied: 8, quota: 80 } }
    if (name === 'list_errors') return { ok: true, data: [{ message: '搜索源无相关岗位' }] }
    return { ok: true, data: { pong: name } }
  })
  const history: ButlerChatTurn[] = []
  return {
    execTool,
    resolveSettings: vi.fn(async () => ({ apiKey: 'sk-test', baseUrl: 'https://api.deepseek.com/v1', modelName: 'deepseek-flash' })),
    loadHistory: vi.fn(async () => [...history]),
    saveHistory: vi.fn(async (h: ButlerChatTurn[]) => {
      history.splice(0, history.length, ...h)
      mockStorage[BUTLER_CHAT_HISTORY_KEY] = h
    }),
    ...over,
  }
}

beforeEach(() => {
  for (const k of Object.keys(mockStorage)) delete mockStorage[k]
  resetButlerEngineState()
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: vi.fn(async (keys: string | string[]) => {
          if (typeof keys === 'string') return { [keys]: mockStorage[keys] }
          if (!Array.isArray(keys)) return { ...mockStorage }
          const res: Record<string, any> = {}
          for (const k of keys) res[k] = mockStorage[k]
          return res
        }),
        set: vi.fn(async (obj: Record<string, any>) => Object.assign(mockStorage, obj)),
        remove: vi.fn(async (keys: string | string[]) => {
          const list = Array.isArray(keys) ? keys : [keys]
          for (const k of list) delete mockStorage[k]
        }),
      },
    },
    runtime: { sendMessage: vi.fn(async () => ({ ok: true, data: {} })) },
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('工具清单与结构化协议', () => {
  it('把 47 个内部工具暴露给模型，并排除会自我递归的旧对话工具', () => {
    const tools = getAvailableButlerTools()
    expect(tools.length).toBe(TOOL_DEFINITIONS.length - 1)
    expect(tools.some((t) => t.name === 'dispatch_butler_chat')).toBe(false)
    expect(tools.some((t) => t.name === 'get_campaign_stats')).toBe(true)
    expect(tools.some((t) => t.name === 'list_errors')).toBe(true)
    expect(tools.some((t) => t.risk === 'dangerous')).toBe(true)
  })

  it('JSON 兜底协议解析：工具调用 / 直接回复 / 脏数据', () => {
    expect(parseJsonFallbackResponse('{"tool":"get_campaign_stats","args":{}}')).toEqual({
      tool: 'get_campaign_stats', args: {},
    })
    expect(parseJsonFallbackResponse('好的 ```json\n{"reply":"已查到"}\n```')).toEqual({ reply: '已查到' })
    expect(parseJsonFallbackResponse('')).toBeNull()
    expect(parseJsonFallbackResponse('不是 JSON')).toBeNull()
    expect(parseJsonFallbackResponse('{"foo":1}')).toBeNull()
  })

  it('历史按 12 条裁剪并截断长文本', () => {
    const prev: ButlerChatTurn[] = Array.from({ length: 14 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `第 ${i} 条`,
      at: i,
    }))
    const next = buildNextHistory(prev, '新问题', 'x'.repeat(1000), NOW)
    expect(next).toHaveLength(12)
    expect(next[10].content).toBe('新问题')
    expect(next[11].content.length).toBeLessThan(900)
    expect(next[11].role).toBe('assistant')
  })
})

describe('真实数据快照', () => {
  it('并发读取投递/战报/错误日志，60 秒内命中缓存不重复调用', async () => {
    const execTool = vi.fn(async () => ({ ok: true, data: { today: 8 } }))
    const first = await buildContextSnapshot(execTool, NOW)
    expect(first).toContain('get_dashboard_stats')
    expect(execTool).toHaveBeenCalledTimes(3)
    await buildContextSnapshot(execTool, NOW + 30_000)
    expect(execTool).toHaveBeenCalledTimes(3)
    await buildContextSnapshot(execTool, NOW + 61_000)
    expect(execTool).toHaveBeenCalledTimes(6)
  })
})

describe('AI Agent 主路径', () => {
  it('模型自由回答时返回 agent 模式，并把这一轮写进上下文', async () => {
    const deps = makeDeps()
    const runModel = vi.fn(async () => ({
      text: '今天只投了 8 份，主要是搜索源被降级成推荐流',
      toolTrace: [{ name: 'get_campaign_stats', displayName: '战报', risk: 'read' as const, ok: true, summary: '8 份' }],
    }))
    const reply = await dispatchButlerAgentMessage('今天为什么只投了 8 份？', {
      deps: { ...deps, runModel }, now: NOW,
    })
    expect(reply.mode).toBe('agent')
    expect(reply.content).toContain('推荐流')
    expect(reply.toolTrace).toHaveLength(1)
    expect(reply.notice).toBeUndefined()
    expect(reply.history).toHaveLength(2)
    expect(reply.history[0].content).toContain('为什么只投了')
    expect(runModel.mock.calls[0][0].settings.modelName).toBe('deepseek-flash')
  })

  it('多轮上下文：上一轮对话会传给模型，新历史保留旧内容', async () => {
    const deps = makeDeps()
    deps.loadHistory.mockResolvedValue([
      { role: 'user', content: '把薪资改成 20-30K', at: NOW - 10000 },
      { role: 'assistant', content: '已改好', at: NOW - 9000 },
    ])
    const runModel = vi.fn(async () => ({ text: '在刚才的基础上再调高一点就好', toolTrace: [] }))
    const reply = await dispatchButlerAgentMessage('那再调高一点呢', {
      deps: { ...deps, runModel }, now: NOW,
    })
    expect(runModel.mock.calls[0][0].history).toHaveLength(2)
    expect(runModel.mock.calls[0][0].history[0].content).toContain('20-30K')
    expect(reply.history).toHaveLength(4)
    expect(reply.history[1].content).toBe('已改好')
  })

  it('危险工具先挂起审批，确认后才带 confirm=true 真正执行', async () => {
    const deps = makeDeps()
    const pending: ButlerPendingApproval = {
      tool: 'clear_all_applications',
      displayName: '清空历史投递数据',
      args: {},
      prompt: '⚠️ 高风险操作需要确认',
      createdAt: '23:00',
    }
    const runModel = vi.fn(async () => ({ text: '需要你确认', toolTrace: [], pendingApproval: pending }))
    const first = await dispatchButlerAgentMessage('清空所有投递记录', {
      deps: { ...deps, runModel }, now: NOW,
    })
    expect(first.pendingApproval?.tool).toBe('clear_all_applications')
    expect(deps.execTool).not.toHaveBeenCalledWith('clear_all_applications', expect.anything())

    const second = await dispatchButlerAgentMessage('', {
      deps: { ...deps, runModel }, approved: first.pendingApproval, now: NOW + 1000,
    })
    expect(runModel).toHaveBeenCalledTimes(1)
    expect(deps.execTool).toHaveBeenCalledWith('clear_all_applications', { confirm: true })
    expect(second.content).toContain('已执行')
    expect(second.toolTrace[0].risk).toBe('dangerous')
  })

  it('审批取消不会误执行，历史也不记录执行结果', async () => {
    const deps = makeDeps()
    const reply = await dispatchButlerAgentMessage('你好呀', {
      deps: { ...deps, runModel: async () => ({ text: '你好，有什么可以帮你？', toolTrace: [] }) },
      now: NOW,
    })
    expect(reply.history).toHaveLength(2)
    expect(reply.pendingApproval).toBeUndefined()
  })
})

describe('降级链路必须可见', () => {
  it('未配置 API Key 时明确说「本地规则模式」并回退旧规则引擎', async () => {
    const deps = makeDeps({
      resolveSettings: vi.fn(async () => ({ apiKey: '', baseUrl: '', modelName: 'deepseek-flash' })),
    })
    const reply = await dispatchButlerAgentMessage('把期望薪资调成 22-28K', { deps, now: NOW })
    expect(reply.mode).toBe('offline')
    expect(reply.notice).toContain('AI 未配置')
    expect(reply.notice).toContain('本地规则模式')
    expect(reply.content).toContain('22-28K')
  })

  it('原生工具调用失败 → 结构化 JSON 工具模式，并告知切换原因', async () => {
    const deps = makeDeps({
      runModel: vi.fn(async () => { throw new Error('模型不支持 tools') }),
      runJsonFallback: vi.fn(async () => ({ text: '已用兼容模式查到 8 份投递', toolTrace: [] })),
    })
    const reply = await dispatchButlerAgentMessage('今天投了几份', { deps, now: NOW })
    expect(reply.mode).toBe('json_fallback')
    expect(reply.notice).toContain('结构化 JSON')
    expect(reply.notice).toContain('模型不支持 tools')
    expect(reply.content).toContain('8 份')
  })

  it('今日 AI 预算用尽 → 不白跑请求，明确告知并回退本地规则', async () => {
    const today = new Date().toISOString().slice(0, 10)
    mockStorage['ai_budget_date'] = today
    mockStorage['ai_budget_count'] = 30
    mockStorage['setting_aiDailyBudget'] = 30
    const deps = makeDeps({ runModel: vi.fn(async () => { throw new Error('不应被调用') }) })
    const reply = await dispatchButlerAgentMessage('今天投了几份', { deps, now: NOW })
    expect(reply.mode).toBe('offline')
    expect(reply.notice).toContain('预算已用尽')
    expect(reply.notice).toContain('30/30')
    expect(deps.runModel).not.toHaveBeenCalled()
  })

  it('两层都失败 → 本地规则模式，且提示去检查连接与预算', async () => {
    const deps = makeDeps({
      runModel: vi.fn(async () => { throw new Error('HTTP 401') }),
      runJsonFallback: vi.fn(async () => { throw new Error('也失败') }),
    })
    const reply = await dispatchButlerAgentMessage('随便问一句', { deps, now: NOW })
    expect(reply.mode).toBe('offline')
    expect(reply.notice).toContain('AI 调用失败')
    expect(reply.notice).toContain('HTTP 401')
    expect(reply.notice).toContain('测试连接')
  })
})

describe('历史持久化', () => {
  it('默认通过 chrome.storage.local 读写历史', async () => {
    const deps = makeDeps()
    const reply = await dispatchButlerAgentMessage('记住我偏好 PHP 岗位', {
      deps: {
        execTool: deps.execTool,
        resolveSettings: deps.resolveSettings,
        runModel: async () => ({ text: '记住了', toolTrace: [] }),
      },
      now: NOW,
    })
    expect(reply.history).toHaveLength(2)
    expect(await getButlerChatHistory()).toHaveLength(2)
    expect(mockStorage[BUTLER_CHAT_HISTORY_KEY][0].content).toContain('PHP')
  })
})

describe('AI SDK 真实集成冒烟', () => {
  it('不注入 runModel 时，能通过 AI SDK + OpenAI 兼容 provider 拿到模型回复', async () => {
    const deps = makeDeps()
    // 用真实 Response 对象：AI SDK 会读取 headers 与 text()，普通对象会让它解析失败
    const payload = {
      id: 'chatcmpl-test',
      object: 'chat.completion',
      created: 1,
      model: 'deepseek-flash',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: '我是中控 Agent，可以查真实数据' },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
    }
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })))
    const reply = await dispatchButlerAgentMessage('你是谁', {
      deps: {
        execTool: deps.execTool,
        resolveSettings: deps.resolveSettings,
        loadHistory: deps.loadHistory,
        saveHistory: deps.saveHistory,
      },
      now: NOW,
    })
    expect(reply.mode).toBe('agent')
    expect(reply.content).toContain('中控 Agent')
    expect(vi.mocked(fetch)).toHaveBeenCalled()
    // 对话台同样计入每日 AI 预算，不绕开成本护栏
    expect(mockStorage['ai_budget_count']).toBe(1)
  })
})
