/**
 * Popup 信息架构契约回归测试
 *
 * 方向：分层收纳、不删功能。首屏只回答「现在做什么 / 现在怎么样了」，
 * 低频设置进 Disclosure；E2E 依赖的按钮必须常驻可见（不能被折叠吞掉）。
 * 这里做静态源码契约校验，防止后续迭代把 47 个按钮重新堆回首屏。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf-8')

const CAMPAIGN = 'src/popup/components/CampaignPanel.tsx'
const BUTLER = 'src/popup/pages/Butler.tsx'
const DISCLOSURE = 'src/components/ui/disclosure.tsx'
const DASHBOARD = 'src/popup/pages/Dashboard.tsx'
const BATCH = 'src/popup/components/BatchControlCard.tsx'
const SHORTCUTS = 'src/popup/components/PlatformShortcuts.tsx'
const APP = 'src/popup/App.tsx'

/** 扫描 <Disclosure> 嵌套深度，同时统计控件总数与折叠控件数 */
function scan(rel: string) {
  const src = read(rel)
  const tag = /<Disclosure\b|<\/Disclosure>|<button\b|<input\b|<select\b|<textarea\b/g
  let depth = 0
  let total = 0
  let folded = 0
  let match: RegExpExecArray | null
  while ((match = tag.exec(src))) {
    if (match[0] === '<Disclosure') depth += 1
    else if (match[0] === '</Disclosure>') depth -= 1
    else {
      total += 1
      if (depth > 0) folded += 1
    }
  }
  return { src, depth, total, folded, visible: total - folded }
}

/**
 * 找出某个文案出现时所在的 Disclosure 深度。
 * 返回空数组表示文案压根不存在；含 0 表示至少有一处常驻。
 */
function depthsOf(src: string, label: string): number[] {
  const tag = /<Disclosure\b|<\/Disclosure>/g
  const out: number[] = []
  let depth = 0
  let cursor = 0
  let match: RegExpExecArray | null

  const collectUntil = (end: number) => {
    let pos = src.indexOf(label, cursor)
    while (pos !== -1 && pos < end) {
      out.push(depth)
      pos = src.indexOf(label, pos + label.length)
    }
  }

  while ((match = tag.exec(src))) {
    collectUntil(match.index)
    if (match[0] === '<Disclosure') depth += 1
    else depth -= 1
    cursor = match.index + match[0].length
  }
  collectUntil(src.length)
  return out
}

describe('分层收纳底座 · Disclosure', () => {
  const src = read(DISCLOSURE)

  it('折叠组件存在且默认收起', () => {
    expect(src).toContain('defaultOpen = false')
    expect(src).toContain('{open && (')
  })

  it('头部是无障碍按钮，展开态可被辅助技术识别', () => {
    expect(src).toContain('type="button"')
    expect(src).toContain('aria-expanded={open}')
    expect(src).toContain('setOpen((value) => !value)')
  })

  it('折叠组件自身不引入 slop（emoji / 渐变 / 毛玻璃 / 循环动效）', () => {
    expect(src).not.toMatch(/bg-gradient|backdrop-blur|animate-(spin|pulse|bounce)/)
    expect(/[\p{Emoji_Presentation}]/u.test(src)).toBe(false)
  })
})

describe('AIbot 面板 · 首屏只留关键动作', () => {
  const { src, depth, total, folded, visible } = scan(CAMPAIGN)

  it('Disclosure 标签成对闭合', () => {
    expect(depth).toBe(0)
    expect(total).toBeGreaterThan(0)
  })

  it('至少 15 个控件从首屏收进折叠组', () => {
    expect(folded).toBeGreaterThanOrEqual(15)
    expect(visible).toBeLessThan(total)
  })

  it('三个折叠组分别收纳复盘维护 / 平台配额 / 悬浮窗配置', () => {
    for (const label of ['复盘与维护工具', '平台与配额', '悬浮窗配置']) {
      expect(src).toContain(`label="${label}"`)
    }
  })

  it('E2E 依赖的按钮与文案必须常驻（深度 0）', () => {
    const critical = [
      '一键开跑 AIbot',
      '工作时段:',
      '每时每刻行为日志',
      '全自主无人值守队列',
      '免手动',
      '自定义投递工作时段',
      '24小时不限',
      '保存时段',
      '选择投递方式',
      '运行中',
    ]
    for (const label of critical) {
      expect(depthsOf(src, label), `常驻文案缺失：${label}`).toContain(0)
    }
  })

  it('低频动作的按钮确实在折叠组里，且功能一个没删', () => {
    // 用事件处理器定位按钮本身，避免把 toast 文案 / 注释误判成常驻控件
    const foldedHandlers = [
      'onClick={handleClearPending}',
      'onClick={handleTriggerAutoCollect}',
      'onClick={handleResetQuotas}',
      'onClick={checkAuth}',
      "onClick={() => onNavigateTab('butler')}",
      "onClick={() => updateAssistant({ applyMode: 'batch' })}",
      'onClick={() => handleAiMatchChange(true)}',
      'onClick={() => handlePanelState(\'closed\')}',
      'onClick={() => updateAssistant({ pinned: !assistant.pinned })}',
    ]
    for (const handler of foldedHandlers) {
      const depths = depthsOf(src, handler)
      expect(depths.length, `功能被删：${handler}`).toBeGreaterThan(0)
      expect(depths.every((d) => d > 0), `低频按钮没有收起：${handler}`).toBe(true)
    }

    for (const label of [
      '清空重获', '立即补仓', '恢复默认配额', '刷新授权',
      '管家日报', '策略进化', '整高侧栏', '半圆浮球',
      '停止并关闭 AIbot', '置顶常驻', '按分筛选', '不评分沟通',
    ]) {
      expect(src, `功能被删：${label}`).toContain(label)
    }
  })

  it('行为日志默认展开，实时流水仍可读取', () => {
    expect(src).toMatch(/const \[logExpanded, setLogExpanded\] = useState\(true\)/)
    expect(src).toContain('h-64 overflow-y-auto')
    expect(src).toContain('font-mono text-xs leading-relaxed')
  })
})

describe('管家页 · 常用视图常驻，低频视图与筛选收纳', () => {
  const { src, depth, folded } = scan(BUTLER)

  it('Disclosure 标签成对闭合，至少 10 个控件被折叠', () => {
    expect(depth).toBe(0)
    expect(folded).toBeGreaterThanOrEqual(10)
  })

  it('E2E 依赖的入口必须常驻', () => {
    for (const label of ['扫描跟进', '异常留痕', '对话中控', '跟进与留痕', '已处理']) {
      expect(depthsOf(src, label), `常驻入口缺失：${label}`).toContain(0)
    }
  })

  it('低频视图的导航按钮收进「更多视图」（注释 / 视图标题不算常驻入口）', () => {
    for (const tab of ['daily_report', 'evolution', 'fixes']) {
      const handler = `onClick={() => setSubTab('${tab}')}`
      const depths = depthsOf(src, handler)
      expect(depths.length, `视图入口被删：${tab}`).toBeGreaterThan(0)
      expect(depths.every((d) => d > 0), `视图入口没有收起：${tab}`).toBe(true)
    }
    for (const label of ['管家日报', '策略进化', '待修清单']) {
      expect(src).toContain(label)
    }
  })

  it('各视图的筛选与维护动作都有对应折叠组', () => {
    for (const label of [
      '更多视图',
      '报告明细',
      '闭环说明',
      '筛选提案',
      '维护操作',
      '按来源筛选',
      '导出与刷新',
    ]) {
      expect(src).toContain(`label="${label}"`)
    }
  })
})

describe('概览与外壳 · 重复信息只出现一次', () => {
  it('平台直达收进折叠，常驻首屏不再有 5 个平台卡', () => {
    const src = read(SHORTCUTS)
    expect(src).toContain('<Disclosure label="打开平台"')
    expect(src).not.toContain('BRAND_COLORS')
    expect(depthsOf(src, '<button')).not.toContain(0)
  })

  it('5 个统计卡改成一行紧凑数字', () => {
    const src = read(DASHBOARD)
    expect(src).toContain('grid grid-cols-5')
    expect(src).not.toContain('stat.icon')
    expect(src).toContain('今日投递')
  })

  it('半自动的模式切换收起，但开跑按钮常驻', () => {
    const src = read(BATCH)
    expect(src).toContain('label="更多设置"')
    expect(depthsOf(src, '开始批量沟通')).toContain(0)
  })

  it('头部一行放完品牌与平台状态，不再重复显示平台名', () => {
    const src = read(APP)
    expect(src).not.toContain('未检测到招聘平台页面')
    expect(src).toContain('aria-label="目标平台"')
    // 平台名只在下拉的「自动 · xxx」里渲染一次
    expect((src.match(/自动 · \$\{effectivePlatformName\}/g) || []).length).toBe(1)
    expect(src).not.toContain('岗位匹配 · 多平台投递 · 回复复盘')
  })
})
