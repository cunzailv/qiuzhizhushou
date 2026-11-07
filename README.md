<p align="center">
  <img src="docs/assets/logo-transparent.png" alt="智能求职助手 Logo" width="140">
</p>

<p align="center">
  <h1 align="center">🤝 智能求职助手</h1>
  <p align="center">
    多平台 AI 驱动的求职投递 Chrome 扩展 —— AI 匹配评估 · Tool-Calling 中控 Agent · 精投/海投双模式 · 简历管理
  </p>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License"></a>
  <a href="https://github.com/cunzailv/qiuzhizhushou/stargazers"><img src="https://img.shields.io/github/stars/cunzailv/qiuzhizhushou?style=flat" alt="Stars"></a>
  <a href="https://github.com/cunzailv/qiuzhizhushou/issues"><img src="https://img.shields.io/github/issues/cunzailv/qiuzhizhushou" alt="Issues"></a>
  <img src="https://img.shields.io/badge/platform-Chrome%20|%20Edge-brightgreen" alt="Platform">
  <img src="https://img.shields.io/badge/manifest-v3-blueviolet" alt="Manifest V3">
  <img src="https://img.shields.io/badge/platforms-5%20(5%E5%A4%A7%E5%B9%B3%E5%8F%B0)-orange" alt="Platforms">
  <img src="https://img.shields.io/badge/tests-1165%20passed-brightgreen" alt="Tests">
</p>

---

## 🎨 品牌与 Logo

以 **「握手」** 为核心图形语言：招聘平台与求职者、AI 与用户之间的双向连接。

- **主 Logo**：商务徽章式设计 —— 暖橙（`#FF7A2F`）× 深蓝（`#1E3A8A`）双色徽章，双手握手图形 + 品牌字标
- **界面方向（2026-11）**：全扩展（popup / options / 招聘页注入侧栏）统一为 **冷调石墨中性表面 · 近黑主按钮 · 单一压暗橙 accent**。品牌橙保留为唯一强调色但离开表面；渐变文字、彩色发光、毛玻璃、emoji 图标与循环动效已全部移除。Logo 徽章作为真实品牌资产保持不变
- **信息架构（2026-11）**：首屏只留「现在做什么 / 现在怎么样了」，低频设置分层收纳进折叠组，功能一个不删；详见下方「信息架构 · 分层收纳」

| 资产 | 用途 |
|------|------|
| `docs/assets/logo-transparent.png` | 透明底主 Logo（弹窗、设置页、README） |
| `public/icons/icon{16,48,128}.png` | 浏览器扩展图标（徽章图形） |

---

## ✨ 功能全景

项目按 **AI 能力 × 平台能力** 分四层演进，每层均通过功能测试 + 浏览器 E2E 验收：

### 🧠 A 层 · AI 匹配评估引擎
| 模块 | 说明 |
|------|------|
| **简历画像** | PDF / DOCX 简历 → 结构化画像（年限推断、项目提取、技能分级、亮点识别） |
| **JD 理解** | 岗位要求结构化（职责 / 硬性条件 / 加分项 / 技能分级 / 薪资学历年限） |
| **语义匹配评分** | 本地规则初筛 + 硬门槛拦截 + LLM 语义精评（0–100 分） |
| **差距报告** | 可解释的维度拆解（技能 / 经验 / 学历…）→ 差距 → 行动建议 + 简历改写要点 |

### 🤖 B 层 · 多角色求职管家 Agent
| 角色 | 职责 |
|------|------|
| **选岗 Agent** | 按画像与目标筛选值得投递的岗位 |
| **策略 Agent** | 生成沟通话术与投递策略（打招呼语 / 面试话术） |
| **沟通 Agent** | 执行批量沟通、按分筛选、不评分沟通等模式 |
| **跟进 Agent** | 投递后跟踪（已读 / 沟通中 / 邀约 / 黑名单） |
| **记忆留痕** | Agent 记忆持久化，跨会话记住求职偏好与历史决策 |

### 🛡️ C 层 · 基础设施与护栏
- 本地语义精筛（不消耗 token 先过滤低质岗位）
- 复盘 Agent（投递结果复盘，反哺策略）
- 流式思考展示（AI 决策过程可视化）
- AI 预算上限（每日 token 预算，防止超额）

### 🌐 D 层 · 多平台适配
| 平台 | 支持能力 |
|------|----------|
| **Boss 直聘** | ✅ 列表 / 详情 / 批量沟通 / 匹配徽章 |
| **猎聘** | ✅ 列表 / 详情 / 投递 |
| **前程无忧 51job** | ✅ 列表 / 详情 / 投递（2026-10 新增） |
| **智联招聘** | ✅ 列表 / 详情面板 / 投递（2026-10 新增） |
| **脉脉** | ✅ 列表 / 详情（保守策略 + 通用兜底） |

> 平台适配通过统一的 `PlatformAdapter` 接口注册，URL 匹配用裸域正则（`(?:^|[/.])domain`）防止跨站误匹配。

### 🦾 E 层 · 自愈韧性智能体架构（M1–M5，2026-11）
面对 DOM 变动、类名混淆、反爬遮罩与运行时异常，全流程自动降级与兜底：

| 能力 | 说明 |
|------|------|
| **技能热修复** | 选择器指纹 + IndexedDB 技能沉淀，命中缓存免发版即时复用；连续失败 3 次自动熔断 |
| **多阶弹性降级** | 卡片三阶（常规定位 → 模糊分词 → URL 直达）、按钮五阶（技能缓存 → 预设选择器 → 语义黑白名单 → LLM 感知 → 本地安全回退） |
| **任务故障隔离** | `executeCampaignTask` 的 `try-finally` 边界：单岗位异常自动收敛、不卡死队列，现场无残留复原 |
| **事后归因** | 自愈事件入库并聚合为「开发者待修清单」，管家面板支持一键复制 GitHub Issue Markdown |

> 严格负面按钮黑名单确保绝不误点「不合适」；所有诊断埋点 fire-and-forget，绝不阻断投递主链路。
> 详见 [`PROJECT.md`](PROJECT.md) 与 [`docs/UNFINISHED_PLAN.md`](docs/UNFINISHED_PLAN.md)。

### 🎛️ F 层 · 右侧侧栏与 AIbot 统一控制
网页右侧侧栏与 AIbot 后台流水线共用一份控制状态（`src/shared/assistant-state.ts`），任何一方修改都会通过 `chrome.storage.onChanged` 同步到另一端：

| 能力 | 说明 |
|------|------|
| **点击图标 = 右侧整高侧栏** | 点插件图标在**招聘网站页面右侧**展开整屏高侧栏（宽 440px，留 8px 边距），正文就是完整助手面板（概览 / AIbot / 管家 / 简历 / 追踪 / 设置，同源 iframe 复用 popup 应用），标题栏只保留 ⚙ 置顶 ⏻ × 四个操作。**不会弹出独立整页面板** |
| **入口只回助手，绝不跳后台** | 入口决策收敛到 `src/shared/assistant-entry.ts`：只有「可注入 + 当前就是招聘网站」才在当前页展开侧栏；新标签页 / `chrome://` / 扩展页 / 任意普通网页，一律激活已打开的招聘网站标签页（没有则新开平台首页）并在右侧展开侧栏。`?standalone=1` 独立面板**只在两条路都失败时才兜底**，管理后台永远不作为兜底。编排依赖签名里根本没有「打开后台」这个函数 |
| **注入不再误判失败** | 扩展刚装 / 刚重载时 content script 的 crxjs loader 会异步 import 多个 chunk，旧版固定等 300ms 就判定失败并回退成独立面板。现改为动态注入后最多轮询 5 次 × 250ms 等消息端就绪；兜底路径额外发「确保展开」消息（`ensureExpanded`），避免和已写入的 `expanded` 状态打架把侧栏收成浮球 |
| **后台页有回家入口** | 管理后台左侧栏顶部「返回助手侧栏」（找到 / 新开招聘网站标签页并展开侧栏）与「打开独立助手面板」；独立助手面板顶部提示 + 右上角「展开侧栏」一键回到网页侧栏 |
| **两态收起（无小浮窗）** | `expanded`（整高侧栏）→ 点右上角 `×` → `bubble`（贴右侧居中的半圆浮球）→ 点浮球 → 回到整高侧栏。另有 `collapsed`（旧版窄把手，兼容历史数据）与 `closed`（关闭并停止 AIbot，入口仍是浮球）。历史残留的 `floating` 会自动归一为 `expanded`；侧栏固定在右侧，不能拖动脱离 |
| **叉掉 ≠ 停止** | 侧栏右上角 `×` 只是收起为浮球，AIbot 继续运行；停止请点标题栏的 `⏻` 或 AIbot 配置页「停止」 |
| **置顶常驻** | 标题栏 `📌` 打开后不再自动收起，新页面也直接展开侧栏 |
| **概览批量沟通控制台** | 概览页去掉与「追踪」重复的「最近投递」，改为批量沟通控制台：实时状态 / 进度条 / 匹配推荐 / 今日剩余额度 / 投递模式 / AI 评分 / 开始停止 / 最近 3 条匹配结果。进度由 content 经 `runtime-state` 实时上报 |
| **概览头部去冗余** | 概览不再重复渲染「求职助手 / 平台 · 智能投递」第二层标题（App 全局头部已有品牌名与平台徽章），也不再放第三个「开始沟通 / 停止」按钮；启动入口收敛为「沟通筛选条件」的「开始智能沟通」与「批量沟通控制台」的「开始批量沟通（半自动）」两处，互斥提示只在控制台保留一条 |
| **半自动 ⇄ 全自动互斥** | 概览「开始批量沟通」是半自动（`manual`），AIbot 是全自动（`autopilot`）。两者由 `src/shared/runtime-state.ts` 的全局锁仲裁：两处启动按钮同时禁用、启动请求被拒并显示提示；暂停 AIbot 会让出锁，恢复时重新申请；异常退出残留超过 2 小时的锁可被抢占 |
| **筛选条件两边通用** | 概览「沟通筛选条件」与 AIbot 全自动流水线通过 `src/shared/agent/filter-config.ts` 读写同一批设置键；AI 评分开关与最低匹配分不再硬编码，任一侧修改两边立即生效 |
| **配置双向同步** | AIbot 配置面板的「面板形态」卡片可设置整高侧栏 / 半圆浮球 / 停止与置顶常驻，并同步投递模式、AI 评分、猎聘简历模式；运行中切换从下一个任务起生效 |
| **投递方式由用户决定** | 启动前必须由用户选择「精投」或「海投」，系统不预设。精投 = AI 逐岗打分 + 个性化话术、45-180 秒/个、门槛 60；海投 = 本地快速评分 + 平台模板、15-45 秒/个、门槛 25。两套参数由 `src/shared/agent/delivery-strategy.ts` 成套切换，杜绝「海投的间隔配精投的门槛」；未选择时启动会被拦截并弹出选择卡片 |
| **AI 语义复核（会判断对错）** | 采集后不再用「标题是否含关键词」判断相关性。精投模式由 `src/shared/ai/job-relevance.ts` 把整页岗位标题一次性交 AI 判定是否真的在招这个方向，识别「PHP技术支持」这类含词但不对口的岗位并直接剔除；同义不同字（后端开发 ↔ PHP开发工程师）不会误杀。AI 结论按页面指纹缓存 30 分钟，海投 / AI 未启用 / AI 失败时自动回退本地职业族谱判定并如实标注来源，低置信度结论不会单方面剔除岗位 | 
| **关键词自愈** | 一整页没有一个真正对口的岗位时，判定搜索源失效（推荐流降级 / 未登录），把该关键词标记无效 24 小时并自动换词；所有关键词都无效则暂停并通知，不再原地空转 | 
| **L3 结果复盘反馈** | `src/shared/db/outcome-store.ts` 记录真实事件（AIbot 投递、聊天页 HR 新消息、已读/沟通/面试/不合适状态变更），按内容哈希去重；`src/shared/agent/outcome-feedback.ts` 按搜索方向统计真实回复率、零回复方向与有效方向，回灌给 Planner 生成「降权 / 加权 / 改话术」建议。摘要里的每个数字都来自真实事件，LLM 只允许输出不含数字的定性解读，含数字整条丢弃；真实结果样本不足时不允许自动改配额 | 
| **停止链路统一** | 标题栏 `⏻`、侧栏「停止」、AIbot 面板「终止」是同一个动作：终止 campaign、清除 `apply-tick` 闹钟、取消当前任务、广播 `ASSISTANT_CANCEL`、释放全局运行锁，并把状态写成 `closed` |
| **不再被自愈误伤** | `dismissUnexpectedModals` 清理高 `z-index` 遮罩时跳过扩展自有节点，避免运行一段时间后侧栏被当作页面弹窗隐藏 |

> 浏览器 E2E 仍是「真实 Chromium + 模拟页面」，猎聘真实站点选择器仍需人工校准。

### 🧠 智能中控对话台 · 真正的 Tool-Calling Agent（2026-11）
旧版「对话台」是 12 条正则 + 8 个写死动作 + 固定兜底文案，问开放问题只会回固定引导。现已换成 `src/shared/agent/butler/chat-engine.ts`：

| 能力 | 说明 |
|------|------|
| **能自己查数据** | 复用扩展内部 46 个工具（战报 / 投递记录 / 错误日志 / 简历 / 黑名单 / 配额 / 导出 / AIbot 控制…），由 AI SDK 7 `generateText + tools + stepCountIs(5)` 自动多步调用；涉及具体数字必须先查真实数据，系统提示词明令禁止编造 |
| **能连续追问** | 最多 12 条多轮上下文写入 `chrome.storage.local`，重开面板自动恢复，模型侧与界面侧同源；「那再调高一点」这类追问不会再失忆 |
| **危险动作人工审批** | `read / write / dangerous` 三级门禁：危险工具在模型循环里一律挂起，UI 弹审批卡，确认后才带 `confirm=true` 重放；后台执行入口 `BUTLER_EXEC_TOOL_MSG` 只接受扩展自身上下文并二次校验，模型绕过 UI 也执行不了 |
| **执行过程可见** | 每条回复可展开工具轨迹（工具名 / 风险级别 / 成功或失败 / 真实结果摘要），回答用 markdown 渲染，不再是一段写死的模板 |
| **降级绝不静默** | 顶部徽章明确标注当前模式：AI Agent / JSON 兼容模式 / 本地规则模式。没配 Key、原生 function calling 不可用、请求失败、今日 AI 预算用尽，都会给出黄色提示条说明原因与下一步，不会假装 AI 在工作 |
| **三级容错链** | 原生 function calling → 结构化 JSON 工具协议（兼容不支持 tools 的模型）→ 旧规则引擎离线兜底，旧 `chat-to-action.ts` 与原有测试全部保留 |
| **共用成本护栏** | 对话台调用同样计入每日 AI 预算（`consumeAiCall`），预算耗尽直接提示并回退本地，不绕开护栏 |
| **异常留痕闭环** | 每次降级 / 工具执行失败 / 审批失败都写入管家「异常留痕」诊断中心（60 秒同因去重、日志脱敏），并同步 `ai_last_failure` 让 AIbot 日志也可见；主路径成功自动清除旧失败标记 |

> 新增 `host_permissions` 覆盖 DeepSeek / OpenAI / DashScope / Moonshot / 智谱五个内置预设的接口域名；自定义 OpenAI 兼容服务的跨域仍取决于该服务自身是否允许扩展来源。

### 🔌 G 层 · 外部 AI 接入（MCP / 小龙虾 / Claude Code / Codex）
把扩展的 47 个能力统一开放给**用户自己的 AI**，本机闭环、默认关闭：

| 能力 | 说明 |
|------|------|
| **本地桥接 daemon** | 零依赖 Node 服务，只监听 `127.0.0.1:18790`，命令队列 + 结果回传 + SSE 事件 |
| **MCP Server** | stdio（Claude Code / Codex / Cursor）与 Streamable HTTP（小龙虾 / 通用客户端）双模式 |
| **统一 RPC + 工具注册表** | 47 个工具覆盖战报、投递记录、简历、黑名单、面试日历、日报、诊断、导出、AIbot 控制；三级分级门禁（只读 / 写入 / 危险） |
| **安全** | 一次性配对 token、fail-closed 总开关、危险动作默认拒绝且每次需 `confirm=true`、设置脱敏、地址白名单 |
| **一条龙脚本** | `./scripts/install.sh` 自动构建 → 生成令牌 → 写入各客户端 MCP 配置 → 启动服务 → 体检 |

> 完整接入指南：[`docs/EXTERNAL_AI.md`](docs/EXTERNAL_AI.md)｜小龙虾 Skill：[`bridge/integrations/openclaw-skill.md`](bridge/integrations/openclaw-skill.md)

### 🩺 异常留痕 · 跨上下文统一诊断（2026-11）
管家「异常留痕」Tab 曾出现「页面里明明报错了，诊断中心却空白」：content script 的 IndexedDB 属于**网页域**（如 zhipin.com），与 popup / options / background 的**扩展域**不是同一个库，直接 `recordError()` 写进去的记录永远读不到。现已收敛为单一上报链路：

| 层 | 说明 |
|---|---|
| **统一入口** | 新增 `src/shared/db/error-report.ts` 的 `reportError()`：业务代码（content / popup / options / iframe 侧栏 / background）一律调它，不再各自直接写库 |
| **主路径** | `chrome.runtime.sendMessage({type:'RECORD_ERROR'})` → background 校验载荷与来源后写入扩展域 `db.errors`；后台路由对脏 payload 与伪造来源一律拒绝 |
| **兜底路径** | background 休眠 / 无接收方时写入 `chrome.storage.local` 共享队列（全上下文可见）；storage 也不可用才回退本地 Dexie，绝不丢异常 |
| **合并读取** | `listErrors / getErrorCount / clearErrors` 同时处理扩展域库与共享队列，按 id 去重、时间与主键倒序；清空两边一起清 |
| **防丢与防刷屏** | 共享队列的 get-modify-set 用进程内串行链排队，避免同一次降级并发写互相覆盖；`dedupeWindowMs` 60 秒同因去重，AI 失败不会刷爆列表 |
| **可见性** | 对话台异常统一以 `butler.agent` / `butler.tool` / `butler.ui` 落库，诊断中心新增「对话台」筛选与来源徽章；日志只记工具名和错误摘要，**不写 API Key、简历正文或工具参数** |

### ✅ 投递确认 · 不再虚报成功（2026-11）
「日志显示投递成功，但手机里的聊天列表和投递记录都没有」的根因：三条投递链路都把 `clickApplyButton() === true` 直接当成平台确认（自愈点击的 Tier 3/4 还可能点中相似按钮），随即写投递记录、加入去重、计入配额并输出「投递成功」。半自动链路更宽松——连招呼语输入框都没出现也不阻断。

| 层 | 说明 |
|---|---|
| **确认层** | 新增 `src/shared/agent/apply-verification.ts` 的 `decideApplyVerification()` 纯函数，把「点了按钮」与「平台确认」严格分开。**点击本身不算任何证据** |
| **平台侧证据** | 只有出现**新增**确认文案（「继续沟通 / 已投递 / 投递成功」等）、新的沟通窗口或输入框、确实填入话术并点击发送、或跳进平台聊天页，才判 `confirmed`。点击前文案作为基线，避免「这个岗位之前投过」被重复记成功 |
| **阻断优先** | 「请先登录 / 请完成安全验证 / 操作过于频繁 / 今日沟通次数已用完 / 职位已下线」等平台提示一律判 `blocked`，优先级高于确认信号 |
| **诚实降级** | 拿不到证据判 `unverified`：**不写投递记录、不加入去重、不计入配额、不写 L3「已投递」事件**，并在日志、浮窗与诊断中心明确提示去平台聊天列表核对 |
| **三条链路全覆盖** | 全自动 AIbot（`content/task-runner.ts`）、半自动批量沟通与 AI 自动确认（`content/index.ts`）都接入；后台 `campaign-service.ts` 只有 `done` 才写 L3 事件，连续 3 次未确认单独告警，提示检查登录态 / 风控 / 页面改版 |
| **回归测试** | `tests/apply-verification.test.ts`（21 例）：点击无变化 → 未确认、基线旧文案不算证据、阻断优先、四种确认信号、页面文案采集跳过隐藏节点、三条链路「先确认再落盘」静态契约 |

### 🎯 搜索方向与技术栈约束（2026-11）
「岗位名称填了 `php 后台开发`、`AI 全栈开发` 却一点效果没有，还投了前端和 Java」的根因是五层叠加：

| 层 | 问题 → 修复 |
|---|---|
| **拆词** | `splitKeywordTokens` 原来不按空格切，整串「php 后台开发」扔给平台基本搜不到、页面被降级成推荐流。现按标点 + 空格切成 `php` / `后台开发` / `AI` / `全栈开发` 等可搜短词 |
| **来源** | `extractSearchKeywords` 原来只读「期望职位 / 工作经历职位 / 文件名」，简历里的 `skills`、项目 `technologies`、画像 `skillLevels` 完全没参与。现全部接入，PHP / Laravel / AI 开发 / 全栈开发 都会变成搜索词 |
| **兜底** | 一个词都没有时旧版硬编码 `['全栈工程师','前端开发工程师',…]` 替用户猜方向，PHP 后端用户因此真的去搜前端岗位。现返回空并明确提示去「设置 → 岗位名称」填写（如 `php 后台开发, AI 全栈开发`）；**不暂停**，填好下一轮自动恢复 |
| **搜索页** | 脉脉的搜索 URL 原来忽略 query，永远停在推荐流；现五个平台都把关键词写进 URL |
| **跨栈硬拦** | 新增 `src/shared/agent/stack-guard.ts`：方向里明确写了 PHP 时，「Java开发」「前端开发」「Golang后端」一律硬否决；通用词「后端开发工程师」不带栈，照常放行交给匹配分。`isCrossStackJob` 在 `evaluateJobCandidate`（硬过滤、不 soft）、`computeLocalRelevance`、AI 审核 prompt、半自动 `filterJobs` 四处一致生效 |
| **精投闸门** | 旧版本地语义判定「只统计不否决」，`relaxCareerFilter` 又把 `targetCareers` 清空，加上软过滤补足名额，没配 AI Key 的精投等于完全不设防。现放宽模式**仍保留方向白名单**；本地语义在精投下也是硬闸门；语义不相关的岗位不能靠补足名额回到队列 |
| **可见性** | 日志写明本轮搜索词 + 来源（设置 / 简历技能）+ 目标方向 + 「技术栈约束【PHP】已生效：剔除 N 个不对口岗位」，浮窗扫描文案也显示 `限 PHP`，不再黑盒 |

回归测试 `tests/search-direction.test.ts`（19 例）覆盖拆词、简历技能来源、跨栈否决、精投闸门、五平台搜索 URL 与静态契约。

### 📜 行为日志 · 可回看全部历史（2026-11）
「实时记录不能滑动、不知道之前干了什么」的根因：日志每 2 秒被无条件拉回底部、只保留本轮最近 120 条、新一轮 campaign 直接清空、条目只有 `HH:mm:ss` 没有日期，且并发写入互相覆盖。

| 改动 | 说明 |
|---|---|
| **滚动不被抢** | 日志容器 `h-36 → h-64`；`onScroll` 检测是否贴底，往上翻看历史时自动暂停跟随，并提供「回到最新」一键回底 |
| **跨轮次历史** | 新增 `campaign_log_history_v1` 归档（上限 2000 条）与本轮 500 条上限，日志终端可切「全部历史 / 只看本轮」，新一轮开跑不再丢失旧流水 |
| **条目可追溯** | 每条带 `date` 与 `campaignId`，跨天 / 跨轮次能分辨是哪一次跑的；写入走串行链，避免并发 `get-modify-set` 覆盖 |
| **回归测试** | `tests/campaign-log-history.test.ts`（6 例）：日期与轮次、归档上限、跨轮次保留、清空隔离、并发写入不丢 |

### 🔇 后台静默运行 · 不再抢焦点（2026-11）
「打开别的软件、切换标签页或下滑，Chrome 都被硬拉回招聘网站页面」的根因：每个投递任务与每轮自动补仓都会调 `ensurePlatformTab()`，旧实现**无条件**执行 `chrome.tabs.update({active:true})` + `chrome.windows.update({focused:true})`，并优先复用「当前活跃标签页」再导航到搜索 URL —— 用户正在看的页面被直接改掉。

| 层 | 说明 |
|---|---|
| **默认静默** | 新增 `src/shared/agent/stealth-mode.ts` 纯函数底座与设置 `aibotForegroundMode`（默认 `false`）。AIbot 只在**专用非活跃标签页**里采集 / 投递，不激活标签页、不聚焦窗口 |
| **多窗口保护** | `pickStealthTab()` 排除**所有窗口**的活跃标签页（不只是 `currentWindow`），避免另一个窗口里正在看的页面被导航；专用 tab 被用户点开后自动让位，绝不抢回来 |
| **专用标签页** | `aibot_dedicated_tabs` 记住每个平台的后台 tab，避免每轮新建一堆标签页；终止 AIbot 时 `releaseDedicatedTabs()` 回收，但用户已经点开的标签页一律保留 |
| **前台模式兜底** | AIbot →「复盘与维护工具」里提供「前台可见模式（会抢焦点）」开关。仅当浏览器对后台标签页节流导致采不到岗位时临时开启，恢复旧行为用于排查 |
| **用户主动入口不受影响** | 点击扩展图标、「打开平台」、手动展开右侧侧栏等**用户显式操作**仍按意图激活页面；只有 AIbot 后台调度改为静默 |
| **可见性** | 启动日志明确写「后台静默运行 / 前台可见模式」，首屏队列说明显示当前模式；登录失效时在后台标签页打开登录页并通知，不打断手上的事；`sendTabMessageWithRetry` 负责后台页 content script 注入恢复 |
| **回归测试** | `tests/stealth-mode.test.ts`（26 例）：模式决策、多窗口活跃页排除、专用 tab 优先级与让位、前台兼容、调用链静态契约、UI 开关与回收留痕 |

> 权衡：Chrome 会对长时间隐藏的标签页做定时器节流，静默模式下采集速度可能略慢。若发现补仓变少，临时打开「前台可见模式」排查即可。

### ⏱ 休息节奏与产能 · 不再一整天卡在「休息中」（2026-11）
「模拟真人作息休息 12 分钟，投了一天还没投满 80」的根因是一个 **P0 死锁**：休息分支只在内存里写 `campaign.restUntil = …` 和 `consecutiveRestCounter = 0`，紧接着 `appendCampaignLog()` 会从 `chrome.storage.local` 读一份**旧副本**并整份写回 —— 休息到期时间从未落盘、连投计数从未清零。于是每个 5 分钟切片 tick 都「重新触发一次休息」，AIbot 一整天都在休息循环里。

| 层 | 说明 |
|---|---|
| **原子落盘** | 新增 `queue-store.ts` 的 `persistRestState()`，与日志共用同一条串行写入链；`restUntil` / 连投计数 / 本批阈值一次写入，不再被日志覆盖 |
| **阈值固定** | 旧版 `15 + random()*10` 写在 tick 里每轮重随机；现在阈值一次生成后随 campaign 持久化，行为可复现 |
| **策略联动** | 新增 `src/shared/agent/rest-policy.ts` 纯状态机。**精投**连投 15-25 份休 8-20 分钟；**海投**连投 30-45 份只休 3-6 分钟，不再出现「海投投 10 分钟却休息 14 分钟」 |
| **到期即投** | 休息结束返回 `resume`，清状态后**本轮立刻继续领任务**，不再空跑一整轮；休息中的日志按 10 分钟节流，5 分钟切片不刷屏 |
| **用户出口** | 「复盘与维护工具」里可关闭「模拟真人作息休息」；休息提示条新增「立即继续」按钮（`SKIP_REST`），关开关时也会自动唤醒，不用干等十几分钟 |
| **进度可见** | 首屏「已成功投递」下方显示已启用平台的合计目标（如 `目标 80`）；休息 / 休眠 / 空转诊断日志都写明「今日已确认投递 X/Y，还差 Z 份」及「未计入配额的失败尝试 N 次」，并提示去平台聊天列表核对未确认投递 |
| **回归测试** | `tests/campaign-rest-policy.test.ts`（26 例）：用深拷贝 storage **真实复现旧死锁**、原子落盘与并发写入、阈值/时长边界、状态机六种决策、升级迁移、静态契约 |

> 说明：配额只统计「平台侧已确认」的投递（`done`）。点了按钮但平台没确认的任务不计入配额，这是防虚报的刻意设计；日志会明确标为「未记为投递成功」。

### 🎯 目标产能 · 设定「N 小时投满 M 份」（2026-11）
在 AIbot →「复盘与维护工具」里设定小时数（1-24，支持 0.5 步进）与目标份数（1-500），点「保存并启用」。设定后首屏出现常驻进度条，显示已投 / 目标、距截止剩余时间、每份最多能花多少秒。

| 层 | 说明 |
|---|---|
| **可达性预判** | 新增 `src/shared/agent/capacity-goal.ts` 的 `evaluateCapacityGoal()`，按剩余时间 / 剩余份数算 `requiredIntervalMs`，结合当前策略与休息开销预测完成时刻，输出 `on-track` / `at-risk` / `achieved` / `missed` |
| **自动调速** | 进度需要时把拟人间隔压缩到 `resolvePacingInterval()`，但**最低不低于 8 秒**防风控；`at-risk` 时自动跳过模拟真人休息，把时间还给投递 |
| **倒计时持久化** | 目标与 `startedAt` 写进本轮 campaign（`persistCapacityGoal`，与日志共用串行写入链）；参数不变则暂停 / Service Worker 重启不重置倒计时，改参数才重新计时 |
| **预警与诊断** | 赶不上时每 10 分钟给一次可操作建议（放宽岗位名称 / 多开平台 / 下调目标，或提示目标超过配额合计）；到点未达成只通知一次，指引去查「未记为投递成功」「没有发现新岗位」与登录态日志 |
| **运行中改目标** | `SET_CAPACITY_GOAL` 路由即时写设置 + campaign + 日志，并唤醒下一轮调度，不用重启 AIbot |
| **回归测试** | `tests/capacity-goal.test.ts`（23 例）：归一化边界、五种状态、预测与调速下限、倒计时持久化、并发写入、静态契约 |

> 诚实边界：这是**截止节奏管理**，不是「保证达标」。岗位供给、登录态、平台风控都不可控，系统只做可达性预判、自动调速与到点诊断，不会为了数字好看把「点了按钮但平台没确认」算成投递成功。

---

## 📸 界面预览（浅色主题）

| 弹窗（popup） | 管理后台（options） | 招聘页注入浮窗 |
|---|---|---|
| <img src="docs/assets/screenshot-popup.png" width="260"> | <img src="docs/assets/screenshot-options.png" width="260"> | <img src="docs/assets/screenshot-content-panel.png" width="260"> |

---

## 🚀 快速开始

### 给外部 AI 用（下载 → 安装 → 配置 → 运行一条龙）

```bash
./scripts/install.sh          # macOS / Linux；Windows 用 scripts\install.cmd
node bridge/bin/cli.mjs doctor
```

脚本会自动构建 `dist/`、生成访问令牌、写入 Claude Code / Codex / Cursor / OpenClaw 小龙虾 的 MCP 配置并启动本机桥接服务。
之后只需两步人工操作（Chrome 沙箱限制）：在 `chrome://extensions` 加载 `dist/`，然后到扩展「设置 → 外部 AI 接入」点一次 **连接本地桥接**。
详见 [`docs/EXTERNAL_AI.md`](docs/EXTERNAL_AI.md)。

### 安装

```bash
git clone https://github.com/cunzailv/qiuzhizhushou.git
cd qiuzhizhushou
npm install
npm run build
```

### 加载扩展

1. 打开 `chrome://extensions/`
2. 开启「开发者模式」
3. 点击「加载已解压的扩展程序」
4. 选择项目的 `dist` 目录

### 使用流程

> 首次使用只需配 4 项：**简历 → 大模型 API Key → 平台登录 → 安全阀档位（已默认保守）**。
> 管理后台「仪表盘」顶部的「配置引导」卡片会实时显示完成情况；AI 权限、通知推送、黑名单、导出都可以以后再开。

1. 点击扩展图标唤起右侧侧栏 → 点侧栏右上角 **⚙** 进入管理后台 → **简历** → 上传 PDF / DOCX 简历，设为默认
2. 打开管理后台 → **设置** → 填入大模型 API Key（默认 DeepSeek，可换通义/Kimi/GLM/自定义）并勾选「启用 AI 分析」
3. 确认**防封策略**档位为「保守」（默认即保守：30 次/天、5-15 秒间隔、单次扫描 20 个）；稳定跑一周无验证码再升档
4. 打开任意支持平台（Boss 直聘 / 猎聘 / 51job / 智联 / 脉脉）的搜索或推荐页
5. 在 **概览** 设置沟通筛选条件（岗位 / 地点 / 薪资 / 学历 / 关键词排除）
6. 在概览点 **开始批量沟通（半自动）**（或展开筛选卡片点「开始智能沟通」），批量沟通控制台实时显示进度与 AI 匹配结果
7. 在 **追踪** 页查看投递漏斗（已投递 → HR 已读 → 沟通中 → 面试邀约）
8. 在 **管家 → 智能中控对话台** 直接提问或下指令（如「今天为什么只投了 8 份，结合错误日志分析」）；Agent 会自己查数据、连续调工具、记住上下文，危险操作会先弹确认卡

---

## 📚 文档索引

| 文档 | 内容 | 读者 |
|---|---|---|
| [docs/CONFIG_GUIDE.md](docs/CONFIG_GUIDE.md) | 配置说明书：首次必配 4 类、默认值与安全档位、可后置项、配置存储机制 | 使用者 / 开发者 / AI |
| [docs/FEATURES.md](docs/FEATURES.md) | 功能总览：11 个模块、端到端主流程、数据表、代码结构速查 | 开发者 / AI |
| [docs/features/](docs/features/) | 分功能详解（简历、匹配、流水线、安全、管家、通知、数据、引导） | 开发者 |
| [PROJECT.md](PROJECT.md) | 自愈韧性智能体架构（四阶降级、技能沉淀、故障隔离） | 开发者 |

---

### 🎨 UI 设计方向 · unslop（2026-11）

按 [unslop](https://github.com/heydamir/unslop) 的 Audit → Direction → 九道 pass → Check 流程做了一次全量视觉收敛。方向从产品本身推导，不套模板：

| 五条方向 | 内容 |
|---|---|
| 产品 | 给正在求职的后端工程师用的浏览器侧栏，把「采集岗位 → 判断匹配 → 投递 → 追踪回复」变成一条可托管的流水线 |
| 性格 | 克制、准确、像仪表盘刻度 |
| 世界 | 招聘档案与进度刻度（工单、状态轴、刻度线），因此中性色取冷调石墨，所有表面无彩色 |
| 亮点 | 全站只留两处有颜色的地方：AIbot 投递进度刻度、追踪页真实回复率数字 |
| 签名 | 2px 的「队列进度刻度线」（`.queue-rule`），只在 AIbot / 批量控制卡 / 进度组件出现 |

九道 pass 的落地：

| Pass | 改动 |
|---|---|
| Spacing / Type | 4px 节奏；最小字号统一到 12px，字重只保留 400/500，去掉斜体；数字 `tabular-nums` |
| Color | 一条冷调石墨 ramp（`#F5F7FA` → `#E2E6ED`）+ 三种文字角色 + 单一 accent `#C2410C`（白底约 5.2:1）；删除跨色相渐变、渐变文字、彩色发光与彩色滚动条 |
| Icons | 界面 emoji 图标全部移除，统一 lucide 16px / 1.5 stroke；状态只用小圆点表达。运行日志与通知里的文本前缀保留（有测试断言，且不属于界面 chrome） |
| Copy | 去掉感叹号、问候语与「一键」类营销词；标题改为事实描述 |
| Layout / Details | 保留 440px popup 与侧栏形态、Tab 顺序与全部功能；药丸改方角（圆点 / 开关除外），发光 active 态改为中性 surface step + hairline，统一可见焦点环 |
| Visuals / Motion | 删除无意义循环动效与 `hover:scale`；`transition-all` → `transition-colors`；只保留 loading 旋转、toast 淡入等解释性动效 |

底座在 `tailwind.config.js` + `src/assets/styles/globals.css`，`src/content/inject-ui.tsx` 的 shadow DOM 内联样式同步收敛。`tests/unslop-design-tokens.test.ts`（8 例）把「无渐变 / 无 emoji / 无 12px 以下小字 / 无循环动效 / 签名刻度线存在」固化为静态契约，防止后续迭代把 slop 加回来。

> 设计方法来自 [unslop](https://github.com/heydamir/unslop) by Damir Sokolovsky ([@heydamir](https://x.com/heydamir))，CC BY 4.0。本项目按其流程做适配与落地，保留作者署名。

---

### 🗂️ 信息架构 · 分层收纳（2026-11）

视觉收敛后仍有一问题：**控件太多**。popup 首屏常驻 175 个控件，其中 AIbot 面板 47 个、管家页 32 个。这轮不改样式，改的是信息层级——原则是 **分层收纳、不删功能**：首屏只回答「现在做什么 / 现在怎么样了」，低频设置全部可展开。

| 区域 | 改造 |
|---|---|
| 常驻头部 | 一行放完品牌 + 平台状态 + 导航；平台名只在下拉里出现一次；5 个平台直达卡收进「打开平台」 |
| 概览 | 5 个独立统计卡合并成一行紧凑数字；半自动的「投递模式 / AI 评分」收进「更多设置」，开跑按钮仍常驻 |
| AIbot | 「一键开跑 / 暂停 / 恢复 / 终止」上移到指标看板正下方；3 个常驻调节入口（时段 / 间歇 / 投递方式）紧邻其编辑器；复盘跳转、补仓、配额、授权收进「复盘与维护工具」，5 个平台开关收进「平台与配额」，10 个悬浮窗开关收进「悬浮窗配置」 |
| 管家 | 二级导航只留「对话中控 / 跟进与留痕 / 异常留痕」+「更多视图」（管家日报 / 策略进化 / 待修清单）；日报明细、闭环说明、提案筛选、诊断维护、来源筛选、导出刷新各自折叠 |
| 硬约束 | 浏览器 E2E 依赖的按钮一律常驻：`一键开跑 AIbot`、`工作时段:`、`24小时不限`、`保存时段`、`每时每刻行为日志`（且默认展开）、`全自主无人值守队列`、`扫描跟进`、`异常留痕`、`已处理` |

折叠底座是 `src/components/ui/disclosure.tsx`（`aria-expanded`、`type="button"`、默认收起、无 emoji / 渐变 / 循环动效）。`tests/popup-information-architecture.test.ts`（17 例）把「Disclosure 成对闭合、至少 15 / 10 个控件被折叠、E2E 关键文案在深度 0、低频按钮的事件处理器在深度 > 0、功能文案一个没删」固化为静态契约。

---

## 🏗️ 技术栈

| 层 | 技术选型 |
|----|---------|
| 框架 | React 18 + TypeScript |
| 构建 | Vite 5 + crxjs（Manifest V3） |
| 样式 | Tailwind CSS 3 + shadow DOM 注入 |
| 数据 | Dexie (IndexedDB) + chrome.storage |
| AI | OpenAI / DeepSeek / 自定义兼容接口 + 本地语义精筛 + AI SDK 7 tool-calling 循环 |
| 测试 | Vitest（1165 用例 / 82 文件）+ Playwright（E2E） |
| UI 组件 | Lucide React + Recharts + react-markdown / remark-gfm |

## 📁 项目结构

```
src/
├── background/         # Service Worker
├── content/            # Content Script（页面注入 + 浮窗）
├── popup/              # 弹窗 UI（浅色主题）
├── options/            # 管理后台（浅色主题）
├── components/ui/      # 共享 UI 组件
└── shared/
    ├── ai/             # AI 模型对接 & 匹配引擎（画像/JD/评分/精筛）
    ├── agent/          # 求职管家 Agent（选岗/策略/沟通/跟进/记忆）
    │   └── butler/     #   智能中控对话台（Tool-Calling 引擎 + 旧规则离线兜底）
    ├── antiBot/        # 防封 & 延迟引擎
    ├── db/             # 数据库 & 状态同步
    ├── export/         # 数据导出
    ├── parser/         # 简历解析
    ├── platform/       # 多平台适配（5 平台）
    │   ├── boss/       #   Boss 直聘
    │   ├── liepin/     #   猎聘
    │   ├── 51job/      #   前程无忧
    │   ├── zhaopin/    #   智联招聘
    │   └── maimai/     #   脉脉
    └── types/          # 全局类型定义
tests/                  # 全量测试用例（含浏览器 E2E）
bridge/                 # 外部 AI 桥接服务（零依赖 Node：daemon / MCP / CLI / 自测）
  ├── src/server.mjs    #   长轮询命令队列 + REST/SSE + Streamable HTTP MCP
  ├── src/mcp-stdio.mjs #   stdio MCP Server
  └── bin/cli.mjs       #   setup / start / stop / doctor / integrations
scripts/                # install.sh / install.cmd / uninstall.sh（一条龙）
docs/EXTERNAL_AI.md     # 外部 AI 接入完整指南
```

## 🔌 接入新平台

1. 在 `src/shared/platform/<name>/` 新建目录
2. 实现 `PlatformAdapter` 接口
3. 在 `src/shared/platform/index.ts` 注册适配器
4. 写测试并校准选择器，跑通 `npm test` 与浏览器 E2E

参考 `src/shared/platform/51job/` 的完整实现。

## 🧪 测试与验收

```bash
npm test                                       # tsc -b + vite build + 全部 1165 个测试用例
npx vitest run                                  # 全量单测/E2E：82 文件 / 1165 用例
npx vitest run tests/self-healing-*.test.ts     # 自愈架构专项：146 用例（基线 110 + 新增 36）
```

每个功能阶段（A/B/C/D/E/UI）都包含浏览器级 E2E 验收（加载 `dist` 扩展 → 真实页面注入 → 截图断言）。
自愈架构另有 Tier 5 白盒对抗压测（并发清理、DB 写失败、500+ 条淘汰、畸形载荷）。

> CI 说明：两个 job 固定 `ubuntu-24.04`（`ubuntu-latest` 已迁移到 26.04，Playwright 1.60 不支持该平台的 Chromium 构建）。`lint-and-build` 执行 lint + build；`test` job 用 `xvfb-run -a` 跑全量测试，含 10 个 `headless:false` 浏览器 E2E 套件。Chromium 安装重试 3 次（带 `--with-deps`），仍失败则直接让 job 失败，不再静默跳过；`SKIP_BROWSER_E2E=1` 仅作为本地应急开关保留。浏览器 E2E 是「真实 Chromium + `page.route` 模拟页面」，不等于真实站点 / 真实账号实测。

## 📝 更新日志

| 版本 | 内容 |
|------|------|
| `未发布` | 🎯 搜索方向真正生效：按空格拆词、简历技能参与搜索、删除硬编码前端兜底、五个平台都带 query；新增技术栈硬约束，PHP 方向不再投 Java / 前端，精投本地语义升级为硬闸门。新增 19 例回归测试 |
| `未发布` | ✅ 投递确认层：点击按钮不再等于平台确认，未确认不落盘 / 不去重 / 不计配额；行为日志可滚动回看全部历史、带日期与轮次。新增 27 例回归测试 |
| `未发布` | 🧭 点击插件图标不再弹独立整页面板：一律落到招聘网站右侧整高侧栏，动态注入改轮询等待，新增 6 例入口契约测试 |
| `未发布` | 🗂️ 信息架构分层收纳：首屏只留「现在做什么 / 现在怎么样了」，低频设置进 Disclosure，功能一个不删；新增 17 例信息架构契约测试 |
| `未发布` | 🎨 按 unslop 完成全量界面收敛：石墨中性底座 + 单一压暗橙 accent、去掉渐变/发光/毛玻璃/emoji 图标/循环动效、落地队列进度刻度线签名，新增 8 例设计契约测试 |
| `未发布` | 🩺 异常留痕跨上下文统一：页面域异常不再丢失，对话台全链路降级留痕、日志脱敏、诊断中心新增「对话台」筛选 |
| `未发布` | 🧠 智能中控对话台升级为 Tool-Calling Agent：多轮上下文 + 46 个内部工具自动调用 + 危险动作审批 + 执行轨迹 + 三级可见降级 |
| `v1.1.1` | 🎛️ F 层：悬浮窗右侧收缩三态、AIbot 配置双向同步、关闭浮窗即关闭 AIbot |
| `bd7464a` | 🦾 E 层：自愈韧性智能体架构 M1–M5（技能热修复 / 多阶降级 / 故障隔离 / 事后归因） |
| `8d4b343` / `7d255b1` | 🎨 全局浅色主题（白底黑字 + 橙色渐变 CTA），popup / options / 注入浮窗统一 |
| `4f58b0e` | 🎨 品牌 Logo（握手徽章）接入 + 全局品牌色统一 |
| `d1e3d22` | 🌐 D 层：51job / 智联 / 脉脉 多平台适配 |
| `55211ee` | 🛡️ C 层：基础设施与护栏 |
| `d486b15` | 🤖 B 层：多角色求职管家 Agent |
| `c069321` | 🧠 A 层：AI 匹配评估接入运行时 |

## 🤝 贡献

欢迎任何形式的贡献！请先阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。

- 🐛 [报告 Bug](https://github.com/cunzailv/qiuzhizhushou/issues/new?template=bug_report.yml)
- 💡 [功能建议](https://github.com/cunzailv/qiuzhizhushou/issues/new?template=feature_request.yml)
- 📦 [提交 PR](CONTRIBUTING.md#提交代码)

## ☕ 赞助

如果这个项目对你有帮助，欢迎请作者喝杯咖啡 ☕

<p align="center">
  <img src="docs/assets/sponsor-qr.jpg" alt="微信收款码" width="280">
</p>

**微信**：`AQuan12070310`

## ⚠️ 免责声明

1. **学习与研究用途**：本工具仅供技术研究、学术交流及正当个人求职提效使用。
2. **遵守平台规范**：使用自动化辅助沟通时，请严格遵守招聘平台的服务协议，切勿设置极速过载频率或批量无休投递。
3. **风险自负**：使用者需对自身使用行为负责，项目作者与贡献者不对过度使用可能带来的账号风控、限制或封禁等后果承担连带责任。
4. **完整声明**：使用前请务必详细查阅 [免责声明与合规使用准则 (DISCLAIMER.md)](DISCLAIMER.md)。

## 📄 开源协议

本项目采用 **[MIT License](LICENSE)** 开源授权，附带防滥用与合规附加准则。

- 完整协议文本：[LICENSE](LICENSE)
- 合规使用准则：[DISCLAIMER.md](DISCLAIMER.md)
- 版权所有 © 2026 cunzailv. All rights reserved.
