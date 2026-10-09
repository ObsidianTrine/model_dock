#!/usr/bin/env node
// dev 实例存活探测——供 run_dev.sh / run_dev.bat 启动前检测「本沙箱已有运行中的网关」。
//
// 背景：一个沙箱只允许一个网关实例（gateway.json 单槽：pid/port/admin_token/设备记忆）。
// 沙箱内已有活实例时，`gateway start` 会打一行黄字后正常退出（exit 0），而 run_dev 把
// 输出重定向进日志文件、终端看不见，浏览器却照开在目标端口 →「无法访问此网站」不知为何。
//
// 判定与 src/gateway/state.ts 的 gatewayLive() 同语义（三重校验防 pid 复用误判）：
//   1. gateway.json 可读且 pid/port 合法；
//   2. pid 存活（process.kill(pid, 0)）；
//   3. health 端点 200 且 started_at 与状态文件一致。
// 活着 → stdout 输出单行四字段（空格分隔）：port pid started_at admin_token
// （缺失字段以 "-" 占位，方便 bat 的 for /f tokens 定位）；不活/异常 → 退出码 1、无输出。
import fs from 'node:fs'

const file = process.argv[2]
if (!file) process.exit(1)

let s
try {
  s = JSON.parse(fs.readFileSync(file, 'utf8'))
} catch {
  process.exit(1)
}
if (!s || !Number.isInteger(s.pid) || !Number.isInteger(s.port)) process.exit(1)
try {
  process.kill(s.pid, 0)
} catch {
  process.exit(1)
}

try {
  const res = await fetch(`http://127.0.0.1:${s.port}/_modeldock/health`, { signal: AbortSignal.timeout(1500) })
  if (!res.ok) process.exit(1)
  const j = await res.json()
  if (s.started_at && j?.started_at && j.started_at !== s.started_at) process.exit(1)
  console.log([s.port, s.pid, s.started_at || '-', s.admin_token || '-'].join(' '))
} catch {
  process.exit(1)
}
