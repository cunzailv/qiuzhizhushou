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
}

export const BUILTIN_MODELS: ModelPreset[] = [
  {
    id: 'deepseek',
    name: 'DeepSeek V3',
    provider: '深度求索',
    baseUrl: 'https://api.deepseek.com/v1',
    modelName: 'deepseek-chat',
    description: '通用对话模型，性价比极高，中文能力强',
    free: true,
    docsUrl: 'https://platform.deepseek.com/api_keys',
  },
  {
    id: 'deepseek-r1',
    name: 'DeepSeek R1',
    provider: '深度求索',
    baseUrl: 'https://api.deepseek.com/v1',
    modelName: 'deepseek-reasoner',
    description: '推理增强模型，深度思考能力强，适合复杂分析',
    free: true,
    docsUrl: 'https://platform.deepseek.com/api_keys',
  },
  {
    id: 'qwen-plus',
    name: '通义千问 Plus',
    provider: '阿里云',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    modelName: 'qwen-plus',
    description: '阿里自研，中文理解优秀，响应快速',
    free: true,
    docsUrl: 'https://dashscope.console.aliyun.com/apiKey',
  },
  {
    id: 'qwen-max',
    name: '通义千问 Max',
    provider: '阿里云',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    modelName: 'qwen-max',
    description: '阿里最强模型，复杂推理和深度分析',
    free: false,
    docsUrl: 'https://dashscope.console.aliyun.com/apiKey',
  },
  {
    id: 'glm-4-flash',
    name: 'GLM-4 Flash',
    provider: '智谱AI',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    modelName: 'glm-4-flash',
    description: '免费快速模型，适合日常批量匹配分析',
    free: true,
    docsUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
  },
  {
    id: 'glm-4-plus',
    name: 'GLM-4 Plus',
    provider: '智谱AI',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    modelName: 'glm-4-plus',
    description: '智谱旗舰模型，综合能力更强',
    free: false,
    docsUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
  },
  {
    id: 'moonshot',
    name: 'Kimi (Moonshot)',
    provider: '月之暗面',
    baseUrl: 'https://api.moonshot.cn/v1',
    modelName: 'moonshot-v1-8k',
    description: '长文本处理出色，适合简历JD深度分析',
    free: true,
    docsUrl: 'https://platform.moonshot.cn/console/api-keys',
  },
  {
    id: 'siliconflow-qwen',
    name: 'SiliconFlow - Qwen2.5',
    provider: '硅基流动',
    baseUrl: 'https://api.siliconflow.cn/v1',
    modelName: 'Qwen/Qwen2.5-7B-Instruct',
    description: '开源模型托管，注册送额度，成本极低',
    free: true,
    docsUrl: 'https://cloud.siliconflow.cn/account/ak',
  },
  {
    id: 'siliconflow-deepseek',
    name: 'SiliconFlow - DeepSeek V2.5',
    provider: '硅基流动',
    baseUrl: 'https://api.siliconflow.cn/v1',
    modelName: 'deepseek-ai/DeepSeek-V2.5',
    description: 'DeepSeek 开源版托管，价格更低',
    free: true,
    docsUrl: 'https://cloud.siliconflow.cn/account/ak',
  },
  {
    id: 'minimax',
    name: 'MiniMax abab6.5s',
    provider: '稀宇科技',
    baseUrl: 'https://api.minimax.chat/v1',
    modelName: 'abab6.5s-chat',
    description: '海螺AI同款模型，快速推理',
    free: true,
    docsUrl: 'https://platform.minimaxi.com/user-center/basic-information/interface-key',
  },
  {
    id: 'stepfun',
    name: '阶跃星辰 Step-2',
    provider: '阶跃星辰',
    baseUrl: 'https://api.stepfun.com/v1',
    modelName: 'step-2-16k',
    description: '万亿参数大模型，理解分析能力强',
    free: true,
    docsUrl: 'https://platform.stepfun.com/interface-key',
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
  return BUILTIN_MODELS[0] // DeepSeek V3
}
