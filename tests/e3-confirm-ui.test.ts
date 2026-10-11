// E1+E3 浏览器验收：确认卡片渲染 + 面板浅色主题回归
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type BrowserContext, type Worker } from 'playwright'
import path from 'node:path'

const extensionPath = path.resolve('dist')
let context: BrowserContext
let serviceWorker: Worker

beforeAll(async () => {
  context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: false,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
  })
  serviceWorker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'))
})

afterAll(async () => {
  await context?.close()
})

describe('E3 confirm card E2E', () => {
  it('shows confirm card when confirm request is posted, and resolves on click', async () => {
    const page = await context.newPage()
    await page.route('https://www.zhipin.com/**', (route) => {
      route.fulfill({
        contentType: 'text/html; charset=utf-8',
        body: `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"></head>
        <body style="background:#F0F2F5;margin:0;color:#333">
          <div style="padding:20px"><h2>Boss 直聘 · 前端开发工程师</h2><p>深圳 · 3-5年 · 本科</p></div>
        </body></html>`,
      })
    })
    await page.goto('https://www.zhipin.com/web/geek/job?query=前端')
    await page.waitForSelector('#boss-assistant-panel', { timeout: 15_000 })

    // 触发确认卡片渲染（测试钩子）
    await page.evaluate(() => {
      window.postMessage({ type: 'BOSS_ASSISTANT_CONFIRM_TEST', desc: 'TEST:即将执行投递动作，请确认' }, '*')
    })
    await page.waitForTimeout(800)

    // 截图：确认卡片
    await page.screenshot({ path: '/tmp/ui-confirm-card.png' })

    // 断言确认卡片文本（vitest 无 Playwright matcher，用手动断言）
    const panel = page.locator('#boss-assistant-panel')
    await panel.getByText('需要确认').waitFor({ timeout: 5000 })
    expect(await panel.getByText('需要确认').isVisible()).toBe(true)
    expect(await panel.getByText('确认执行').isVisible()).toBe(true)
    expect(await panel.getByText('取消').isVisible()).toBe(true)

    // 点击确认 → 卡片消失、回到 applying
    await panel.getByText('确认执行').click()
    await page.waitForTimeout(500)
    expect(await panel.getByText('需要确认').count()).toBe(0)
    await page.close()
  }, 90_000)
})
