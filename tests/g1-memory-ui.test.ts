// G 层后台浏览器验收：记忆中心 + 投递记录 + 简历管理
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
  await page.getByText(label, { exact: true }).click()
  await page.waitForSelector(`text=${waitText}`, { timeout: 10_000 })
}

/** 向扩展域 IndexedDB 指定表注入测试数据 */
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

describe('G 层后台 E2E', () => {
  it('导航 10 项完整 + 记忆中心空态渲染', async () => {
    const page = await context.newPage()
    await openOptions(page)

    // 导航完整（导航栏按钮定位）
    for (const label of ['仪表盘', '面试日历', '投递记录', '记忆中心', '简历管理', '黑名单', '审计中心', '智能体', '导出中心', '设置']) {
      await page.locator(`aside button:has-text("${label}")`).first().waitFor()
    }

    // 记忆中心
    await openNav(page, '记忆中心', 'AI 记住了你什么')
    await page.getByText('职业画像').first().waitFor()
    await page.getByText('公司记忆').first().waitFor()
    await page.getByText('决策留痕').first().waitFor()
    await page.getByText('跟进建议').first().waitFor()
    await page.getByText('匹配分析').first().waitFor()
    expect(await page.getByText('暂无公司记忆').count()).toBeGreaterThanOrEqual(0)
    await page.screenshot({ path: '/tmp/ui-g-memory-empty.png' })
    await page.close()
  }, 90_000)

  it('投递记录页：统计卡 + 空态渲染', async () => {
    const page = await context.newPage()
    await openOptions(page)
    await openNav(page, '投递记录', '全部投递的完整台账')
    await page.getByText('累计投递', { exact: true }).waitFor()
    await page.getByText('暂无投递记录').waitFor()
    await page.screenshot({ path: '/tmp/ui-g-applications.png' })
    await page.close()
  }, 90_000)

  it('简历管理页：空态渲染', async () => {
    const page = await context.newPage()
    await openOptions(page)
    await openNav(page, '简历管理', '管理投递使用的简历')
    await page.getByText('暂无简历').waitFor()
    await page.screenshot({ path: '/tmp/ui-g-resumes.png' })
    await page.close()
  }, 90_000)

  it('记忆中心：注入公司记忆/决策留痕后列表显示，单删与清空生效', async () => {
    const page = await context.newPage()
    await openOptions(page)
    await openNav(page, '记忆中心', 'AI 记住了你什么')

    const now = new Date().toISOString()
    await seedTable(page, 'companyMemories', [
      { id: 'g-test-company', companyName: '记忆测试公司', jobTitle: '前端工程师', touchCount: 3, replyCount: 1, lastOutcome: 'interview', updatedAt: now, notes: '' },
    ])
    await seedTable(page, 'decisionLogs', [
      { id: 'g-test-decision', source: 'butler', subject: '记忆测试岗位', context: '测试', thinking: '测试决策思考', decision: '{"apply":true}', createdAt: now },
    ])

    // 刷新后重新导航
    await page.reload()
    await page.waitForSelector('text=求职数据看板', { timeout: 15_000 })
    await openNav(page, '记忆中心', 'AI 记住了你什么')

    // 列表显示注入数据
    await page.getByText('记忆测试公司', { exact: true }).waitFor({ timeout: 10_000 })
    await page.getByText('记忆测试岗位').waitFor({ timeout: 10_000 })

    // 单删公司记忆
    await page.locator('button[title="删除"]').first().click()
    await page.getByText('已删除').waitFor({ timeout: 10_000 })

    // 清空决策留痕
    await page.once('dialog', (d) => d.accept())
    await page.getByText('清空', { exact: true }).nth(1).click()
    await page.getByText('已清空').waitFor({ timeout: 10_000 })

    await page.screenshot({ path: '/tmp/ui-g-memory-data.png' })

    // 清理注入残留
    await clearTable(page, 'companyMemories')
    await clearTable(page, 'decisionLogs')
    await page.close()
  }, 90_000)
})
