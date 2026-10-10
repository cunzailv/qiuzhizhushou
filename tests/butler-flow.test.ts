// B 层 E2E：管家 Agent 全链路（跟进扫描 → 建议入库 → 决策留痕 → popup 展示）
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type BrowserContext } from 'playwright'

describe('butler agent flow', () => {
  let context: BrowserContext

  beforeAll(async () => {
    context = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      headless: false,
      args: [
        `--disable-extensions-except=${process.cwd()}/dist`,
        `--load-extension=${process.cwd()}/dist`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-infobars',
        '--disable-features=Translate,AcceptCHFrame',
      ],
    })
  }, 30_000)

  afterAll(async () => {
    await context?.close()
  }, 30_000)

  it('butler daily scan generates follow-up suggestions and logs decisions', async () => {
    // 获取扩展 id（service worker URL）
    let serviceWorker
    await expect.poll(async () => {
      serviceWorker = context.serviceWorkers()[0]
      return serviceWorker?.url() ?? ''
    }, { timeout: 30_000 }).toContain('chrome-extension://')

    const extensionId = new URL(serviceWorker.url()).host

    // 打开 popup 并播种一条 3 天前投递（status=applied → 应触发跟进建议）
    const popup = await context.newPage()
    await popup.goto(`chrome-extension://${extensionId}/src/popup/index.html`)

    await popup.evaluate(async () => {
      const threeDaysAgo = new Date(Date.now() - 3 * 86400000).toISOString()
      await chrome.runtime.sendMessage({
        type: 'SAVE_APPLICATION',
        payload: {
          job: {
            id: 'butler-e2e-job',
            title: '管家测试工程师',
            companyName: '管家测试科技',
            salary: '20K-30K',
            location: '深圳',
            experience: '',
            education: '',
            tags: [],
            jobDescription: 'React 测试',
            bossName: '',
            bossTitle: '',
            bossOnline: false,
            publishedAt: '',
            url: 'https://www.zhipin.com/job_detail/butler-e2e-job.html',
          },
          match: {
            jobId: 'butler-e2e-job',
            score: 80,
            skillMatch: ['React'],
            skillGap: [],
            strengths: [],
            weaknesses: [],
            improvementSuggestions: [],
            recommendation: '推荐',
            scoreBypassed: false,
          },
          resumeId: 'resume-1',
          platformId: 'boss',
          appliedAt: threeDaysAgo,
        },
      })
    })

    // 打开「管家」页 → 点击扫描跟进
    await popup.getByRole('button', { name: '管家', exact: true }).click()
    await popup.getByRole('button', { name: '扫描跟进', exact: true }).click()

    // 跟进建议出现：含公司名与岗位名
    await expect.poll(async () => await popup.getByText('管家测试科技 · 管家测试工程师').count(), { timeout: 15_000 }).toBeGreaterThan(0)
    await expect.poll(async () => await popup.getByText(/已 \d+ 天未回复/).count(), { timeout: 10_000 }).toBeGreaterThan(0)

    // 决策留痕出现：butler 每日管家扫描
    await expect.poll(async () => await popup.getByText(/butler.*每日管家扫描/).count(), { timeout: 10_000 }).toBeGreaterThan(0)

    // C2：周期复盘卡片出现（投递 1、回复率 0%）
    await expect.poll(async () => await popup.getByText(/周期复盘（近 2 周（14 天））/).count(), { timeout: 10_000 }).toBeGreaterThan(0)
    await expect.poll(async () => await popup.getByText(/投递 1/).count(), { timeout: 10_000 }).toBeGreaterThan(0)

    // 清理：标记已处理 → 建议消失
    await popup.getByRole('button', { name: '已处理' }).click()
    await expect.poll(async () => await popup.getByText('管家测试科技 · 管家测试工程师').count(), { timeout: 10_000 }).toBe(0)

    await popup.close()
  }, 60_000)
})
