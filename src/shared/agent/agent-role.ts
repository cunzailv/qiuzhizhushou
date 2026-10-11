// F2 · 智能体角色预设
// 角色 = 一组可批量应用的"智能体参数"（匹配门槛/沟通模式/评分开关）。
// 切换角色会把参数写入现有 settings（运行时无需改读取逻辑）；
// 安全护栏（AI 动作权限三档）不属于角色参数，不被角色覆盖。
import { getSetting, setSetting } from '../db/settings-store'

export type AgentRoleId = 'aggressive' | 'conservative' | 'custom'

export interface AgentRole {
  id: AgentRoleId
  name: string
  description: string
  /** 应用到现有 settings 的参数；custom 返回 null（不动参数） */
  params: Record<string, string | number | boolean> | null
}

export const AGENT_ROLES: AgentRole[] = [
  {
    id: 'aggressive',
    name: '激进海投',
    description: '快速铺量：低匹配门槛、一键批量沟通、不评分直接投。适合扩大机会面、先拿面试练手。',
    params: { enableAiMatch: false, applyMode: 'batch' },
  },
  {
    id: 'conservative',
    name: '保守精投',
    description: '精准打击：高匹配门槛、AI 推荐确认、逐条评分后投递。适合重点目标岗位、控制沟通量。',
    params: { enableAiMatch: true, applyMode: 'recommend' },
  },
  {
    id: 'custom',
    name: '自定义',
    description: '不使用预设，完全按下方设置页里的防封策略与沟通模式自行调整。',
    params: null,
  },
]

const ROLE_KEY = 'agentRole'

export async function getAgentRole(): Promise<AgentRoleId> {
  return getSetting<AgentRoleId>(ROLE_KEY, 'custom')
}

export async function setAgentRole(role: AgentRoleId): Promise<void> {
  await setSetting(ROLE_KEY, role)
  const def = AGENT_ROLES.find((r) => r.id === role)
  if (def?.params) {
    for (const [k, v] of Object.entries(def.params)) {
      await setSetting(k, v)
    }
  }
}
