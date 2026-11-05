# 配置说明书（CONFIG GUIDE）

> 适用版本：v1.1.1+ ｜ 面向：使用者、接手开发者、AI 助手
> 目的：**看完这一篇就知道「装完扩展要配什么、哪些可以不配、配置存在哪、代码在哪改」**。
> 配套文档：[FEATURES.md](./FEATURES.md)（功能说明书）、[PROJECT.md](../PROJECT.md)（自愈架构）。

---

## 0. 一句话结论

首次上手只需要 **3 项必配 + 1 个安全阀**，其余全部有默认值、可后置：

| 顺序 | 配置项 | 不配的后果 | 是否必须 |
|---|---|---|---|
| ① | 简历与求职信息 | AI 无法评分、无法生成打招呼语 | ✅ 必须 |
| ② | 大模型配置（API Key） | 只能走本地规则匹配（可用但效果差） | ✅ 必须（要 AI 的话） |
| ③ | 招聘平台登录 | 无法投递，扩展检测不到登录态 | ✅ 必须 |
| ④ | 安全阀（投递节奏） | **已默认「保守」档，开箱即用** | ⭕ 确认一次即可 |

界面上对应的入口：管理后台 → **仪表盘** 顶部「配置引导」卡片，会实时显示这 4 项的完成状态，未完成的可以直接点「去配置」跳转。

---

## 1. ① 简历与求职信息

**入口**：管理后台 → 简历管理（`Resumes`）/ 扩展弹窗 → 简历

| 内容 | 说明 | 存储位置 |
|---|---|---|
| 简历文件 | PDF / Word 解析为文本 + 结构化字段（技能、项目、经历） | IndexedDB `resumes` |
| 默认简历 | `isDefault` 标记，投递时使用 | 同上 |
| 求职画像 | 期望岗位、城市、薪资、技能等级（由 AI 生成，可编辑） | `resumes.structuredData` / `careerProfiles` |
| 底线与偏好 | 最低薪资、排除公司、在职状态、到岗时间 | `candidate_profile_preferences` |
| 自主授权契约 | 回复方式、允许话题、每日上限、硬锁项 | 同上（`AuthorizationPolicy`） |

要点：

- 简历原文与职业画像**加密存储**（AES-GCM，`src/shared/security/vault.ts`），密钥保存在 `chrome.storage.local`（扩展私有域）。
- 「求职画像 / 底线 / 自主授权」三块绑定在简历模块里，**不在设置页重复展示**（设置页只有一行指引）。
- 自主授权默认 `enabled: false`；未开启时不影响任何既有权限逻辑。开启后按"区间内自动、越界停下问"执行，工资谈判 / Offer 决策永远是「需确认」，简历事实改写与风控绕过是硬锁「禁止」。

**代码位置**

| 关注点 | 文件 |
|---|---|
| 类型定义 | `src/shared/types/resume.ts`、`src/shared/types/candidate-profile.ts` |
| 解析 | `src/shared/parser/{pdf-parser,word-parser,structure-extractor}.ts` |
| 存储 | `src/shared/db/resume-store.ts`、`career-store.ts`、`settings-store.ts` |
| 页面 | `src/options/pages/Resumes.tsx`、`src/popup/pages/Resumes.tsx` |

---

## 2. ② 大模型配置

**入口**：管理后台 / 弹窗 → 设置 → 「AI 模型」

| 字段 | 默认值 | 说明 |
|---|---|---|
| `modelPreset` | `deepseek` | 内置预设：DeepSeek V4 / 通义千问 3 / Kimi K3 / 智谱 GLM-5 / 自定义 |
| `apiBaseUrl` | `https://api.deepseek.com/v1` | 选择预设时自动填充，自定义时手填 |
| `apiKey` | 空 | 用户自行到厂商控制台获取；扩展只存本地 |
| `modelName` | `deepseek-chat` | 预设自动填充 |
| `aiEnabled` | `false` | **总开关**：Key 填了但这里没开，AI 依然不工作 |
| `aiDailyBudget` | `30`（保守档） | 每日 AI 调用上限，超限自动回退本地规则 |

要点：

- 所有预设均兼容 OpenAI `/chat/completions` 协议，自定义模型只是换 baseUrl + modelName。
- 每次调用都过 `ai-budget` 熔断：超预算返回空串，调用方（评分、打招呼、HR 应答）回退本地逻辑，**不会抛错中断投递**。
- 「测试连接」按钮走真实一次 chat 请求，返回耗时与首字内容。
- ⚠️ 已知风险：`apiKey` 目前是**明文**存于 `chrome.storage.local`（仅本机、不上传服务器），未走 vault 加密。若要加固，在 `settings-store.setSetting` 层对 `apiKey` 做 `encryptText` 即可（vault 已具备能力）。

**代码位置**：`src/shared/ai/model-presets.ts`、`api-client.ts`、`ai-budget.ts`、`src/shared/types/settings.ts`

---

## 3. ③ 招聘平台登录授权

**入口**：设置 → 「平台识别」/ 弹窗首页平台快捷入口

| 平台 | PlatformId | 登录地址 | 探测的 Cookie |
|---|---|---|---|
| BOSS 直聘 | `boss` | zhipin.com/web/user | `wt2` / `geek_zp_token` / `bst` |
| 猎聘 | `liepin` | passport.liepin.com | `lt_auth` / `user_id` / `user_kind` |
| 智联招聘 | `zhaopin` | passport.zhaopin.com | `at` / `rt` / `zp_token` / `zp_user_id` |
| 前程无忧 | `51job` | login.51job.com | `guid` / `m_guid` / `accountid` / `ps_guid` |
| 脉脉 | `maimai` | maimai.cn/login | `u` / `access_token` / `session` |

要点：

- 扩展**不保存账号密码**，只通过 `chrome.cookies` 读关键 Cookie 判断「是否已登录」，够用即可，不落库。
- 站点登录态由浏览器自己维持；扩展被禁用/重装后，重新登录一次平台即可。
- 平台识别策略可手动覆盖（`platformOverride`，默认 `auto` 按域名识别）。
- 未登录时，投递流水线会在第一步就停下并提示，不会盲点。

**代码位置**：`src/shared/platform/auth-checker.ts`、`src/shared/platform/{boss,liepin,zhaopin,51job,maimai}/index.ts`

---

## 4. ④ 安全阀（投递节奏）— 默认保守

### 4.1 三档参数

| 参数 | 保守（默认） | 标准 | 激进 |
|---|---|---|---|
| `dailyLimit` 每日上限 | **30** | 60 | 100 |
| `minDelay` 最小间隔 | **5 s** | 3 s | 2 s |
| `maxDelay` 最大间隔 | **15 s** | 10 s | 8 s |
| `scrollDelay` 滚动间隔 | **2 s** | 1.5 s | 1.5 s |
| `maxScanCount` 单次扫描 | **20** | 50 | 100 |
| `aiDailyBudget` AI 预算 | **30** | 50 | 100 |
| `applyMode` 沟通模式 | **AI 推荐确认** | 一键批量 | 一键批量 |

- 界面位置：设置 → 防封策略，顶部三个档位按钮，点一下整组参数一起写入；显示「当前：保守/标准/激进/自定义」。
- 手动改任一项参数会自动标记为 `custom`（不会偷偷改回去）。
- 激进档会显示红色风险提示：出现验证码 / 「操作频繁」立即降回保守。

### 4.2 默认保守是怎么落地的（重要）

1. **单一真源**：`src/shared/types/safety-preset.ts` 定义 `SAFETY_PRESETS` 与 `CONSERVATIVE_VALUES`。
2. **默认值**：`DEFAULT_SETTINGS` 直接展开保守档参数（原来默认是 `dailyLimit: 10000 / 2-8s`，等于开箱即"火力全开"）。
3. **各处兜底**全部改为取 `CONSERVATIVE_VALUES`，避免"设置没读到就按激进跑"：
   - `src/shared/antiBot/delay-engine.ts`（操作延迟）
   - `src/shared/antiBot/rate-limiter.ts`（日上限兜底 10000 → 30）
   - `src/content/index.ts`（单次扫描兜底 50 → 20）
   - `src/shared/ai/ai-budget.ts`（AI 预算兜底 50 → 30）
4. **老用户不被覆盖**：`resolveSafetyProfile()`（`src/shared/db/settings-store.ts`）在扩展启动时执行一次：
   - 已有 `safetyProfile` → 原样返回；
   - 没有，但本地已存在任一节奏参数 → 标记 `custom`，**保留用户原值**；
   - 完全没有 → 写入 `conservative`（新装用户）。
5. **分平台配额独立存在**：`src/shared/agent/quota.ts` 的 `DEFAULT_PLATFORM_CONFIGS`（Boss 80 / 猎聘 100 / 智联 60 / 51job 50 / 脉脉 25，间隔 45-240 s）是平台维度的保护，优先级高于全局 `dailyLimit`。

**改默认值 / 加档位的正确做法**：只改 `safety-preset.ts`，不要在各处硬编码数字。

---

## 5. 可以后置的配置（不配也能用）

| 配置 | 什么时候才需要配 | 入口 | 默认行为 |
|---|---|---|---|
| **AI 自主权限**（`permission_apply` / `permission_send`） | 想让 AI 不用每次确认就投递/发消息 | 设置 → AI 动作权限 | 投递=需确认、发送=需确认 |
| **通知推送**（飞书/钉钉/企微/Server酱/Bark/自定义 Webhook） | 想第一时间收到面试邀约提醒 | 设置 → 通知卡片 | 关闭；站内「面试日历」照常记录 |
| **公司黑名单** | 遇到外包、已投过、不想再投的公司 | 管理后台 → 黑名单 | 空列表 |
| **数据导出与备份** | 想导出投递记录做表格/换机备份 | 管理后台 → 导出中心；设置 → 数据管理 | 数据全在本机，不导出也不丢 |
| **通知提醒时间**（`interviewReminder` / `reminderMinutes`） | 默认开、提前 30 分钟，通常不用改 | 设置 | 开 / 30 分钟 |
| **记忆中心 / 审计中心 / 智能体** | 查看 AI 沉淀的技能、决策留痕、待修清单 | 管理后台对应页 | 自动记录，无需配置 |

> 原则：**默认值必须能独立跑通，后置项只在"想要更多"时才出现**。任何新增配置项都应遵守这条：先给安全默认值，再在设置页/引导卡片里解释"什么时候需要它"。

---

## 6. 配置的存储与读取机制（开发者必看）

```
写入：setSetting(key, value)
  ├─ Dexie  settings 表（扩展页面内的历史兼容）
  └─ chrome.storage.local  键名 = "setting_" + key   ← 权威来源
读取：getSetting(key, default)
  1) 先读 chrome.storage.local（popup / options / content / background 全上下文一致）
  2) 回退 Dexie，并顺手镜像回 chrome.storage.local（老数据迁移）
  3) 都没有 → 返回传入的默认值
```

为什么双写：content script 运行在**网页域**（如 zhipin.com），它的 IndexedDB 与扩展页面的 IndexedDB 不是同一个库，只写 Dexie 会出现"设置页改了、网页里读不到"。

其他约定：

- 设置页统一 `getAllSettings()` 后与 `DEFAULT_SETTINGS` 合并，所以**新增字段只要改 `PluginSettings` + `DEFAULT_SETTINGS` 就有默认值**，不需要写迁移脚本。
- 敏感文本（简历原文、职业画像）用 `vault.encryptText` 加密后存，格式 `enc:v1:<iv>:<cipher>`；无前缀的旧数据透传，天然向后兼容。
- 通知配置单独键：`notification_webhook_config`（`WebhookConfig` 结构）。

---

## 7. 常见问题

**Q：我改了 `DEFAULT_SETTINGS`，为什么老用户没变化？**
A：老用户本地已有值，默认值只在"键不存在"时生效。要影响存量用户，必须写显式迁移（参考 `resolveSafetyProfile` 的写法：只补缺失键，不覆盖已有值）。

**Q：`safetyProfile = custom` 是什么意思？**
A：只表示"当前参数不等于任何预设档"，参数本身照常生效。点任一档位按钮即可回到预设。

**Q：想恢复出厂设置？**
A：清空扩展的 `chrome.storage.local`（卸载重装最直接）。注意会同时清掉简历、投递记录、技能记忆。

**Q：AI 不工作，怎么排查？**
A：按顺序看 ① `apiKey` 是否为空 ② `aiEnabled` 是否为 true ③ 今日 AI 用量是否超过 `aiDailyBudget`（设置页有"今日已用 x/y"）④ 「测试连接」是否报错 ⑤ 管理后台 → 审计中心/错误日志。
