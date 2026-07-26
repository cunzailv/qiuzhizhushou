// Apply filters used before starting the auto-apply flow
export interface ApplyFilters {
  /** 岗位名称关键词（空格分隔多个关键词，AND 逻辑） */
  jobTitles: string
  /** 工作地点关键词（空格分隔） */
  locations: string
  /** 最低月薪（K，如 15） */
  salaryMin: number | null
  /** 最高月薪（K，如 30） */
  salaryMax: number | null
  /** 经验要求：应届生/1年以内/1-3年/3-5年/5-10年 */
  experience: string
  /** 学历要求：不限/大专/本科/硕士/博士 */
  education: string
  /** 排除关键词（公司名中包含则不投，空格分隔） */
  excludeKeywords: string
  /** 是否启用 AI 匹配评分 */
  enableAiMatch: boolean
  /** 最低 AI 匹配分数（低于此分不投） */
  minMatchScore: number
}

export const DEFAULT_FILTERS: ApplyFilters = {
  jobTitles: '',
  locations: '',
  salaryMin: null,
  salaryMax: null,
  experience: '',
  education: '',
  excludeKeywords: '',
  enableAiMatch: true,
  minMatchScore: 60,
}

export const EXPERIENCE_OPTIONS = [
  { value: '', label: '不限' },
  { value: '应届', label: '应届生' },
  { value: '1年以内', label: '1年以内' },
  { value: '1-3年', label: '1-3年' },
  { value: '3-5年', label: '3-5年' },
  { value: '5-10年', label: '5-10年' },
  { value: '10年以上', label: '10年以上' },
]

export const EDUCATION_OPTIONS = [
  { value: '', label: '不限' },
  { value: '大专', label: '大专' },
  { value: '本科', label: '本科' },
  { value: '硕士', label: '硕士' },
  { value: '博士', label: '博士' },
]

/**
 * 解析 Boss 直聘薪资字符串（如 "15K-25K"、"20K-40K·16薪"），返回 [minK, maxK]
 * 只取月薪部分（K前的数字），忽略年终等其他信息
 */
export function parseSalaryRange(salary: string): [number, number] | null {
  if (!salary) return null
  const match = salary.match(/(\d+)\s*[Kk]\s*[-~到至]\s*(\d+)\s*[Kk]/)
  if (!match) {
    // 尝试单值格式 "20K"
    const single = salary.match(/(\d+)\s*[Kk]/)
    if (single) {
      const k = parseInt(single[1], 10)
      return [k, k]
    }
    return null
  }
  return [parseInt(match[1], 10), parseInt(match[2], 10)]
}
