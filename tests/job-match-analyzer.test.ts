import { describe, expect, it, vi, beforeEach } from 'vitest'
import { analyzeJobMatch } from '../src/shared/ai/job-match-analyzer'

vi.mock('../src/shared/ai/api-client', () => ({
  chatCompletionStream: vi.fn(),
}))

import { chatCompletionStream } from '../src/shared/ai/api-client'
const mockStream = chatCompletionStream as unknown as ReturnType<typeof vi.fn>

const RESUME_TEXT = '三年前端开发经验，熟练使用 React、TypeScript。'
const JD_TEXT = '高级前端工程师，要求 React、TypeScript，3年以上经验，本科及以上'

describe('analyzeJobMatch (A4)', () => {
  beforeEach(() => {
    mockStream.mockReset()
  })

  it('parses dimensions, gapActions and resumeTailoringPoints from fenced JSON', async () => {
    const aiOutput = `分析过程省略...

\`\`\`json
{
  "overallScore": 72,
  "skillMatch": ["React", "TypeScript"],
  "skillGap": ["性能优化"],
  "strengths": ["React 经验扎实"],
  "weaknesses": ["缺少性能优化实践"],
  "improvementSuggestions": ["花2周学习性能优化并做demo"],
  "recommendation": "基本匹配，建议补充性能优化经历",
  "dimensions": {"skills": 40, "similarity": 8, "direction": 12, "experience": 8, "education": 4},
  "gapActions": [{"gap": "缺少性能优化实践", "action": "简历补充：在项目中加入性能优化细节", "type": "rewrite"}],
  "resumeTailoringPoints": ["把'负责订单系统'改为'重构订单中台，支撑双11峰值，QPS提升40%'"]
}
\`\`\``
    mockStream.mockResolvedValue(aiOutput)

    let chunks = ''
    const result = await analyzeJobMatch(RESUME_TEXT, ['React', 'TypeScript'], JD_TEXT, (c) => { chunks += c })
    expect(mockStream).toHaveBeenCalledTimes(1)
    expect(chunks.length).toBeGreaterThanOrEqual(0)
    expect(result.overallScore).toBe(72)
    expect(result.dimensions).toEqual({ skills: 40, similarity: 8, direction: 12, experience: 8, education: 4 })
    expect(result.gapActions).toHaveLength(1)
    expect(result.gapActions![0].type).toBe('rewrite')
    expect(result.resumeTailoringPoints![0]).toContain('订单中台')
  })

  it('clamps out-of-range dimension values', async () => {
    mockStream.mockResolvedValue(JSON.stringify({
      overallScore: 60,
      dimensions: { skills: 999, similarity: -5, direction: 20, experience: 12, education: 8 },
    }))
    const result = await analyzeJobMatch(RESUME_TEXT, [], JD_TEXT, () => {})
    expect(result.dimensions!.skills).toBe(45)
    expect(result.dimensions!.similarity).toBe(0)
  })

  it('parses bare JSON without a code fence', async () => {
    mockStream.mockResolvedValue('{"overallScore":80,"gapActions":[{"gap":"x","action":"y","type":"learn"}]}')
    const result = await analyzeJobMatch(RESUME_TEXT, [], JD_TEXT, () => {})
    expect(result.overallScore).toBe(80)
    expect(result.gapActions![0].action).toBe('y')
  })

  it('falls back to a default structure when no JSON is present', async () => {
    mockStream.mockResolvedValue('抱歉，无法分析')
    const result = await analyzeJobMatch(RESUME_TEXT, [], JD_TEXT, () => {})
    expect(result.overallScore).toBe(0)
    expect(result.strengths[0]).toContain('格式异常')
  })
})
