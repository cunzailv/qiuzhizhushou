# Changelog

## [Unreleased] — 侧栏形态收敛、概览批量沟通控制台、半自动/全自动互斥、筛选条件通用、智能中控对话台 Tool-Calling Agent、异常留痕跨上下文统一、unslop 界面设计体系、信息架构分层收纳、图标入口直达右侧侧栏、投递确认层与行为日志历史回看、搜索方向生效与技术栈硬约束、后台静默运行不抢焦点、休息状态机与产能修复、目标产能设定、目标产能闭环修复（供给死锁 / 产能优先 / 时段冲突）、目标必达模式（设定即承诺，未达成不停机）

### Added

- **必达模式不再有「超时」这一说法（用户反馈「已超时 16/80 · 必达模式继续投递，没有超时这一说法的呀」）**：设定目标 = 承诺达成，小时数只是进度参考，`remainingMs <= 0` 不该显示为失败标签。现统一为「进行中」口径：`describeCapacityStatus()` 的超时分支改为 `16/80 · 目标必达继续投递`，`on-track` 必达分支改为 `X/Y 份 · 目标必达进行中`（不再写「X 小时内」），`at-risk` 预测分支也不再说「赶不上目标」；`evaluateCapacityGoal()` 的必达 advice 去掉「已超过 N 小时时限」，改报「目标进行中，当前已确认 X/Y，还差 Z 份」。后台超过时限那条日志去掉「已超过设定的 N 小时」并从 `warn` 降为 `info`，通知标题 `目标必达 · 超时继续` → `目标必达 · 继续投递`，每 10 分钟那条由「🎯 目标产能预警」改为「🎯 目标进度」（必达全程 capacityUrgent，是常态播报不是预警）。面板去掉「已超时，必达模式继续投递直到达成」，并让必达状态下的状态文字不再用警告黄。**显式关掉必达后仍保留 `missed` / 超时 / 预警的旧语义**，向后兼容不变
- **回归测试**：`tests/capacity-goal.test.ts` +3 例（必达状态摘要与 advice 不含「超时 / 超期 / 未达成」、进行中不出现「X 小时内」、UI/后台静态契约），`tests/must-achieve.test.ts` 补静态断言。重建 dist 后全量 **85 文件 / 1243 例通过**
- **岗位名称搜索词「空格填法」修复（用户反馈「刚填了 `php开发 后端开发 AI 全栈开发`，不知道是否有效果」）**：核实链路为 `设置 → 岗位名称` → `filterJobTitles` → `extractSearchKeywords` → `getNextSearchKeyword` 轮转 → `ensurePlatformTab(platform, keyword, page)` → 五平台搜索 URL 带 query；精投 / 海投共用同一份关键词，启动后 1 秒即开始第一轮补仓。但按旧界面提示用空格填会拆出孤立的 `AI`，占一轮轮转去搜回大量非 PHP 后端岗位。现：① 泛词 + 职位词补成 `AI 全栈开发` 组合词；② 所有来源（岗位名称 / 工作经历 / 简历技能）统一清除孤立 `AI` / `大模型` / `智能体` / `Agent` 等泛词，PHP / Laravel / AI开发 等真实职位词不受影响；③ 启动时把「岗位名称 → 解析出的 N 个搜索词」直接写进行为日志，不用等日志滚到补仓轮；④ 界面提示改为与后台一致的「多个岗位名用逗号或顿号分隔」
- **回归测试**：`tests/job-discovery.test.ts` +7 例（用户原填法、组合词、逗号写法、技术栈词不误杀、简历来源泛词、启动日志与导航静态契约、界面提示），`tests/search-direction.test.ts` 旧断言由「拆出 `AI` 是对的」改为锁正确行为。重建 dist 后全量 **85 文件 / 1240 例通过**
- **平台验证状态诚实标注（用户反馈「Boss直聘、猎聘两个平台测试使用了，其他还需要测试」）**：README 简介与 D 层表格区分「真实账号实测」与「仅模拟页面 E2E」，新增**待真实账号验收清单**（6 步：登录注入侧栏 → 扫描诊断数字 → 卡片字段与稳定 ID → 半自动沟通 1 个 → 到平台聊天列表核对 → 翻第 2 页），避免把「适配 5 平台」误读成「5 平台都真实测过」
- **待验证平台适配层契约测试**：新增 `tests/platform-verification-parity.test.ts`（13 例），覆盖 51job / 智联 / 脉脉的注册与 URL 识别不串站、接口 / 风控文案 / 配额完整性、搜索 URL 带 query 与页码、列表解析字段与不重复入队、岗位 ID 稳定性、投递确认层统一链路。明确声明这只证明适配层正确，不能替代真实账号验收
- **修复岗位 ID 不稳定会重复投递**：`51job` / `zhaopin` 在卡片既无详情链接也无 `data-jobid` 时用 `String(Date.now())` 兜底，站点改版后每轮解析都生成新 ID，历史去重键全部失效、同一岗位反复入队。改用 Boss 已有的 `generateJobId(url, '公司:标题')` 生成稳定哈希兜底
- **回归验证**：重建 dist 后全量 **85 文件 / 1233 例通过**（含 Chromium E2E，`multi-platform-flow.test.ts` 三个模拟平台流程无回归）
- **项目简介全面更新（README / package.json / manifest.json）**：旧文案还停留在「支持 Boss直聘、猎聘两个平台」，现统一为 5 平台 + AI 简历画像 / 语义评分 + Tool-Calling 中控 Agent + 精投/海投双模式 + 目标必达。README 新增「📌 项目简介」章节，明确写出「启动前必须自己选半自动/全自动，全自动再选精投/海投」「只认平台确认投递数」「后台静默不抢焦点」「数据留在浏览器本地」
- **目标必达模式（产品语义变更：「设定了目标必须要成功，哪怕是海投」）**：`CapacityGoal` 新增 `mustAchieve`，默认开启、老数据缺字段按开启处理；UI 折叠组新增「必达模式」开关，首屏显示「必达 · 未达成不停机」，关闭后回到旧的截止节奏语义。设定目标不再接受「不保证达标」的结论
- **自动接管所有可控参数**：新增 `src/shared/agent/must-achieve.ts` 纯函数底座（`planMustAchieveQuotas` / `relaxFiltersForMustAchieve` / `shouldBypassWorkWindow` / `resolveMustAchieveMatchThreshold` / `shouldBypassRelevanceGate` / `shouldKeepCollectingOnNoSource` / `shouldMarkKeywordInvalid` / `resolveCollectMaxJobs`）。后台 `applyMustAchieveTakeover()` 在启动与运行中改目标时自动切海投、抬配额（目标 +25% 至少 10 份余量，只升不降）、开启全部平台、解除日限标记、清掉 24 小时无效关键词锁、清掉遗留休息状态
- **达成才停机**：`isCampaignFinished()` 在必达目标未达成时恒为 `false`；超时只报进度事实、不再返回 `missed`；工作时段自动临时放行（不改写用户设置）；全程跳过模拟休息、锁定 30 秒高频补仓；`activePlatforms=0` 时按 10 分钟持久化冷却解除标记继续换平台。只有平台已确认投递数达标才显式停机 + 通知
- **执行层门槛彻底放开**：必达模式下本地匹配分门槛降到 0（只排序不否决）、活跃时间临时放宽到「不限时间」、本地语义硬闸门降级、每平台采集上限提到 50；技术栈 / 岗位方向 / 黑名单硬约束仍保留，不为了凑数乱投前端或 Java
- **风险例外诚实留痕**：验证码不再整体停机 —— 该平台临时标耗尽、其余平台继续投递、任务标 `skipped` 待冷却后回收；账号受限仍保留安全熔断，日志明确写明这是唯一例外且目标不会记为成功
- **回归测试**：新增 `tests/must-achieve.test.ts`（25 例：配额规划与幂等、上限不压小已有配额、工作时段 / 采集 / 门槛 / 关键词锁、`isCampaignFinished` 真实行为、`clearPlatformExhausted` 落盘、全链路接线静态契约），并更新 `tests/capacity-goal.test.ts`（+6 例必达语义）与 `tests/capacity-delivery-loop.test.ts` 静态契约。测试总量 1189 → 1220（83 → 84 文件），`tsc` 0 error、`eslint` 0 error、全量 E2E 通过
- **纯函数缺陷修正**：`planMustAchieveQuotas()` 的单平台上限只约束新分摊值，不再把用户已设的更高配额压小（必达是接管加码，不是覆盖配置）
- **目标产能闭环（现场日志「设了目标却一个都投不出去」）**：`capacityUrgent` 成为贯穿调度、补仓、执行层的统一开关，`isCapacityUrgent()` / `CAPACITY_PRIORITY_THRESHOLD` / `hasWindowConflict()` / `checkCapacityWindowFit()` / `countUsableMinutesUntil()` 均为可单测纯函数；`blocked` 状态表示「墙钟还有时间、实际 0 分钟可投」
- **设定时预检 + 一键放行**：`setCapacityGoal` 立即算目标窗口内的有效工时，冲突就日志 + 通知告警；首屏目标产能卡片提供「解除时段限制并继续」，直接写 `saveTimeWindows` + `UPDATE_CAMPAIGN_WINDOWS` + 唤醒后台（折叠组里的「24小时不限」仍只是填表单，文案不再谎称一键生效）
- **诊断口径归真**：采集层回传 `dedupedOnPage` / `truncatedByCap` / `tasksProduced` / `duplicatesAtAppend` / `filteredOther`，「本轮未新增岗位」日志能区分「筛选没过」与「过了筛选但被历史去重挡下」；`CampaignStats` 透传 `windows`，面板与后台用同一份时段算可达性
- **回归测试**：新增 `tests/capacity-delivery-loop.test.ts`（24 例）。测试总量 1165 → 1189（82 → 83 文件）
- **目标产能「N 小时投满 M 份」**：新增 `src/shared/agent/capacity-goal.ts`（`evaluateCapacityGoal` / `resolvePacingInterval` / `describeCapacityStatus`）。可设 1-24 小时（0.5 步进）与 1-500 份；首屏常驻进度条显示已投/目标、距截止剩余时间、每份最多可花秒数
- **自动调速**：按剩余时间/剩余份数压缩拟人间隔（**最低 8 秒**防风控）；`at-risk` 时自动跳过模拟真人休息。赶不上时每 10 分钟给可操作建议，到点未达成一次性诊断通知，不会静默
- **倒计时持久化**：目标与 `startedAt` 写进本轮 campaign（`persistCapacityGoal`，与日志共用串行链）；参数不变则暂停 / SW 重启不重置，改参数才重新计时。`SET_CAPACITY_GOAL` 路由支持运行中即时修改
- **旧版诚实边界（已被上方「目标必达模式」取代）**：只统计平台已确认投递数；当时的定位是「截止节奏管理」而非保证达标，目标超过已开启平台配额合计时提示先调高配额。现在配额会被必达模式自动抬高，超时不停机，但「只认平台确认、不虚报成功」这条底线不变
- **回归测试**：新增 `tests/capacity-goal.test.ts`（23 例：归一化边界、五种状态、预测与调速下限、倒计时持久化、并发写入、静态契约）。测试总量 1142 → 1165（81 → 82 文件）
- **休息状态机**：新增 `src/shared/agent/rest-policy.ts`（`decideRest` / `resolveRestPolicy` / `pickRestThreshold` / `pickRestDurationMs` / `estimateRemainingMs`）。休息批次与时长跟随投递策略：精投连投 15-25 份休 8-20 分钟，海投连投 30-45 份只休 3-6 分钟；阈值一次生成后持久化，不再每 tick 重随机
- **原子落盘**：`queue-store.ts` 新增 `persistRestState()`，与 `appendCampaignLog` 共用串行写入链；`Campaign` 新增 `restThreshold`。休息到期返回 `resume` 后**本轮立即继续投递**，休息中日志按 10 分钟节流
- **用户出口**：AIbot「复盘与维护工具」新增「模拟真人作息休息」开关（`aibotRestEnabled`，默认开）；休息提示条新增「立即继续」按钮与 `SKIP_REST` 后台路由，关开关时自动唤醒。首屏「已成功投递」显示合计目标，休息 / 休眠 / 空转诊断日志都带「今日已确认投递 X/Y」与「未计入配额的失败尝试 N 次」
- **升级迁移**：旧 campaign 补写阈值时把死锁期间累积的连投计数一并归零，避免升级后第一次 tick 立刻又休息十几分钟
- **回归测试**：新增 `tests/campaign-rest-policy.test.ts`（26 例：深拷贝 storage 真实复现旧死锁、原子落盘与并发、阈值/时长边界、状态机六种决策、升级迁移、静态契约）。测试总量 1116 → 1142（80 → 81 文件）
- **后台静默运行**：新增 `src/shared/agent/stealth-mode.ts`（`shouldActivateTab` / `pickStealthTab` / `pickForegroundTab` / `isProtectedTab`）与设置 `aibotForegroundMode`（默认 `false`）。AIbot 默认只在专用**非活跃**标签页里采集 / 投递，不激活标签页、不聚焦窗口、不导航用户当前页面
- **专用后台标签页**：`aibot_dedicated_tabs` 按平台记住后台 tab，避免每轮新建；终止 AIbot 时 `releaseDedicatedTabs()` 回收，用户已点开的标签页一律保留。启动日志写明运行模式，登录失效时后台打开登录页 + 通知，不打断手上的事
- **前台可见模式开关**：AIbot →「复盘与维护工具」提供显式开关，首屏队列说明同步显示当前模式；仅当浏览器对后台标签页节流导致采不到岗位时临时打开排查。用户主动点击图标 / 打开平台 / 展开侧栏仍按意图激活，不受影响
- **回归测试**：新增 `tests/stealth-mode.test.ts`（26 例：模式决策、多窗口活跃页排除、专用 tab 优先级与让位、前台兼容、tab-manager 激活调用被模式开关包住、UI 开关与回收留痕）。测试总量 1090 → 1116（79 → 80 文件）
- **技术栈硬约束**：新增 `src/shared/agent/stack-guard.ts`（`extractTargetStacks` / `isCrossStackJob` / `detectTechStacks`）。方向里明确写了 PHP 时，「Java开发」「前端开发」「Golang后端」一律硬否决；通用「后端开发工程师」不带栈照常放行。技能清单只用于补主语言栈，避免「熟悉 Vue」把前端算成求职方向
- **搜索词来源扩充**：`extractSearchKeywords` 接入简历 `structuredData.skills`、项目 `technologies`、画像 `skillLevels` 与一句话画像中的标准职位名；用户填的方向仍优先
- **方向可见性**：采集日志写明本轮搜索词 + 来源（设置里的「岗位名称」/ 简历技能）+ 目标方向 + 「技术栈约束【PHP】已生效：剔除 N 个不对口岗位」；浮窗扫描文案显示 `限 PHP`
- **回归测试**：新增 `tests/search-direction.test.ts`（19 例：空格拆词、简历技能来源、无词不猜通用词、跨栈否决、精投本地语义闸门、五平台搜索 URL、静态契约）。测试总量 1071 → 1090（78 → 79 文件）
- **投递确认层**：新增 `src/shared/agent/apply-verification.ts`，`decideApplyVerification()` 把「点了按钮」与「平台确认」严格分开。只有新增确认文案 / 新沟通窗口 / 已发送话术 / 跳进聊天页才判 `confirmed`；点击前文案作为基线排除旧状态；「请先登录 / 安全验证 / 日限 / 职位下线」等阻断文案优先级最高
- **未确认的诚实降级**：判 `unverified` 时**不写投递记录、不加入去重、不计入配额、不写 L3 事件**，日志 + 浮窗 + 诊断中心明确提示去平台聊天列表核对；后台连续 3 次未确认会单独告警，提示检查登录态 / 风控 / 页面改版
- **行为日志跨轮次归档**：新增 `campaign_log_history_v1`（上限 2000 条）与本轮 500 条上限；日志条目带 `date` 与 `campaignId`；日志终端新增「全部历史 / 只看本轮」与「回到最新」
- **回归测试**：新增 `tests/apply-verification.test.ts`（21 例：点击无变化 → 未确认、基线旧文案不算证据、阻断优先、四种确认信号、页面文案采集跳过隐藏节点、三条链路「先确认再落盘」静态契约）与 `tests/campaign-log-history.test.ts`（6 例：日期与轮次、归档上限、跨轮次保留、清空隔离、并发写入不丢）。测试总量 1044 → 1071（76 → 78 文件）
- **侧栏形态决策单一真源**：`assistant-entry.ts` 新增纯函数 `resolvePanelPresence(current, ensureExpanded)`，区分「点图标切换展开 ⇄ 浮球」与「兜底路径只确保展开」；`tests/assistant-entry.test.ts` 扩到 22 例（新增 `job-site-sidebar` 编排、非招聘网站不注入、独立面板只作为最后兜底、静态链路契约）。测试总量 1038 → 1044
- **分层收纳底座**：新增 `src/components/ui/disclosure.tsx`（`type="button"` + `aria-expanded` + 默认收起 + 无 emoji / 渐变 / 循环动效）。首屏只回答「现在做什么 / 现在怎么样了」，低频设置全部可展开，**功能一个不删**
- **回归测试**：新增 `tests/popup-information-architecture.test.ts`（17 例：Disclosure 无障碍契约 / 标签成对闭合 / AIbot 至少 15 个控件折叠、管家至少 10 个 / E2E 关键文案必须在深度 0 / 低频按钮按事件处理器定位必须在深度 > 0 / 功能文案一个没删 / 行为日志默认展开 / 概览与外壳去冗余）。测试总量 1021 → 1038（75 → 76 文件）

- **unslop 设计底座**：`tailwind.config.js` 收敛为一条冷调石墨中性 ramp + 唯一 accent `#C2410C`（旧 `primary` / `brand` 兼容别名全部指向新值，零散引用不会退化成透明文字）；`globals.css` 重写组件类，去掉毛玻璃 / 渐变 / 发光，新增 `:focus-visible` 统一焦点环、数字 `tabular-nums` 与签名刻度线 `.queue-rule` / `.queue-rule-fill`
- **签名细节**：2px 队列进度刻度线落地在 `CampaignPanel.tsx`（AIbot 各平台配额进度）、`BatchControlCard.tsx`（批量沟通进度）与 `components/ui/progress.tsx`，颜色只在这条线与关键数字上出现
- **回归测试**：新增 `tests/unslop-design-tokens.test.ts`（8 例：单 accent 色板 / 组件类无 slop / 界面无 emoji 图标 / 最小 12px 与字重上限 / 无渐变与毛玻璃 / 无循环动效 / 签名刻度线落地 / 注入侧栏收敛），把设计方向固化成静态契约

- **侧栏正文 = 完整助手面板**：侧栏不再自绘「投递监控 / 管家中控」精简界面，改为同源 iframe 内嵌 `src/popup/index.html`，把概览 / AIbot / 管家 / 简历 / 追踪 / 设置原样搬进整高侧栏。应用检测 `window.self !== window.top` 后加 `app-embedded` 类铺满宽高；`web_accessible_resources` 放行 popup HTML 与 `assets/*`；旧内联正文移入隐藏容器 `#panel-legacy` 以保住既有消息链路
- **概览批量沟通控制台**：新增 `src/popup/components/BatchControlCard.tsx`，替换与「追踪」页重复的「最近投递」。展示实时状态 / 进度条 / 匹配推荐 / 今日剩余额度 / 投递模式 / AI 评分 / 开始停止 / 最近 3 条匹配结果；进度由 content 在扫描、匹配、沟通各阶段经 `runtime-state` 上报
- **全局运行状态与互斥锁**：新增 `src/shared/runtime-state.ts`（`setting_runtimeState` 单一真源）。`RunMode = idle | manual | autopilot`，由 background 原子仲裁 `RUNTIME_ACQUIRE / RELEASE / PATCH / GET`。概览半自动与 AIbot 全自动绝不并行：冲突时启动按钮禁用 + toast 提示，content 在 `EXECUTE_APPLY` / `EXECUTE_CAMPAIGN_TASK` 入口再做一次冲突拦截
- **陈旧锁兜底**：运行时锁带 `startedAt`，超过 2 小时视为陈旧可抢占，避免刷新 / 崩溃后永久锁死
- **筛选条件单一真源**：新增 `src/shared/agent/filter-config.ts`（`loadSharedApplyFilters` / `persistSharedFilters`）。概览与 AIbot 全自动流水线读同一批设置键；AI 评分开关以 `setting_enableAiMatch` 为准、旧 `filterEnableAiMatch` 作回退并双写兼容
- **回归测试**：新增 `tests/runtime-state.test.ts`（18 例：默认值 / 冲突仲裁 / 幂等 / 陈旧锁 / 进度上报 / 订阅）、`tests/shared-filters.test.ts`（8 例：全字段读取 / 评分开关与最低分 / 旧键回退 / 写后即读）与 `tests/assistant-entry.test.ts`（16 例：可注入判定 / 决策 / 标签页复用 / 编排，明确断言「绝不打开后台」）
- **入口决策单一真源**：新增 `src/shared/assistant-entry.ts`（`canHostSidebar` / `planAssistantEntry` / `runAssistantEntry` / `findJobSiteTabId` / `findAssistantTabId`），把「点图标该去哪」从 background 里抽成可单测的纯函数
- **独立助手面板**：popup 新增 `?standalone=1` 标签页形态（`body.app-standalone` 居中留白），顶部提示 + 右上角「展开侧栏」按钮；background 用 `focusOrCreateAssistantPanel()` 复用已开面板，不重复开标签页
- **后台页回家按钮**：`src/options/App.tsx` 左侧栏顶部新增「返回助手侧栏」与「打开独立助手面板」
- **智能中控对话台 Tool-Calling 引擎（B 计划）**：新增 `src/shared/agent/butler/chat-engine.ts`，用 AI SDK 7 `generateText + tools + stepCountIs(5)` 把 46 个扩展内部工具交给模型自动多步调用；系统提示词明令「涉及具体数字必须先查真实数据」，60 秒缓存的真实数据快照（战报 / 投递统计 / 错误日志）让开放问题也有据可依
- **三级容错链与可见降级**：原生 function calling → 结构化 JSON 工具协议 → 旧规则引擎离线兜底；AI 未配置 / 请求失败 / 预算耗尽都在 UI 显示模式徽章 + 黄色原因提示，不再静默假装 AI 在工作
- **多轮上下文与历史持久化**：最多 12 轮写入 `butler_chat_history_v1`，重开面板自动恢复；`buildNextHistory` / `parseJsonFallbackResponse` 等纯函数可直接单测
- **回归测试**：新增 `tests/butler-chat-engine.test.ts`（18 例：工具清单 / JSON 协议 / 历史裁剪 / 数据快照缓存 / Agent 主路径 / 多轮上下文 / 危险审批重放 / 三层降级 / 历史持久化 / AI SDK 真实集成冒烟 / 预算护栏 / 异常留痕闭环）
- **跨上下文统一异常留痕**：新增 `src/shared/db/error-report.ts` 的 `reportError()`，把 content / popup / options / iframe 侧栏 / background 的错误上报收敛到 `RECORD_ERROR` → background 写扩展域 `db.errors`；转发失败写 `chrome.storage.local` 共享队列（`shared_error_queue_v1`），再不行才回退本地 Dexie。`error-store.ts` 的 `listErrors / getErrorCount / clearErrors` 合并读取两处并按 id 去重
- **对话台全链路留痕**：AI 未配置 / 预算耗尽 / 主路径失败 / JSON 兜底切换或失败 / 最终离线 / 工具执行失败 / 审批重放失败 / 历史写入失败 / 快照探针失败，全部写入诊断中心（60 秒同因去重）；同时同步 `ai_last_failure` 标记让 AIbot 日志可见，主路径成功自动清除旧标记
- **回归测试**：新增 `tests/error-report.test.ts`（10 例：转发成功不双写 / 转发抛错或 success:false 的兜底 / storage 不可用回退 Dexie / 并发写入不互相覆盖 / 去重 / 脏载荷 / 合并读取 / 清空 / 脏共享数据）

### Changed

- **搜索词按空格拆**：`splitKeywordTokens` 现在按标点 + 空格切词，「php 后台开发 / AI 全栈开发」变成 `php`、`后台开发`、`AI`、`全栈开发` 等可搜短词，原始短词组保留在队尾作更精准尝试
- **无关键词时不再替用户猜方向**：删除硬编码 `['全栈工程师','前端开发工程师','后端开发工程师','技术经理']` 兜底；`getNextSearchKeyword` 返回 `reason: 'no_keywords' | 'all_invalid'`，后台对 `no_keywords` 只提示去「设置 → 岗位名称」填写且**保持 running**（填好下一轮自动恢复），`all_invalid` 才暂停
- **精投方向闸门收紧**：`relaxCareerFilter` 不再把 `targetCareers` 清空（只放宽同义匹配严格度）；本地语义判定在精投下升级为硬闸门；语义不相关的岗位不能靠软过滤补足名额回到队列；`evaluateJobCandidate` 新增 `targetStacks` 硬过滤且不带 `soft`
- **AI 语义复核与半自动同步约束**：`computeLocalRelevance` 先执行跨栈否决再谈后端同义族谱；AI prompt 不再把「Java 后台」当后端同义例子，改为明确列出目标技术栈；半自动 `filterJobs` 只按用户明确填的岗位名称做跨栈否决
- **脉脉搜索 URL 带上 query**：原来 `getPlatformSearchUrl('maimai', …)` 忽略关键词，永远停在推荐流
- **三条投递链路全部先确认再落盘**：全自动 AIbot（`content/task-runner.ts`）、半自动批量沟通与 AI 自动确认（`content/index.ts`）都采集点击前基线 / 点击后文案 / 话术发送结果，交给确认层判定；`fillGreetingMessage()` 的返回值不再被丢弃，「没有 textarea 也不阻断」的旧假设删除。后台 `campaign-service.ts` 只在 `done` 时写 L3「已投递」事件，成功日志带上平台确认依据
- **行为日志不再抢滚动条**：容器 `h-36 → h-64`，`onScroll` 检测是否贴底，往上翻看历史时暂停自动跟随（原来每 2 秒无条件 `scrollTop = scrollHeight`）；日志写入改串行链，避免并发覆盖
- **点击图标的兜底从「独立整页面板」改为「去招聘网站展开右侧侧栏」**：`planAssistantEntry` 现在要求「可注入 + 当前就是招聘网站」才走 `try-sidebar`；新标签页 / 任意普通网页 / `chrome://` / 扩展页 / 注入失败，一律由 `openJobSiteWithSidebar()` 激活已有招聘网站标签页（没有则新开平台首页）并展开侧栏。`?standalone=1` 只在两条路都失败时才兜底，管理后台仍绝不作为兜底
- **动态注入改轮询**：`sendPanelAction()` 统一封装消息发送，注入 crxjs loader 后最多轮询 5 次 × 250ms 等消息端就绪，替代固定 300ms；`openJobSiteWithSidebar` 对已有招聘网站标签页补发 `ensureExpanded: true`，避免与写入的 `expanded` 状态打架把侧栏收成浮球；新增失败时返回 `false` 让编排能继续兜底
- **文档同步**：README 的 F 层入口表、测试徽章 1038 → 1044、更新日志；CHANGELOG 补 Added / Changed / Fixed

- **常驻头部与概览首屏**：`App.tsx` 一行放完品牌 + 平台状态 + 导航，平台名只在下拉里出现一次（删掉重复的平台徽章、副标题与「未检测到招聘平台页面」提示）；`PlatformShortcuts.tsx` 的 5 个平台直达卡收进「打开平台」，同时移除品牌色映射与 hover 位移；`Dashboard.tsx` 的 5 个独立统计卡合并成一行紧凑数字；`BatchControlCard.tsx` 的「投递模式 / AI 评分」收进「更多设置」，开跑按钮仍常驻
- **AIbot 面板重排**：把「一键开跑 / 暂停 / 恢复 / 终止」从页面底部上移到指标看板正下方；「复盘与维护工具」收纳管家跳转、清空重获、立即补仓、恢复默认配额、刷新授权；「平台与配额」收纳 5 个平台开关 / 授权 / 配额输入；「悬浮窗配置」收纳 10 个模式与形态开关。「全自主无人值守队列 / 免手动」说明条与行为日志保持常驻；时段 / 间歇 / 投递方式三个入口移到编辑器正上方，展开后不用反向滚动
- **管家页重排**：二级导航由 6 个入口收敛为「对话中控 / 跟进与留痕 / 异常留痕」+「更多视图」（管家日报 / 策略进化 / 待修清单），计数改到折叠提示里；日报明细、闭环说明、提案筛选、诊断维护、来源筛选、导出刷新各自折叠。按钮 className 抽成 `navButton()` 消除 6 段重复
- **文档同步**：README 新增「信息架构 · 分层收纳」章节、测试数量 1021 → 1038、更新日志；CHANGELOG 补齐 Added / Changed / Fixed

- **九道 pass 全量精修**：35 个界面文件按 Spacing → Color → Icons → Copy → Type → Layout → Details → Visuals → Motion 顺序收敛；26 个文件 830 行样式类批量替换，界面 emoji 装饰清零（日志 / 通知文本前缀保留，避免破坏既有测试断言）
- **基础组件重写**：`button / card / badge / progress / toast / dialog / tabs` 统一为近黑主按钮、中性 hairline、方角标签与语义色文字；删除 `active:scale-95`、`hover:shadow-glow`、`transition-all`、`font-bold`、9–11px 小字
- **页面注入侧栏同步**：`inject-ui.tsx` 的 shadow DOM 内联 CSS 去掉橙绿渐变、彩色发光、`backdrop-filter` 与 `pulse` 循环，头部改中性深色；`content/index.css` 的岗位徽章改纯色方角。旧 `glass-card` / `glass-panel` 类名重命名为 `surface-card` / `surface-panel`
- **文案收敛**：对话台欢迎语改为事实描述，去掉问候语与感叹号；popup 副标题改为「岗位匹配 · 多平台投递 · 回复复盘」（避开与「追踪」Tab 同名）
- **文档同步**：README 新增「UI 设计方向 · unslop」章节、测试徽章 1013 → 1021（75 文件）、技术栈与测试命令、更新日志；按 CC BY 4.0 保留 Damir Sokolovsky ([@heydamir](https://x.com/heydamir)) 与仓库链接署名

- **对话台 UI 重写**：`ButlerChatView.tsx` 改为 markdown 渲染 + 工具执行轨迹（可展开）+ 模式徽章 + 降级提示 + 审批卡；审批确认 / 取消后立即移除卡片并禁用按钮，杜绝危险动作被重复点击执行
- **后台工具执行新增独立门禁**：`external-ai-rpc.ts` 增加 `executeToolForButler()`，`background/index.ts` 新增 `BUTLER_EXEC_TOOL_MSG` 路由，仅接受扩展自身上下文；保留参数校验并对 `dangerous` 强制 `confirm=true`，与外部 AI 的 fail-closed 总开关互不绕过
- **依赖与权限**：新增 `ai@7` / `@ai-sdk/openai-compatible@3` / `zod@4` / `react-markdown@10` / `remark-gfm@4`；`manifest.json` 的 `host_permissions` 增加 DeepSeek / OpenAI / DashScope / Moonshot / 智谱接口域名
- **对话台纳入成本护栏**：新引擎调用同样计入每日 AI 预算，预算耗尽直接提示并回退本地规则
- **错误上报单一真源**：`api-client.ts` 的 7 个失败点、`action-simulator.ts` 的 `recordSelfHealingEvent`、`ButlerChatView.tsx` 的两处 UI catch 全部改走 `reportError()`；页面域不再双写，避免一条异常记两次或只记在看不到的库里
- **后台门禁加固**：`RECORD_ERROR` 路由校验 `source/message` 类型、拒绝非扩展来源，脏 payload 不会让 `.slice` 抛错；`BUTLER_EXEC_TOOL` 路由改为严格 `sender.id === chrome.runtime.id`；`executeToolForButler()` 的工具失败写入 `butler.tool` 留痕且**不记录 args**（可能含简历正文）
- **诊断中心升级**：管家「异常留痕」新增「对话台」筛选与 `butler.*` 来源徽章；对话台降级提示明确写出「异常已写入异常留痕」，并把第二层兜底失败原因合并进同一条提示
- **数据快照提速**：`buildContextSnapshot()` 三个只读探针由串行改为 `Promise.all` 并发，不再把每轮对话拖慢 3 次 RPC
- **文档同步**：README 新增「智能中控对话台」与「异常留痕 · 跨上下文统一诊断」章节、测试徽章 985 → 1013（74 文件）、功能全景与技术栈、使用流程第 8 步、更新日志；项目结构补充 `butler/`
- **去掉小浮窗**：`PanelState` 收敛为 `expanded | bubble | collapsed | closed`，删除 `floating`、`FLOATING_WIDTH/HEIGHT`、`applyFloatingLayout()`、`detachSidebarToFloating()`、拖动脱离与视口夹取逻辑。现在是「整高侧栏 ⇄ 半圆浮球」两态，侧栏固定贴右侧不可拖动；历史残留 `floating` 归一为 `expanded`
- **AIbot 流水线不再硬编码评分配置**：`campaign-service.ts` 的 `enableAiMatch: true` / `minMatchScore: 60` 改为 `loadSharedApplyFilters()`，概览改筛选后全自动补仓立即生效
- **AI 评分开关双向同步**：概览筛选面板、批量沟通控制台、AIbot 配置页三处改动都会写同一份共享配置；任一侧改动，其他侧经 `storage.onChanged` 实时刷新
- **暂停/恢复参与互斥**：`PAUSE_CAMPAIGN` 让出 autopilot 锁（可切到概览跑半自动），`RESUME_CAMPAIGN` 重新申请锁并在半自动运行时拒绝；campaign 自然完成 / 中止 / 异常也释放锁
- **开跑 AIbot 保持侧栏展开**：`START_CAMPAIGN` / `RESUME_CAMPAIGN` 不再把面板收起成浮球——侧栏正文含实时行为日志，收起会让用户看不到运行过程
- **关闭链路统一**：`shutdownAssistant()` 释放所有运行锁；`APPLY_ENDED` 与 content 收尾双重释放（幂等），不会误清对方状态
- **概览头部去冗余**：移除概览页第二层标题「求职助手 / {平台} · 智能投递」与顶部「开始沟通 / 停止」按钮（App 全局头部已有品牌名与平台徽章）。启动入口从三处收敛为两处：「沟通筛选条件」的「开始智能沟通」与「批量沟通控制台」的「开始批量沟通（半自动）」；同时删掉与控制台重复的那条 AIbot 互斥提示，只保留控制台一条。`Dashboard` 不再接收 `platformName` prop
- **文案与文档**：概览筛选卡片与 AIbot 配置页各加「配置共用」说明；README F 层、快速开始、本 CHANGELOG、实施计划同步到最终形态；`CampaignPanel` 面板形态改为「整高侧栏 / 半圆浮球 / 停止」并修正残留的「还原成小浮窗」文案

### Fixed

- **「设了目标产能却一个都投不出去」· 页码游标死锁**：`autoCollectJobsForCampaign` 旧版只在 `collected === 0 && excludedOnPage > 0` 时翻页；现场「抓到 75 张卡、语义对口 35 个、added=0」永远停在第 1 页。现在主补仓路径零新增即翻页（1→5 循环回第 1 页），步骤 8 的机会性预取不抢游标
- **「设了目标产能却一个都投不出去」· 历史任务永久占去重键**：`appendTasksToCampaign` 只回收过冷却期的 `skipped`，`failed` 一律不回收（可能已在平台侧建立沟通，重试会造成重复打招呼）；`isRecyclableTask` 带 `MAX_TASK_RECYCLES=3` 上限并透传 `attempts`。目标产能落后时后台把冷却设为 0 立即重评
- **「设了目标产能却一个都投不出去」· 本地评分量纲误杀**：「高级php工程师」30 分被 33 分门槛（60×0.55）跳过。产能优先时门槛降到 20 分下限，`capacityUrgent` 经 `EXECUTE_CAMPAIGN_TASK` 下发到 `task-runner` 并留痕；投递成功后降档只回退一档，不再清零造成门槛震荡
- **「不在投递时段」日志重复两次**：去重标记从模块内存迁到 `aibot_last_window_sleep_log_at`（`chrome.storage.local`），Service Worker 回收后不再每个 5 分钟切片重复打一条；进入允许时段时清标记，下次休眠仍能立刻提示
- **目标产能与工作时段冲突被静默吞掉**：新增 `blocked` 状态与 `countUsableMinutesUntil()`（只算允许时段内的分钟），设定目标时立即预检并告警；面板与统计层共用 `CampaignStats.windows`。休眠日志不再谎称「一键设为【24小时不限】立即唤醒」
- **误导性日志与空转降频**：`at-risk` / `blocked` 锁定 30 秒高频补仓不再退避到 5 分钟；间隔未被压缩时不再声称「已按剩余时间压缩间隔」，改为写明「真正卡住产出的是岗位供给与投递门槛」；零新增诊断把 `maxJobs*2` 截断数与真实去重数分开
- **「模拟真人作息休息 12 分钟，投了一天还没投满 80」（P0 死锁）**：休息分支只在内存写 `campaign.restUntil` / `consecutiveRestCounter = 0`，随后 `appendCampaignLog()` 从 storage 读旧副本整份写回，状态修改被覆盖 —— `restUntil` 从未落盘、连投计数从未清零。结果每个 5 分钟切片 tick 都重新触发一次休息，AIbot 永久卡在休息循环里，配额永远投不满。现全部走 `persistRestState()` 原子落盘；同时修掉阈值每 tick 重随机、休息节奏与精投/海投脱钩（海投投 10 分钟却休 14 分钟）、休息日志刷屏、到期后还要空跑一整轮、用户没有「立刻继续」出口
- **「打开别的软件 / 切换页面 / 下滑，Chrome 都被拉回招聘网站」**：`ensurePlatformTab()` 每个投递任务与每轮补仓都无条件 `tabs.update({active:true})` + `windows.update({focused:true})`，还优先复用**当前活跃标签页**并导航到搜索 URL。现默认后台静默：排除所有窗口的活跃页、只操作专用后台 tab；激活 / 聚焦调用全部收进 `if (foreground)` 分支，`openPlatformLoginTab()` 同步改为后台打开
- **「岗位名称写了 php 后台开发 / AI 全栈开发却没效果」**：长词组没被拆开、简历技能没参与提取、脉脉搜索 URL 忽略关键词，三层叠加导致平台搜不到结果并降级成推荐流。现按空格拆词 + 简历技能参与 + 五平台都带 query
- **「一个前端、一个 Java 开发，都不对，还是精投」**：旧版本地语义「只统计不否决」+ 后端族谱把 Java 当同义 + `relaxCareerFilter` 清空方向白名单 + 软过滤补足名额，没配 AI Key 的精投等于完全不设防；硬编码兜底词里还含「前端开发工程师」，会真的去搜前端岗位。现四处统一加技术栈硬约束 + 精投本地闸门，跨栈岗位永远进不了队列
- **「显示投递成功，但手机里没有聊天和投递记录」的假阳性**：过去 `clickApplyButton() === true` 就直接落盘 + 去重 + 配额 + 输出成功日志，自愈点击 Tier 3/4 点错相似按钮、弹窗被风控/登录态拦截、半自动链路根本没有招呼语输入框，都会被记成一次成功投递。现改为必须拿到平台侧状态变化证据才记成功；拿不到一律标「未确认」并留痕，不再虚报
- **「行为实时记录不能滑动、不知道之前干了什么」**：日志被自动滚动反复拉回底部、只留本轮 120 条、新一轮 campaign 直接清空、条目无日期、并发写入互相覆盖。现支持自由上翻 + 全部历史归档 + 日期/轮次 + 串行写入
- **点击插件图标弹出独立整页面板，而不是右侧整高侧栏**：旧编排把 `focusOrCreateAssistantPanel()` 当作常规兜底，只要当前标签页不是招聘网站（最常见是新标签页）或注入没赶上，就打开一整个 `?standalone=1` 标签页。现改为优先去招聘网站展开侧栏；同时修掉「固定等 300ms 判定注入失败」的误判。用户感知：点图标永远落在招聘网站右侧侧栏，不再多出一个面板标签页
- **折叠提示文案重复导致 E2E 严格模式冲突**：管家「按来源筛选」的 hint 曾写「共 N 条记录」，与诊断中心标题里的同文案同时被 `getByText(/共 \d+ 条记录/)` 命中，`tests/aibot-browser-e2e.test.ts` 失败。改用来源枚举作为 hint，「导出与刷新」的重复计数提示同步移除；两套受影响的浏览器 E2E 复跑通过
- **副标题与 Tab 同名导致 E2E 严格模式冲突**：精简副标题时曾写入「结果追踪」，使 `getByText('追踪')` 同时匹配副标题与 Tab；改为「回复复盘」后 `tests/extension-flow.test.ts` 12 例恢复全绿

- **页面域异常「留了但看不见」**：content script 直接写 `db.errors` 时落到网页域 IndexedDB，管家诊断中心读扩展域库，永远查不到。现由统一上报入口 + 共享队列 + 合并读取彻底打通
- **同一次降级并发上报互相覆盖**：共享队列的 get-modify-set 不是原子操作，三条并发留痕各自读到旧数组再覆盖，最终只剩一条。现用进程内串行链排队写入，一条不丢
- **带 `dedupeWindowMs` 的错误被二次去重吞掉**：上报层与 `recordError` 各去重一次、命中同一签名，导致 AI HTTP 500 这类错误一条都查不到。现去重只在上报层做一次
- **合并排序破坏原有倒序语义**：相同时间戳内未按主键倒序，导致 `listErrors(10)` 把刚发生的异常挤出首页。现按「时间倒序 + 同毫秒主键倒序」还原 Dexie `orderBy().reverse()` 行为
- **JSON 兜底静默失败**：`chatCompletion()` 返回空串时旧实现直接 `return` 空结果，用户只看到掉到离线却不知道第二层为什么也失败。现抛可读错误并合并进降级提示
- **对话台「怎么问都一样」**：旧版 12 条正则 + 8 个写死动作 + 固定兜底引导，且 `chatCompletion()` 失败时静默返回空串让用户误以为 AI 在工作。现在开放问题由模型结合真实工具数据回答，失败原因全部可见
- **测试模拟与真实后台语义不一致**：`self-healing-button.test.ts` 的 `sendMessage` mock 只返回 `success:true` 却不落库；已改为按 `RECORD_ERROR` 路由真实写入，覆盖统一留痕的新契约
- **模型只调工具不给总结时被误判失败**：`runAiSdkToolLoop` 在 `result.text` 为空但有工具轨迹时，改用真实执行轨迹生成兜底回复，不再一路降级到离线固定文案
- **审批卡可被重复点击**：确认或取消后立即从消息中移除审批卡并在执行期间禁用按钮，避免危险工具（如清空数据）被重复执行
- **点击插件图标不再跳进管理后台、后台也不再「回不来」**：旧 `chrome.action.onClicked` 在注入侧栏失败时无条件 `chrome.tabs.create(src/options/index.html)`；而后台页是 `chrome-extension://`，content script 永远注入不进去，于是再点图标又开一个后台页，形成死循环，且后台页没有任何返回助手的入口。现改为 `runAssistantEntry()` 统一编排：扩展页 / 受限页连注入都不尝试，直接打开或复用独立助手面板；普通 http(s) 页注入失败也回退到助手面板；`OPEN_ASSISTANT_SIDEBAR` 失败时回退到「去招聘网站展开侧栏」。显式 `OPEN_OPTIONS`（设置按钮）保留，但不再是任何兜底路径
- **修正文档与注释中的错误描述**：README「受限页退化为打开管理后台」、background 里 `openSidebarInActiveTab` 的同类注释均已改正；独立面板提示语改为指向真正可用的「展开侧栏」按钮

## [1.2.0] — 2026-11-06 · 安全默认、平台配额、自主授权契约与经验记忆

### Added

- **安全阀档位 `safety-preset`**：新增 `src/shared/types/safety-preset.ts`，把「每日上限 / 操作延迟 / 滚动延迟 / 单次扫描 / AI 预算 / 沟通模式」打包为 `保守 / 标准 / 激进` 三档，参数单一真源，禁止各模块再写魔法数字
- **设置页档位选择**：管理后台与弹窗的「防封策略」顶部新增三档按钮，点击整组写入；显示「当前：保守/标准/激进/自定义」；手动改任一项参数自动判定为 `custom`（`detectSafetyProfile`），激进档带红色风险提示
- **首启档位迁移**：`resolveSafetyProfile()`（`src/shared/db/settings-store.ts`）在扩展启动时执行一次——已有档位原样返回；老用户已调过任一节奏参数则标记 `custom`、**不覆盖原值**；完全新装写入 `conservative`
- **配置引导卡片**：新增 `src/components/setup-checklist.tsx`，挂在管理后台仪表盘顶部，实时只读探测「简历 / 大模型 / 平台登录 / 安全阀」完成状态，未完成可一键跳转；同时列出可后置的 4 项（AI 自主权限、通知推送、黑名单、数据导出）
- **弹窗配置顺序提示**：弹窗设置页新增文案版「必配 3 项 + 安全阀，其余可后置」
- **文档**：新增 `docs/CONFIG_GUIDE.md`（配置说明书）、`docs/FEATURES.md`（功能总览）与 `docs/features/01~08`（分功能详解）；README 增加「文档索引」并重写使用流程
- **各平台投递数量可修改（G 层）**：新增 `quota.ts` 平台配额单一真源——`DEFAULT_PLATFORM_QUOTAS`（由推荐安全配额派生）、`normalizePlatformQuotas` 脏数据兜底、`chrome.storage.local` 持久化（`aibot_platform_quotas` 键）、区间限制 1–500；`queue-store.ts` 新增 `updateCampaignQuotas` 即时生效、campaign 领任务时按平台配额过滤、`rate-limiter.ts` 每日风控上限与自定义配额同步；AIbot 配置面板新增各平台投递数量编辑卡片（新增 `tests/platform-quotas.test.ts` 覆盖存储真源 / campaign 即时生效 / 风控同步）
- **声明式自主授权契约（AuthorizationPolicy）**：新增 `src/shared/agent/authorization.ts`——用户在简历页事前编写「事实（简历只读）/ 应答（话题白名单+每日上限）/ 策略（投递授权档、配额上限、匹配门槛、主攻方向白名单、可自动调参项）/ 硬锁」四类授权，运行时 `evaluateAuthorization` 查表判定 `auto / confirm / deny` 替代逐次弹确认；默认 `enabled=false` 未启用时完全回退原有 `permission.ts` 三档逻辑（向后兼容）；fail-closed：未覆盖/超范围/解析失败一律停下问；`updatedAt` 超 14 天自动降级为 confirm；硬锁（改简历事实、绕过风控=deny；offer 决策、薪资谈判=confirm）永不可下放
- **授权接入执行链**：`action-executor.ts` 的 `decidePermission` 前置授权判定（deny→'denied'）；`proposeAction` 把执行上下文映射为结构化动作（apply / send_greeting / browse），send_greeting 的话题白名单用 goal 匹配
- **L3 经验记忆**：新增 `src/shared/types/experience.ts` + `src/shared/db/experience-store.ts`（Dexie v9 新增 `experiences` 表）——AI 归纳的规律性结论必须带 `evidenceIds`、样本 ≥5 才下结论、30 天过期、同 pattern 去重 upsert、用户禁用/删除后 `userOverride` 永不被 AI 覆盖；关键词分词匹配检索（单用户数据量级不引入向量库）
- **单一主脑 Planner**：新增 `src/shared/agent/planner.ts`——`replanIfNeeded` 挂在 campaign tick 流水线（3.5 步，失败静默降级）：读授权契约 + 近 7 天真实复盘 + 相关经验 → 纯规则推导建议（每条过授权判定）→ LLM 只润色总结（缺失降级 `local_rules`）→ 仅在授权 auto 且回复率 <20%、样本 ≥10 时有界下调本轮各平台配额 10%（不低于下限，只动 `campaign.quotas` 可回滚，不动全局设置）；按「日期:任务数档位」节流
- **简历页授权配置 UI**：`CandidatePreferencesCard` 新增「自主授权契约」分区（总开关、投递授权档、配额上限/匹配门槛、主攻方向白名单、可自动调参 chips、应答白名单/禁用话题、硬锁只读展示、最后确认时间）；HR 问答模式补活死枚举第三档「白名单自动发」（`safe_auto_reply`）；卡片标题改为「求职画像 · 底线 · 自主授权」并从设置页迁至简历页（弹窗与管理后台同步迁移，设置页留指向提示）
- **回归测试**：新增 `tests/authorization.test.ts`（14 例：默认关闭回退、硬锁、过期降级、fail-closed、配额/门槛/调参/白名单/上限/facts 只读、proposeAction 映射）、`tests/experience-store.test.ts`（8 例：样本门槛、去重、userOverride 不覆盖、过期、检索、删除）、`tests/planner.test.ts`（8 例：低回复率建议、无授权全 confirm、授权 auto、过期降级、LLM 缺失降级）

- **外部 AI 接入 / MCP（G 层，同期交付）**：新增 `bridge/` 零依赖 Node 桥接服务（`server.mjs` 命令队列 + 长轮询 + SSE + 一次性配对 token、`mcp-stdio.mjs` stdio MCP、`/mcp` Streamable HTTP MCP），`scripts/install.sh` / `install.cmd` 一条龙（构建 → 生成令牌 → 写入 Claude Code / Codex / Cursor / OpenClaw 小龙虾 MCP 配置 → 启动 → `doctor` 体检）
- **统一 RPC 与 47 个工具**：`src/shared/bridge/tools.ts` 定义只读 24 / 写入 15 / 危险 8 的工具清单与参数校验、三级门禁、设置脱敏；`src/background/external-ai-rpc.ts` 复用既有 store 与 `campaignService` 分发；`src/offscreen/bridge.ts` 常驻长连接（background 用 1 分钟 alarm 保活）；设置页新增「外部 AI 接入」卡片（开关、配对、测试、工具清单、一键复制配置）
- **接入安全**：fail-closed 总开关、危险动作默认拒绝且每次需 `confirm=true`、只允许本机回环地址、`/pair` 一次性、background 只接受扩展自身上下文 RPC、`get_settings` 敏感字段脱敏
- **接入测试**：`tests/external-ai-bridge.test.ts`（22 例：清单 / 参数 / 门禁 / 脱敏 / CSV）与 `bridge/test/selftest.mjs`（12 项端到端：配对 → 心跳 → 长轮询 → MCP 与 REST 结果回传）
- **接入文档**：`docs/EXTERNAL_AI.md`、`bridge/README.md`、`bridge/integrations/openclaw-skill.md`

### Changed

- **默认值改为保守档**：`dailyLimit` 10000 → **30**、`minDelay/maxDelay` 2000/8000 → **5000/15000**、`maxScanCount` 50 → **20**、`aiDailyBudget` 50 → **30**、`applyMode` batch → **recommend**
- 兜底值统一取 `CONSERVATIVE_VALUES`：`delay-engine.ts`、`rate-limiter.ts`（日上限兜底 10000→30）、`content/index.ts`（扫描兜底 50→20）、`ai-budget.ts`（预算兜底 50→30）
- `PluginSettings` 新增 `safetyProfile` 字段，`DEFAULT_SETTINGS` 展开保守档参数
- **清除两处硬编码假统计**：`induction-engine.ts` 的 `runInductionAnalysis` 重写——删除「500+ JD / +40.2%」等写死数字，改用 `buildReview()` 真实投递记录统计（样本不足明示「不构成统计结论」），对已存在 pending 提案刷新真实数据；`butler-evolution-store.ts` 三条种子提案的 insight/evidenceStats 改为诚实版（sampleSize:0、liftRate:'待验证'）
- 零回复岗位方向（count≥3 且回复率 0）自动沉淀为 L3 经验供后续降权参考
- `CandidateProfilePreferences` 新增可选 `authorization` 字段，spread merge 读取零迁移；Dexie v8 → v9（新增 `experiences` 表索引）
- 管家演进提案（butler evolution）与自主重规划决策均写入审计日志留痕

### Fixed

- `tests/self-healing-diagnostics.test.ts` 断言 Dexie 版本 8 → 9（新增 experiences 表）
- `tests/butler-evolution.test.ts` 断言改为「真实投递记录」且不再匹配虚构提升率
- `tests/aibot-browser-e2e.test.ts` 「运行中」文案 strict mode 冲突（状态徽标与说明文字同时命中），改为精确匹配

### Validation

- `npx tsc -b`：0 error
- `npm run lint`：0 error（42 warnings，为遗留技术债）
- `CI=1 npx vitest run tests`（单线程串行）：**60 files / 807 tests passed**，含 10 个 `headless:false` 浏览器 E2E 套件（本地双线程并发跑浏览器 E2E 会因 headed Chromium 争抢资源偶发超时，串行稳定全绿）
- `npm run build`：success；`dist/manifest.json` = 1.2.0
- `dist.crx` 以原 `dist.pem` 重新打包为 1.2.0，扩展 ID 保持 `dccklnbklkmobooaeioifidckbgbgjfg`（即 SHA-256(SPKI DER) 前 128 位；更正 1.1.1 记录中 `322abd1a...` 的指纹算法误差，该值非 Chrome 标准扩展 ID 算法所得，实际扩展 ID 一直未变）

## [1.1.1] — 2026-11-05 · 悬浮窗与 AIbot 统一控制

### Added

- **统一控制状态**：新增 `src/shared/assistant-state.ts`，以 `chrome.storage.local` 的 `setting_` 键为单一真源，定义 `PanelState = expanded | collapsed | closed`、`AssistantApplyMode = batch | recommend`，提供 `getAssistantState` / `patchAssistantState`（相同值不写，防回环）/ `subscribeAssistantState`
- **悬浮窗右侧收缩**：`inject-ui.tsx` 新增 `#btn-collapse` 与懒创建 `#edge-handle` 边缘把手，实现三态渲染；AIbot 启动成功时后台写入 `collapsed`，页面浮窗自动贴右侧收缩
- **AIbot 配置页同步**：`CampaignPanel.tsx` 新增「悬浮窗配置」卡片，展示并编辑同一份状态，含投递模式、AI 评分、猎聘简历模式、浮窗形态；`chrome.storage.onChanged` 订阅保证与页面浮窗双向同步
- **关闭链路统一**：新增 `ASSISTANT_CONTROL`（`shutdown` / `patch` / `get`）与 `ASSISTANT_CANCEL` 消息；`shutdownAssistant()` 同时终止 campaign、清 `apply-tick` alarm、写 `panelState: closed`、广播取消
- **任务级取消信号**：`TaskRunnerCallbacks` 增加 `shouldCancel`，`executeCampaignTask` 在任务开始、点击投递前、写库前三处检查，取消时返回「已取消：AIbot 已关闭」，不再继续投递或写库
- **关闭竞态防护**：关闭动作在 content 本地立即置 `runStopped` 与 `assistantState.panelState = 'closed'`，不等 `storage.onChanged` 回传；新增纯函数 `isAssistantTaskCancelled(state, flag)`，即便广播未送达、后台恰好又派发新任务并重置本地标记，只要统一状态仍是 `closed` 就立即取消。bot 重新展开/收缩时自动解除取消标记
- **运行时模式可切**：运行中不再锁定模式 / AI 评分 / 简历模式开关，切换后从下一个任务起生效；`EXECUTE_APPLY` 默认模式由硬编码 `recommend` 改为读取统一状态
- **回归测试**：新增 `tests/assistant-control.test.ts`（10 用例）：默认状态、patch 可读、相同值不重复写、订阅与取消订阅、自愈白名单不误伤浮窗、三态切换，、关闭竞态防护 3 例（本地标记置位 / `closed` 状态兜底 / 展开与收缩不误取消）与关闭状态归一化 1 例

### Changed

- `START_CAMPAIGN` / `RESUME_CAMPAIGN` 成功后不再让浮窗保持展开态，改为写入 `collapsed`
- `ABORT_CAMPAIGN`、popup「终止」、浮窗「关闭」与「停止」全部收敛到同一个 `shutdown` 动作，不再出现「UI 停了但后台仍在跑」
- `campaign-service.ts` 的 `pause` / `abort` 清理 `scheduledTimer` 后置 `null`，并清除 `chrome.alarms` 的 `apply-tick`，防止 service worker 唤醒后继续 tick
- `settings.ts` / `message.ts` 补齐 `panelState`、`liepinResumeMode` 字段与两个新消息类型
- 扩展版本统一升级为 1.1.1（`package.json` / `package-lock.json` / `public/manifest.json`）

### Fixed

- **浮窗运行一段时间后消失**：`dismissUnexpectedModals` 新增 `isExtensionOwnedUi`，扫描 dialogs / masks / 高 `z-index` fixed div 时跳过 `#boss-assistant-panel`、`#boss-assistant-trigger` 及其子节点
- **悬浮窗配置无法提前设置、只能精确投递**：AIbot 配置面板现在可提前选择批量沟通 / 精确推荐，配置与页面浮窗同一份状态
- **悬浮窗停止无效**：停止不再只改页面内 `isApplying`，而是走后台 `shutdown` + 广播 `ASSISTANT_CANCEL`，后台 campaign 与当前 content script 任务一起终止；同时本地立即置 `runStopped = true`，让老链路收尾显示「已停止沟通」而非「沟通完成」
- **关闭状态跨页面残留**：关闭浮窗是运行时动作而非永久偏好；`normalizeInitialPanelState()` 在新页面加载时把残留的 `closed` 恢复为展开并同步写回 storage，浮窗配置改由 content 直接写 `chrome.storage.local` 单一真源，消除「关闭后立刻点恢复入口」的消息往返竞态
- **猎聘浏览器 E2E 200s 超时**：`readAppliedPlatforms()` 用 `indexedDB.open()` 读库后长期不关闭连接，正好阻塞 `SAVE_APPLICATION` 的 Dexie 升级事务，写库与读库互等；现读完立即 `db.close()`，补齐 `onblocked`、缺失 `applications` 表的兜底，并加 5s open 超时与 8s 单次读取硬超时，避免整个用例挂死

### Validation

- `npm run lint`：0 error（42 warnings，为遗留 `explicit-any` 与 unused eslint-disable 技术债）
- `npx tsc -b`：0 error
- `npx vitest run tests`：**54 files / 728 tests passed**（在 718 基线上新增 10 个统一控制状态用例），含 10 个 `headless:false` 浏览器 E2E 套件
- `npx vite build`：success；`dist/manifest.json` = 1.1.1（95 文件），浏览器 E2E 加载该产物
- `dist.crx` 以原 `dist.pem` 重新打包为 1.1.1，扩展 ID（公钥指纹 `322abd1abace1ee048e85832a1616956`）保持不变

## [1.1.0] — 2026-11-05 · 自愈韧性智能体架构（M1–M5）

### Added

- **M1 技能热修复引擎**：选择器指纹提取、Promise 互斥写队列（防并发竞态）、技能沉淀/检索、3 次失败自动熔断、跨进程消息桥；Dexie v8 + `[platform+goal]` 复合索引
- **M2 多阶弹性降级**：目标卡片三阶降级（常规定位 → 去行政后缀模糊分词 → URL 直达）、沟通按钮五阶降级（技能缓存 → 预设选择器 → 语义黑白名单 → LLM 感知 → 本地安全回退）、严格负面按钮黑名单（绝不误点"不合适"）、意外弹窗/遮罩/滚动锁死强力脱困
- **M3 任务优先保障**：`executeCampaignTask` 建立 `try-finally` 单岗位故障隔离边界，任何异常都不卡死投递流水线；`cleanupUi` 统一现场复原（弹窗、遮罩、body 滚动锁、焦点）
- **M4 事后归因**：自愈事件入库（复用 `auditLogs`，`source='self_healing'`，保留最近 500 条）、按 `platform + category` 聚合为开发者待修建议；管家面板新增「待修清单」Tab，支持优先级卡片、失败选择器、一键复制 GitHub Issue Markdown
- **M5 全量验收**：新增 `self-healing-mission`、`self-healing-diagnostics`、`adversarial-m3-stress`、`adversarial-m4-stress` 共 59 个用例
- **质量收尾：猎聘测试覆盖**：新增 `tests/liepin-logic.test.ts`（19 用例：粗筛规则、平台识别、DOM 解析、详情页 JSON-LD）与 `tests/liepin-flow.test.ts`（2 个真实 Chromium fixture 用例：浮窗注入、hover→「聊一聊」→投递入库 `platformId=liepin`）

### Changed

- 诊断事件复用现有 `db.auditLogs` 表，**无需新增 Dexie 版本号**，不触发用户端强制迁移
- 所有诊断埋点与 `finally` 清理均为 fire-and-forget + `.catch(() => {})`，诊断链路故障绝不外溢至投递主链路
- `isNegativeButton` 保持纯函数无副作用，拦截埋点落在实际拦截分支

### Fixed

- **CI 红线**：`npm run lint` 从 292 errors 收敛到 **0 error** —— `eslint.config.js` 仅对 `tests/**` 放宽 mock/fixture 相关规则、对 `src/**` 的 `no-explicit-any` 降为 `warn` 显式留债，其余 82 处（未用导入/参数、空 catch、正则多余转义）全部真修；CI 的 `npm run lint` 步骤保持不变
- **CI 浏览器 E2E**：`ci.yml` 的 `npm test` 改由 `xvfb-run -a` 执行，解决 Linux runner 无 DISPLAY 时 10 个 `headless:false` 扩展套件无法启动的问题；不改 headless 以免 MV3 `--load-extension` 失效
- **CI 假绿修复**：`ubuntu-latest` 迁移到 26.04 后，Playwright 1.60 报 `does not support chromium on ubuntu26.04-x64`，Chromium 安装 1 秒失败，兜底逻辑自动跳过 10 个浏览器 E2E 套件却仍显示 CI 成功；现固定 `runs-on: ubuntu-24.04`、安装重试 3 次并加 `--with-deps`、失败即让 job 失败，同时把安装输出与 vitest 摘要写入 check-run annotation，绕开 GitHub 日志登录墙
- **文档一致性**：修正 1.0.0 Known Issues 的过时表述，同步 README / PROJECT / 归档文档的用例计数，扩展版本号统一为 1.1.0

### Validation

- `npx vitest run tests`：**53 files / 718 tests passed**（在 697 基线之上新增 21 个猎聘用例）
- `npm run lint`：**0 error**（42 warnings，为遗留 `explicit-any` 与 react-refresh 提示）
- `npx tsc -b`：0 error
- `npx vite build`：success（2361 modules，仅 1 条 1MB chunk 体积警告）
- `dist.crx` 以原 `dist.pem` 重新打包为 1.1.0，扩展 ID（公钥指纹 `322abd1abace1ee048e85832a1616956`）保持不变
- GitHub Actions：`lint-and-build` 执行 lint + build；`test` job 固定 `ubuntu-24.04`，完整执行含 10 个 headed 浏览器 E2E 套件的全量用例，Chromium 安装失败即让 job 失败、不再静默跳过；CI 单线程运行避免多个 Chromium 抢占资源。浏览器 E2E 需 headed Chromium + 已构建的 `dist`

## [1.0.0] — 2026-07-27

### Added

- **多平台支持**：Boss 直聘 + 猎聘平台适配器
- **简历管理**：支持 PDF / DOCX 上传与自动解析为结构化数据
- **AI 匹配**：本地匹配引擎 + 远程 AI（支持 DeepSeek、OpenAI、Qwen、GLM-4、Kimi 等 12 种预设模型）
- **智能筛选**：岗位/地点/薪资/学历多维度过滤 + 关键词排除
- **一键投递**：批量自动沟通模式 + AI 推荐模式
- **浮动面板**：Shadow DOM 注入，支持拖拽、最小化、关闭/恢复
- **防封策略**：可配置随机延迟、人类行为模拟、风险检测
- **数据追踪**：投递记录、面试日历（含浏览器通知提醒）、黑名单管理
- **数据导出**：CSV / Excel 导出，支持批量合并
- **设置同步**：IndexedDB + chrome.storage.local 双写，跨上下文状态共享
- **Popup UI**：4 个 Tab（概览、简历、追踪、设置）
- **Options UI**：5 个页面（仪表盘、面试日历、黑名单、导出中心、设置）

### Known Issues

- 猎聘适配器所有 DOM 选择器标记为 `[待校准]`，需在真实页面验证
- 每日限额功能为 stub 实现，`rate-limiter.ts` 所有方法均为 no-op
- E2E 测试仅覆盖 Boss 直聘，未覆盖猎聘
- 单元测试覆盖不足（仅本地匹配算法有单测）

> **2026-11-05 修订说明（以上为 1.0.0 发布时的历史状态，保留原文以便追溯）：**
> - ① 猎聘选择器仍**未在真实站点校准**，但 1.1.0 已补齐基于调研 DOM 的 fixture 测试覆盖；源码中并无逐行 `[待校准]` 标记，原文表述不准确。
> - ② 每日限额已由 `src/shared/antiBot/rate-limiter.ts` 完整实现（含分平台配额与每日重置），**不再是 no-op**。
> - ③ E2E 已覆盖 51job / 智联招聘 / 脉脉（fixture 页面），1.1.0 起补齐猎聘，**仅 Boss 的说法已失效**。
> - ④ 测试规模已从「仅本地匹配算法有单测」增长到全量 53 文件 / 718 用例，「覆盖不足」的结论不再成立。
> - 注意：所有浏览器 E2E 均为「真实 Chromium + `page.route` 注入的模拟页面」，**不等于真实站点 / 真实账号实测**。
