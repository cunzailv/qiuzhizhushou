// @vitest-environment jsdom
/**
 * 回归「显示投递成功，但手机上看不到聊天和投递记录」：
 * 三条投递链路过去都把 clickApplyButton() === true 当成成功，
 * 半自动链路甚至在没有招呼语输入框时也不阻断，于是落盘 / 去重 / 配额
 * 全部虚增。这里锁定「点击 != 平台确认」的判定契约与落盘顺序。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  decideApplyVerification,
  detectConfirmationSignals,
  detectBlockingSignals,
  isChatPageUrl,
  hasNewCommunicationUi,
  collectApplyPageTexts,
  CONFIRMATION_MARKERS,
  BLOCKING_MARKERS,
  type ApplyAttemptEvidence,
} from '../src/shared/agent/apply-verification'

const ROOT = process.cwd()
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf-8')

const evidence = (over: Partial<ApplyAttemptEvidence> = {}): ApplyAttemptEvidence => ({
  clicked: true,
  greetingSent: false,
  pageTexts: [],
  ...over,
})

describe('投递确认判定：点击不等于平台确认', () => {
  it('仅点击成功、页面零变化 → 未确认，且不写投递记录', () => {
    const v = decideApplyVerification(evidence())
    expect(v.level).toBe('unverified')
    expect(v.signals).toEqual([])
    expect(v.reason).toContain('不写投递记录')
    expect(v.reason).toContain('不计入投递数')
  })

  it('没点到按钮 → 平台未受理', () => {
    const v = decideApplyVerification(evidence({ clicked: false }))
    expect(v.level).toBe('blocked')
    expect(v.reason).toContain('未找到并点击')
  })

  it('点击后按钮变成「继续沟通」→ 平台已确认', () => {
    const v = decideApplyVerification(evidence({ pageTexts: ['继续沟通', '聊一聊'] }))
    expect(v.level).toBe('confirmed')
    expect(v.signals).toContain('继续沟通')
    expect(v.reason).toContain('平台确认依据')
  })

  it('点击前就已存在的「继续沟通」不算新证据（岗位之前投过）', () => {
    const v = decideApplyVerification(evidence({
      baselineTexts: ['继续沟通'],
      pageTexts: ['继续沟通'],
    }))
    expect(v.level).toBe('unverified')
  })

  it('点击前已有的旧文案 + 点击后新增确认文案 → 只认新增的', () => {
    const v = decideApplyVerification(evidence({
      baselineTexts: ['立即沟通', '已投递 3 个岗位'],
      postClickTexts: ['继续沟通'],
      pageTexts: ['继续沟通'],
    }))
    expect(v.level).toBe('confirmed')
    expect(v.signals).toContain('继续沟通')
  })

  it('阻断文案优先级高于确认信号', () => {
    const v = decideApplyVerification(evidence({
      pageTexts: ['继续沟通', '请先登录后操作'],
      greetingSent: true,
    }))
    expect(v.level).toBe('blocked')
    expect(v.blockers).toContain('请先登录')
    expect(v.signals).toEqual([])
  })

  it('风控 / 日限 / 职位下线都会阻断，不记成功', () => {
    for (const text of ['请完成安全验证', '操作过于频繁', '该职位已下线', '账号异常']) {
      expect(decideApplyVerification(evidence({ pageTexts: [text] })).level).toBe('blocked')
    }
  })

  it('出现新的沟通窗口 / 输入框 → 平台已确认', () => {
    expect(decideApplyVerification(evidence({ communicationUiChanged: true })).level).toBe('confirmed')
  })

  it('在新招呼语窗口填入话术并发送 → 平台已确认', () => {
    const v = decideApplyVerification(evidence({ greetingSent: true }))
    expect(v.level).toBe('confirmed')
    expect(v.signals.join('')).toContain('填入话术')
  })

  it('点完跳进平台聊天页 → 平台已确认', () => {
    expect(decideApplyVerification(evidence({ navigatedToChat: true })).level).toBe('confirmed')
  })

  it('确认依据全部列进 reason，用户能逐条核对', () => {
    const v = decideApplyVerification(evidence({
      greetingSent: true,
      communicationUiChanged: true,
      pageTexts: ['继续沟通'],
    }))
    expect(v.signals.length).toBeGreaterThanOrEqual(3)
    for (const signal of v.signals) expect(v.reason).toContain(signal)
  })
})

describe('文案标记与 URL / UI 快照辅助', () => {
  it('确认与阻断标记各自覆盖常见平台文案', () => {
    expect(detectConfirmationSignals(['已投递', '继续沟通'])).toEqual(
      expect.arrayContaining(['已投递', '继续沟通']),
    )
    expect(detectBlockingSignals(['请完成安全验证'])).toContain('请完成安全验证')
    expect(CONFIRMATION_MARKERS).toContain('简历已投递')
    expect(BLOCKING_MARKERS).toContain('今日沟通次数已用完')
  })

  it('空文本 / 空白文本不会命中', () => {
    expect(detectConfirmationSignals(['', '   '])).toEqual([])
  })

  it('沟通页 URL 识别，普通搜索页不误判', () => {
    expect(isChatPageUrl('https://www.zhipin.com/web/geek/chat?from=job')).toBe(true)
    expect(isChatPageUrl('https://www.zhipin.com/web/geek/job?query=php')).toBe(false)
    expect(isChatPageUrl('')).toBe(false)
  })

  it('UI 快照只认新增的输入框 / 弹窗', () => {
    const oldInput = document.createElement('textarea')
    const newInput = document.createElement('textarea')
    expect(hasNewCommunicationUi(
      { inputs: new Set([oldInput]) },
      { inputs: new Set([oldInput]) },
    )).toBe(false)
    expect(hasNewCommunicationUi(
      { inputs: new Set([oldInput]) },
      { inputs: new Set([oldInput, newInput]) },
    )).toBe(true)
    expect(hasNewCommunicationUi(null, { visibleDialogs: new Set([document.createElement('div')]) })).toBe(true)
  })
})

describe('页面文案采集', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('采集可见按钮与 toast，跳过明确隐藏的节点，并去重', () => {
    document.body.innerHTML = `
      <div id="detail">
        <button>立即沟通</button>
        <div class="toast-box" style="display:none">投递成功</div>
        <div class="toast-box">继续沟通</div>
      </div>`
    const texts = collectApplyPageTexts(document.querySelector('#detail'))
    expect(texts).toContain('立即沟通')
    expect(texts).toContain('继续沟通')
    expect(texts).not.toContain('投递成功')
    expect(new Set(texts).size).toBe(texts.length)
  })

  it('hidden 属性与 aria-hidden 容器内的文案不会被当成平台反馈', () => {
    document.body.innerHTML = `
      <div id="detail"><button>立即沟通</button></div>
      <div class="dialog" hidden>沟通成功</div>
      <div class="notice" aria-hidden="true">已投递</div>`
    const texts = collectApplyPageTexts(document.querySelector('#detail'))
    expect(texts).not.toContain('沟通成功')
    expect(texts).not.toContain('已投递')
  })
})

describe('静态契约：三条投递链路都必须先确认再落盘', () => {
  it('全自动 AIbot：确认判定在写投递记录 / 去重之前', () => {
    const src = read('src/content/task-runner.ts')
    const decision = src.indexOf('decideApplyVerification({')
    expect(decision).toBeGreaterThan(-1)
    expect(decision).toBeLessThan(src.indexOf('await saveApplicationRecord('))
    expect(decision).toBeLessThan(src.indexOf('await addSharedAppliedJobId('))
    expect(src).toContain("verification.level !== 'confirmed'")
    expect(src).toContain('greetingSent = await adapter.fillGreetingMessage')
  })

  it('半自动 / AI 自动确认：两处都接入确认层，且不落盘就返回 false', () => {
    const src = read('src/content/index.ts')
    expect((src.match(/decideApplyVerification\(\{/g) || []).length).toBe(2)
    expect(src).not.toContain('没有也不阻断')
    expect(src).toContain('reportUnverifiedApply(job, verification,')
    const firstDecision = src.indexOf('decideApplyVerification({')
    expect(firstDecision).toBeLessThan(src.indexOf('const saved = await saveApplication(job, match)'))
    // 未确认分支必须直接返回 false（不计入 appliedCount）
    expect(src).toContain('return false\n  }')
  })

  it('后台：只有 done 才写 L3「已投递」事件，未确认单独告警', () => {
    const src = read('src/background/campaign-service.ts')
    const doneBranch = src.indexOf("if (result.status === 'done')")
    const outcome = src.indexOf("kind: 'applied'")
    expect(doneBranch).toBeGreaterThan(-1)
    expect(outcome).toBeGreaterThan(doneBranch)
    expect(src).toContain('consecutiveUnverifiedMap')
    expect(src).toContain('未记为投递成功')
    expect(src).toContain('不落盘、不去重、不计配额')
  })

  it('成功日志带上平台确认依据，不再无条件宣称「投递成功」', () => {
    const src = read('src/background/campaign-service.ts')
    expect(src).toContain('result.verification?.reason')
  })
})
