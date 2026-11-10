/**
 * 回归用户反馈：「海投也要根据岗位名字才行啊，不能我写了 php 后台 AI 全栈开发
 * 不投，投了产品经理 销售 啥的」。
 *
 * 旧链路的三处漏点：
 *  1. content 的 strictRelevanceGate 被 mustAchieve / fastMode / relaxCareerFilter 关掉；
 *  2. job-filter 把「职业方向不匹配」标 soft，采集层再用 softMatchedJobs 补回队列；
 *  3. isJobMatchingCareer 的包含规则让泛词「AI」把「AI产品经理」判成对口。
 *
 * 本文件锁死：岗位名称是硬闸门，任何模式都不绕过；海投 / 必达只放宽可控参数。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  isJobTitleAllowed,
  isCareerGateActive,
  describeCareerGate,
  isGenericCareerToken,
} from '../src/shared/agent/career-gate'
import {
  normalizeCareerTokens,
  extractTargetCareers,
  isJobMatchingCareer,
  evaluateJobCandidate,
} from '../src/shared/agent/job-filter'
import {
  hasSoftwareDirection,
  matchesCareerFamily,
  NON_SOFTWARE_DOMAIN_RE,
  SOFTWARE_DEV_ROLE_RE,
} from '../src/shared/agent/career-gate'
import { shouldBypassRelevanceGate } from '../src/shared/agent/must-achieve'
import { isRecyclableTask, CAREER_GATE_BLOCK_MARK } from '../src/shared/agent/queue-store'

const ROOT = process.cwd()
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf-8')

/** 用户在「岗位名称」里的真实填法 */
const USER_DIRECTIONS = normalizeCareerTokens('php 后台 AI  全栈开发')

const job = (title: string) =>
  ({ id: '1', title, companyName: 'C', tags: [], jobUrl: 'u' }) as any

describe('用户填写的岗位名称解析', () => {
  it('空格会把「php 后台 AI 全栈开发」拆成四个独立方向，且不会被长句清洗掉', () => {
    expect(USER_DIRECTIONS).toEqual(['php', '后台', 'AI', '全栈开发'])
    expect(isCareerGateActive(USER_DIRECTIONS)).toBe(true)
  })

  it('FilterPanel 的岗位名称优先于简历推断', () => {
    const careers = extractTargetCareers(null, { jobTitles: 'php 后台 AI 全栈开发' } as any)
    expect(careers).toEqual(USER_DIRECTIONS)
  })

  it('没填方向时不启用硬闸门，也不擅自否决整页', () => {
    expect(isCareerGateActive([])).toBe(false)
    expect(isJobTitleAllowed('产品经理', []).allowed).toBe(true)
    expect(describeCareerGate([])).toContain('未填写岗位名称')
  })
})

describe('岗位名称硬闸门：用户填了 php / 后台 / AI / 全栈开发', () => {
  it('对口的开发岗全部放行（含同义不同字与括号补充说明）', () => {
    const allowed = [
      'PHP开发工程师',
      'php后台开发',
      '后端开发工程师',
      '全栈开发工程师',
      '服务端研发工程师（Go）',
      'AI算法工程师',
      '高级PHP后台开发工程师',
      'PHP开发工程师（销售系统方向）',
      '兼职Java后端开发工程师',
      '医疗软件后端开发工程师',
      // 方向只写「后台」时，只写语言栈、不写「后端」二字的岗位仍算同族
      'Laravel开发工程师',
    ]
    for (const title of allowed) {
      expect(isJobTitleAllowed(title, USER_DIRECTIONS).allowed, title).toBe(true)
    }
  })

  it('产品经理 / 销售 / 客服等不对口岗位一律否决，标题里带 AI 也不行', () => {
    const denied = [
      '产品经理',
      'AI产品经理',
      'WMS 产品经理',
      '高级产品总监',
      '销售',
      '销售经理',
      '电话销售',
      '销售工程师',
      '客户成功经理',
      '客服专员',
      '行政专员',
      '运营专员',
      '新媒体运营',
      '市场经理',
      '项目经理',
      'UI设计师',
      '课程顾问',
      'PHP技术支持',
      'AI训练师',
      '招聘PHP培训讲师',
      // 用户第二轮反馈：「还是乱投 项目主管 电子研发」
      '项目主管',
      '项目总监',
      '研发主管',
      '电子研发',
      '电子研发工程师',
      '硬件研发工程师',
      '电路设计工程师',
      'PCB Layout工程师',
      '机械结构工程师',
      '电气工程师',
      '射频工程师',
      '工艺工程师',
    ]
    const leaked = denied.filter((title) => isJobTitleAllowed(title, USER_DIRECTIONS).allowed)
    expect(leaked).toEqual([])
  })

  it('用户第三轮反馈：MES / WMS 等通用业务系统开发岗不算「php 后台 AI 全栈开发」', () => {
    const denied = [
      'MES系统开发工程师（含WMS模块）',
      'MES系统开发工程师',
      'WMS开发工程师',
      'ERP系统开发工程师',
      'OA系统开发工程师',
      'CRM系统开发',
      '系统开发工程师',
      '软件工程师',
      '高级软件工程师',
      '研发工程师',
      '业务系统开发',
      '嵌入式软件工程师',
      '电商销售系统开发工程师',
      // 技术管理岗白名单也不能绕过方向族谱（用户没填架构 / 技术总监）
      '技术总监',
      '架构师',
      '技术经理',
      // 含 ai 字母但不是 AI 方向的岗位
      'Email系统开发工程师',
    ]
    const leaked = denied.filter((title) => isJobTitleAllowed(title, USER_DIRECTIONS).allowed)
    expect(leaked).toEqual([])
  })

  it('用户明确填了架构 / 技术总监时，同方向技术管理岗照常放行', () => {
    expect(isJobTitleAllowed('架构师', ['架构师']).allowed).toBe(true)
    expect(isJobTitleAllowed('技术总监', ['技术总监']).allowed).toBe(true)
    expect(isJobTitleAllowed('技术负责人', ['技术经理', '架构师']).allowed).toBe(true)
  })

  it('方向族谱匹配：同义不同字 / 语言栈命中才算同方向', () => {
    expect(matchesCareerFamily('PHP开发工程师', ['后台开发'])).toBe(true)
    expect(matchesCareerFamily('后端开发工程师', ['后台'])).toBe(true)
    expect(matchesCareerFamily('AI算法工程师', ['AI'])).toBe(true)
    expect(matchesCareerFamily('全栈工程师', ['全栈开发'])).toBe(true)
    expect(matchesCareerFamily('MES系统开发工程师', USER_DIRECTIONS)).toBe(false)
    expect(matchesCareerFamily('高级软件工程师', USER_DIRECTIONS)).toBe(false)
  })

  it('否决原因带上用户填的方向，便于日志里核对到底按什么在筛', () => {
    const verdict = isJobTitleAllowed('AI产品经理', USER_DIRECTIONS)
    expect(verdict.allowed).toBe(false)
    expect(verdict.reason).toContain('产品经理')
    expect(verdict.reason).toContain('php / 后台 / AI / 全栈开发')
  })

  it('用户自己就在找产品经理时，方向按职能词严格匹配，不再塞开发岗', () => {
    expect(isJobTitleAllowed('高级产品经理', ['产品经理']).allowed).toBe(true)
    expect(isJobTitleAllowed('AI产品经理', ['产品经理']).allowed).toBe(true)
    expect(isJobTitleAllowed('PHP开发工程师', ['产品经理']).allowed).toBe(false)
    expect(isJobTitleAllowed('销售经理', ['产品经理']).allowed).toBe(false)
  })

  it('空标题不蒙混过关', () => {
    expect(isJobTitleAllowed('', USER_DIRECTIONS).allowed).toBe(false)
    expect(isJobTitleAllowed('（急聘）', USER_DIRECTIONS).allowed).toBe(false)
  })

  it('方向是「研发助理」时不把它误判成非开发职能', () => {
    expect(isJobTitleAllowed('PHP开发工程师', ['研发助理']).allowed).toBe(true)
    expect(isJobTitleAllowed('产品经理', ['研发助理']).allowed).toBe(false)
  })

  it('用户填「前台开发」时，前端开发岗不被行政职能词误杀', () => {
    expect(isJobTitleAllowed('前台开发工程师', ['前台开发']).allowed).toBe(true)
    expect(isJobTitleAllowed('行政前台', USER_DIRECTIONS).allowed).toBe(false)
    // 用户填「后台开发」时前端岗本就不该投
    expect(isJobTitleAllowed('前台开发工程师', ['后台开发']).allowed).toBe(false)
  })
})

describe('泛词误命中修复', () => {
  it('AI / 大模型这类泛词被识别为修饰词，不能单独代表岗位方向', () => {
    expect(isGenericCareerToken('AI')).toBe(true)
    expect(isGenericCareerToken('大模型')).toBe(true)
    expect(isGenericCareerToken('后台开发')).toBe(false)
    expect(isGenericCareerToken('全栈开发')).toBe(false)
    expect(isGenericCareerToken('PHP')).toBe(false)
  })

  it('isJobMatchingCareer 不再把「AI产品经理」当成 AI 开发岗', () => {
    expect(isJobMatchingCareer('AI产品经理', USER_DIRECTIONS)).toBe(false)
    expect(isJobMatchingCareer('AI算法工程师', ['AI'])).toBe(true)
    expect(isJobMatchingCareer('PHP开发工程师', ['PHP开发'])).toBe(true)
    expect(isJobMatchingCareer('销售工程师', ['PHP开发'])).toBe(false)
  })
})

describe('入队评估：方向不符是硬拦截，不再标 soft 被补回队列', () => {
  it('不对口岗位 pass=false 且不带 soft', () => {
    for (const title of ['AI产品经理', '销售经理', '客服专员']) {
      const res = evaluateJobCandidate(job(title), {
        filters: null,
        targetCareers: USER_DIRECTIONS,
        blacklist: new Set(),
      })
      expect(res.pass, title).toBe(false)
      expect(res.soft, title).toBeUndefined()
    }
  })

  it('启用硬闸门后跳过族谱白名单，同义不同字的开发岗照样入队', () => {
    const res = evaluateJobCandidate(job('PHP开发工程师'), {
      filters: null,
      targetCareers: ['后台开发'],
      blacklist: new Set(),
      careerGateChecked: true,
    })
    expect(res.pass).toBe(true)
  })

  it('填写了岗位名称时，方向不符一律硬拦截（不再保留 soft 补足语义）', () => {
    const res = evaluateJobCandidate(job('Java开发工程师'), {
      filters: null,
      targetCareers: ['PHP开发'],
      blacklist: new Set(),
    })
    expect(res.pass).toBe(false)
    expect(res.reason).toContain('岗位名称硬闸门')
    expect(res.soft).not.toBe(true)
  })
})

describe('软件方向识别与领域闸门', () => {
  it('用户填的方向是软件开发，规则只对软件方向启用', () => {
    expect(hasSoftwareDirection(USER_DIRECTIONS)).toBe(true)
    expect(hasSoftwareDirection(['电子研发', '硬件工程师'])).toBe(false)
    expect(hasSoftwareDirection([])).toBe(false)
  })

  it('硬件求职者填「电子研发」时不被软件闸门越权否决', () => {
    expect(isJobTitleAllowed('电子研发工程师', ['电子研发']).allowed).toBe(true)
    expect(isJobTitleAllowed('硬件研发工程师', ['电子研发']).allowed).toBe(true)
    expect(isJobTitleAllowed('PHP开发工程师', ['电子研发']).allowed).toBe(false)
  })

  it('行业修饰词不误杀同方向岗位，但不对口的嵌入式软件岗仍然拦下', () => {
    expect(isJobTitleAllowed('医疗软件后端开发工程师', USER_DIRECTIONS).allowed).toBe(true)
    expect(isJobTitleAllowed('嵌入式软件工程师', USER_DIRECTIONS).allowed).toBe(false)
  })

  it('领域常量与软件开发语义常量各自边界清晰', () => {
    expect(NON_SOFTWARE_DOMAIN_RE.test('电子研发')).toBe(true)
    expect(NON_SOFTWARE_DOMAIN_RE.test('PHP开发工程师')).toBe(false)
    expect(SOFTWARE_DEV_ROLE_RE.test('PHP开发工程师')).toBe(true)
    expect(SOFTWARE_DEV_ROLE_RE.test('电子研发')).toBe(false)
  })
})

describe('闸门拦下的任务永不回收，避免无限认领', () => {
  const base = { status: 'skipped' as const, createdAt: 0, attempts: 0 }

  it('普通 skipped 过冷却期仍可回收', () => {
    expect(isRecyclableTask(base, 10 * 60_000, 60_000)).toBe(true)
  })

  it('带岗位名称硬闸门标记的任务即使过冷却期也不回收', () => {
    const blocked = { ...base, failReason: `${CAREER_GATE_BLOCK_MARK}（执行层拦截）：不属于填写的方向` }
    expect(isRecyclableTask(blocked, 10 * 60_000, 60_000)).toBe(false)
  })

  it('非 skipped 状态一律不回收', () => {
    expect(isRecyclableTask({ ...base, status: 'failed' }, 10 * 60_000, 60_000)).toBe(false)
  })
})

describe('运行模式不允许绕过岗位方向', () => {
  it('必达 / 海投的语义闸门绕过开关恒为 false', () => {
    expect(shouldBypassRelevanceGate(true)).toBe(false)
    expect(shouldBypassRelevanceGate(false)).toBe(false)
  })
})

describe('静态契约：防止旧逻辑回退', () => {
  it('采集层把硬闸门放在循环第一条，并彻底删掉方向软补足', () => {
    const src = read('src/content/index.ts')
    expect(src).toContain('isJobTitleAllowed(job.title, targetCareers)')
    expect(src).toContain('filteredByCareerGate')
    expect(src).toContain('careerGateChecked: careerGateActive')
    expect(src).not.toContain('const softMatchedJobs')
    expect(src).not.toContain('softMatchedJobs.push')
    expect(src).not.toContain('shouldBypassRelevanceGate(mustAchieve)')
  })

  it('语义闸门与模式解耦，只要有搜索词就生效', () => {
    const src = read('src/content/index.ts')
    expect(src).toContain('const strictRelevanceGate = !!searchKeyword')
    expect(src).toContain('const relevanceGate = aiRelevanceGate || strictRelevanceGate')
    expect(src).toContain('const targetCareers: string[] =')
    expect(src).not.toMatch(/relaxCareerFilter\s*\?\s*\[\]/)
    expect(src).not.toContain('!fastModeForRelevance && !relaxCareerFilter')
  })

  it('后台认领任务时复核岗位名称，拦截历史脏任务', () => {
    const src = read('src/background/campaign-service.ts')
    expect(src).toContain('readCareerGateDirections')
    expect(src).toContain('isJobTitleAllowed(task.jobTitle, gateCareers)')
    expect(src).toContain("status: 'skipped'")
    expect(src).toContain('CAREER_GATE_BLOCK_MARK')
    expect(src).not.toContain('本轮立即放宽方向限制重采一次')
  })

  it('执行层有最后一道闸，后台会把方向随任务下发', () => {
    const content = read('src/content/index.ts')
    expect(content).toContain('message.payload?.targetCareers')
    expect(content).toContain('loadSharedApplyFilters')
    expect(content).toContain('岗位名称硬闸门（执行层拦截）')
    // 半自动批量沟通也接了硬闸门
    expect(content).toContain('isJobTitleAllowed(job.title, gateDirections)')
    const service = read('src/background/campaign-service.ts')
    expect(service).toContain('targetCareers: gateCareers')
    expect(service).toContain('CAREER_GATE_BLOCK_MARK')
    expect(service).toContain('已生效（本页拦下')
  })

  it('闸门拦截任务在回收层被永久排除，且写进 failReason 标记', () => {
    expect(read('src/shared/agent/queue-store.ts')).toContain('CAREER_GATE_BLOCK_MARK')
    expect(read('src/content/index.ts')).toContain(`${CAREER_GATE_BLOCK_MARK}（执行层拦截）`)
  })

  it('设置页明确告知：岗位名称是硬闸门，海投 / 必达都不放宽', () => {
    const panel = read('src/popup/components/FilterPanel.tsx')
    expect(panel).toContain('它是硬闸门，海投 / 必达模式也不会放宽')
    expect(panel).toContain('产品经理、销售等不会进队列')
  })

  it('入队评估与本地语义判定都接上硬闸门', () => {
    expect(read('src/shared/agent/job-filter.ts')).toContain('isJobTitleAllowed(job.title, targetCareers)')
    expect(read('src/shared/ai/job-relevance.ts')).toContain("isJobTitleAllowed(job.title || '', dirs)")
    expect(read('src/shared/ai/job-relevance.ts')).toContain('return isCareerGateActive(dirs)')
    expect(read('src/shared/agent/must-achieve.ts')).toContain('岗位名称属于用户真实意愿')
  })
})
