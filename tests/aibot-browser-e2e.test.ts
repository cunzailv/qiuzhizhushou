import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type BrowserContext, type Worker } from 'playwright'
import path from 'node:path'

const extensionPath = path.resolve('dist')
let context: BrowserContext
let serviceWorker: Worker
const browserLogs: string[] = []

beforeAll(async () => {
  context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: false,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
  })

  serviceWorker = context.serviceWorkers()[0]
    ?? await context.waitForEvent('serviceworker')
  serviceWorker.on('console', (message) => browserLogs.push(`[worker] ${message.text()}`))
}, 30_000)

afterAll(async () => {
  await context?.close()
}, 30_000)

describe('AIbot browser real E2E test', () => {
  it('opens popup, modifies time windows and starts AIbot campaign with live action logs', async () => {
    const extensionId = new URL(serviceWorker.url()).host
    const popupPage = await context.newPage()
    await popupPage.goto(`chrome-extension://${extensionId}/src/popup/index.html`)

    // 等待页面渲染并点击 AIbot Tab
    const aibotTab = popupPage.getByRole('button', { name: /AIbot/ })
    await aibotTab.waitFor({ timeout: 10_000 })
    await aibotTab.click()

    // 验证 AIbot 页面主元素已出现
    await popupPage.getByText('AIbot 全自动投递流水线').waitFor({ timeout: 5000 })
    await popupPage.getByText('每时每刻行为日志').waitFor({ timeout: 5000 })

    // 验证全自主无人值守队列提示出现，且彻底移除了手动从当前页面提取职位的按钮
    await popupPage.getByText('全自主无人值守队列').waitFor({ timeout: 5000 })
    await popupPage.getByText('免手动').waitFor({ timeout: 5000 })
    expect(await popupPage.locator('button', { hasText: '提取职位' }).count()).toBe(0)

    // 1. 测试时段修改交互：点击展开时段编辑器
    const timeEditBtn = popupPage.locator('button', { hasText: '工作时段:' })
    await timeEditBtn.waitFor({ timeout: 5000 })
    await timeEditBtn.click()

    // 验证时段编辑区域展开，并点击「24小时不限」预设
    await popupPage.getByText('自定义投递工作时段').waitFor({ timeout: 5000 })
    await popupPage.getByText('24小时不限').click()

    // 点击「保存时段」
    await popupPage.getByText('保存时段').click()

    // 等待 500ms
    await popupPage.waitForTimeout(500)

    // 验证保存后标签显示更新为「24小时不限」或 00:00-23:59
    const timeBtnText = await timeEditBtn.textContent()
    expect(timeBtnText).toContain('00:00-23:59')

    // 2. 点击「一键开跑 AIbot」
    const startBtn = popupPage.getByText('一键开跑 AIbot')
    await startBtn.waitFor({ timeout: 5000 })
    await startBtn.click()

    // 验证状态变为「运行中」
    await popupPage.getByText('运行中').waitFor({ timeout: 5000 })

    // 3. 验证行为日志流实时有输出（有流水日志跳出，且绝不误报已达上限）
    await expect.poll(async () => {
      const logsText = await popupPage.locator('div.font-mono').textContent()
      return logsText || ''
    }, { timeout: 10_000 }).toMatch(/🚀|🔍|🌐|已启动|自动连接|扫描采集/)

    const allLogs = await popupPage.locator('div.font-mono').textContent()
    expect(allLogs).not.toContain('当前无待执行任务或启用平台均已达上限')

    // 4. 验证管家 Agent 的「异常留痕」诊断中心
    const butlerTab = popupPage.getByRole('button', { name: '管家', exact: true })
    await butlerTab.click()
    await popupPage.getByText('异常留痕').waitFor({ timeout: 5000 })
    await popupPage.getByText('异常留痕').click()
    await popupPage.getByText('异常留痕与诊断中心').waitFor({ timeout: 5000 })
    await popupPage.getByText(/共 \d+ 条记录/).waitFor({ timeout: 5000 })

    await popupPage.close()
  }, 30_000)
})
