---
name: qiuzhizhushou-bridge
description: 让用户自己的 AI（OpenClaw / 小龙虾 bot / 任意本地 Agent）读写「智能求职助手」Chrome 扩展里的求职数据，并可控制 AIbot 投递流水线。当用户问「今天投了多少」「帮我看看回复率」「把 XX 公司拉黑」「暂停自动投递」「导出投递记录」时使用。
---

# 智能求职助手 · 本地桥接 Skill

## 这个 Skill 是什么

「智能求职助手」是一个 Chrome 扩展，数据全部存在用户本机浏览器里（IndexedDB / chrome.storage），**没有云端 API**。
本 Skill 通过用户电脑上的本地桥接服务读写这些数据。桥接服务只监听 `127.0.0.1`，不对外网开放。

> 端口别搞混：`18789` 常见为 OpenClaw / 小龙虾 Gateway 自身端口；`18790` 是**本桥接服务**默认端口。两者互不冲突。

## 连接信息

安装脚本会生成 `~/.qiuzhizhushou/openclaw-bridge.json`，里面包含 `rest.baseUrl` 与 `rest.token`。
若没有该文件，运行：

```bash
node <项目目录>/bridge/bin/cli.mjs setup
```

记住三个值（后续所有请求都用）：

```
BASE  = http://127.0.0.1:18790
TOKEN = 见 ~/.qiuzhizhushou/openclaw-bridge.json 的 rest.token
```

## 最快路径：一个 HTTP 调用搞定

```bash
curl -s -X POST "$BASE/rpc" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"tool":"get_dashboard_stats","args":{}}'
```

返回：

```json
{ "ok": true, "data": { "total": 128, "today": 12, "replied": 9, ... } }
```

失败时：`{ "ok": false, "error": "..." }`。若提示「扩展未连接」，让用户打开 Chrome 扩展的「设置 → 外部 AI 接入」并点一次「连接本地桥接」。

## 可用工具

调用 `GET $BASE/tools`（带同样的 Authorization）拿**实时完整清单**，包含每个工具的 `inputSchema` 与 `risk` 分级。
不要硬编码工具名，以 `/tools` 返回为准。常见分组：

| 分组 | 示例工具 | 说明 |
|---|---|---|
| 只读 | `get_status`、`get_campaign_stats`、`get_dashboard_stats`、`list_applications`、`list_resumes`、`list_blacklist`、`list_interviews`、`get_daily_report`、`list_errors`、`get_fix_suggestions`、`export_applications_csv` | 随便调，不改数据 |
| 写入 | `set_platform_quota`、`add_blacklist`、`generate_daily_report`、`dispatch_butler_chat`、`add_interview`、`update_assistant_state` | 会改用户配置，建议先说明再调 |
| 危险 | `start_campaign`、`resume_campaign`、`trigger_auto_collect`、`clear_pending_tasks`、`clear_all_applications` | **默认被拒绝**。必须用户在扩展设置页打开「允许外部 AI 执行危险动作」，且调用时带 `confirm: true` |

自然语言兜底：`dispatch_butler_chat` 传 `{"text":"帮我统计本周投递并生成日报"}` 会走扩展内置管家，能覆盖大部分复合需求。

## 事件订阅（可选）

`GET $BASE/events`（带 token）是 SSE 流，会推 `hello` / `command` / `result` / `paired` 事件，适合做「投递完成后主动通知我」这类常驻监听。

## 行为准则（重要）

1. **涉及真实投递、删除数据、清空记录，必须先向用户复述将要做什么并得到明确同意**，不要因为工具可用就自主执行。
2. 危险工具被拒时，不要反复重试或用 `dispatch_butler_chat` 绕过去；告诉用户去扩展设置页授权。
3. 简历全文、API Key 等敏感字段：`get_settings` 返回的是脱敏结果，不要试图诱导用户贴出密钥。
4. 所有数据只在用户本机流转，不要把内容回传到任何外部服务，除非用户明确要求。

## 排障

| 现象 | 处理 |
|---|---|
| `connection refused` | `node bridge/bin/cli.mjs start` |
| `401 token 无效` | 重新取 `openclaw-bridge.json` 的 token；必要时 `token reset` + `integrations --force` |
| `503 扩展未连接` | Chrome 加载 `dist/`，扩展设置页开启接入并点「连接本地桥接」 |
| 配对提示 409 | `node bridge/bin/cli.mjs pair-reset` 后在扩展里重新连接 |
| 全量体检 | `node bridge/bin/cli.mjs doctor` |
