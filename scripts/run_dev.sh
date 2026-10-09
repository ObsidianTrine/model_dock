#!/bin/sh
# ModelDock — 功能验证页面（开发调试）脚本
#
# 作用：用 tsx watch 起 dev 网关（改 src/** 自动重启、立即生效），
#       等网关就绪后自动打开 Web 控制台页面，让你直接验证界面是否正常。
#
# 隔离：dev 实例完全沙箱化——配置/状态/日志/客户端写入全部落在 ~/.modeldock-dev，
#       与生产（~/.modeldock + 8687 + 真实客户端文件）互不影响；dev 里随便接入、
#       切换、改配置都不会碰生产。首次启动会从生产复制一份服务配置（含密钥文件），
#       之后两边各自独立。
#
# 用法：
#   ./scripts/run_dev.sh                默认端口 8890（用户 dev 端口；8687 是生产端口，禁止占用）
#   ./scripts/run_dev.sh 18990          指定端口（改代码即生效，刷新浏览器即可）
#   agent 起测试实例：勿共用本脚本默认沙箱（~/.modeldock-dev 是用户 dev 实例专属），
#   按 AGENTS.md「端口与实例约定」成对覆盖沙箱与端口：MODELRDOCK_FAKE_HOME=<独立目录> ./scripts/run_dev.sh 189xx
#
# 退出：Ctrl+C 停止网关；改到 src/ 下任意文件会自动重启。
set -e
# 脚本位于 scripts/，仓库根是其上一级：后续相对路径（scripts/dev-instance-probe.mjs、
# src/cli.ts、package.json）一律以仓库根为锚点。
cd "$(dirname "$0")/.."

PORT="${1:-8890}"   # 默认 8890（用户 dev 测试端口）；8687 为生产常驻实例专用，任何 dev 实例不得监听
LOG="/tmp/modeldock-dev.$(date +%Y%m%d-%H%M%S).log"   # 日期+时间命名，每次启动新文件不冲突

# dev 沙箱：整个 home 重定向到 ~/.modeldock-dev（客户端配置 ~/.claude 等也随之隔离）；
# DEV_SANDBOX 标志让 Web 控制台显示沙箱徽标并在写操作确认里提示"不影响生产"
export MODELRDOCK_DEV_SANDBOX=1
export MODELRDOCK_FAKE_HOME="${MODELRDOCK_FAKE_HOME:-$HOME/.modeldock-dev}"
mkdir -p "$MODELRDOCK_FAKE_HOME/.modeldock"

# 首次使用沙箱：从生产复制服务配置与密钥（此后两边互不影响）
if [ ! -f "$MODELRDOCK_FAKE_HOME/.modeldock/config.toml" ] && [ -f "$HOME/.modeldock/config.toml" ]; then
  cp "$HOME/.modeldock/config.toml" "$MODELRDOCK_FAKE_HOME/.modeldock/config.toml"
  [ -f "$HOME/.modeldock/secrets.json" ] && cp "$HOME/.modeldock/secrets.json" "$MODELRDOCK_FAKE_HOME/.modeldock/secrets.json"
  echo "▶ 已从生产复制服务配置到沙箱（${MODELRDOCK_FAKE_HOME}），两边此后互不影响"
fi

if [ "$(uname)" = "Darwin" ]; then OPEN="open"; else OPEN="xdg-open"; fi

# 沙箱内已有实例探测（一个沙箱只允许一个网关实例）：
# 不探测的后果——gateway start 见已有实例会打一行黄字后正常退出（exit 0），输出进了日志文件
# 终端看不见，脚本照样"成功"开浏览器 → 页面连接被拒却不知为何。这里先探测并明说（判定与
# src/gateway/state.ts 的 gatewayLive 同语义：pid 存活 + health + started_at 三重校验）。
PROBE="$(node scripts/dev-instance-probe.mjs "$MODELRDOCK_FAKE_HOME/.modeldock/gateway.json" 2>/dev/null || true)"
if [ -n "${PROBE}" ]; then
  OLD_PORT="$(printf '%s\n' "${PROBE}" | cut -d' ' -f1)"
  OLD_PID="$(printf '%s\n' "${PROBE}" | cut -d' ' -f2)"
  OLD_STARTED="$(printf '%s\n' "${PROBE}" | cut -d' ' -f3)"
  OLD_TOKEN="$(printf '%s\n' "${PROBE}" | cut -d' ' -f4)"
  if [ "${OLD_PORT}" = "${PORT}" ]; then
    echo "✓ 本沙箱已有 dev 实例正跑在 ${PORT}（tsx watch 随 src 改动热重载，直接用即可）："
    echo "  http://127.0.0.1:${PORT}/_modeldock/ui?token=${OLD_TOKEN}"
    "$OPEN" "http://127.0.0.1:${PORT}/_modeldock/ui?token=${OLD_TOKEN}" >/dev/null 2>&1 || true
    exit 0
  fi
  echo "✗ 本沙箱（${MODELRDOCK_FAKE_HOME}）已有另一个 ModelDock 实例：端口 ${OLD_PORT}（pid ${OLD_PID}，${OLD_STARTED} 启动）。"
  echo "  同一沙箱只允许一个实例：此刻再起会被单实例保护静默拒绝（提示写进日志、浏览器却开在 ${PORT} →「无法访问此网站」）。"
  echo "  运行中旧实例的直链（注意：非 tsx watch 起的可能是旧代码）："
  echo "    http://127.0.0.1:${OLD_PORT}/_modeldock/ui?token=${OLD_TOKEN}"
  echo "  三选一："
  echo "  ① 直接用旧实例（打开上面直链）；"
  echo "  ② 先停它再跑本脚本：MODELRDOCK_FAKE_HOME=\"${MODELRDOCK_FAKE_HOME}\" npx tsx src/cli.ts gateway stop"
  echo "  ③ 给新实例换独立沙箱：MODELRDOCK_FAKE_HOME=/tmp/modeldock-test ./scripts/run_dev.sh ${PORT}"
  exit 1
fi

# 端口占用预检（TCP 级）：任何监听中的端口都不复用——网关遇到占用会静默换端口，
# 脚本却按原端口开浏览器，必须在这里挡下（含生产 8687，红线：dev 实例不得监听 8687）
if node -e "const n=require('net');const s=n.connect(Number(process.argv[1]),'127.0.0.1');s.on('connect',()=>{s.destroy();process.exit(0)});s.on('error',()=>process.exit(1));setTimeout(()=>process.exit(1),1500)" "$PORT"; then
  echo "✗ 端口 $PORT 已被占用（监听中的服务不一定是 ModelDock），dev 网关不能共用。"
  echo "  请换一个端口再跑：./scripts/run_dev.sh $((PORT + 1))"
  exit 1
fi

echo
echo "▶ 启动 dev 网关（端口 ${PORT}，tsx watch，改 src 自动重载；沙箱：${MODELRDOCK_FAKE_HOME}）…"
npx tsx watch src/cli.ts gateway start --port "$PORT" > "$LOG" 2>&1 &
GW_PID=$!

# 轮询健康检查，网关就绪后打开控制台
i=0
while [ "$i" -lt 40 ]; do
  if curl -sf "http://127.0.0.1:$PORT/_modeldock/health" >/dev/null 2>&1; then break; fi
  sleep 0.5
  i=$((i + 1))
done
if [ "$i" -ge 40 ]; then
  echo "✗ 等待 20 秒后 http://127.0.0.1:${PORT} 仍未就绪——网关多半没起来（常见：单实例拒绝启动、配置错误、tsx 编译报错）。"
  echo "  网关进程输出尾部如下（完整日志：${LOG}）："
  tail -n 15 "${LOG}" | sed 's/^/    /'
  pkill -P "${GW_PID}" 2>/dev/null || true
  kill "${GW_PID}" 2>/dev/null || true
  exit 1
fi

echo "▶ 打开控制台：http://127.0.0.1:${PORT}/_modeldock/ui（自动携带管理令牌）"
echo "  （页面内容在网关进程内嵌，改代码自动重启后请刷新浏览器；日志：${LOG}）"
TOKEN=$(node -p "JSON.parse(require('fs').readFileSync(require('path').join(process.env.MODELRDOCK_FAKE_HOME,'.modeldock','gateway.json'),'utf8')).admin_token" 2>/dev/null || true)
if [ -n "${TOKEN}" ]; then
  # 网关输出重定向进日志（非 TTY），启动横幅按安全约定不打印 token——这里对齐 Windows 网关窗口的体验，把带令牌的直链打在交互终端
  echo "  控制台直链（含令牌，可复制到其他浏览器登录）：http://127.0.0.1:${PORT}/_modeldock/ui?token=${TOKEN}"
  "$OPEN" "http://127.0.0.1:${PORT}/_modeldock/ui?token=${TOKEN}" >/dev/null 2>&1 || true
else
  echo "  ✗ 未能从沙箱 gateway.json 读到 admin_token，已打开未登录页，按页面指引追加 ?token= 即可"
  "$OPEN" "http://127.0.0.1:${PORT}/_modeldock/ui" >/dev/null 2>&1 || true
fi

# 前台挂住，Ctrl+C 退出
wait "$GW_PID"
