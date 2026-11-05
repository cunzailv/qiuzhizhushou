// Boss 直聘专属的页面操作逻辑（已从 content/action-simulator 下沉至此）。
// 该模块只服务于 Boss 平台，不依赖任何 content 层代码。
import { randomDelay } from '../../antiBot'
import type { JobCard, MatchResult } from '../../types/job'
import type { CollectOptions } from '../types'
import {
  findBestSkill,
  upsertSkill,
  recordSkillFail,
  buildSelectorFingerprint,
} from '../../agent/skill-memory'
import type { AgentSkill } from '../../agent/types'
import { chatCompletion, checkAIConfigured } from '../../ai/api-client'
import { recordError } from '../../db/error-store'
// M4 诊断埋点：与本地同名的审计日志函数区分开，写入 auditLogs(source='self_healing')
import { recordSelfHealingEvent as recordDiagnosticEvent } from '../../db/diagnostics-store'

export interface CommunicationUiSnapshot {
  inputs: Set<Element>
  visibleDialogs: Set<Element>
  // 扩展字段（新平台适配器使用；Boss 保留默认空值）
  hasInput?: boolean
  inputSelector?: string
  sendButton?: string
  applyButtons?: number
}

export interface FuzzyMatchResult {
  matched: boolean
  score: number // 0.0 - 1.0
  titleScore: number
  companyScore: number
  reasons: string[]
}

export interface ActivateCardFallbackOptions {
  allowDirectUrl?: boolean
  fuzzyThreshold?: number
  maxDetailWaitMs?: number
}

export interface ResilientClickContext {
  platform: string
  jobTitle: string
  company: string
  allowLlm?: boolean
  llmTimeoutMs?: number
}

export interface ResilientClickResult {
  success: boolean
  path: 'skill_memory' | 'standard_heuristic' | 'semantic_heuristic' | 'llm_perception' | 'local_heuristic_revert' | 'failed'
  usedSkill?: AgentSkill
}

export interface CandidateButtonInfo {
  index: number
  tag: string
  text: string
  className: string
  role?: string
  ariaLabel?: string
  ka?: string
  element: HTMLElement
}

export const BOSS_APPLY_SELECTORS = [
  '.btn-startchat',
  '[class*="btn-startchat"]',
  '[class*="startchat"]',
  '[class*="start-chat"]',
  '[class*="btn-chat"]',
  '[class*="chat-btn"]',
  '[ka*="startchat"]',
  '[ka*="start_chat"]',
  '[ka="job_detail_start_chat"]',
  '[ka="job_card_start_chat"]',
  'a.btn-startchat',
  'button.btn-startchat',
]

export const APPLY_SELECTOR = BOSS_APPLY_SELECTORS.join(', ')

/**
 * 负向黑名单判断：是否属于“不合适/不感兴趣/屏蔽/举报/收藏/关闭”等负向或非投递操作按钮
 */
export function isNegativeButton(el: Element): boolean {
  const text = (el.textContent || '').trim().replace(/\s+/g, '')
  const title = (el.getAttribute('title') || '').trim()
  const ariaLabel = (el.getAttribute('aria-label') || '').trim()
  const ka = (el.getAttribute('ka') || '').toLowerCase()
  const className = (typeof el.className === 'string' ? el.className : '').toLowerCase()

  const negativeKeywords = [
    '不合适',
    '不感兴趣',
    '不喜欢',
    '屏蔽',
    '举报',
    '投诉',
    '收藏',
    '已收藏',
    '关注',
    '已关注',
    '分享',
    '点赞',
    '关闭',
    '取消',
    '暂不',
    '放弃',
    '停止招聘',
    '已停止招聘',
    '职位已关闭',
    '职位已下线',
    '已下架',
    '已暂停招聘',
    '该职位已暂停沟通',
    '停止接受新沟通',
    '减少此类推荐',
    '不想看',
  ]

  for (const kw of negativeKeywords) {
    if (text.includes(kw) || title.includes(kw) || ariaLabel.includes(kw)) {
      return true
    }
  }

  // 属性维度的负向过滤（如 dislike, shield, collect, share, follow 等）
  if (
    ka.includes('dislike') ||
    ka.includes('shield') ||
    ka.includes('report') ||
    ka.includes('collect') ||
    ka.includes('share') ||
    ka.includes('follow') ||
    className.includes('dislike') ||
    className.includes('op-btn-dislike') ||
    className.includes('btn-cancel') ||
    className.includes('follow')
  ) {
    return true
  }

  return false
}

/**
 * 正向投递/沟通按钮判定：文案或特征必须为正向立即沟通，且严禁负向属性
 */
export function isPositiveApplyButton(el: Element): boolean {
  if (isNegativeButton(el)) {
    return false
  }

  const text = (el.textContent || '').trim().replace(/\s+/g, '')
  const lowerText = text.toLowerCase()
  const positiveTexts = [
    '立即沟通',
    '继续沟通',
    '立即投递',
    '聊一聊',
    '发消息',
    '与Boss沟通',
    '开聊',
    '去开聊',
    '打招呼',
    'apply',
  ]

  for (const pos of positiveTexts) {
    if (text.includes(pos) || lowerText.includes(pos)) {
      return true
    }
  }

  // 类名与属性正向特征
  const ka = (el.getAttribute('ka') || '').toLowerCase()
  const className = (typeof el.className === 'string' ? el.className : '').toLowerCase()

  if (
    className.includes('btn-startchat') ||
    className.includes('startchat') ||
    className.includes('btn-chat') ||
    className.includes('chat-btn') ||
    ka.includes('startchat') ||
    ka.includes('start_chat')
  ) {
    return true
  }

  return false
}

// ============================================================================
// 意外弹窗与遮罩脱困系统 (Unexpected Modals & Overlay De-blocking Engine)
// ============================================================================

/** 弹窗选择器合集：覆盖主流招聘平台、组件库与自研浮层 */
const MODAL_CONTAINER_SELECTORS = [
  '.dialog-wrap',
  '[role="dialog"]',
  '[role="alertdialog"]',
  '[aria-modal="true"]',
  '.boss-dialog',
  '[class*="dialog-box"]',
  '[class*="dialog-container"]',
  '.dialog-lib-box',
  '.chat-dialog',
  '.boss-popup',
  '[class*="popup-wrap"]',
  '[class*="popup-box"]',
  '[class*="modal-wrap"]',
  '[class*="modal-dialog"]',
  '[class*="modal-container"]',
  '.ant-modal',
  '.el-dialog',
  '.el-dialog__wrapper',
  '[class*="guide-dialog"]',
  '[class*="banner-dialog"]',
].join(', ')

/** 遮罩层选择器合集：覆盖各平台与主流 UI 库的半透明全屏背景 */
const MASK_BACKDROP_SELECTORS = [
  '.dialog-mask',
  '.modal-backdrop',
  '.v-modal',
  '.mask',
  '[class*="dialog-mask"]',
  '[class*="modal-backdrop"]',
  '[class*="v-modal"]',
  '[class*="popup-mask"]',
  '[class*="ant-modal-mask"]',
  '[class*="el-overlay"]',
  '[class*="modal-overlay"]',
  '[class*="backdrop"]',
].join(', ')

/** 常见非正向/关闭/取消文案启发式白名单 */
const DISMISS_BUTTON_TEXTS = [
  '取消',
  '放弃',
  '暂不',
  '我知道了',
  '知道了',
  '关闭',
  '忽略',
  '下次再说',
  '暂不体验',
  '暂不参与',
  '再看看',
  '退出',
  '拒绝',
  '跳过',
  '稍后再说',
]

/** 干扰/负向/非核心阻塞弹窗关键词 */
const UNEXPECTED_MODAL_KEYWORDS = [
  // 负向反馈与减少推荐
  '不合适的原因',
  '为什么不合适',
  '减少此类推荐',
  '选择原因',
  '不感兴趣',
  '不想看该',
  '屏蔽该公司',
  '不喜欢',
  '不再显示',
  '关闭推荐',
  // 客户端/APP 推广与升级通知
  '下载APP',
  '下载客户端',
  '扫码下载',
  '体验新版',
  '新版本上线',
  '升级提示',
  '立即升级',
  '更新提示',
  '版本更新',
  '升级新版',
  '安装客户端',
  '系统升级',
  // 调研问卷与活动浮层
  '问卷调研',
  '满意度评价',
  '求职体验调研',
  '求职反馈',
  '活动详情',
  '新人专享',
  '抽奖',
  '体验问卷',
  '给个好评',
  // 非关键提醒与引导
  '防骗提醒',
  '求职安全提醒',
  '安全防范小贴士',
  '温馨提示',
  '新手引导',
  '功能推荐',
  '隐私政策更新',
  '服务协议更新',
]

/**
 * 判断是否属于必须严格保护的正向交互弹窗或高危风控验证（严禁误杀）
 */
function isProtectedDialog(el: HTMLElement): boolean {
  const text = el.textContent || ''

  // 1. 正常打招呼开聊弹窗（包含输入框或打招呼关键词）
  const hasGreetingText =
    text.includes('打招呼') ||
    text.includes('开聊') ||
    text.includes('发送打招呼语') ||
    text.includes('编辑打招呼语') ||
    text.includes('发送简历') ||
    text.includes('打个招呼')
  const hasGreetingInput = !!el.querySelector(
    'textarea, div[contenteditable="true"], input[type="text"], [class*="chat-input"], [class*="greeting"]'
  )
  if (hasGreetingText && (hasGreetingInput || el.classList.contains('chat-dialog') || el.className.includes('chat'))) {
    return true
  }

  // 2. 真实安全风控滑块验证（需交由风控模块或人工介入，不可静默强关）
  const hasCaptchaMarker =
    text.includes('滑块验证') ||
    text.includes('请完成安全验证') ||
    text.includes('滑动验证') ||
    text.includes('安全验证') ||
    text.includes('验证码') ||
    !!el.querySelector('.geetest_holder, [class*="geetest"], [class*="captcha"], #nc_container, [class*="baxia"]')
  if (hasCaptchaMarker) {
    return true
  }

  // 3. 每日沟通上限硬阻断（由风控检测器统一感知并停止整场任务，不作为普通弹窗强关）
  if (text.includes('沟通上限') || text.includes('沟通次数已达上限') || (text.includes('已达上限') && text.includes('沟通'))) {
    return true
  }

  // 4. 主岗位详情展示抽屉（非阻塞性弹窗）
  if (
    (el.classList.contains('job-detail-box') || el.classList.contains('job-detail-container')) &&
    !el.getAttribute('role')?.includes('dialog')
  ) {
    return true
  }

  return false
}

/** 扩展自有 UI 不能被自愈清理当成页面弹窗/遮罩隐藏 */
function isExtensionOwnedUi(el: HTMLElement): boolean {
  if (el.id === 'boss-assistant-panel' || el.id === 'boss-assistant-trigger') return true
  return typeof el.closest === 'function'
    && !!el.closest('#boss-assistant-panel, #boss-assistant-trigger')
}

/**
 * 自动识别并关闭页面上的意外阻塞性弹窗（例如“请选择不合适的原因”、“升级提示”、“APP推荐”、“问卷”等）
 * 解除半透明遮罩与 body 滚动/指针锁定，保证自动化与用户操作畅通无阻。
 *
 * @param doc 目标文档（默认为 document）
 * @returns boolean 若有任何弹窗关闭、遮罩清除或视图复原，返回 true；若页面无任何阻塞，返回 false。
 */
export function dismissUnexpectedModals(doc: Document = document): boolean {
  let dismissed = false

  try {
    if (!doc || !doc.body) return false

    // 1. 扫描页面中所有潜在弹窗
    const dialogs = Array.from(doc.querySelectorAll<HTMLElement>(MODAL_CONTAINER_SELECTORS))

    for (const dialog of dialogs) {
      if (isExtensionOwnedUi(dialog)) continue
      // 忽略不可见元素
      if (
        dialog.offsetWidth === 0 &&
        dialog.offsetHeight === 0 &&
        (!dialog.getClientRects || dialog.getClientRects().length === 0)
      ) {
        continue
      }

      // 保护正向打招呼与风控验证弹窗
      if (isProtectedDialog(dialog)) {
        continue
      }

      const text = dialog.textContent || ''
      const isKnownUnexpected = UNEXPECTED_MODAL_KEYWORDS.some((kw) => text.includes(kw))
      const hasDialogRole =
        dialog.getAttribute('role') === 'dialog' ||
        dialog.getAttribute('role') === 'alertdialog' ||
        dialog.getAttribute('aria-modal') === 'true'

      // 若命中干扰关键词，或属于非保护的通用浮层弹窗
      if (isKnownUnexpected || hasDialogRole) {
        // Step 1: 优先点击“取消”/“我知道了”等文本型按钮
        const cancelBtn = Array.from(
          dialog.querySelectorAll<HTMLElement>('button, a, span, [role="button"], div')
        ).find((el) => {
          const t = el.textContent?.trim() || ''
          return (
            DISMISS_BUTTON_TEXTS.includes(t) ||
            el.classList.contains('btn-cancel') ||
            el.className.includes('cancel') ||
            el.className.includes('dismiss')
          )
        })

        if (cancelBtn) {
          try {
            cancelBtn.click()
            dismissed = true
          } catch { /* 预期内异常，安全忽略 */ }
        } else {
          // Step 2: 查找关闭图标（.icon-close, SVG, unicode × 等）
          const closeBtn = Array.from(
            dialog.querySelectorAll<HTMLElement>(
              'button, a, span, i, [role="button"], ' +
                '.icon-close, .dialog-close, .iboss-close, .boss-popup__close, .ant-modal-close, .el-dialog__close, ' +
                '[aria-label*="close" i], [aria-label*="关闭"], [title*="关闭"], [title*="close" i], ' +
                '.close, [class*="close" i], [class*="Close"], button svg, a svg'
            )
          ).find((el) => {
            const t = el.textContent?.trim() || ''
            return (
              t === '×' ||
              t === '✕' ||
              t === '✖' ||
              t === '╳' ||
              t === 'X' ||
              t === 'x' ||
              el.tagName.toLowerCase() === 'svg' ||
              !!el.querySelector('svg') ||
              el.className.toLowerCase().includes('close') ||
              el.getAttribute('aria-label')?.toLowerCase().includes('close')
            )
          })

          if (closeBtn) {
            try {
              closeBtn.click()
              dismissed = true
            } catch { /* 预期内异常，安全忽略 */ }
          }
        }

        // Step 3: 发送 ESC 键盘事件兜底
        try {
          const escEvent = new KeyboardEvent('keydown', {
            key: 'Escape',
            code: 'Escape',
            keyCode: 27,
            which: 27,
            bubbles: true,
            cancelable: true,
          })
          dialog.dispatchEvent(escEvent)
          const targetWin = doc.defaultView || window
          targetWin.dispatchEvent(escEvent)
          doc.dispatchEvent(escEvent)
        } catch { /* 预期内异常，安全忽略 */ }

        // Step 4: 强制隐藏/清除仍残留的弹窗 DOM 节点，防止卡死
        if (
          dialog.isConnected &&
          dialog.style.display !== 'none' &&
          (dialog.offsetWidth > 0 || dialog.offsetHeight > 0 || (dialog.getClientRects && dialog.getClientRects().length > 0))
        ) {
          dialog.style.display = 'none'
          dialog.style.pointerEvents = 'none'
          dismissed = true
        }
      }
    }

    // 2. 检查页面是否存在正在活跃的正向交互弹窗
    const hasActiveChatDialog = Array.from(
      doc.querySelectorAll<HTMLElement>('.chat-dialog, .dialog-wrap, [class*="chat-modal"]')
    ).some(
      (d) =>
        isProtectedDialog(d) &&
        d.style.display !== 'none' &&
        (d.offsetWidth > 0 || d.offsetHeight > 0 || (d.getClientRects && d.getClientRects().length > 0))
    )

    // 3. 清理遗留的孤立遮罩层与全屏高 z-index 阻塞浮层
    if (!hasActiveChatDialog) {
      const masks = doc.querySelectorAll<HTMLElement>(MASK_BACKDROP_SELECTORS)
      for (const mask of Array.from(masks)) {
        if (isExtensionOwnedUi(mask)) continue
        if (mask.style.display === 'none') continue
        if (mask.offsetWidth > 0 || mask.offsetHeight > 0 || (mask.getClientRects && mask.getClientRects().length > 0)) {
          mask.style.display = 'none'
          mask.style.pointerEvents = 'none'
          dismissed = true
        }
      }

      // 探测高 z-index (>= 1000) 的全屏固定定位遮蔽层
      const fixedDivs = doc.querySelectorAll<HTMLElement>('div[style*="fixed"], div[style*="z-index"]')
      for (const div of Array.from(fixedDivs)) {
        if (isExtensionOwnedUi(div)) continue
        if (div.style.display === 'none') continue
        const style = div.style
        const zIndex = parseInt(style.zIndex, 10)
        if (
          (style.position === 'fixed' || style.position === 'absolute') &&
          zIndex >= 1000 &&
          (div.offsetWidth > 0 || div.offsetHeight > 0)
        ) {
          div.style.display = 'none'
          div.style.pointerEvents = 'none'
          dismissed = true
        }
      }
    }

    // 4. 彻底复原 Body 与 DocumentElement 视口滚动与交互（解除 scroll freeze / pointer-events freeze）
    if (!hasActiveChatDialog) {
      if (doc.body) {
        if (doc.body.style.overflow === 'hidden') {
          doc.body.style.overflow = ''
          dismissed = true
        }
        if (doc.body.style.position === 'fixed') {
          doc.body.style.position = ''
          dismissed = true
        }
        if (doc.body.style.pointerEvents === 'none') {
          doc.body.style.pointerEvents = ''
          dismissed = true
        }
        const lockClasses = ['modal-open', 'dialog-open', 'has-modal', 'popup-show', 'overflow-hidden']
        for (const cls of lockClasses) {
          if (doc.body.classList.contains(cls)) {
            doc.body.classList.remove(cls)
            dismissed = true
          }
        }
      }

      if (doc.documentElement) {
        if (doc.documentElement.style.overflow === 'hidden') {
          doc.documentElement.style.overflow = ''
          dismissed = true
        }
        if (doc.documentElement.style.pointerEvents === 'none') {
          doc.documentElement.style.pointerEvents = ''
          dismissed = true
        }
      }
    }
  } catch {
    // 任务优先保障：永不向外抛出异常
  }

  // M4 埋点：弹窗/遮罩/滚动锁死被强制清除时记录归因（fire-and-forget，不阻断主链路）
  if (dismissed) {
    void recordDiagnosticEvent({
      platform: 'boss',
      category: 'modal_dismissed',
      triggerDescription: '检测到意外弹窗、全屏遮罩或视口滚动锁死',
      bypassPath: 'force_dismiss_and_viewport_restore',
      success: true,
    }).catch(() => {})
  }

  return dismissed
}

/**
 * 健壮查找所有可见的沟通/投递按钮（选择器 + 文案启发式双重探测，且严格排除任何负向/不合适按钮）
 */
export function findApplyButtons(root: Document | Element = document): HTMLElement[] {
  const scope = root || (typeof document !== 'undefined' ? document : null)
  if (!scope) return []
  const elements = Array.from(scope.querySelectorAll<HTMLElement>(APPLY_SELECTOR))
  const set = new Set<HTMLElement>()

  for (const el of elements) {
    if (isPositiveApplyButton(el)) {
      set.add(el)
    }
  }

  // 兜底：通过常见沟通文案（立即沟通、继续沟通、聊一聊、立即投递等）查找交互按钮
  const clickableCandidates = Array.from(
    scope.querySelectorAll<HTMLElement>('a, button, [role="button"], span.btn, div.btn, [class*="btn"]')
  )
  for (const el of clickableCandidates) {
    if (isPositiveApplyButton(el)) {
      set.add(el)
    }
  }

  const validButtons = Array.from(set).filter((el) => {
    // 严禁负向按钮
    if (isNegativeButton(el)) return false
    // 必须符合正向沟通按钮标准
    if (!isPositiveApplyButton(el)) return false
    // 过滤掉不可见或未渲染元素
    return el.offsetWidth > 0 || el.offsetHeight > 0 || el.getClientRects().length > 0
  })

  // 排序：含有“立即沟通”或具有明确 .btn-startchat 主类名的按钮排在最前
  validButtons.sort((a, b) => {
    const textA = (a.textContent || '').trim()
    const textB = (b.textContent || '').trim()
    const isPrimaryA = textA.includes('立即沟通') || a.classList.contains('btn-startchat')
    const isPrimaryB = textB.includes('立即沟通') || b.classList.contains('btn-startchat')
    if (isPrimaryA && !isPrimaryB) return -1
    if (!isPrimaryA && isPrimaryB) return 1
    return 0
  })

  return validButtons
}

/**
 * 严格基于预设选择器配置查找沟通/投递按钮 (Tier 1 专用，排除无预设类名的普通元素)
 */
export function findConfiguredApplyButtons(root: Document | Element = document): HTMLElement[] {
  const scope = root || (typeof document !== 'undefined' ? document : null)
  if (!scope) return []
  const elements = Array.from(scope.querySelectorAll<HTMLElement>(APPLY_SELECTOR))
  const validButtons = elements.filter((el) => {
    if (el.hasAttribute('disabled') || el.classList.contains('disabled') || el.getAttribute('aria-disabled') === 'true') {
      return false
    }
    if (isNegativeButton(el)) {
      // M4 埋点：isNegativeButton 的实际拦截分支（纯函数本身保持无副作用）
      // 记录预设选择器命中却因负面语义被拦下的节点，避免误点"不合适"复发。
      void recordDiagnosticEvent({
        platform: 'boss',
        category: 'negative_button_blocked',
        triggerDescription: '预设选择器命中候选节点，但被负面按钮黑名单拦截，已中止点击',
        bypassPath: 'negative_blacklist_block',
        failedSelector: APPLY_SELECTOR,
        buttonText: (el.textContent || '').trim().slice(0, 40),
        success: true,
      }).catch(() => {})
      return false
    }
    if (!isPositiveApplyButton(el)) return false
    return el.offsetWidth > 0 || el.offsetHeight > 0 || (el.getClientRects && el.getClientRects().length > 0)
  })
  validButtons.sort((a, b) => {
    const textA = (a.textContent || '').trim()
    const textB = (b.textContent || '').trim()
    const isPrimaryA = textA.includes('立即沟通') || a.classList.contains('btn-startchat')
    const isPrimaryB = textB.includes('立即沟通') || b.classList.contains('btn-startchat')
    if (isPrimaryA && !isPrimaryB) return -1
    if (!isPrimaryA && isPrimaryB) return 1
    return 0
  })
  return validButtons
}

const GREETING_INPUT_SELECTOR = [
  '[class*="greet-message"]',
  '[class*="chat-input"]',
  'textarea',
  '[class*="message-area"]',
].join(', ')

const COMMUNICATION_DIALOG_SELECTOR = [
  '[role="dialog"]',
  '.dialog-wrap',
  '[class*="boss-dialog"]',
  '[class*="dialog-container"]',
  '[class*="dialog-wrapper"]',
  '[class*="modal"]',
  '[class*="popup"]',
  '.chat-dialog',
].join(', ')

export async function clickElement(
  selector: string,
  options?: { all?: boolean; index?: number }
): Promise<{ success: boolean; count: number }> {
  await randomDelay()

  if (options?.all) {
    const elements = document.querySelectorAll(selector)
    let count = 0
    for (const el of elements) {
      ;(el as HTMLElement).click()
      count++
      await randomDelay(500, 1500)
    }
    return { success: count > 0, count }
  }

  if (options?.index !== undefined) {
    const elements = document.querySelectorAll(selector)
    if (elements.length > options.index) {
      ;(elements[options.index] as HTMLElement).click()
      return { success: true, count: 1 }
    }
    return { success: false, count: 0 }
  }

  const element = document.querySelector(selector) as HTMLElement | null
  if (element) {
    element.click()
    return { success: true, count: 1 }
  }
  return { success: false, count: 0 }
}

// ============================================================================
// 按钮点击多阶弹性降级与技能热修复 (Button Resilience & Multi-Tier Fallback Engine)
// ============================================================================

export const WHITELIST_PRIMARY = ['立即沟通', '打招呼', '聊一聊', '投递简历', '继续沟通']
export const WHITELIST_SYNONYMS = ['立即投递', '发消息', '与Boss沟通', '开聊', '去开聊', 'apply', 'chat', '发起对话', '发送意向', '发起交谈']
export const COMMUNICATIVE_KEYWORDS = ['沟通', '投递', '聊', '对话', '交谈', '意向', '申请', '开聊', '联系', '打招呼', '发信', 'apply', 'chat']

/** 记录自愈审计日志到 db.errors 并通知 runtime */
export async function recordSelfHealingEvent(payload: {
  source: string
  message: string
  context?: string
}): Promise<void> {
  try {
    if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
      chrome.runtime.sendMessage({
        type: 'RECORD_ERROR',
        payload,
      }).catch?.(() => {})
    }
  } catch { /* 预期内异常，安全忽略 */ }
  try {
    await recordError(payload)
  } catch { /* 预期内异常，安全忽略 */ }
}

/** 提取可见、未禁用、非黑名单的交互候选按钮 */
export function extractCandidateButtons(root: ParentNode): CandidateButtonInfo[] {
  if (!root) return []
  const elements = Array.from(
    root.querySelectorAll<HTMLElement>(
      'button, a, [role="button"], span.btn, div.btn, [class*="btn"], input[type="button"], input[type="submit"]'
    )
  )
  const candidates: CandidateButtonInfo[] = []
  const seen = new Set<HTMLElement>()

  for (const el of elements) {
    if (seen.has(el)) continue
    seen.add(el)

    if (
      el.offsetWidth === 0 &&
      el.offsetHeight === 0 &&
      (!el.getClientRects || el.getClientRects().length === 0)
    ) {
      continue
    }
    if (el.hasAttribute('disabled') || el.classList.contains('disabled') || el.getAttribute('aria-disabled') === 'true') {
      continue
    }
    if (isNegativeButton(el)) {
      continue
    }

    const text = (el.textContent || '').trim().replace(/\s+/g, ' ')
    const className = typeof el.className === 'string' ? el.className.trim() : ''
    const role = el.getAttribute('role') || undefined
    const ariaLabel = el.getAttribute('aria-label') || el.getAttribute('title') || undefined
    const ka = el.getAttribute('ka') || undefined

    candidates.push({
      index: candidates.length,
      tag: el.tagName.toLowerCase(),
      text: text.slice(0, 40),
      className: className.slice(0, 100),
      role,
      ariaLabel,
      ka,
      element: el,
    })

    if (candidates.length >= 15) break
  }

  return candidates
}

/** 语义文案黑白名单启发式探测 (Tier 2) */
export function findWhitelistCandidate(candidates: CandidateButtonInfo[]): CandidateButtonInfo | null {
  let best: CandidateButtonInfo | null = null
  let maxScore = 0

  for (const c of candidates) {
    const text = c.text.replace(/\s+/g, '')
    const lower = text.toLowerCase()
    let score = 0

    for (const w of WHITELIST_PRIMARY) {
      if (text === w) score = Math.max(score, 100)
      else if (text.includes(w) || lower.includes(w.toLowerCase())) score = Math.max(score, 80)
    }

    if (score === 0) {
      for (const s of WHITELIST_SYNONYMS) {
        if (text === s) score = Math.max(score, 75)
        else if (text.includes(s) || lower.includes(s.toLowerCase())) score = Math.max(score, 60)
      }
    }

    if (score > 0) {
      if (c.tag === 'button') score += 10
      if (/startchat|chat|apply/i.test(c.className) || (c.ka && /chat|apply/i.test(c.ka))) score += 10
      if (score > maxScore) {
        maxScore = score
        best = c
      }
    }
  }

  return best
}

/** LLM 感知决策降级 (Tier 3) */
export async function selectButtonViaLlm(
  candidates: CandidateButtonInfo[],
  context: { platform: string; jobTitle: string; company: string },
  timeoutMs = 8000
): Promise<{ candidate: CandidateButtonInfo; reason: string } | null> {
  if (candidates.length === 0) return null

  const serialized = candidates.map((c) => ({
    index: c.index,
    tag: c.tag,
    text: c.text,
    className: c.className,
    role: c.role,
    ariaLabel: c.ariaLabel,
    ka: c.ka,
  }))

  const systemPrompt = [
    'You are an intelligent web UI perception agent.',
    'Identify which candidate button is the genuine button to initiate communication or apply for the job position.',
    'Strictly avoid negative action buttons (e.g. close, cancel, dislike, report, favorite, follow).',
    'Respond ONLY with a JSON object in this format: {"selectedIndex": <number or null>, "confidence": <number between 0 and 1>, "reason": "<brief explanation>"}',
    'If none of the candidates is a valid communicate/apply button, return {"selectedIndex": null, "confidence": 0, "reason": "No valid button found"}.',
  ].join(' ')

  const userMessage = [
    `Target Job Title: "${context.jobTitle}"`,
    `Target Company: "${context.company}"`,
    'Candidate Interactive Elements:',
    JSON.stringify(serialized, null, 2),
  ].join('\n')

  let raw = ''
  try {
    const callPromise = chatCompletion(systemPrompt, userMessage, 0.1)
    const timeoutPromise = new Promise<string>((_, reject) =>
      setTimeout(() => reject(new Error('LLM timeout')), timeoutMs)
    )
    raw = await Promise.race([callPromise, timeoutPromise])
  } catch {
    return null
  }

  if (!raw || typeof raw !== 'string') return null

  try {
    const match = raw.match(/\{[\s\S]*?\}/)
    if (!match) return null
    const parsed = JSON.parse(match[0])
    if (
      typeof parsed.selectedIndex === 'number' &&
      parsed.selectedIndex >= 0 &&
      parsed.selectedIndex < candidates.length
    ) {
      const chosen = candidates[parsed.selectedIndex]
      if (isNegativeButton(chosen.element)) return null
      return { candidate: chosen, reason: parsed.reason || 'LLM perception decision' }
    }
  } catch {
    return null
  }

  return null
}

/** 本地启发式规则安全兜底与任务连续性保障 (Tier 4) */
export function rankCandidatesLocally(candidates: CandidateButtonInfo[]): CandidateButtonInfo | null {
  let best: CandidateButtonInfo | null = null
  let bestScore = 0

  for (const c of candidates) {
    if (isNegativeButton(c.element)) continue
    let score = 0
    const text = c.text.replace(/\s+/g, '')
    const lower = text.toLowerCase()

    for (const kw of COMMUNICATIVE_KEYWORDS) {
      if (text.includes(kw) || lower.includes(kw.toLowerCase())) {
        score += 40
        break
      }
    }

    if (/chat|apply|startchat|contact/i.test(c.className)) score += 25
    if (c.ka && /chat|apply/i.test(c.ka)) score += 25
    if (c.tag === 'button') score += 15
    if (c.role === 'button') score += 10
    if (text.length >= 2 && text.length <= 10) score += 10

    if (score > bestScore) {
      bestScore = score
      best = c
    }
  }

  return bestScore > 0 ? best : null
}

/**
 * 按钮点击多阶弹性降级体系：
 * Tier 0: Skill Memory 技能记忆优先复用 (0ms 瞬时热修复)
 * Tier 1: 预设类名常规选择器点击 (.btn-startchat)
 * Tier 2: 语义文本黑白名单启发式探测 + 动态技能沉淀
 * Tier 3: LLM 候选感知与决策降级 + 动态技能沉淀
 * Tier 4: 本地规则安全兜底回退 + 任务连续性保障
 */
export async function clickApplyButtonWithResilience(
  jobCard: HTMLElement,
  context: ResilientClickContext
): Promise<ResilientClickResult> {
  dismissUnexpectedModals()

  const platform = context.platform || 'boss'
  const pageType = 'job_detail'
  const goal = 'click_apply'

  // ─── Tier 0: Skill Memory Cache ───
  try {
    const cachedSkill = await findBestSkill(platform, pageType, goal)
    if (cachedSkill && cachedSkill.steps && cachedSkill.steps.length > 0) {
      const targetSelector =
        cachedSkill.steps[0].action?.target?.value ||
        cachedSkill.fingerprint?.cssSelector ||
        cachedSkill.selectorSignature

      if (targetSelector) {
        const targetEl =
          jobCard?.querySelector<HTMLElement>(targetSelector) ||
          document.querySelector<HTMLElement>(targetSelector)

        if (
          targetEl &&
          (targetEl.offsetWidth > 0 || targetEl.offsetHeight > 0 || (targetEl.getClientRects && targetEl.getClientRects().length > 0)) &&
          !targetEl.hasAttribute('disabled') &&
          !targetEl.classList.contains('disabled') &&
          targetEl.getAttribute('aria-disabled') !== 'true' &&
          !isNegativeButton(targetEl)
        ) {
          targetEl.click()
          await recordSelfHealingEvent({
            source: `self-healing.skill_patch.${platform}`,
            message: `[Self-Healing] click_apply: Skill memory hit -> Reused cached selector: ${targetSelector}`,
            context: JSON.stringify({
              category: 'skill_patch',
              action: 'click_apply',
              mitigation: `Reused cached selector: ${targetSelector}`,
              selector: targetSelector,
              skillId: cachedSkill.id,
              ...context,
            }),
          })
          dismissUnexpectedModals()
          return { success: true, path: 'skill_memory', usedSkill: cachedSkill }
        } else {
          await recordSkillFail(cachedSkill)
        }
      }
    }
  } catch {
    // 降级至 Tier 1
  }

  // ─── Tier 1: Configured Default Selector ───
  const standardButtons = jobCard ? findConfiguredApplyButtons(jobCard) : []
  if (standardButtons.length > 0) {
    standardButtons[0].click()
    dismissUnexpectedModals()
    return { success: true, path: 'standard_heuristic' }
  }
  const docStandardButtons = findConfiguredApplyButtons(document)
  if (docStandardButtons.length > 0) {
    docStandardButtons[0].click()
    dismissUnexpectedModals()
    return { success: true, path: 'standard_heuristic' }
  }

  // 提取候选按钮供 Tiers 2, 3, 4 使用
  const cardCandidates = jobCard ? extractCandidateButtons(jobCard) : []
  const candidates = cardCandidates.length > 0 ? cardCandidates : extractCandidateButtons(document)

  // ─── Tier 2: 语义文本白名单启发式探测 ───
  const whitelistCandidate = findWhitelistCandidate(candidates)
  if (whitelistCandidate) {
    whitelistCandidate.element.click()
    const selector = buildSelectorFingerprint(whitelistCandidate.element, jobCard || undefined)
    try {
      await upsertSkill({
        platform,
        pageType,
        goal,
        steps: [
          {
            thinking: `Semantic text heuristic matched: "${whitelistCandidate.text}"`,
            action: { type: 'click', target: { kind: 'css_selector', value: selector } },
          },
        ],
        selectorSignature: selector,
        patchSource: 'heuristic',
        remediationNotes: `Discovered apply button via semantic text heuristic: "${whitelistCandidate.text}"`,
        fingerprint: {
          cssSelector: selector,
          buttonText: whitelistCandidate.text,
          signature: `${platform}:${pageType}:${goal}:${selector}`,
        },
      })
    } catch { /* 预期内异常，安全忽略 */ }

    await recordSelfHealingEvent({
      source: `self-healing.button_fallback.${platform}`,
      message: `[Self-Healing] click_apply: Conventional selector failed -> Selected element ${selector} ("${whitelistCandidate.text}") and hot-patched to agentSkills`,
      context: JSON.stringify({
        category: 'button_fallback',
        action: 'click_apply',
        mitigation: `Selected element ${selector} ("${whitelistCandidate.text}") and hot-patched to agentSkills`,
        selector,
        buttonText: whitelistCandidate.text,
        ...context,
      }),
    })
    // M4 埋点 · Tier 2：预设选择器失效，语义启发式命中
    void recordDiagnosticEvent({
      platform,
      category: 'button_heuristic',
      triggerDescription: '预设沟通按钮选择器未命中，降级为语义文本白名单启发式',
      bypassPath: 'semantic_text_whitelist',
      failedSelector: APPLY_SELECTOR,
      buttonText: whitelistCandidate.text,
      jobTitle: context.jobTitle,
      success: true,
    }).catch(() => {})
    dismissUnexpectedModals()
    return { success: true, path: 'semantic_heuristic' }
  }

  // ─── Tier 3: LLM 感知与决策降级 ───
  if (context.allowLlm !== false) {
    try {
      const { configured } = await checkAIConfigured()
      if (configured) {
        const llmResult = await selectButtonViaLlm(candidates, context, context.llmTimeoutMs)
        if (llmResult) {
          llmResult.candidate.element.click()
          const selector = buildSelectorFingerprint(llmResult.candidate.element, jobCard || undefined)
          try {
            await upsertSkill({
              platform,
              pageType,
              goal,
              steps: [
                {
                  thinking: `LLM perception: ${llmResult.reason}`,
                  action: { type: 'click', target: { kind: 'css_selector', value: selector } },
                },
              ],
              selectorSignature: selector,
              patchSource: 'llm',
              remediationNotes: `Discovered by LLM perception: ${llmResult.reason}`,
              fingerprint: {
                cssSelector: selector,
                buttonText: llmResult.candidate.text,
                signature: `${platform}:${pageType}:${goal}:${selector}`,
              },
            })
          } catch { /* 预期内异常，安全忽略 */ }

          await recordSelfHealingEvent({
            source: `self-healing.button_fallback.${platform}`,
            message: `[Self-Healing] click_apply: Conventional selector failed -> Selected element ${selector} ("${llmResult.candidate.text}") and hot-patched to agentSkills (LLM)`,
            context: JSON.stringify({
              category: 'button_fallback',
              action: 'click_apply',
              mitigation: `Selected element ${selector} ("${llmResult.candidate.text}") and hot-patched to agentSkills (LLM)`,
              selector,
              buttonText: llmResult.candidate.text,
              reason: llmResult.reason,
              ...context,
            }),
          })
          // M4 埋点 · Tier 3：启发式未命中，LLM 感知决策命中
          void recordDiagnosticEvent({
            platform,
            category: 'button_llm',
            triggerDescription: `语义启发式未命中，触发 LLM 感知决策：${llmResult.reason}`,
            bypassPath: 'llm_perception',
            buttonText: llmResult.candidate.text,
            jobTitle: context.jobTitle,
            success: true,
          }).catch(() => {})
          dismissUnexpectedModals()
          return { success: true, path: 'llm_perception' }
        }
      }
    } catch { /* 预期内异常，安全忽略 */ }
  }

  // ─── Tier 4: 本地规则安全兜底 ───
  const localCandidate = rankCandidatesLocally(candidates)
  if (localCandidate) {
    localCandidate.element.click()
    const selector = buildSelectorFingerprint(localCandidate.element, jobCard || undefined)
    try {
      await upsertSkill({
        platform,
        pageType,
        goal,
        steps: [
          {
            thinking: `Local heuristic safety fallback: "${localCandidate.text}"`,
            action: { type: 'click', target: { kind: 'css_selector', value: selector } },
          },
        ],
        selectorSignature: selector,
        patchSource: 'heuristic',
        remediationNotes: `Recovered via Tier 4 local rule-based safety fallback: "${localCandidate.text}"`,
        fingerprint: {
          cssSelector: selector,
          buttonText: localCandidate.text,
          signature: `${platform}:${pageType}:${goal}:${selector}`,
        },
      })
    } catch { /* 预期内异常，安全忽略 */ }

    await recordSelfHealingEvent({
      source: `self-healing.button_fallback.${platform}`,
      message: `[Self-Healing] click_apply: LLM unavailable/failed -> Recovered via local heuristic safety fallback: ${selector} ("${localCandidate.text}")`,
      context: JSON.stringify({
        category: 'button_fallback',
        action: 'click_apply',
        mitigation: `Clicked fallback element ${selector} with text "${localCandidate.text}"`,
        selector,
        buttonText: localCandidate.text,
        ...context,
      }),
    })
    // M4 埋点 · Tier 4：LLM 失败/不可用，本地规则安全回退
    void recordDiagnosticEvent({
      platform,
      category: 'button_local_fallback',
      triggerDescription: 'LLM 感知不可用或调用失败，回落本地规则安全兜底',
      bypassPath: 'local_heuristic_revert',
      buttonText: localCandidate.text,
      jobTitle: context.jobTitle,
      success: true,
    }).catch(() => {})
    dismissUnexpectedModals()
    return { success: true, path: 'local_heuristic_revert' }
  }

  return { success: false, path: 'failed' }
}

export async function clickApplyButton(jobCard: HTMLElement): Promise<boolean> {
  const result = await clickApplyButtonWithResilience(jobCard, {
    platform: 'boss',
    jobTitle: '',
    company: '',
    allowLlm: true,
  })
  return result.success
}

function getActionRoot(action: Element): HTMLElement {
  return (
    action.closest(
      '.job-detail-box, .job-detail-container, .job-detail-content, .job-detail-wrapper, [class*="job-detail"], .job-detail-section, .job-box',
    )
    || action.parentElement?.closest('[class*="detail"]')
    || action.parentElement
    || document.body
  ) as HTMLElement
}

export function cleanTitle(text: string): string {
  return text
    .toLowerCase()
    .replace(/[（(【[].*?[）)】\]]/g, '') // 去除括号内容如（AI 智能体方向），得到核心岗位如 "全栈工程师"
    .replace(/[\s\-_/\\（）()【】[\]·•/]/g, '')
    .trim()
}

export function cleanFullText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[（【]/g, '(')
    .replace(/[）】]/g, ')')
    .replace(/[\s\-_/\\·•/]/g, '')
    .trim()
}

/** 清理并提取公司主体核心词（去除地名、有限公司、科技有限公司等通用行政后缀与括号说明） */
export function cleanCompanyName(name: string): string {
  return cleanFullText(name)
    .replace(/[(（].*?[)）]/g, '')
    .replace(/(深圳|广州|北京|上海|杭州|成都|武汉|南京|苏州|西安|长沙|东莞|重庆)(市)?/g, '')
    .replace(/(有限责任公司|股份有限公司|科技有限责任公司|网络技术服务有限公司|技术服务有限公司|网络科技有限公司|信息科技有限公司|科技有限公司|网络科技|信息科技|技术服务|服务有限公司|发展有限公司|网络技术|软件技术|集团有限公司|有限公司|分公司|集团|科技)/g, '')
    .trim()
}

/** 双向智能公司名匹配：处理全称与简称不对称（如预期“深圳市方圆宝科技有限公司” vs 页面卡片“方圆宝”） */
export function isCompanyMatch(text: string, expectedCompany: string): boolean {
  if (!expectedCompany) return true
  const normExpected = cleanFullText(expectedCompany)
  const coreExpected = cleanCompanyName(expectedCompany)
  const normText = cleanFullText(text)
  const coreText = cleanCompanyName(text)

  if (normText.includes(normExpected)) return true
  if (coreExpected.length >= 2 && normText.includes(coreExpected)) return true
  if (coreText.length >= 2 && normExpected.includes(coreText)) return true
  if (coreExpected.length >= 2 && coreText.includes(coreExpected)) return true
  return false
}

/** 双向智能职位名匹配：处理带括号或前缀后缀不对称 */
export function isTitleMatch(text: string, expectedTitle: string): boolean {
  if (!expectedTitle) return true
  const normExpected = cleanFullText(expectedTitle)
  const coreExpected = cleanTitle(expectedTitle)
  const normText = cleanFullText(text)
  const coreText = cleanTitle(text)

  if (normText.includes(normExpected)) return true
  if (coreExpected && normText.includes(coreExpected)) return true
  if (coreText.length >= 2 && normExpected.includes(coreText)) return true
  if (coreExpected && coreText.includes(coreExpected)) return true

  // 针对带斜杠 / 分隔符的复合职位（如 "全栈产品工程师 / 独立开发者"、"技术经理/架构师"）
  const subParts = expectedTitle
    .split(/[/、|]+/)
    .map((s) => cleanTitle(s))
    .filter((s) => s.length >= 2)
  if (subParts.length > 1 && subParts.some((p) => normText.includes(p) || coreText.includes(p))) {
    return true
  }

  return false
}

// ============================================================================
// 去行政后缀模糊多词匹配系统 (Fuzzy Multi-Word Match Engine)
// ============================================================================

const GEOGRAPHIC_PREFIX_SUFFIX_REGEX = new RegExp(
  '(' +
  '北京|上海|天津|重庆|' +
  '广东|深圳|广州|东莞|佛山|珠海|中山|惠州|江门|汕头|' +
  '浙江|杭州|宁波|温州|嘉兴|湖州|绍兴|金华|衢州|舟山|台州|丽水|' +
  '江苏|南京|无锡|徐州|常州|苏州|南通|连云港|淮安|盐城|扬州|镇江|泰州|宿迁|' +
  '四川|成都|绵阳|德阳|' +
  '湖北|武汉|宜昌|襄阳|' +
  '湖南|长沙|株洲|湘潭|' +
  '陕西|西安|咸阳|' +
  '山东|济南|青岛|烟台|潍坊|' +
  '福建|福州|厦门|泉州|' +
  '河南|郑州|洛阳|' +
  '河北|石家庄|唐山|保定|' +
  '安徽|合肥|芜湖|' +
  '江西|南昌|赣州|' +
  '辽宁|沈阳|大连|' +
  '黑龙江|哈尔滨|' +
  '吉林|长春|' +
  '云南|昆明|贵州|贵阳|广西|南宁|桂林|海南|海口|三亚|山西|太原|内蒙古|呼和浩特|宁夏|银川|新疆|乌鲁木齐|西藏|拉萨|青海|西宁|甘肃|兰州' +
  ')(市|省|自治区|特别行政区|区|县)?',
  'g'
)

const CORPORATE_SUFFIX_REGEX = new RegExp(
  '(' +
  '网络科技服务有限公司|网络技术服务有限公司|科学技术服务有限公司|信息技术服务有限公司|技术服务有限公司|' +
  '网络科技有限公司|信息科技有限公司|软件技术有限公司|科学技术有限公司|数字科技有限公司|数据技术有限公司|智能科技有限公司|' +
  '电子商务有限公司|文化传播有限公司|广告传媒有限公司|企业管理咨询有限公司|投资管理有限公司|' +
  '有限责任公司|股份有限公司|股份合作公司|全民所有制|合伙企业\\(有限合伙\\)|合伙企业|有限合伙|个人独资企业|' +
  '控股集团有限公司|投资集团有限公司|产业集团有限公司|发展集团有限公司|建设集团有限公司|' +
  '控股有限公司|投资有限公司|实业有限公司|发展有限公司|集团有限公司|' +
  '互联网科技|网络技术|网络科技|信息科技|信息技术|软件技术|技术服务|数据技术|智能科技|数字科技|' +
  '控股集团|投资集团|产业集团|发展集团|建设集团|实业集团|' +
  '责任公司|股份有限公司|股份公司|有限公司|分公司|总公司|办事处|事务所|代表处|' +
  '集团|控股|实业|科技|网络|信息|软件' +
  ')',
  'g'
)

/**
 * 强化去行政后缀与主体提取：覆盖全量省市、政企法律结构、行业后缀与多重嵌套括号
 */
export function cleanCompanyNameEnhanced(name: string): string {
  if (!name) return ''
  let cleaned = cleanFullText(name)
    .replace(/[(（[【][^()（）[\]【】]*?(中国|总部|研发中心|大中华区|亚太区|全球|创新中心|事业部|分部)[^()（）[\]【】]*?[)）\]】]/g, '')
    .replace(/[()（）[\]【】]/g, '')
    .replace(GEOGRAPHIC_PREFIX_SUFFIX_REGEX, '')
    .replace(CORPORATE_SUFFIX_REGEX, '')
    .trim()

  if (cleaned.length < 2) {
    cleaned = cleanFullText(name).replace(/[()（）[\]【】]/g, '').trim()
  }
  return cleaned
}

/** 提取职位核心分词关键词（支持斜杠分隔符、中英文混合、技术栈与常见职级特征词） */
export function extractTitleTokens(title: string): string[] {
  if (!title) return []
  const norm = title
    .toLowerCase()
    .replace(/[()（）[\]【】]/g, ' ')

  // 分词时注意保留诸如 node.js, vue.js, .net 等技术栈点号，按斜杠、空格、下划线、加号等切分
  const rawParts = norm.split(/[/、|·\-_+,\s]+/).filter(Boolean)
  const tokens = new Set<string>()

  const commonWords = [
    '前端', '后端', '全栈', '开发', '工程师', '架构师', '专家',
    '总监', '经理', '测试', '运维', '算法', '产品', '数据',
    '安全', '高级', '资深', '初级', '中级', '独立开发者', '独立开发',
    'web', 'react', 'vue', 'node', 'java', 'python', 'go', 'golang',
  ]

  for (const part of rawParts) {
    if (part.length >= 2) {
      tokens.add(part)
    }
    for (const cw of commonWords) {
      if (part.includes(cw)) {
        tokens.add(cw)
      }
    }
  }

  return Array.from(tokens)
}

/**
 * 去行政后缀模糊多词匹配与相似度综合评分
 * 支持以下两种调用约定：
 * 1. fuzzyMultiWordMatch(cardText, expectedTitle, expectedCompany, threshold = 0.55)
 * 2. fuzzyMultiWordMatch(targetTitle, targetCompany, cardText, cardTitle?, cardCompany?, threshold?)
 */
export function fuzzyMultiWordMatch(
  arg1: string,
  arg2: string,
  arg3: string,
  arg4?: string | number,
  arg5?: string,
  arg6?: number
): FuzzyMatchResult {
  let targetTitle = ''
  let targetCompany = ''
  let cardText = ''
  let cardTitle = ''
  let cardCompany = ''
  let threshold = 0.55

  if (typeof arg4 === 'string') {
    // 5-param signature: (targetTitle, targetCompany, cardText, cardTitle?, cardCompany?, threshold?)
    targetTitle = arg1 || ''
    targetCompany = arg2 || ''
    cardText = arg3 || ''
    cardTitle = arg4 || ''
    cardCompany = arg5 || ''
    if (typeof arg6 === 'number') threshold = arg6
  } else {
    if (typeof arg4 === 'number') {
      threshold = arg4
    }
    const norm1 = cleanFullText(arg1 || '')
    const norm2 = cleanFullText(arg2 || '')
    const norm3 = cleanFullText(arg3 || '')

    const arg1HasCardMarkers = /\d+-\d+[kK千元]|25-35|20-40|\d+k/i.test(arg1) || norm1.length > norm2.length + norm3.length
    const arg3HasCardMarkers = /\d+-\d+[kK千元]|25-35|20-40|\d+k/i.test(arg3) || norm3.length > norm1.length + norm2.length

    if (arg1HasCardMarkers || (!arg3HasCardMarkers && (norm1.includes(norm2) || norm1.includes(norm3)))) {
      cardText = arg1
      targetTitle = arg2
      targetCompany = arg3
    } else if (arg3HasCardMarkers || (norm3.includes(norm1) || norm3.includes(norm2))) {
      targetTitle = arg1
      targetCompany = arg2
      cardText = arg3
    } else {
      const core2 = cleanCompanyNameEnhanced(arg2)
      if (core2 !== cleanFullText(arg2) || /公司|科技|网络|技术/.test(arg2)) {
        targetTitle = arg1
        targetCompany = arg2
        cardText = arg3
      } else {
        cardText = arg1
        targetTitle = arg2
        targetCompany = arg3
      }
    }
  }

  const normCardText = cleanFullText(cardText + ' ' + cardTitle + ' ' + cardCompany)
  const reasons: string[] = []

  // 1. 职位名匹配度计算
  let titleScore = 0
  const expectedTokens = extractTitleTokens(targetTitle)
  if (expectedTokens.length === 0) {
    titleScore = 1.0
    reasons.push('Title is empty, default titleScore=1.0')
  } else {
    let matchedTokenCount = 0
    for (const token of expectedTokens) {
      if (normCardText.includes(token)) {
        matchedTokenCount++
      }
    }
    titleScore = matchedTokenCount / expectedTokens.length
    reasons.push(`Title tokens matched ${matchedTokenCount}/${expectedTokens.length}`)
  }

  // 2. 公司名匹配度计算
  let companyScore = 0
  if (!targetCompany) {
    companyScore = 1.0
    reasons.push('Company is empty, default companyScore=1.0')
  } else {
    const rawExpectedCompany = cleanFullText(targetCompany)
    const coreExpectedCompany = cleanCompanyNameEnhanced(targetCompany)

    if (normCardText.includes(rawExpectedCompany)) {
      companyScore = 1.0
      reasons.push(`Exact company match: "${rawExpectedCompany}"`)
    } else if (coreExpectedCompany.length >= 2 && normCardText.includes(coreExpectedCompany)) {
      companyScore = 1.0
      reasons.push(`Cleaned company match: "${coreExpectedCompany}"`)
    } else {
      const cardCompanyCore = cleanCompanyNameEnhanced(cardCompany || cardText)
      if (
        coreExpectedCompany.length >= 2 &&
        cardCompanyCore.length >= 2 &&
        (cardCompanyCore.includes(coreExpectedCompany) || coreExpectedCompany.includes(cardCompanyCore))
      ) {
        companyScore = 0.85
        reasons.push(`Bidirectional core company overlap: "${coreExpectedCompany}" ~ "${cardCompanyCore}"`)
      } else {
        companyScore = 0.0
        reasons.push(`Company mismatch: expected "${coreExpectedCompany}"`)
      }
    }
  }

  // 3. 综合评分加权（0.55 * Stitle + 0.45 * Scompany，若公司明确不匹配则严惩）
  let compositeScore = 0
  if (targetCompany && companyScore === 0) {
    compositeScore = titleScore * 0.3
  } else if (!targetCompany) {
    compositeScore = titleScore
  } else {
    compositeScore = titleScore * 0.55 + companyScore * 0.45
  }

  const matched = compositeScore >= threshold
  return {
    matched,
    score: parseFloat(compositeScore.toFixed(3)),
    titleScore: parseFloat(titleScore.toFixed(3)),
    companyScore: parseFloat(companyScore.toFixed(3)),
    reasons,
  }
}

function getDetailContainers(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(
    '.job-detail-box, .job-detail-container, .job-detail-content, .job-detail-wrapper, [class*="job-detail"], [class*="detail-box"], #main, .main-container'
  )).filter((c) => c.offsetWidth > 0 || c.offsetHeight > 0 || c.getClientRects().length > 0)
}

export function checkDetailPanelOffline(root: HTMLElement): boolean {
  const text = root.innerText || root.textContent || ''
  return (
    text.includes('该职位已关闭') ||
    text.includes('职位已关闭') ||
    text.includes('该职位已停止招聘') ||
    text.includes('停止招聘') ||
    text.includes('已停止招聘') ||
    text.includes('该职位已下线') ||
    text.includes('职位已下线') ||
    text.includes('职位已下架') ||
    text.includes('已下架') ||
    text.includes('已暂停招聘') ||
    text.includes('该职位已暂停沟通') ||
    text.includes('停止接受新沟通') ||
    !!root.querySelector('.job-status-closed, [class*="closed"], [class*="offline"], .btn-disabled, [class*="disabled"]')
  )
}

function findMatchingDetailPanel(
  normTitle: string,
  coreTitle: string,
  normCompany: string,
  expectedTitle = '',
  expectedCompany = '',
): HTMLElement | null {
  const containers = getDetailContainers()

  // 1. 优先从详情外层容器中校验
  for (const c of containers) {
    const text = c.innerText || c.textContent || ''
    const titleHit = isTitleMatch(text, expectedTitle)
    const companyHit = !expectedCompany || isCompanyMatch(text, expectedCompany)

    const hasApply =
      findApplyButtons(c).length > 0 ||
      !!c.querySelector(APPLY_SELECTOR) ||
      !!c.querySelector('.btn-startchat, [class*="startchat"], [class*="btn-chat"]') ||
      text.includes('立即沟通') ||
      text.includes('继续沟通')

    if (titleHit) {
      if (checkDetailPanelOffline(c)) {
        c.setAttribute('data-job-offline', 'true')
        return c
      }
      if (companyHit && hasApply) {
        return c
      }
    }
  }

  // 2. 遍历所有沟通按钮所在容器
  const actions = findApplyButtons(document)
  for (const action of actions) {
    const root = getActionRoot(action)
    const text = root.innerText || root.textContent || ''
    const titleHit = isTitleMatch(text, expectedTitle)
    const companyHit = !expectedCompany || isCompanyMatch(text, expectedCompany)
    if (titleHit && (companyHit || !expectedCompany)) {
      return root
    }
  }

  // 3. 兜底：若标题强匹配，只要包含沟通按钮或职位描述特征即可认定为对应详情
  for (const c of containers) {
    const text = c.innerText || c.textContent || ''
    const hasApply =
      findApplyButtons(c).length > 0 ||
      !!c.querySelector(APPLY_SELECTOR) ||
      !!c.querySelector('.btn-startchat, [class*="startchat"]') ||
      text.includes('立即沟通') ||
      text.includes('继续沟通')
    if (isTitleMatch(text, expectedTitle)) {
      if (checkDetailPanelOffline(c)) {
        c.setAttribute('data-job-offline', 'true')
        return c
      }
      if (hasApply || text.includes('职位描述') || text.includes('岗位职责')) {
        return c
      }
    }
  }

  return null
}

function findAnyActiveDetail(): HTMLElement | null {
  const containers = getDetailContainers()
  for (const c of containers) {
    if (checkDetailPanelOffline(c)) {
      c.setAttribute('data-job-offline', 'true')
      return c
    }
    const text = c.innerText || c.textContent || ''
    if (
      (text.includes('职位描述') || text.includes('岗位职责') || text.includes('任职要求')) &&
      (findApplyButtons(c).length > 0 || text.includes('立即沟通') || text.includes('继续沟通'))
    ) {
      return c
    }
  }

  const actions = findApplyButtons(document)
  for (const action of actions) {
    const root = getActionRoot(action)
    const text = root.innerText || root.textContent || ''
    if (
      text.includes('职位描述') ||
      text.includes('岗位职责') ||
      text.includes('任职要求') ||
      text.includes('立即沟通') ||
      text.includes('继续沟通')
    ) {
      return root
    }
  }
  return null
}

export async function activateJobCard(
  jobUrl: string,
  jobId: string,
  expectedTitle = '',
  expectedCompany = '',
): Promise<HTMLElement | null> {
  const normTitle = cleanFullText(expectedTitle)
  const coreTitle = cleanTitle(expectedTitle)
  const normCompany = cleanFullText(expectedCompany)

  // 0. 特殊情况：若当前页面本身就是独立详情页（/job_detail/xxx.html）
  if (
    typeof window !== 'undefined' &&
    (window.location.href.includes('/job_detail/') || window.location.href.includes('job-detail'))
  ) {
    const pageText = document.body.innerText || document.body.textContent || ''
    const tHit = !expectedTitle || isTitleMatch(pageText, expectedTitle)
    const cHit = !expectedCompany || isCompanyMatch(pageText, expectedCompany)
    if (tHit || cHit) {
      const detailContainer = document.querySelector<HTMLElement>(
        '.job-detail-box, .job-detail-container, .job-detail-content, .job-detail-wrapper, [class*="job-detail"], #main, .main-container',
      ) || document.body
      if (checkDetailPanelOffline(detailContainer)) {
        detailContainer.setAttribute('data-job-offline', 'true')
      }
      return detailContainer
    }
  }

  // 1. 如果当前右侧详情面板已展示此岗位且有立即沟通按钮或已下线，直接复用
  const existingDetail = findMatchingDetailPanel(normTitle, coreTitle, normCompany, expectedTitle, expectedCompany)
  if (existingDetail) {
    return existingDetail
  }

  // 2. 在左侧列表中定位目标卡片（支持双向微滚、自适应顶底复位，解决虚拟列表下卡片被回收问题）
  let cardEl: HTMLElement | null = null
  let titleLink: HTMLAnchorElement | null = null

  const getScrollContainer = (): HTMLElement | null => {
    return document.querySelector<HTMLElement>(
      '.job-list-box, .recommend-list, [class*="job-list"], [class*="result-list"], [class*="geek-list"], ul.job-list-box, .rec-job-list'
    )
  }

  const findCardInDom = (): { card: HTMLElement | null; link: HTMLAnchorElement | null } => {
    try {
      // 策略 A: URL / JobId 查找 (含 data- 属性)
      const candidateLinks = Array.from(document.querySelectorAll<HTMLAnchorElement>(
        'a[href*="job_detail"], a[ka*="job"], [class*="job-card"] a, a[class*="job-name"], .job-card-box a'
      ))
      for (const link of candidateLinks) {
        try {
          const href = link.getAttribute('href') || (link as unknown as { href?: string }).href || ''
          if (jobId && href && href.includes(jobId)) {
            const foundCard = (link.closest('li.job-card-box, .job-card-wrapper, .recommend-job-card, li, [class*="job-card"]') || link) as HTMLElement
            return { card: foundCard, link }
          }
          if (jobUrl && href) {
            const baseOrigin = typeof window !== 'undefined' && window.location.origin ? window.location.origin : 'https://www.zhipin.com'
            const linkPath = new URL(href, baseOrigin).pathname
            const targetPath = new URL(jobUrl, baseOrigin).pathname
            if (linkPath === targetPath) {
              const foundCard = (link.closest('li.job-card-box, .job-card-wrapper, .recommend-job-card, li, [class*="job-card"]') || link) as HTMLElement
              return { card: foundCard, link }
            }
          }
        } catch {
          // ignore parsing error
        }
      }

      // 尝试 data-jobid / data-jid 属性定位
      if (jobId) {
        const dataCard = document.querySelector<HTMLElement>(`[data-jobid*="${jobId}"], [data-jid*="${jobId}"], [data-itemid*="${jobId}"]`)
        if (dataCard) {
          const link = dataCard.querySelector<HTMLAnchorElement>('a[href*="job_detail"], a[class*="job-name"], a[class*="title"]')
          return { card: dataCard, link }
        }
      }

      // 策略 B: 标题 + 公司分级模糊匹配
      const allCards = Array.from(document.querySelectorAll<HTMLElement>(
        'li.job-card-box, .job-card-wrapper, .recommend-job-card, .job-list-box > li, [class*="job-card"], [class*="jobCard"]'
      ))

      let fallbackCard: HTMLElement | null = null
      let fallbackLink: HTMLAnchorElement | null = null

      for (const el of allCards) {
        const elText = el.innerText || el.textContent || ''
        const titleHit = isTitleMatch(elText, expectedTitle)
        const companyHit = expectedCompany ? isCompanyMatch(elText, expectedCompany) : true

        if (titleHit && companyHit) {
          const link = el.querySelector<HTMLAnchorElement>('a[href*="job_detail"], a[class*="job-name"], a[class*="title"]')
          return { card: el, link }
        }

        // 如果标题强匹配，仅在未指定 expectedCompany 或公司名匹配时才作为保底候选
        // 严禁在预期公司不匹配时返回 fallbackCard，防止跨公司误点击误投递
        if (titleHit && (!expectedCompany || companyHit) && !fallbackCard) {
          fallbackCard = el
          fallbackLink = el.querySelector<HTMLAnchorElement>('a[href*="job_detail"], a[class*="job-name"], a[class*="title"]')
        }
      }

      if (fallbackCard && (!expectedCompany || isCompanyMatch(fallbackCard.innerText || fallbackCard.textContent || '', expectedCompany))) {
        return { card: fallbackCard, link: fallbackLink }
      }

      return { card: null, link: null }
    } catch {
      return { card: null, link: null }
    }
  }

  // 首次快速探测当前视口 DOM
  const initial = findCardInDom()
  if (initial.card) {
    cardEl = initial.card
    titleLink = initial.link
  } else {
    // 关键优化：若当前视口未命中，极可能是之前采集滚动到底部导致首屏顶部卡片被虚拟列表回收！
    // 立即复位回顶部重新扫描
    const scrollContainer = getScrollContainer()
    if (scrollContainer && scrollContainer.scrollTop > 50) {
      scrollContainer.scrollTop = 0
      scrollContainer.dispatchEvent(new Event('scroll', { bubbles: true }))
    }
    if (window.scrollY > 50) {
      window.scrollTo(0, 0)
      window.dispatchEvent(new Event('scroll'))
    }
    await new Promise((r) => setTimeout(r, 250))

    // 顶部复位后重新寻找
    const topScan = findCardInDom()
    if (topScan.card) {
      cardEl = topScan.card
      titleLink = topScan.link
    } else {
      // 循序向下滚动扫描（从顶部向底部逐步步进，兼顾虚拟列表按需挂载）
      for (let attempt = 0; attempt < 8; attempt++) {
        if (scrollContainer && scrollContainer.scrollHeight > scrollContainer.clientHeight) {
          scrollContainer.scrollTop += 450
          scrollContainer.dispatchEvent(new Event('scroll', { bubbles: true }))
        }
        window.scrollBy(0, 400)
        await new Promise((r) => setTimeout(r, 200))

        const stepScan = findCardInDom()
        if (stepScan.card) {
          cardEl = stepScan.card
          titleLink = stepScan.link
          break
        }
      }
    }
  }

  if (!cardEl && !titleLink) {
    return null
  }

  const target = cardEl || titleLink!

  // 3. 滚动卡片居中可视
  target.scrollIntoView({ behavior: 'smooth', block: 'center' })
  await new Promise((r) => setTimeout(r, 200))

  // 4. 清理 target="_blank"，优先点击卡片内部的交互区域（如 .job-card-left / .job-card-body）
  if (titleLink && titleLink.getAttribute('target') === '_blank') {
    titleLink.removeAttribute('target')
  }

  const clickTarget =
    cardEl?.querySelector<HTMLElement>(
      '.job-card-left, .job-card-body, .job-title, [class*="job-name"], [class*="job-info"]'
    ) || target

  const evtOpts = { bubbles: true, cancelable: true, view: window }
  try {
    clickTarget.dispatchEvent(new PointerEvent('pointerdown', evtOpts))
    clickTarget.dispatchEvent(new MouseEvent('mousedown', evtOpts))
    clickTarget.dispatchEvent(new PointerEvent('pointerup', evtOpts))
    clickTarget.dispatchEvent(new MouseEvent('mouseup', evtOpts))
  } catch { /* 预期内异常，安全忽略 */ }
  clickTarget.click()

  // 5. 循环等待详情面板展开与更新（增加下线状态识别）
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    const detail = findMatchingDetailPanel(normTitle, coreTitle, normCompany, expectedTitle, expectedCompany)
    if (detail) return detail
    await new Promise((resolve) => setTimeout(resolve, 150))
  }

  // 兜底：如果右侧有任意详情面板或下线提示，直接返回
  const anyDetail = findAnyActiveDetail()
  if (anyDetail) return anyDetail

  return cardEl || titleLink || null
}

/**
 * 多阶弹性卡片激活兜底机制：
 * Tier 0: 独立 URL 详情页直接识别
 * Tier 1: 常规视口定位（ID/URL/属性/滚动扫描）
 * Tier 2: 去行政后缀模糊多词匹配 (Fuzzy Multi-Word)
 * Tier 3: 独立 URL 详情页静默直达投递
 */
export async function activateJobCardWithFallback(
  jobUrl: string,
  jobId: string,
  expectedTitle = '',
  expectedCompany = '',
  options: ActivateCardFallbackOptions = {}
): Promise<HTMLElement | null> {
  const threshold = options.fuzzyThreshold ?? 0.55
  const maxWait = options.maxDetailWaitMs ?? 4000

  // ─── Tier 0: 检查当前页面是否已是独立详情页 ───
  if (
    typeof window !== 'undefined' &&
    (window.location.href.includes('/job_detail/') || window.location.href.includes('job-detail'))
  ) {
    const pageText = document.body.innerText || document.body.textContent || ''
    const match = fuzzyMultiWordMatch(pageText, expectedTitle, expectedCompany, 0.4)
    if (match.matched || !expectedTitle) {
      const container = document.querySelector<HTMLElement>(
        '.job-detail-box, .job-detail-container, .job-detail-content, .job-detail-wrapper, [class*="job-detail"], #main, .main-container'
      ) || document.body
      if (checkDetailPanelOffline(container)) {
        container.setAttribute('data-job-offline', 'true')
      }
      return container
    }
  }

  // ─── Tier 1: 常规定位器探测 ───
  try {
    const conventionalResult = await activateJobCard(jobUrl, jobId, expectedTitle, expectedCompany)
    if (conventionalResult) {
      return conventionalResult
    }
  } catch {
    // Tier 1 抛出任何 DOM 或匹配异常时，优雅降级至 Tier 2 与 Tier 3
  }

  // ─── Tier 2: 去行政后缀模糊多词匹配 (Fuzzy Multi-Word) ───
  const allCards = Array.from(
    document.querySelectorAll<HTMLElement>(
      'li.job-card-box, .job-card-wrapper, .recommend-job-card, .job-list-box > li, [class*="job-card"], [class*="jobCard"]'
    )
  )

  let bestCard: HTMLElement | null = null
  let bestScore = 0
  let bestResult: FuzzyMatchResult | null = null

  for (const card of allCards) {
    const text = card.innerText || card.textContent || ''
    const fMatch = fuzzyMultiWordMatch(text, expectedTitle, expectedCompany, threshold)
    if (fMatch.matched && fMatch.score > bestScore) {
      bestScore = fMatch.score
      bestCard = card
      bestResult = fMatch
    }
  }

  if (bestCard && bestResult) {
    // 滚动居中并点击激活
    bestCard.scrollIntoView({ behavior: 'smooth', block: 'center' })
    await new Promise((r) => setTimeout(r, 100))

    const link = bestCard.querySelector<HTMLAnchorElement>('a[href*="job_detail"], a[class*="job-name"], a[class*="title"]')
    if (link && link.getAttribute('target') === '_blank') {
      link.removeAttribute('target')
    }

    const clickTarget =
      bestCard.querySelector<HTMLElement>(
        '.job-card-left, .job-card-body, .job-title, [class*="job-name"], [class*="job-info"]'
      ) || bestCard

    const evtOpts = { bubbles: true, cancelable: true, view: window }
    try {
      clickTarget.dispatchEvent(new PointerEvent('pointerdown', evtOpts))
      clickTarget.dispatchEvent(new MouseEvent('mousedown', evtOpts))
      clickTarget.dispatchEvent(new PointerEvent('pointerup', evtOpts))
      clickTarget.dispatchEvent(new MouseEvent('mouseup', evtOpts))
    } catch { /* 预期内异常，安全忽略 */ }
    clickTarget.click()

    // 记录自愈审计事件
    await recordSelfHealingEvent({
      source: 'self-healing.card_fallback.boss',
      message: `[Self-Healing] activate_job_card: Conventional locator failed -> Activated via fuzzyMultiWordMatch (score: ${bestScore})`,
      context: JSON.stringify({
        category: 'card_fallback',
        action: 'activate_job_card',
        mitigation: `Fuzzy multi-word match (score: ${bestScore})`,
        jobId,
        expectedTitle,
        expectedCompany,
        score: bestScore,
      }),
    })

    // M4 埋点 · Tier 2：常规定位失败，去行政后缀模糊多词命中
    void recordDiagnosticEvent({
      platform: 'boss',
      category: 'card_not_found',
      triggerDescription: `常规卡片定位器未命中岗位 ${expectedTitle} @ ${expectedCompany}`,
      bypassPath: 'fuzzy_multi_word_match',
      failedSelector: 'li.job-card-box, .job-card-wrapper, [class*="job-card"]',
      jobTitle: expectedTitle,
      success: true,
    }).catch(() => {})

    // 等待详情面板渲染
    const deadline = Date.now() + maxWait
    while (Date.now() < deadline) {
      const detail = findMatchingDetailPanel(
        cleanFullText(expectedTitle),
        cleanTitle(expectedTitle),
        cleanCompanyNameEnhanced(expectedCompany),
        expectedTitle,
        expectedCompany
      )
      if (detail) return detail
      await new Promise((r) => setTimeout(r, 100))
    }

    const anyDetail = findAnyActiveDetail()
    if (anyDetail) return anyDetail

    return bestCard
  }

  // ─── Tier 3: 独立 URL 详情页后台静默跳转直达投递 ───
  if (options.allowDirectUrl !== false && jobUrl) {
    try {
      // 校验 URL 有效性：基于 window.location.origin 解析，防止相对路径继承当前页面 /job_detail/ 导致污染
      const baseOrigin = typeof window !== 'undefined' && window.location.origin ? window.location.origin : 'https://www.zhipin.com'
      const parsedUrl = new URL(jobUrl, baseOrigin)
      const isDetailPath = (parsedUrl.pathname.includes('job_detail') || parsedUrl.pathname.startsWith('/job/')) && !parsedUrl.pathname.includes('/geek/job')
      if (isDetailPath) {
        // 记录 Tier 3 自愈事件
        await recordSelfHealingEvent({
          source: 'self-healing.card_fallback.boss',
          message: `[Self-Healing] activate_job_card: Viewport list locator and fuzzy match failed -> Silent direct URL fallback: ${parsedUrl.pathname}`,
          context: JSON.stringify({
            category: 'card_fallback',
            action: 'activate_job_card',
            mitigation: `Direct URL fallback: ${parsedUrl.href}`,
            jobUrl,
            jobId,
            expectedTitle,
            expectedCompany,
          }),
        })

        // M4 埋点 · Tier 3：模糊分词也失败，独立 URL 详情页静默直达
        void recordDiagnosticEvent({
          platform: 'boss',
          category: 'card_not_found',
          triggerDescription: `视口列表定位与模糊分词均未命中 ${expectedTitle} @ ${expectedCompany}`,
          bypassPath: 'direct_url_silent_navigation',
          jobTitle: expectedTitle,
          success: true,
        }).catch(() => {})

        // 模拟/执行 URL 静默导航至详情页
        if (typeof window !== 'undefined') {
          if (window.history?.pushState) {
            window.history.pushState({}, '', parsedUrl.pathname)
          }
          const detailContainer = document.querySelector<HTMLElement>(
            '.job-detail-box, .job-detail-container, .job-detail-content, .job-detail-wrapper, [class*="job-detail"], #main, .main-container'
          ) || document.body
          if (checkDetailPanelOffline(detailContainer)) {
            detailContainer.setAttribute('data-job-offline', 'true')
          }
          return detailContainer
        }
      }
    } catch {
      // 忽略畸形 URL
    }
  }

  return null
}

export async function navigateToNextPage(): Promise<boolean> {
  const nextButton = document.querySelector(
    '[class*="next"], [class*="page-next"], .next-page, button:last-child[class*="page"]'
  ) as HTMLElement | null

  if (nextButton && !nextButton.classList.contains('disabled') && !nextButton.hasAttribute('disabled')) {
    await randomDelay(1000, 3000)
    nextButton.click()
    return true
  }

  // Alternative: click page numbers
  const currentActive = document.querySelector('[class*="active"][class*="page"]')
  if (currentActive) {
    const nextSibling = currentActive.nextElementSibling as HTMLElement | null
    if (nextSibling && nextSibling.textContent?.match(/^\d+$/)) {
      await randomDelay(1000, 3000)
      nextSibling.click()
      return true
    }
  }

  return false
}

function jobKey(job: JobCard): string {
  return job.id || job.url || `${job.companyName}:${job.title}`
}

export async function collectJobCards(
  readCurrentCards: () => JobCard[],
  options?: CollectOptions & {
    stableRounds?: number
  },
): Promise<JobCard[]> {
  const maxJobs = options?.maxJobs ?? Infinity
  const requiredStableRounds = options?.stableRounds ?? 5
  const shouldCancel = options?.shouldCancel
  const jobs = new Map<string, JobCard>()
  let unchangedRounds = 0

  const collectCurrent = () => {
    const before = jobs.size
    for (const job of readCurrentCards()) {
      const key = jobKey(job)
      // 若已被排除（已在任务队列中），跳过以便继续向下滚动采集全新岗位
      if (
        options?.excludeJobIds?.has(key) ||
        options?.excludeJobIds?.has(job.id) ||
        options?.excludeJobIds?.has(`boss:${job.id}`) ||
        options?.excludeJobIds?.has(`${job.companyName}:${job.title}`) ||
        options?.excludeJobIds?.has(`boss:${job.companyName}:${job.title}`)
      ) {
        continue
      }
      jobs.set(key, job)
      if (jobs.size >= maxJobs) break
    }
    if (jobs.size !== before) options?.onCountChange?.(jobs.size)
    return jobs.size !== before
  }

  // Scroll every candidate scroll container AND the window to the very bottom,
  // then dispatch scroll events. This reliably triggers the page's
  // infinite-scroll / lazy-loading so more job cards get rendered.
  const scrollToBottom = () => {
    const containers = Array.from(document.querySelectorAll<HTMLElement>(
      '.job-list-box, [class*="job-list"], [class*="result-list"], .recommend-list, [class*="job-board"], [class*="rec-job"], [class*="geek-list"]',
    )).filter((c) => c.scrollHeight > c.clientHeight + 8)

    for (const c of containers) {
      c.scrollTop = c.scrollHeight
      c.dispatchEvent(new Event('scroll', { bubbles: true }))
    }
    // Fallback: many feeds listen on the document/window scroll.
    window.scrollTo(0, document.documentElement.scrollHeight)
    window.dispatchEvent(new Event('scroll', { bubbles: true }))
  }

  collectCurrent()
  while (jobs.size < maxJobs && unchangedRounds < requiredStableRounds) {
    if (shouldCancel?.()) break
    scrollToBottom()
    // Give the feed enough time to fetch & render the next batch of cards.
    await randomDelay(1200, 2000)
    if (shouldCancel?.()) break
    unchangedRounds = collectCurrent() ? 0 : unchangedRounds + 1
  }

  return Array.from(jobs.values())
}

function isVisible(element: Element): boolean {
  const style = window.getComputedStyle(element)
  return style.display !== 'none'
    && style.visibility !== 'hidden'
    && style.opacity !== '0'
}

export function snapshotCommunicationUi(): CommunicationUiSnapshot {
  return {
    inputs: new Set(document.querySelectorAll(GREETING_INPUT_SELECTOR)),
    visibleDialogs: new Set(
      Array.from(document.querySelectorAll(COMMUNICATION_DIALOG_SELECTOR))
        .filter(isVisible),
    ),
  }
}

async function closeGreetingDialog(dialog: Element): Promise<boolean> {
  if (!dialog.isConnected) return true

  const closeSelector = [
    '[aria-label*="关闭"]',
    '[aria-label="Close"]',
    '[title*="关闭"]',
    '[class*="dialog-close"]',
    '[class*="modal-close"]',
    '[class*="popup-close"]',
    '[class*="icon-close"]',
    'button[class*="close"]',
  ].join(', ')
  const closeButton = (
    dialog.querySelector(closeSelector)
    || Array.from(dialog.querySelectorAll<HTMLElement>('button, [role="button"], i, span'))
      .find((candidate) => ['×', '✕', '✖'].includes(candidate.textContent?.trim() || ''))
  ) as HTMLElement | null

  if (closeButton) {
    await randomDelay(200, 500)
    closeButton.click()
    return true
  }
  return false
}

export async function fillGreetingMessage(
  message: string,
  snapshot: CommunicationUiSnapshot = {
    inputs: new Set(),
    visibleDialogs: new Set(),
  },
): Promise<boolean> {
  // Wait for either a greeting editor or a standalone communication modal.
  const deadline = Date.now() + 5000
  let textarea: HTMLTextAreaElement | null = null
  while (Date.now() < deadline && !textarea) {
    const candidates = Array.from(
      document.querySelectorAll<HTMLTextAreaElement>(GREETING_INPUT_SELECTOR),
    )
    textarea = candidates.reverse().find((candidate) => !snapshot.inputs.has(candidate)) || null
    if (textarea) break

    const newDialogs = Array.from(
      document.querySelectorAll(COMMUNICATION_DIALOG_SELECTOR),
    ).filter((dialog) => isVisible(dialog) && !snapshot.visibleDialogs.has(dialog))
    for (const dialog of newDialogs.reverse()) {
      // Close pre-existing dialogs (stale from previous interactions) so
      // they don't block the greeting flow, but do NOT return true — we
      // haven't sent a greeting yet. Continue waiting for the textarea.
      await closeGreetingDialog(dialog)
      // Don't return — continue the while loop to find the textarea
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }

  if (textarea) {
    textarea.value = message
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    textarea.dispatchEvent(new Event('change', { bubbles: true }))
    await randomDelay(300, 800)

    // Find and click send button
    const dialog = textarea.closest(
      `${COMMUNICATION_DIALOG_SELECTOR}, [class*="popover"], [class*="greeting"]`,
    ) || textarea.parentElement || document.body
    const sendBtn = dialog.querySelector(
      '[class*="send"], button[type="submit"], [class*="submit"]'
    ) as HTMLElement | null

    if (sendBtn) {
      await randomDelay(500, 1500)
      sendBtn.click()
      if (dialog !== document.body) await closeGreetingDialog(dialog)
      return true
    }
  }

  return false
}

export function getJobSpecificGreeting(
  resumeName: string,
  job: JobCard,
  match: MatchResult,
): string {
  const relevantSkills = match.skillMatch
    .filter(Boolean)
    .slice(0, 3)
    .join('、')
  const experience = relevantSkills
    ? `我有${relevantSkills}相关经验，`
    : '我的经历与该岗位方向较匹配，'
  return `您好，我是${resumeName}，看到${job.companyName}正在招聘“${job.title}”。${experience}希望能进一步沟通。`
}

// ─── 聊天页操作（/web/geek/chat）───

export interface ChatContact {
  id: string
  name: string
  company: string
  element: HTMLElement
}

/** 获取聊天页左侧联系人列表 */
export function getChatContacts(): ChatContact[] {
  const contacts: ChatContact[] = []

  // Boss 聊天页联系人容器：DIV.chat-user.v2
  const container = document.querySelector('[class*="chat-user"]')
  if (!container) return contacts

  // 联系人项是容器内的直接子 DIV
  const items = container.querySelectorAll(':scope > div, :scope > a, :scope > li')
  items.forEach((el, i) => {
    const text = (el.textContent || '').trim()
    if (!text || text.length < 5) return

    // 排除非联系人的 UI 元素（过滤栏、标签页等）
    const excludeWords = ['全部未读', '全部', '未读', '新招呼', '仅沟通', '有交换', '有面试', '不感兴趣', 'AI筛选', '提交', '更多', '已读', '筛选']
    if (excludeWords.some(w => text.startsWith(w) || text === w)) return

    // 必须有时间戳格式（HH:MM）或名称格式才是联系人
    const hasTime = /\d{1,2}:\d{2}/.test(text.slice(0, 6))
    if (!hasTime && text.length < 15) return

    // 提取名称（时间戳后面的中文字符）
    const cleanText = text.replace(/^\d{1,2}:\d{2}/, '').trim()
    const nameMatch = cleanText.match(/^([一-龥]{2,4})/)
    const name = nameMatch ? nameMatch[1] : cleanText.slice(0, 5)
    const company = cleanText.slice(name.length, name.length + 15).trim()

    contacts.push({
      id: el.getAttribute('data-id') || el.getAttribute('data-uid') || `chat-${i}`,
      name,
      company,
      element: el as HTMLElement,
    })
  })

  return contacts
}

/** 点击联系人打开对话 */
export async function clickContact(contact: ChatContact): Promise<boolean> {
  contact.element.scrollIntoView({ behavior: 'smooth', block: 'center' })
  await new Promise((r) => setTimeout(r, 600))

  // 尝试多种点击方式
  const el = contact.element
  el.click()
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
  el.dispatchEvent(new PointerEvent('click', { bubbles: true, cancelable: true, view: window }))

  // 也尝试点击元素内的第一个链接或可交互子元素
  const inner = el.querySelector('a, button, [class*="name"], [class*="title"]') as HTMLElement | null
  if (inner) {
    inner.click()
    inner.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
  }

  await new Promise((r) => setTimeout(r, 1000))
  return true
}

/**
 * 检查当前对话是否已发过简历。
 * 在聊天记录中搜索已发送标记文本。
 */
export function hasResumeSentInChat(): boolean {
  const markers = ['附件简历请求已发送', '简历已发送', '已发送简历', '附件简历已投递', '简历请求已发送']
  const chatArea = document.querySelector('[class*="chat-content"], [class*="chat-message"], [class*="message-list"], [class*="chat-dialog"]')
  const body = (chatArea?.textContent || document.body.textContent || '')
  return markers.some((m) => body.includes(m))
}

/** 在对话工具栏中找「发简历」按钮并点击 */
export async function clickSendResume(): Promise<boolean> {
  await new Promise((r) => setTimeout(r, 1000))

  // 只搜 button，且文本精确等于「发简历」
  let btn: HTMLElement | null = null
  const allBtnTexts: string[] = []
  for (const b of document.querySelectorAll<HTMLElement>('button')) {
    const t = (b.textContent || '').trim()
    if (t.length >= 2 && t.length <= 15) allBtnTexts.push(t)
    if (t === '发简历') { btn = b; break }
  }
  console.log('[clickSendResume] All buttons:', allBtnTexts.join(', '))
  console.log('[clickSendResume] Found btn:', btn ? (btn.textContent || '').trim() : 'NULL')

  if (!btn) return false

  btn.scrollIntoView({ block: 'center' })
  await new Promise((r) => setTimeout(r, 300))
  btn.click()
  await new Promise((r) => setTimeout(r, 1500))
  return true
}

/** 在简历弹窗中选简历并点发送 */
export async function selectAndSendResume(): Promise<boolean> {
  // 等待弹窗出现
  await new Promise((r) => setTimeout(r, 1000))

  // 收集弹窗内所有按钮文字供调试
  const allBtns = document.querySelectorAll('button, [role="button"], [class*="btn"]')
  const btnList = Array.from(allBtns).map(b => (b.textContent || '').trim()).filter(t => t.length >= 2 && t.length <= 10).join(',')
  console.log('[selectAndSendResume] Buttons in dialog:', btnList || 'none')

  // 找并点击「发送」或「确定」按钮
  const keywords = ['发送', '确定', '确认发送', '立刻投递', '立即投递', '投递']
  let sendBtn: HTMLElement | null = null

  // 优先在弹窗/modal 内搜索
  const dialog = document.querySelector('[class*="dialog"], [class*="modal"], [class*="drawer"], [class*="popup"], .dialog-wrap')
  const root = (dialog as ParentNode) || document
  const all = root.querySelectorAll<HTMLElement>('button, span, a, div')
  for (const el of all) {
    const text = (el.textContent || '').trim()
    if (keywords.includes(text)) {
      sendBtn = el.closest('button') as HTMLElement | null || el
      break
    }
  }

  // 全局兜底
  if (!sendBtn) {
    for (const el of document.querySelectorAll<HTMLElement>('button')) {
      if (keywords.includes((el.textContent || '').trim())) {
        sendBtn = el; break
      }
    }
  }

  if (!sendBtn) return false

  sendBtn.click()
  await new Promise((r) => setTimeout(r, 1500))
  return true
}

/** 关闭详情侧边面板（非推荐岗位释放资源，并清理意外遮罩） */
export async function closeDetailPanel(): Promise<void> {
  dismissUnexpectedModals()

  // Boss 详情面板关闭方式多样：点 X 按钮 / 点遮罩 / ESC
  const closeBtn = document.querySelector(
    '.job-detail-container [class*="close"], .job-detail-box [class*="close"], [class*="detail-close"]'
  ) as HTMLElement | null
  if (closeBtn && closeBtn.offsetParent !== null) {
    closeBtn.click()
    await new Promise((r) => setTimeout(r, 300))
    dismissUnexpectedModals()
    return
  }
  // 兜底：ESC
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  await new Promise((r) => setTimeout(r, 300))
  dismissUnexpectedModals()
}

/** 从 Boss 聊天会话中提取最后一条由对方（HR/面试官）发出的提问或消息 */
export function getLastHrMessageFromChat(): {
  text: string
  sender?: string
  time?: string
} | null {
  // Boss 直聘聊天面板消息项选择器：通常由 .item-friend / [class*="friend"] 标识对方消息
  const chatMessages = Array.from(
    document.querySelectorAll<HTMLElement>(
      '.chat-message .item-friend, [class*="message-list"] [class*="friend"], [class*="chat-item"][class*="friend"], .chat-record .item-friend',
    ),
  )

  if (chatMessages.length === 0) {
    const allItems = Array.from(
      document.querySelectorAll<HTMLElement>(
        '.chat-message [class*="item"], [class*="message-item"], [class*="chat-record"] > div',
      ),
    )
    for (let i = allItems.length - 1; i >= 0; i--) {
      const el = allItems[i]
      const cls = (el.className || '').toLowerCase()
      if (!cls.includes('myself') && !cls.includes('system') && !cls.includes('time')) {
        chatMessages.push(el)
        break
      }
    }
  }

  if (chatMessages.length === 0) return null
  const lastItem = chatMessages[chatMessages.length - 1]

  const textEl =
    lastItem.querySelector<HTMLElement>(
      '.text, [class*="text"], .chat-text, [class*="message-content"]',
    ) || lastItem
  const rawText = (textEl.textContent || '').replace(/\s+/g, ' ').trim()
  if (!rawText) return null

  const nameEl = lastItem.querySelector<HTMLElement>('[class*="name"]')
  const timeEl = lastItem.querySelector<HTMLElement>('[class*="time"]')

  return {
    text: rawText,
    sender: nameEl?.textContent?.trim() || 'HR',
    time: timeEl?.textContent?.trim(),
  }
}

/** 将生成的建议话术自动填入聊天输入框，并支持模拟点击发送 */
export async function fillChatInputAndSend(
  text: string,
  sendImmediately = false,
): Promise<boolean> {
  const inputEl = document.querySelector<HTMLElement>(
    '#chat-input, [contenteditable="true"], .chat-input, textarea[class*="input"], [class*="chat-input"] [contenteditable]',
  )

  if (!inputEl) {
    console.warn('[fillChatInputAndSend] Chat input not found')
    return false
  }

  inputEl.scrollIntoView({ block: 'center' })
  inputEl.focus()
  await new Promise((r) => setTimeout(r, 100))

  if (inputEl.isContentEditable) {
    inputEl.innerHTML = ''
    document.execCommand('insertText', false, text)
    inputEl.dispatchEvent(new Event('input', { bubbles: true }))
    inputEl.dispatchEvent(new Event('change', { bubbles: true }))
  } else {
    ;(inputEl as HTMLInputElement | HTMLTextAreaElement).value = text
    inputEl.dispatchEvent(new Event('input', { bubbles: true }))
    inputEl.dispatchEvent(new Event('change', { bubbles: true }))
  }

  await new Promise((r) => setTimeout(r, 200))

  if (sendImmediately) {
    const sendBtn = document.querySelector<HTMLElement>(
      'button.btn-send, [class*="btn-send"], button[class*="send"], [class*="op-btn-send"], button:has-text("发送")',
    )
    if (sendBtn && sendBtn.offsetParent !== null) {
      sendBtn.click()
    } else {
      inputEl.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          code: 'Enter',
          keyCode: 13,
          bubbles: true,
        }),
      )
    }
  }

  return true
}

/** 关闭当前弹窗 */
export async function closeChatDialog(): Promise<void> {
  const closeSelectors = [
    '[class*="dialog"] [class*="close"]',
    '[class*="modal"] [class*="close"]',
    '.dialog-container [class*="close"]',
    '[class*="dialog"] .icon-close',
    '.ant-modal-close',
  ]
  for (const sel of closeSelectors) {
    const btn = document.querySelector(sel) as HTMLElement | null
    if (btn && btn.offsetParent !== null) {
      btn.click()
      await new Promise((r) => setTimeout(r, 300))
      return
    }
  }
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  await new Promise((r) => setTimeout(r, 300))
}

