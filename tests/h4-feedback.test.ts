// H4 · 反馈自进化：负面投递结果回流 → 提升方向沉淀（去重）
import { describe, it, expect, beforeAll } from 'vitest'
import 'fake-indexeddb/auto'
import { db } from '../src/shared/db/index'
import { getCareerProfile, addImprovementDirection } from '../src/shared/db/career-store'
import { extractFeedbackInsight, evolveFromApplication } from '../src/shared/db/feedback-store'

beforeAll(async () => {
  await db.open()
  await db.careerProfiles.clear()
})

const sampleApp = {
  id: 'app-1',
  jobTitle: '前端工程师',
  companyName: '某科技公司',
  matchReason: '岗位要求 React 与性能优化经验，简历项目偏业务开发',
  notes: '后续需补充性能优化案例',
}

describe('H4 反馈自进化', () => {
  it('extractFeedbackInsight 合并匹配理由与备注', () => {
    const insight = extractFeedbackInsight(sampleApp)
    expect(insight).toContain('前端工程师')
    expect(insight).toContain('性能优化')
  })

  it('无反馈信息时返回 null', () => {
    expect(extractFeedbackInsight({ ...sampleApp, matchReason: '', notes: '' })).toBeNull()
  })

  it('rejected 状态沉淀一条提升方向', async () => {
    await addImprovementDirection({ skill: '占位', reason: '占位', suggestedAction: '占位' })
    const changed = await evolveFromApplication(sampleApp, 'rejected')
    expect(changed).toBe(true)
    const profile = await getCareerProfile()
    const directions = profile.improvementDirections
    expect(directions.some((d) => d.reason.startsWith('来自投递反馈：'))).toBe(true)
  })

  it('重复反馈去重（同一条不重复沉淀）', async () => {
    const changed = await evolveFromApplication(sampleApp, 'rejected')
    expect(changed).toBe(false)
    const profile = await getCareerProfile()
    const feedbackCount = profile.improvementDirections.filter((d) => d.reason.startsWith('来自投递反馈：')).length
    expect(feedbackCount).toBe(1)
  })

  it('正面状态（interview/hired）不沉淀', async () => {
    const changed = await evolveFromApplication(sampleApp, 'interview')
    expect(changed).toBe(false)
  })
})
