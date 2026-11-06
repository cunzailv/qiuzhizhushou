import { getSetting } from '../db/settings-store'
import { getPresetById } from './model-presets'
import { consumeAiCall, getAiBudgetLimit, getAiUsageToday } from './ai-budget'
import { recordError } from '../db/error-store'
interface ChatCompletionResponse {
  choices: Array<{ message: { content: string } }>
}

/** 图片输入：支持 data URL、裸 base64 或公网 http(s) 地址 */
export interface ChatImageInput {
  data: string
  /** 裸 base64 时需要指定，默认 image/png */
  mimeType?: string
}

type OpenAIContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

/** 把文本 + 图片组装成 OpenAI 兼容的多模态 content（导出以便单测覆盖） */
export function buildUserContent(
  userMessage: string,
  images?: ChatImageInput[],
): string | OpenAIContentPart[] {
  if (!images || images.length === 0) return userMessage

  const parts: OpenAIContentPart[] = [{ type: 'text', text: userMessage }]
  for (const img of images) {
    const raw = (img?.data || '').trim()
    if (!raw) continue
    const url = /^(https?:|data:)/i.test(raw)
      ? raw
      : `data:${img.mimeType || 'image/png'};base64,${raw}`
    parts.push({ type: 'image_url', image_url: { url } })
  }

  // 图片全部无效时退化为纯字符串，避免发出只有 text part 的数组 content
  if (parts.length === 1) return userMessage
  return parts
}

/** 当前模型是否支持图片输入（DeepSeek 只有 V4.1-Flash 系支持原生视觉） */
const VISION_CAPABLE_MODEL_RE = /(flash|vision|v4\.1|qwen-vl|glm-4v|gpt-4o|claude|gemini)/i

export function isVisionCapableModel(modelName: string): boolean {
  return VISION_CAPABLE_MODEL_RE.test(modelName || '')
}

// ─────────── AI 降级可见化 ───────────
// chatCompletion 失败时一律返回空串、由调用方静默回退本地规则。
// 这会让用户误以为「AI 在工作」，实际一直在跑硬编码规则。
// 这里落一个失败标记，由 AIbot 调度器读出来写进可见日志。

export const AI_FAILURE_KEY = 'ai_last_failure'

export interface AiFailureMark {
  at: number
  kind: 'network' | 'http' | 'model'
  model: string
  message: string
}

let lastFailureSig = ''
let lastFailureAt = 0

/** 记录一次 AI 失败（同一错误 5 分钟内只写一次，避免刷爆 storage） */
async function markAiFailure(kind: AiFailureMark['kind'], message: string, modelName: string): Promise<void> {
  const now = Date.now()
  const sig = `${kind}:${modelName}:${message.slice(0, 100)}`
  if (sig === lastFailureSig && now - lastFailureAt < 5 * 60_000) return
  lastFailureSig = sig
  lastFailureAt = now

  try {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      const mark: AiFailureMark = { at: now, kind, model: modelName, message: message.slice(0, 300) }
      await chrome.storage.local.set({ [AI_FAILURE_KEY]: mark })
    }
  } catch {
    // 存储不可用时忽略，不影响主流程
  }
}

/** 调用成功后清除失败标记 */
async function clearAiFailure(): Promise<void> {
  try {
    if (typeof chrome === 'undefined' || !chrome.storage?.local) return
    const res = await chrome.storage.local.get(AI_FAILURE_KEY)
    if (res?.[AI_FAILURE_KEY]) {
      lastFailureSig = ''
      await chrome.storage.local.remove(AI_FAILURE_KEY)
    }
  } catch {
    // 忽略
  }
}

/** H2：瞬时错误指数退避重试（最多 2 次），返回是否需要继续重试 */
async function shouldRetry(attempt: number, error: unknown): Promise<boolean> {
  if (attempt >= 2) return false
  // 网络/超时类错误才重试；HTTP 状态错误不重试（4xx/5xx 通常稳定失败）
  const name = error instanceof Error ? error.name : ''
  if (name === 'AbortError' || name === 'TypeError' || name === 'TimeoutError') {
    const delay = 800 * 2 ** attempt
    await new Promise((r) => setTimeout(r, delay))
    return true
  }
  return false
}

/** 根据设置解析最终的 baseUrl 和 modelName（预设优先，自定义覆盖） */
async function resolveAISettings(): Promise<{ baseUrl: string; apiKey: string; modelName: string }> {
  const modelPreset = await getSetting<string>('modelPreset', 'deepseek')
  const apiKey = await getSetting<string>('apiKey', '')

  // 自定义模式：读取用户手动填入的值
  if (modelPreset === 'custom') {
    const baseUrl = await getSetting<string>('apiBaseUrl', 'https://api.openai.com/v1')
    const modelName = await getSetting<string>('modelName', 'gpt-4o-mini')
    return { baseUrl, apiKey, modelName }
  }

  // 内置预设模式：从预设读取，同时允许用户覆盖
  const preset = getPresetById(modelPreset)
  const baseUrl = (await getSetting<string>('apiBaseUrl', '')) || preset?.baseUrl || 'https://api.deepseek.com/v1'
  const modelName = (await getSetting<string>('modelName', '')) || preset?.modelName || 'deepseek-flash'

  return { baseUrl, apiKey, modelName }
}

export async function chatCompletion(
  systemPrompt: string,
  userMessage: string,
  temperature = 0.3,
  opts?: { bypassBudget?: boolean; images?: ChatImageInput[] }
): Promise<string> {
  const { baseUrl, apiKey, modelName } = await resolveAISettings()

  if (!apiKey || !baseUrl) {
    return ''
  }

  // 图片输入前先确认模型支持视觉，避免把图片发给纯文本模型白跑一次 400
  const images = opts?.images?.filter((img) => img && img.data && img.data.trim())
  if (images && images.length > 0 && !isVisionCapableModel(modelName)) {
    console.warn(`[AI] 当前模型 ${modelName} 不支持图片输入，本次仅发送文本`)
    void recordError({
      source: 'ai.api',
      message: `模型 ${modelName} 不支持图片输入，已自动降级为纯文本调用`,
    })
  }
  const usableImages = images && isVisionCapableModel(modelName) ? images : undefined

  // C4：每日 AI 预算护栏——超限直接返回空串，由调用方回退本地逻辑
  // 测试连接等诊断调用可通过 bypassBudget 跳过护栏
  if (!opts?.bypassBudget) {
    const remaining = await consumeAiCall()
    if (remaining < 0) {
      console.warn(`[AI-BUDGET] 今日 AI 调用已超预算（剩余 ${remaining}），本次调用跳过，回退本地逻辑`)
      return ''
    }
  }

  const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`

  const body = JSON.stringify({
    model: modelName,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: buildUserContent(userMessage, usableImages) },
    ],
    temperature,
    max_tokens: 1500,
  })

  let response: Response | undefined
  let lastError: unknown
  for (let attempt = 0; attempt < 3; attempt++) {
    // 每次尝试使用新的 AbortController（已 abort 的 signal 不可复用）
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 30000)
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body,
        signal: controller.signal,
      })
      clearTimeout(timeout)
      break
    } catch (err) {
      clearTimeout(timeout)
      lastError = err
      if (!(await shouldRetry(attempt, err))) break
    }
  }

  if (!response) {
    const msg = lastError instanceof Error ? lastError.message : String(lastError)
    console.error(`[AI] 请求失败：${msg}`)
    void recordError({ source: 'ai.api', message: `chatCompletion 请求失败: ${msg}`, dedupeWindowMs: 60_000 })
    void markAiFailure('network', `网络请求失败：${msg}`, modelName)
    return ''
  }

  if (!response.ok) {
    const errorText = await response.text()
    console.error(`AI API error: ${response.status} - ${errorText}`)
    void recordError({ source: 'ai.api', message: `chatCompletion HTTP ${response.status}: ${errorText.slice(0, 200)}`, dedupeWindowMs: 60_000 })
    // 400/404 且报错文本提到模型名 → 模型名失效，是最常见的静默降级原因
    const lookedLikeModelError =
      (response.status === 400 || response.status === 404) &&
      /(model|模型|not.?exist|invalid|does not exist)/i.test(errorText)
    void markAiFailure(
      lookedLikeModelError ? 'model' : 'http',
      `HTTP ${response.status}：${errorText.slice(0, 160)}`,
      modelName,
    )
    return ''
  }

  const data: ChatCompletionResponse = await response.json()
  const content = data.choices?.[0]?.message?.content || ''
  if (content) void clearAiFailure()
  return content
}

/**
 * 带图片的对话调用（多模态）。
 * 用于需要「看图」的场景：扫描件简历、岗位截图、图形验证码等。
 * 若当前模型不支持视觉，会自动降级为纯文本调用，不会静默失败。
 */
export async function chatCompletionWithVision(
  systemPrompt: string,
  userMessage: string,
  images: ChatImageInput[],
  temperature = 0.2,
): Promise<string> {
  const { modelName } = await resolveAISettings()
  if (!isVisionCapableModel(modelName)) {
    // 纯文本模型（如 deepseek-v4-pro）无法识图，直接返回空让调用方保留原逻辑
    console.warn(`[AI] 当前模型 ${modelName} 不支持图片输入，跳过视觉调用`)
    return ''
  }
  return chatCompletion(systemPrompt, userMessage, temperature, { images })
}

/** 检查 AI 是否已配置（仅验证 key/url 是否存在，不发网络请求） */export async function checkAIConfigured(): Promise<{ configured: boolean; reason: string }> {
  const { apiKey, baseUrl } = await resolveAISettings()
  if (!apiKey) return { configured: false, reason: '请先在设置中配置 API Key' }
  if (!baseUrl) return { configured: false, reason: '请先选择或配置 AI 模型' }
  return { configured: true, reason: '' }
}

export async function testAIConnection(): Promise<{ success: boolean; message: string }> {
  const { baseUrl, apiKey, modelName } = await resolveAISettings()
  if (!apiKey) return { success: false, message: '请先配置 API Key' }
  if (!baseUrl) return { success: false, message: '请先选择或配置 AI 模型' }

  // 预算护栏：超限是"静默跳过"的常见误报源，先明确提示而不是笼统报连接失败
  const [used, limit] = await Promise.all([getAiUsageToday(), getAiBudgetLimit()])
  if (used >= limit) {
    return {
      success: false,
      message: `今日 AI 调用已达上限（${used}/${limit}），请调高预算或在设置页重置今日计数`,
    }
  }

  const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`
  const body = JSON.stringify({
    model: modelName,
    messages: [
      { role: 'system', content: '你是一个助手，用中文简短回复。' },
      { role: 'user', content: '请回复"连接成功"' },
    ],
    temperature: 0,
    max_tokens: 50,
  })

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 30000)
  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body,
      signal: controller.signal,
    })
  } catch (err) {
    clearTimeout(timeout)
    const msg = err instanceof Error ? err.message : String(err)
    const reason =
      err instanceof Error && err.name === 'AbortError'
        ? '请求超时（30 秒），请检查网络'
        : `网络请求失败：${msg}`
    void recordError({ source: 'ai.api', message: `testAIConnection ${reason}` })
    return { success: false, message: reason }
  }
  clearTimeout(timeout)

  if (!response.ok) {
    let detail = ''
    try {
      detail = (await response.text()).slice(0, 160)
    } catch {
      // ignore
    }
    let reason: string
    if (response.status === 401 || response.status === 403) {
      reason = `API Key 无效或已过期（HTTP ${response.status}）`
    } else if (response.status === 402) {
      reason = '账户余额不足或欠费（HTTP 402）'
    } else if (response.status === 429) {
      reason = '请求过于频繁或触发限流（HTTP 429），请稍后再试'
    } else {
      reason = `接口返回错误（HTTP ${response.status}）：${detail || '无响应内容'}`
    }
    void recordError({ source: 'ai.api', message: `testAIConnection ${reason}` })
    return { success: false, message: reason }
  }

  try {
    const data: ChatCompletionResponse = await response.json()
    const content = data.choices?.[0]?.message?.content
    if (content) {
      return { success: true, message: `模型 ${modelName} 连接成功` }
    }
    return { success: false, message: '接口响应异常：未返回内容，请检查模型名是否正确' }
  } catch {
    return { success: false, message: '接口响应解析失败，请检查接口地址是否兼容 OpenAI 格式' }
  }
}

/**
 * 流式 AI 对话（SSE），每个文本块通过 onChunk 回调输出。
 * 返回完整的累积文本。
 * @param signal 用于取消请求的 AbortSignal
 */
export async function chatCompletionStream(
  systemPrompt: string,
  userMessage: string,
  onChunk: (text: string) => void,
  temperature = 0.3,
  signal?: AbortSignal
): Promise<string> {
  const { baseUrl, apiKey, modelName } = await resolveAISettings()

  if (!apiKey || !baseUrl) {
    throw new Error('AI 未配置：请先在设置中填写 API Key 和选择模型')
  }

  const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`

  const body = JSON.stringify({
    model: modelName,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ],
    temperature,
    max_tokens: 2500,
    stream: true,
  })

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body,
    signal,
  })

  if (!response.ok) {
    const errorText = await response.text()
    void recordError({ source: 'ai.api', message: `chatCompletionStream HTTP ${response.status}: ${errorText.slice(0, 200)}`, dedupeWindowMs: 60_000 })
    throw new Error(`AI API 错误 (${response.status}): ${errorText.slice(0, 200)}`)
  }

  const reader = response.body?.getReader()
  if (!reader) {
    void recordError({ source: 'ai.api', message: 'chatCompletionStream 无响应体', dedupeWindowMs: 60_000 })
    throw new Error('浏览器不支持流式响应')
  }

  const decoder = new TextDecoder()
  let fullText = ''
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed || !trimmed.startsWith('data: ')) continue
        const data = trimmed.slice(6)
        if (data === '[DONE]') continue

        try {
          const parsed = JSON.parse(data)
          const content = parsed.choices?.[0]?.delta?.content
          if (content) {
            fullText += content
            onChunk(content)
          }
        } catch {
          // skip unparseable SSE lines
        }
      }
    }
  } finally {
    reader.releaseLock()
  }

  return fullText
}
