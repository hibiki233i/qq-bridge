#!/bin/bash
# macOS / Linux 版 restart.bat：停掉本目录的守护和桥接 → 确认真的退出 → 删锁 → 新开窗口重新守护。
#
# 和 restart.bat 一样的坑：start.command 用相对路径 `node src/bridge.js` 启动，命令行里没有仓库绝对路径，
# 只按命令行匹配会误杀别的目录里的桥接（或者杀不到）。这里按 PID（锁文件）+ 进程工作目录（lsof cwd）两条路认人。
cd "$(dirname "$0")" || exit 1
ROOT="$(pwd -P)"   # 物理路径：lsof 报的 cwd 是解析过符号链接的

# 进程 $1 的工作目录是不是本目录
in_this_dir() {
  local cwd
  cwd=$(lsof -a -p "$1" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1)
  [ "$cwd" = "$ROOT" ]
}

bridge_pids() {
  local pids=""
  if [ -f state/bridge.lock ]; then
    local p
    p=$(tr -d '[:space:]' < state/bridge.lock)
    case "$p" in ''|*[!0-9]*) ;; *) kill -0 "$p" 2>/dev/null && pids="$p" ;; esac
  fi
  for p in $(pgrep -f 'src/bridge\.js' 2>/dev/null); do
    in_this_dir "$p" && pids="$pids $p"
  done
  echo "$pids" | tr ' ' '\n' | grep -E '^[0-9]+$' | sort -u
}

echo "停掉旧的守护窗口…"
for p in $(pgrep -f '(^|[/ ])start\.command' 2>/dev/null); do
  [ "$p" = "$$" ] && continue
  in_this_dir "$p" && { echo "  kill 守护 PID $p"; kill "$p" 2>/dev/null; }
done

echo "停掉旧的桥接进程…"
for p in $(bridge_pids); do
  echo "  kill PID $p"
  kill "$p" 2>/dev/null
done

# 等旧实例真的退出（并放开控制台端口）再删锁；否则「锁删了但进程还活着」就是双实例。
sleep 3
left=$(bridge_pids)
if [ -n "$left" ]; then
  echo
  echo "仍有桥接进程存活：$left"
  echo "重启已中止：避免双实例互相抢消息、互相覆盖 state。请手动 kill 上面的 PID 后重试。"
  read -r -p "按回车关闭…" _
  exit 1
fi

rm -f state/bridge.lock
if [ "$(uname)" = "Darwin" ]; then
  open -a Terminal "$ROOT/start.command"
  echo "已在新的终端窗口里启动守护。"
else
  nohup "$ROOT/start.command" >/dev/null 2>&1 &
  echo "已在后台启动守护（日志见 state/bridge.log）。"
fi
