// L3 经验记忆：样本门槛 / 证据 / 用户驳回 / 过期 / 结构化检索
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach } from 'vitest'
import { db } from '../src/shared/db'
import {
  recordExperience,
  listExperiences,
  getRelevantExperiences,
  setExperienceEnabled,
  purgeExpiredExperiences,
  deleteExperience,
  type ExperienceInput,
} from '../src/shared/db/experience-store'
import { MIN_EXPERIENCE_SAMPLE } from '../src/shared/types/experience'

function input(over: Partial<ExperienceInput> = {}): ExperienceInput {
  return {
    pattern: '岗位名含 PHP后端',
    verdict: 'avoid',
    sampleSize: 8,
    replyRate: 0,
    evidenceIds: ['a1', 'a2'],
    reason: '近 7 天该方向 8 投零回复',
    source: 'review',
    ...over,
  }
}

beforeEach(async () => {
  await db.experiences.clear()
})

describe('经验记忆 · 样本门槛与证据', () => {
  it(`样本不足 ${MIN_EXPERIENCE_SAMPLE} 条不许写成结论`, async () => {
    const result = await recordExperience(input({ sampleSize: MIN_EXPERIENCE_SAMPLE - 1 }))
    expect(result).toBeNull()
    expect(await listExperiences()).toHaveLength(0)
  })

  it('正常写入并保留证据与有效期', async () => {
    const exp = await recordExperience(input())
    expect(exp).not.toBeNull()
    expect(exp?.evidenceIds).toEqual(['a1', 'a2'])
    expect(new Date(exp!.expiresAt).getTime()).toBeGreaterThan(Date.now())
    expect(await listExperiences()).toHaveLength(1)
  })

  it('同一特征重复归纳只更新，不产生重复条目', async () => {
    const first = await recordExperience(input())
    const second = await recordExperience(input({ sampleSize: 12, replyRate: 8 }))
    expect(second?.id).toBe(first?.id)
    const all = await listExperiences()
    expect(all).toHaveLength(1)
    expect(all[0].sampleSize).toBe(12)
  })
})

describe('经验记忆 · 用户驳回与过期', () => {
  it('用户手工驳回后不再出现在规划中，且 AI 归纳不得覆盖', async () => {
    const exp = await recordExperience(input())
    expect(await setExperienceEnabled(exp!.id, false)).toBe(true)
    expect(await listExperiences()).toHaveLength(0)
    expect(await listExperiences(true)).toHaveLength(1)
    expect(await recordExperience(input({ sampleSize: 20 }))).toBeNull()
    expect((await listExperiences(true))[0].sampleSize).toBe(8)
  })

  it('过期经验不参与规划，可被清理', async () => {
    const exp = await recordExperience(input())
    await db.experiences.update(exp!.id, {
      expiresAt: new Date(Date.now() - 86_400_000).toISOString(),
    })
    expect(await listExperiences()).toHaveLength(0)
    expect(await purgeExpiredExperiences()).toBe(1)
    expect(await listExperiences(true)).toHaveLength(0)
  })

  it('按特征关键词检索相关经验', async () => {
    await recordExperience(input())
    await recordExperience(input({ pattern: 'JD 含 外包驻场', reason: '命中底线' }))
    const relevant = await getRelevantExperiences('当前岗位：PHP后端 工程师')
    expect(relevant).toHaveLength(1)
    expect(relevant[0].pattern).toContain('PHP后端')
  })

  it('可彻底删除一条经验', async () => {
    const exp = await recordExperience(input())
    await deleteExperience(exp!.id)
    expect(await listExperiences()).toHaveLength(0)
  })
})
