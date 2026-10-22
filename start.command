#!/bin/bash
# macOS / Linux 版 start.bat：守护模式启动桥接（崩溃 5 秒后自动拉起，关掉终端窗口即停止）。
# Finder 里双击即可；命令行：./start.command
cd "$(dirname "$0")" || exit 1

# 便携版 Node（ai-companion-kit 的安装脚本会放在 tools/_runtime/node）优先
for d in "$PWD/tools/_runtime/node/bin" "$PWD/../ai-companion-kit/tools/_runtime/node/bin"; do
  [ -x "$d/node" ] && PATH="$d:$PATH"
done

if ! command -v node >/dev/null 2>&1; then
  echo "没找到 node —— 先装 Node.js 22.13+（brew install node@22，或跑 ai-companion-kit/tools/安装.command）"
  read -r -p "按回车关闭…" _
  exit 1
fi

# 收紧 state/ 权限（非 Windows 上是 chmod 700，失败也不阻断启动）
node scripts/harden-state-acl.mjs --quiet

while true; do
  node src/bridge.js
  code=$?
  if [ "$code" = "2" ]; then
    echo "[$(date '+%F %T')] 已经有一个桥接在跑（另一个窗口），本窗口退出。"
    read -r -p "按回车关闭…" _
    exit 2
  fi
  echo "[$(date '+%F %T')] bridge 退出（code $code），5 秒后重启…（Ctrl+C 停止）"
  sleep 5
done
