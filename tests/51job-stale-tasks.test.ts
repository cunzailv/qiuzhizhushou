// @vitest-environment jsdom
/**
 * 2026-11-09 真实 Chrome 现场复盘：修好 51job 适配器后，AIbot 仍在报
 *   ❌ 投递未完成：[51job] 资深后端开发工程师
 *     (原因: 页面中未找到对应岗位卡片或详情无法展开)｜现场：0 张岗位卡片 / 167 个详情链接
 *
 * 从扩展的 chrome.storage.local 里挖出队列，看到修复前入队的**脏任务**：
 *   jobId = jobUrl = "https://jobs.51job.com/all/coUzxRPVA2VmkAYQdlVjY.html"（公司页！）
 * 这些任务永远定位不到卡片 → failed → 触发「连续未定位，清空待投缓存」自愈，
 * 把新采到的岗位一起清掉，流水线反复空转。
 *
 * 本文件锁死两件事：
 *  1) 历史脏任务必须被清掉，且采集/入队链路不能再写回这种任务；
 *  2) 执行投递前必须把后台 tab 导航回「岗位列表页」——51job 点岗位链接是整页跳转，
 *     上一个任务结束后 tab 停在详情页，isOnTargetSearchUrl 只看关键词/页码会误判。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  createNewCampaign,
  getCampaign,
  saveCampaign,
  appendTasksToCampaign,
  isStaleNonJobUrlTask,
  purgeStaleJobUrlTasks,
  type ApplyTask,
} from '../src/shared/agent/queue-store'
import { isPlatformListPageUrl } from '../src/background/tab-manager'

const ROOT = process.cwd()
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf-8')
const SERVICE = 'src/background/campaign-service.ts'
const TAB_MANAGER = 'src/background/tab-manager.ts'
const STORE = 'src/shared/agent/queue-store.ts'

const COMPANY_URL = 'https://jobs.51job.com/all/coUzxRPVA2VmkAYQdlVjY.html'
const JOB_URL = 'https://jobs.51job.com/shenzhen-ftq/173795328.html?s=pchome_jobgroup_joblist'

const mockStorage: Record<string, unknown> = {}
beforeEach(() => {
  for (const k of Object.keys(mockStorage)) delete mockStorage[k]
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: vi.fn(async (keys: string | string[]) => {
          if (typeof keys === 'string') return { [keys]: mockStorage[keys] }
          const res: Record<string, unknown> = {}
          for (const k of keys) res[k] = mockStorage[k]
          return res
        }),
        set: vi.fn(async (obj: Record<string, unknown>) => { Object.assign(mockStorage, obj) }),
        remove: vi.fn(async (keys: string | string[]) => {
          for (const k of Array.isArray(keys) ? keys : [keys]) delete mockStorage[k]
        }),
      },
    },
  })
})

function makeTask(over: Partial<ApplyTask> = {}): ApplyTask {
  return {
    id: '51job:job-1',
    platform: '51job',
    jobId: 'job-1',
    jobTitle: 'PHP开发工程师',
    company: '凯帝纳国际货运代理',
    jobUrl: JOB_URL,
    status: 'pending',
    attempts: 0,
    createdAt: Date.now(),
    ...over,
  }
}

describe('旧版 51job 公司页脏任务识别', () => {
  it('公司页同时作为 jobUrl 与 jobId → 判脏（现场真实数据）', () => {
    expect(isStaleNonJobUrlTask(makeTask({ jobUrl: COMPANY_URL, jobId: COMPANY_URL }))).toBe(true)
  })

  it('公司是 /all/ 聚合页 → 判脏', () => {
    expect(isStaleNonJobUrlTask(makeTask({ jobUrl: 'https://jobs.51job.com/all/coABC123.html' }))).toBe(true)
  })

  it('普通岗位详情 URL（数字 ID）→ 不判脏', () => {
    expect(isStaleNonJobUrlTask(makeTask({ jobUrl: JOB_URL, jobId: '173795328' }))).toBe(false)
  })

  it('新版带 jobid query 的岗位链接 → 不判脏', () => {
    expect(isStaleNonJobUrlTask(makeTask({ jobUrl: 'https://we.51job.com/pc/jobdetail?jobid=173795328' }))).toBe(false)
  })

  it('老结构空 jobUrl + data-jobid → 不判脏（靠 findTargetCard 兜底，不能误杀）', () => {
    expect(isStaleNonJobUrlTask(makeTask({ jobUrl: '', jobId: 'job51-001' }))).toBe(false)
  })

  it('其它平台不受影响', () => {
    expect(isStaleNonJobUrlTask(makeTask({ platform: 'boss', jobUrl: COMPANY_URL, jobId: COMPANY_URL }))).toBe(false)
  })
})

describe('purgeStaleJobUrlTasks：真的把脏任务从队列里清掉', () => {
  it('清掉 failed / pending 的脏任务，保留干净任务，并返回删除条数', async () => {
    await createNewCampaign()
    const campaign = await getCampaign()
    expect(campaign).not.toBeNull()
    campaign!.tasks = [
      makeTask({ id: 'dirty-1', jobUrl: COMPANY_URL, jobId: COMPANY_URL, status: 'failed' }),
      makeTask({ id: 'dirty-2', jobUrl: COMPANY_URL, jobId: COMPANY_URL, status: 'pending' }),
      makeTask({ id: 'clean-1', jobUrl: JOB_URL, jobId: '173795328' }),
    ]
    await saveCampaign(campaign!)

    expect(await purgeStaleJobUrlTasks()).toBe(2)
    const after = await getCampaign()
    expect(after!.tasks.map((t) => t.id)).toEqual(['clean-1'])
  })

  it('幂等：没有脏任务时返回 0 且不写盘', async () => {
    await createNewCampaign()
    const campaign = await getCampaign()
    campaign!.tasks = [makeTask()]
    await saveCampaign(campaign!)
    const setSpy = vi.spyOn(chrome.storage.local, 'set')
    expect(await purgeStaleJobUrlTasks()).toBe(0)
    expect(setSpy).not.toHaveBeenCalled()
  })

  it('清掉脏任务后，同名岗位可以重新入队（不再被去重键挡住）', async () => {
    await createNewCampaign()
    const campaign = await getCampaign()
    campaign!.tasks = [makeTask({ id: 'dirty', jobUrl: COMPANY_URL, jobId: COMPANY_URL, status: 'failed' })]
    await saveCampaign(campaign!)
    await purgeStaleJobUrlTasks()

    const added = await appendTasksToCampaign([{
      id: '51job:173795328',
      platform: '51job',
      jobId: '173795328',
      jobTitle: 'PHP开发工程师',
      company: '凯帝纳国际货运代理',
      jobUrl: JOB_URL,
    }])
    expect(added).toBe(1)
  })
})

describe('入队链路防复发', () => {
  it('采集结果里混入公司页任务时直接过滤掉', async () => {
    await createNewCampaign()
    const added = await appendTasksToCampaign([
      {
        id: '51job:dirty', platform: '51job', jobId: COMPANY_URL,
        jobTitle: '后端开发工程师', company: '某公司', jobUrl: COMPANY_URL,
      },
      {
        id: '51job:173795328', platform: '51job', jobId: '173795328',
        jobTitle: 'PHP开发工程师', company: '凯帝纳国际货运代理', jobUrl: JOB_URL,
      },
    ])
    expect(added).toBe(1)
    const campaign = await getCampaign()
    expect(campaign!.tasks.map((t) => t.id)).toEqual(['51job:173795328'])
  })
})

describe('isPlatformListPageUrl：执行前必须回到岗位列表页', () => {
  it('51job 搜索页是列表页', () => {
    expect(isPlatformListPageUrl('51job', 'https://we.51job.com/pc/search?keyword=PHP')).toBe(true)
    expect(isPlatformListPageUrl('51job', 'https://we.51job.com/pc/search?keyword=PHP&pageNum=2')).toBe(true)
  })

  it('51job 公司页 / 岗位详情页 / 城市聚合页都不是列表页', () => {
    expect(isPlatformListPageUrl('51job', COMPANY_URL)).toBe(false)
    expect(isPlatformListPageUrl('51job', JOB_URL)).toBe(false)
    expect(isPlatformListPageUrl('51job', 'https://jobs.51job.com/shantou/')).toBe(false)
  })

  it('登录页 / 空 URL 不是列表页', () => {
    expect(isPlatformListPageUrl('51job', 'https://login.51job.com/login.php')).toBe(false)
    expect(isPlatformListPageUrl('51job', undefined)).toBe(false)
  })

  it('其它平台的详情页被排除，列表页保留', () => {
    expect(isPlatformListPageUrl('boss', 'https://www.zhipin.com/job_detail/abc.html')).toBe(false)
    expect(isPlatformListPageUrl('boss', 'https://www.zhipin.com/web/geek/job?query=PHP')).toBe(true)
    expect(isPlatformListPageUrl('liepin', 'https://www.liepin.com/zhaopin/?key=PHP')).toBe(true)
    expect(isPlatformListPageUrl('maimai', 'https://maimai.cn/jobs?query=PHP')).toBe(true)
  })
})

describe('接线静态契约', () => {
  it('执行任务时传入 requireListPage', () => {
    const s = read(SERVICE)
    expect(s).toContain('requireListPage: true')
    expect(s).toContain('ensurePlatformTab(task.platform, taskKeyword || undefined, taskPage')
  })

  it('tick 开头调用队列清洗并写日志', () => {
    const s = read(SERVICE)
    expect(s).toContain('purgeStaleJobUrlTasks()')
    expect(s).toContain('已清理 ${purged} 条旧版 51job 公司页脏任务')
  })

  it('tab-manager 复用分支把 offListPage 纳入导航条件', () => {
    const s = read(TAB_MANAGER)
    expect(s).toContain('offListPage')
    expect(s).toContain('opts.requireListPage === true && !isPlatformListPageUrl')
  })

  it('queue-store 在入队前过滤脏任务', () => {
    expect(read(STORE)).toContain('tasks = tasks.filter((t) => !isStaleNonJobUrlTask(t))')
  })
})
