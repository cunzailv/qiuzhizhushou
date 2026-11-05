#!/usr/bin/env bash
# 停止桥接服务并给出清理指引。
# 注意：本脚本不会删除你的 Claude Code / Codex / Cursor 配置，也不会删除任何求职数据。
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."
node bridge/bin/cli.mjs stop || true

CFG="$HOME/.qiuzhizhushou/bridge.json"
printf '\n桥接服务已停止。\n'
printf '若想彻底卸载，可手动处理以下位置（脚本不会代劳，避免误删）：\n'
printf '  · 配置与日志：%s\n' "$HOME/.qiuzhizhushou/"
printf '  · MCP 配置片段：%s\n' "$HOME/.qiuzhizhushou/mcp-config.json"
printf '  · Claude Code：~/.claude.json 的 mcpServers.qiuzhizhushou（安装时自动备份为 .bak.*）\n'
printf '  · Codex：~/.codex/config.toml 中 # >>> qiuzhizhushou-bridge >>> 之间的段落\n'
printf '  · Cursor：~/.cursor/mcp.json 的 mcpServers.qiuzhizhushou\n'
printf '  · Chrome：chrome://extensions 中移除「智能求职助手」\n'
if [[ -f "$CFG" ]]; then printf '  · 当前配置文件：%s\n' "$CFG"; fi
printf '\n'
