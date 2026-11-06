<p align="center">
  <img src="docs/assets/logo-transparent.png" alt="智能求职助手 Logo" width="140">
</p>

<p align="center">
  <h1 align="center">🤝 智能求职助手</h1>
  <p align="center">
    多平台 AI 驱动的求职投递 Chrome 扩展 —— AI 匹配评估 · 管家 Agent · 精投/海投双模式 · 简历管理
  </p>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License"></a>
  <a href="https://github.com/cunzailv/qiuzhizhushou/stargazers"><img src="https://img.shields.io/github/stars/cunzailv/qiuzhizhushou?style=flat" alt="Stars"></a>
  <a href="https://github.com/cunzailv/qiuzhizhushou/issues"><img src="https://img.shields.io/github/issues/cunzailv/qiuzhizhushou" alt="Issues"></a>
  <img src="https://img.shields.io/badge/platform-Chrome%20|%20Edge-brightgreen" alt="Platform">
  <img src="https://img.shields.io/badge/manifest-v3-blueviolet" alt="Manifest V3">
  <img src="https://img.shields.io/badge/platforms-5%20(5%E5%A4%A7%E5%B9%B3%E5%8F%B0)-orange" alt="Platforms">
  <img src="https://img.shields.io/badge/tests-948%20passed-brightgreen" alt="Tests">
</p>

---

## 🎨 品牌与 Logo

以 **「握手」** 为核心图形语言：招聘平台与求职者、AI 与用户之间的双向连接。

- **主 Logo**：商务徽章式设计 —— 暖橙（`#FF7A2F`）× 深蓝（`#1E3A8A`）双色徽章，双手握手图形 + 品牌字标
- **浅色主题 UI**：全扩展（popup / options / 招聘页注入浮窗）统一为 **白底 · 黑字 · 橙色渐变 CTA**，与 Logo 徽章橙色形成品牌一致性

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
| **点击图标唤起侧栏** | 点插件图标即在当前网页右侧展开整屏高侧栏（宽 440px，留 8px 边距），**正文就是原来的完整助手面板**（概览 / AIbot / 管家 / 简历 / 追踪 / 设置，同源 iframe 复用 popup 应用），标题栏只保留 ⚙ 置顶 ⏻ × 四个操作 |
| **入口只回助手，绝不跳后台** | 入口决策收敛到 `src/shared/assistant-entry.ts`：只有普通 `http(s)` 网页才尝试注入侧栏；`chrome://` / 扩展页（`chrome-extension://`）等不可注入场景、或注入失败，一律打开 / 复用「独立助手面板」标签页（`src/popup/index.html?standalone=1`），**不再打开管理后台**。编排依赖签名里根本没有「打开后台」这个函数，从设计上杜绝把用户困在后台页 |
| **后台页有回家入口** | 管理后台左侧栏顶部新增「返回助手侧栏」（找到 / 新开招聘网站标签页并展开侧栏）与「打开独立助手面板」两个按钮；独立助手面板顶部提示 + 右上角「展开侧栏」一键回到网页侧栏 |
| **两态收起（无小浮窗）** | `expanded`（整高侧栏）→ 点右上角 `×` → `bubble`（贴右侧居中的半圆浮球）→ 点浮球 → 回到整高侧栏。另有 `collapsed`（旧版窄把手，兼容历史数据）与 `closed`（关闭并停止 AIbot，入口仍是浮球）。历史残留的 `floating` 会自动归一为 `expanded`；侧栏固定在右侧，不能拖动脱离 |
| **叉掉 ≠ 停止** | 侧栏右上角 `×` 只是收起为浮球，AIbot 继续运行；停止请点标题栏的 `⏻` 或 AIbot 配置页「停止」 |
| **置顶常驻** | 标题栏 `📌` 打开后不再自动收起，新页面也直接展开侧栏 |
| **概览批量沟通控制台** | 概览页去掉与「追踪」重复的「最近投递」，改为批量沟通控制台：实时状态 / 进度条 / 匹配推荐 / 今日剩余额度 / 投递模式 / AI 评分 / 开始停止 / 最近 3 条匹配结果。进度由 content 经 `runtime-state` 实时上报 |
| **概览头部去冗余** | 概览不再重复渲染「求职助手 / 平台 · 智能投递」第二层标题（App 全局头部已有品牌名与平台徽章），也不再放第三个「开始沟通 / 停止」按钮；启动入口收敛为「沟通筛选条件」的「开始智能沟通」与「批量沟通控制台」的「开始批量沟通（半自动）」两处，互斥提示只在控制台保留一条 |
| **半自动 ⇄ 全自动互斥** | 概览「开始批量沟通」是半自动（`manual`），AIbot 是全自动（`autopilot`）。两者由 `src/shared/runtime-state.ts` 的全局锁仲裁：两处启动按钮同时禁用、启动请求被拒并显示提示；暂停 AIbot 会让出锁，恢复时重新申请；异常退出残留超过 2 小时的锁可被抢占 |
| **筛选条件两边通用** | 概览「沟通筛选条件」与 AIbot 全自动流水线通过 `src/shared/agent/filter-config.ts` 读写同一批设置键；AI 评分开关与最低匹配分不再硬编码，任一侧修改两边立即生效 |
| **配置双向同步** | AIbot 配置面板的「面板形态」卡片可设置整高侧栏 / 半圆浮球 / 停止与置顶常驻，并同步投递模式、AI 评分、猎聘简历模式；运行中切换从下一个任务起生效 |
| **投递方式由用户决定** | 启动前必须由用户选择「精投」或「海投」，系统不预设。精投 = AI 逐岗打分 + 个性化话术、45-180 秒/个、门槛 60；海投 = 本地快速评分 + 平台模板、15-45 秒/个、门槛 25。两套参数由 `src/shared/agent/delivery-strategy.ts` 成套切换，杜绝「海投的间隔配精投的门槛」；未选择时启动会被拦截并弹出选择卡片 |
| **停止链路统一** | 标题栏 `⏻`、侧栏「停止」、AIbot 面板「终止」是同一个动作：终止 campaign、清除 `apply-tick` 闹钟、取消当前任务、广播 `ASSISTANT_CANCEL`、释放全局运行锁，并把状态写成 `closed` |
| **不再被自愈误伤** | `dismissUnexpectedModals` 清理高 `z-index` 遮罩时跳过扩展自有节点，避免运行一段时间后侧栏被当作页面弹窗隐藏 |

> 浏览器 E2E 仍是「真实 Chromium + 模拟页面」，猎聘真实站点选择器仍需人工校准。

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
8. 在 **管家** 页让 Agent 自动选岗、生成话术、复盘投递结果

---

## 📚 文档索引

| 文档 | 内容 | 读者 |
|---|---|---|
| [docs/CONFIG_GUIDE.md](docs/CONFIG_GUIDE.md) | 配置说明书：首次必配 4 类、默认值与安全档位、可后置项、配置存储机制 | 使用者 / 开发者 / AI |
| [docs/FEATURES.md](docs/FEATURES.md) | 功能总览：11 个模块、端到端主流程、数据表、代码结构速查 | 开发者 / AI |
| [docs/features/](docs/features/) | 分功能详解（简历、匹配、流水线、安全、管家、通知、数据、引导） | 开发者 |
| [PROJECT.md](PROJECT.md) | 自愈韧性智能体架构（四阶降级、技能沉淀、故障隔离） | 开发者 |

---

## 🏗️ 技术栈

| 层 | 技术选型 |
|----|---------|
| 框架 | React 18 + TypeScript |
| 构建 | Vite 5 + crxjs（Manifest V3） |
| 样式 | Tailwind CSS 3 + shadow DOM 注入 |
| 数据 | Dexie (IndexedDB) + chrome.storage |
| AI | OpenAI / DeepSeek / 自定义兼容接口 + 本地语义精筛 |
| 测试 | Vitest（94 用例）+ Playwright（E2E） |
| UI 组件 | Lucide React + Recharts |

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
npm test                                       # tsc -b + vite build + 全部 728 个测试用例
npx vitest run                                  # 全量单测/E2E：54 文件 / 728 用例
npx vitest run tests/self-healing-*.test.ts     # 自愈架构专项：146 用例（基线 110 + 新增 36）
```

每个功能阶段（A/B/C/D/E/UI）都包含浏览器级 E2E 验收（加载 `dist` 扩展 → 真实页面注入 → 截图断言）。
自愈架构另有 Tier 5 白盒对抗压测（并发清理、DB 写失败、500+ 条淘汰、畸形载荷）。

> CI 说明：两个 job 固定 `ubuntu-24.04`（`ubuntu-latest` 已迁移到 26.04，Playwright 1.60 不支持该平台的 Chromium 构建）。`lint-and-build` 执行 lint + build；`test` job 用 `xvfb-run -a` 跑全量测试，含 10 个 `headless:false` 浏览器 E2E 套件。Chromium 安装重试 3 次（带 `--with-deps`），仍失败则直接让 job 失败，不再静默跳过；`SKIP_BROWSER_E2E=1` 仅作为本地应急开关保留。浏览器 E2E 是「真实 Chromium + `page.route` 模拟页面」，不等于真实站点 / 真实账号实测。

## 📝 更新日志

| 版本 | 内容 |
|------|------|
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
