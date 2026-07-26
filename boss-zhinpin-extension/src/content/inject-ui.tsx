// Inject a floating UI panel into the Boss Zhipin page
// Supports: collapsible, filter display, minimize toggle, floating trigger button
import { DEFAULT_FILTERS, type ApplyFilters } from '../shared/types/filters'

interface PanelContent {
  mode: 'batch' | 'recommend'
  stats?: { total: number; processed: number; matched: number }
  matchResults?: Array<{
    title: string
    companyName: string
    score: number
    recommended: boolean
    scoreBypassed?: boolean
  }>
  status?: 'idle' | 'scanning' | 'matching' | 'applying' | 'pause' | 'done'
  message?: string
  dailyRemaining?: number
  filters?: Partial<ApplyFilters>
}

let isMinimized = false
let triggerBtn: HTMLDivElement | null = null
let activeHost: HTMLElement | null = null
let resizeListenerInstalled = false

const VIEWPORT_MARGIN = 8

function clampPanelToViewport(host: HTMLElement): void {
  if (!host.isConnected || host.style.display === 'none') return

  const rect = host.getBoundingClientRect()
  const maxLeft = Math.max(VIEWPORT_MARGIN, window.innerWidth - rect.width - VIEWPORT_MARGIN)
  const maxTop = Math.max(VIEWPORT_MARGIN, window.innerHeight - rect.height - VIEWPORT_MARGIN)
  const left = Math.min(Math.max(rect.left, VIEWPORT_MARGIN), maxLeft)
  const top = Math.min(Math.max(rect.top, VIEWPORT_MARGIN), maxTop)

  host.style.right = 'auto'
  host.style.left = `${left}px`
  host.style.top = `${top}px`
}

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
  const header = shadow.querySelector('.panel-header') as HTMLElement | null
  const btnMinimize = shadow.getElementById('btn-minimize')

  if (panel) panel.style.width = '320px'
  if (body) body.style.display = ''
  if (filterBar) filterBar.style.display = ''
  if (header) header.style.borderRadius = '16px 16px 0 0'
  if (btnMinimize) btnMinimize.textContent = '−'

  clampPanelToViewport(host)
  requestAnimationFrame(() => clampPanelToViewport(host))
}

function installPanelDragging(host: HTMLElement, header: HTMLElement): void {
  let draggingPointerId: number | null = null
  let offsetX = 0
  let offsetY = 0

  const stopDragging = (event: PointerEvent) => {
    if (draggingPointerId !== event.pointerId) return
    try {
      header.releasePointerCapture(event.pointerId)
    } catch {
      // Synthetic events and a pointer released outside the page may have no capture.
    }
    draggingPointerId = null
    document.body.style.userSelect = ''
  }

  header.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return
    if ((event.target as Element | null)?.closest('.header-actions')) return

    const rect = host.getBoundingClientRect()
    draggingPointerId = event.pointerId
    offsetX = event.clientX - rect.left
    offsetY = event.clientY - rect.top
    host.style.right = 'auto'
    host.style.left = `${rect.left}px`
    host.style.top = `${rect.top}px`
    document.body.style.userSelect = 'none'

    try {
      header.setPointerCapture(event.pointerId)
    } catch {
      // Synthetic pointer events used by browser tests do not create active pointers.
    }
    event.preventDefault()
  })

  window.addEventListener('pointermove', (event) => {
    if (draggingPointerId !== event.pointerId) return
    host.style.left = `${event.clientX - offsetX}px`
    host.style.top = `${event.clientY - offsetY}px`
    clampPanelToViewport(host)
  })
  window.addEventListener('pointerup', stopDragging)
  window.addEventListener('pointercancel', stopDragging)
}

export function createFloatingPanel(): HTMLElement {
  if (activeHost?.isConnected) {
    restoreFloatingPanel(activeHost)
    return activeHost
  }

  document.getElementById('boss-assistant-panel')?.remove()
  document.getElementById('boss-assistant-trigger')?.remove()
  triggerBtn = null

  const host = document.createElement('div')
  host.id = 'boss-assistant-panel'
  host.style.cssText = `
    position: fixed;
    top: 80px;
    right: 20px;
    z-index: 99999;
    font-family: 'PingFang SC', system-ui, sans-serif;
    transition: transform 0.3s ease, opacity 0.3s ease;
    max-width: calc(100vw - ${VIEWPORT_MARGIN * 2}px);
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
        <h3>智能求职助手</h3>
      </div>
      <div class="header-actions">
        <button class="btn-header" id="btn-minimize" title="最小化">−</button>
        <button class="btn-header" id="btn-close" title="关闭">&times;</button>
      </div>
    </div>
    <div class="filter-bar" id="filter-bar"></div>
    <div class="panel-body" id="panel-body">
      <div id="panel-content"></div>
    </div>
  `
  shadow.appendChild(panel)

  // Close handler
  shadow.getElementById('btn-close')?.addEventListener('click', () => {
    host.style.display = 'none'
    createFloatingTrigger(host)
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

  document.body.appendChild(host)
  activeHost = host
  isMinimized = false
  const header = shadow.querySelector('.panel-header') as HTMLElement
  installPanelDragging(host, header)
  if (!resizeListenerInstalled) {
    window.addEventListener('resize', () => {
      if (activeHost?.isConnected) clampPanelToViewport(activeHost)
    })
    resizeListenerInstalled = true
  }
  requestAnimationFrame(() => clampPanelToViewport(host))
  return host
}

function toggleMinimize(host: HTMLElement): void {
  const shadow = host.shadowRoot
  if (!shadow) return

  const panel = shadow.querySelector('.panel') as HTMLElement
  const body = shadow.getElementById('panel-body') as HTMLElement
  const header = shadow.querySelector('.panel-header') as HTMLElement
  const filterBar = shadow.getElementById('filter-bar') as HTMLElement
  const btnMinimize = shadow.getElementById('btn-minimize') as HTMLElement

  isMinimized = !isMinimized

  if (isMinimized) {
    body.style.display = 'none'
    filterBar.style.display = 'none'
    panel.style.width = '200px'
    header.style.borderRadius = '16px'
    btnMinimize.textContent = '+'
    host.style.cursor = 'pointer'
  } else {
    body.style.display = ''
    filterBar.style.display = ''
    panel.style.width = '320px'
    header.style.borderRadius = '16px 16px 0 0'
    btnMinimize.textContent = '−'
    host.style.cursor = ''
  }
}

// Floating trigger button shown after panel is closed
function createFloatingTrigger(host: HTMLElement): void {
  if (triggerBtn?.isConnected) return
  document.getElementById('boss-assistant-trigger')?.remove()
  triggerBtn = document.createElement('div')
  triggerBtn.id = 'boss-assistant-trigger'
  triggerBtn.style.cssText = `
    position: fixed;
    bottom: 24px;
    right: 24px;
    z-index: 99998;
    width: 48px;
    height: 48px;
    border-radius: 50%;
    background: linear-gradient(135deg, #6366F1, #8B5CF6);
    box-shadow: 0 4px 20px rgba(99, 102, 241, 0.4);
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    font-size: 20px;
    color: white;
    user-select: none;
    transition: transform 0.2s, box-shadow 0.2s;
  `
  triggerBtn.innerHTML = '🤖'
  triggerBtn.title = '打开智能求职助手'
  triggerBtn.addEventListener('click', () => {
    triggerBtn?.remove()
    triggerBtn = null
    restoreFloatingPanel(host)
  })
  triggerBtn.addEventListener('mouseenter', () => {
    triggerBtn!.style.transform = 'scale(1.1)'
    triggerBtn!.style.boxShadow = '0 6px 24px rgba(99, 102, 241, 0.6)'
  })
  triggerBtn.addEventListener('mouseleave', () => {
    triggerBtn!.style.transform = 'scale(1)'
    triggerBtn!.style.boxShadow = '0 4px 20px rgba(99, 102, 241, 0.4)'
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
  const { mode, stats, matchResults, status = 'idle', message, dailyRemaining, filters } = content
  const effectiveFilters: ApplyFilters = { ...DEFAULT_FILTERS, ...filters }

  // Update filter bar
  if (filterBar) {
    filterBar.innerHTML = buildFilterSummary(filters)
  }

  let statusText = ''
  let statusColor = '#10B981'
  const statusIcon: Record<string, string> = {
    idle: '○', scanning: '🔍', matching: '🧠', applying: '📨', pause: '⏸', done: '✅',
  }
  switch (status) {
    case 'idle': statusText = '就绪'; statusColor = '#6366F1'; break
    case 'scanning': statusText = '扫描岗位中...'; statusColor = '#F59E0B'; break
    case 'matching':
      statusText = effectiveFilters.enableAiMatch ? 'AI匹配分析中...' : '准备直投中...'
      statusColor = '#F59E0B'
      break
    case 'applying': statusText = '投递中...'; statusColor = '#10B981'; break
    case 'pause': statusText = '已暂停'; statusColor = '#EF4444'; break
    case 'done': statusText = '完成'; statusColor = '#10B981'; break
  }

  const progress = stats && stats.total > 0 ? (stats.processed / stats.total * 100) : 0
  const progressColor = status === 'done' ? '#10B981' : progress > 0 ? '#8B5CF6' : '#47476B'

  // Lock the delivery-mode / scoring toggles while a run is in progress — the
  // running loop has already captured its mode & filters, so mid-run changes
  // would be silently ignored and confuse the user.
  const lockToggles = status === 'scanning' || status === 'matching' || status === 'applying'
  const lockAttr = lockToggles ? 'disabled' : ''
  const lockHint = lockToggles ? ' title="扫描/投递进行中，无法切换"' : ''

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
    <div class="mode-toggle">
      <button class="mode-btn ${mode === 'batch' ? 'active' : ''}" data-mode="batch" ${lockAttr}${lockHint}>⚡ 批量投递</button>
      <button class="mode-btn ${mode === 'recommend' ? 'active' : ''}" data-mode="recommend" ${lockAttr}${lockHint}>🤔 AI推荐确认</button>
    </div>
    <div class="score-toggle">
      <button class="score-btn ${effectiveFilters.enableAiMatch ? 'active' : ''}" id="score-filter" ${lockAttr}${lockHint}>⭐ 按分筛选</button>
      <button class="score-btn ${effectiveFilters.enableAiMatch ? '' : 'active direct'}" id="score-direct" ${lockAttr}${lockHint}>🚀 不评分直投</button>
    </div>
    <div class="btn-row">
      ${status === 'idle' ? `<button class="btn btn-primary" id="btn-start">🚀 开始智能投递</button>` : ''}
      ${status === 'applying' ? `<button class="btn btn-danger" id="btn-stop">⏹ 停止</button>` : ''}
      ${status === 'done' ? `<button class="btn btn-primary" id="btn-start">🔄 继续投递</button>` : ''}
      ${status === 'pause' ? `<button class="btn btn-primary" id="btn-resume">▶ 继续投递</button>` : ''}
      ${status === 'scanning' || status === 'matching' ? `<button class="btn btn-danger" id="btn-stop">⏹ 停止</button>` : ''}
    </div>
    <div class="debug-row">
      <button class="debug-btn" id="btn-copy-card" title="复制首张岗位卡片HTML，用于排查公司名/职位描述提取">🐞 复制卡片HTML</button>
    </div>
    ${matchResults && matchResults.length > 0 ? buildMatchResults(matchResults) : ''}
  `

  // Button event listeners
  const btnStart = shadow.getElementById('btn-start')
  const btnStop = shadow.getElementById('btn-stop')
  const btnResume = shadow.getElementById('btn-resume')
  const scoreFilter = shadow.getElementById('score-filter')
  const scoreDirect = shadow.getElementById('score-direct')
  const modeBtns = shadow.querySelectorAll('.mode-btn')

  btnStart?.addEventListener('click', () => {
    window.postMessage({
      type: 'BOSS_ASSISTANT_START_APPLY',
      mode,
      filters: effectiveFilters,
    }, '*')
  })
  btnStop?.addEventListener('click', () => {
    window.postMessage({ type: 'BOSS_ASSISTANT_STOP_APPLY' }, '*')
  })
  btnResume?.addEventListener('click', () => {
    window.postMessage({
      type: 'BOSS_ASSISTANT_START_APPLY',
      mode,
      filters: effectiveFilters,
    }, '*')
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
}>): string {
  const list = matchResults.map((r) => {
    const color = r.score >= 70 ? '#10B981' : r.score >= 50 ? '#F59E0B' : '#EF4444'
    const title = escapeHtml(r.title)
    const company = escapeHtml(r.companyName || '未知公司')
    return `
      <div class="match-item">
        <div class="match-info">
          <span class="match-title" title="${title}">${title}</span>
          <span class="match-company" title="${company}">${company}</span>
        </div>
        <span class="match-score" style="color:${color}">${r.scoreBypassed ? '不判分' : `${r.score}分`}</span>
        <span class="tag ${r.recommended ? 'tag-rec' : 'tag-no-rec'}">${r.scoreBypassed ? '直投' : (r.recommended ? '推荐' : '待定')}</span>
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
    background: rgba(15,15,26,0.98);
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

function getStyles(): string {
  return `
    * { box-sizing: border-box; margin: 0; padding: 0; }

    @keyframes toastIn {
      from { opacity: 0; transform: translateY(8px); }
      to { opacity: 1; transform: translateY(0); }
    }

    .panel {
      background: rgba(15, 15, 26, 0.97);
      backdrop-filter: blur(24px);
      -webkit-backdrop-filter: blur(24px);
      border: 1px solid rgba(99, 102, 241, 0.15);
      border-radius: 16px;
      box-shadow: 0 8px 40px rgba(0, 0, 0, 0.5), 0 0 60px rgba(99, 102, 241, 0.08);
      overflow: hidden;
      width: 320px;
      max-width: calc(100vw - 16px);
      max-height: calc(100vh - 16px);
      display: flex;
      flex-direction: column;
      transition: width 0.3s ease, border-radius 0.3s ease;
    }

    .panel-header {
      background: linear-gradient(135deg, #6366F1 0%, #8B5CF6 100%);
      padding: 10px 14px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      cursor: move;
      touch-action: none;
      flex-shrink: 0;
    }
    .header-left {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .header-icon { font-size: 16px; }
    .panel-header h3 {
      color: white;
      font-size: 13px;
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
    .btn-header:hover { background: rgba(255,255,255,0.3); }

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
      background: rgba(99, 102, 241, 0.06);
      border-bottom: 1px solid rgba(255,255,255,0.04);
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
      background: rgba(255,255,255,0.06);
      color: #A1A1C0;
      border: 1px solid rgba(255,255,255,0.06);
    }
    .filter-tag-title { border-color: rgba(99,102,241,0.3); color: #A78BFA; }
    .filter-tag-loc { border-color: rgba(16,185,129,0.2); color: #6EE7B7; }
    .filter-tag-salary { border-color: rgba(245,158,11,0.3); color: #FCD34D; }
    .filter-tag-exclude { border-color: rgba(239,68,68,0.2); color: #FCA5A5; }
    .filter-tag-score { border-color: rgba(16,185,129,0.3); color: #10B981; }

    /* Body */
    .panel-body {
      padding: 12px 14px;
      max-height: 420px;
      min-height: 0;
      flex: 1 1 auto;
      overflow-y: auto;
      scrollbar-width: thin;
      scrollbar-color: rgba(255,255,255,0.1) transparent;
    }
    .panel-body::-webkit-scrollbar { width: 4px; }
    .panel-body::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.1); border-radius: 2px; }

    .stat-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 6px 0;
      border-bottom: 1px solid rgba(255,255,255,0.03);
    }
    .stat-label { color: #7B7BA0; font-size: 11px; }
    .stat-value, .stat-value-success { font-size: 13px; font-weight: 700; }
    .stat-value { color: #8B5CF6; }
    .stat-value-success { color: #10B981; }

    .panel-message {
      padding: 8px 0;
      color: #A1A1C0;
      font-size: 11px;
      line-height: 1.4;
    }

    .progress-bar {
      width: 100%;
      height: 4px;
      background: rgba(255,255,255,0.05);
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
      background: rgba(255,255,255,0.04);
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
      color: #6B6B8D;
      transition: all 0.2s;
      white-space: nowrap;
    }
    .mode-btn.active {
      background: rgba(99,102,241,0.2);
      color: #A78BFA;
    }
    .mode-btn:hover:not(.active) { color: #A1A1C0; }

    .score-toggle {
      display: flex;
      gap: 4px;
      padding: 3px;
      margin: -2px 0 8px;
      border-radius: 10px;
      background: rgba(255,255,255,0.04);
    }
    .score-btn {
      flex: 1;
      padding: 7px 6px;
      border: 1px solid transparent;
      border-radius: 8px;
      background: transparent;
      color: #6B6B8D;
      font-size: 11px;
      cursor: pointer;
      transition: all 0.2s;
    }
    .score-btn.active {
      color: #FCD34D;
      border-color: rgba(245,158,11,0.25);
      background: rgba(245,158,11,0.1);
    }
    .score-btn.active.direct {
      color: #6EE7B7;
      border-color: rgba(16,185,129,0.25);
      background: rgba(16,185,129,0.1);
    }

    /* Mode / scoring toggles are locked while a run is active. */
    .mode-btn:disabled,
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
      background: linear-gradient(135deg, #6366F1, #8B5CF6);
      color: white;
    }
    .btn-primary:hover { box-shadow: 0 0 20px rgba(99,102,241,0.4); transform: translateY(-1px); }
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
      border: 1px solid rgba(255,255,255,0.08);
      color: #6B6B8D;
      font-size: 10px;
      padding: 4px 8px;
      border-radius: 8px;
      cursor: pointer;
      transition: all 0.2s;
    }
    .debug-btn:hover { color: #A1A1C0; border-color: rgba(255,255,255,0.18); }

    .match-section {
      margin-top: 12px;
      padding-top: 8px;
      border-top: 1px solid rgba(255,255,255,0.05);
    }
    .match-header {
      color: #7B7BA0;
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
      color: #E2E2F0;
      font-size: 11px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      min-width: 0;
    }
    .match-company {
      color: #7B7BA0;
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
  `
}
