# Changelog

## [Unreleased] — 右侧整高侧栏（Kimi 式）+ 置顶常驻

### Added

- **点击插件图标直接唤起侧栏**：`manifest.action` 去掉 `default_popup`，background 新增 `chrome.action.onClicked`，向当前标签页发 `TOGGLE_ASSISTANT_PANEL`；非招聘页会动态注入 content script 后重试，`chrome://` 等受限页退化为打开管理后台
- **右侧整高侧栏**：注入面板从「右上角 320px 浮窗」改为「贴右侧、整屏高、宽 380px、留 8px 边距」的侧栏形态（`SIDEBAR_WIDTH`），窄视口按 `calc(100vw - 16px)` 自适应
- **标题栏新增按钮**：`⚙ 管理后台`（打开 options）、`📌 置顶常驻`、`⏻ 停止 AIbot`；`×` 改为「收起为右侧浮球」
- **收起重做为浮球**：新增 `PanelState = bubble`，收起后显示贴在网页右侧垂直居中的半圆浮球（点击重新展开）
- **置顶常驻**：`AssistantControlState` 新增 `pinned`；置顶后 AIbot 启动不再自动收起、新页面直接展开侧栏
- **拖动脱离**：拖动侧栏标题栏会自动脱离为 320px 可自由移动的浮窗（保留原有拖拽与边界夹取行为）

### Changed

- `×` 不再等于「停止 AIbot」：收起为浮球只改形态，bot 继续运行；停止改由 `⏻` 按钮或 AIbot 配置页「停止」触发（`closed` 语义保持不变）
- `START_CAMPAIGN` / `RESUME_CAMPAIGN` 成功后不再写 `collapsed`，改为未置顶时写 `bubble`
- 新页面恢复规则：`pinned` → 展开侧栏；残留 `closed` / `bubble` → 恢复为展开
- AIbot 配置页「浮窗形态」改为「侧栏形态（右侧侧栏 / 收起为浮球 / 停止）」并新增置顶常驻开关
- 外部 AI 工具 `update_assistant_state` 支持 `bubble` 与 `pinned`

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
