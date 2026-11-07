/**
 * 回归「岗位名称写了 php 后台开发 / AI 全栈开发却没效果，还在投前端和 Java」。
 *
 * 根因链：
 *  1. splitKeywordTokens 不按空格切词 → 「php 后台开发」整串扔给平台，搜不到 → 降级推荐流；
 *  2. extractSearchKeywords 完全没读简历 skills / 项目技术栈 / 画像 → 简历里的 PHP、AI、全栈没变成搜索词；
 *  3. 一个词都没有时硬编码兜底「全栈工程师 / 前端开发工程师 / …」→ 真的去搜前端并投递；
 *  4. relaxCareerFilter 把 targetCareers 清空 → 方向白名单失效，前端 / Java 整页进队列；
 *  5. 本地语义判定「只统计不否决」+ 后端族谱把 Java 当同义 + 软过滤补足名额 → 精投也照投不误。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { extractSearchKeywords } from '../src/shared/agent/job-discovery'
import { DEFAULT_FILTERS, type ApplyFilters } from '../src/shared/types/filters'
import type { Resume } from '../src/shared/types/resume'
import { evaluateJobCandidate } from '../src/shared/agent/job-filter'
import {
  extractTargetStacks,
  isCrossStackJob,
  detectTechStacks,
  describeTargetStacks,
} from '../src/shared/agent/stack-guard'
import { computeLocalRelevance } from '../src/shared/ai/job-relevance'
import { getPlatformSearchUrl } from '../src/background/tab-manager'
import type { JobCard } from '../src/shared/types/job'

const ROOT = process.cwd()
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf-8')

const filters = (jobTitles: string): ApplyFilters => ({ ...DEFAULT_FILTERS, jobTitles })

function makeJob(title: string): JobCard {
  return {
    id: `j-${title}`,
    title,
    companyName: '测试公司',
    companyLogo: '',
    salary: '20-30K',
    location: '深圳',
    experience: '3-5年',
    education: '本科',
    tags: [],
    jobDescription: '',
    bossName: '',
    bossTitle: '',
    bossOnline: false,
    publishedAt: '',
    url: 'https://example.com/job',
  }
}

function makeResume(over: Partial<Resume['structuredData']> = {}): Resume {
  return {
    id: 'r1',
    name: '朱红全-PHP后端.pdf',
    fileName: 'resume.pdf',
    fileType: 'pdf',
    fileData: new ArrayBuffer(0),
    rawText: 'PHP 后端开发 5 年，Laravel / MySQL / Redis，AI 全栈项目经验',
    structuredData: {
      name: '朱红全',
      phone: '', email: '', city: '深圳', yearsOfExperience: 5,
      education: [], workExperience: [], projects: [], skills: [], summary: '',
      ...over,
    },
    aiAnalysis: null,
    isDefault: true,
    createdAt: '', updatedAt: '',
  } as Resume
}

describe('搜索关键词：用户填的方向与简历技能都要真的拿去搜', () => {
  it('「php 后台开发、AI 全栈开发」按空格与顿号拆成可搜短词', () => {
    const words = extractSearchKeywords(null, undefined, filters('php 后台开发、AI 全栈开发'))
    expect(words).toContain('php')
    expect(words).toContain('后台开发')
    expect(words).toContain('AI')
    expect(words).toContain('全栈开发')
  })

  it('不再返回与用户无关的硬编码前端兜底词', () => {
    const words = extractSearchKeywords(null, undefined, filters(''))
    expect(words).toEqual([])
    expect(words).not.toContain('前端开发工程师')
    expect(words).not.toContain('全栈工程师')
  })

  it('简历技能 / 项目技术栈 / 画像里的 PHP、AI、全栈都会变成搜索词', () => {
    const resume = makeResume({
      skills: ['PHP', 'Laravel', 'MySQL', 'AI 应用开发'],
      projects: [{ name: 'ERP', role: '后端', startDate: '', endDate: '', description: '', technologies: ['PHP', 'ThinkPHP'] }],
      summary: 'PHP开发工程师，做过 AI全栈开发 与 大模型应用',
    })
    const words = extractSearchKeywords(resume, undefined, DEFAULT_FILTERS)
    expect(words).toContain('PHP')
    expect(words).toContain('Laravel')
    expect(words).toContain('ThinkPHP')
    expect(words.some((w) => /全栈开发|AI开发|PHP开发/i.test(w))).toBe(true)
  })

  it('最近工作职位参与搜索，姓名与公司名不参与', () => {
    const resume = makeResume({
      workExperience: [{ company: '深圳竖云科技有限公司', position: 'PHP开发工程师', startDate: '', endDate: '', description: '' }],
    })
    const words = extractSearchKeywords(resume, undefined, DEFAULT_FILTERS)
    expect(words).toContain('PHP开发工程师')
    expect(words.join(' ')).not.toContain('竖云科技')
  })

  it('用户方向优先于简历技能，且最多 8 个词', () => {
    const words = extractSearchKeywords(makeResume({ skills: ['PHP', 'Laravel'] }), undefined, filters('php 后台开发'))
    expect(words[0]).toBe('php')
    expect(words.length).toBeLessThanOrEqual(8)
  })
})

describe('技术栈硬约束：PHP 方向不投 Java / 前端', () => {
  it('从「php 后台开发」推断出 PHP 栈', () => {
    expect(extractTargetStacks({ directions: ['php 后台开发'] })).toEqual(['php'])
    expect(describeTargetStacks(['php'])).toBe('PHP')
  })

  it('技能里的 Vue / MySQL 不会把前端算成求职方向', () => {
    expect(extractTargetStacks({
      directions: [''],
      skills: ['PHP', 'Laravel', 'Vue', 'MySQL', 'Redis'],
    })).toEqual(['php'])
  })

  it('方向没写栈、技能里两种语言并列时不强行锁定', () => {
    expect(extractTargetStacks({ directions: ['后端开发'], skills: ['PHP', 'Java'] })).toEqual([])
  })

  it('Java / 前端 / Go 岗位被否决；通用后端词与同栈岗位放行', () => {
    expect(isCrossStackJob('Java开发工程师', ['php'])).toBe(true)
    expect(isCrossStackJob('高级前端开发工程师', ['php'])).toBe(true)
    expect(isCrossStackJob('Golang后端工程师', ['php'])).toBe(true)
    expect(isCrossStackJob('后端开发工程师', ['php'])).toBe(false)
    expect(isCrossStackJob('PHP开发工程师', ['php'])).toBe(false)
    expect(isCrossStackJob('PHP/Java双栈开发', ['php'])).toBe(false)
  })

  it('目标栈为空或用户接受多栈时不启用否决', () => {
    expect(isCrossStackJob('Java开发工程师', [])).toBe(false)
    expect(isCrossStackJob('Java开发工程师', ['php', 'java'])).toBe(false)
  })

  it('detectTechStacks 不把 JavaScript 误判成 Java', () => {
    expect(detectTechStacks('JavaScript 工程师')).not.toContain('java')
    expect(detectTechStacks('Java 后端工程师')).toContain('java')
  })
})

describe('过滤链路：跨栈岗位是硬否决，不能靠软补足回到队列', () => {
  it('evaluateJobCandidate 对 Java 岗位返回 pass=false 且不带 soft', () => {
    const res = evaluateJobCandidate(makeJob('Java开发工程师'), { targetStacks: ['php'] })
    expect(res.pass).toBe(false)
    expect(res.reason).toContain('技术栈不符')
    expect(res.soft).not.toBe(true)
  })

  it('PHP 与通用后端岗位正常通过', () => {
    expect(evaluateJobCandidate(makeJob('PHP后台开发工程师'), { targetStacks: ['php'] }).pass).toBe(true)
    expect(evaluateJobCandidate(makeJob('后端开发工程师'), { targetStacks: ['php'] }).pass).toBe(true)
  })

  it('computeLocalRelevance 先执行跨栈否决，再谈后端同义族谱', () => {
    const input = {
      keyword: 'php',
      targetCareers: ['php', '后台开发'],
      targetStacks: ['php'] as const,
      jobs: [],
    }
    const rel = (title: string) => computeLocalRelevance(
      { id: title, title },
      { ...input, targetStacks: [...input.targetStacks] },
    )
    expect(rel('Java后台开发工程师')).toBe(false)
    expect(rel('前端开发工程师')).toBe(false)
    expect(rel('PHP开发工程师')).toBe(true)
    expect(rel('后端开发工程师')).toBe(true)
  })
})

describe('搜索 URL：每个平台都要真的带上关键词', () => {
  it('Boss / 猎聘 / 智联 / 51job / 脉脉 都把 query 写进 URL', () => {
    for (const platform of ['boss', 'liepin', 'zhaopin', '51job', 'maimai'] as const) {
      const url = getPlatformSearchUrl(platform, 'PHP')
      expect(url, platform).toContain('PHP')
      expect(url, platform).not.toBe('https://maimai.cn/jobs')
    }
  })
})

describe('静态契约：防止旧逻辑回退', () => {
  it('关键词模块已删除硬编码通用兜底，并接入简历技能来源', () => {
    const src = read('src/shared/agent/job-discovery.ts')
    expect(src).not.toContain("'前端开发工程师'")
    expect(src).toContain('collectResumeSkillKeywords')
    expect(src).toContain("reason: allKeywords.length === 0 ? 'no_keywords' : 'all_invalid'")
  })

  it('采集链路不再因放宽模式清空方向，且本地语义成为精投硬闸门', () => {
    const src = read('src/content/index.ts')
    expect(src).not.toMatch(/relaxCareerFilter === true[\s\S]{0,40}\? \[\]/)
    expect(src).toContain('strictRelevanceGate')
    expect(src).toContain('targetStacks,')
    expect(src).toContain('filteredByStack')
  })

  it('AI 语义复核 prompt 不再把「Java 后台」当作后端同义例子', () => {
    const src = read('src/shared/ai/job-relevance.ts')
    expect(src).not.toContain('Java 后台')
    expect(src).toContain('目标技术栈')
    expect(src).toContain('isCrossStackJob')
  })

  it('后台对「没有可用搜索词」不再暂停，而是提示用户填期望职位', () => {
    const src = read('src/background/campaign-service.ts')
    expect(src).toContain("keywordInfo.reason === 'no_keywords'")
    expect(src).toContain('需要填写期望职位')
  })
})
