// @vitest-environment jsdom
// 风控误报回归：整页文本扫描会把「岗位描述里出现验证码字样」当成真验证码，
// 导致 AIbot 被挂起、用户却看不到任何验证码。
import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  detectCaptcha,
  detectBlock,
  detectRateLimit,
  scanRisk,
} from '../src/shared/antiBot/risk-detector'

const BOSS_MARKERS = ['请完成安全验证', '滑动验证', '验证码', '安全验证', '校验']
const BOSS_BLOCK = ['账号异常', '账号被封', '检测到异常', '账号已被', '暂时无法', '被限制']
const BOSS_RATE = ['操作频繁', '操作太频繁', '稍后再试', '请稍后', '重试']

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('验证码检测 detectCaptcha', () => {
  it('岗位描述里出现「验证码」字样不应判定为验证码弹窗', () => {
    document.body.innerHTML = `
      <div class="job-detail">
        <h1>PHP开发工程师</h1>
        <p>负责公司短信验证码平台的后端开发，熟悉滑块验证码接入优先。</p>
        <p>技术栈：PHP / Laravel / MySQL / Redis</p>
      </div>`
    expect(detectCaptcha(BOSS_MARKERS)).toBe(false)
  })

  it('页脚出现「安全验证」不应误判', () => {
    document.body.innerHTML = `<div class="job-list">职位列表</div><footer>账号安全验证说明</footer>`
    expect(detectCaptcha(BOSS_MARKERS)).toBe(false)
  })

  it('真实可见的验证码容器应判定为命中', () => {
    document.body.innerHTML = `<div class="geetest_panel">拖动滑块完成拼图</div>`
    expect(detectCaptcha(BOSS_MARKERS)).toBe(true)
  })

  it('隐藏的验证码容器不应触发挂起', () => {
    document.body.innerHTML = `<div class="captcha-box" style="display:none">请完成验证</div>`
    expect(detectCaptcha(BOSS_MARKERS)).toBe(false)
  })

  it('可见浮层内出现验证提示应判定为命中', () => {
    document.body.innerHTML = `
      <div class="job-list">职位列表</div>
      <div class="dialog-wrap">请完成安全验证后继续</div>`
    expect(detectCaptcha(BOSS_MARKERS)).toBe(true)
  })
})

describe('封号检测 detectBlock', () => {
  it('正常长页面提到「账号异常」不应误判封号', () => {
    const filler = '岗位职责与任职要求描述。'.repeat(80)
    document.body.innerHTML = `
      <div class="job-list">
        <h1>系统运维工程师</h1>
        <p>${filler}</p>
        <p>需熟悉账号异常排查流程。</p>
      </div>`
    expect(detectBlock(BOSS_BLOCK)).toBe(false)
  })

  it('整页只剩错误文案时判定封号', () => {
    document.body.innerHTML = `<div class="err">账号异常，暂时无法访问</div>`
    expect(detectBlock(BOSS_BLOCK)).toBe(true)
  })

  it('浮层内出现封号文案时判定封号', () => {
    const filler = '正常岗位内容。'.repeat(100)
    document.body.innerHTML = `
      <div class="job-list">${filler}</div>
      <div class="dialog-box">检测到异常，账号已被限制</div>`
    expect(detectBlock(BOSS_BLOCK)).toBe(true)
  })
})

describe('频率限制检测 detectRateLimit', () => {
  it('错误提示节点内出现「操作过于频繁」判定命中', () => {
    document.body.innerHTML = `<div class="error-tips">操作过于频繁，请稍后再试</div>`
    expect(detectRateLimit(BOSS_RATE)).toBe(true)
  })

  it('正常页面提到「稍后再试」不应误判', () => {
    const filler = '岗位描述内容。'.repeat(120)
    document.body.innerHTML = `<div class="job-list">${filler}如遇问题请稍后再试。</div>`
    expect(detectRateLimit(BOSS_RATE)).toBe(false)
  })
})

describe('综合风控扫描 scanRisk', () => {
  it('干净页面返回 null', () => {
    document.body.innerHTML = `<div class="job-list"><div>PHP开发工程师</div></div>`
    expect(scanRisk({ dailyLimitMarkers: [], rateLimitMarkers: BOSS_RATE, blockMarkers: BOSS_BLOCK, captchaMarkers: BOSS_MARKERS, id: 'boss', name: 'Boss直聘' } as any)).toBeNull()
  })

  it('真实验证码弹窗返回 captcha 信号', () => {
    document.body.innerHTML = `<div class="modal">请完成安全验证</div>`
    const signal = scanRisk({
      dailyLimitMarkers: [],
      rateLimitMarkers: BOSS_RATE,
      blockMarkers: BOSS_BLOCK,
      captchaMarkers: BOSS_MARKERS,
      id: 'boss',
      name: 'Boss直聘',
    } as any)
    expect(signal?.type).toBe('captcha')
  })
})

describe('真实浏览器 innerText 行为对齐', () => {
  it('元素有 innerText 时优先使用（jsdom 下回退 textContent）', () => {
    const el = document.createElement('div')
    el.className = 'modal'
    el.textContent = '占位文本'
    Object.defineProperty(el, 'innerText', { value: '请完成安全验证', configurable: true })
    document.body.appendChild(el)
    expect(detectCaptcha(BOSS_MARKERS)).toBe(true)
  })
})
