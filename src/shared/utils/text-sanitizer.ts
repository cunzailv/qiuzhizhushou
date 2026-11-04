// 文本与岗位数据深度清洗工具（剔除 Boss 直聘防爬注入样式、混淆词、加密字体与脏数据）

const PUA_RE = /[\uE000-\uF8FF]/g

/**
 * 将 Boss 直聘加密字体编码（PUA 码段）确定性还原为 0-9 数字，并移除残余图标码
 */
export function decodeBossFontGlyphs(text: string): string {
  if (!text || typeof text !== 'string') return ''
  return text.replace(PUA_RE, (ch) => {
    const code = ch.charCodeAt(0)
    // 码段 1: 0xE030 - 0xE039 -> '0' - '9'
    if (code >= 0xe030 && code <= 0xe039) return String(code - 0xe030)
    // 码段 2: 0xEE00 - 0xEE09 -> '0' - '9'
    if (code >= 0xee00 && code <= 0xee09) return String(code - 0xee00)
    // 码段 3: 0xE130 - 0xE139 -> '0' - '9'
    if (code >= 0xe130 && code <= 0xe139) return String(code - 0xe130)
    // 其他未识别的 PUA 特殊字符移除
    return ''
  })
}

/**
 * 彻底清洗各类文本：移除 CSS 样式块、混淆关键词、无意义空白与特殊标记
 */
export function sanitizeJobText(raw?: string): string {
  if (!raw || typeof raw !== 'string') return ''

  // 1. 还原加密字体
  let text = decodeBossFontGlyphs(raw)

  // 2. 移除 CSS 样式块与 style 标签
  text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
  text = text.replace(/[.#]?[a-zA-Z0-9_-]+\s*\{[^}]*\}/g, '')
  text = text.replace(/display:\s*inline-block;[^;]*;/gi, '')
  text = text.replace(/visibility:\s*hidden;?/gi, '')
  text = text.replace(/font-size:\s*0!important;?/gi, '')

  // 3. 移除 Boss 直聘注入的水印与混淆词
  text = text.replace(/来自BOSS直聘后台/g, '')
  text = text.replace(/kanzhun/gi, '')
  // 针对被作为独立隐形 token 插入的混淆
  text = text.replace(/【岗位boss概述】/g, '【岗位概述】')
  text = text.replace(/深boss度/g, '深度')
  text = text.replace(/B boss端/g, 'B端')
  text = text.replace(/核[心|⼼]数据[工|⼯]具模kanzhun块/g, '核心数据工具模块')
  text = text.replace(/数据工具直聘方向/g, '数据工具方向')

  // 4. 清理无意义空白与控制字符
  text = text
    .replace(/[\t\r\f\v]+/g, ' ')
    .replace(/ {2,}/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim()

  return text
}

/**
 * 清洗 JobCard 对象的各字段，防止脏数据入库
 */
export function sanitizeJobCard<T extends {
  title?: string
  companyName?: string
  salary?: string
  location?: string
  jobDescription?: string
  tags?: string[]
}>(card: T): T {
  const cleaned: T = { ...card }
  if (cleaned.title) cleaned.title = sanitizeJobText(cleaned.title)
  if (cleaned.companyName) cleaned.companyName = sanitizeJobText(cleaned.companyName)
  if (cleaned.salary) cleaned.salary = sanitizeJobText(cleaned.salary)
  if (cleaned.location) cleaned.location = sanitizeJobText(cleaned.location)
  if (cleaned.jobDescription) cleaned.jobDescription = sanitizeJobText(cleaned.jobDescription)
  if (cleaned.tags && Array.isArray(cleaned.tags)) {
    cleaned.tags = cleaned.tags
      .map((t) => sanitizeJobText(t))
      .filter((t) => {
        if (!t) return false
        // 过滤混入 tags 的薪资串（如 20-40K·15薪）
        if (/\d+[-~到至]\d+[Kk]/.test(t)) return false
        if (/[Kk]·\d+薪/.test(t)) return false
        return true
      })
  }
  return cleaned
}
