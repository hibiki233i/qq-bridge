#!/bin/bash
# 双击打开「连接配置」页面（QQ 网关 / DSH / 白名单），不用先启动桥接。
# 命令行：./config.command，或者 npm run config
cd "$(dirname "$0")" || exit 1
for d in "$PWD/tools/_runtime/node/bin" "$PWD/../ai-companion-kit/tools/_runtime/node/bin"; do
  [ -x "$d/node" ] && PATH="$d:$PATH"
done
if ! command -v node >/dev/null 2>&1; then
  echo "没找到 node —— 先装 Node.js 22.13+（brew install node@22，或跑 ai-companion-kit/tools/安装.command）"
  read -r -p "按回车关闭…" _
  exit 1
fi
exec node scripts/config-gui.mjs "$@"
