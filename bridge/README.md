# qiuzhizhushou-bridge

「智能求职助手」Chrome 扩展的本地 AI 桥接服务。**零第三方依赖，只需 Node.js ≥ 18。**

它同时是：

- **MCP Server**（stdio + Streamable HTTP），供 Claude Code / Codex / Cursor / Cline / 小龙虾等接入
- **REST / SSE API**，供任意脚本或 Agent 调用
- **命令中转站**：把外部工具调用排队，由扩展的 offscreen 页面长轮询取走执行，再回传结果

```
外部 AI ──MCP/REST──▶ 本服务(127.0.0.1:18790) ◀──长轮询── 扩展 offscreen 页面 ──▶ background RPC ──▶ 既有业务代码
```

## 快速开始

在项目根目录：

```bash
./scripts/install.sh                 # 一条龙：构建 + 配置 + 启动 + 体检
node bridge/bin/cli.mjs doctor       # 随时自检
```

然后在 Chrome 加载 `dist/`，并在扩展「设置 → 外部 AI 接入」点一次「连接本地桥接」。

## 目录

| 路径 | 作用 |
|---|---|
| `src/server.mjs` | HTTP daemon：命令队列、配对、长轮询、SSE、MCP JSON-RPC |
| `src/mcp-stdio.mjs` | stdio MCP Server（AI 客户端拉起） |
| `src/tools.mjs` | 工具清单兜底 + MCP instructions（权威清单由扩展上报） |
| `src/config.mjs` | 配置 / token / 鉴权 |
| `src/integrations.mjs` | 生成并合并各客户端 MCP 配置 |
| `src/doctor.mjs` | 体检 |
| `bin/cli.mjs` | CLI |
| `test/selftest.mjs` | 端到端自测（起临时 daemon + 模拟扩展） |
| `integrations/openclaw-skill.md` | OpenClaw / 小龙虾 bot 的 Skill 文档 |

## 自测

```bash
node bridge/test/selftest.mjs
```

会启动一个临时端口的 daemon 和模拟扩展客户端，验证配对、工具上报、长轮询、结果回传、MCP 与 REST 全链路（12 项断言）。

## 完整文档

见项目根目录 [`docs/EXTERNAL_AI.md`](../docs/EXTERNAL_AI.md)。
