import type { JobCard, MatchResult } from '../types/job'
// CommunicationUiSnapshot 由 content/action-simulator 定义并导出，这里仅做类型引用（无运行时循环依赖）。
import type { CommunicationUiSnapshot } from './boss/action-simulator'

export type { CommunicationUiSnapshot }

// 页面类型：搜索列表 / 职位详情 / 沟通会话 / 推荐流 / 其他
export type PageType = 'search' | 'detail' | 'chat' | 'recommend' | 'other'

// 平台专属风控文案配置（用于风险检测器参数化，避免硬编码 BOSS 文案）
export interface PlatformRiskConfig {
  id: string
  name: string
  dailyLimitMarkers: string[] // 每日沟通/投递上限提示
  rateLimitMarkers: string[] // 操作频率限制提示
  blockMarkers: string[] // 账号受限/风控提示
  captchaMarkers: string[] // 安全验证/验证码提示
}

export interface CollectOptions {
  // 最大采集岗位数量（跨平台统一口径）。达到后立即停止采集；未设置或 <=0 表示不限制。
  maxJobs?: number
  maxPages?: number
  delayBetweenPages?: number
  onCountChange?: (count: number) => void
  // 返回 true 时立即中止采集（用于响应用户的「停止」操作）。
  shouldCancel?: () => boolean
}

// 统一平台适配器接口：所有招聘平台（Boss直聘、猎聘等）均实现该接口，
// content 脚本通过 PlatformManager 获取当前活动适配器，从而与具体平台解耦。
export interface PlatformAdapter {
  id: string
  name: string
  icon: string
  // 没有可用标签页时，用于「自动打开目标平台入口页」的默认 URL。
  homeUrl: string
  // 按当前网址判断是否匹配该平台
  matchesUrl(url: string): boolean
  // 页面类型识别（可结合 URL 与 DOM）
  detectPageType(): PageType
  // 解析搜索列表中的职位卡片
  parseJobCardsFromSearchPage(): JobCard[]
  // 解析当前职位详情页（猎聘等详情内联场景）
  parseJobDetailFromPage(): JobCard | null
  // 提取详情页岗位描述文本
  extractJobDescriptionFromDetail(root?: ParentNode): string
  // 渐进式收集多页职位（封装滚动 / 翻页 / 换一批等平台差异）
  collectJobCards(
    readCurrentCards: () => JobCard[],
    options?: CollectOptions,
  ): Promise<JobCard[]>
  // 激活（打开）某个职位详情，返回详情容器元素
  activateJobCard(
    jobUrl: string,
    jobId: string,
    expectedTitle?: string,
    expectedCompany?: string,
  ): Promise<HTMLElement | null>
  // 点击「投递 / 申请」按钮
  clickApplyButton(jobCard: HTMLElement): Promise<boolean>
  // 在招呼输入框中填入消息
  fillGreetingMessage(
    message: string,
    snapshot?: CommunicationUiSnapshot,
  ): Promise<boolean>
  // 根据简历与匹配结果生成平台专属招呼语
  getJobSpecificGreeting(resumeName: string, job: JobCard, match: MatchResult): string
  // 抓取当前沟通 / 招呼 UI 快照
  snapshotCommunicationUi(): CommunicationUiSnapshot
  // 返回平台风控配置
  getRiskConfig(): PlatformRiskConfig
  // 关闭已打开的详情面板（非推荐岗位释放资源）
  closeDetailPanel?(): Promise<void>
}
