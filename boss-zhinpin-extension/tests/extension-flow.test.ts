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

describe('extension application flow', () => {
  it('restores shared resume state for an existing uploaded resume', async () => {
    const extensionId = new URL(serviceWorker.url()).host
    const bootstrapPopup = await context.newPage()
    await bootstrapPopup.goto(`chrome-extension://${extensionId}/src/popup/index.html`)
    await bootstrapPopup.getByText('求职助手').waitFor()
    await bootstrapPopup.close()

    await serviceWorker.evaluate(async () => {
      await chrome.storage.local.clear()
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.open('BossZhipinAssistant')
        request.onerror = () => reject(request.error)
        request.onsuccess = () => {
          try {
            const transaction = request.result.transaction('resumes', 'readwrite')
            const store = transaction.objectStore('resumes')
            store.clear()
            const put = store.put({
              id: 'legacy-resume',
              name: '已上传简历',
              fileName: 'legacy.pdf',
              fileType: 'pdf',
              fileData: new ArrayBuffer(0),
              rawText: 'React TypeScript',
              structuredData: {
                name: '测试用户',
                email: 'test@example.com',
                phone: '13800138000',
                education: [],
                workExperience: [],
                skills: ['React', 'TypeScript'],
                projects: [],
                summary: 'React TypeScript',
                yearsOfExperience: 2,
              },
              aiAnalysis: null,
              isDefault: false,
              createdAt: '2026-07-26T00:00:00.000Z',
              updatedAt: '2026-07-26T00:00:00.000Z',
            })
            put.onerror = () => reject(put.error)
            transaction.oncomplete = () => resolve()
            transaction.onerror = () => reject(transaction.error)
            transaction.onabort = () => reject(transaction.error)
          } catch (error) {
            reject(error)
          }
        }
      })
    })

    const page = await context.newPage()
    await page.route('https://www.zhipin.com/**', async (route) => {
      await route.fulfill({
        headers: { 'content-type': 'text/html; charset=utf-8' },
        body: '<!doctype html><html><body><div class="job-list-box"></div></body></html>',
      })
    })
    await page.goto('https://www.zhipin.com/web/geek/job-recommend')
    await expect.poll(
      () => page.locator('#boss-assistant-panel').count(),
      { timeout: 10_000 },
    ).toBe(1)

    await expect.poll(async () => serviceWorker.evaluate(async () => {
      const result = await chrome.storage.local.get('shared_default_resume_meta')
      return result.shared_default_resume_meta?.id ?? null
    }), { timeout: 3_000 }).toBe('legacy-resume')

    await page.close()
  }, 15_000)

  it('activates a job, sends the greeting, and persists the application', async () => {
    const extensionId = new URL(serviceWorker.url()).host
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
            education: [{ school: '测试大学', degree: '本科', major: '计算机', startDate: '', endDate: '' }],
            workExperience: [
              { company: '测试公司', position: '前端工程师', startDate: '', endDate: '', description: '' },
              { company: '示例公司', position: '开发工程师', startDate: '', endDate: '', description: '' },
            ],
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

    const page = await context.newPage()
    page.on('console', (message) => browserLogs.push(`[page] ${message.text()}`))
    await page.route('https://www.zhipin.com/**', async (route) => {
      await route.fulfill({
        headers: { 'content-type': 'text/html; charset=utf-8' },
        body: `<!doctype html>
          <html><body>
            <ul class="job-list-box">
              <li class="job-card-wrapper">
                <a class="job-name" href="/job_detail/job123.html">前端工程师</a>
                <span class="company-name">测试科技</span>
                <span class="salary">20K-30K</span>
                <span class="job-area">深圳</span>
                <div class="job-detail">React TypeScript JavaScript HTML CSS Node.js</div>
              </li>
            </ul>
            <script>
              document.querySelector('.job-name').addEventListener('click', (event) => {
                event.preventDefault()
                const detail = document.createElement('section')
                detail.className = 'job-detail-content'
                detail.innerHTML = '<button class="btn-chat">立即沟通</button>'
                document.body.appendChild(detail)
                detail.querySelector('.btn-chat').addEventListener('click', () => {
                  const textarea = document.createElement('textarea')
                  textarea.className = 'greet-message'
                  const send = document.createElement('button')
                  send.className = 'send'
                  send.textContent = '发送'
                  send.addEventListener('click', () => {
                    document.body.dataset.sentGreeting = textarea.value
                  })
                  document.body.append(textarea, send)
                })
              })
            </script>
          </body></html>`,
      })
    })

    await page.goto('https://www.zhipin.com/web/geek/job-recommend')
    await expect.poll(
      () => page.locator('#boss-assistant-panel').count(),
      { timeout: 10_000 },
    ).toBe(1)

    await serviceWorker.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ url: 'https://www.zhipin.com/*' })
      if (!tab.id) throw new Error('fixture tab not found')
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
    })

    await expect.poll(
      () => page.locator('body').getAttribute('data-sent-greeting'),
      { timeout: 15_000 },
    ).toMatch(/.+/)

    await new Promise((resolve) => setTimeout(resolve, 2000))
    const applicationCount = await serviceWorker.evaluate(async () => {
      return new Promise<number>((resolve, reject) => {
        const request = indexedDB.open('BossZhipinAssistant')
        request.onerror = () => reject(request.error)
        request.onsuccess = () => {
          const transaction = request.result.transaction('applications', 'readonly')
          const count = transaction.objectStore('applications').count()
          count.onerror = () => reject(count.error)
          count.onsuccess = () => resolve(count.result)
        }
      })
    })
    const sharedIds = await serviceWorker.evaluate(async () => {
      const result = await chrome.storage.local.get('shared_applied_job_ids')
      return result.shared_applied_job_ids ?? []
    })
    expect(applicationCount, JSON.stringify({ sharedIds, browserLogs }, null, 2)).toBe(1)

    const popup = await context.newPage()
    popup.on('console', (message) => browserLogs.push(`[popup] ${message.text()}`))
    await popup.goto(`chrome-extension://${extensionId}/src/popup/index.html`)
    await popup.getByText('追踪').click()
    await new Promise((resolve) => setTimeout(resolve, 1000))
    const popupText = await popup.locator('body').textContent()
    expect(popupText, JSON.stringify(browserLogs, null, 2)).toContain('测试科技')
    expect(popupText).toContain('前端工程师')
    await popup.close()
    await page.close()
  }, 45_000)

  it('waits for each selected job and sends a job-specific greeting to both jobs', async () => {
    await serviceWorker.evaluate(async () => {
      await chrome.storage.local.clear()
      await chrome.storage.local.set({
        shared_default_resume_meta: {
          id: 'resume-consecutive',
          name: '连续投递用户',
          fileName: 'resume.pdf',
          skills: ['React', 'TypeScript', 'Node.js'],
          yearsOfExperience: 3,
          hasFullData: true,
          updatedAt: '2026-07-26T00:00:00.000Z',
        },
        shared_default_resume_full: {
          id: 'resume-consecutive',
          name: '连续投递用户',
          fileName: 'resume.pdf',
          fileType: 'pdf',
          rawText: 'React TypeScript Node.js 前端开发',
          structuredData: {
            name: '连续投递用户',
            email: '',
            phone: '',
            education: [],
            workExperience: [],
            skills: ['React', 'TypeScript', 'Node.js'],
            projects: [],
            summary: '三年前端开发经验',
            yearsOfExperience: 3,
          },
          aiAnalysis: null,
          isDefault: true,
          createdAt: '2026-07-26T00:00:00.000Z',
          updatedAt: '2026-07-26T00:00:00.000Z',
        },
      })
    })

    const page = await context.newPage()
    await page.route('https://www.zhipin.com/**', async (route) => {
      await route.fulfill({
        headers: { 'content-type': 'text/html; charset=utf-8' },
        body: `<!doctype html><html><body>
          <ul class="job-list-box">
            <li class="job-card-wrapper">
              <a class="job-name" href="/job_detail/frontendalpha.html" data-job="frontendalpha">React前端工程师</a>
              <span class="company-name">甲科技</span>
              <span class="salary">20K-30K</span>
              <div class="job-detail">React TypeScript</div>
            </li>
            <li class="job-card-wrapper">
              <a class="job-name" href="/job_detail/nodebeta.html" data-job="nodebeta">Node.js工程师</a>
              <span class="company-name">乙网络</span>
              <span class="salary">22K-32K</span>
              <div class="job-detail">Node.js TypeScript</div>
            </li>
          </ul>
          <div id="details"></div>
          <script>
            const jobs = {
              frontendalpha: { title: 'React前端工程师', company: '甲科技' },
              nodebeta: { title: 'Node.js工程师', company: '乙网络' },
            }
            document.querySelectorAll('.job-name').forEach((link) => {
              link.addEventListener('click', (event) => {
                event.preventDefault()
                const jobId = link.dataset.job
                if (document.querySelector('.chat-dialog')) {
                  document.body.dataset.blockedByDialog = jobId
                  return
                }
                setTimeout(() => {
                  const detail = document.createElement('section')
                  detail.className = 'job-detail-content'
                  detail.dataset.job = jobId
                  detail.innerHTML =
                    '<h2>' + jobs[jobId].title + '</h2>' +
                    '<div class="detail-company">' + jobs[jobId].company + '</div>' +
                    '<button class="btn-chat">立即沟通</button>'
                  document.querySelector('#details').append(detail)
                  detail.querySelector('.btn-chat').addEventListener('click', () => {
                    const dialog = document.createElement('div')
                    dialog.className = 'chat-dialog'
                    dialog.dataset.job = jobId
                    dialog.innerHTML =
                      '<button class="dialog-close" aria-label="关闭">×</button>' +
                      '<textarea class="greet-message"></textarea>' +
                      '<button class="send">发送</button>'
                    document.body.append(dialog)
                    dialog.querySelector('.dialog-close').addEventListener('click', () => {
                      const closed = JSON.parse(document.body.dataset.closedDialogs || '[]')
                      closed.push(jobId)
                      document.body.dataset.closedDialogs = JSON.stringify(closed)
                      dialog.remove()
                    })
                    dialog.querySelector('.send').addEventListener('click', () => {
                      const sent = JSON.parse(document.body.dataset.sentGreetings || '[]')
                      sent.push({
                        jobId,
                        message: dialog.querySelector('textarea').value,
                      })
                      document.body.dataset.sentGreetings = JSON.stringify(sent)
                    })
                  })
                }, 150)
              })
            })
          </script>
        </body></html>`,
      })
    })

    await page.goto('https://www.zhipin.com/web/geek/job-recommend?fixture=consecutive')
    await expect.poll(() => page.locator('#boss-assistant-panel').count(), { timeout: 10_000 }).toBe(1)

    await serviceWorker.evaluate(async () => {
      const [tab] = await chrome.tabs.query({
        url: 'https://www.zhipin.com/web/geek/job-recommend?fixture=consecutive',
      })
      if (!tab.id) throw new Error('consecutive fixture tab not found')
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
            enableAiMatch: false,
            minMatchScore: 100,
          },
        },
      })
    })

    await expect.poll(async () => {
      const value = await page.locator('body').getAttribute('data-sent-greetings')
      return value ? JSON.parse(value).length : 0
    }, { timeout: 20_000 }).toBeGreaterThanOrEqual(1)
    await expect.poll(
      () => page.locator('.chat-dialog').count(),
      { timeout: 3_000 },
    ).toBe(0)

    await expect.poll(async () => {
      const value = await page.locator('body').getAttribute('data-sent-greetings')
      return value ? JSON.parse(value).length : 0
    }, { timeout: 35_000 }).toBe(2)

    const sent = JSON.parse(
      await page.locator('body').getAttribute('data-sent-greetings') || '[]',
    ) as Array<{ jobId: string; message: string }>
    expect(sent.map((entry) => entry.jobId)).toEqual(['frontendalpha', 'nodebeta'])
    expect(sent[0].message).toContain('React前端工程师')
    expect(sent[0].message).toContain('甲科技')
    expect(sent[1].message).toContain('Node.js工程师')
    expect(sent[1].message).toContain('乙网络')
    await expect.poll(async () => JSON.parse(
      await page.locator('body').getAttribute('data-closed-dialogs') || '[]',
    )).toEqual(['frontendalpha', 'nodebeta'])
    expect(await page.locator('body').getAttribute('data-blocked-by-dialog')).toBeNull()

    await page.close()
  }, 60_000)

  it('closes a standalone communication modal that has no greeting input', async () => {
    await serviceWorker.evaluate(async () => {
      await chrome.storage.local.clear()
      await chrome.storage.local.set({
        shared_default_resume_meta: {
          id: 'resume-standalone-modal',
          name: '模态框测试用户',
          fileName: 'resume.pdf',
          skills: ['React'],
          yearsOfExperience: 2,
          hasFullData: true,
          updatedAt: '2026-07-26T00:00:00.000Z',
        },
        shared_default_resume_full: {
          id: 'resume-standalone-modal',
          name: '模态框测试用户',
          fileName: 'resume.pdf',
          fileType: 'pdf',
          rawText: 'React 前端开发',
          structuredData: {
            name: '模态框测试用户',
            email: '',
            phone: '',
            education: [],
            workExperience: [],
            skills: ['React'],
            projects: [],
            summary: 'React 前端开发',
            yearsOfExperience: 2,
          },
          aiAnalysis: null,
          isDefault: true,
          createdAt: '2026-07-26T00:00:00.000Z',
          updatedAt: '2026-07-26T00:00:00.000Z',
        },
      })
    })

    const page = await context.newPage()
    await page.route('https://www.zhipin.com/**', async (route) => {
      await route.fulfill({
        headers: { 'content-type': 'text/html; charset=utf-8' },
        body: `<!doctype html><html><body>
          <ul class="job-list-box"><li class="job-card-wrapper">
            <a class="job-name" href="/job_detail/standalonemodal.html">前端开发工程师</a>
            <span class="company-name">独立模态框公司</span>
            <span class="salary">15K-25K</span>
            <div class="job-detail">React TypeScript</div>
          </li></ul>
          <script>
            document.querySelector('.job-name').addEventListener('click', (event) => {
              event.preventDefault()
              const detail = document.createElement('section')
              detail.className = 'job-detail-content'
              detail.innerHTML =
                '<h2>前端开发工程师</h2>' +
                '<span>独立模态框公司</span>' +
                '<button class="btn-chat">立即沟通</button>'
              document.body.append(detail)
              detail.querySelector('.btn-chat').addEventListener('click', () => {
                const modal = document.createElement('div')
                modal.className = 'boss-dialog'
                modal.setAttribute('role', 'dialog')
                modal.innerHTML =
                  '<button class="boss-dialog__close" aria-label="关闭">×</button>' +
                  '<p>沟通请求已发出</p>'
                document.body.append(modal)
                modal.querySelector('.boss-dialog__close').addEventListener('click', () => {
                  document.body.dataset.standaloneModalClosed = 'true'
                  modal.remove()
                })
              })
            })
          </script>
        </body></html>`,
      })
    })

    await page.goto('https://www.zhipin.com/web/geek/job-recommend?fixture=standalone-modal')
    await expect.poll(
      () => page.locator('#boss-assistant-panel').count(),
      { timeout: 10_000 },
    ).toBe(1)

    await serviceWorker.evaluate(async () => {
      const [tab] = await chrome.tabs.query({
        url: 'https://www.zhipin.com/web/geek/job-recommend?fixture=standalone-modal',
      })
      if (!tab.id) throw new Error('standalone modal fixture tab not found')
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
            enableAiMatch: false,
            minMatchScore: 100,
          },
        },
      })
    })

    await expect.poll(
      () => page.locator('body').getAttribute('data-standalone-modal-closed'),
      { timeout: 20_000 },
    ).toBe('true')
    expect(await page.locator('.boss-dialog').count()).toBe(0)

    await page.close()
  }, 45_000)

  it('scrolls the job list and analyzes jobs loaded after the first 15 cards', async () => {
    await serviceWorker.evaluate(async () => {
      await chrome.storage.local.clear()
      await chrome.storage.local.set({
        shared_default_resume_meta: {
          id: 'resume-scroll',
          name: '滚动测试用户',
          fileName: 'resume.pdf',
          skills: ['React'],
          yearsOfExperience: 2,
          hasFullData: true,
          updatedAt: '2026-07-26T00:00:00.000Z',
        },
        shared_default_resume_full: {
          id: 'resume-scroll',
          name: '滚动测试用户',
          fileName: 'resume.pdf',
          fileType: 'pdf',
          rawText: 'React 前端开发',
          structuredData: {
            name: '滚动测试用户',
            email: '',
            phone: '',
            education: [],
            workExperience: [],
            skills: ['React'],
            projects: [],
            summary: 'React 前端开发',
            yearsOfExperience: 2,
          },
          aiAnalysis: null,
          isDefault: true,
          createdAt: '2026-07-26T00:00:00.000Z',
          updatedAt: '2026-07-26T00:00:00.000Z',
        },
      })
    })

    const page = await context.newPage()
    await page.route('https://www.zhipin.com/**', async (route) => {
      await route.fulfill({
        headers: { 'content-type': 'text/html; charset=utf-8' },
        body: `<!doctype html><html><body style="min-height:2400px">
          <ul class="job-list-box"></ul>
          <script>
            const list = document.querySelector('.job-list-box')
            const appendJob = (index) => {
              const item = document.createElement('li')
              item.className = 'job-card-wrapper'
              item.innerHTML =
                '<a class="job-name" href="/job_detail/scrolljob' + index + '.html">前端工程师' + index + '</a>' +
                '<span class="company-name">滚动公司' + index + '</span>' +
                '<span class="salary">15K-25K</span>' +
                '<div class="job-detail">React</div>'
              list.append(item)
            }
            for (let index = 1; index <= 15; index++) appendJob(index)
            let loaded = false
            window.addEventListener('scroll', () => {
              if (loaded || window.scrollY < 100) return
              loaded = true
              for (let index = 16; index <= 20; index++) appendJob(index)
              document.body.dataset.loadedMore = 'true'
            })
          </script>
        </body></html>`,
      })
    })

    await page.goto('https://www.zhipin.com/web/geek/job-recommend?fixture=scroll')
    await expect.poll(() => page.locator('#boss-assistant-panel').count(), { timeout: 10_000 }).toBe(1)

    await serviceWorker.evaluate(async () => {
      const [tab] = await chrome.tabs.query({
        url: 'https://www.zhipin.com/web/geek/job-recommend?fixture=scroll',
      })
      if (!tab.id) throw new Error('scroll fixture tab not found')
      await chrome.tabs.sendMessage(tab.id, {
        type: 'EXECUTE_APPLY',
        payload: {
          mode: 'recommend',
          filters: {
            jobTitles: '',
            locations: '',
            salaryMin: null,
            salaryMax: null,
            experience: '',
            education: '',
            excludeKeywords: '',
            enableAiMatch: false,
            minMatchScore: 100,
          },
        },
      })
    })

    await expect.poll(
      () => page.locator('body').getAttribute('data-loaded-more'),
      { timeout: 15_000 },
    ).toBe('true')
    await expect.poll(async () => page.locator('#boss-assistant-panel').evaluate(
      (host) => host.shadowRoot?.textContent ?? '',
    ), { timeout: 30_000 }).toMatch(/进度\s*20\/20/)

    await page.close()
  }, 60_000)

  it('does not apply when the match score is below the selected minimum', async () => {
    await serviceWorker.evaluate(async () => {
      await chrome.storage.local.clear()
      await chrome.storage.local.set({
        shared_default_resume_meta: {
          id: 'resume-2',
          name: 'Threshold User',
          fileName: 'resume.pdf',
          skills: ['React', 'TypeScript', 'JavaScript', 'HTML', 'CSS', 'Node.js'],
          yearsOfExperience: 3,
          hasFullData: true,
          updatedAt: '2026-07-26T00:00:00.000Z',
        },
        shared_default_resume_full: {
          id: 'resume-2',
          name: 'Threshold User',
          fileName: 'resume.pdf',
          fileType: 'pdf',
          rawText: 'React TypeScript JavaScript HTML CSS Node.js',
          structuredData: {
            name: 'Threshold User',
            email: 'test@example.com',
            phone: '13800138000',
            education: [{ school: 'Test University', degree: '本科', major: 'CS', startDate: '', endDate: '' }],
            workExperience: [
              { company: 'A', position: 'Engineer', startDate: '', endDate: '', description: '' },
              { company: 'B', position: 'Engineer', startDate: '', endDate: '', description: '' },
            ],
            skills: ['React', 'TypeScript', 'JavaScript', 'HTML', 'CSS', 'Node.js'],
            projects: [],
            summary: 'React TypeScript JavaScript HTML CSS Node.js',
            yearsOfExperience: 3,
          },
          aiAnalysis: null,
          isDefault: true,
          createdAt: '2026-07-26T00:00:00.000Z',
          updatedAt: '2026-07-26T00:00:00.000Z',
        },
      })
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.open('BossZhipinAssistant')
        request.onerror = () => reject(request.error)
        request.onsuccess = () => {
          const transaction = request.result.transaction('applications', 'readwrite')
          transaction.objectStore('applications').clear()
          transaction.oncomplete = () => resolve()
          transaction.onerror = () => reject(transaction.error)
        }
      })
    })

    const page = await context.newPage()
    await page.route('https://www.zhipin.com/**', async (route) => {
      await route.fulfill({
        headers: { 'content-type': 'text/html; charset=utf-8' },
        body: `<!doctype html><html><body>
          <ul class="job-list-box"><li class="job-card-wrapper">
            <a class="job-name" href="/job_detail/job-high-threshold.html">Frontend Engineer</a>
            <span class="company-name">Threshold Inc</span>
            <span class="salary">20K-30K</span>
            <div class="job-detail">React TypeScript JavaScript HTML CSS Node.js</div>
          </li></ul>
          <script>
            document.querySelector('.job-name').addEventListener('click', (event) => {
              event.preventDefault()
              const button = document.createElement('button')
              button.className = 'btn-chat'
              button.textContent = 'Apply'
              button.addEventListener('click', () => {
                document.body.dataset.applied = 'true'
                const textarea = document.createElement('textarea')
                textarea.className = 'greet-message'
                const send = document.createElement('button')
                send.className = 'send'
                document.body.append(textarea, send)
              })
              document.body.append(button)
            })
          </script>
        </body></html>`,
      })
    })
    await page.goto('https://www.zhipin.com/web/geek/job-recommend')
    await expect.poll(
      () => page.locator('#boss-assistant-panel').count(),
      { timeout: 10_000 },
    ).toBe(1)

    await serviceWorker.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ url: 'https://www.zhipin.com/*' })
      if (!tab.id) throw new Error('fixture tab not found')
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
            minMatchScore: 90,
          },
        },
      })
    })

    await expect.poll(async () => page.locator('#boss-assistant-panel').evaluate(
      (host) => host.shadowRoot?.textContent ?? '',
    ), { timeout: 15_000 }).toContain('投递完成')
    expect(await page.locator('body').getAttribute('data-applied')).toBeNull()
    await page.close()
  }, 45_000)

  it('bypasses match scoring when direct application is selected', async () => {
    await serviceWorker.evaluate(async () => {
      await chrome.storage.local.clear()
      await chrome.storage.local.set({
        shared_default_resume_meta: {
          id: 'resume-direct',
          name: 'Direct User',
          fileName: 'resume.pdf',
          skills: ['React'],
          yearsOfExperience: 1,
          hasFullData: true,
          updatedAt: '2026-07-26T00:00:00.000Z',
        },
        shared_default_resume_full: {
          id: 'resume-direct',
          name: 'Direct User',
          fileName: 'resume.pdf',
          fileType: 'pdf',
          rawText: 'React 前端开发',
          structuredData: {
            name: 'Direct User',
            email: '',
            phone: '',
            education: [],
            workExperience: [],
            skills: ['React'],
            projects: [],
            summary: 'React 前端开发',
            yearsOfExperience: 1,
          },
          aiAnalysis: null,
          isDefault: true,
          createdAt: '2026-07-26T00:00:00.000Z',
          updatedAt: '2026-07-26T00:00:00.000Z',
        },
      })
    })

    const page = await context.newPage()
    await page.route('https://www.zhipin.com/**', async (route) => {
      await route.fulfill({
        headers: { 'content-type': 'text/html; charset=utf-8' },
        body: `<!doctype html><html><body>
          <ul class="job-list-box"><li class="job-card-wrapper">
            <a class="job-name" href="/job_detail/direct-score-bypass.html">财务会计</a>
            <span class="company-name">直投测试公司</span>
            <span class="salary">10K-15K</span>
            <div class="job-detail">财务 会计 Excel</div>
          </li></ul>
          <script>
            document.querySelector('.job-name').addEventListener('click', (event) => {
              event.preventDefault()
              const button = document.createElement('button')
              button.className = 'btn-chat'
              button.textContent = 'Apply'
              button.addEventListener('click', () => {
                document.body.dataset.applied = 'true'
                const textarea = document.createElement('textarea')
                textarea.className = 'greet-message'
                const send = document.createElement('button')
                send.className = 'send'
                document.body.append(textarea, send)
              })
              document.body.append(button)
            })
          </script>
        </body></html>`,
      })
    })
    await page.goto('https://www.zhipin.com/web/geek/job-recommend?fixture=direct-score-bypass')
    await expect.poll(
      () => page.locator('#boss-assistant-panel').count(),
      { timeout: 10_000 },
    ).toBe(1)

    await serviceWorker.evaluate(async () => {
      const [tab] = await chrome.tabs.query({
        url: 'https://www.zhipin.com/web/geek/job-recommend?fixture=direct-score-bypass',
      })
      if (!tab.id) throw new Error('direct fixture tab not found')
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
            enableAiMatch: false,
            minMatchScore: 90,
          },
        },
      })
    })

    await expect.poll(
      () => page.locator('body').getAttribute('data-applied'),
      { timeout: 20_000 },
    ).toBe('true')
    await expect.poll(async () => page.locator('#boss-assistant-panel').evaluate(
      (host) => host.shadowRoot?.textContent ?? '',
    ), { timeout: 20_000 }).toContain('投递完成')
    const bypassPanelText = await page.locator('#boss-assistant-panel').evaluate(
      (host) => host.shadowRoot?.textContent ?? '',
    )
    expect(bypassPanelText).toContain('不判分')
    expect(bypassPanelText).toContain('直投')
    expect(bypassPanelText).not.toMatch(/\d+分/)

    const directApplicationScore = await serviceWorker.evaluate(async () => {
      return new Promise<number | null | undefined>((resolve, reject) => {
        const request = indexedDB.open('BossZhipinAssistant')
        request.onerror = () => reject(request.error)
        request.onsuccess = () => {
          const transaction = request.result.transaction('applications', 'readonly')
          const index = transaction.objectStore('applications').index('jobId')
          const get = index.get('direct')
          get.onerror = () => reject(get.error)
          get.onsuccess = () => resolve(get.result?.matchScore)
        }
      })
    })
    expect(directApplicationScore).toBeNull()
    await page.close()
  }, 60_000)

  it('shows a scoring switch in the floating panel and starts without scoring', async () => {
    await serviceWorker.evaluate(async () => {
      await chrome.storage.local.clear()
      await chrome.storage.local.set({
        shared_default_resume_meta: {
          id: 'resume-panel-direct',
          name: '悬浮窗直投用户',
          fileName: 'resume.pdf',
          skills: ['React'],
          yearsOfExperience: 1,
          hasFullData: true,
          updatedAt: '2026-07-26T00:00:00.000Z',
        },
        shared_default_resume_full: {
          id: 'resume-panel-direct',
          name: '悬浮窗直投用户',
          fileName: 'resume.pdf',
          fileType: 'pdf',
          rawText: 'React',
          structuredData: {
            name: '悬浮窗直投用户',
            email: '',
            phone: '',
            education: [],
            workExperience: [],
            skills: ['React'],
            projects: [],
            summary: 'React',
            yearsOfExperience: 1,
          },
          aiAnalysis: null,
          isDefault: true,
          createdAt: '2026-07-26T00:00:00.000Z',
          updatedAt: '2026-07-26T00:00:00.000Z',
        },
      })
    })

    const page = await context.newPage()
    await page.route('https://www.zhipin.com/**', async (route) => {
      await route.fulfill({
        headers: { 'content-type': 'text/html; charset=utf-8' },
        body: `<!doctype html><html><body>
          <ul class="job-list-box"><li class="job-card-wrapper">
            <a class="job-name" href="/job_detail/paneldirect.html">后端开发工程师</a>
            <span class="company-name">悬浮窗测试公司</span>
            <span class="salary">15K-25K</span>
            <div class="job-detail">Java Spring Cloud</div>
          </li></ul>
        </body></html>`,
      })
    })

    await page.goto('https://www.zhipin.com/web/geek/job-recommend?fixture=panel-direct')
    const host = page.locator('#boss-assistant-panel')
    await expect.poll(() => host.count(), { timeout: 10_000 }).toBe(1)
    const initialPanelText = await host.evaluate(
      (node) => node.shadowRoot?.textContent ?? '',
    )
    expect(initialPanelText).toContain('按分筛选')
    expect(initialPanelText).toContain('不评分直投')

    await host.locator('#score-direct').click()
    await host.locator('#btn-start').click()

    await expect.poll(async () => host.evaluate(
      (node) => node.shadowRoot?.textContent ?? '',
    ), { timeout: 20_000 }).toContain('筛选完成')
    const finalPanelText = await host.evaluate(
      (node) => node.shadowRoot?.textContent ?? '',
    )
    expect(finalPanelText).toContain('不判分')
    expect(finalPanelText).toContain('直投')
    expect(finalPanelText).not.toMatch(/\d+分/)

    await page.close()
  }, 45_000)

  it('scores visible card metadata when the list card has no full description', async () => {
    await serviceWorker.evaluate(async () => {
      await chrome.storage.local.clear()
      await chrome.storage.local.set({
        shared_default_resume_meta: {
          id: 'resume-card-metadata',
          name: '前端候选人',
          fileName: 'resume.pdf',
          skills: ['React', 'TypeScript', 'JavaScript', 'CSS', 'Vite'],
          yearsOfExperience: 3,
          hasFullData: true,
          updatedAt: '2026-07-26T00:00:00.000Z',
        },
        shared_default_resume_full: {
          id: 'resume-card-metadata',
          name: '前端候选人',
          fileName: 'resume.pdf',
          fileType: 'pdf',
          rawText: '三年前端开发经验，熟练使用 React TypeScript JavaScript CSS Vite',
          structuredData: {
            name: '前端候选人',
            email: '',
            phone: '',
            education: [{ school: '测试大学', degree: '本科', major: '计算机', startDate: '', endDate: '' }],
            workExperience: [
              { company: '甲公司', position: '前端工程师', startDate: '', endDate: '', description: 'React TypeScript 项目开发' },
              { company: '乙公司', position: 'Web 工程师', startDate: '', endDate: '', description: '前端性能优化' },
            ],
            skills: ['React', 'TypeScript', 'JavaScript', 'CSS', 'Vite'],
            projects: [],
            summary: '三年前端开发经验，熟练使用 React TypeScript JavaScript CSS Vite',
            yearsOfExperience: 3,
          },
          aiAnalysis: null,
          isDefault: true,
          createdAt: '2026-07-26T00:00:00.000Z',
          updatedAt: '2026-07-26T00:00:00.000Z',
        },
      })
    })

    const page = await context.newPage()
    await page.route('https://www.zhipin.com/**', async (route) => {
      await route.fulfill({
        headers: { 'content-type': 'text/html; charset=utf-8' },
        body: `<!doctype html><html><body>
          <ul class="job-list-box"><li class="job-card-wrapper">
            <div class="job-card-box">
              <a class="job-name" href="/job_detail/card-metadata.html">高级前端工程师</a>
              <span class="company-name">元数据科技</span>
              <span class="salary">20K-30K</span>
              <span class="job-area">深圳</span>
              <ul class="job-info">
                <li>3-5年</li>
                <li>本科</li>
                <li>React</li>
                <li>TypeScript</li>
              </ul>
            </div>
          </li></ul>
        </body></html>`,
      })
    })
    await page.goto('https://www.zhipin.com/web/geek/job-recommend?fixture=card-metadata')
    await expect.poll(
      () => page.locator('#boss-assistant-panel').count(),
      { timeout: 10_000 },
    ).toBe(1)

    await serviceWorker.evaluate(async () => {
      const [tab] = await chrome.tabs.query({
        url: 'https://www.zhipin.com/web/geek/job-recommend?fixture=card-metadata',
      })
      if (!tab.id) throw new Error('fixture tab not found')
      await chrome.tabs.sendMessage(tab.id, {
        type: 'EXECUTE_APPLY',
        payload: {
          mode: 'recommend',
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
    })

    await expect.poll(async () => page.locator('#boss-assistant-panel').evaluate(
      (host) => host.shadowRoot?.textContent ?? '',
    ), { timeout: 10_000 }).toContain('分析完成')
    const panelText = await page.locator('#boss-assistant-panel').evaluate(
      (host) => host.shadowRoot?.textContent ?? '',
    )
    expect(panelText).toMatch(/进度\s*1\/1/)
    expect(panelText).not.toContain('14分')
    expect(panelText).toMatch(/[6-9]\d分/)

    await page.close()
  }, 30_000)

  it('keeps floating panel content and bounds when closed and reopened', async () => {
    const page = await context.newPage()
    await page.setViewportSize({ width: 420, height: 360 })
    await page.route('https://www.zhipin.com/**', async (route) => {
      await route.fulfill({
        headers: { 'content-type': 'text/html; charset=utf-8' },
        body: '<!doctype html><html><body><main>Floating panel fixture</main></body></html>',
      })
    })
    await page.goto('https://www.zhipin.com/web/geek/job-recommend')
    const host = page.locator('#boss-assistant-panel')
    await expect.poll(() => host.count()).toBe(1)
    const originalHost = await host.elementHandle()
    if (!originalHost) throw new Error('floating panel host not found')

    await host.evaluate((node) => {
      const content = node.shadowRoot?.getElementById('panel-content')
      if (!content) throw new Error('panel content not found')
      content.innerHTML = '<div style="height:600px">二次打开内容标记</div>'
    })
    await host.locator('#btn-close').click()

    expect(await originalHost.evaluate((node) => node.isConnected)).toBe(true)
    await expect.poll(() => page.locator('#boss-assistant-trigger').count()).toBe(1)
    await page.locator('#boss-assistant-trigger').click()

    const reopenedHost = page.locator('#boss-assistant-panel')
    await expect.poll(() => reopenedHost.count()).toBe(1)
    expect(await reopenedHost.evaluate((node) => node.shadowRoot?.textContent ?? ''))
      .toContain('二次打开内容标记')

    const metrics = await reopenedHost.evaluate((node) => {
      const hostBox = node.getBoundingClientRect()
      const panel = node.shadowRoot?.querySelector('.panel')
      const panelBox = panel?.getBoundingClientRect()
      return {
        viewport: { width: window.innerWidth, height: window.innerHeight },
        host: { x: hostBox.x, y: hostBox.y, width: hostBox.width, height: hostBox.height },
        panel: panelBox
          ? { x: panelBox.x, y: panelBox.y, width: panelBox.width, height: panelBox.height }
          : null,
        hostOverflow: getComputedStyle(node).overflow,
        panelMaxHeight: panel ? getComputedStyle(panel).maxHeight : null,
      }
    })
    const box = metrics.host
    expect(box.x).toBeGreaterThanOrEqual(8)
    expect(box.y).toBeGreaterThanOrEqual(8)
    expect(box.x + box.width, JSON.stringify(metrics)).toBeLessThanOrEqual(metrics.viewport.width - 8)
    expect(box.y + box.height, JSON.stringify(metrics)).toBeLessThanOrEqual(metrics.viewport.height - 8)

    await page.close()
  }, 20_000)

  it('drags the floating panel by its header and clamps it to the viewport', async () => {
    const page = await context.newPage()
    await page.setViewportSize({ width: 800, height: 600 })
    await page.route('https://www.zhipin.com/**', async (route) => {
      await route.fulfill({
        headers: { 'content-type': 'text/html; charset=utf-8' },
        body: '<!doctype html><html><body><main>Draggable panel fixture</main></body></html>',
      })
    })
    await page.goto('https://www.zhipin.com/web/geek/job-recommend')
    const host = page.locator('#boss-assistant-panel')
    await expect.poll(() => host.count()).toBe(1)
    const header = host.locator('.panel-header')
    const before = await host.boundingBox()
    if (!before) throw new Error('floating panel is not visible')

    await header.dispatchEvent('pointerdown', {
      pointerId: 1,
      button: 0,
      clientX: before.x + 80,
      clientY: before.y + 20,
    })
    await page.evaluate(() => {
      window.dispatchEvent(new PointerEvent('pointermove', {
        pointerId: 1,
        clientX: 220,
        clientY: 260,
        bubbles: true,
      }))
      window.dispatchEvent(new PointerEvent('pointerup', {
        pointerId: 1,
        clientX: 220,
        clientY: 260,
        bubbles: true,
      }))
    })

    const moved = await host.boundingBox()
    if (!moved) throw new Error('floating panel disappeared after drag')
    expect(Math.round(moved.x)).not.toBe(Math.round(before.x))
    expect(Math.round(moved.y)).not.toBe(Math.round(before.y))

    await header.dispatchEvent('pointerdown', {
      pointerId: 2,
      button: 0,
      clientX: moved.x + 80,
      clientY: moved.y + 20,
    })
    await page.evaluate(() => {
      window.dispatchEvent(new PointerEvent('pointermove', {
        pointerId: 2,
        clientX: 5000,
        clientY: 5000,
        bubbles: true,
      }))
      window.dispatchEvent(new PointerEvent('pointerup', {
        pointerId: 2,
        clientX: 5000,
        clientY: 5000,
        bubbles: true,
      }))
    })

    const clamped = await host.boundingBox()
    if (!clamped) throw new Error('floating panel disappeared after clamped drag')
    expect(clamped.x).toBeGreaterThanOrEqual(8)
    expect(clamped.y).toBeGreaterThanOrEqual(8)
    expect(clamped.x + clamped.width).toBeLessThanOrEqual(792)
    expect(clamped.y + clamped.height).toBeLessThanOrEqual(592)

    await page.close()
  }, 20_000)

  it('starts from a standalone popup page by connecting to an existing Boss tab', async () => {
    const extensionId = new URL(serviceWorker.url()).host
    await serviceWorker.evaluate(async () => {
      await chrome.storage.local.clear()
      await chrome.storage.local.set({
        shared_default_resume_meta: {
          id: 'resume-popup',
          name: 'Popup User',
          fileName: 'resume.pdf',
          skills: ['React'],
          yearsOfExperience: 1,
          hasFullData: true,
          updatedAt: '2026-07-26T00:00:00.000Z',
        },
        shared_default_resume_full: {
          id: 'resume-popup',
          name: 'Popup User',
          fileName: 'resume.pdf',
          fileType: 'pdf',
          rawText: 'React',
          structuredData: {
            name: 'Popup User',
            email: '',
            phone: '',
            education: [],
            workExperience: [],
            skills: ['React'],
            projects: [],
            summary: 'React',
            yearsOfExperience: 1,
          },
          aiAnalysis: null,
          isDefault: true,
          createdAt: '2026-07-26T00:00:00.000Z',
          updatedAt: '2026-07-26T00:00:00.000Z',
        },
      })
    })

    const page = await context.newPage()
    await page.route('https://www.zhipin.com/**', async (route) => {
      await route.fulfill({
        headers: { 'content-type': 'text/html; charset=utf-8' },
        body: '<!doctype html><html><body><main>Boss fixture without job cards</main></body></html>',
      })
    })
    await page.goto('https://www.zhipin.com/web/geek/job-recommend')
    await expect.poll(
      () => page.locator('#boss-assistant-panel').count(),
      { timeout: 10_000 },
    ).toBe(1)

    const popup = await context.newPage()
    await popup.goto(`chrome-extension://${extensionId}/src/popup/index.html`)
    await popup.getByRole('button', { name: '开始投递', exact: true }).click()

    await expect.poll(async () => page.locator('#boss-assistant-panel').evaluate(
      (host) => host.shadowRoot?.textContent ?? '',
    ), { timeout: 10_000 }).toContain('未找到岗位卡片')
    await expect.poll(
      () => popup.getByText('已连接 BOSS 页面，开始扫描岗位').count(),
    ).toBe(1)

    await popup.close()
    await page.close()
  }, 30_000)
})
