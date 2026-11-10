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

/**
 * 非软件领域的**职能**词：电子 / 硬件 / 机械 / 电气 / 传统工程。
 *
 * 用户反馈「还是乱投 项目主管 电子研发」：旧版第 4 步只看 DEV_SEMANTIC_RE，
 * 「电子研发」「硬件研发工程师」「PCB Layout工程师」因为带「研发 / 工程师」全被放行。
 * 这里只放职能词，不放「医疗 / 汽车」这类行业修饰词 —— 「医疗软件后端开发」
 * 依然是对口的软件开发岗，不该被行业名误杀。
 */
export const NON_SOFTWARE_DOMAIN_RE =
  /(电子|硬件|电路|pcb|原理图|射频|微波|模拟电路|数字电路|单片机|plc|fpga|嵌入式硬件|机械|结构|模具|钣金|电气|电力|工业自动化|自动化控制|仪器仪表|通信工程|光电子|半导体|晶圆|材料|化工|化学|土木|建筑|装修|暖通|给排水|测绘|工艺|装配|品控|车辆|汽车电子|航空|航天|船舶)/i

/** 明确的软件栈 / 软件岗位信号：出现时说明这确实是软件开发岗，领域词只是修饰 */
const SOFTWARE_STACK_RE =
  /(php|java|python|golang|go语言|node|vue|react|spring|laravel|thinkphp|django|flask|\.net|c#|web|app|小程序|后端|前端|全栈|前后端|服务端|后台|软件|算法工程师|数据开发|大数据|saas|中间件|数据库|devops|sre)/i

/** 软件开发方向下的正向准入：必须是软件 / 互联网开发岗，而不只是「带工程师三个字」 */
export const SOFTWARE_DEV_ROLE_RE =
  /(开发|软件|架构|全栈|前后端|前端|后端|服务端|后台|程序员|程序|算法|数据开发|大数据|php|java|python|golang|go语言|node|vue|react|web|app|小程序|移动端|saas|中间件|数据库|devops|sre|运维开发|测试开发)/i

/** 纯管理职能：不是开发岗。技术管理（技术总监 / 架构师）走下面的白名单 */
const MANAGEMENT_ROLE_RE =
  /(项目主管|项目总监|项目经理|项目助理|研发主管|研发经理|研发总监|部门主管|部门经理|组长|主管|总监|负责人|leader|ceo)/i

/** 同方向的技术管理岗，视为对口，不被管理否决误杀 */
const TECH_LEADERSHIP_RE =
  /(技术经理|技术总监|技术主管|技术负责人|架构师|cto|技术专家|首席架构|研发架构)/i

/** 用户填的方向是不是软件 / 互联网开发方向（硬件求职者不该被软件领域闸门误伤） */
const SOFTWARE_DIRECTION_RE =
  /(开发|软件|后端|前端|全栈|前后端|服务端|后台|架构|算法|程序|php|java|python|golang|node|vue|react|web|app|小程序|移动端|ai|智能体|大模型|llm|agent|数据|运维|测试|互联网)/i

export function hasSoftwareDirection(targetCareers: readonly string[] | null | undefined): boolean {
  return (targetCareers || []).some((c) => SOFTWARE_DIRECTION_RE.test(cleanKey(c)))
}

/**
 * 岗位标题是否命中用户填写的**方向族谱**。
 *
 * 这是「按岗位名称投」的核心：只证明「这是个软件开发岗」不够，
 * 「MES系统开发工程师（含WMS模块）」也是软件开发岗，但用户填的是
 * php / 后台 / AI / 全栈开发，它一个都没沾，就不该进队列。
 *
 * 族谱覆盖同义不同字：方向「后台」↔ 岗位「后端开发工程师」、
 * 方向「php」↔ 岗位「PHP开发工程师」、方向「AI」↔ 岗位「AI算法工程师」。
 * 这样既严格又不会把「搜后台却投不了 PHP 开发」的老问题带回来。
 */
export function matchesCareerFamily(
  jobTitle: string,
  targetCareers: readonly string[] | null | undefined,
): boolean {
  const main = cleanMainTitle(jobTitle)
  const dirs = (targetCareers || []).map(cleanKey).filter(Boolean)
  if (!main || dirs.length === 0) return false
  const dirText = dirs.join('')

  // 1. 方向词直接命中（或被方向词完整包含）。
  //    短英文方向词必须落在单词边界上：方向「ai」不能因为「email / maintenance」里
  //    有 ai 两个字母就把非 AI 岗位判成同族，方向「go」同理不能被 golang 误命中。
  const LATIN_TOKEN_RE = /^[a-z0-9.+#/]+$/i
  for (const d of dirs) {
    if (d.length < 2 || !(main.includes(d) || d.includes(main))) continue
    if (LATIN_TOKEN_RE.test(d)) {
      const escaped = d.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      if (!new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`, 'i').test(main)) continue
    }
    return true
  }

  // 2. 后端 / 后台 / 服务端族谱
  if (/(后端|后台|服务端|backend|server)/.test(dirText) &&
      /(后端|后台|服务端|backend|server)/.test(main)) return true

  // 3. 前端族谱
  if (/(前端|frontend)/.test(dirText) && /(前端|frontend|web开发)/.test(main)) return true

  // 4. 全栈族谱
  if (/(全栈|fullstack|前后端)/.test(dirText) && /(全栈|fullstack|前后端)/.test(main)) return true

  // 5. AI / 智能体族谱。ai 两侧不能紧挨英文字母，否则「email / maintenance
  //    开发工程师」会因为含 ai 被当成 AI 方向岗位（又一种乱投）。
  const AI_TOKEN_RE = /(?<![a-z])ai(?![a-z])|人工智能|智能体|agent|大模型|llm|aigc/i
  if (AI_TOKEN_RE.test(dirText) && new RegExp(`${AI_TOKEN_RE.source}|算法`, 'i').test(main)) return true

  // 5.1 历史假阴性：方向只写「后台 / 后端 / 全栈」时，
  //     「PHP开发工程师」「Java后端」这类只写语言栈、不写「后端」二字的岗位
  //     也必须算同族，否则会退回「搜后台却一个岗位都投不了」的老问题。
  //     跨栈（方向锁定 PHP 却投 Java）由 stack-guard 独立硬拦，这里不管。
  if (/(后端|后台|服务端|backend|server|全栈|fullstack)/.test(dirText) &&
      /(php|laravel|thinkphp|swoole|java|spring|python|django|flask|golang|go语言|node|nestjs|\.net|c#|ruby|rust)/.test(main)) {
    return true
  }

  // 6. 明确的语言 / 框架栈
  const stacks = [
    'php', 'laravel', 'thinkphp', 'swoole', 'java', 'spring', 'python',
    'django', 'flask', 'golang', 'go语言', 'node', 'vue', 'react',
    '.net', 'c#', 'rust', 'mysql', 'redis',
  ]
  for (const s of stacks) {
    if (dirText.includes(s) && main.includes(s)) return true
  }

  // 7. 架构 / 技术管理族谱（白名单岗位本身已在 4.2 放行）
  const LEADERSHIP_FAMILY_RE =
    /(架构|技术经理|技术总监|技术主管|技术负责人|技术专家|cto|研发经理|研发架构|首席架构)/i
  if (LEADERSHIP_FAMILY_RE.test(dirText) && LEADERSHIP_FAMILY_RE.test(main)) return true

  return false
}

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
 *  4. 软件方向 → 先否决非软件领域职能（电子 / 硬件 / 机械 / 电气）与纯管理岗，
 *     再要求「软件开发语义 + 命中用户方向族谱」两个条件同时成立；
 *     技术管理岗（技术总监 / 架构师）走白名单。
 *     同义不同字由 matchesCareerFamily 承担（「后台」↔「后端开发工程师」），
 *     跨技术栈由 stack-guard 独立硬拦，这里不重复实现。
 *  5. 非软件方向（例如用户填「电子研发」）→ 沿用宽松技术岗判定，不越权替他改方向。
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

  // 4. 软件方向：职能领域 + 管理岗 + 软件开发语义三层收口
  if (hasSoftwareDirection(careers)) {
    // 4.1 电子 / 硬件 / 机械 / 电气等不是软件开发岗；
    //     标题里同时出现明确软件栈信号时只当修饰词，不误杀「嵌入式软件工程师」。
    const domainHit = main.match(NON_SOFTWARE_DOMAIN_RE)?.[0] || ''
    if (domainHit && !SOFTWARE_STACK_RE.test(main)) {
      return {
        allowed: false,
        reason: `「${domainHit}」属于非软件领域，不是你填写的岗位方向（${careers.join(' / ')}）`,
      }
    }

    // 4.2 技术管理岗（技术总监 / 架构师）只豁免下面的「纯管理岗否决」，
    //     仍必须命中方向族谱。旧版在这里直接 return allowed，
    //     等于给「架构师 / 技术总监」开了一道绕过岗位名称的后门。
    if (TECH_LEADERSHIP_RE.test(main)) {
      return matchesCareerFamily(title, careers)
        ? { allowed: true }
        : {
            allowed: false,
            reason: `岗位「${title}」不在你填写的方向族谱内（${careers.join(' / ')}）`,
          }
    }

    // 4.3 纯管理岗：「项目主管」「研发主管」「部门经理」不是开发岗
    const mgmtHit = main.match(MANAGEMENT_ROLE_RE)?.[0] || ''
    if (mgmtHit && !dirText.includes(cleanKey(mgmtHit))) {
      return {
        allowed: false,
        reason: `「${mgmtHit}」是管理岗，不是你填写的开发方向（${careers.join(' / ')}）`,
      }
    }

    // 4.4 正向准入：既是软件开发岗，**又必须命中用户填的方向族谱**。
    //     只满足「是个开发岗」不够 —— MES / WMS / ERP 业务系统开发、通用软件工程师
    //     都是开发岗，但和「php 后台 AI 全栈开发」不是一个方向，精投 / 海投都不投。
    if (SOFTWARE_DEV_ROLE_RE.test(main) && matchesCareerFamily(title, careers)) {
      return { allowed: true }
    }

    return {
      allowed: false,
      reason: `岗位「${title}」不在你填写的方向族谱内（${careers.join(' / ')}）`,
    }
  }

  // 5. 非软件方向（例如用户填「电子研发」）：不越权替他改成软件方向。
  //    软件开发岗与硬件领域互斥；同领域的同义技术岗照常放行。
  const dirHasSoftwareStack = SOFTWARE_STACK_RE.test(dirText)
  // 只有方向**明确落在非软件领域**（电子 / 硬件 / 机械 …）才互斥；
  // 「研发助理」这种泛研发词仍按开发方向处理，不能把 PHP 开发岗误杀。
  const userIsNonSoftwareDomain = careers.some((c) => NON_SOFTWARE_DOMAIN_RE.test(cleanKey(c)))
  if (userIsNonSoftwareDomain && SOFTWARE_DEV_ROLE_RE.test(main) && !dirHasSoftwareStack) {
    return {
      allowed: false,
      reason: `岗位「${title}」是软件开发岗，与你填写的方向（${careers.join(' / ')}）不符`,
    }
  }
  if (DEV_SEMANTIC_RE.test(main)) return { allowed: true }

  return {
    allowed: false,
    reason: `岗位「${title}」不是技术岗，与填写的方向（${careers.join(' / ')}）不符`,
  }
}
