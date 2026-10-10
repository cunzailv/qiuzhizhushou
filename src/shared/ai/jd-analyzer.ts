import { ALL_SKILLS } from '../parser/skills-dict'
import { chatCompletion } from './api-client'
import { getSetting } from '../db/settings-store'
import type { JobCard, JdRequirements, JdSkill } from '../types/job'

// ─── 本地解析工具（可单测） ───

/**
 * 解析薪资范围（元/月）。
 * 支持：20K-30K / 15-25K / 20-40万 / 1.5-2万
 * 约定：单位 K 为月薪；单位 万 且下限 ≥10 视为年薪（÷12 折算月薪），否则视为月薪；面议返回 null。
 */
export function parseSalaryRange(text: string): { min: number; max: number } | null {
  if (!text || /面议|面谈|协商|薪资开放/.test(text)) return null
  const kRange = text.match(/(\d+(?:\.\d+)?)\s*[kK]\s*[-~至到]\s*(\d+(?:\.\d+)?)\s*[kK]/)
  if (kRange) {
    return { min: Math.round(Number(kRange[1]) * 1000), max: Math.round(Number(kRange[2]) * 1000) }
  }
  const bareK = text.match(/(\d+(?:\.\d+)?)\s*[-~至到]\s*(\d+(?:\.\d+)?)\s*[kK]/)
  if (bareK) {
    return { min: Math.round(Number(bareK[1]) * 1000), max: Math.round(Number(bareK[2]) * 1000) }
  }
  const wanRange = text.match(/(\d+(?:\.\d+)?)\s*[-~至到]\s*(\d+(?:\.\d+)?)\s*万/)
  if (wanRange) {
    const min = Number(wanRange[1])
    const max = Number(wanRange[2])
    if (min >= 10) {
      // 年薪口径：折算为月薪
      return { min: Math.round((min * 10000) / 12), max: Math.round((max * 10000) / 12) }
    }
    return { min: Math.round(min * 10000), max: Math.round(max * 10000) }
  }
  return null
}

/** 解析年限下限：3-5年→3；5年以上/及以上→5；经验不限/无经验→0；解析不到→0 */
export function parseExperienceYears(text: string): number {
  if (!text || /经验不限|不限经验|无经验|应届/.test(text)) return 0
  const range = text.match(/(\d+)\s*[-~至到]\s*\d+\s*年/)
  if (range) return Number(range[1])
  const floor = text.match(/(\d+)\s*年(?:以上|及以上|以下|及以下)/)
  if (floor) return Number(floor[1])
  const single = text.match(/(\d+)\s*年/)
  return single ? Number(single[1]) : 0
}

/** 解析学历下限：硕士及以上→硕士；本科及以上/统招本科→本科；大专→大专；学历不限→不限；解析不到→'' */
export function parseEducationRequirement(text: string): string {
  if (!text) return ''
  if (/博士/.test(text)) return '博士'
  if (/硕士/.test(text)) return '硕士'
  if (/本科/.test(text)) return '本科'
  if (/大专|专科/.test(text)) return '大专'
  if (/学历不限|不限学历/.test(text)) return '不限'
  return ''
}

// ─── 段落切分 ───

const HEADER_DEFS: Array<{ key: 'responsibilities' | 'hardRequirements' | 'niceToHave'; pattern: RegExp }> = [
  { key: 'responsibilities', pattern: /岗位职责|工作职责|职位描述|工作内容|职责描述|岗位描述/i },
  { key: 'hardRequirements', pattern: /任职要求|任职资格|岗位要求|职位要求|任职条件/i },
  { key: 'niceToHave', pattern: /加分项|优先条件|优先考虑|加分条件|优先录取/i },
]

/** 按标题切分 JD：每个段落从标题结尾截取到下一个标题（或文末），支持"标题：内容"同行写法 */
function splitIntoSections(text: string): Map<string, string> {
  const headers: Array<{ key: 'responsibilities' | 'hardRequirements' | 'niceToHave'; start: number; end: number }> = []
  for (const { key, pattern } of HEADER_DEFS) {
    const m = pattern.exec(text)
    if (m) headers.push({ key, start: m.index, end: m.index + m[0].length })
  }

  const sections = new Map<string, string>()
  for (const h of headers) {
    const next = headers.filter((o) => o.start > h.start).sort((a, b) => a.start - b.start)[0]
    const end = next ? next.start : text.length
    const body = text.slice(h.end, end).replace(/^[\s:：]*\n?[\s:：]*/, '').trim()
    sections.set(h.key, body)
  }
  return sections
}

function toLines(body: string, max = 12): string[] {
  return body
    .split(/\n+/)
    .map((line) => line.replace(/^[\s●·•\-—–\d.、]+/, '').trim())
    .filter((line) => line.length >= 4)
    .slice(0, max)
}

function containsText(text: string, keyword: string): boolean {
  const normalizedText = text.toLowerCase()
  const normalizedKeyword = keyword.toLowerCase().trim()
  if (!normalizedKeyword) return false
  if (/[\u3400-\u9fff]/.test(normalizedKeyword)) return normalizedText.includes(normalizedKeyword)
  const escaped = normalizedKeyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|[^a-z0-9])${escaped}(?=$|[^a-z0-9])`, 'i').test(normalizedText)
}

/** 从 JD 提取技能并区分必须/加分：任职要求段或职责段出现→必须；加分项段→加分；其余→加分（保守） */
function extractJdSkills(text: string, sections: Map<string, string>): JdSkill[] {
  const hardSection = sections.get('hardRequirements') || ''
  const respSection = sections.get('responsibilities') || ''
  const niceSection = sections.get('niceToHave') || ''
  const skills: JdSkill[] = []
  for (const skill of ALL_SKILLS) {
    if (!containsText(text, skill)) continue
    let required = false
    if (containsText(hardSection, skill) || containsText(respSection, skill)) required = true
    else if (containsText(niceSection, skill)) required = false
    skills.push({ skill, required })
  }
  return skills
}

export function analyzeJdLocally(job: JobCard): Omit<JdRequirements, 'source' | 'parsedAt'> {
  const text = [job.title, ...job.tags, job.jobDescription].filter(Boolean).join('\n')
  const sections = splitIntoSections(text)
  const salary = parseSalaryRange([job.salary, job.jobDescription].filter(Boolean).join(' '))
  return {
    responsibilities: toLines(sections.get('responsibilities') || ''),
    hardRequirements: toLines(sections.get('hardRequirements') || ''),
    niceToHave: toLines(sections.get('niceToHave') || ''),
    education: parseEducationRequirement([job.education, job.jobDescription].filter(Boolean).join(' ')),
    experienceYears: parseExperienceYears([job.experience, job.jobDescription].filter(Boolean).join(' ')),
    salaryMin: salary?.min ?? null,
    salaryMax: salary?.max ?? null,
    skills: extractJdSkills(text, sections),
  }
}

// ─── AI 补全 ───

const SYSTEM_PROMPT = `你是资深HR与职位分析Agent。分析岗位JD，输出结构化要求。

推理要求：
1. responsibilities：岗位职责，逐条列出（3-8条）
2. hardRequirements：硬性要求（学历/年限/证书/必备技能等任职资格，3-10条）
3. niceToHave：加分项（优先条件）；没有则空数组
4. education：学历下限（不限/大专/本科/硕士/博士）
5. experienceYears：年限下限（数字，经验不限填0）
6. skills：从JD提取技能，required=true表示必须（must-have），false表示加分（nice-to-have）

只输出JSON（不要markdown包裹）：
{"responsibilities":["..."],"hardRequirements":["..."],"niceToHave":["..."],"education":"本科","experienceYears":3,"skills":[{"skill":"Go","required":true}]}`

function mergeSkills(local: JdSkill[], ai: JdSkill[]): JdSkill[] {
  const merged = new Map<string, JdSkill>()
  for (const s of local) merged.set(s.skill.toLowerCase(), s)
  for (const s of ai) {
    const key = s.skill.toLowerCase()
    const existing = merged.get(key)
    // AI 判定为必须时覆盖本地判定
    if (!existing || s.required) merged.set(key, s)
  }
  return Array.from(merged.values())
}

async function tryAIAnalyze(job: JobCard): Promise<Omit<JdRequirements, 'source' | 'parsedAt' | 'salaryMin' | 'salaryMax'> | null> {
  const userMessage = `【岗位信息】
标题: ${job.title}
公司: ${job.companyName || ''}
薪资: ${job.salary || ''}
地点: ${job.location || ''}
经验: ${job.experience || ''}
学历: ${job.education || ''}
标签: ${job.tags.join('、')}

【JD全文】
${job.jobDescription || ''}

请按 Agent 思维流程输出结构化 JD JSON。`

  const result = await chatCompletion(SYSTEM_PROMPT, userMessage, 0.2)
  if (!result) return null
  try {
    const jsonStr = result.match(/\{[\s\S]*\}/)?.[0]
    if (!jsonStr) return null
    const parsed = JSON.parse(jsonStr)
    const skills: JdSkill[] = Array.isArray(parsed.skills)
      ? parsed.skills
          .filter((s: { skill?: unknown }) => typeof s?.skill === 'string')
          .map((s: { skill: string; required?: unknown }) => ({ skill: s.skill.trim(), required: s.required === true }))
      : []
    return {
      responsibilities: Array.isArray(parsed.responsibilities) ? parsed.responsibilities.filter((x: unknown) => typeof x === 'string').slice(0, 12) : [],
      hardRequirements: Array.isArray(parsed.hardRequirements) ? parsed.hardRequirements.filter((x: unknown) => typeof x === 'string').slice(0, 12) : [],
      niceToHave: Array.isArray(parsed.niceToHave) ? parsed.niceToHave.filter((x: unknown) => typeof x === 'string').slice(0, 12) : [],
      education: typeof parsed.education === 'string' ? parsed.education : '',
      experienceYears: typeof parsed.experienceYears === 'number' ? Math.max(0, parsed.experienceYears) : 0,
      skills,
    }
  } catch {
    console.error('Failed to parse AI JD analysis')
    return null
  }
}

/**
 * A2: AI JD 理解。
 * 策略：本地结构化（薪资/年限/学历/技能分级/段落切分）→ AI 补全语义层（职责/硬性/加分/技能必须性）。
 */
export async function analyzeJd(job: JobCard): Promise<JdRequirements> {
  const local = analyzeJdLocally(job)
  const parsedAt = new Date().toISOString()

  // 尊重用户开关：AI 未启用时纯本地结构化（不产生任何 AI 调用）
  const aiEnabled = await getSetting<boolean>('aiEnabled', false)
  const ai = aiEnabled ? await tryAIAnalyze(job) : null
  if (!ai) return { ...local, source: 'local', parsedAt }

  return {
    responsibilities: ai.responsibilities.length ? ai.responsibilities : local.responsibilities,
    hardRequirements: ai.hardRequirements.length ? ai.hardRequirements : local.hardRequirements,
    niceToHave: ai.niceToHave.length ? ai.niceToHave : local.niceToHave,
    education: ai.education || local.education,
    experienceYears: ai.experienceYears > 0 ? ai.experienceYears : local.experienceYears,
    salaryMin: local.salaryMin,
    salaryMax: local.salaryMax,
    skills: ai.skills.length ? mergeSkills(local.skills, ai.skills) : local.skills,
    source: 'hybrid',
    parsedAt,
  }
}
