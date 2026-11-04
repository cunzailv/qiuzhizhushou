// M4 · 自愈事件归因与开发者待修建议类型定义
// 记录每次智能体绕过/降级事件，聚合成结构化待修建议供管家面板消费。

/** 自愈类别：描述触发原因 */
export type SelfHealingCategory =
  | 'card_not_found'       // 卡片定位失败，降级为模糊/URL 直达
  | 'button_heuristic'     // 按钮预设选择器失效，降级为语义启发式
  | 'button_llm'           // 启发式未命中，升级为 LLM 感知决策
  | 'button_local_fallback'// LLM 也失败，回落为本地安全回退
  | 'negative_button_blocked' // 拦截到负面按钮（"不合适"等），中止点击
  | 'modal_dismissed'      // 检测并强行关闭了意外弹窗/遮罩
  | 'task_isolated'        // 单岗位异常被故障隔离，任务标记为 skipped 继续队列
  | 'skill_circuit_breaker'// 技能触发熔断（failCount >= 3）
  | 'skill_fallback'       // 技能缓存命中但 DOM 失配，降级至 Tier 1

/** 建议修复优先级 */
export type FixPriority = 'critical' | 'high' | 'medium' | 'low'

/** 单次自愈绕过事件 */
export interface SelfHealingEvent {
  id: string
  createdAt: string
  /** 发生绕过的平台（boss / liepin / 51job 等） */
  platform: string
  /** 绕过类别 */
  category: SelfHealingCategory
  /** 触发此次自愈的原始失败描述 */
  triggerDescription: string
  /** 实际采用的绕过路径 */
  bypassPath: string
  /** 相关 CSS 选择器（如果有） */
  failedSelector?: string
  /** 相关按钮文本（如果有） */
  buttonText?: string
  /** 任务 ID（如果有） */
  taskId?: string
  /** 岗位标题（如果有） */
  jobTitle?: string
  /** 是否绕过成功 */
  success: boolean
}

/** 聚合后的开发者待修建议 */
export interface DeveloperFixSuggestion {
  /** 聚合键：platform + category */
  key: string
  platform: string
  category: SelfHealingCategory
  /** 触发次数 */
  occurrences: number
  /** 最近一次触发时间 */
  lastOccurredAt: string
  /** 建议修复标题 */
  fixTitle: string
  /** 建议修复说明 */
  fixDescription: string
  /** 建议修复优先级 */
  priority: FixPriority
  /** 失败的选择器集合（去重） */
  failedSelectors: string[]
  /** 失败的按钮文本集合（去重） */
  buttonTexts: string[]
  /** 相关事件 ID 列表（最近 10 条） */
  eventIds: string[]
}

// ─── 友好描述映射 ───

export const CATEGORY_LABELS: Record<SelfHealingCategory, string> = {
  card_not_found: '卡片定位失败 → 降级投递',
  button_heuristic: '按钮选择器失效 → 语义启发式',
  button_llm: '启发式未命中 → LLM 感知',
  button_local_fallback: 'LLM 失败 → 本地回退',
  negative_button_blocked: '拦截到负面按钮',
  modal_dismissed: '意外弹窗/遮罩强制关闭',
  task_isolated: '单岗位故障隔离（已跳过）',
  skill_circuit_breaker: '技能熔断（失败过多）',
  skill_fallback: '技能缓存失配 → 降级',
}

export const CATEGORY_FIX_TEMPLATES: Record<
  SelfHealingCategory,
  { title: string; description: string; priority: FixPriority }
> = {
  card_not_found: {
    title: '更新岗位卡片选择器',
    description:
      '`activateJobCard` 常规选择器无法命中目标岗位卡片，当前依赖模糊分词或 URL 直达降级。建议检查并更新 `src/shared/platform/boss/action-simulator.ts` 中的卡片定位选择器，或扩充模糊匹配关键词白名单。',
    priority: 'high',
  },
  button_heuristic: {
    title: '更新"立即沟通"按钮选择器',
    description:
      '预设按钮选择器（`APPLY_BUTTON_SELECTORS`）未能命中沟通按钮，系统降级为语义启发式。建议将成功命中的启发式选择器固化为预设规则，减少绕道次数。',
    priority: 'high',
  },
  button_llm: {
    title: '补充按钮语义白名单或选择器',
    description:
      '语义启发式未命中，系统调用 LLM 感知决策（Tier 3）。LLM 解析成本高且有配额限制。建议将命中的 LLM 结果反推到启发式白名单或预设选择器，降低 LLM 触发率。',
    priority: 'medium',
  },
  button_local_fallback: {
    title: 'LLM 感知兜底失败，需修复按钮探测链路',
    description:
      'LLM 也未能找到沟通按钮，系统执行本地安全回退（任务标记失败/跳过）。这说明页面结构可能发生了重大变更，需要人工排查并更新 `APPLY_BUTTON_SELECTORS` 或 `isPositiveApplyButton` 白名单。',
    priority: 'critical',
  },
  negative_button_blocked: {
    title: '检查"不合适"按钮的黑名单规则',
    description:
      '系统拦截了对负面按钮（如"不合适"）的误点。若频繁触发，说明正面按钮探测未能在黑名单之前找到目标，建议检查 `isNegativeButton` 与 `isPositiveApplyButton` 的优先级与覆盖范围。',
    priority: 'medium',
  },
  modal_dismissed: {
    title: '识别新型意外弹窗并扩充规则库',
    description:
      '`dismissUnexpectedModals` 检测到并强制关闭了意外弹窗。建议检查被关闭弹窗的 class/文本特征，补充到规则库，或修复触发弹窗的根因（如负面按钮点击残留）。',
    priority: 'medium',
  },
  task_isolated: {
    title: '排查单岗位不可逆异常的根因',
    description:
      'executeCampaignTask 在 finally 中捕获到不可逆异常，任务被标记为 skipped 以保护队列连续性。建议查阅对应错误日志，分析是否需要修复特定平台适配器或修正网络/DOM 操作逻辑。',
    priority: 'high',
  },
  skill_circuit_breaker: {
    title: '清理或更新已熔断的缓存技能',
    description:
      '技能的失败次数达到阈值（≥3），触发熔断保护，不再从缓存复用。建议在管家面板"技能管理"中查看并删除或更新该技能，以恢复 Tier 0 缓存加速。',
    priority: 'low',
  },
  skill_fallback: {
    title: '刷新缓存技能的选择器指纹',
    description:
      '缓存技能命中但对应 DOM 元素失配（元素不存在或不可见），系统降级至 Tier 1。这通常意味着平台更新了 HTML 结构，需要重新训练/沉淀技能或更新指纹。',
    priority: 'medium',
  },
}
