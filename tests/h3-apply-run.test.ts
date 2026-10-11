// H3 · 投递流程持久化：状态机保存/恢复/清理
import { describe, it, expect, beforeAll } from 'vitest'
import 'fake-indexeddb/auto'
import { db } from '../src/shared/db/index'
import {
  saveApplyRun,
  loadPendingApplyRun,
  listPendingApplyRuns,
  clearApplyRun,
} from '../src/shared/agent/apply-state-machine'

beforeAll(async () => {
  await db.open()
  await db.applyRuns.clear()
})

describe('H3 投递流程持久化', () => {
  it('非终态流程可保存并恢复', async () => {
    await saveApplyRun('job-a', 'matched', { jobTitle: '前端工程师', platform: 'boss' })
    const run = await loadPendingApplyRun('job-a')
    expect(run).toBeDefined()
    expect(run!.state).toBe('matched')
    expect(run!.context?.jobTitle).toBe('前端工程师')
  })

  it('终态记录读取时自动清理（不返回）', async () => {
    await saveApplyRun('job-b', 'applied')
    const run = await loadPendingApplyRun('job-b')
    expect(run).toBeUndefined()
    expect(await db.applyRuns.get('job-b')).toBeUndefined()
  })

  it('listPendingApplyRuns 只返回非终态', async () => {
    await saveApplyRun('job-c', 'scanning')
    await saveApplyRun('job-d', 'failed')
    const pending = await listPendingApplyRuns()
    const ids = pending.map((r) => r.jobId)
    expect(ids).toContain('job-c')
    expect(ids).not.toContain('job-d')
  })

  it('clearApplyRun 删除记录', async () => {
    await saveApplyRun('job-e', 'followup')
    await clearApplyRun('job-e')
    expect(await db.applyRuns.get('job-e')).toBeUndefined()
  })
})
