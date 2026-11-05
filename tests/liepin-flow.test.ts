// 猎聘平台 E2E（真实 Chromium + 加载 dist 扩展 + page.route 注入的 fixture 页面）
//
// 重要边界：这里验证的是「扩展在真实浏览器里对猎聘 DOM 结构的识别与投递链路」，
// 不是真实 liepin.com 站点实测。页面由 page.route 拦截返回内联 HTML，
// 不需要登录、不访问真实站点、不产生真实投递。猎聘真实选择器仍需真站校准。
//
// 复用 tests/multi-platform-flow.test.ts 的 setup 与 helper 模式。
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type BrowserContext, type Worker } from 'playwright'
import path from 'node:path'

const extensionPath = path.resolve('dist')
let context: BrowserContext
let serviceWorker: Worker
const browserLogs: string[] = []

const LIEPIN_FIXTURE = `<!doctype html><html><body>
  <div class="job-list-wrap">
    <a data-nick="job-detail-job-info" href="https://www.liepin.com/a/77558891.shtml">
      <div class="ellipsis-1" title="前端开发工程师">前端开发工程师</div>
      <div class="ellipsis-1">深圳</div>
      <span>25K-40K</span>
      <span>3-5年</span>
      <span>本科</span>
    </a>
    <div data-nick="job-detail-company-info">
      <span class="ellipsis-1">方圆宝科技有限公司</span>
    </div>
    <div class="recruiter-info-box">
      <div class="ellipsis-1">王经理</div>
      <button class="chat-trigger" style="display:none">聊一聊</button>
    </div>
  </div>
  <script type="application/ld+json">
    {"@type":"JobPosting","description":"负责订单与库存模块，使用 React TypeScript"}
  </script>
  <script>
    document.querySelector('.chat-trigger').addEventListener('click', function () {
      document.body.dataset.liepinChat = 'clicked'
    })
  </script>
</body></html>`

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

async function seedResume() {
  await serviceWorker.evaluate(async () => {
    await chrome.storage.local.clear()
    await chrome.storage.local.set({
      shared_default_resume_meta: {
        id: 'resume-1',
        name: '测试用户',
        fileName: 'resume.pdf',
        skills: ['React', 'TypeScript', 'JavaScript', 'HTML', 'CSS', 'Node.js'],
        yearsOfExperience: 3,
        hasFullData: true,
        updatedAt: '2026-07-26T00:00:00.000Z',
      },
      shared_default_resume_full: {
        id: 'resume-1',
        name: '测试用户',
        fileName: 'resume.pdf',
        fileType: 'pdf',
        rawText: 'React TypeScript JavaScript HTML CSS Node.js',
        structuredData: {
          name: '测试用户',
          email: 'test@example.com',
          phone: '13800138000',
          education: [],
          workExperience: [],
          skills: ['React', 'TypeScript', 'JavaScript', 'HTML', 'CSS', 'Node.js'],
          projects: [],
          summary: 'React TypeScript 前端工程师',
          yearsOfExperience: 3,
        },
        aiAnalysis: null,
        isDefault: true,
        createdAt: '2026-07-26T00:00:00.000Z',
        updatedAt: '2026-07-26T00:00:00.000Z',
      },
    })
  })
}

async function triggerApply(urlPattern: string) {
  await serviceWorker.evaluate(async (pattern) => {
    const [tab] = await chrome.tabs.query({ url: pattern })
    if (!tab?.id) throw new Error(`fixture tab not found for ${pattern}`)
    await chrome.tabs.sendMessage(tab.id, {
      type: 'EXECUTE_APPLY',
      payload: {
        mode: 'batch',
        filters: {
          jobTitles: '',
          locations: '',
          salaryMin: null,
          salaryMax: null,
          experience: '',
          education: '',
          excludeKeywords: '',
          enableAiMatch: true,
          minMatchScore: 60,
        },
      },
    })
  }, urlPattern)
}

/** 投递过程中 MV3 service worker 可能被重启，读取时始终取当前实例 */
async function currentWorker(): Promise<Worker> {
  return context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker')
}

async function readAppliedPlatforms(): Promise<string[]> {
  const worker = await currentWorker()
  return worker.evaluate(async () => {
    return new Promise<string[]>((resolve, reject) => {
      const request = indexedDB.open('BossZhipinAssistant')
      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        const transaction = request.result.transaction('applications', 'readonly')
        const getAll = transaction.objectStore('applications').getAll()
        getAll.onerror = () => reject(getAll.error)
        getAll.onsuccess = () => resolve(
          (getAll.result ?? []).map((app) => app.platformId).filter(Boolean),
        )
      }
    })
  })
}

describe('猎聘 E2E · fixture 页面', () => {
  it('加载扩展后识别猎聘列表页并注入浮窗，卡片 DOM 可被解析', async () => {
    await seedResume()
    const page = await context.newPage()
    page.on('console', (message) => browserLogs.push(`[pageLiepin] ${message.text()}`))
    await page.route('https://www.liepin.com/**', async (route) => {
      await route.fulfill({
        headers: { 'content-type': 'text/html; charset=utf-8' },
        body: LIEPIN_FIXTURE,
      })
    })
    await page.goto('https://www.liepin.com/zhaopin/?key=前端')

    await expect.poll(
      () => page.locator('#boss-assistant-panel').count(),
      { timeout: 10_000 },
    ).toBe(1)
    expect(page.url()).toContain('liepin.com')
    expect(await page.locator('a[data-nick="job-detail-job-info"]').count()).toBe(1)
    expect(await page.locator('a[data-nick="job-detail-job-info"] .ellipsis-1[title]').first().getAttribute('title'))
      .toBe('前端开发工程师')
    await page.close()
  }, 30_000)

  it('触发投递后 hover 出「聊一聊」并点击，applications 记录 platformId=liepin', async () => {
    await seedResume()
    const page = await context.newPage()
    page.on('console', (message) => browserLogs.push(`[pageLiepinApply] ${message.text()}`))
    await page.route('https://www.liepin.com/**', async (route) => {
      await route.fulfill({
        headers: { 'content-type': 'text/html; charset=utf-8' },
        body: LIEPIN_FIXTURE,
      })
    })
    await page.goto('https://www.liepin.com/zhaopin/?key=前端')
    await expect.poll(
      () => page.locator('#boss-assistant-panel').count(),
      { timeout: 10_000 },
    ).toBe(1)

    await triggerApply('https://www.liepin.com/*')

    // 「聊一聊」默认隐藏，适配器需 hover 后强制显示并点击
    await expect.poll(
      () => page.locator('body').getAttribute('data-liepin-chat'),
      { timeout: 45_000 },
    ).toBe('clicked')

    // 投递流水线写库略晚于按钮点击；全量并发运行时耗时更长，
    // service worker 重启时重试而非直接失败
    let lastPlatforms: string[] = []
    await expect.poll(
      async () => {
        try {
          lastPlatforms = await readAppliedPlatforms()
          return lastPlatforms.includes('liepin')
        } catch {
          return false
        }
      },
      { timeout: 60_000, interval: 1000 },
    ).toBe(true)
    expect(
      lastPlatforms,
      `applications 未记录 liepin。BROWSER_LOGS:\n${browserLogs.slice(-60).join('\n')}`,
    ).toContain('liepin')
    await page.close()
  }, 120_000)
})
