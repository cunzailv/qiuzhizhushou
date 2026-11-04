import { db } from '../db'
import type { AgentSkill, AgentStep, SelectorFingerprint, SkillPatchSource } from './types'

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
}

/** 14 天 TTL 常量 (毫秒) */
export const SKILL_TTL_MS = 14 * 86400000

/** 测试用传输模式覆盖（'messaging' 强制走 chrome.runtime.sendMessage，'direct' 强制走 Dexie） */
let testTransportOverride: 'messaging' | 'direct' | null = null

export function setSkillMemoryTransportForTesting(override: 'messaging' | 'direct' | null): void {
  testTransportOverride = override
}

/** CSS 特殊字符转义安全兜底 */
function escapeCss(str: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return CSS.escape(str)
  }
  return str.replace(/([ #;?%&,.+*~':"!^$[\]()=>|/@])/g, '\\$1')
}

/** HTML 属性值引号转义 */
function escapeAttr(str: string): string {
  return str.replace(/["\\]/g, '\\$&')
}

/** 判断 ID 是否属于稳定 ID（排除纯数字、React / HeadlessUI 动态 hash、UUID） */
function isStableId(id: string): boolean {
  if (!id || typeof id !== 'string') return false
  const trimmed = id.trim()
  if (!trimmed) return false
  if (/^\d+$/.test(trimmed)) return false
  if (/^(:r\w+:|rc-anchor|headlessui-|ant-|mat-|chakra-)/i.test(trimmed)) return false
  if (/[0-9a-f]{8,}/i.test(trimmed)) return false
  if (/^__/.test(trimmed)) return false
  return true
}

const NOISY_CLASS_PATTERNS = [
  // Tailwind / 原子化 CSS
  /^(flex|grid|block|inline|hidden|relative|absolute|fixed|static)$/,
  /^(items|justify|content|self|place)-(start|end|center|between|around|evenly|stretch|baseline)/,
  /^[mp][xytblr]?-\d+(\.\d+)?$/,
  /^[wh]-(\d+|full|screen|auto|fit|min|max)/,
  /^(text|bg|border|ring|fill|stroke|shadow|rounded|opacity|gap|z)-/,
  /^(font|leading|tracking|cursor|transition|duration|ease|overflow)-/,
  /^(hover|focus|active|disabled|group-hover):/,
  // 随机 hash 类名（如 _9xa3, b3kz 等）
  /^_[a-zA-Z0-9]+$/,
  /^[a-zA-Z0-9]*\d+[a-zA-Z0-9]*$/,
  /^[a-z0-9]{7,}$/i,
  /^_?[a-zA-Z0-9]{4,}_[a-zA-Z0-9]{4,}/,
  /^css-[a-z0-9]+/i,
  /^sc-[a-zA-Z0-9]+/,
]

function isSemanticClass(cls: string): boolean {
  if (!cls || cls.length < 2) return false
  // 明确的业务语义化类名优先保护
  if (/^(btn|button|chat|startchat|apply|submit|sure|confirm|action|primary|cancel|close)/i.test(cls)) {
    return true
  }
  for (const pattern of NOISY_CLASS_PATTERNS) {
    if (pattern.test(cls)) return false
  }
  return true
}

// 内存级写入互斥排队队列（确保并发 upsert / recordSkillFail 原子有序执行，杜绝竞态与重复记录）
let skillWriteQueue = Promise.resolve<any>(undefined)
function enqueueSkillWrite<T>(op: () => Promise<T>): Promise<T> {
  const next = skillWriteQueue.then(() => op(), () => op())
  skillWriteQueue = next
  return next
}

/**
 * 判断当前是否运行在 Content Script 环境
 */
export function isContentScriptEnvironment(): boolean {
  if (testTransportOverride !== null) {
    return testTransportOverride === 'messaging'
  }
  // Vitest / Node.js 测试环境默认直连 DB
  if (typeof process !== 'undefined' && (process.env?.VITEST || process.env?.NODE_ENV === 'test')) {
    return false
  }
  // Background Service Worker 无 window
  if (typeof window === 'undefined') {
    return false
  }
  // 必须具备 chrome.runtime.sendMessage
  if (typeof chrome === 'undefined' || !chrome.runtime || typeof chrome.runtime.sendMessage !== 'function') {
    return false
  }
  // 扩展页面 (Popup / Options) 处于 chrome-extension: 域，可直连 DB
  if (typeof window.location !== 'undefined' && window.location.protocol === 'chrome-extension:') {
    return false
  }
  return true
}

/** 兼容别名 */
export const isContentScript = isContentScriptEnvironment

function sendRuntimeMessage<T>(type: string, payload?: unknown): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    try {
      if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) {
        return reject(new Error('chrome.runtime.sendMessage is not available'))
      }
      chrome.runtime.sendMessage({ type, payload }, (response: any) => {
        const lastErr = chrome.runtime?.lastError
        if (lastErr) {
          return reject(new Error(lastErr.message || `chrome.runtime.sendMessage(${type}) failed`))
        }
        if (response && response.success === false) {
          return reject(new Error(response.error || `Background rejected ${type}`))
        }
        resolve(response?.data !== undefined ? response.data : response)
      })
    } catch (err) {
      reject(err)
    }
  })
}

/** 计算页面结构指纹（按钮文本的简单 hash，用于页面结构校验） */
export function computeSignature(state: { buttons: { text: string }[] }): string {
  return state.buttons.slice(0, 10).map(b => b.text).join('|')
}

/**
 * 为目标元素构建稳定、高容错的选择器指纹。
 * 策略优先级：
 * 1. 唯一且稳定的元素 ID
 * 2. 平台专属/语义化测试属性（如 Boss 直聘 ka、data-testid、data-qa、aria-label 等）
 * 3. 过滤动态 hash 与 Tailwind 后的语义化 class（如 btn-startchat、btn-primary 等）
 * 4. 容器内相对层级与父级上下文特征组合
 * 5. 命中同类多元素时的位置消歧（:first-of-type / :nth-of-type(n)）
 * 6. 结构化 DOM 标签路径兜底
 *
 * @param el 目标 DOM 元素
 * @param container 可选的作用域容器（如 jobCard 容器）
 * @returns 能够在 container（或 document）中准确定位 el 的有效 CSS 选择器
 */
export function buildSelectorFingerprint(el: Element, container?: Element): string {
  if (!el || !(el instanceof Element)) return ''
  const scope: ParentNode = container || el.ownerDocument || (typeof document !== 'undefined' ? document : null as unknown as ParentNode)
  if (!scope) return ''
  const tag = el.tagName.toLowerCase()

  const matchesTarget = (sel: string): boolean => {
    try {
      return scope.querySelector(sel) === el
    } catch {
      return false
    }
  }

  // 1. 稳定 ID
  if (el.id && isStableId(el.id)) {
    const idSel = `#${escapeCss(el.id)}`
    if (matchesTarget(idSel)) return idSel
  }

  // 2. 平台专属 / 语义属性优先级
  // Boss 直聘高频使用的 ka 属性
  const ka = el.getAttribute('ka')
  if (ka) {
    const kaSel = `${tag}[ka="${escapeAttr(ka)}"]`
    if (matchesTarget(kaSel)) return kaSel
    const bareKa = `[ka="${escapeAttr(ka)}"]`
    if (matchesTarget(bareKa)) return bareKa
  }

  // 其它测试/语义属性
  const semanticAttrs = [
    'data-testid',
    'data-qa',
    'data-test',
    'data-action',
    'data-role',
    'data-type',
    'aria-label',
    'title',
    'name',
  ]
  for (const attr of semanticAttrs) {
    const val = el.getAttribute(attr)
    if (val && val.trim()) {
      const attrSel = `${tag}[${attr}="${escapeAttr(val.trim())}"]`
      if (matchesTarget(attrSel)) return attrSel
      const bareAttr = `[${attr}="${escapeAttr(val.trim())}"]`
      if (matchesTarget(bareAttr)) return bareAttr
    }
  }

  // 3. 语义化 Class 组合
  const validClasses = Array.from(el.classList).filter(isSemanticClass)
  if (validClasses.length > 0) {
    const priorityClasses = validClasses.filter(c =>
      /(btn|button|chat|startchat|apply|submit|sure|confirm|action|primary)/i.test(c)
    )

    const getClsScore = (cls: string): number => {
      let score = 0
      if (/(startchat|chat|apply|submit|confirm|sure)/i.test(cls)) score += 10
      if (/(primary|action|target|success)/i.test(cls)) score += 5
      if (/^(btn|button)$/i.test(cls)) score -= 2
      score += Math.min(cls.length, 10) * 0.1
      return score
    }

    const testClasses = [...(priorityClasses.length > 0 ? priorityClasses : validClasses)]
      .sort((a, b) => getClsScore(b) - getClsScore(a))

    for (const c of testClasses) {
      const tagClsSel = `${tag}.${escapeCss(c)}`
      if (matchesTarget(tagClsSel)) return tagClsSel
    }

    if (testClasses.length >= 2) {
      const multiClsSel = `${tag}.${testClasses.slice(0, 2).map(escapeCss).join('.')}`
      if (matchesTarget(multiClsSel)) return multiClsSel
    }

    for (const c of testClasses) {
      const bareCls = `.${escapeCss(c)}`
      if (matchesTarget(bareCls)) return bareCls
    }
  }

  // 4. 上下文父级组合探测
  let parent = el.parentElement
  let depth = 0
  while (parent && parent !== scope && depth < 3) {
    const parentTag = parent.tagName.toLowerCase()
    const parentClasses = Array.from(parent.classList).filter(isSemanticClass)
    const parentId = parent.id && isStableId(parent.id) ? `#${escapeCss(parent.id)}` : ''

    const parentSel =
      parentId ||
      (parentClasses.length > 0
        ? `${parentTag}.${escapeCss(parentClasses[0])}`
        : parentTag)

    const candidateParts = [
      ka ? `[ka="${escapeAttr(ka)}"]` : null,
      validClasses.length > 0 ? `.${escapeCss(validClasses[0])}` : null,
      tag,
    ].filter(Boolean) as string[]

    for (const part of candidateParts) {
      const combined = `${parentSel} > ${part}`
      if (matchesTarget(combined)) return combined
      const descCombined = `${parentSel} ${part}`
      if (matchesTarget(descCombined)) return descCombined
    }

    parent = parent.parentElement
    depth++
  }

  // 5. 命中同类多元素时的位置消歧
  const baseSelector =
    (ka && `[ka="${escapeAttr(ka)}"]`) ||
    (validClasses.length > 0 && `${tag}.${escapeCss(validClasses[0])}`) ||
    tag

  try {
    const matches = Array.from(scope.querySelectorAll(baseSelector))
    const index = matches.indexOf(el)
    if (index >= 0) {
      if (index === 0) {
        const firstSel = `${baseSelector}:first-of-type`
        if (matchesTarget(firstSel)) return firstSel
      }
      const nthSel = `${baseSelector}:nth-of-type(${index + 1})`
      if (matchesTarget(nthSel)) return nthSel
      const nthChildSel = `${baseSelector}:nth-child(${index + 1})`
      if (matchesTarget(nthChildSel)) return nthChildSel
    }
  } catch {
    // ignore
  }

  // 6. 兜底：从 scope/container 到 el 构建通用标签路径
  const path: string[] = []
  let curr: Element | null = el
  while (curr && curr !== scope && curr !== el.ownerDocument?.body && curr !== el.ownerDocument?.documentElement) {
    const currentTag = curr.tagName.toLowerCase()
    const parentEl: HTMLElement | null = curr.parentElement
    if (parentEl) {
      const siblings = Array.from(parentEl.children)
      const sameTagSiblings = siblings.filter((c): c is Element => c.tagName === curr!.tagName)
      if (sameTagSiblings.length > 1) {
        const idx = sameTagSiblings.indexOf(curr) + 1
        path.unshift(`${currentTag}:nth-of-type(${idx})`)
      } else {
        path.unshift(currentTag)
      }
    } else {
      path.unshift(currentTag)
    }
    curr = parentEl
  }

  const fallbackSel = path.join(' > ')
  return fallbackSel || tag
}

/**
 * 查找匹配的缓存 Skill（多阶复合查询与自愈过滤）
 * 1. 严格模式：优先查询 [platform+pageType+goal] 复合索引
 * 2. 宽松兜底：若严格模式未命中，回退至 [platform+goal] 跨页面场景复用
 * 3. 过滤规则：必须满足 failCount < 3、enabled !== false、expiresAt > Date.now()
 * 4. 排序规则：按 successCount 倒序，相同则按 lastUsedAt 倒序
 */
export async function findBestSkill(
  platform: string,
  pageType: string,
  goal: string
): Promise<AgentSkill | null> {
  if (isContentScriptEnvironment()) {
    try {
      const skill = await sendRuntimeMessage<AgentSkill | null>('GET_BEST_SKILL', {
        platform,
        pageType,
        goal,
      })
      return skill || null
    } catch (err) {
      console.warn('[SkillMemory] GET_BEST_SKILL fallback to null:', err)
      return null
    }
  }

  return findBestSkillDirect(platform, pageType, goal)
}

/** 直接数据库查询实现（供 background / popup / options / 单元测试使用） */
export async function findBestSkillDirect(
  platform: string,
  pageType: string,
  goal: string
): Promise<AgentSkill | null> {
  const now = Date.now()

  // 1. Tier 1: 严格三元复合索引查询 [platform+pageType+goal]
  if (pageType) {
    const strictSkills = await db.agentSkills
      .where('[platform+pageType+goal]')
      .equals([platform, pageType, goal])
      .filter(s => s.expiresAt > now && s.failCount < 3 && s.enabled !== false)
      .toArray()

    if (strictSkills.length > 0) {
      strictSkills.sort((a, b) => b.successCount - a.successCount || b.lastUsedAt - a.lastUsedAt)
      return strictSkills[0]
    }
  }

  // 2. Tier 2: 宽松二元复合索引查询 [platform+goal] 兜底跨场景复用
  const looseSkills = await db.agentSkills
    .where('[platform+goal]')
    .equals([platform, goal])
    .filter(s => s.expiresAt > now && s.failCount < 3 && s.enabled !== false)
    .toArray()

  if (looseSkills.length > 0) {
    looseSkills.sort((a, b) => b.successCount - a.successCount || b.lastUsedAt - a.lastUsedAt)
    return looseSkills[0]
  }

  return null
}

/**
 * 保存或更新 Skill
 * - 设置 14 天 TTL（expiresAt = Date.now() + 14 * 86400000）
 * - 成功执行时重置 failCount = 0（故障自愈解除）
 * - 更新 lastUsedAt，自增 successCount
 * - 新步骤更优时更新 steps
 * - 支持 patchSource、fingerprint、remediationNotes
 */
export async function upsertSkill(params: {
  platform: string
  pageType: string
  goal: string
  steps: AgentStep[]
  selectorSignature: string
  patchSource?: SkillPatchSource
  remediationNotes?: string
  fingerprint?: SelectorFingerprint
}): Promise<AgentSkill> {
  if (isContentScriptEnvironment()) {
    try {
      return await sendRuntimeMessage<AgentSkill>('UPSERT_SKILL', params)
    } catch (err) {
      console.warn('[SkillMemory] UPSERT_SKILL messaging error:', err)
      return {
        id: 'fallback-' + Date.now(),
        ...params,
        successCount: 1,
        failCount: 0,
        createdAt: Date.now(),
        lastUsedAt: Date.now(),
        expiresAt: Date.now() + SKILL_TTL_MS,
        enabled: true,
      } as AgentSkill
    }
  }

  return upsertSkillDirect(params)
}

/** 直接数据库写入实现 */
export async function upsertSkillDirect(params: {
  platform: string
  pageType: string
  goal: string
  steps: AgentStep[]
  selectorSignature: string
  patchSource?: SkillPatchSource
  remediationNotes?: string
  fingerprint?: SelectorFingerprint
}): Promise<AgentSkill> {
  return enqueueSkillWrite(async () => {
    const now = Date.now()
    const expiresAt = now + SKILL_TTL_MS

    const existing = await db.agentSkills
      .where('[platform+pageType+goal]')
      .equals([params.platform, params.pageType, params.goal])
      .first()

    if (existing) {
      const shouldUpdateSteps =
        params.steps.length > 0 &&
        (existing.steps.length === 0 || params.steps.length <= existing.steps.length)

      const updatedSteps = shouldUpdateSteps ? params.steps : existing.steps

      const updated: AgentSkill = {
        ...existing,
        steps: updatedSteps,
        successCount: existing.successCount + 1,
        failCount: 0, // 成功后重置 failCount，解除故障隔离
        lastUsedAt: now,
        expiresAt,
        selectorSignature: params.selectorSignature || existing.selectorSignature,
        enabled: true,
        patchSource: params.patchSource ?? existing.patchSource ?? 'heuristic',
        remediationNotes: params.remediationNotes ?? existing.remediationNotes,
        fingerprint: params.fingerprint ?? existing.fingerprint,
      }

      await db.agentSkills.put(updated)
      return updated
    } else {
      const newSkill: AgentSkill = {
        id: generateId(),
        platform: params.platform,
        pageType: params.pageType,
        goal: params.goal,
        steps: params.steps,
        successCount: 1,
        failCount: 0,
        createdAt: now,
        lastUsedAt: now,
        expiresAt,
        selectorSignature: params.selectorSignature,
        enabled: true,
        patchSource: params.patchSource ?? 'heuristic',
        remediationNotes: params.remediationNotes,
        fingerprint: params.fingerprint,
      }

      await db.agentSkills.put(newSkill)
      return newSkill
    }
  })
}

/**
 * 记录 Skill 失败
 * - failCount 累加
 * - 更新 lastUsedAt
 */
export async function recordSkillFail(skill: AgentSkill): Promise<void> {
  if (isContentScriptEnvironment()) {
    try {
      await sendRuntimeMessage<void>('RECORD_SKILL_FAIL', { skill, id: skill.id })
      return
    } catch (err) {
      console.warn('[SkillMemory] RECORD_SKILL_FAIL messaging error:', err)
      return
    }
  }

  return recordSkillFailDirect(skill)
}

/** 直接数据库更新实现 */
export async function recordSkillFailDirect(skill: AgentSkill): Promise<void> {
  return enqueueSkillWrite(async () => {
    const current = await db.agentSkills.get(skill.id)
    const nextFailCount = ((current?.failCount ?? skill.failCount) || 0) + 1
    await db.agentSkills.update(skill.id, {
      failCount: nextFailCount,
      lastUsedAt: Date.now(),
    })
  })
}

// ─── F3 · 技能管理（后台） ───

/** 全部技能（后台表格用，按最后使用倒序） */
export async function listSkills(): Promise<AgentSkill[]> {
  const all = await db.agentSkills.orderBy('lastUsedAt').reverse().toArray()
  return all
}

/** 启停技能（false=停用，findBestSkill 不再命中） */
export async function setSkillEnabled(id: string, enabled: boolean): Promise<void> {
  await db.agentSkills.update(id, { enabled })
}

/** 删除技能 */
export async function deleteSkill(id: string): Promise<void> {
  await db.agentSkills.delete(id)
}
