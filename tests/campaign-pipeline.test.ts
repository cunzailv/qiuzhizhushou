// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  createNewCampaign,
  appendTasksToCampaign,
  claimNextTask,
  updateTaskResult,
  getCampaign,
  markPlatformExhausted,
  appendCampaignLog,
  togglePlatformEnabled,
  updateCampaignWindows,
} from '../src/shared/agent/queue-store'
import {
  isWithinWindow,
  getRandomInterval,
  getDelayUntilNextWindow,
  formatTimeWindows,
  parseTimeString,
} from '../src/shared/agent/quota'
import {
  aggregateCampaignStats,
  isCampaignFinished,
  pauseCampaign,
  resumeCampaign,
} from '../src/shared/agent/campaign'
import { generateJobGreeting } from '../src/shared/ai/greeting'

// 模拟 chrome.storage.local
const mockStorage: Record<string, any> = {}

beforeEach(() => {
  for (const k of Object.keys(mockStorage)) {
    delete mockStorage[k]
  }

  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: vi.fn(async (keys: string | string[]) => {
          if (typeof keys === 'string') {
            return { [keys]: mockStorage[keys] }
          }
          const res: Record<string, any> = {}
          for (const k of keys) {
            res[k] = mockStorage[k]
          }
          return res
        }),
        set: vi.fn(async (obj: Record<string, any>) => {
          Object.assign(mockStorage, obj)
        }),
        remove: vi.fn(async (keys: string | string[]) => {
          const list = Array.isArray(keys) ? keys : [keys]
          for (const k of list) delete mockStorage[k]
        }),
      },
    },
  })
})

describe('Quota and Windows Engine', () => {
  it('correctly determines whether current time is within window', () => {
    const windows = [
      { startHour: 9, startMin: 0, endHour: 11, endMin: 30 },
      { startHour: 14, startMin: 0, endHour: 17, endMin: 30 },
    ]

    const morningDate = new Date('2026-11-03T10:15:00')
    expect(isWithinWindow(windows, morningDate)).toBe(true)

    const lunchDate = new Date('2026-11-03T12:30:00')
    expect(isWithinWindow(windows, lunchDate)).toBe(false)

    const afternoonDate = new Date('2026-11-03T15:00:00')
    expect(isWithinWindow(windows, afternoonDate)).toBe(true)

    const nightDate = new Date('2026-11-03T21:00:00')
    expect(isWithinWindow(windows, nightDate)).toBe(false)
  })

  it('generates random interval within platform bounds', () => {
    const bossDelay = getRandomInterval('boss')
    expect(bossDelay).toBeGreaterThanOrEqual(60_000)
    expect(bossDelay).toBeLessThanOrEqual(180_000)

    const liepinDelay = getRandomInterval('liepin')
    expect(liepinDelay).toBeGreaterThanOrEqual(45_000)
    expect(liepinDelay).toBeLessThanOrEqual(120_000)
  })

  it('formats time windows and parses time strings correctly', () => {
    const windows = [
      { startHour: 9, startMin: 0, endHour: 11, endMin: 30 },
      { startHour: 14, startMin: 0, endHour: 17, endMin: 30 },
    ]
    expect(formatTimeWindows(windows)).toBe('09:00-11:30 / 14:00-17:30')

    const p = parseTimeString('15:45')
    expect(p).toEqual({ hour: 15, min: 45 })
  })

  it('dynamically updates campaign windows', async () => {
    await createNewCampaign()
    const newWindows = [{ startHour: 10, startMin: 0, endHour: 12, endMin: 0 }]
    const updated = await updateCampaignWindows(newWindows)
    expect(updated?.windows).toEqual(newWindows)

    const saved = await getCampaign()
    expect(saved?.windows).toEqual(newWindows)
  })
})

describe('Queue Store and Lease Manager', () => {
  it('creates campaign and appends unique tasks', async () => {
    const cmp = await createNewCampaign({ boss: 10, liepin: 20 })
    expect(cmp.status).toBe('running')
    expect(cmp.quotas.boss.quota).toBe(10)
    expect(cmp.quotas.liepin.quota).toBe(20)

    const added = await appendTasksToCampaign([
      {
        id: 'boss:job1',
        platform: 'boss',
        jobId: 'job1',
        jobTitle: '前端专家',
        company: '某大厂',
        jobUrl: 'https://zhipin.com/job1',
      },
      {
        id: 'boss:job2',
        platform: 'boss',
        jobId: 'job2',
        jobTitle: '架构师',
        company: '某AI公司',
        jobUrl: 'https://zhipin.com/job2',
      },
      {
        id: 'boss:job1', // 重复 ID
        platform: 'boss',
        jobId: 'job1',
        jobTitle: '前端专家',
        company: '某大厂',
        jobUrl: 'https://zhipin.com/job1',
      },
    ])

    expect(added).toBe(2)

    const saved = await getCampaign()
    expect(saved?.tasks.length).toBe(2)
    expect(saved?.tasks[0].status).toBe('pending')
  })

  it('claims next task and locks with lease duration', async () => {
    await createNewCampaign({ boss: 5 })
    await appendTasksToCampaign([
      {
        id: 'boss:job1',
        platform: 'boss',
        jobId: 'job1',
        jobTitle: '工程师',
        company: '公司A',
        jobUrl: 'https://zhipin.com/job1',
      },
    ])

    const { task } = await claimNextTask(60_000)
    expect(task).not.toBeNull()
    expect(task?.id).toBe('boss:job1')
    expect(task?.status).toBe('running')
    expect(task?.leaseUntil).toBeGreaterThan(Date.now())

    // 再次 claim 应该为 null（已无 pending）
    const secondClaim = await claimNextTask(60_000)
    expect(secondClaim.task).toBeNull()
  })

  it('reclaims expired running lease back to pending if attempts < 2', async () => {
    await createNewCampaign({ boss: 5 })
    await appendTasksToCampaign([
      {
        id: 'boss:job1',
        platform: 'boss',
        jobId: 'job1',
        jobTitle: '工程师',
        company: '公司A',
        jobUrl: 'https://zhipin.com/job1',
      },
    ])

    // 第一次 claim，租约设为 0
    const { task } = await claimNextTask(0)
    expect(task?.attempts).toBe(1)

    // 等待 5ms 确保 Date.now() > task.leaseUntil
    await new Promise((r) => setTimeout(r, 5))

    // 租约已经过期，再次 claim 时应当回收并重新分派
    const reClaim = await claimNextTask(60_000)
    expect(reClaim.task?.id).toBe('boss:job1')
    expect(reClaim.task?.attempts).toBe(2)
  })

  it('updates task result and updates quota stats', async () => {
    await createNewCampaign({ boss: 5 })
    await appendTasksToCampaign([
      {
        id: 'boss:job1',
        platform: 'boss',
        jobId: 'job1',
        jobTitle: '工程师',
        company: '公司A',
        jobUrl: 'https://zhipin.com/job1',
      },
    ])

    await claimNextTask()
    const updated = await updateTaskResult('boss:job1', {
      status: 'done',
      matchScore: 92,
      appliedAt: '2026-11-03T13:00:00Z',
    })

    expect(updated?.quotas.boss.applied).toBe(1)
    const task = updated?.tasks.find((t) => t.id === 'boss:job1')
    expect(task?.status).toBe('done')
    expect(task?.matchScore).toBe(92)
  })

  it('skips disabled platform tasks during claimNextTask', async () => {
    // 仅开启 boss，禁用 liepin
    await createNewCampaign({ boss: 5, liepin: 5 }, ['boss'])
    await appendTasksToCampaign([
      { id: 'liepin:j1', platform: 'liepin', jobId: 'j1', jobTitle: 'T1', company: 'C1', jobUrl: 'u1' },
      { id: 'boss:j2', platform: 'boss', jobId: 'j2', jobTitle: 'T2', company: 'C2', jobUrl: 'u2' },
    ])

    // 应该直接跳过 liepin，领取 boss 任务
    const { task } = await claimNextTask()
    expect(task?.id).toBe('boss:j2')

    // 动态启用 liepin 后，liepin 任务可以被领取
    await togglePlatformEnabled('liepin', true)
    const second = await claimNextTask()
    expect(second.task?.id).toBe('liepin:j1')
  })

  it('records live action logs and trims overflow', async () => {
    await createNewCampaign()
    await appendCampaignLog('第 1 条行为日志', 'info')
    await appendCampaignLog('第 2 条行为日志', 'success')

    const cmp = await getCampaign()
    expect(cmp?.logs.length).toBeGreaterThanOrEqual(3) // 包含 init 日志
    const last = cmp?.logs[cmp.logs.length - 1]
    expect(last?.message).toBe('第 2 条行为日志')
    expect(last?.level).toBe('success')
  })
})

describe('Campaign LifeCycle and Stats', () => {
  it('correctly aggregates stats and manages pause/resume', async () => {
    const cmp = await createNewCampaign({ boss: 5, liepin: 5 })
    await appendTasksToCampaign([
      { id: 'boss:1', platform: 'boss', jobId: '1', jobTitle: 'T1', company: 'C1', jobUrl: 'u1' },
      { id: 'boss:2', platform: 'boss', jobId: '2', jobTitle: 'T2', company: 'C2', jobUrl: 'u2' },
    ])

    let stats = aggregateCampaignStats(cmp)
    expect(stats.totalTasks).toBe(2)
    expect(stats.pending).toBe(2)

    await pauseCampaign('captcha')
    const paused = await getCampaign()
    expect(paused?.status).toBe('paused')
    expect(paused?.pausedReason).toBe('captcha')

    await resumeCampaign()
    const resumed = await getCampaign()
    expect(resumed?.status).toBe('running')
    expect(resumed?.pausedReason).toBeUndefined()
  })

  it('detects when campaign is finished', async () => {
    const cmp = await createNewCampaign({ boss: 1 })
    expect(isCampaignFinished(cmp)).toBe(false)

    await appendTasksToCampaign([
      { id: 'boss:1', platform: 'boss', jobId: '1', jobTitle: 'T1', company: 'C1', jobUrl: 'u1' },
    ])
    await claimNextTask()
    await updateTaskResult('boss:1', { status: 'done' })

    const updated = await getCampaign()
    expect(isCampaignFinished(updated!)).toBe(true)
  })
})

describe('Greeting Generation Fallback', () => {
  it('falls back to platform template when AI returns empty or fails', async () => {
    const mockResume: any = {
      id: 'res_1',
      name: '张三',
      structuredData: { name: '张三', skills: ['React', 'TypeScript'] },
    }
    const mockJob: any = {
      id: 'job_1',
      title: '前端专家',
      companyName: '字节跳动',
      jobDescription: '要求掌握 React 和 TypeScript',
    }
    const mockMatch: any = {
      score: 85,
      skillMatch: ['React', 'TypeScript'],
      recommendation: '良好匹配',
    }
    const mockAdapter: any = {
      id: 'boss',
      getJobSpecificGreeting: vi.fn(() => '您好！我是张三，看到贵司在招前端专家，期望能与您沟通。'),
    }

    const res = await generateJobGreeting(mockResume, mockJob, mockMatch, mockAdapter, 100)
    expect(res.text).toContain('张三')
    expect(mockAdapter.getJobSpecificGreeting).toHaveBeenCalled()
  })
})

describe('Boss Job Detail & Title Matching Resilience', () => {
  it('correctly extracts full job ID including tilde and special chars', () => {
    const url1 = 'https://www.zhipin.com/job_detail/c3a07604b901dd1a1nVy3Ny9EFVR~.html?securityId=abc'
    const match1 = url1.match(/job_detail[/=]([^/?.#]+)/)
    expect(match1?.[1]).toBe('c3a07604b901dd1a1nVy3Ny9EFVR~')

    const url2 = '/job_detail/8fa10b9c2419_01~1.html'
    const match2 = url2.match(/job_detail[/=]([^/?.#]+)/)
    expect(match2?.[1]).toBe('8fa10b9c2419_01~1')
  })

  it('matches title regardless of Chinese vs English parentheses or spaces', () => {
    const cleanTitle = (text: string) =>
      text.toLowerCase().replace(/[（(【\[].*?[）)】\]]/g, '').replace(/[\s\-_/\\（）()【】\[\]·•/]/g, '').trim()
    const cleanFullText = (text: string) =>
      text.toLowerCase().replace(/[（【]/g, '(').replace(/[）】]/g, ')').replace(/[\s\-_/\\·•/]/g, '').trim()

    const expectedTitle = '全栈工程师（AI 智能体方向）'
    const domTitle1 = '全栈工程师(AI智能体方向)'
    const domTitle2 = '全栈工程师 (AI 智能体方向)'
    const domTitle3 = '全栈工程师'

    const normExpected = cleanFullText(expectedTitle)
    const coreExpected = cleanTitle(expectedTitle)

    expect(coreExpected).toBe('全栈工程师')
    expect(cleanFullText(domTitle1)).toBe(normExpected)
    expect(cleanFullText(domTitle2)).toBe(normExpected)
    expect(cleanFullText(domTitle3)).toContain(coreExpected)
  })
})

describe('Export Sanitization & Anti-crawler Noise Removal', () => {
  it('purges css blocks and anti-crawler noise from text', async () => {
    const { sanitizeExportText } = await import('../src/shared/export/csv-export')
    const rawNoisyText =
      '.QWyReFEWzknP{display:inline-block;width:0.1px;height:0.1px;overflow:hidden;visibility: hidden;}.wtEZJBjpnMB{font-style:normal;font-weight:normal}岗位职责： 1、kanzhun负责公司 B boss端 AI 智能体平台的全栈开发与架构设计，覆盖来自BOSS直聘后台的前端交互页面与后端存储。'

    const cleaned = sanitizeExportText(rawNoisyText)
    expect(cleaned).not.toContain('.QWyReFEWzknP')
    expect(cleaned).not.toContain('display:inline-block')
    expect(cleaned).not.toContain('kanzhun')
    expect(cleaned).not.toContain('来自BOSS直聘后台')
    expect(cleaned).toContain('负责公司 B端 AI 智能体平台的全栈开发与架构设计')
  })
})

describe('Custom Human-like Interval Configuration', () => {
  it('respects custom min/max seconds interval config', () => {
    const customConfig = { minSeconds: 15, maxSeconds: 30 }
    for (let i = 0; i < 50; i++) {
      const intervalMs = getRandomInterval('boss', undefined, customConfig)
      expect(intervalMs).toBeGreaterThanOrEqual(15_000)
      expect(intervalMs).toBeLessThanOrEqual(30_000)
    }
  })

  it('updates campaign interval configuration dynamically', async () => {
    const { updateCampaignInterval, createNewCampaign, getCampaign } = await import(
      '../src/shared/agent/queue-store'
    )
    await createNewCampaign([])
    const updated = await updateCampaignInterval({ minSeconds: 20, maxSeconds: 50 })
    expect(updated?.intervalConfig.minSeconds).toBe(20)
    expect(updated?.intervalConfig.maxSeconds).toBe(50)

    const fetched = await getCampaign()
    expect(fetched?.intervalConfig.minSeconds).toBe(20)
    expect(fetched?.intervalConfig.maxSeconds).toBe(50)
  })
})

describe('Platform Authorization Checker & Enriched Fields', () => {
  it('maps correct login URLs and checks platform auth', async () => {
    const { checkPlatformAuth, PLATFORM_LOGIN_URLS } = await import(
      '../src/shared/platform/auth-checker'
    )
    expect(PLATFORM_LOGIN_URLS.boss).toContain('zhipin.com')
    expect(PLATFORM_LOGIN_URLS.liepin).toContain('liepin.com')
    expect(PLATFORM_LOGIN_URLS.zhaopin).toContain('zhaopin.com')
    expect(PLATFORM_LOGIN_URLS['51job']).toContain('51job.com')
    expect(PLATFORM_LOGIN_URLS.maimai).toContain('maimai.cn')

    const auth = await checkPlatformAuth('boss')
    expect(auth.platform).toBe('boss')
    expect(auth.name).toBe('Boss直聘')
    expect(auth.loginUrl).toBe(PLATFORM_LOGIN_URLS.boss)
  })

  it('preserves location, experience, education, tags and boss info in task queue', async () => {
    const { createNewCampaign, appendTasksToCampaign, getCampaign } = await import(
      '../src/shared/agent/queue-store'
    )
    await createNewCampaign([])
    await appendTasksToCampaign([
      {
        id: 'boss:job_test_01',
        platform: 'boss',
        jobId: 'job_test_01',
        jobTitle: '全栈工程师（AI 智能体方向）',
        company: '方圆宝',
        salary: '18-20K',
        location: '深圳·南山区',
        experience: '5-10年',
        education: '本科',
        tags: ['React', 'Node.js', 'AI智能体'],
        bossName: '方女士',
        bossTitle: '招聘HR',
      },
    ])

    const cmp = await getCampaign()
    const task = cmp?.tasks[0]
    expect(task?.location).toBe('深圳·南山区')
    expect(task?.experience).toBe('5-10年')
    expect(task?.education).toBe('本科')
    expect(task?.tags).toEqual(['React', 'Node.js', 'AI智能体'])
    expect(task?.bossName).toBe('方女士')
    expect(task?.bossTitle).toBe('招聘HR')
  })
})

describe('Boss 直聘 Job Card & Detail Resilience (技术经理/方圆宝专项)', () => {
  it('bidirectionally matches company names with administrative suffixes removed', async () => {
    const { cleanCompanyName, isCompanyMatch } = await import(
      '../src/shared/platform/boss/action-simulator'
    )

    expect(cleanCompanyName('深圳市方圆宝科技有限公司')).toBe('方圆宝')
    expect(cleanCompanyName('广州富途网络技术服务有限公司')).toBe('富途')
    expect(cleanCompanyName('腾讯科技（深圳）有限公司')).toBe('腾讯')

    // 预期为长全称，DOM 显示短简称
    expect(isCompanyMatch('技术经理 方圆宝 18-20K', '深圳市方圆宝科技有限公司')).toBe(true)

    // 预期为短简称，DOM 显示长全称
    expect(isCompanyMatch('技术经理 深圳市方圆宝科技有限公司 18-20K', '方圆宝')).toBe(true)

    // 富途与腾讯
    expect(isCompanyMatch('全栈开发 富途 20-40K', '富途网络科技有限公司')).toBe(true)
    expect(isCompanyMatch('后端专家 腾讯 30-60K', '腾讯科技（深圳）有限公司')).toBe(true)
  })

  it('bidirectionally matches job titles like 技术经理 with bracket/slash qualifiers', async () => {
    const { cleanTitle, isTitleMatch } = await import(
      '../src/shared/platform/boss/action-simulator'
    )

    expect(cleanTitle('技术经理（AI 智能体方向）')).toBe('技术经理')
    expect(cleanTitle('【急聘】技术经理')).toBe('技术经理')

    // 核心岗位匹配
    expect(isTitleMatch('技术经理 方圆宝 18-20K', '技术经理')).toBe(true)
    expect(isTitleMatch('技术经理 方圆宝 18-20K', '技术经理（AI 智能体方向）')).toBe(true)
    expect(isTitleMatch('【急聘】高级技术经理/主管', '技术经理')).toBe(true)
    expect(isTitleMatch('技术经理', '技术经理/架构师')).toBe(true)

    // 复合/带斜杠职位匹配（如 全栈产品工程师 / 独立开发者）
    expect(isTitleMatch('全栈产品工程师 / 独立开发者 某科技', '全栈产品工程师 / 独立开发者')).toBe(true)
    expect(isTitleMatch('全栈产品工程师 某科技', '全栈产品工程师 / 独立开发者')).toBe(true)
    expect(isTitleMatch('独立开发者 个人工作室', '全栈产品工程师 / 独立开发者')).toBe(true)
  })

  it('detects offline or closed job indicators on detail panel', async () => {
    const { checkDetailPanelOffline } = await import(
      '../src/shared/platform/boss/action-simulator'
    )

    const closedBox = document.createElement('div')
    closedBox.innerHTML = `
      <div class="job-detail-box">
        <h1 class="job-title">全栈产品工程师 / 独立开发者</h1>
        <div class="job-status-closed">该职位已停止招聘</div>
      </div>
    `
    expect(checkDetailPanelOffline(closedBox)).toBe(true)

    const offlineBox = document.createElement('div')
    offlineBox.innerHTML = `
      <div class="job-detail-box">
        <h1 class="job-title">前端开发</h1>
        <div class="job-status">职位已下线</div>
      </div>
    `
    expect(checkDetailPanelOffline(offlineBox)).toBe(true)

    const activeBox = document.createElement('div')
    activeBox.innerHTML = `
      <div class="job-detail-box">
        <h1 class="job-title">Node.js工程师</h1>
        <a class="btn btn-startchat">立即沟通</a>
      </div>
    `
    expect(checkDetailPanelOffline(activeBox)).toBe(false)
  })

  it('generates deterministic stable job IDs when url has no job_detail match', async () => {
    const { generateJobId } = await import('../src/shared/platform/boss/parser')

    const id1 = generateJobId('', '某初创团队:全栈产品工程师 / 独立开发者')
    const id2 = generateJobId('', '某初创团队:全栈产品工程师 / 独立开发者')
    const idDiff = generateJobId('', '某另一家公司:技术经理')

    expect(id1).toBe(id2)
    expect(id1).not.toBe(idDiff)
    expect(id1).toMatch(/^job_/)
  })

  it('prevents adding duplicate tasks with identical company and jobTitle', async () => {
    const { createNewCampaign, appendTasksToCampaign, getCampaign } = await import(
      '../src/shared/agent/queue-store'
    )
    await createNewCampaign([])
    const added1 = await appendTasksToCampaign([
      {
        id: 'boss:job_abc1',
        platform: 'boss',
        jobId: 'job_abc1',
        jobTitle: '全栈产品工程师 / 独立开发者',
        company: '某独立实验室',
        jobUrl: 'https://www.zhipin.com/job_detail/abc1.html',
      },
    ])
    expect(added1).toBe(1)

    // 相同公司和岗位的任务即便 ID 伪造不同，也必须被去重拦截
    const added2 = await appendTasksToCampaign([
      {
        id: 'boss:job_xyz_different_id',
        platform: 'boss',
        jobId: 'job_xyz_different_id',
        jobTitle: '全栈产品工程师 / 独立开发者',
        company: '某独立实验室',
        jobUrl: 'https://www.zhipin.com/job_detail/xyz.html',
      },
    ])
    expect(added2).toBe(0)
  })

  it('clears stale pending tasks from old page while preserving historical logs and done/skipped tasks', async () => {
    const { createNewCampaign, appendTasksToCampaign, clearPendingTasks, getCampaign, updateTaskResult } = await import(
      '../src/shared/agent/queue-store'
    )
    await createNewCampaign([])
    await appendTasksToCampaign([
      { id: 'boss:old_p1', platform: 'boss', jobId: 'old_p1', jobTitle: '旧岗位1', company: '旧企业1', jobUrl: 'u1' },
      { id: 'boss:old_p2', platform: 'boss', jobId: 'old_p2', jobTitle: '旧岗位2', company: '旧企业2', jobUrl: 'u2' },
      { id: 'liepin:old_lp', platform: 'liepin', jobId: 'old_lp', jobTitle: '猎聘旧岗', company: '猎聘企', jobUrl: 'u3' },
    ])

    // 将 old_p1 标记为已投递
    await updateTaskResult('boss:old_p1', { status: 'done' })

    // 只清空 boss 的 pending 任务
    const cleared = await clearPendingTasks('boss')
    expect(cleared).toBe(1) // 只有 old_p2 被清空，old_p1 是 done，old_lp 是 liepin

    const cmp = await getCampaign()
    const taskIds = cmp?.tasks.map((t) => t.id)
    expect(taskIds).toContain('boss:old_p1')
    expect(taskIds).toContain('liepin:old_lp')
    expect(taskIds).not.toContain('boss:old_p2')
  })

  it('detects Boss apply buttons via btn-startchat and text heuristics', async () => {
    const { findApplyButtons } = await import(
      '../src/shared/platform/boss/action-simulator'
    )

    const container = document.createElement('div')
    container.innerHTML = `
      <div class="job-detail-box">
        <a class="btn btn-startchat" href="javascript:;" ka="job-detail-chat">立即沟通</a>
        <a class="op-btn op-btn-chat" href="javascript:;">继续沟通</a>
        <button class="irrelevant-btn">查看更多</button>
      </div>
    `
    // JSDOM 默认 offsetWidth 为 0，模拟 getClientRects 使可见性探测通过
    for (const el of Array.from(container.querySelectorAll('a, button'))) {
      ;(el as any).getClientRects = () => [{ width: 100, height: 40 }]
    }

    const btns = findApplyButtons(container)
    expect(btns.length).toBe(2)
    expect(btns[0].textContent).toContain('立即沟通')
    expect(btns[1].textContent).toContain('继续沟通')
  })

  it('strictly excludes "不合适", "不感兴趣", and dislike buttons from apply buttons', async () => {
    const { findApplyButtons, isNegativeButton, isPositiveApplyButton } = await import(
      '../src/shared/platform/boss/action-simulator'
    )

    const container = document.createElement('div')
    container.innerHTML = `
      <div class="job-detail-box">
        <a class="op-btn op-btn-chat" href="javascript:;" ka="job_detail_chat_dislike">不合适</a>
        <button class="btn btn-outline" ka="job_card_chat_dislike">不感兴趣</button>
        <a class="op-btn" title="屏蔽此岗位">屏蔽</a>
        <button class="btn btn-startchat" ka="job_detail_start_chat">立即沟通</button>
        <button class="btn-close">关闭</button>
      </div>
    `
    for (const el of Array.from(container.querySelectorAll('a, button'))) {
      ;(el as any).getClientRects = () => [{ width: 100, height: 40 }]
    }

    const dislikeBtn = container.querySelector('[ka="job_detail_chat_dislike"]')!
    expect(isNegativeButton(dislikeBtn)).toBe(true)
    expect(isPositiveApplyButton(dislikeBtn)).toBe(false)

    const applyBtns = findApplyButtons(container)
    expect(applyBtns.length).toBe(1)
    expect(applyBtns[0].textContent?.trim()).toBe('立即沟通')
  })

  it('clickApplyButton prioritizes 立即沟通 and never clicks 不合适 even if it appears first', async () => {
    const { clickApplyButton } = await import(
      '../src/shared/platform/boss/action-simulator'
    )

    const container = document.createElement('div')
    container.innerHTML = `
      <div class="job-detail-box">
        <!-- 不合适按钮排在 DOM 的最前部 -->
        <a id="btn-dislike" class="op-btn op-btn-chat" href="javascript:;" ka="job_detail_chat_dislike">不合适</a>
        <button id="btn-chat" class="btn btn-startchat" ka="job_detail_start_chat">立即沟通</button>
      </div>
    `
    for (const el of Array.from(container.querySelectorAll('a, button'))) {
      ;(el as any).getClientRects = () => [{ width: 100, height: 40 }]
    }

    const dislikeBtn = container.querySelector('#btn-dislike') as HTMLElement
    const chatBtn = container.querySelector('#btn-chat') as HTMLElement

    let dislikeClicked = false
    let chatClicked = false
    dislikeBtn.onclick = () => { dislikeClicked = true }
    chatBtn.onclick = () => { chatClicked = true }

    const success = await clickApplyButton(container)
    expect(success).toBe(true)
    expect(dislikeClicked).toBe(false)
    expect(chatClicked).toBe(true)
  })

  it('dismissUnexpectedModals dismisses "请选择不合适的原因" modal and removes blocking masks', async () => {
    const { dismissUnexpectedModals } = await import(
      '../src/shared/platform/boss/action-simulator'
    )

    const modal = document.createElement('div')
    modal.className = 'dialog-wrap'
    modal.innerHTML = `
      <div class="dialog-container">
        <h3 class="dialog-title">请选择不合适的原因</h3>
        <ul class="reason-list"><li>与期望岗位不匹配</li></ul>
        <button class="btn-cancel">取消</button>
      </div>
    `
    const mask = document.createElement('div')
    mask.className = 'dialog-mask'

    document.body.appendChild(mask)
    document.body.appendChild(modal)

    ;(modal as any).getClientRects = () => [{ width: 300, height: 200 }]
    ;(mask as any).getClientRects = () => [{ width: 800, height: 600 }]

    let cancelClicked = false
    modal.querySelector<HTMLElement>('.btn-cancel')!.onclick = () => {
      cancelClicked = true
      modal.remove()
    }

    const dismissed = dismissUnexpectedModals(document)
    expect(dismissed).toBe(true)
    expect(cancelClicked).toBe(true)
    expect(mask.style.display).toBe('none')

    modal.remove()
    mask.remove()
  })
})

describe('Job Filter & Resume Career Alignment Engine', () => {
  it('extracts target careers from resume or filters', async () => {
    const { extractTargetCareers } = await import('../src/shared/agent/job-filter')

    // 1. From filters
    const fromFilters = extractTargetCareers(null, {
      jobTitles: '全栈工程师 技术经理',
      locations: '',
      salaryMin: null,
      salaryMax: null,
      experience: '',
      education: '',
      excludeKeywords: '',
      enableAiMatch: true,
      minMatchScore: 60,
    })
    expect(fromFilters).toEqual(['全栈工程师', '技术经理'])

    // 2. From resume work experience
    const mockResume: any = {
      name: '张三_技术经理_6年.pdf',
      structuredData: {
        workExperience: [{ position: '高级全栈工程师' }],
        summary: '6年全栈工程师，负责平台架构设计',
      },
    }
    const fromResume = extractTargetCareers(mockResume, null)
    expect(fromResume).toContain('高级全栈工程师')
    expect(fromResume).toContain('技术经理')
  })

  it('correctly matches and rejects careers based on resume orientation', async () => {
    const { isJobMatchingCareer } = await import('../src/shared/agent/job-filter')

    const targets = ['全栈工程师', '技术经理']

    // Positive matches
    expect(isJobMatchingCareer('全栈工程师（AI 智能体方向）', targets)).toBe(true)
    expect(isJobMatchingCareer('高级全栈开发专家', targets)).toBe(true)
    expect(isJobMatchingCareer('技术经理/架构师', targets)).toBe(true)
    expect(isJobMatchingCareer('研发技术主管', targets)).toBe(true)

    // Negative hard rejects
    expect(isJobMatchingCareer('电话销售专员', targets)).toBe(false)
    expect(isJobMatchingCareer('客服专员/在线答疑', targets)).toBe(false)
    expect(isJobMatchingCareer('前台行政前台接待', targets)).toBe(false)
    expect(isJobMatchingCareer('财务出纳', targets)).toBe(false)
  })

  it('filters job cards by freshness/active time', async () => {
    const { isJobMatchingFreshness } = await import('../src/shared/agent/job-filter')

    // Today
    expect(isJobMatchingFreshness('刚刚活跃', 'today')).toBe(true)
    expect(isJobMatchingFreshness('今日活跃', 'today')).toBe(true)
    expect(isJobMatchingFreshness('3天前', 'today')).toBe(false)
    expect(isJobMatchingFreshness('半年前活跃', 'today')).toBe(false)

    // 3 Days
    expect(isJobMatchingFreshness('昨天', '3days')).toBe(true)
    expect(isJobMatchingFreshness('3日内活跃', '3days')).toBe(true)
    expect(isJobMatchingFreshness('半年前活跃', '3days')).toBe(false)

    // Week
    expect(isJobMatchingFreshness('本周活跃', 'week')).toBe(true)
    expect(isJobMatchingFreshness('4天前', 'week')).toBe(true)
    expect(isJobMatchingFreshness('半年前活跃', 'week')).toBe(false)
  })

  it('evaluates candidate jobs holistically including blacklist, salary, and career', async () => {
    const { evaluateJobCandidate } = await import('../src/shared/agent/job-filter')

    const validJob: any = {
      id: 'job-1',
      title: '资深全栈工程师',
      companyName: '优质科技有限公司',
      salary: '25-35K',
      location: '深圳',
      publishedAt: '今日活跃',
      tags: ['React', 'Node.js'],
    }

    // Pass
    const passRes = evaluateJobCandidate(validJob, {
      filters: {
        jobTitles: '全栈工程师',
        locations: '深圳',
        salaryMin: 20,
        salaryMax: 40,
        experience: '',
        education: '',
        excludeKeywords: '',
        publishTime: 'week',
        enableAiMatch: true,
        minMatchScore: 60,
      },
      targetCareers: ['全栈工程师'],
      blacklist: new Set(['不良外包公司']),
    })
    expect(passRes.pass).toBe(true)

    // Blacklist hit
    const blacklistRes = evaluateJobCandidate(
      { ...validJob, companyName: '不良外包公司' },
      {
        targetCareers: ['全栈工程师'],
        blacklist: new Set(['不良外包公司']),
      },
    )
    expect(blacklistRes.pass).toBe(false)
    expect(blacklistRes.reason).toContain('黑名单')

    // Off-target career hit
    const offTargetRes = evaluateJobCandidate(
      { ...validJob, title: '电话销售专员' },
      {
        targetCareers: ['全栈工程师'],
      },
    )
    expect(offTargetRes.pass).toBe(false)
    expect(offTargetRes.reason).toContain('职业方向不匹配')

    // Stale time hit
    const staleRes = evaluateJobCandidate(
      { ...validJob, publishedAt: '半年前活跃' },
      {
        filters: {
          jobTitles: '',
          locations: '',
          salaryMin: null,
          salaryMax: null,
          experience: '',
          education: '',
          excludeKeywords: '',
          publishTime: 'week',
          enableAiMatch: true,
          minMatchScore: 60,
        },
        targetCareers: ['全栈工程师'],
      },
    )
    expect(staleRes.pass).toBe(false)
    expect(staleRes.reason).toContain('活跃度不符')
  })
})

describe('Text Sanitizer & Font Glyph Decoder', () => {
  it('decodes Boss encrypted PUA font numbers correctly', async () => {
    const { decodeBossFontGlyphs } = await import('../src/shared/utils/text-sanitizer')

    // \uE033 = 3, \uE031 = 1, \uE035 = 5, \uE032 = 2, \uE036 = 6
    const raw = '全栈工程师、\uE033\uE031-\uE035\uE031K·\uE032\uE036薪'
    expect(decodeBossFontGlyphs(raw)).toBe('全栈工程师、31-51K·26薪')
  })

  it('strips Boss anti-scraping CSS rules and decoy words', async () => {
    const { sanitizeJobText } = await import('../src/shared/utils/text-sanitizer')

    const raw =
      '.QWyReFEWzknP{display:inline-block;width:0.1px;height:0.1px;overflow:hidden;visibility: hidden;}.wAEMXrfAK{display:inline-block;font-size:0!important;width:1em;height:1em;visibility:hidden;line-height:0;}岗位职责： 1、kanzhun负责公司 B boss端 AI 智能体平台的全栈开发与架构设计，覆盖前端管理来自BOSS直聘后台、客户端交互页面'
    const cleaned = sanitizeJobText(raw)

    expect(cleaned).not.toContain('.QWyReFEWzknP')
    expect(cleaned).not.toContain('kanzhun')
    expect(cleaned).not.toContain('来自BOSS直聘后台')
    expect(cleaned).toContain('负责公司 B端 AI 智能体平台的全栈开发与架构设计')
  })
})
