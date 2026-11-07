/**
 * 技术栈方向约束：让「PHP 后端」不会再投到「Java 开发 / 前端开发」。
 *
 * 历史 bug：`isJobMatchingCareer` 的后端族谱把「Java 后台」也当后端同义，
 * `computeLocalRelevance` 的 BACKEND_STACK_RE 里也含 java / spring，
 * 于是搜「php 后台开发」时 Java 岗位被判成「真正对口」并进了投递队列。
 * 前端岗位则来自「方向放宽后 targetCareers 被清空 + 软过滤补足名额」。
 *
 * 这里只做一件确定性的事：用户方向里**明确写了某个技术栈**时，
 * 岗位标题里明确写了「另一个栈、且完全没提目标栈」就硬否决。
 * 通用词（「后端开发工程师」「研发工程师」）不带栈，照常放行交给匹配分。
 */

export type TechStack =
  | 'php' | 'java' | 'go' | 'python' | 'node' | 'dotnet'
  | 'cpp' | 'rust' | 'frontend' | 'mobile' | 'data'

/** 只用于「主语言栈」推断：后端工程师简历里常附 Vue/React，不能把它当成求职方向 */
export const PRIMARY_LANGUAGE_STACKS: TechStack[] = [
  'php', 'java', 'go', 'python', 'node', 'dotnet', 'cpp', 'rust',
]

const STACK_PATTERNS: Array<{ id: TechStack; re: RegExp }> = [
  { id: 'php', re: /php|laravel|thinkphp|symfony|\byii\b|swoole/i },
  { id: 'java', re: /java(?!script)|spring\s?boot|\bspring\b|\bjvm\b|mybatis|hadoop/i },
  { id: 'go', re: /golang|go\s?语言|gopher/i },
  { id: 'python', re: /python|django|\bflask\b|fastapi/i },
  { id: 'node', re: /node\.?js|nestjs|\bexpress\b|\bkoa\b/i },
  { id: 'dotnet', re: /\.net|c#|asp\.net/i },
  { id: 'cpp', re: /c\+\+|\bqt\b/i },
  { id: 'rust', re: /\brust\b/i },
  { id: 'frontend', re: /前端|frontend|\bvue\b|\breact\b|angular|webpack|typescript|\bh5\b|web\s?前端|小程序开发/i },
  { id: 'mobile', re: /android|\bios\b|\bswift\b|flutter|移动端|安卓|客户端开发/i },
  { id: 'data', re: /算法工程师|机器学习|数据开发|大数据|数据仓库|\betl\b|数据挖掘/i },
]

export const STACK_LABELS: Record<TechStack, string> = {
  php: 'PHP', java: 'Java', go: 'Go', python: 'Python', node: 'Node.js',
  dotnet: '.NET', cpp: 'C++', rust: 'Rust', frontend: '前端',
  mobile: '移动端', data: '数据/算法',
}

/** 从一段文本里识别所有出现的技术栈 */
export function detectTechStacks(text: string, allowed?: TechStack[]): TechStack[] {
  const clean = (text || '').toLowerCase()
  if (!clean) return []
  const scope = allowed
    ? STACK_PATTERNS.filter((p) => allowed.includes(p.id))
    : STACK_PATTERNS
  const hits: TechStack[] = []
  for (const p of scope) if (p.re.test(clean)) hits.push(p.id)
  return hits
}

export interface StackSources {
  /** 用户明确填写的期望职位 / 本轮搜索词（可识别全部栈） */
  directions?: string[]
  /** 最近工作职位（可识别全部栈） */
  positions?: string[]
  /** 简历技能 / 项目技术栈（只识别主语言栈，避免「熟悉 Vue」把前端算成方向） */
  skills?: string[]
}

/**
 * 汇总目标技术栈。
 * 方向文本权重最高；技能清单只补主语言栈，且必须是「唯一或明显占优」的那个，
 * 否则（例如简历同时写了 PHP 和 Java）不强行锁定，避免误杀。
 */
export function extractTargetStacks(sources: StackSources): TechStack[] {
  const directionHits = new Set<TechStack>()
  for (const text of [...(sources.directions || []), ...(sources.positions || [])]) {
    for (const s of detectTechStacks(text)) directionHits.add(s)
  }
  if (directionHits.size > 0) return [...directionHits]

  // 方向里没写具体栈时，从技能清单里找主语言栈（最多一个才敢锁定）
  const counts = new Map<TechStack, number>()
  for (const text of sources.skills || []) {
    for (const s of detectTechStacks(text, PRIMARY_LANGUAGE_STACKS)) {
      counts.set(s, (counts.get(s) || 0) + 1)
    }
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1])
  if (ranked.length === 0) return []
  if (ranked.length > 1 && ranked[0][1] === ranked[1][1]) return []
  return [ranked[0][0]]
}

/**
 * 岗位是否明确属于「另一个技术栈」。
 * 只在目标栈非空时启用；岗位标题含任意目标栈 → 一律放行（含双栈岗位）。
 * 岗位标题不带任何具体栈（通用「后端开发工程师」）→ 放行，交给匹配分。
 */
export function isCrossStackJob(jobTitle: string, targetStacks: TechStack[] = []): boolean {
  if (targetStacks.length === 0 || !jobTitle) return false
  const title = jobTitle.toLowerCase()
  const targetSet = new Set(targetStacks)
  const jobStacks = detectTechStacks(title)
  if (jobStacks.length === 0) return false
  if (jobStacks.some((s) => targetSet.has(s))) return false
  return true
}

export function describeTargetStacks(stacks: TechStack[] = []): string {
  return stacks.map((s) => STACK_LABELS[s]).join(' / ')
}

/** 生成给日志/AI 看的否决说明 */
export function describeCrossStackReason(jobTitle: string, targetStacks: TechStack[]): string {
  const jobStacks = detectTechStacks(jobTitle)
  return `岗位属于 ${jobStacks.map((s) => STACK_LABELS[s]).join('/') || '其他技术栈'}，与你的方向（${describeTargetStacks(targetStacks)}）不符`
}
