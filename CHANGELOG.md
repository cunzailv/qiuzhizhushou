# Changelog

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
