// 岗位名称硬闸门（Career Hard Gate）
//
// 用户反馈：「海投也要根据岗位名字才行啊，不能我写了 php 后台 AI 全栈开发 不投，
// 投了产品经理 销售 啥的」。
//
// 旧链路有三处让「用户填写的岗位名称」失效：
//  1. content/index.ts 的 strictRelevanceGate 被 mustAchieve / fastMode / relaxCareerFilter 关掉；
//  2. job-filter.ts 把「职业方向不匹配」标成 soft，采集层用 softMatchedJobs 又把它们补回队列；
//  3. isJobMatchingCareer 的包含规则让「AI」这类泛词把「AI产品经理」误判成 AI 开发岗。
//
// 本模块是**唯一的方向真源**：只要用户在「岗位名称」里填了方向，任何模式
// （精投 / 海投 / 极速 / 必达 / 放宽 / 匹配分下调）都不允许绕过它。
// 必达模式能自动接管的只有配额、活跃时间、匹配分、页码、频次等可控参数，
// 用户想找什么岗位属于不可让渡的真实意愿。
//
// 设计上刻意做成零依赖纯函数：job-filter / job-relevance / content / background 都能引用，
// 不会和 job-filter 形成循环引用。

/** 硬闸门判定结论 */
export interface CareerGateVerdict {
  allowed: boolean
  /** 不通过时给用户看的具体原因，会写进行为日志和任务的 failReason */
  reason?: string
}

/**
 * 明确的「非开发职能」岗位性质词。
 * 出现在标题主部且用户方向里没写 → 一律否决，标题里带 AI / PHP 字样也不行。
 * 例如「AI产品经理」「PHP销售工程师」「WMS 产品经理」。
 */
export const NON_DEV_ROLE_RE =
  /(产品经理|产品总监|产品专员|产品助理|产品负责人|产品策划|产品顾问|产品运营|运营经理|运营总监|运营专员|运营主管|用户运营|内容运营|活动运营|新媒体运营|电商运营|社区运营|游戏运营|数据运营|市场营销|市场专员|市场经理|市场总监|品牌经理|公关|商务经理|商务专员|商务拓展|渠道经理|客户经理|客户成功|大客户经理|销售|电销|招商|电话销售|客服|客户支持|售后服务|售后|售前顾问|售前|技术支持|课程顾问|招生顾问|咨询顾问|讲师|培训师|教师|助教|行政|前台|人事|人力资源|招聘专员|招聘顾问|猎头|财务|会计|出纳|审计|法务|律师|设计师|视觉设计|ui设计|平面设计|空间设计|美工|文案|编辑|主播|编导|记者|项目经理|项目助理|项目主管|秘书|跟单|采购|物流|仓储|质检|翻译|院长|医生|护士|药师|心理咨询|理财顾问|保险经纪|房产中介|置业顾问|保安|保洁|司机|骑手|外卖|普工|操作工|店员|导购|地推|兼职刷单)/i

/**
 * 强开发语义词。用于区分「岗位主职能是开发」与「只是含工程师三个字的销售岗」。
 * 「电商销售系统开发工程师」有「开发」→ 放行；「销售工程师」没有 → 否决。
 */
export const STRONG_DEV_ROLE_RE =
  /(开发|研发|架构|全栈|前后端|前端|后端|服务端|后台|算法|程序员|数据开发|大数据|嵌入式|移动端|小程序)/i

/** 技术岗语义词（比 STRONG_DEV_ROLE_RE 宽，用于泛词命中时要求岗位确实是技术岗） */
export const DEV_SEMANTIC_RE =
  /(开发|研发|工程师|程序员|架构|全栈|前后端|前端|后端|服务端|后台|算法|运维|测试|嵌入式|移动端|小程序|技术|程序|数据开发|大数据|软件工程)/i

/** 泛修饰词：只是技术/级别/领域修饰，单独出现不能代表一个岗位方向 */
const GENERIC_MODIFIER_RE =
  /^(ai|人工智能|智能体|agent|大模型|llm|aigc|数据|软件|互联网|信息化|数字化|云原生|高级|资深|专家|急聘|招聘|全职|远程|实习|应届)$/i

/** 判断一个用户方向词是不是「不能单独证明岗位对口」的泛词 */
export function isGenericCareerToken(token: string): boolean {
  return GENERIC_MODIFIER_RE.test(String(token || '').trim().toLowerCase())
}

/** 用户是否填了可用的岗位方向（空数组 = 不限方向，硬闸门不启用） */
export function isCareerGateActive(targetCareers: readonly string[] | null | undefined): boolean {
  return Array.isArray(targetCareers) && targetCareers.some((t) => String(t || '').trim().length > 0)
}

function cleanKey(raw: string): string {
  return String(raw || '')
    .toLowerCase()
    .replace(/[（(].*?[)）]/g, '')
    .replace(/[\s\-_/\\|·、,，]/g, '')
    .trim()
}

/**
 * 标题主部：去掉括号里的补充说明（「PHP开发工程师（销售系统方向）」不该被「销售」误杀）。
 */
function cleanMainTitle(raw: string): string {
  return cleanKey(raw)
}

/** 日志用的方向摘要 */
export function describeCareerGate(targetCareers: readonly string[] = []): string {
  return isCareerGateActive(targetCareers)
    ? `岗位名称硬闸门【${targetCareers.join(' / ')}】`
    : '未填写岗位名称（方向不设限）'
}

/**
 * 岗位名称硬闸门：这个岗位标题，是否属于用户填写的求职方向。
 *
 * 判定顺序：
 *  1. 用户没填方向 → 不擅自否决（保持「全量职业」语义）；
 *  2. 标题主部命中非开发职能，且用户方向里没写这个职能 → 否决；
 *     若标题同时有强开发语义（「XX系统开发工程师」），视为开发岗继续判断；
 *  3. 用户方向本身是非开发职能（例如他就要找「产品经理」）→ 按职能词严格匹配；
 *  4. 其余（技术方向）→ 只要岗位确实是技术/开发岗就放行，
 *     同义不同字（「后台开发」搜到「PHP开发工程师」）不再被族谱白名单误杀；
 *     跨技术栈由 stack-guard 独立硬拦，这里不重复实现。
 */
export function isJobTitleAllowed(
  jobTitle: string,
  targetCareers: readonly string[] | null | undefined = [],
): CareerGateVerdict {
  const careers = (targetCareers || [])
    .map((t) => String(t || '').trim())
    .filter(Boolean)
  if (careers.length === 0) return { allowed: true }

  const title = String(jobTitle || '').trim()
  if (!title) return { allowed: false, reason: '岗位名称为空，无法核对求职方向' }

  const main = cleanMainTitle(title)
  if (!main) return { allowed: false, reason: '岗位名称为空，无法核对求职方向' }

  const dirText = careers.map(cleanKey).join('')
  const nonDevHit = main.match(NON_DEV_ROLE_RE)?.[0] || ''
  const userWantsNonDevRole = careers.some((c) => NON_DEV_ROLE_RE.test(cleanKey(c)))

  // 2. 非开发职能否决：用户没写这个职能，且标题不是「XX系统开发工程师」这类开发岗
  if (nonDevHit && !dirText.includes(cleanKey(nonDevHit)) && !STRONG_DEV_ROLE_RE.test(main)) {
    return {
      allowed: false,
      reason: `「${nonDevHit}」不属于你填写的岗位方向（${careers.join(' / ')}）`,
    }
  }

  // 3. 用户明确要找非开发职能岗位时，按职能词严格匹配，不许把开发岗塞进来
  if (userWantsNonDevRole) {
    const hit = careers.some((c) => {
      const key = cleanKey(c)
      return key.length >= 2 && (main.includes(key) || key.includes(main))
    })
    return hit
      ? { allowed: true }
      : { allowed: false, reason: `岗位「${title}」不是你填写的方向（${careers.join(' / ')}）` }
  }

  // 4. 技术方向：只要是技术岗就放行，泛词「AI」不再单独构成匹配依据
  if (DEV_SEMANTIC_RE.test(main)) return { allowed: true }

  return {
    allowed: false,
    reason: `岗位「${title}」不是技术开发岗，与填写的方向（${careers.join(' / ')}）不符`,
  }
}
