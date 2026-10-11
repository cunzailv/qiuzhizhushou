// H 层后台浏览器验收：错误日志卡 + 反馈自进化（投递拒绝回流提升方向）
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

async function openNav(page: Page, label: string, waitText: string): Promise<void> {
  await page.locator(`aside button:has-text("${label}")`).first().click()
  await page.waitForSelector(`text=${waitText}`, { timeout: 10_000 })
}

async function seedTable(page: Page, table: string, rows: unknown[]): Promise<void> {
  await page.evaluate(async ({ table, rows }) => {
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open('BossZhipinAssistant')
      req.onerror = () => reject(req.error)
      req.onsuccess = () => {
        const db = req.result
        const tx = db.transaction(table, 'readwrite')
        const store = tx.objectStore(table)
        for (const r of rows) store.put(r)
        tx.oncomplete = () => { db.close(); resolve() }
        tx.onerror = () => reject(tx.error)
      }
    })
  }, { table, rows })
}

async function clearTable(page: Page, table: string): Promise<void> {
  await page.evaluate(async ({ table }) => {
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open('BossZhipinAssistant')
      req.onerror = () => reject(req.error)
      req.onsuccess = () => {
        const db = req.result
        const tx = db.transaction(table, 'readwrite')
        tx.objectStore(table).clear()
        tx.oncomplete = () => { db.close(); resolve() }
        tx.onerror = () => reject(tx.error)
      }
    })
  }, { table })
}

describe('H 层后台 E2E', () => {
  it('设置页：错误日志卡展示注入的错误并展开', async () => {
    const page = await context.newPage()
    await openOptions(page)
    await openNav(page, '设置', '启用 AI 评分筛选')

    // 前置清理，保证唯一一条注入
    await clearTable(page, 'errors')
    const now = new Date().toISOString()
    await seedTable(page, 'errors', [
      { id: 'h-test-err-1', createdAt: now, source: 'ai.api', message: 'chatCompletion HTTP 500: server boom', stack: 'at fetch (test)' },
    ])

    await page.reload()
    await page.waitForSelector('text=求职数据看板', { timeout: 15_000 })
    await openNav(page, '设置', '启用 AI 评分筛选')

    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
    await page.waitForTimeout(500)

    await page.getByText(/错误日志（\d+）/).first().waitFor({ timeout: 10_000 })
    await page.getByText('chatCompletion HTTP 500: server boom').waitFor({ timeout: 10_000 })
    await page.getByText('ai.api').first().waitFor()
    await page.screenshot({ path: '/tmp/ui-h-errors.png' })
    await clearTable(page, 'errors')
    await page.close()
  }, 90_000)

  it('反馈自进化：投递标为拒绝后，记忆中心提升方向 +1', async () => {
    const page = await context.newPage()
    await openOptions(page)

    // 注入一条投递记录（含匹配理由），并保证提升方向为空
    await clearTable(page, 'careerProfiles')
    await clearTable(page, 'applications')
    await clearTable(page, 'resumes')
    const now = new Date().toISOString()
    await seedTable(page, 'applications', [
      {
        id: 'h-test-app-1', jobTitle: '前端工程师', companyName: '反馈测试公司',
        status: 'applied', matchReason: '岗位要求 React 与性能优化经验，简历项目偏业务开发',
        notes: '', platformId: 'boss', appliedAt: now, updatedAt: now,
      },
    ])
    await seedTable(page, 'careerProfiles', [
      { id: 'default', updatedAt: now, currentRole: '前端开发', yearsOfExperience: 3, skills: [{ name: 'React', level: '熟练' }], improvementDirections: [], status: 'seeking' },
    ])

    // popup Tracker：展开记录并把状态改为「不合适」
    const extensionId = new URL(serviceWorker.url()).host
    const popup = await context.newPage()
    await popup.goto(`chrome-extension://${extensionId}/src/popup/index.html`)
    await popup.waitForSelector('text=概览', { timeout: 15_000 })
    await popup.getByText('追踪', { exact: true }).click()
    await popup.getByText('反馈测试公司', { exact: true }).waitFor({ timeout: 10_000 })
    await popup.getByText('反馈测试公司', { exact: true }).click()
    await popup.locator('button:has-text("不合适")').last().click()
    await popup.waitForTimeout(800)
    await popup.screenshot({ path: '/tmp/ui-h-feedback.png' })
    await popup.close()

    // 仪表盘（默认页）职业状态卡应出现「来自投递反馈」的提升方向
    const page2 = await context.newPage()
    await openOptions(page2)
    await page2.waitForSelector('text=职业状态', { timeout: 10_000 })
    await page2.waitForTimeout(500)
    await page2.getByText('来自投递反馈：').waitFor({ timeout: 10_000 })
    await page2.getByText(/复盘：/).first().waitFor({ timeout: 10_000 })
    await page2.screenshot({ path: '/tmp/ui-h-evolved.png' })

    await clearTable(page2, 'applications')
    await clearTable(page2, 'careerProfiles')
    await page2.close()
  }, 120_000)
})
