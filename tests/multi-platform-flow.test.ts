// 多平台适配 E2E：51job / 智联 / 脉脉
// 用 Playwright 加载 dist 扩展，route mock 三平台列表页（依据真实调研 DOM 结构），
// 验证：平台识别 → 列表解析 → 详情描述提取 → 本地匹配 → 投递动作 → applications 入库（platformId 正确）。
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type BrowserContext, type Worker } from 'playwright'
import path from 'node:path'

const extensionPath = path.resolve('dist')
let context: BrowserContext
let serviceWorker: Worker
const browserLogs: string[] = []

const RESUME_META = {
  id: 'resume-1',
  name: '测试用户',
  fileName: 'resume.pdf',
  skills: ['React', 'TypeScript', 'JavaScript', 'HTML', 'CSS', 'Node.js'],
  yearsOfExperience: 3,
  hasFullData: true,
  updatedAt: '2026-07-26T00:00:00.000Z',
}

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
          summary: 'React TypeScript JavaScript HTML CSS Node.js 前端工程师',
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

async function readAppliedPlatforms(): Promise<string[]> {
  return serviceWorker.evaluate(async () => {
    return new Promise<string[]>((resolve, reject) => {
      const request = indexedDB.open('BossZhipinAssistant')
      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        const transaction = request.result.transaction('applications', 'readonly')
        const getAll = transaction.objectStore('applications').getAll()
        getAll.onerror = () => reject(getAll.error)
        getAll.onsuccess = () => resolve((getAll.result ?? []).map((app) => app.platformId).filter(Boolean))
      }
    })
  })
}

describe('multi-platform flow', () => {
  it('51job: parses .joblist cards, extracts detail, applies and persists with platformId', async () => {
    await seedResume()
    const page = await context.newPage()
    page.on('console', (message) => browserLogs.push(`[page51] ${message.text()}`))
    await page.route('https://we.51job.com/**', async (route) => {
      await route.fulfill({
        headers: { 'content-type': 'text/html; charset=utf-8' },
        body: `<!doctype html><html><body>
          <div class="joblist">
            <div class="joblist-item" data-jobid="job51-001">
              <div class="joblist-item-left">
                <div class="joblist-item-jobname"><div class="job-info text-cut">前端工程师（AI方向）</div></div>
                <div class="joblist-item-jobinfo text-cut">20-30万·14薪<div class="area">上海·浦东新区</div></div>
                <div class="joblist-item-tags"><span class="tag">React</span><span class="tag">TypeScript</span><span class="tag">Vue</span></div>
              </div>
              <div class="joblist-item-right">裕太微电子股份有限公司</div>
              <button>投递</button>
            </div>
          </div>
          <script>
            document.querySelector('.joblist-item').addEventListener('click', function (event) {
              if (event.target.tagName === 'BUTTON') {
                document.body.dataset.applied51 = document.querySelector('.joblist-item-jobname').textContent.trim()
                return
              }
              const desc = document.createElement('div')
              desc.className = 'job_msg'
              desc.innerHTML = '<h1>前端工程师（AI方向）</h1><p>React TypeScript JavaScript HTML CSS Node.js 负责前端开发</p>'
              const apply = document.createElement('button')
              apply.textContent = '投递'
              apply.addEventListener('click', function () {
                document.body.dataset.applied51 = 'detail-apply'
              })
              document.body.append(desc, apply)
            })
          </script>
        </body></html>`,
      })
    })
    await page.goto('https://we.51job.com/pc/search?keyword=%E5%89%8D%E7%AB%AF')
    await expect.poll(() => page.locator('#boss-assistant-panel').count(), { timeout: 10_000 }).toBe(1)
    await triggerApply('https://we.51job.com/*')
    await expect.poll(async () => {
      const v = await page.locator('body').getAttribute('data-applied51')
      return v !== null && v.length > 0
    }, { timeout: 30_000 }).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 1500))
    expect(await readAppliedPlatforms(), JSON.stringify(browserLogs, null, 2)).toContain('51job')
    await page.close()
  }, 60_000)

  it('zhaopin: parses .job-card list + detail panel, applies via .job-detail-summary__apply', async () => {
    await seedResume()
    const page = await context.newPage()
    page.on('console', (message) => browserLogs.push(`[pageZp] ${message.text()}`))
    await page.route('https://www.zhaopin.com/**', async (route) => {
      await route.fulfill({
        headers: { 'content-type': 'text/html; charset=utf-8' },
        body: `<!doctype html><html><body>
          <div class="job-card" data-jobid="zp-1001">
            <div class="job-card__title-row"><div class="job-card__title-main">Web前端开发工程师</div></div>
            <div class="job-card__salary">20K-30K</div>
            <div class="job-card__skill-tags"><span class="job-card__skill-tag">React</span><span class="job-card__skill-tag">TypeScript</span><span class="job-card__skill-tag">Node.js</span></div>
            <div class="job-card__company-row">中科创达软件股份有限公司</div>
          </div>
          <script>
            document.querySelector('.job-card').addEventListener('click', function () {
              const panel = document.createElement('div')
              panel.className = 'job-detail-panel'
              panel.innerHTML = [
                '<h1 class="job-detail-summary__title-text">Web前端开发工程师</h1>',
                '<span class="job-detail-summary__salary">20K-30K</span>',
                '<div class="job-detail-summary__main">深圳·南山区 经验不限 本科 中科创达软件股份有限公司</div>',
                '<div class="job-description">岗位职责：负责公司前端平台开发，使用 React、TypeScript、JavaScript、HTML、CSS、Node.js 技术栈，参与前端框架应用与全栈开发，与产品、后端协作交付高质量 Web 应用。任职要求：熟悉前端开发，3年以上相关经验优先。</div>',
                '<button class="job-detail-summary__apply">立即投递</button>'
              ].join('')
              panel.querySelector('.job-detail-summary__apply').addEventListener('click', function () {
                document.body.dataset.appliedZp = panel.querySelector('.job-detail-summary__title-text').textContent.trim()
              })
              document.body.append(panel)
            })
          </script>
        </body></html>`,
      })
    })
    await page.goto('https://www.zhaopin.com/jobs?jl=765&kw=%E5%89%8D%E7%AB%AF')
    await expect.poll(() => page.locator('#boss-assistant-panel').count(), { timeout: 10_000 }).toBe(1)
    await triggerApply('https://www.zhaopin.com/*')
    const zpApplied = await page.waitForFunction(() => document.body.dataset.appliedZp, null, { timeout: 20_000 })
      .catch(() => null)
    expect(zpApplied, `ZP_BROWSER_LOGS:\n${browserLogs.slice(-60).join('\n')}`).not.toBeNull()
    await new Promise((resolve) => setTimeout(resolve, 1500))
    expect(await readAppliedPlatforms(), JSON.stringify(browserLogs, null, 2)).toContain('zhaopin')
    await page.close()
  }, 60_000)

  it('maimai: parses job cards, communicates via 沟通 button, persists with platformId', async () => {
    await seedResume()
    const page = await context.newPage()
    page.on('console', (message) => browserLogs.push(`[pageMai] ${message.text()}`))
    await page.route('https://maimai.cn/**', async (route) => {
      await route.fulfill({
        headers: { 'content-type': 'text/html; charset=utf-8' },
        body: `<!doctype html><html><body>
          <div class="job-card" data-jobid="mm-777">
            <div class="job-card-title">前端开发工程师</div>
            <div class="job-card-salary">25-40K</div>
            <div class="job-card-company">字节跳动</div>
            <div class="job-card-tags"><span class="tag">React</span><span class="tag">TypeScript</span></div>
          </div>
          <script>
            document.querySelector('.job-card').addEventListener('click', function () {
              const panel = document.createElement('div')
              panel.className = 'job-detail'
              panel.innerHTML = '<div class="job-description">岗位职责：负责前端平台开发，使用 React、TypeScript、JavaScript、HTML、CSS、Node.js 技术栈，参与前端框架应用开发，与后端协作交付高质量 Web 应用。任职要求：熟悉前端开发。</div>'
              const chat = document.createElement('button')
              chat.textContent = '沟通'
              chat.addEventListener('click', function () {
                document.body.dataset.appliedMai = '沟通-clicked'
                const input = document.createElement('textarea')
                input.className = 'chat-input'
                document.body.append(input)
              })
              document.body.append(panel, chat)
            })
          </script>
        </body></html>`,
      })
    })
    await page.goto('https://maimai.cn/web/search_center?type=job&query=%E5%89%8D%E7%AB%AF')
    await expect.poll(() => page.locator('#boss-assistant-panel').count(), { timeout: 10_000 }).toBe(1)
    await triggerApply('https://maimai.cn/*')
    const mmApplied = await page.waitForFunction(() => document.body.dataset.appliedMai, null, { timeout: 20_000 })
      .catch(() => null)
    expect(mmApplied, `MM_BROWSER_LOGS:\n${browserLogs.slice(-70).join('\n')}`).not.toBeNull()
    await new Promise((resolve) => setTimeout(resolve, 1500))
    expect(await readAppliedPlatforms(), JSON.stringify(browserLogs, null, 2)).toContain('maimai')
    await page.close()
  }, 60_000)
})
