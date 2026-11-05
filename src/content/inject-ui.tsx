// 网页右侧整高侧栏（正文为内嵌的完整助手面板）+ 半圆浮球入口。
// 单一控制状态在 src/shared/assistant-state.ts，popup / content / background 三方同步。
import { DEFAULT_FILTERS, type ApplyFilters } from '../shared/types/filters'
import type { PanelState } from '../shared/assistant-state'

export interface ChatCopilotData {
  hrMessage?: string
  replyText?: string
  matchedFact?: string
  bottomLineAlert?: string
  intent?: string
  confidence?: number
  loading?: boolean
}

export interface PanelContent {
  mode: 'batch' | 'recommend'
  stats?: { total: number; processed: number; matched: number }
  matchResults?: Array<{
    title: string
    companyName: string
    score: number
    recommended: boolean
    scoreBypassed?: boolean
    /** 猎聘两阶段：未通过卡片粗筛（分数为粗筛分，未做 AI 精评） */
    prefiltered?: boolean
  }>
  status?: 'idle' | 'scanning' | 'matching' | 'applying' | 'pause' | 'done'
  message?: string
  dailyRemaining?: number
  filters?: Partial<ApplyFilters>
  platformName?: string
  resumeMode?: boolean
  pageType?: string
  isChatPage?: boolean
  /** HR 经典追问智能应答 Copilot 数据 */
  chatCopilot?: ChatCopilotData | null
  /** E3：权限确认请求。非空时渲染确认卡片，等待用户确认/取消 */
  confirmRequest?: { desc: string } | null
}

let isMinimized = false
let triggerBtn: HTMLDivElement | null = null
let activeHost: HTMLElement | null = null
let currentPlatformName = ''

export interface InPageChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  createdAt: string
  pendingAction?: any
}

let activeTab: 'monitor' | 'chat' = 'monitor'
const inPageChatHistory: InPageChatMessage[] = [
  {
    id: 'welcome',
    role: 'assistant',
    content: `👋 您好！我是您的**求职 Bot 智能管家**。\n在网页端您可以直接对我下达指令操纵系统：\n- 💰 *“把期望薪资改成 20-30K”*\n- 🕒 *“工作时间设为 09:30-18:00”*\n- 📊 *“导出今天的投递记录为 CSV”*\n- 📈 *“分析今天投递”*`,
    createdAt: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
  },
]
let isChatSending = false

function renderMarkdownLite(text: string): string {
  if (!text) return ''
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.*?)\*/g, '<em>$1</em>')
    .replace(/\n\n/g, '<div style="height:6px"></div>')
    .replace(/\n- (.*?)(?=\n|$)/g, '<div style="padding-left:8px">• $1</div>')
    .replace(/\n/g, '<br/>')
}

/**
 * 设置当前活动平台名称并在浮动面板头部徽标中展示。
 * 由 content/index.ts 在识别到平台后调用（初始化时先于面板创建执行，
 * 因此新建面板时会自动带上平台名；面板已存在时则就地更新）。
 */
export function setPlatformName(name: string): void {
  currentPlatformName = name
  const shadow = activeHost?.shadowRoot
  if (!shadow) return
  const badge = shadow.getElementById('platform-badge')
  if (badge) badge.textContent = name
}

const VIEWPORT_MARGIN = 8
/** 右侧侧栏宽度（网页窄于该值时自动留出 8px 边距） */
const SIDEBAR_WIDTH = 440

function restoreFloatingPanel(host: HTMLElement): void {
  const shadow = host.shadowRoot
  if (!shadow) return

  isMinimized = false
  host.style.display = 'block'
  host.style.opacity = '1'
  host.style.transform = ''
  host.style.cursor = ''

  const panel = shadow.querySelector('.panel') as HTMLElement | null
  const body = shadow.getElementById('panel-body')
  const filterBar = shadow.getElementById('filter-bar')
  const panelTabs = shadow.getElementById('panel-tabs')
  const panelContent = shadow.getElementById('panel-content')
  const panelChatContent = shadow.getElementById('panel-chat-content')
  const header = shadow.querySelector('.panel-header') as HTMLElement | null
  const btnMinimize = shadow.getElementById('btn-minimize')

  if (panel) panel.style.display = ''
  if (body) body.style.display = ''
  if (panelTabs) panelTabs.style.display = ''
  if (filterBar) filterBar.style.display = activeTab === 'monitor' ? '' : 'none'
  if (panelContent) panelContent.style.display = activeTab === 'monitor' ? '' : 'none'
  if (panelChatContent) panelChatContent.style.display = activeTab === 'chat' ? 'flex' : 'none'
  if (header) header.style.borderRadius = '16px 16px 0 0'
  if (btnMinimize) btnMinimize.textContent = '−'
}

/**
 * 侧栏形态：贴网页右侧、整屏高、宽 380px（窄视口自动留出 8px 边距）。
 * 与浮窗共用同一个 panel，仅尺寸与定位不同。
 */
function applySidebarLayout(host: HTMLElement): void {
  const shadow = host.shadowRoot
  const panel = shadow?.querySelector('.panel') as HTMLElement | null
  const header = shadow?.querySelector('.panel-header') as HTMLElement | null

  host.style.top = `${VIEWPORT_MARGIN}px`
  host.style.right = `${VIEWPORT_MARGIN}px`
  host.style.bottom = `${VIEWPORT_MARGIN}px`
  host.style.left = 'auto'
  host.style.height = 'auto'
  host.style.maxHeight = ''
  host.style.width = `min(${SIDEBAR_WIDTH}px, calc(100vw - ${VIEWPORT_MARGIN * 2}px))`
  host.style.maxWidth = ''
  host.style.transform = 'none'
  host.style.cursor = ''

  if (panel) {
    panel.style.display = ''
    panel.style.width = '100%'
    panel.style.height = '100%'
    panel.style.maxHeight = 'none'
    panel.style.borderRadius = '16px'
  }
  if (header) header.style.cursor = 'default'
}

export function setPanelState(host: HTMLElement, state: PanelState): void {
  const shadow = host.shadowRoot
  if (!shadow) return

  let handle = shadow.getElementById('edge-handle') as HTMLButtonElement | null
  if (!handle) {
    handle = document.createElement('button')
    handle.id = 'edge-handle'
    handle.type = 'button'
    handle.title = '展开智能求职助手'
    handle.textContent = '🤖'
    handle.style.cssText = `
      display: none;
      width: 30px;
      height: 92px;
      padding: 0;
      border: none;
      border-radius: 10px 0 0 10px;
      background: #F97316;
      color: #FFFFFF;
      font-size: 15px;
      cursor: pointer;
      align-items: center;
      justify-content: center;
      box-shadow: 0 2px 12px rgba(0,0,0,0.18);
    `
    handle.addEventListener('click', () => {
      window.postMessage({ type: 'BOSS_ASSISTANT_SET_PANEL_STATE', state: 'expanded' }, '*')
    })
    shadow.appendChild(handle)
  }

  const panel = shadow.querySelector('.panel') as HTMLElement | null

  // 浮球与关闭都只保留网页右侧的半圆入口，不销毁 host（内容仍在，便于秒开）
  if (state === 'closed' || state === 'bubble') {
    host.style.display = 'none'
    handle.style.display = 'none'
    createFloatingTrigger(host)
    return
  }

  // 自愈清理可能把浮窗 display:none，这里兜底恢复可见性
  if (triggerBtn?.isConnected) {
    triggerBtn.remove()
    triggerBtn = null
  }
  host.style.display = 'block'
  host.style.opacity = '1'
  host.style.pointerEvents = 'auto'

  if (state === 'collapsed') {
    if (panel) panel.style.display = 'none'
    handle.style.display = 'flex'
    host.style.right = '0px'
    host.style.left = 'auto'
    host.style.top = '40%'
    host.style.width = '30px'
    host.style.maxWidth = '30px'
    host.style.transform = 'none'
    isMinimized = false
    return
  }

  if (panel) panel.style.display = ''
  handle.style.display = 'none'
  restoreFloatingPanel(host)
  applySidebarLayout(host)
}

/** 置顶常驻按钮的视觉状态（📌 高亮 + aria-pressed） */
export function setPinned(host: HTMLElement, pinned: boolean): void {
  const btn = host.shadowRoot?.getElementById('btn-pin') as HTMLButtonElement | null
  if (!btn) return
  btn.classList.toggle('active', pinned)
  btn.title = pinned ? '取消置顶常驻' : '置顶常驻'
  btn.setAttribute('aria-pressed', String(pinned))
}

/**
 * 侧栏正文 = 完整助手面板（概览 / AIbot / 管家 / 简历 / 追踪 / 设置）。
 * 用同源 iframe 复用 popup 的 React 应用，保证和原来的面板完全一致，
 * 不再重复实现一套 UI。应用检测到自己被内嵌时会自动铺满侧栏宽高。
 */
function ensureAppFrame(container: HTMLElement): void {
  if (container.querySelector('iframe')) return
  let appUrl = ''
  try {
    appUrl = chrome.runtime?.getURL?.('src/popup/index.html') ?? ''
  } catch {
    appUrl = ''
  }
  // 单测 / 无扩展上下文时拿不到扩展地址，跳过内嵌（正文由旧版渲染函数兜底）
  if (!appUrl) return
  const frame = document.createElement('iframe')
  frame.id = 'assistant-app-frame'
  frame.src = appUrl
  frame.style.cssText = 'width:100%;height:100%;border:none;display:block;background:#FFFFFF;'
  container.appendChild(frame)
}

export function createFloatingPanel(): HTMLElement {
  if (activeHost?.isConnected) {
    restoreFloatingPanel(activeHost)
    applySidebarLayout(activeHost)
    return activeHost
  }

  document.getElementById('boss-assistant-panel')?.remove()
  document.getElementById('boss-assistant-trigger')?.remove()
  triggerBtn = null

  const host = document.createElement('div')
  host.id = 'boss-assistant-panel'
  // 默认形态：网页右侧整高侧栏（与 Kimi / 通义等插件的侧栏一致）
  host.style.cssText = `
    position: fixed;
    top: ${VIEWPORT_MARGIN}px;
    right: ${VIEWPORT_MARGIN}px;
    bottom: ${VIEWPORT_MARGIN}px;
    width: min(${SIDEBAR_WIDTH}px, calc(100vw - ${VIEWPORT_MARGIN * 2}px));
    z-index: 99999;
    font-family: 'PingFang SC', system-ui, sans-serif;
    transition: transform 0.3s ease, opacity 0.3s ease;
  `

  const shadow = host.attachShadow({ mode: 'open' })

  const style = document.createElement('style')
  style.textContent = getStyles()
  shadow.appendChild(style)

  const panel = document.createElement('div')
  panel.className = 'panel'
  panel.innerHTML = `
    <div class="panel-header">
      <div class="header-left">
        <span class="header-icon">🤖</span>
        <div class="header-titles">
          <h3>智能求职助手</h3>
          <span class="platform-badge" id="platform-badge">${currentPlatformName}</span>
        </div>
      </div>
      <div class="header-actions">
        <button class="btn-header" id="btn-options" title="打开管理后台" aria-label="打开管理后台">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="3.2"/><path d="M12 3v2.4M12 18.6V21M3 12h2.4M18.6 12H21M5.6 5.6l1.7 1.7M16.7 16.7l1.7 1.7M18.4 5.6l-1.7 1.7M7.3 16.7l-1.7 1.7"/></svg>
        </button>
        <button class="btn-header" id="btn-pin" title="置顶常驻" aria-label="置顶常驻" aria-pressed="false">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5"/><path d="M9 10.76V4h6v6.76l3 3.24H6l3-3.24Z"/></svg>
        </button>
        <button class="btn-header btn-header-stop" id="btn-stop" title="停止 AIbot" aria-label="停止 AIbot">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 3v9"/><path d="M6.3 6.3a8 8 0 1 0 11.4 0"/></svg>
        </button>
        <button class="btn-header" id="btn-close" title="收起为浮球" aria-label="收起为浮球">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
        </button>
      </div>
    </div>
    <div class="panel-body" id="panel-body">
      <div id="panel-app-content"></div>
      <!-- 旧版内联正文（投递监控 / 管家中控）：面板正文已换成完整助手面板，
           这里仅保留容器让既有渲染函数不报错，始终隐藏 -->
      <div id="panel-legacy" style="display:none">
        <div class="panel-tabs" id="panel-tabs">
          <button class="panel-tab active" id="tab-monitor">📊 投递监控</button>
          <button class="panel-tab" id="tab-chat">💬 管家中控</button>
        </div>
        <div class="filter-bar" id="filter-bar"></div>
        <div id="panel-content"></div>
        <div id="panel-chat-content"></div>
      </div>
    </div>
  `
  shadow.appendChild(panel)

  // Tab switching
  const tabMonitor = shadow.getElementById('tab-monitor')
  const tabChat = shadow.getElementById('tab-chat')
  const panelContent = shadow.getElementById('panel-content')
  const panelChatContent = shadow.getElementById('panel-chat-content')
  const filterBar = shadow.getElementById('filter-bar')

  const switchTab = (tab: 'monitor' | 'chat') => {
    activeTab = tab
    tabMonitor?.classList.toggle('active', tab === 'monitor')
    tabChat?.classList.toggle('active', tab === 'chat')
    if (filterBar) filterBar.style.display = tab === 'monitor' ? '' : 'none'
    if (panelContent) panelContent.style.display = tab === 'monitor' ? '' : 'none'
    if (panelChatContent) panelChatContent.style.display = tab === 'chat' ? 'flex' : 'none'
    if (tab === 'chat') renderInPageChat(host)
  }


  tabMonitor?.addEventListener('click', () => switchTab('monitor'))
  tabChat?.addEventListener('click', () => switchTab('chat'))

  // × = 收起为右侧浮球，AIbot 继续运行（与「停止」区分开）
  shadow.getElementById('btn-close')?.addEventListener('click', () => {
    window.postMessage({ type: 'BOSS_ASSISTANT_SET_PANEL_STATE', state: 'bubble' }, '*')
  })

  // 置顶常驻：不自动收起，新页面直接展开
  shadow.getElementById('btn-pin')?.addEventListener('click', () => {
    window.postMessage({ type: 'BOSS_ASSISTANT_TOGGLE_PIN' }, '*')
  })

  // 打开管理后台（去掉 popup 后，这是简历/设置/数据的主入口）
  shadow.getElementById('btn-options')?.addEventListener('click', () => {
    window.postMessage({ type: 'BOSS_ASSISTANT_OPEN_OPTIONS' }, '*')
  })

  // 停止 AIbot（保留原有的"一键停止"能力）
  shadow.getElementById('btn-stop')?.addEventListener('click', () => {
    window.postMessage({ type: 'BOSS_ASSISTANT_SHUTDOWN' }, '*')
  })

  // Minimize handler
  shadow.getElementById('btn-minimize')?.addEventListener('click', () => {
    toggleMinimize(host)
  })

  // Clicking host itself when minimized → restore
  host.addEventListener('click', (e) => {
    if (isMinimized && e.target === host) {
      toggleMinimize(host)
    }
  })

  const appContent = shadow.getElementById('panel-app-content')
  if (appContent) ensureAppFrame(appContent)

  document.body.appendChild(host)
  activeHost = host
  isMinimized = false
  return host
}

function toggleMinimize(host: HTMLElement): void {
  const shadow = host.shadowRoot
  if (!shadow) return

  const panel = shadow.querySelector('.panel') as HTMLElement
  const body = shadow.getElementById('panel-body') as HTMLElement
  const header = shadow.querySelector('.panel-header') as HTMLElement
  const filterBar = shadow.getElementById('filter-bar') as HTMLElement
  const panelTabs = shadow.getElementById('panel-tabs') as HTMLElement | null
  const btnMinimize = shadow.getElementById('btn-minimize') as HTMLElement

  isMinimized = !isMinimized

  if (isMinimized) {
    body.style.display = 'none'
    filterBar.style.display = 'none'
    if (panelTabs) panelTabs.style.display = 'none'
    panel.style.width = '200px'
    header.style.borderRadius = '16px'
    btnMinimize.textContent = '+'
    host.style.cursor = 'pointer'
  } else {
    body.style.display = ''
    if (panelTabs) panelTabs.style.display = ''
    filterBar.style.display = activeTab === 'monitor' ? '' : 'none'
    panel.style.width = '320px'
    header.style.borderRadius = '16px 16px 0 0'
    btnMinimize.textContent = '−'
    host.style.cursor = ''
  }
}

/**
 * 网页右侧垂直居中的半圆浮球，点击后直接展开整高侧栏。
 */
function createFloatingTrigger(host: HTMLElement): void {
  if (triggerBtn?.isConnected) return
  document.getElementById('boss-assistant-trigger')?.remove()
  triggerBtn = document.createElement('div')
  triggerBtn.id = 'boss-assistant-trigger'
  // 收起后贴在网页右侧垂直居中的半圆浮球（与 Kimi 等一致）
  triggerBtn.style.cssText = `
    position: fixed;
    top: 50%;
    right: 0;
    transform: translateY(-50%);
    z-index: 99998;
    width: 46px;
    height: 46px;
    border-radius: 23px 0 0 23px;
    background: linear-gradient(135deg, #F97316, #FB923C);
    box-shadow: 0 4px 20px rgba(249, 115, 22, 0.4);
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    font-size: 18px;
    color: white;
    user-select: none;
    transition: transform 0.2s, box-shadow 0.2s;
  `
  triggerBtn.innerHTML = '🤖'
  triggerBtn.title = '展开智能求职助手侧栏'
  triggerBtn.addEventListener('click', () => {
    triggerBtn?.remove()
    triggerBtn = null
    setPanelState(host, 'expanded')
    window.postMessage({ type: 'BOSS_ASSISTANT_SET_PANEL_STATE', state: 'expanded' }, '*')
  })
  triggerBtn.addEventListener('mouseenter', () => {
    triggerBtn!.style.transform = 'translateY(-50%) translateX(-3px)'
    triggerBtn!.style.boxShadow = '0 6px 24px rgba(249, 115, 22, 0.6)'
  })
  triggerBtn.addEventListener('mouseleave', () => {
    triggerBtn!.style.transform = 'translateY(-50%)'
    triggerBtn!.style.boxShadow = '0 4px 20px rgba(249, 115, 22, 0.4)'
  })
  document.body.appendChild(triggerBtn)
}

// BOSS's anti-debug refreshes the page when DevTools opens, so we can't ask the
// user for console output. This copies the first job card's HTML to the
// clipboard (with a textarea fallback) so the user can paste it back for
// selector debugging without ever opening DevTools.
async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    try {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      const ok = document.execCommand('copy')
      ta.remove()
      return ok
    } catch {
      return false
    }
  }
}

export function updatePanelContent(host: HTMLElement, content: PanelContent): void {
  const shadow = host.shadowRoot
  if (!shadow) return

  const wrapper = shadow.getElementById('panel-content')
  if (!wrapper) return

  const filterBar = shadow.getElementById('filter-bar')
  const { mode, stats, matchResults, status = 'idle', message, dailyRemaining, filters, confirmRequest, chatCopilot } = content
  const effectiveFilters: ApplyFilters = { ...DEFAULT_FILTERS, ...filters }

  // Sync platform badge (explicit payload wins, else module state)
  const badge = shadow.getElementById('platform-badge')
  if (badge) badge.textContent = content.platformName ?? currentPlatformName

  // Update filter bar
  if (filterBar) {
    filterBar.innerHTML = buildFilterSummary(filters)
    filterBar.style.display = activeTab === 'monitor' ? '' : 'none'
  }
  wrapper.style.display = activeTab === 'monitor' ? '' : 'none'
  const chatContentEl = shadow.getElementById('panel-chat-content')
  if (chatContentEl) {
    chatContentEl.style.display = activeTab === 'chat' ? 'flex' : 'none'
  }

  let statusText = ''
  let statusColor = '#10B981'
  const statusIcon: Record<string, string> = {
    idle: '○', scanning: '🔍', matching: '🧠', applying: '📨', pause: '⏸', done: '✅',
  }
  switch (status) {
    case 'idle': statusText = '就绪'; statusColor = '#F97316'; break
    case 'scanning': statusText = '扫描岗位中...'; statusColor = '#F59E0B'; break
    case 'matching':
      statusText = effectiveFilters.enableAiMatch ? 'AI匹配分析中...' : '准备直投中...'
      statusColor = '#F59E0B'
      break
    case 'applying': statusText = '沟通中...'; statusColor = '#10B981'; break
    case 'pause': statusText = '已暂停'; statusColor = '#EF4444'; break
    case 'done': statusText = '完成'; statusColor = '#10B981'; break
  }

  const progress = stats && stats.total > 0 ? (stats.processed / stats.total * 100) : 0
  const progressColor = status === 'done' ? '#10B981' : progress > 0 ? '#FB923C' : '#9CA3AF'

  // 运行中允许切换：改动写入统一控制状态，后台从下一个任务起采用新配置
  const lockAttr = ''
  const lockHint = ' title="切换后从下一个任务起生效"'

  wrapper.innerHTML = `
    <div class="stat-row">
      <span class="stat-label">状态</span>
      <span style="color:${statusColor};font-size:13px;font-weight:600;">
        ${statusIcon[status] || ''} ${statusText}
      </span>
    </div>
    ${stats ? `
    <div class="stat-row">
      <span class="stat-label">进度</span>
      <span class="stat-value">${stats.processed}/${stats.total}</span>
    </div>
    <div class="stat-row">
      <span class="stat-label">匹配推荐</span>
      <span class="stat-value-success">${stats.matched}</span>
    </div>
    <div class="progress-bar">
      <div class="progress-fill" style="width:${progress}%;background:${progressColor};transition:width 0.5s ease;"></div>
    </div>
    ` : ''}
    ${dailyRemaining !== undefined ? `
    <div class="stat-row">
      <span class="stat-label">今日剩余额度</span>
      <span class="stat-value">${dailyRemaining} 次</span>
    </div>
    ` : ''}
    ${message ? `
    <div class="panel-message">${message}</div>
    ` : ''}
    ${content.isChatPage ? '' : `
    <div class="mode-toggle">
      <button class="mode-btn ${mode === 'batch' ? 'active' : ''}" data-mode="batch" ${lockAttr}${lockHint}>⚡ 批量沟通</button>
      <button class="mode-btn ${mode === 'recommend' ? 'active' : ''}" data-mode="recommend" ${lockAttr}${lockHint}>🤖 AI自动确认</button>
    </div>
    <div class="score-toggle">
      <button class="score-btn ${effectiveFilters.enableAiMatch ? 'active' : ''}" id="score-filter" ${lockAttr}${lockHint}>⭐ 按分筛选</button>
      <button class="score-btn ${effectiveFilters.enableAiMatch ? '' : 'active direct'}" id="score-direct" ${lockAttr}${lockHint}>🚀 不评分沟通</button>
    </div>
    ${currentPlatformName === '猎聘' ? `
    <div class="resume-toggle">
      <button class="resume-btn ${!content.resumeMode ? 'active' : ''}" id="resume-chat" ${lockAttr}${lockHint}>💬 仅沟通</button>
      <button class="resume-btn ${content.resumeMode ? 'active' : ''}" id="resume-send" ${lockAttr}${lockHint}>📤 投简历</button>
    </div>
    ` : ''}
    `}
    <div class="btn-row">
      ${confirmRequest ? `
        <div style="width:100%;background:#FFF7ED;border:1px solid #FDBA74;border-radius:10px;padding:10px 12px;">
          <div style="font-size:12px;font-weight:700;color:#9A3412;margin-bottom:6px;">⚠️ 需要确认</div>
          <div style="font-size:12px;color:#4B5563;line-height:1.6;margin-bottom:10px;">${confirmRequest.desc}</div>
          <div style="display:flex;gap:8px;">
            <button class="btn btn-primary" id="btn-confirm-yes" style="flex:1;">✅ 确认执行</button>
            <button class="btn" id="btn-confirm-no" style="flex:1;background:#ECEEF2;color:#4B5563;">✖ 取消</button>
          </div>
        </div>
      ` : `
      ${content.isChatPage ? `
        ${status === 'idle' ? `<button class="btn btn-primary" id="btn-send-resumes">📤 批量发简历</button>` : ''}
        ${status === 'applying' ? `<button class="btn btn-danger" id="btn-stop">⏹ 停止</button>` : ''}
        ${status === 'done' ? `<button class="btn btn-primary" id="btn-send-resumes">🔄 重新发送</button>` : ''}
      ` : `
        ${status === 'idle' ? `<button class="btn btn-primary" id="btn-start">🚀 开始智能沟通</button>` : ''}
        ${status === 'applying' ? `<button class="btn btn-danger" id="btn-stop">⏹ 停止</button>` : ''}
        ${status === 'done' ? `<button class="btn btn-primary" id="btn-start">🔄 继续沟通</button>` : ''}
        ${status === 'pause' ? `<button class="btn btn-primary" id="btn-resume">▶ 继续沟通</button>` : ''}
        ${status === 'scanning' || status === 'matching' ? `<button class="btn btn-danger" id="btn-stop">⏹ 停止</button>` : ''}
      `}
      `}
    </div>
    ${(content.isChatPage || chatCopilot) ? buildChatCopilotCard(chatCopilot) : ''}
    <div class="debug-row">
      <button class="debug-btn" id="btn-copy-card" title="复制首张岗位卡片HTML，用于排查公司名/职位描述提取">🐞 复制卡片HTML</button>
    </div>
    ${matchResults && matchResults.length > 0 ? buildMatchResults(matchResults) : ''}
    ${(!matchResults || matchResults.length === 0) && (status === 'idle' || status === 'done') && !content.isChatPage ? `
    <div class="panel-empty">
      <div class="panel-empty-icon">🗂️</div>
      <div class="panel-empty-title">还没有扫描到职位</div>
      <div class="panel-empty-hint">点上方「开始智能沟通」扫描当前页职位卡片<br/>匹配到的岗位会显示在这里</div>
    </div>
    ` : ''}
    <div style="margin-top:8px;padding-top:6px;border-top:1px solid rgba(0,0,0,0.06);font-size:9px;color:#6B7280;">
      平台:${currentPlatformName} | 聊天页:${content.isChatPage ? '是' : '否'} | 状态:${status}
    </div>
  `

  // Button event listeners
  const btnStart = shadow.getElementById('btn-start')
  const btnStop = shadow.getElementById('btn-stop')
  const btnResume = shadow.getElementById('btn-resume')
  const scoreFilter = shadow.getElementById('score-filter')
  const scoreDirect = shadow.getElementById('score-direct')
  const modeBtns = shadow.querySelectorAll('.mode-btn')

  // E3：确认卡片按钮 → content 侧桥接 resolve
  shadow.getElementById('btn-confirm-yes')?.addEventListener('click', () => {
    window.postMessage({ type: 'BOSS_ASSISTANT_CONFIRM', decision: true }, '*')
  })
  shadow.getElementById('btn-confirm-no')?.addEventListener('click', () => {
    window.postMessage({ type: 'BOSS_ASSISTANT_CONFIRM', decision: false }, '*')
  })

  btnStart?.addEventListener('click', () => {
    window.postMessage({
      type: 'BOSS_ASSISTANT_START_APPLY',
      mode,
      filters: effectiveFilters,
    }, '*')
  })
  btnStop?.addEventListener('click', () => {
    // 浮窗「停止」与「关闭」是同一个动作：关闭 bot 流水线
    window.postMessage({ type: 'BOSS_ASSISTANT_SHUTDOWN' }, '*')
  })
  btnResume?.addEventListener('click', () => {
    window.postMessage({
      type: 'BOSS_ASSISTANT_START_APPLY',
      mode,
      filters: effectiveFilters,
    }, '*')
  })
  shadow.getElementById('btn-send-resumes')?.addEventListener('click', () => {
    console.log('[求职助手] btn-send-resumes clicked, posting BOSS_ASSISTANT_SEND_RESUMES')
    window.postMessage({ type: 'BOSS_ASSISTANT_SEND_RESUMES' }, '*')
  })
  scoreFilter?.addEventListener('click', () => {
    window.postMessage({ type: 'BOSS_ASSISTANT_CHANGE_SCORING', enabled: true }, '*')
  })
  scoreDirect?.addEventListener('click', () => {
    window.postMessage({ type: 'BOSS_ASSISTANT_CHANGE_SCORING', enabled: false }, '*')
  })
  modeBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      const newMode = btn.getAttribute('data-mode') as 'batch' | 'recommend'
      window.postMessage({ type: 'BOSS_ASSISTANT_CHANGE_MODE', mode: newMode }, '*')
    })
  })

  shadow.getElementById('resume-chat')?.addEventListener('click', () => {
    window.postMessage({ type: 'BOSS_ASSISTANT_CHANGE_RESUME_MODE', enabled: false }, '*')
  })
  shadow.getElementById('resume-send')?.addEventListener('click', () => {
    window.postMessage({ type: 'BOSS_ASSISTANT_CHANGE_RESUME_MODE', enabled: true }, '*')
  })

  shadow.getElementById('btn-copy-card')?.addEventListener('click', async () => {
    const card = document.querySelector(
      'li.job-card-box, .job-card-wrapper, .recommend-job-card, [class*="job-card"]',
    )
    if (!card) {
      showPanelToast(host, '未找到岗位卡片', 'warning')
      return
    }
    const ok = await copyTextToClipboard(card.outerHTML)
    showPanelToast(
      host,
      ok ? '已复制卡片HTML，请粘贴发给开发者' : '复制失败，请重试',
      ok ? 'success' : 'error',
    )
  })

  // Copilot 一键填入 / 一键发送
  const copilotFillBtn = shadow.getElementById('btn-copilot-fill')
  const copilotSendBtn = shadow.getElementById('btn-copilot-send')
  const copilotInput = shadow.getElementById('copilot-reply-input') as HTMLTextAreaElement | null

  copilotFillBtn?.addEventListener('click', () => {
    const text = copilotInput ? copilotInput.value : (chatCopilot?.replyText || '')
    window.postMessage({ type: 'BOSS_ASSISTANT_COPILOT_FILL', text }, '*')
  })

  copilotSendBtn?.addEventListener('click', () => {
    const text = copilotInput ? copilotInput.value : (chatCopilot?.replyText || '')
    window.postMessage({ type: 'BOSS_ASSISTANT_COPILOT_SEND', text }, '*')
  })
}

function buildFilterSummary(filters?: PanelContent['filters']): string {
  if (!filters) return ''

  const parts: string[] = []
  if (filters.jobTitles) parts.push(`<span class="filter-tag filter-tag-title">📋 ${filters.jobTitles}</span>`)
  if (filters.locations) parts.push(`<span class="filter-tag filter-tag-loc">📍 ${filters.locations}</span>`)
  if (filters.salaryMin !== null || filters.salaryMax !== null) {
    const min = filters.salaryMin ?? '?'
    const max = filters.salaryMax ?? '?'
    parts.push(`<span class="filter-tag filter-tag-salary">💰 ${min}-${max}K</span>`)
  }
  if (filters.experience) parts.push(`<span class="filter-tag">🎓 ${filters.experience}</span>`)
  if (filters.education) parts.push(`<span class="filter-tag">📚 ${filters.education}</span>`)
  if (filters.excludeKeywords) parts.push(`<span class="filter-tag filter-tag-exclude">🚫 ${filters.excludeKeywords}</span>`)
  if (!filters.enableAiMatch) parts.push(`<span class="filter-tag filter-tag-exclude">🧠 AI已关</span>`)
  else if (filters.minMatchScore) parts.push(`<span class="filter-tag filter-tag-score">⭐ ≥${filters.minMatchScore}分</span>`)

  if (parts.length === 0) return ''

  return `<div class="filter-summary">${parts.join('')}</div>`
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function buildMatchResults(matchResults: Array<{
  title: string
  companyName: string
  score: number
  recommended: boolean
  scoreBypassed?: boolean
  prefiltered?: boolean
}>): string {
  const list = matchResults.map((r) => {
    // 粗筛未过的岗位：固定红色 + 「×粗筛」标签（该分数是本地粗筛分，非 AI 精评分）
    const color = r.prefiltered ? '#EF4444' : (r.score >= 70 ? '#10B981' : r.score >= 50 ? '#F59E0B' : '#EF4444')
    const title = escapeHtml(r.title)
    const company = escapeHtml(r.companyName || '未知公司')
    const tagText = r.scoreBypassed ? '直投' : r.prefiltered ? '×粗筛' : (r.recommended ? '推荐' : '待定')
    return `
      <div class="match-item">
        <div class="match-info">
          <span class="match-title" title="${title}">${title}</span>
          <span class="match-company" title="${company}">${company}</span>
        </div>
        <span class="match-score" style="color:${color}">${r.scoreBypassed ? '不判分' : `${r.score}分`}</span>
        <span class="tag ${r.prefiltered ? 'tag-no-rec' : (r.recommended ? 'tag-rec' : 'tag-no-rec')}">${tagText}</span>
      </div>
    `
  }).join('')

  return `
    <div class="match-section">
      <div class="match-header">${matchResults.every((result) => result.scoreBypassed) ? '直投结果' : '匹配结果'}</div>
      ${list}
    </div>
  `
}

function getIntentLabel(intent?: string): string {
  switch (intent) {
    case 'status_and_onboard': return '🕒 到岗/求职状态'
    case 'salary_inquiry': return '💰 期望薪资'
    case 'bottom_line_check': return '🛡️ 底线拦截'
    case 'architecture_and_tech': return '🏗️ 技术架构实战'
    case 'interview_invitation': return '📅 面试邀约'
    case 'general_chitchat': return '💬 热情互动'
    default: return '🤖 智能应答'
  }
}

function buildChatCopilotCard(copilot?: ChatCopilotData | null): string {
  if (!copilot) {
    return `
      <div class="copilot-card">
        <div class="copilot-header">
          <span class="copilot-title">💬 HR 追问 Copilot</span>
          <span class="copilot-pill">实时感知中</span>
        </div>
        <div class="copilot-empty">等待聊天会话中 HR 的提问或追问…</div>
      </div>
    `
  }

  const hrText = copilot.hrMessage ? escapeHtml(copilot.hrMessage) : ''
  const replyText = copilot.replyText ? escapeHtml(copilot.replyText) : ''
  const factText = copilot.matchedFact ? escapeHtml(copilot.matchedFact) : ''
  const alertText = copilot.bottomLineAlert ? escapeHtml(copilot.bottomLineAlert) : ''
  const intentLabel = getIntentLabel(copilot.intent)

  return `
    <div class="copilot-card">
      <div class="copilot-header">
        <span class="copilot-title">💬 HR 追问 Copilot</span>
        ${copilot.loading ? '<span class="copilot-pill copilot-pill-loading">思考中...</span>' : `<span class="copilot-pill">${intentLabel}</span>`}
      </div>

      ${copilot.hrMessage ? `
        <div class="copilot-hr-msg">
          <span class="copilot-label">HR最新提问：</span>
          <div class="copilot-text">${hrText}</div>
        </div>
      ` : `
        <div class="copilot-empty">正在感知聊天会话中 HR 的最新提问…</div>
      `}

      ${alertText ? `
        <div class="copilot-alert">
          ${alertText}
        </div>
      ` : ''}

      ${factText ? `
        <div class="copilot-fact">
          <span class="copilot-fact-tag">📌 真实简历事实依据</span>
          <div class="copilot-fact-text">${factText}</div>
        </div>
      ` : ''}

      ${copilot.replyText ? `
        <div class="copilot-reply-box">
          <div class="copilot-reply-header">
            <span class="copilot-label">💡 建议回复（可二次编辑）：</span>
          </div>
          <textarea class="copilot-reply-input" id="copilot-reply-input">${replyText}</textarea>
          <div class="copilot-actions">
            <button class="copilot-btn copilot-btn-fill" id="btn-copilot-fill" title="填入网页聊天框，可在发送前二次编辑">📝 填入输入框</button>
            <button class="copilot-btn copilot-btn-send" id="btn-copilot-send" title="直接发送该建议给HR">🚀 一键发送</button>
          </div>
        </div>
      ` : ''}
    </div>
  `
}

export function showPanelToast(host: HTMLElement, message: string, type: 'success' | 'error' | 'warning' | 'info' = 'info'): void {
  const shadow = host.shadowRoot
  if (!shadow) return

  const existing = shadow.getElementById('panel-toast')
  if (existing) existing.remove()

  const colors = { success: '#10B981', error: '#EF4444', warning: '#F59E0B', info: '#3B82F6' }
  const icons = { success: '✅', error: '❌', warning: '⚠️', info: 'ℹ️' }

  const toast = document.createElement('div')
  toast.id = 'panel-toast'
  toast.style.cssText = `
    position: absolute;
    bottom: 16px;
    left: 12px;
    right: 12px;
    padding: 10px 14px;
    background: rgba(255,255,255,0.98);
    border: 1px solid ${colors[type]}40;
    border-radius: 10px;
    color: ${colors[type]};
    font-size: 12px;
    text-align: center;
    z-index: 20;
    backdrop-filter: blur(12px);
    animation: toastIn 0.3s ease;
  `
  toast.textContent = `${icons[type]} ${message}`

  const body = shadow.getElementById('panel-body')
  body?.appendChild(toast)

  setTimeout(() => {
    toast.style.opacity = '0'
    toast.style.transition = 'opacity 0.3s'
    setTimeout(() => toast.remove(), 300)
  }, 3000)
}

function renderChatMessages(history: InPageChatMessage[]): string {
  return history
    .map((msg) => {
      const isUser = msg.role === 'user'
      return `
        <div class="chat-bubble ${isUser ? 'chat-bubble-user' : 'chat-bubble-assistant'}">
          <div class="chat-bubble-content">${renderMarkdownLite(msg.content)}</div>
          ${
            msg.pendingAction
              ? `
            <div class="chat-approval-box">
              <div style="font-weight:600;color:#C2410C;margin-bottom:3px;">⚠️ 需要确认操作：</div>
              <div style="color:#4B5563;margin-bottom:6px;line-height:1.4;">${msg.pendingAction.description}</div>
              <div class="chat-approval-btns">
                <button class="chat-action-btn chat-action-approve" data-msg-id="${msg.id}">✅ 确认执行</button>
                <button class="chat-action-btn chat-action-reject" data-msg-id="${msg.id}">✖ 取消</button>
              </div>
            </div>
          `
              : ''
          }
          <div class="chat-bubble-time">${msg.createdAt}</div>
        </div>
      `
    })
    .join('')
}

export function renderInPageChat(host: HTMLElement): void {
  const shadow = host.shadowRoot
  if (!shadow) return
  const container = shadow.getElementById('panel-chat-content')
  if (!container) return

  container.innerHTML = `
    <div class="chat-wrapper">
      <div class="chat-messages-scroll" id="chat-messages-scroll">
        ${renderChatMessages(inPageChatHistory)}
      </div>
      <div class="chat-chips-row">
        <button class="chat-chip" data-prompt="导出今天的投递记录为 CSV">📊 导出报表</button>
        <button class="chat-chip" data-prompt="把期望薪资改成 20-30K">💰 期望薪资改20-30K</button>
        <button class="chat-chip" data-prompt="工作时间设为 09:30-18:00">🕒 工作时间09:30-18:00</button>
        <button class="chat-chip" data-prompt="分析今天投递">📈 分析今天投递</button>
        <button class="chat-chip" data-prompt="把中软卓越加入黑名单">🛡️ 加黑名单</button>
      </div>
      <div class="chat-input-bar">
        <input type="text" class="chat-input" id="chat-input-text" placeholder="对管家下指令（如：调高薪资、分析投递）..." ${isChatSending ? 'disabled' : ''} />
        <button class="chat-send-btn" id="chat-send-btn" title="发送指令" ${isChatSending ? 'disabled' : ''}>
          ${isChatSending ? '⏳' : '🚀'}
        </button>
      </div>
    </div>
  `

  const scrollEl = shadow.getElementById('chat-messages-scroll')
  if (scrollEl) {
    scrollEl.scrollTop = scrollEl.scrollHeight
  }

  // Bind input and send
  const inputEl = shadow.getElementById('chat-input-text') as HTMLInputElement | null
  const sendBtn = shadow.getElementById('chat-send-btn')

  const doSend = (text: string) => {
    if (!text.trim() || isChatSending) return
    sendMessage(host, text.trim())
  }

  sendBtn?.addEventListener('click', () => {
    if (inputEl) doSend(inputEl.value)
  })

  inputEl?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      doSend(inputEl.value)
    }
  })

  // Bind chips
  const chips = shadow.querySelectorAll('.chat-chip')
  chips.forEach((chip) => {
    chip.addEventListener('click', () => {
      const prompt = chip.getAttribute('data-prompt')
      if (prompt) doSend(prompt)
    })
  })

  // Bind pending approval buttons
  const approveBtns = shadow.querySelectorAll('.chat-action-approve')
  approveBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      const msgId = btn.getAttribute('data-msg-id')
      const targetMsg = inPageChatHistory.find((m) => m.id === msgId)
      if (targetMsg?.pendingAction) {
        sendApproval(host, targetMsg.pendingAction)
        delete targetMsg.pendingAction
      }
    })
  })

  const rejectBtns = shadow.querySelectorAll('.chat-action-reject')
  rejectBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      const msgId = btn.getAttribute('data-msg-id')
      const targetMsg = inPageChatHistory.find((m) => m.id === msgId)
      if (targetMsg) {
        delete targetMsg.pendingAction
        inPageChatHistory.push({
          id: Date.now().toString(),
          role: 'assistant',
          content: '已取消执行该操作。',
          createdAt: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
        })
        renderInPageChat(host)
      }
    })
  })
}

function sendMessage(host: HTMLElement, text: string): void {
  const now = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  inPageChatHistory.push({
    id: Date.now().toString(),
    role: 'user',
    content: text,
    createdAt: now,
  })

  const tempId = `loading_${Date.now()}`
  inPageChatHistory.push({
    id: tempId,
    role: 'assistant',
    content: '🤖 管家思考并执行中...',
    createdAt: now,
  })

  isChatSending = true
  renderInPageChat(host)

  // Send to background service
  chrome.runtime.sendMessage(
    {
      type: 'DISPATCH_BUTLER_CHAT',
      payload: { text },
    },
    (res) => {
      isChatSending = false
      const index = inPageChatHistory.findIndex((m) => m.id === tempId)

      if (chrome.runtime.lastError || !res?.success) {
        const errMsg = res?.error || chrome.runtime.lastError?.message || '执行遇到错误'
        if (index !== -1) {
          inPageChatHistory[index] = {
            id: Date.now().toString(),
            role: 'assistant',
            content: `❌ ${errMsg}`,
            createdAt: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
          }
        }
      } else {
        const reply = res.data
        if (index !== -1) {
          inPageChatHistory[index] = {
            id: reply?.id || Date.now().toString(),
            role: 'assistant',
            content: reply?.content || '已完成处理',
            createdAt: reply?.createdAt || new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
            pendingAction: reply?.pendingAction,
          }
        }
        // Notify content script that settings may have changed
        window.postMessage({ type: 'BOSS_ASSISTANT_SETTINGS_CHANGED' }, '*')
      }

      renderInPageChat(host)
    },
  )
}

function sendApproval(host: HTMLElement, pendingAction: any): void {
  const now = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  const tempId = `loading_${Date.now()}`
  inPageChatHistory.push({
    id: tempId,
    role: 'assistant',
    content: '⚡ 正在执行确认的操作...',
    createdAt: now,
  })

  isChatSending = true
  renderInPageChat(host)

  chrome.runtime.sendMessage(
    {
      type: 'DISPATCH_BUTLER_CHAT',
      payload: { text: '', pendingApproval: pendingAction },
    },
    (res) => {
      isChatSending = false
      const index = inPageChatHistory.findIndex((m) => m.id === tempId)

      if (chrome.runtime.lastError || !res?.success) {
        const errMsg = res?.error || chrome.runtime.lastError?.message || '执行确认遇到错误'
        if (index !== -1) {
          inPageChatHistory[index] = {
            id: Date.now().toString(),
            role: 'assistant',
            content: `❌ ${errMsg}`,
            createdAt: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
          }
        }
      } else {
        const reply = res.data
        if (index !== -1) {
          inPageChatHistory[index] = {
            id: reply?.id || Date.now().toString(),
            role: 'assistant',
            content: reply?.content || '✅ 操作已确认并执行完成',
            createdAt: reply?.createdAt || new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
          }
        }
        window.postMessage({ type: 'BOSS_ASSISTANT_SETTINGS_CHANGED' }, '*')
      }

      renderInPageChat(host)
    },
  )
}

function getStyles(): string {
  return `
    * { box-sizing: border-box; margin: 0; padding: 0; }

    @keyframes toastIn {
      from { opacity: 0; transform: translateY(8px); }
      to { opacity: 1; transform: translateY(0); }
    }

    .panel {
      background: rgba(255, 255, 255, 0.97);
      backdrop-filter: blur(24px);
      -webkit-backdrop-filter: blur(24px);
      border: 1px solid rgba(249, 115, 22, 0.15);
      border-radius: 16px;
      box-shadow: 0 8px 40px rgba(0, 0, 0, 0.18), 0 0 60px rgba(249, 115, 22, 0.1);
      overflow: hidden;
      width: 100%;
      height: 100%;
      max-width: none;
      max-height: none;
      display: flex;
      flex-direction: column;
      transition: width 0.3s ease, border-radius 0.3s ease;
    }

    .panel-header {
      background: linear-gradient(135deg, #F97316 0%, #FB923C 100%);
      padding: 6px 10px 6px 12px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      cursor: default;
      touch-action: auto;
      flex-shrink: 0;
    }
    .header-left {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .header-icon { font-size: 14px; }
.header-titles { display: flex; flex-direction: column; line-height: 1.15; gap: 1px; }
.platform-badge {
  font-size: 10px;
  font-weight: 500;
  color: rgba(255, 255, 255, 0.85);
  letter-spacing: 0.3px;
}
    .panel-header h3 {
      color: white;
      font-size: 12px;
      font-weight: 600;
    }
    .header-actions {
      display: flex;
      gap: 4px;
    }
    .btn-header {
      background: rgba(255,255,255,0.15);
      border: none;
      color: white;
      width: 22px;
      height: 22px;
      border-radius: 6px;
      font-size: 14px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      line-height: 1;
      transition: background 0.2s;
    }
    .btn-header svg { width: 14px; height: 14px; display: block; }
    .btn-header:hover { background: rgba(255,255,255,0.3); }
    .btn-header.active {
      background: rgba(255, 255, 255, 0.94);
      color: #EA580C;
      box-shadow: inset 0 0 0 1px rgba(249, 115, 22, 0.35);
    }
    .btn-header-stop:hover { background: rgba(220, 38, 38, 0.85); }

    /* Filter bar */
    .filter-bar {
      padding: 0;
      flex-shrink: 0;
    }
    .filter-summary {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
      padding: 8px 14px;
      background: rgba(249, 115, 22, 0.06);
      border-bottom: 1px solid rgba(0,0,0,0.06);
      min-height: 0;
    }
    .filter-tag {
      display: inline-flex;
      align-items: center;
      gap: 2px;
      padding: 2px 7px;
      border-radius: 10px;
      font-size: 10px;
      white-space: nowrap;
      max-width: 140px;
      overflow: hidden;
      text-overflow: ellipsis;
      background: rgba(0,0,0,0.04);
      color: #4B5563;
      border: 1px solid rgba(0,0,0,0.08);
    }
    .filter-tag-title { border-color: rgba(249,115,22,0.3); color: #EA580C; }
    .filter-tag-loc { border-color: rgba(16,185,129,0.2); color: #059669; }
    .filter-tag-salary { border-color: rgba(245,158,11,0.3); color: #D97706; }
    .filter-tag-exclude { border-color: rgba(239,68,68,0.2); color: #DC2626; }
    .filter-tag-score { border-color: rgba(16,185,129,0.3); color: #10B981; }

    /* Body */
    .panel-body {
      padding: 0;
      max-height: none;
      min-height: 0;
      flex: 1 1 auto;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    /* 侧栏正文：完整助手面板 */
    #panel-app-content {
      flex: 1 1 auto;
      min-height: 0;
      display: block;
    }
    /* 正文铺满侧栏高度，空闲态在剩余空间居中提示，避免大片空白 */
    #panel-content {
      display: flex;
      flex-direction: column;
      min-height: 100%;
    }
    .panel-empty {
      flex: 1 1 auto;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 6px;
      padding: 24px 10px;
      text-align: center;
    }
    .panel-empty-icon { font-size: 28px; opacity: 0.5; line-height: 1; }
    .panel-empty-title { font-size: 12px; font-weight: 600; color: #6B7280; }
    .panel-empty-hint { font-size: 11px; line-height: 1.75; color: #9CA3AF; }

    .panel-body::-webkit-scrollbar { width: 4px; }
    .panel-body::-webkit-scrollbar-thumb { background: rgba(0,0,0,0.15); border-radius: 2px; }

    .stat-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 6px 0;
      border-bottom: 1px solid rgba(0,0,0,0.05);
    }
    .stat-label { color: #6B7280; font-size: 11px; }
    .stat-value, .stat-value-success { font-size: 13px; font-weight: 700; }
    .stat-value { color: #FB923C; }
    .stat-value-success { color: #10B981; }

    .panel-message {
      padding: 8px 0;
      color: #4B5563;
      font-size: 11px;
      line-height: 1.4;
    }

    .progress-bar {
      width: 100%;
      height: 4px;
      background: rgba(0,0,0,0.06);
      border-radius: 2px;
      overflow: hidden;
      margin: 6px 0;
    }
    .progress-fill {
      height: 100%;
      border-radius: 2px;
    }

    .mode-toggle {
      display: flex;
      gap: 4px;
      background: rgba(0,0,0,0.05);
      padding: 3px;
      border-radius: 10px;
      margin: 8px 0;
    }
    .mode-btn {
      flex: 1;
      padding: 7px 8px;
      border: none;
      border-radius: 8px;
      font-size: 11px;
      font-weight: 500;
      cursor: pointer;
      background: transparent;
      color: #6B7280;
      transition: all 0.2s;
      white-space: nowrap;
    }
    .mode-btn.active {
      background: rgba(249,115,22,0.2);
      color: #EA580C;
    }
    .mode-btn:hover:not(.active) { color: #4B5563; }

    .score-toggle {
      display: flex;
      gap: 4px;
      padding: 3px;
      margin: -2px 0 8px;
      border-radius: 10px;
      background: rgba(0,0,0,0.05);
    }
    .score-btn {
      flex: 1;
      padding: 7px 6px;
      border: 1px solid transparent;
      border-radius: 8px;
      background: transparent;
      color: #6B7280;
      font-size: 11px;
      cursor: pointer;
      transition: all 0.2s;
    }
    .score-btn.active {
      color: #D97706;
      border-color: rgba(245,158,11,0.25);
      background: rgba(245,158,11,0.1);
    }
    .score-btn.active.direct {
      color: #059669;
      border-color: rgba(16,185,129,0.25);
      background: rgba(16,185,129,0.1);
    }

    /* Mode / scoring toggles are locked while a run is active. */
    .mode-btn:disabled,
    .resume-toggle {
      display: flex;
      gap: 4px;
      padding: 3px;
      margin: -2px 0 8px;
      border-radius: 10px;
      background: rgba(0,0,0,0.05);
    }
    .resume-btn {
      flex: 1;
      padding: 7px 6px;
      border: 1px solid transparent;
      border-radius: 8px;
      background: transparent;
      color: #6B7280;
      font-size: 11px;
      cursor: pointer;
      transition: all 0.2s;
    }
    .resume-btn.active {
      color: #059669;
      border-color: rgba(16,185,129,0.25);
      background: rgba(16,185,129,0.1);
    }
    .resume-btn:disabled {
      opacity: 0.4;
      cursor: not-allowed;
      pointer-events: none;
      filter: grayscale(0.6);
    }

    .score-btn:disabled {
      opacity: 0.4;
      cursor: not-allowed;
      pointer-events: none;
      filter: grayscale(0.6);
    }

    .btn-row {
      display: flex;
      gap: 8px;
    }
    .btn {
      flex: 1;
      padding: 10px;
      border: none;
      border-radius: 10px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s;
    }
    .btn-primary {
      background: linear-gradient(135deg, #F97316, #FB923C);
      color: white;
    }
    .btn-primary:hover { box-shadow: 0 0 20px rgba(249,115,22,0.4); transform: translateY(-1px); }
    .btn-primary:disabled { opacity: 0.5; cursor: not-allowed; transform: none; }
    .btn-danger {
      background: rgba(239,68,68,0.12);
      color: #EF4444;
      border: 1px solid rgba(239,68,68,0.2);
    }
    .btn-danger:hover { background: rgba(239,68,68,0.2); }

    .debug-row {
      display: flex;
      justify-content: flex-end;
      margin-top: 8px;
    }
    .debug-btn {
      background: transparent;
      border: 1px solid rgba(0,0,0,0.12);
      color: #6B7280;
      font-size: 10px;
      padding: 4px 8px;
      border-radius: 8px;
      cursor: pointer;
      transition: all 0.2s;
    }
    .debug-btn:hover { color: #4B5563; border-color: rgba(0,0,0,0.25); }

    .match-section {
      margin-top: 12px;
      padding-top: 8px;
      border-top: 1px solid rgba(0,0,0,0.06);
    }
    .match-header {
      color: #6B7280;
      font-size: 10px;
      font-weight: 600;
      margin-bottom: 6px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .match-item {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 5px 0;
      gap: 6px;
    }
    .match-info {
      display: flex;
      flex-direction: column;
      flex: 1;
      min-width: 0;
      gap: 1px;
    }
    .match-title {
      color: #111827;
      font-size: 11px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      min-width: 0;
    }
    .match-company {
      color: #6B7280;
      font-size: 10px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .match-score {
      font-size: 11px;
      font-weight: 700;
      white-space: nowrap;
    }
    .tag {
      display: inline-block;
      padding: 1px 6px;
      border-radius: 8px;
      font-size: 9px;
      font-weight: 500;
      white-space: nowrap;
      flex-shrink: 0;
    }
    .tag-rec { background: rgba(16,185,129,0.12); color: #10B981; }
    .tag-no-rec { background: rgba(239,68,68,0.1); color: #EF4444; }

    /* Copilot Card Styles */
    .copilot-card {
      margin-top: 10px;
      padding: 10px;
      background: #F9FAFB;
      border: 1px solid #E5E7EB;
      border-radius: 12px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .copilot-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .copilot-title {
      font-size: 11px;
      font-weight: 700;
      color: #374151;
      display: flex;
      align-items: center;
      gap: 4px;
    }
    .copilot-pill {
      font-size: 9px;
      padding: 2px 6px;
      border-radius: 6px;
      background: #E0E7FF;
      color: #4338CA;
      font-weight: 600;
    }
    .copilot-pill-loading {
      background: #FEF3C7;
      color: #D97706;
      animation: pulse 1.5s infinite;
    }
    .copilot-hr-msg {
      background: #FFFFFF;
      border: 1px solid #E5E7EB;
      border-left: 3px solid #3B82F6;
      border-radius: 6px;
      padding: 6px 8px;
      font-size: 11px;
      color: #1F2937;
      line-height: 1.4;
    }
    .copilot-empty {
      font-size: 11px;
      color: #9CA3AF;
      text-align: center;
      padding: 12px 6px;
      background: #FFFFFF;
      border-radius: 6px;
      border: 1px dashed #E5E7EB;
    }
    .copilot-label {
      font-size: 10px;
      font-weight: 600;
      color: #6B7280;
      display: block;
      margin-bottom: 2px;
    }
    .copilot-alert {
      background: #FEF2F2;
      border: 1px solid #FCA5A5;
      border-radius: 6px;
      padding: 6px 8px;
      font-size: 11px;
      color: #991B1B;
      line-height: 1.4;
      font-weight: 500;
    }
    .copilot-fact {
      background: #F0FDF4;
      border: 1px solid #BBF7D0;
      border-radius: 6px;
      padding: 6px 8px;
      font-size: 10px;
      color: #166534;
      line-height: 1.35;
    }
    .copilot-fact-tag {
      font-size: 9px;
      font-weight: 700;
      color: #15803D;
      display: block;
      margin-bottom: 2px;
    }
    .copilot-reply-box {
      background: #FFFFFF;
      border: 1px solid #E5E7EB;
      border-radius: 8px;
      padding: 8px;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .copilot-reply-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .copilot-reply-input {
      width: 100%;
      min-height: 64px;
      border: 1px solid #D1D5DB;
      border-radius: 6px;
      padding: 6px 8px;
      font-size: 11px;
      color: #111827;
      line-height: 1.45;
      resize: vertical;
      font-family: inherit;
      outline: none;
      box-sizing: border-box;
    }
    .copilot-reply-input:focus {
      border-color: #F97316;
      box-shadow: 0 0 0 2px rgba(249, 115, 22, 0.15);
    }
    .copilot-actions {
      display: flex;
      gap: 6px;
      margin-top: 2px;
    }
    .copilot-btn {
      flex: 1;
      padding: 6px 8px;
      border: none;
      border-radius: 6px;
      font-size: 11px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s;
    }
    .copilot-btn-fill {
      background: #F3F4F6;
      color: #374151;
      border: 1px solid #D1D5DB;
    }
    .copilot-btn-fill:hover {
      background: #E5E7EB;
      color: #111827;
    }
    .copilot-btn-send {
      background: linear-gradient(135deg, #10B981, #059669);
      color: white;
    }
    .copilot-btn-send:hover {
      box-shadow: 0 2px 8px rgba(16, 185, 129, 0.3);
    }

    /* Tabs */
    .panel-tabs {
      display: flex;
      background: #F3F4F6;
      border-bottom: 1px solid rgba(0,0,0,0.06);
      padding: 3px 6px;
      gap: 4px;
      flex-shrink: 0;
    }
    .panel-tab {
      flex: 1;
      padding: 5px 8px;
      border: none;
      border-radius: 8px;
      font-size: 11px;
      font-weight: 500;
      cursor: pointer;
      background: transparent;
      color: #6B7280;
      transition: all 0.2s ease;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 4px;
    }
    .panel-tab:hover {
      color: #1F2937;
    }
    .panel-tab.active {
      background: #FFFFFF;
      color: #EA580C;
      font-weight: 600;
      box-shadow: 0 1px 3px rgba(0,0,0,0.08);
    }

    /* Butler In-page Chat */
    #panel-chat-content {
      flex-direction: column;
      width: 100%;
    }
    .chat-wrapper {
      display: flex;
      flex-direction: column;
      height: 100%;
      min-height: 320px;
      gap: 8px;
      width: 100%;
    }
    .chat-messages-scroll {
      flex: 1 1 auto;
      min-height: 0;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 8px;
      padding-right: 2px;
      scrollbar-width: thin;
      scrollbar-color: rgba(0,0,0,0.15) transparent;
    }
    .chat-messages-scroll::-webkit-scrollbar { width: 4px; }
    .chat-messages-scroll::-webkit-scrollbar-thumb { background: rgba(0,0,0,0.15); border-radius: 2px; }

    .chat-bubble {
      max-width: 90%;
      border-radius: 12px;
      padding: 8px 10px;
      font-size: 11px;
      line-height: 1.5;
      word-break: break-word;
      animation: toastIn 0.2s ease;
    }
    .chat-bubble-user {
      align-self: flex-end;
      background: linear-gradient(135deg, #F97316 0%, #FB923C 100%);
      color: #FFFFFF;
      border-bottom-right-radius: 2px;
    }
    .chat-bubble-assistant {
      align-self: flex-start;
      background: #F9FAFB;
      color: #1F2937;
      border: 1px solid rgba(0,0,0,0.08);
      border-bottom-left-radius: 2px;
    }
    .chat-bubble-time {
      font-size: 9px;
      opacity: 0.6;
      margin-top: 3px;
      text-align: right;
    }
    .chat-bubble-user .chat-bubble-time {
      color: rgba(255,255,255,0.85);
    }
    .chat-approval-box {
      margin-top: 6px;
      padding: 6px 8px;
      background: #FFF7ED;
      border: 1px solid #FDBA74;
      border-radius: 6px;
      font-size: 11px;
    }
    .chat-approval-btns {
      display: flex;
      gap: 4px;
      margin-top: 6px;
    }
    .chat-action-btn {
      padding: 3px 8px;
      border-radius: 4px;
      font-size: 10px;
      font-weight: 500;
      border: none;
      cursor: pointer;
    }
    .chat-action-approve {
      background: #F97316;
      color: white;
    }
    .chat-action-approve:hover {
      background: #EA580C;
    }
    .chat-action-reject {
      background: #E5E7EB;
      color: #374151;
    }
    .chat-action-reject:hover {
      background: #D1D5DB;
    }

    .chat-chips-row {
      display: flex;
      gap: 4px;
      overflow-x: auto;
      padding-bottom: 2px;
      scrollbar-width: none;
      flex-shrink: 0;
    }
    .chat-chips-row::-webkit-scrollbar { display: none; }
    .chat-chip {
      font-size: 10px;
      white-space: nowrap;
      padding: 3px 8px;
      background: rgba(249, 115, 22, 0.08);
      color: #EA580C;
      border: 1px solid rgba(249, 115, 22, 0.2);
      border-radius: 12px;
      cursor: pointer;
      transition: background 0.2s;
      flex-shrink: 0;
    }
    .chat-chip:hover {
      background: rgba(249, 115, 22, 0.18);
    }

    .chat-input-bar {
      display: flex;
      gap: 6px;
      align-items: center;
      padding-top: 6px;
      border-top: 1px solid rgba(0,0,0,0.06);
      flex-shrink: 0;
    }
    .chat-input {
      flex: 1;
      border: 1px solid #D1D5DB;
      border-radius: 8px;
      padding: 6px 8px;
      font-size: 11px;
      outline: none;
      font-family: inherit;
    }
    .chat-input:focus {
      border-color: #F97316;
      box-shadow: 0 0 0 2px rgba(249, 115, 22, 0.15);
    }
    .chat-send-btn {
      background: linear-gradient(135deg, #F97316, #FB923C);
      color: white;
      border: none;
      border-radius: 8px;
      width: 28px;
      height: 28px;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      font-size: 12px;
      flex-shrink: 0;
      transition: opacity 0.2s;
    }
    .chat-send-btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
  `
}
