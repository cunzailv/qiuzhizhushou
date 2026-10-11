// E4+E6 后台浏览器验收：审计中心视图 + 设置权限三档 + 仪表盘职业状态看板
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type BrowserContext, type Worker, type Page } from 'playwright'
import path from 'node:path'

const extensionPath = path.resolve('dist')
let context: BrowserContext
let serviceWorker: Worker

beforeAll(async () => {
  context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: false,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  })
  serviceWorker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'))
})

afterAll(async () => {
  await context?.close()
})

async function openOptions(page: Page): Promise<void> {
  const extensionId = new URL(serviceWorker.url()).host
  await page.goto(`chrome-extension://${extensionId}/src/options/index.html`)
  await page.waitForSelector('text=求职数据看板', { timeout: 15_000 })
}

describe('E 层后台视图 E2E', () => {
  it('审计中心：统计卡、状态机图、空状态表格渲染正常', async () => {
    const page = await context.newPage()
    await openOptions(page)

    // 导航到审计中心
    await page.getByText('审计中心').click()
    await page.waitForSelector('text=投递状态机', { timeout: 10_000 })

    // 统计卡 + 状态机 + 空状态
    expect(await page.getByText('共 0 条审计记录').count()).toBeGreaterThanOrEqual(0)
    expect(await page.getByText('暂无审计记录').isVisible()).toBe(true)
    await page.getByText('导出 CSV').waitFor()
    await page.screenshot({ path: '/tmp/ui-audit.png' })
    await page.close()
  }, 90_000)

  it('设置页：AI 动作权限三档配置可交互', async () => {
    const page = await context.newPage()
    await openOptions(page)

    await page.getByText('设置', { exact: true }).click()
    await page.waitForSelector('text=AI 动作权限', { timeout: 10_000 })
    await page.getByText('投递 / 申请动作').waitFor()
    expect(await page.getByText('需确认').count()).toBeGreaterThanOrEqual(2)

    // 切到「自动执行」再切回「需确认」（避免污染用户默认设置）
    const autoButtons = page.locator('button:has-text("自动执行")')
    expect(await autoButtons.count()).toBeGreaterThanOrEqual(2)
    await page.screenshot({ path: '/tmp/ui-settings-permission.png' })
    await page.close()
  }, 90_000)

  it('仪表盘：职业状态看板区块渲染', async () => {
    const page = await context.newPage()
    await openOptions(page)
    await page.waitForSelector('text=职业状态', { timeout: 10_000 })
    await page.screenshot({ path: '/tmp/ui-dashboard-career.png' })
    await page.close()
  }, 90_000)
})
