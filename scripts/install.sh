#!/usr/bin/env bash
# 智能求职助手 · 外部 AI 接入「下载 → 安装 → 配置 → 运行」一条龙
#
# 用法：
#   ./scripts/install.sh                      # 当前已是项目目录：直接安装配置
#   curl -fsSL <raw-url>/scripts/install.sh | bash   # 全新机器：自动 clone 后安装
#
# 常用选项：
#   --dir <路径>          指定安装目录（默认 ~/qiuzhizhushou）
#   --repo <地址>         指定仓库地址（GitHub 不通时换镜像）
#   --port <端口>         桥接服务端口（默认 18790）
#   --skip-build          跳过依赖安装与扩展构建（dist 已存在时）
#   --skip-clients        不改动 Claude Code / Codex / Cursor 的配置
#   --force               覆盖已存在的同名 MCP 配置
#   --no-start            只生成配置，不启动服务
#
# 本脚本只做增量安装，不删除任何已有文件；写入用户配置前会自动备份。

set -euo pipefail

DEFAULT_REPO="https://github.com/cunzailv/qiuzhizhushou.git"
REPO="$DEFAULT_REPO"
TARGET_DIR=""
CLI_ARGS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir) TARGET_DIR="$2"; shift 2 ;;
    --repo) REPO="$2"; shift 2 ;;
    *) CLI_ARGS+=("$1"); shift ;;
  esac
done

say() { printf '%s\n' "$*"; }
fail() { printf '✗ %s\n' "$*" >&2; exit 1; }

# 1) 检查 Node
if ! command -v node >/dev/null 2>&1; then
  fail "未检测到 Node.js。请先安装 Node.js 18+（https://nodejs.org），再重新运行本脚本。"
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [[ "$NODE_MAJOR" -lt 18 ]]; then
  fail "Node.js 版本过低（当前 $(node -v)），需要 18 或更高。"
fi
say "✓ Node.js $(node -v)"

# 2) 定位项目目录；若不在项目内则 clone 一份
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "$SCRIPT_DIR/../bridge/bin/cli.mjs" ]]; then
  PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
  say "✓ 已检测到项目目录：$PROJECT_DIR"
else
  PROJECT_DIR="${TARGET_DIR:-$HOME/qiuzhizhushou}"
  if [[ -f "$PROJECT_DIR/bridge/bin/cli.mjs" ]]; then
    say "✓ 复用已有安装：$PROJECT_DIR"
  else
    command -v git >/dev/null 2>&1 || fail "需要 git 来下载项目，请先安装 git。"
    say "→ 下载项目到 $PROJECT_DIR …"
    mkdir -p "$(dirname "$PROJECT_DIR")"
    git clone --depth 1 "$REPO" "$PROJECT_DIR" || fail "下载失败。可改用镜像：--repo <镜像地址>"
  fi
fi

cd "$PROJECT_DIR"

# 3) 把剩余参数交给跨平台 CLI 完成安装 / 配置 / 启动 / 体检
say ""
exec node bridge/bin/cli.mjs setup "${CLI_ARGS[@]}"
