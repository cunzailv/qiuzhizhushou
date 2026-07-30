// 国内大模型预设，全部兼容 OpenAI API 格式
export interface ModelPreset {
  id: string
  name: string           // 显示名称
  provider: string       // 厂商
  baseUrl: string        // API 地址
  modelName: string      // 模型名称
  description: string    // 简介
  free: boolean          // 是否有免费额度
  docsUrl: string        // 获取 API Key 的地址
  isCustom?: boolean     // 是否为用户自定义模型
}

// chrome.storage.local 中存储自定义模型的 key
const CUSTOM_MODELS_KEY = 'setting_customModels'

/** 读取用户自定义模型列表 */
export async function getCustomModels(): Promise<ModelPreset[]> {
  try {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      const res = await chrome.storage.local.get(CUSTOM_MODELS_KEY)
      return (res[CUSTOM_MODELS_KEY] as ModelPreset[]) || []
    }
  } catch { /* ignore */ }
  return []
}

/** 保存用户自定义模型列表 */
export async function saveCustomModels(models: ModelPreset[]): Promise<void> {
  try {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      await chrome.storage.local.set({ [CUSTOM_MODELS_KEY]: models })
    }
  } catch { /* ignore */ }
}

/** 获取全部可用模型（内置 + 自定义），自定义模型排最后 */
export async function getAllModels(): Promise<ModelPreset[]> {
  const custom = await getCustomModels()
  return [...BUILTIN_MODELS, ...custom]
}

/** 生成自定义模型的唯一 ID */
export function generateCustomModelId(): string {
  return `custom-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

export const BUILTIN_MODELS: ModelPreset[] = [
  {
    id: 'deepseek',
    name: 'DeepSeek V4',
    provider: '深度求索',
    baseUrl: 'https://api.deepseek.com/v1',
    modelName: 'deepseek-chat',
    description: 'DeepSeek 最新旗舰，中文能力强，性价比极高',
    free: true,
    docsUrl: 'https://platform.deepseek.com/api_keys',
  },
  {
    id: 'qwen-plus',
    name: '通义千问 3',
    provider: '阿里云',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    modelName: 'qwen-plus',
    description: '阿里最新模型，中文理解优秀，响应快速',
    free: true,
    docsUrl: 'https://dashscope.console.aliyun.com/apiKey',
  },
  {
    id: 'kimi',
    name: 'Kimi K3',
    provider: '月之暗面',
    baseUrl: 'https://api.moonshot.cn/v1',
    modelName: 'moonshot-v1-8k',
    description: '月之暗面最新 Kimi 模型，长文本处理出色',
    free: true,
    docsUrl: 'https://platform.moonshot.cn/console/api-keys',
  },
  {
    id: 'glm',
    name: '智谱 GLM-5',
    provider: '智谱AI',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    modelName: 'glm-4-plus',
    description: '智谱最新旗舰模型，综合能力强',
    free: false,
    docsUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
  },
  {
    id: 'custom',
    name: '自定义 OpenAI 兼容',
    provider: '其他',
    baseUrl: 'https://api.openai.com/v1',
    modelName: 'gpt-4o-mini',
    description: '手动输入任意兼容 OpenAI API 的服务',
    free: false,
    docsUrl: '',
  },
]

export function getPresetById(id: string): ModelPreset | undefined {
  return BUILTIN_MODELS.find((p) => p.id === id)
}

export function getDefaultPreset(): ModelPreset {
  return BUILTIN_MODELS[0] // DeepSeek V4
}
