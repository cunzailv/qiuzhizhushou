// C1 · 本地语义精筛
// 轻量离线语义增强：技能别名归一 + 词元 Jaccard + 方向词强化。
// 让本地评分在无 AI/省成本场景下更准（离线 embedding 作为后续可选升级）。
import { ROLE_KEYWORDS } from './role-keywords'

/** 技能/术语别名（归一后统一词形，提升"JS↔JavaScript / Node↔Node.js"这类跨写法匹配） */
export const SKILL_ALIASES: Array<{ pattern: RegExp; replacement: string }> = [
  // 长模式优先，避免 \bjs\b 误伤 node.js / react.js 中的 js
  { pattern: /node\.?js/g, replacement: 'nodejs' },
  { pattern: /react\.?js/g, replacement: 'react' },
  { pattern: /\bgolang\b/g, replacement: 'go' },
  { pattern: /\bpy\b/g, replacement: 'python' },
  { pattern: /\bhtml5\b/g, replacement: 'html' },
  { pattern: /\bcss3\b/g, replacement: 'css' },
  { pattern: /\bjs\b/g, replacement: 'javascript' },
  { pattern: /\bts\b/g, replacement: 'typescript' },
]

/** 文本归一：小写 + 别名替换 */
export function normalizeText(text: string): string {
  let normalized = text.toLowerCase()
  for (const { pattern, replacement } of SKILL_ALIASES) {
    normalized = normalized.replace(pattern, replacement)
  }
  return normalized
}

/** 词元化：英文单词（保留 . + # / - 组合）+ 中文二元组 */
export function tokenizeSemantic(text: string): Set<string> {
  const tokens = new Set<string>()
  const normalized = normalizeText(text)

  for (const match of normalized.matchAll(/[a-z0-9]+(?:[.+#/-][a-z0-9+#]+)*/g)) {
    if (match[0].length > 1) tokens.add(match[0])
  }

  for (const match of normalized.matchAll(/[\u3400-\u9fff]+/g)) {
    const sequence = match[0]
    if (sequence.length === 1) {
      tokens.add(sequence)
      continue
    }
    for (let index = 0; index < sequence.length - 1; index++) {
      tokens.add(sequence.slice(index, index + 2))
    }
  }

  return tokens
}

/** 双方共现的方向词数量（前端/后端/算法等，作为语义强化信号） */
export function sharedRoleKeywordCount(text1: string, text2: string): number {
  const t1 = normalizeText(text1)
  const t2 = normalizeText(text2)
  let count = 0
  for (const keyword of ROLE_KEYWORDS) {
    if (t1.includes(keyword.toLowerCase()) && t2.includes(keyword.toLowerCase())) count += 1
  }
  return count
}

/**
 * 语义相似度（0-1）：别名归一后的词元 Jaccard，方向词共现加权。
 * 相比纯字符二元组，能识别 "JS↔JavaScript / Node↔Node.js" 的跨写法等价。
 */
export function semanticSimilarity(text1: string, text2: string): number {
  const words1 = tokenizeSemantic(text1)
  const words2 = tokenizeSemantic(text2)
  if (words1.size === 0 && words2.size === 0) return 0

  let intersection = 0
  for (const word of words1) {
    if (words2.has(word)) intersection += 1
  }

  const union = words1.size + words2.size - intersection
  if (union === 0) return 0

  let similarity = intersection / union
  // 方向词共现强化：每 1 个共现方向词 +2.5% 相似度（上限 15%）
  const roleBoost = Math.min(0.15, sharedRoleKeywordCount(text1, text2) * 0.025)
  similarity = Math.min(1, similarity + roleBoost)
  return similarity
}
