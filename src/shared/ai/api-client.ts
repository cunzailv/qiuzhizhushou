import { getSetting } from '../db/settings-store'
import { getPresetById } from './model-presets'
interface ChatCompletionResponse {
  choices: Array<{ message: { content: string } }>
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
  const modelName = (await getSetting<string>('modelName', '')) || preset?.modelName || 'deepseek-chat'

  return { baseUrl, apiKey, modelName }
}

export async function chatCompletion(
  systemPrompt: string,
  userMessage: string,
  temperature = 0.3
): Promise<string> {
  const { baseUrl, apiKey, modelName } = await resolveAISettings()

  if (!apiKey || !baseUrl) {
    return ''
  }

  const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`

  const body = JSON.stringify({
    model: modelName,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ],
    temperature,
    max_tokens: 1500,
  })

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 30000)

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body,
    signal: controller.signal,
  })

  clearTimeout(timeout)

  if (!response.ok) {
    const errorText = await response.text()
    console.error(`AI API error: ${response.status} - ${errorText}`)
    return ''
  }

  const data: ChatCompletionResponse = await response.json()
  return data.choices?.[0]?.message?.content || ''
}

/** 检查 AI 是否已配置（仅验证 key/url 是否存在，不发网络请求） */
export async function checkAIConfigured(): Promise<{ configured: boolean; reason: string }> {
  const { apiKey, baseUrl } = await resolveAISettings()
  if (!apiKey) return { configured: false, reason: '请先在设置中配置 API Key' }
  if (!baseUrl) return { configured: false, reason: '请先选择或配置 AI 模型' }
  return { configured: true, reason: '' }
}

export async function testAIConnection(): Promise<{ success: boolean; message: string }> {
  const { baseUrl, apiKey, modelName } = await resolveAISettings()
  if (!apiKey) return { success: false, message: '请先配置 API Key' }
  if (!baseUrl) return { success: false, message: '请先选择或配置 AI 模型' }

  const result = await chatCompletion(
    '你是一个助手，用中文简短回复。',
    '请回复"连接成功"',
    0
  )

  if (result) {
    return { success: true, message: `模型 ${modelName} 连接成功` }
  }
  return { success: false, message: '连接失败，请检查 API Key 和网络' }
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
    throw new Error(`AI API 错误 (${response.status}): ${errorText.slice(0, 200)}`)
  }

  const reader = response.body?.getReader()
  if (!reader) throw new Error('浏览器不支持流式响应')

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
