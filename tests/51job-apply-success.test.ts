// @vitest-environment jsdom
/**
 * 2026-11-09 第四轮真实账号现场复盘（重载后的新日志）：
 *
 *   ⚠️ 页面未找到岗位卡片：后端开发工程师（AI 网关）-宠物健康
 *      （当前页（页面 jobs.51job.com/applysuccess.php） 0 张岗位卡片 / 1 个岗位详情链接 ...）
 *   ⚠️ 页面未找到岗位卡片：全栈软件工程师
 *      （当前页（页面 we.51job.com/pc/search） 0 张岗位卡片 / 0 个岗位详情链接 / 正文 1698 字）
 *
 * Chrome 里同时留着一个标签，标题是 `jobs.51job.com/applysuccess.php?jobid=173879321`
 * —— 那是 51job 的**投递成功回执页**。也就是说岗位真的投成功了，插件却没记上：
 * 51job 点「投递」是整页跳转，content script 上下文被销毁，
 * 「点击 → 采集平台确认 → 回传 done」这半段根本跑不完；后台 tab 又停在成功页，
 * 下一个任务在那儿找岗位卡片，连续两次就触发 clearPendingTasks 自愈清空队列。
 *
 * 另一个页面 URL 是对的（we.51job.com/pc/search），但正文只有 1698 字、0 张卡片，
 * 是 SPA 岗位列表还没渲染出来的空壳页；用同一 Chrome 手动打开搜索页确认岗位卡片正常，
 * 所以不是反爬 / 未登录，而是导航竞态 + 渲染等待不足。
 *
 * 本文件锁死：成功页补记（含幂等与精确 jobid 匹配）、空壳页标 skipped 不清队列、
 * 导航必须等 URL 真的变了。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  isApplySuccessUrl,
  parseApplySuccessJobId,
  findApplySuccessTask,
  type ApplySuccessTaskLike,
} from '../src/shared/agent/apply-success'
import { waitForJobListReady } from '../src/content/task-runner'

const ROOT = process.cwd()
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf-8')
const SERVICE = 'src/background/campaign-service.ts'
const BG_INDEX = 'src/background/index.ts'
const RUNNER = 'src/content/task-runner.ts'
const TAB_MANAGER = 'src/background/tab-manager.ts'

const SUCCESS_URL = 'https://jobs.51job.com/applysuccess.php?jobid=173879321'
const SEARCH_URL = 'https://we.51job.com/pc/search?keyword=php%E5%BC%80%E5%8F%91'
const COMPANY_URL = 'https://jobs.51job.com/all/coUzxRPVA2VmkAYQdlVjY.html'
const JOB_URL = 'https://jobs.51job.com/shenzhen-ftq/173795328.html?s=pchome_jobgroup_joblist'

function makeTask(over: Partial<ApplySuccessTaskLike> = {}): ApplySuccessTaskLike {
  return {
    id: '51job:173879321',
    platform: '51job',
    jobId: '173879321',
    jobUrl: JOB_URL,
    status: 'running',
    ...over,
  }
}

describe('51job 投递成功页识别', () => {
  it('认得现场真实回执页，不把普通页面当回执', () => {
    expect(isApplySuccessUrl(SUCCESS_URL)).toBe(true)
    expect(isApplySuccessUrl('https://jobs.51job.com/applysuccess.php')).toBe(true)
    expect(isApplySuccessUrl('https://www.51job.com/apply/success/173879321')).toBe(true)
    expect(isApplySuccessUrl(SEARCH_URL)).toBe(false)
    expect(isApplySuccessUrl(COMPANY_URL)).toBe(false)
    expect(isApplySuccessUrl(JOB_URL)).toBe(false)
    expect(isApplySuccessUrl('')).toBe(false)
    expect(isApplySuccessUrl(null)).toBe(false)
  })

  it('从回执页提取 jobid，普通页面一律返回 null', () => {
    expect(parseApplySuccessJobId(SUCCESS_URL)).toBe('173879321')
    expect(parseApplySuccessJobId('https://jobs.51job.com/applysuccess.php?jobId=173879321&t=1')).toBe('173879321')
    expect(parseApplySuccessJobId('https://www.51job.com/apply/success/173879321')).toBe('173879321')
    expect(parseApplySuccessJobId('https://jobs.51job.com/applysuccess.php')).toBeNull()
    expect(parseApplySuccessJobId(SEARCH_URL)).toBeNull()
    expect(parseApplySuccessJobId(JOB_URL)).toBeNull()
  })
})

describe('成功页 → 精确补记到对应任务', () => {
  it('按 jobId 命中，且优先当前 running 的任务', () => {
    const tasks = [
      makeTask({ id: '51job:old', jobId: '173879321', status: 'skipped' }),
      makeTask({ id: '51job:current', jobId: '173879321', status: 'running' }),
    ]
    expect(findApplySuccessTask(tasks, SUCCESS_URL)?.id).toBe('51job:current')
  })

  it('content 因整页导航中断时任务可能已被标 failed，也要能补记', () => {
    const tasks = [makeTask({ status: 'failed' })]
    expect(findApplySuccessTask(tasks, SUCCESS_URL)?.id).toBe('51job:173879321')
  })

  it('已 done 的任务不再补记（同一成功页重复触发不重复计配额）', () => {
    expect(findApplySuccessTask([makeTask({ status: 'done' })], SUCCESS_URL)).toBeNull()
  })

  it('不误伤其它平台 / 其它岗位 / 拿不到 jobid 的回执页', () => {
    expect(findApplySuccessTask([makeTask({ platform: 'boss' })], SUCCESS_URL)).toBeNull()
    expect(findApplySuccessTask([makeTask({ jobId: '999999999', id: '51job:999999999' })], SUCCESS_URL)).toBeNull()
    expect(findApplySuccessTask([makeTask()], 'https://jobs.51job.com/applysuccess.php')).toBeNull()
    expect(findApplySuccessTask([makeTask()], SEARCH_URL)).toBeNull()
  })

  it('jobId 落在 jobUrl / id 里也能关联', () => {
    const tasks = [makeTask({ id: '51job:some-key', jobId: 'some-key', jobUrl: `${JOB_URL}&jobid=173879321` })]
    expect(findApplySuccessTask(tasks, SUCCESS_URL)?.id).toBe('51job:some-key')
  })
})

describe('列表页就绪等待：空壳页不再误判为「找不到岗位卡片」', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('有岗位卡片时立即就绪', async () => {
    document.body.innerHTML = '<div class="joblist"><div class="joblist-item">PHP开发工程师</div></div>'
    expect(await waitForJobListReady(100)).toBe(true)
  })

  it('有岗位详情链接时立即就绪', async () => {
    document.body.innerHTML = `<a href="${JOB_URL}">PHP开发工程师</a>`
    expect(await waitForJobListReady(100)).toBe(true)
  })

  it('空壳页等不到卡片就返回未就绪', async () => {
    document.body.innerHTML = '<div>求职招聘指南</div>'
    expect(await waitForJobListReady(60)).toBe(false)
  })

  it('投递成功回执页永远判未就绪，哪怕页面上有链接', async () => {
    document.body.innerHTML = `<a href="${JOB_URL}">相关岗位</a>`
    expect(await waitForJobListReady(100, SUCCESS_URL)).toBe(false)
  })
})

describe('全链路接线静态契约', () => {
  it('background 顶层监听 tab URL 变化并调用补记入口', () => {
    const bg = read(BG_INDEX)
    expect(bg).toContain('chrome.tabs.onUpdated.addListener')
    expect(bg).toContain('isApplySuccessUrl(url)')
    expect(bg).toContain('recordApplySuccessFromUrl(url)')
  })

  it('补记走统一 handleTaskExecutionResult，且是 confirmed 的 done', () => {
    const service = read(SERVICE)
    expect(service).toContain('export async function recordApplySuccessFromUrl')
    expect(service).toContain('findApplySuccessTask(campaign.tasks, url)')
    expect(service).toContain("status: 'done'")
    expect(service).toContain("level: 'confirmed'")
    expect(service).toContain('平台确认依据：投递成功页')
    expect(service).toContain('await handleTaskExecutionResult(task, {')
  })

  it('页面未就绪标 skipped、显式重置连续失败计数、不清空队列', () => {
    const runner = read(RUNNER)
    const service = read(SERVICE)
    expect(runner).toContain('waitForJobListReady')
    expect(runner).toContain("status: 'skipped'")
    expect(runner).toContain('列表页未就绪')
    expect(service).toContain("result.failReason?.includes('列表页未就绪')")
    expect(service).toContain('consecutiveNotFoundMap[task.platform] = 0')
    expect(service).toContain('任务保留待重试，不清空队列')
  })

  it('导航后必须等 URL 真的变了，不再只看 status=complete', () => {
    const tab = read(TAB_MANAGER)
    expect(tab).toContain('async function waitForTabNavigation')
    expect(tab).toContain('await waitForTabNavigation(tabId, targetUrl, 25_000)')
    expect(tab).toContain('current.startsWith(expected) && tab.status ===')
  })
})
