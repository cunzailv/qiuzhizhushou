// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { dismissUnexpectedModals } from '../src/shared/platform/boss/action-simulator'

describe('自愈韧性智能体架构 · 页面阻塞脱困与意外弹窗遮罩强力解除 (dismissUnexpectedModals)', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    document.body.style.overflow = ''
    document.body.style.position = ''
    document.body.style.pointerEvents = ''
    document.body.className = ''
    document.documentElement.style.overflow = ''
    document.documentElement.style.pointerEvents = ''
  })

  afterEach(() => {
    document.body.innerHTML = ''
    document.body.style.overflow = ''
    document.body.style.position = ''
    document.body.style.pointerEvents = ''
    document.body.className = ''
    document.documentElement.style.overflow = ''
    document.documentElement.style.pointerEvents = ''
    vi.restoreAllMocks()
  })

  // ─────────────────────────────────────────────────────────────
  // 1. 标准负向与反馈弹窗关闭检验 (Dislike & Negative Dialogs)
  // ─────────────────────────────────────────────────────────────
  describe('1. 标准负向与反馈弹窗关闭检验', () => {
    it('1.1 通过 .btn-cancel 点击关闭“请选择不合适的原因”弹窗', () => {
      const dialog = document.createElement('div')
      dialog.className = 'dialog-wrap'
      dialog.innerHTML = `
        <div class="dialog-container">
          <h3>请选择不合适的原因</h3>
          <button class="btn-cancel">取消</button>
        </div>
      `
      Object.defineProperty(dialog, 'offsetWidth', { value: 300, configurable: true })
      Object.defineProperty(dialog, 'offsetHeight', { value: 200, configurable: true })
      document.body.appendChild(dialog)

      let cancelClicked = false
      dialog.querySelector('.btn-cancel')!.addEventListener('click', () => {
        cancelClicked = true
        dialog.remove()
      })

      const res = dismissUnexpectedModals(document)
      expect(res).toBe(true)
      expect(cancelClicked).toBe(true)
    })

    it('1.2 通过普通文本“取消”按钮关闭“为什么不合适”弹窗', () => {
      const dialog = document.createElement('div')
      dialog.className = 'boss-dialog'
      dialog.innerHTML = `
        <div class="dialog-box">
          <p>为什么不合适该职位？</p>
          <button class="custom-btn">取消</button>
        </div>
      `
      Object.defineProperty(dialog, 'offsetWidth', { value: 300, configurable: true })
      Object.defineProperty(dialog, 'offsetHeight', { value: 200, configurable: true })
      document.body.appendChild(dialog)

      let clicked = false
      dialog.querySelector('button')!.addEventListener('click', () => {
        clicked = true
        dialog.remove()
      })

      const res = dismissUnexpectedModals(document)
      expect(res).toBe(true)
      expect(clicked).toBe(true)
    })

    it('1.3 通过右上角 .icon-close 关闭“减少此类推荐”弹窗', () => {
      const dialog = document.createElement('div')
      dialog.className = 'dialog-lib-box'
      dialog.innerHTML = `
        <h3>减少此类推荐</h3>
        <span class="icon-close">×</span>
      `
      Object.defineProperty(dialog, 'offsetWidth', { value: 280, configurable: true })
      Object.defineProperty(dialog, 'offsetHeight', { value: 150, configurable: true })
      document.body.appendChild(dialog)

      let closeClicked = false
      dialog.querySelector('.icon-close')!.addEventListener('click', () => {
        closeClicked = true
        dialog.remove()
      })

      const res = dismissUnexpectedModals(document)
      expect(res).toBe(true)
      expect(closeClicked).toBe(true)
    })

    it('1.4 通过 unicode 字符“×”按钮关闭“不感兴趣”弹窗', () => {
      const dialog = document.createElement('div')
      dialog.className = 'boss-popup'
      dialog.innerHTML = `
        <h4>不感兴趣</h4>
        <button class="pure-symbol">×</button>
      `
      Object.defineProperty(dialog, 'offsetWidth', { value: 250, configurable: true })
      Object.defineProperty(dialog, 'offsetHeight', { value: 120, configurable: true })
      document.body.appendChild(dialog)

      let clicked = false
      dialog.querySelector('button')!.addEventListener('click', () => {
        clicked = true
        dialog.remove()
      })

      const res = dismissUnexpectedModals(document)
      expect(res).toBe(true)
      expect(clicked).toBe(true)
    })

    it('1.5 通过 aria-label="Close" 关闭“不想看该岗位”弹窗', () => {
      const dialog = document.createElement('div')
      dialog.setAttribute('role', 'dialog')
      dialog.innerHTML = `
        <div>不想看该职位</div>
        <button aria-label="Close this dialog">X</button>
      `
      Object.defineProperty(dialog, 'offsetWidth', { value: 300, configurable: true })
      Object.defineProperty(dialog, 'offsetHeight', { value: 180, configurable: true })
      document.body.appendChild(dialog)

      let clicked = false
      dialog.querySelector('button')!.addEventListener('click', () => {
        clicked = true
        dialog.remove()
      })

      const res = dismissUnexpectedModals(document)
      expect(res).toBe(true)
      expect(clicked).toBe(true)
    })

    it('1.6 识别“暂不”按钮并关闭“屏蔽该公司”弹窗', () => {
      const dialog = document.createElement('div')
      dialog.className = 'dialog-wrap'
      dialog.innerHTML = `
        <div>屏蔽该公司与相关职位</div>
        <button>暂不</button>
      `
      Object.defineProperty(dialog, 'offsetWidth', { value: 280, configurable: true })
      Object.defineProperty(dialog, 'offsetHeight', { value: 160, configurable: true })
      document.body.appendChild(dialog)

      let clicked = false
      dialog.querySelector('button')!.addEventListener('click', () => {
        clicked = true
        dialog.remove()
      })

      const res = dismissUnexpectedModals(document)
      expect(res).toBe(true)
      expect(clicked).toBe(true)
    })

    it('1.7 识别“放弃”按钮并关闭反馈弹窗', () => {
      const dialog = document.createElement('div')
      dialog.className = 'boss-dialog'
      dialog.innerHTML = `
        <div>选择原因以帮助我们优化</div>
        <a class="action-btn">放弃</a>
      `
      Object.defineProperty(dialog, 'offsetWidth', { value: 260, configurable: true })
      Object.defineProperty(dialog, 'offsetHeight', { value: 140, configurable: true })
      document.body.appendChild(dialog)

      let clicked = false
      dialog.querySelector('a')!.addEventListener('click', () => {
        clicked = true
        dialog.remove()
      })

      const res = dismissUnexpectedModals(document)
      expect(res).toBe(true)
      expect(clicked).toBe(true)
    })
  })

  // ─────────────────────────────────────────────────────────────
  // 2. 升级/推广/问卷/提示类干扰弹窗脱困检验
  // ─────────────────────────────────────────────────────────────
  describe('2. 升级/推广/问卷/提示类干扰弹窗脱困检验', () => {
    it('2.1 识别“新版本上线/系统升级”弹窗并通过“我知道了”关闭', () => {
      const dialog = document.createElement('div')
      dialog.className = 'dialog-wrap'
      dialog.innerHTML = `
        <h3>新版本上线通知</h3>
        <p>系统升级，全新页面布局体验</p>
        <button class="ok-btn">我知道了</button>
      `
      Object.defineProperty(dialog, 'offsetWidth', { value: 400, configurable: true })
      Object.defineProperty(dialog, 'offsetHeight', { value: 250, configurable: true })
      document.body.appendChild(dialog)

      let clicked = false
      dialog.querySelector('button')!.addEventListener('click', () => {
        clicked = true
        dialog.remove()
      })

      const res = dismissUnexpectedModals(document)
      expect(res).toBe(true)
      expect(clicked).toBe(true)
    })

    it('2.2 识别“下载APP”推广弹窗并通过“下次再说”关闭', () => {
      const dialog = document.createElement('div')
      dialog.className = 'boss-popup'
      dialog.innerHTML = `
        <h3>下载客户端体验更多功能</h3>
        <button>下次再说</button>
      `
      Object.defineProperty(dialog, 'offsetWidth', { value: 320, configurable: true })
      Object.defineProperty(dialog, 'offsetHeight', { value: 200, configurable: true })
      document.body.appendChild(dialog)

      let clicked = false
      dialog.querySelector('button')!.addEventListener('click', () => {
        clicked = true
        dialog.remove()
      })

      const res = dismissUnexpectedModals(document)
      expect(res).toBe(true)
      expect(clicked).toBe(true)
    })

    it('2.3 识别“求职安全提示/防骗提醒”并通过“知道了”关闭', () => {
      const dialog = document.createElement('div')
      dialog.className = 'dialog-box'
      dialog.innerHTML = `
        <h3>求职安全提醒</h3>
        <p>防骗提醒：凡收取押金、培训费均属违规</p>
        <button>知道了</button>
      `
      Object.defineProperty(dialog, 'offsetWidth', { value: 360, configurable: true })
      Object.defineProperty(dialog, 'offsetHeight', { value: 220, configurable: true })
      document.body.appendChild(dialog)

      let clicked = false
      dialog.querySelector('button')!.addEventListener('click', () => {
        clicked = true
        dialog.remove()
      })

      const res = dismissUnexpectedModals(document)
      expect(res).toBe(true)
      expect(clicked).toBe(true)
    })

    it('2.4 识别“求职体验调研/问卷”并通过“暂不参与”关闭', () => {
      const dialog = document.createElement('div')
      dialog.className = 'dialog-wrap'
      dialog.innerHTML = `
        <h3>满意度评价与问卷调研</h3>
        <button>暂不参与</button>
      `
      Object.defineProperty(dialog, 'offsetWidth', { value: 350, configurable: true })
      Object.defineProperty(dialog, 'offsetHeight', { value: 210, configurable: true })
      document.body.appendChild(dialog)

      let clicked = false
      dialog.querySelector('button')!.addEventListener('click', () => {
        clicked = true
        dialog.remove()
      })

      const res = dismissUnexpectedModals(document)
      expect(res).toBe(true)
      expect(clicked).toBe(true)
    })

    it('2.5 识别包含 SVG 关闭图标的“新人礼包/活动详情”推广弹窗', () => {
      const dialog = document.createElement('div')
      dialog.className = 'boss-dialog'
      dialog.innerHTML = `
        <h3>新人专享活动详情</h3>
        <button class="svg-close-btn">
          <svg><path d="M0 0 L10 10" /></svg>
        </button>
      `
      Object.defineProperty(dialog, 'offsetWidth', { value: 300, configurable: true })
      Object.defineProperty(dialog, 'offsetHeight', { value: 200, configurable: true })
      document.body.appendChild(dialog)

      let clicked = false
      dialog.querySelector('button')!.addEventListener('click', () => {
        clicked = true
        dialog.remove()
      })

      const res = dismissUnexpectedModals(document)
      expect(res).toBe(true)
      expect(clicked).toBe(true)
    })
  })

  // ─────────────────────────────────────────────────────────────
  // 3. 全屏与半透明遮罩层强力清除检验 (Mask & Backdrop Purge)
  // ─────────────────────────────────────────────────────────────
  describe('3. 全屏与半透明遮罩层强力清除检验', () => {
    it('3.1 清理孤立的 .dialog-mask 遮罩', () => {
      const mask = document.createElement('div')
      mask.className = 'dialog-mask'
      Object.defineProperty(mask, 'offsetWidth', { value: 1920, configurable: true })
      Object.defineProperty(mask, 'offsetHeight', { value: 1080, configurable: true })
      document.body.appendChild(mask)

      const res = dismissUnexpectedModals(document)
      expect(res).toBe(true)
      expect(mask.style.display).toBe('none')
    })

    it('3.2 清理孤立的 .modal-backdrop 与 .v-modal 遮罩', () => {
      const m1 = document.createElement('div')
      m1.className = 'modal-backdrop'
      const m2 = document.createElement('div')
      m2.className = 'v-modal'
      for (const m of [m1, m2]) {
        Object.defineProperty(m, 'offsetWidth', { value: 1000, configurable: true })
        Object.defineProperty(m, 'offsetHeight', { value: 800, configurable: true })
        document.body.appendChild(m)
      }

      const res = dismissUnexpectedModals(document)
      expect(res).toBe(true)
      expect(m1.style.display).toBe('none')
      expect(m2.style.display).toBe('none')
    })

    it('3.3 清理 Ant Design 与 Element Plus 遮罩 (.ant-modal-mask, .el-overlay)', () => {
      const antMask = document.createElement('div')
      antMask.className = 'ant-modal-mask'
      const elOverlay = document.createElement('div')
      elOverlay.className = 'el-overlay'
      for (const m of [antMask, elOverlay]) {
        Object.defineProperty(m, 'offsetWidth', { value: 1200, configurable: true })
        Object.defineProperty(m, 'offsetHeight', { value: 900, configurable: true })
        document.body.appendChild(m)
      }

      const res = dismissUnexpectedModals(document)
      expect(res).toBe(true)
      expect(antMask.style.display).toBe('none')
      expect(elOverlay.style.display).toBe('none')
    })

    it('3.4 一次性清除多个多重嵌套与堆叠遮罩', () => {
      const m1 = document.createElement('div')
      m1.className = 'dialog-mask'
      const m2 = document.createElement('div')
      m2.className = 'modal-backdrop'
      const m3 = document.createElement('div')
      m3.className = 'v-modal'
      const m4 = document.createElement('div')
      m4.className = 'mask'
      for (const m of [m1, m2, m3, m4]) {
        Object.defineProperty(m, 'offsetWidth', { value: 500, configurable: true })
        Object.defineProperty(m, 'offsetHeight', { value: 500, configurable: true })
        document.body.appendChild(m)
      }

      const res = dismissUnexpectedModals(document)
      expect(res).toBe(true)
      expect(m1.style.display).toBe('none')
      expect(m2.style.display).toBe('none')
      expect(m3.style.display).toBe('none')
      expect(m4.style.display).toBe('none')
    })

    it('3.5 清除高 z-index (>= 1000) 的无类名固定全屏阻塞 div', () => {
      const fixedOverlay = document.createElement('div')
      fixedOverlay.style.position = 'fixed'
      fixedOverlay.style.zIndex = '9999'
      Object.defineProperty(fixedOverlay, 'offsetWidth', { value: 1920, configurable: true })
      Object.defineProperty(fixedOverlay, 'offsetHeight', { value: 1080, configurable: true })
      document.body.appendChild(fixedOverlay)

      const res = dismissUnexpectedModals(document)
      expect(res).toBe(true)
      expect(fixedOverlay.style.display).toBe('none')
    })
  })

  // ─────────────────────────────────────────────────────────────
  // 4. Body 滚动锁死与指针冻结复原检验 (Viewport Reset)
  // ─────────────────────────────────────────────────────────────
  describe('4. Body 滚动锁死与指针冻结复原检验', () => {
    it('4.1 自动解除 document.body.style.overflow = "hidden"', () => {
      document.body.style.overflow = 'hidden'

      const res = dismissUnexpectedModals(document)
      expect(res).toBe(true)
      expect(document.body.style.overflow).toBe('')
    })

    it('4.2 自动解除 document.documentElement.style.overflow = "hidden"', () => {
      document.documentElement.style.overflow = 'hidden'

      const res = dismissUnexpectedModals(document)
      expect(res).toBe(true)
      expect(document.documentElement.style.overflow).toBe('')
    })

    it('4.3 自动解除 document.body.style.position = "fixed"', () => {
      document.body.style.position = 'fixed'

      const res = dismissUnexpectedModals(document)
      expect(res).toBe(true)
      expect(document.body.style.position).toBe('')
    })

    it('4.4 自动解除 document.body.style.pointerEvents = "none"', () => {
      document.body.style.pointerEvents = 'none'

      const res = dismissUnexpectedModals(document)
      expect(res).toBe(true)
      expect(document.body.style.pointerEvents).toBe('')
    })

    it('4.5 自动移除 modal-open / dialog-open / has-modal 等滚动锁类名', () => {
      document.body.classList.add('modal-open', 'dialog-open', 'has-modal')

      const res = dismissUnexpectedModals(document)
      expect(res).toBe(true)
      expect(document.body.classList.contains('modal-open')).toBe(false)
      expect(document.body.classList.contains('dialog-open')).toBe(false)
      expect(document.body.classList.contains('has-modal')).toBe(false)
    })
  })

  // ─────────────────────────────────────────────────────────────
  // 5. 正向流程保护检验 (Zero False Positives)
  // ─────────────────────────────────────────────────────────────
  describe('5. 正向流程保护检验', () => {
    it('5.1 严禁误关正常的打招呼开聊弹窗 (.chat-dialog)', () => {
      const chatDialog = document.createElement('div')
      chatDialog.className = 'chat-dialog'
      chatDialog.innerHTML = `
        <h3>打招呼内容</h3>
        <textarea class="chat-input">您好，对贵司岗位很感兴趣！</textarea>
      `
      Object.defineProperty(chatDialog, 'offsetWidth', { value: 450, configurable: true })
      Object.defineProperty(chatDialog, 'offsetHeight', { value: 320, configurable: true })
      document.body.appendChild(chatDialog)

      const res = dismissUnexpectedModals(document)
      expect(chatDialog.style.display).not.toBe('none')
      expect(res).toBe(false)
    })

    it('5.2 严禁误关包含打招呼富文本编辑器的 modal', () => {
      const modal = document.createElement('div')
      modal.setAttribute('role', 'dialog')
      modal.innerHTML = `
        <div class="header">向HR打个招呼</div>
        <div contenteditable="true">您好！</div>
      `
      Object.defineProperty(modal, 'offsetWidth', { value: 400, configurable: true })
      Object.defineProperty(modal, 'offsetHeight', { value: 300, configurable: true })
      document.body.appendChild(modal)

      dismissUnexpectedModals(document)
      expect(modal.style.display).not.toBe('none')
    })

    it('5.3 存在正常打招呼弹窗时，不清理其正向遮罩', () => {
      const chatDialog = document.createElement('div')
      chatDialog.className = 'chat-dialog'
      chatDialog.innerHTML = '<h3>打招呼</h3><textarea></textarea>'
      Object.defineProperty(chatDialog, 'offsetWidth', { value: 400, configurable: true })
      Object.defineProperty(chatDialog, 'offsetHeight', { value: 300, configurable: true })
      document.body.appendChild(chatDialog)

      const mask = document.createElement('div')
      mask.className = 'dialog-mask'
      Object.defineProperty(mask, 'offsetWidth', { value: 1920, configurable: true })
      Object.defineProperty(mask, 'offsetHeight', { value: 1080, configurable: true })
      document.body.appendChild(mask)

      dismissUnexpectedModals(document)
      expect(mask.style.display).not.toBe('none')
    })

    it('5.4 严禁误杀真实安全风控滑块验证 (geetest / 滑块验证)', () => {
      const captcha = document.createElement('div')
      captcha.setAttribute('role', 'dialog')
      captcha.innerHTML = `
        <div class="geetest_holder">
          <p>请完成安全验证（滑动滑块拼合图像）</p>
        </div>
      `
      Object.defineProperty(captcha, 'offsetWidth', { value: 350, configurable: true })
      Object.defineProperty(captcha, 'offsetHeight', { value: 250, configurable: true })
      document.body.appendChild(captcha)

      dismissUnexpectedModals(document)
      expect(captcha.style.display).not.toBe('none')
    })

    it('5.5 严禁误杀沟通上限警报弹窗（留给风控系统感知并停止）', () => {
      const limitDialog = document.createElement('div')
      limitDialog.className = 'boss-dialog'
      limitDialog.innerHTML = `
        <h3>今日沟通次数已达上限</h3>
        <p>今日已与多位BOSS沟通，请明天再来</p>
      `
      Object.defineProperty(limitDialog, 'offsetWidth', { value: 320, configurable: true })
      Object.defineProperty(limitDialog, 'offsetHeight', { value: 200, configurable: true })
      document.body.appendChild(limitDialog)

      dismissUnexpectedModals(document)
      expect(limitDialog.style.display).not.toBe('none')
    })
  })

  // ─────────────────────────────────────────────────────────────
  // 6. 多阶降级兜底与对抗边界检验 (Fallback & Robustness)
  // ─────────────────────────────────────────────────────────────
  describe('6. 多阶降级兜底与对抗边界检验', () => {
    it('6.1 按钮点击报错时，顺利降级触发 ESC 键盘事件', () => {
      const dialog = document.createElement('div')
      dialog.className = 'dialog-wrap'
      dialog.innerHTML = `
        <h3>为什么不合适</h3>
        <button class="broken-btn">取消</button>
      `
      Object.defineProperty(dialog, 'offsetWidth', { value: 300, configurable: true })
      Object.defineProperty(dialog, 'offsetHeight', { value: 200, configurable: true })
      document.body.appendChild(dialog)

      let escTriggered = false
      dialog.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          escTriggered = true
          dialog.remove()
        }
      })
      dialog.querySelector('button')!.onclick = () => {
        throw new Error('Simulated click failure')
      }

      const errorHandler = (e: any) => {
        if (e?.message?.includes('Simulated click failure') || e?.error?.message?.includes('Simulated click failure')) {
          e.preventDefault?.()
        }
      }
      window.addEventListener('error', errorHandler)

      try {
        const res = dismissUnexpectedModals(document)
        expect(res).toBe(true)
        expect(escTriggered).toBe(true)
      } finally {
        window.removeEventListener('error', errorHandler)
      }
    })

    it('6.2 没有任何关闭按钮且忽略 ESC 时，强制设置 display = "none"', () => {
      const dialog = document.createElement('div')
      dialog.className = 'dialog-wrap'
      dialog.innerHTML = '<p>为什么不合适（没有任何取消或关闭按钮）</p>'
      Object.defineProperty(dialog, 'offsetWidth', { value: 300, configurable: true })
      Object.defineProperty(dialog, 'offsetHeight', { value: 200, configurable: true })
      document.body.appendChild(dialog)

      const res = dismissUnexpectedModals(document)
      expect(res).toBe(true)
      expect(dialog.style.display).toBe('none')
    })

    it('6.3 空文档或干净页面返回 false 且绝不抛出任何异常', () => {
      expect(() => {
        const res = dismissUnexpectedModals(document)
        expect(res).toBe(false)
      }).not.toThrow()
    })

    it('6.4 忽略尺寸为 0 (offsetWidth=0, offsetHeight=0) 的隐藏弹窗', () => {
      const hiddenDialog = document.createElement('div')
      hiddenDialog.className = 'dialog-wrap'
      hiddenDialog.innerHTML = '<h3>请选择不合适的原因</h3>'
      Object.defineProperty(hiddenDialog, 'offsetWidth', { value: 0, configurable: true })
      Object.defineProperty(hiddenDialog, 'offsetHeight', { value: 0, configurable: true })
      document.body.appendChild(hiddenDialog)

      const res = dismissUnexpectedModals(document)
      expect(res).toBe(false)
    })

    it('6.5 幂等性检验：连续调用两次，第一次返回 true，第二次返回 false', () => {
      const mask = document.createElement('div')
      mask.className = 'dialog-mask'
      Object.defineProperty(mask, 'offsetWidth', { value: 500, configurable: true })
      Object.defineProperty(mask, 'offsetHeight', { value: 500, configurable: true })
      document.body.appendChild(mask)

      const first = dismissUnexpectedModals(document)
      expect(first).toBe(true)

      const second = dismissUnexpectedModals(document)
      expect(second).toBe(false)
    })

    it('6.6 传入 null 或 undefined doc 防御：优雅返回 false', () => {
      expect(() => {
        const res = dismissUnexpectedModals(null as any)
        expect(res).toBe(false)
      }).not.toThrow()
    })
  })
})
