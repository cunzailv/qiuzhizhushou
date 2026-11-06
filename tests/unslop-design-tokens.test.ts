/**
 * unslop 设计契约回归测试
 *
 * 方向：招聘档案 / 仪表刻度 —— 冷调石墨中性表面、单一压暗橙 accent、
 * 安静的 chrome、只在 AIbot 投递刻度与真实数字上出现颜色。
 * 这里只做静态源码契约校验，防止后续迭代把 slop 重新加回来。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf-8')

function collect(rel: string, exts: string[]): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) walk(full)
      else if (exts.some((ext) => entry.endsWith(ext))) out.push(full)
    }
  }
  walk(join(ROOT, rel))
  return out
}

/** 只看用户真正看得见的界面层，日志 / 通知文案不在此列 */
const UI_FILES = [
  ...collect('src/popup', ['.tsx']),
  ...collect('src/options', ['.tsx']),
  ...collect('src/components', ['.tsx']),
  ...collect('src/content', ['.tsx', '.css']),
]
const uiBlob = () => UI_FILES.map((file) => readFileSync(file, 'utf-8')).join('\n')

/** 允许保留的安静排版符号：勾选、几何状态点、箭头、省略号 */
const QUIET_SYMBOLS = new Set('✓✖✗○●◐→←↑↓‖·—…'.split(''))

function countEmojiIcons(blob: string): number {
  let count = 0
  for (const ch of blob) {
    if (ch.codePointAt(0)! <= 0x2000) continue
    // Unicode So / Sk 即各类 emoji 与装饰符号
    const isSymbol = /[\p{So}\p{Sk}]/u.test(ch)
    if (isSymbol && !QUIET_SYMBOLS.has(ch)) count += 1
  }
  return count
}

describe('unslop 设计底座', () => {
  it('色板只有一条中性 ramp 与唯一 accent，primary 全系列收敛到同一色', () => {
    const cfg = read('tailwind.config.js')
    expect(cfg).toContain("DEFAULT: '#C2410C'")
    expect(cfg).toContain("soft: '#FFF4ED'")
    expect(cfg).toContain("page: '#F5F7FA'")
    // 旧的亮橙 / 蓝橙渐变 / 彩色发光不再存在
    expect(cfg).not.toMatch(/#FF7A2F|#F97316|#FB923C|135deg|rgba\(249, 115, 22/)
    // primary 兼容别名全部指向 accent，避免出现第二个强调色
    expect(cfg).toMatch(/primary:\s*\{[^}]*DEFAULT: '#C2410C'[^}]*light: '#C2410C'/s)
  })

  it('全局组件类不含毛玻璃、发光、跨色相渐变，并保留签名刻度线', () => {
    const css = read('src/assets/styles/globals.css')
    expect(css).not.toMatch(/backdrop-blur|shadow-glow|bg-gradient|bg-clip-text/)
    expect(css).toContain('.queue-rule')
    expect(css).toContain('.queue-rule-fill')
    // 中性滚动条与可见焦点环
    expect(css).toContain(':focus-visible')
    expect(css).not.toMatch(/rgba\(99, 102, 241/)
  })

  it('界面层不再有 emoji 图标与装饰符号', () => {
    expect(countEmojiIcons(uiBlob())).toBe(0)
  })

  it('界面层没有 12px 以下小字、600 以上字重与 transition-all', () => {
    const blob = uiBlob()
    expect(blob).not.toMatch(/text-\[(?:9|10|11)px\]/)
    expect(blob).not.toMatch(/font-(?:bold|semibold|extrabold|black)/)
    expect(blob).not.toContain('transition-all')
  })

  it('界面层没有跨色相渐变、彩色发光与毛玻璃', () => {
    const blob = uiBlob()
    expect(blob).not.toMatch(/bg-gradient|linear-gradient|radial-gradient|bg-clip-text/)
    expect(blob).not.toMatch(/shadow-glow|drop-shadow|backdrop-blur|backdrop-filter|glass-/)
  })

  it('界面层没有无意义循环动效', () => {
    const blob = uiBlob()
    expect(blob).not.toMatch(/animate-pulse|animate-ping|animate-bounce|infinite;|@keyframes pulse/)
    // loading 的 animate-spin 属于解释性动效，允许保留
  })

  it('签名刻度线真正用在 AIbot 与批量控制卡上', () => {
    expect(read('src/popup/components/CampaignPanel.tsx')).toContain('queue-rule')
    expect(read('src/popup/components/BatchControlCard.tsx')).toContain('queue-rule')
    expect(read('src/components/ui/progress.tsx')).toContain('queue-rule')
  })

  it('页面注入侧栏的头部与按钮已去掉渐变与彩色发光', () => {
    const injected = read('src/content/inject-ui.tsx')
    expect(injected).not.toMatch(/linear-gradient|rgba\(249, 115, 22|blur\(/)
    expect(injected).not.toContain('backdrop-filter')
    expect(injected).toContain('background: #111827')
  })
})
