# 07 · 数据存储 / 加密 / 导出

> 一句话职责：数据全部留在本机，敏感内容加密，导出时自动脱敏。

---

## 存储分层

| 层 | 位置 | 存什么 |
|---|---|---|
| IndexedDB（Dexie `BossZhipinAssistant`） | 扩展域 | 简历、投递、黑名单、面试、审计、技能、记忆、错误、经历 |
| `chrome.storage.local` | 全上下文共享 | 设置（`setting_*`）、队列与 Campaign、日计数、Webhook 配置、AI 用量 |
| 内存 | 运行时 | 缓存与熔断计数（单测环境替代 chrome API） |

为什么要两套：content script 在网页域，IndexedDB 与扩展页不互通，所以设置/队列这类跨上下文数据放 `chrome.storage.local`。详见 CONFIG_GUIDE 第 6 节。

## 加密（`src/shared/security/vault.ts`）

- 算法：WebCrypto AES-GCM，密钥首次生成后存 `chrome.storage.local`（扩展私有域）。
- 格式：`enc:v1:<iv>:<cipher>`（base64）；无前缀视为旧明文，直接透传（平滑迁移）。
- 当前覆盖：**简历原文**、**职业画像**。`apiKey` 仍为明文（仅本机），如需加固在 `settings-store.setSetting` 层接入 `encryptText`。

## 脱敏（`src/shared/security/mask.ts`）

导出前对手机号、邮箱、身份证等做掩码（如 `138****8000`），避免把敏感信息发给第三方/上传表格。

## 导出（`src/shared/export/`）

| 能力 | 文件 | 输出 |
|---|---|---|
| 投递记录 | `csv-export.ts` → `exportApplications` | Excel/CSV（含公司、岗位、状态、匹配分、时间） |
| 黑名单 | `csv-export.ts` → `exportBlacklistCSV` | CSV |
| 岗位池合并 | `merge-jobs.ts` | 多平台采集结果去重合并，供离线分析 |
| 页面 | 管理后台 → 导出中心；弹窗设置 → 数据管理 | — |

导出走 `file-saver`，纯前端生成，不经过任何服务器。

## 隐私主张（对用户可见）

- 不上传任何数据到自有服务器；AI 调用直连用户自己配置的模型厂商。
- 卸载扩展 = 清空本地数据（含加密密钥，等于不可恢复），重要记录请先导出。

## 相关测试

`h1-vault.test.ts`、`h5-error-store.test.ts`、`extension-flow.test.ts`。
