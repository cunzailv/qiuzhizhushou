import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  classifyHrIntent,
  extractRelevantResumeFacts,
  generateHrReplyCopilot,
} from '../src/shared/ai/hr-copilot'
import {
  DEFAULT_CANDIDATE_PREFERENCES,
  type CandidateProfilePreferences,
} from '../src/shared/types/candidate-profile'
import {
  getCandidatePreferences,
  saveCandidatePreferences,
} from '../src/shared/db/settings-store'
import type { Resume } from '../src/shared/types/resume'

// Mock chrome storage
const storageMap: Record<string, any> = {}
;(globalThis as any).chrome = {
  storage: {
    local: {
      get: vi.fn(async (keys: any, cb?: (res: any) => void) => {
        let res: Record<string, any> = {}
        if (typeof keys === 'string') {
          res = { [keys]: storageMap[keys] }
        } else if (Array.isArray(keys)) {
          keys.forEach((k) => (res[k] = storageMap[k]))
        } else if (typeof keys === 'object' && keys !== null) {
          Object.keys(keys).forEach((k) => (res[k] = storageMap[k] !== undefined ? storageMap[k] : keys[k]))
        } else {
          res = { ...storageMap }
        }
        if (cb) cb(res)
        return res
      }),
      set: vi.fn(async (items: any, cb?: () => void) => {
        Object.assign(storageMap, items)
        if (cb) cb()
      }),
      remove: vi.fn(async (keys: any, cb?: () => void) => {
        const arr = Array.isArray(keys) ? keys : [keys]
        arr.forEach((k) => delete storageMap[k])
        if (cb) cb()
      }),
      clear: vi.fn(async (cb?: () => void) => {
        Object.keys(storageMap).forEach((k) => delete storageMap[k])
        if (cb) cb()
      }),
    },
  },
  runtime: {
    lastError: null,
  },
}

describe('HR 经典追问库智能应答 Copilot 核心引擎', () => {
  beforeEach(() => {
    Object.keys(storageMap).forEach((k) => delete storageMap[k])
  })

  const mockResume: Resume = {
    id: 'res_001',
    name: '全栈架构师简历',
    skills: ['React', 'Next.js', 'Node.js', 'AI Agent', 'Python', 'MySQL'],
    updatedAt: new Date().toISOString(),
    profile: {
      profile: '6年全栈研发经验，专注大模型智能体与高可用架构。',
    },
    structuredData: {
      projects: [
        {
          name: 'B端 AI 智能体工作台',
          role: '全栈架构师',
          technologies: ['React', 'Next.js', 'Python', 'FastAPI', 'Agent'],
          description: '负责平台全栈架构与AI视频生成、智能体编排落地，支撑万人并发调用。',
        },
        {
          name: '高可用微服务数据中台',
          role: '后端负责人',
          technologies: ['Golang', 'Redis', 'Kafka', 'MySQL'],
          description: '重构元数据调度管道，吞吐量提升 300%，支撑跨市场日千万级数据交换。',
        },
      ],
      workExperience: [
        {
          company: '前沿科技',
          position: '高级全栈工程师',
          description: '主导智能体应用研发及工程化全链路闭环交付。',
        },
      ],
      summary: '精通全栈工程化及大模型智能体平台架构，落地多个百万级商业化生产项目。',
    },
  }

  const customPreferences: CandidateProfilePreferences = {
    ...DEFAULT_CANDIDATE_PREFERENCES,
    employmentStatus: 'resigned_immediately',
    availableDays: '最快1周到岗',
    expectedSalaryMin: 18,
    expectedSalaryMax: 25,
    bottomLines: ['no_outsourcing', 'no_single_rest', 'need_social_security'],
    contactInfo: '13800000000 (微信同号)',
  }

  describe('1. HR 意图分类与冲突识别 (classifyHrIntent)', () => {
    it('准确识别到岗时间与在职状态提问', () => {
      expect(classifyHrIntent('您好，目前是在职还是离职状态？')).toBe('status_and_onboard')
      expect(classifyHrIntent('最快什么时候能到岗入职呢？')).toBe('status_and_onboard')
      expect(classifyHrIntent('离职手续办完了吗，多久能到岗？')).toBe('status_and_onboard')
    })

    it('准确识别薪酬待遇追问', () => {
      expect(classifyHrIntent('方便透露一下您的期望薪资是多少吗？')).toBe('salary_inquiry')
      expect(classifyHrIntent('目前薪资多少，期望待遇多少K？')).toBe('salary_inquiry')
    })

    it('准确识别底线冲突提问（单休、外包、996等）', () => {
      expect(classifyHrIntent('我们是外包驻场项目，能接受吗？')).toBe('bottom_line_check')
      expect(classifyHrIntent('公司目前是单休，偶尔需要加班')).toBe('bottom_line_check')
      expect(classifyHrIntent('大小周工作制可以接受吗？')).toBe('bottom_line_check')
    })

    it('准确识别技术架构与项目经验追问', () => {
      expect(classifyHrIntent('您做过大模型智能体和视频生成相关架构吗？')).toBe('architecture_and_tech')
      expect(classifyHrIntent('有做过微服务高并发和Redis优化吗？')).toBe('architecture_and_tech')
    })

    it('准确识别面试邀请与约聊', () => {
      expect(classifyHrIntent('明天下午有空吗，方便约个腾讯会议线上聊聊吗？')).toBe('interview_invitation')
      expect(classifyHrIntent('方便留个电话或者微信详聊吗？')).toBe('interview_invitation')
    })
  })

  describe('2. 真实简历事实检索 (extractRelevantResumeFacts)', () => {
    it('根据提问中的技术词精准提取简历中的真实项目事实', () => {
      const facts = extractRelevantResumeFacts(mockResume, '做过智能体和AI视频生成架构吗？')
      expect(facts.length).toBeGreaterThan(0)
      expect(facts[0]).toContain('B端 AI 智能体工作台')
      expect(facts[0]).toContain('全栈架构师')
    })

    it('微服务/高并发关键词提取对应后端中台事实', () => {
      const facts = extractRelevantResumeFacts(mockResume, '是否有做过高并发微服务和Redis优化？')
      expect(facts.length).toBeGreaterThan(0)
      expect(facts[0]).toContain('高可用微服务数据中台')
      expect(facts[0]).toContain('Golang')
    })

    it('无特定技术词命中时兜底提取简历亮点与画像', () => {
      const facts = extractRelevantResumeFacts(mockResume, '能具体聊聊您的个人优势吗？')
      expect(facts.length).toBeGreaterThan(0)
      expect(facts[0]).toContain('全栈')
    })
  })

  describe('3. 高情商智能应答生成 (generateHrReplyCopilot)', () => {
    it('底线拦截：HR 提及外包时触发底线告警并委婉谢绝', async () => {
      const res = await generateHrReplyCopilot({
        hrMessage: '该岗位是人力外包派遣性质，可以接受吗？',
        companyName: '某外包技术服务商',
        jobTitle: '全栈外包',
        resume: mockResume,
        preferences: customPreferences,
      })

      expect(res.intent).toBe('bottom_line_check')
      expect(res.bottomLineAlert).toContain('不接受外包')
      expect(res.replyText).toContain('自研业务及双休规范')
      expect(res.replyText).toContain('祝团队招聘顺利')
    })

    it('求职状态与到岗周期：带入离职状态与最快1周到岗画像', async () => {
      const res = await generateHrReplyCopilot({
        hrMessage: '目前在职吗？最快什么时候可以到岗？',
        companyName: '创新科技',
        jobTitle: '全栈工程师',
        resume: mockResume,
        preferences: customPreferences,
      })

      expect(res.intent).toBe('status_and_onboard')
      expect(res.replyText).toContain('目前已离职')
      expect(res.replyText).toContain('最快【最快1周到岗】即可到岗入职')
      expect(res.matchedFact).toContain('最快1周到岗')
    })

    it('期望薪资：带入 18-25K 期望区间并留有弹性定薪话术', async () => {
      const res = await generateHrReplyCopilot({
        hrMessage: '方便问下您的期望薪资要求是多少吗？',
        companyName: '创新科技',
        jobTitle: '全栈工程师',
        resume: mockResume,
        preferences: customPreferences,
      })

      expect(res.intent).toBe('salary_inquiry')
      expect(res.replyText).toContain('18-25K')
      expect(res.replyText).toContain('弹性沟通')
      expect(res.matchedFact).toContain('18-25K')
    })

    it('面试邀约：自动附带预留的电话/微信号码', async () => {
      const res = await generateHrReplyCopilot({
        hrMessage: '您的经历很符合，明天下午方便电话或者线上沟通吗？',
        companyName: '创新科技',
        jobTitle: '全栈工程师',
        resume: mockResume,
        preferences: customPreferences,
      })

      expect(res.intent).toBe('interview_invitation')
      expect(res.replyText).toContain('13800000000 (微信同号)')
      expect(res.replyText).toContain('创新科技')
    })

    it('架构与技术深挖：严密引用简历真实项目事实论证，杜绝虚构', async () => {
      const res = await generateHrReplyCopilot({
        hrMessage: '做过大模型智能体和Agent编排落地吗？',
        companyName: '智谱伙伴',
        jobTitle: 'AI智能体开发',
        resume: mockResume,
        preferences: customPreferences,
      })

      expect(res.intent).toBe('architecture_and_tech')
      expect(res.matchedFact).toContain('B端 AI 智能体工作台')
      expect(res.replyText).toContain('B端 AI 智能体工作台')
      expect(res.replyText).toContain('很契合贵司 AI智能体开发 的方向')
    })
  })

  describe('4. 画像与底线持久化存储 (SettingsStore)', () => {
    it('正确保存和读取预设画像底线配置', async () => {
      const initial = await getCandidatePreferences()
      expect(initial.employmentStatus).toBe('unemployed_immediate')

      await saveCandidatePreferences({
        employmentStatus: 'employed_month',
        availableDays: '最快2周到岗',
        expectedSalaryMin: 22,
        expectedSalaryMax: 30,
        bottomLines: ['no_outsourcing', 'no_996'],
        customBottomLines: '不接受降薪试用',
        contactInfo: '13911112222',
        copilotMode: 'suggest_first',
      })

      const loaded = await getCandidatePreferences()
      expect(loaded.employmentStatus).toBe('employed_month')
      expect(loaded.availableDays).toBe('最快2周到岗')
      expect(loaded.expectedSalaryMin).toBe(22)
      expect(loaded.expectedSalaryMax).toBe(30)
      expect(loaded.bottomLines).toEqual(['no_outsourcing', 'no_996'])
      expect(loaded.customBottomLines).toBe('不接受降薪试用')
      expect(loaded.contactInfo).toBe('13911112222')
    })
  })
})
