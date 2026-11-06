// L3 结果复盘 · 真实投递结果事件流
//
// 之前 planner 只能读 applications.status，而 status 几乎全靠用户手动改，
// 于是「自主重规划」是在拿一堆 stale 的「已投递」当复盘依据，
// 甚至让 LLM 自由发挥编出「样本量为 175、回复率为 1」这种没有来源的话。
//
// 本模块用 chrome.storage.local 记录可观测的真实结果事件：
//   applied（AIbot 投递成功）/ hr_reply（聊天页观察到 HR 新消息）/
//   read / communicating / interview / rejected / hired（投递状态变更）
// 每条事件带稳定的去重 key，聊天页 2.5 秒轮询不会把同一条 HR 消息记成几十条。
// 不用 Dexie 是为了避免为了一个回流通道改动全库 schema 版本。

export type OutcomeEventKind =
  | 'applied'
  | 'hr_reply'
  | 'read'
  | 'communicating'
  | 'interview'
  | 'rejected'
  | 'hired'

export interface OutcomeEvent {
  id: string
  /** 去重键：同一投递 / 同一条 HR 消息只保留一条 */
  key: string
  kind: OutcomeEventKind
  at: number
  jobId?: string
  jobTitle: string
  company: string
  platform?: string
  /** 由哪个搜索关键词采集而来（仅 applied 事件可靠携带） */
  direction?: string
  /** HR 回复原文 / 状态备注，截断保存 */
  snippet?: string
}

export const OUTCOME_EVENTS_KEY = 'aibot_outcome_events'
/** 最多保留的事件数，超出后丢弃最旧的 */
export const MAX_OUTCOME_EVENTS = 600

export type OutcomeEventInput = Omit<OutcomeEvent, 'id' | 'key' | 'at'> & { at?: number }

/** djb2 短哈希，用于 HR 消息去重 */
export function hashOutcomeText(raw: string): string {
  let hash = 5381
  const text = raw || ''
  for (let i = 0; i < text.length; i++) hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0
  return (hash >>> 0).toString(36)
}

function identityOf(input: Pick<OutcomeEventInput, 'jobId' | 'jobTitle' | 'company'>): string {
  return (input.jobId || `${(input.jobTitle || '').trim()}|${(input.company || '').trim()}`).trim()
}

export function buildOutcomeEventKey(input: OutcomeEventInput): string {
  const identity = identityOf(input)
  if (input.kind === 'hr_reply') {
    return `hr_reply:${hashOutcomeText(input.snippet || '')}:${identity}`
  }
  return `${input.kind}:${identity}`
}

function generateId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

/** 读取全部结果事件（按时间升序） */
export async function getOutcomeEvents(): Promise<OutcomeEvent[]> {
  try {
    if (typeof chrome === 'undefined' || !chrome.storage?.local) return []
    const res = await chrome.storage.local.get(OUTCOME_EVENTS_KEY)
    const list = res?.[OUTCOME_EVENTS_KEY]
    if (!Array.isArray(list)) return []
    return (list as OutcomeEvent[])
      .filter((e) => e && typeof e.at === 'number' && e.kind)
      .sort((a, b) => a.at - b.at)
  } catch {
    return []
  }
}

/**
 * 记录一条真实结果事件。返回 false 表示重复事件已被忽略。
 * 任何存储异常都静默吞掉——复盘数据绝不能阻断投递主链路。
 */
export async function recordOutcomeEvent(input: OutcomeEventInput): Promise<boolean> {
  try {
    if (typeof chrome === 'undefined' || !chrome.storage?.local) return false
    const at = input.at ?? Date.now()
    const key = buildOutcomeEventKey(input)
    const res = await chrome.storage.local.get(OUTCOME_EVENTS_KEY)
    const existing: OutcomeEvent[] = Array.isArray(res?.[OUTCOME_EVENTS_KEY])
      ? res[OUTCOME_EVENTS_KEY] as OutcomeEvent[]
      : []
    if (existing.some((e) => e?.key === key)) return false

    const event: OutcomeEvent = {
      id: generateId(),
      key,
      kind: input.kind,
      at,
      jobId: input.jobId,
      jobTitle: (input.jobTitle || '').slice(0, 80),
      company: (input.company || '').slice(0, 80),
      platform: input.platform,
      direction: input.direction,
      snippet: (input.snippet || '').slice(0, 200) || undefined,
    }
    const next = [...existing.filter((e) => e && e.key !== key), event]
      .sort((a, b) => a.at - b.at)
      .slice(-MAX_OUTCOME_EVENTS)
    await chrome.storage.local.set({ [OUTCOME_EVENTS_KEY]: next })
    return true
  } catch {
    return false
  }
}

/** 清空结果事件（设置页/测试用） */
export async function clearOutcomeEvents(): Promise<void> {
  try {
    if (typeof chrome === 'undefined' || !chrome.storage?.local) return
    await chrome.storage.local.remove(OUTCOME_EVENTS_KEY)
  } catch {
    // ignore
  }
}
