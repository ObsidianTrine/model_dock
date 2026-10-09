// vitest setupFiles：worker 内心跳（每个测试文件的 worker 里各挂一个）。
// **默认关闭**，VITEST_WATCHDOG=1 时才挂（vitest.config 只在该开关下注册本 setupFile）。
// 心跳写 $TMPDIR/vitest-heartbeat.log（appendFileSync 绕开 vitest 的 stdout 转发——
// silent: 'passed-only' 会吞掉 worker 的 console 输出，但吞不掉文件写入）。
// 主进程 reporter（vitest-watchdog.mjs，同开关）每 10s 读该文件打进 CI 日志。
// worker 事件循环被同步阻塞时心跳停跳：最后一条心跳的时间戳即卡死时刻。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const HEARTBEAT_FILE = path.join(os.tmpdir(), 'vitest-heartbeat.log')

if (process.env.VITEST_WATCHDOG === '1') {
  const t0 = Date.now()
  const iv = setInterval(() => {
    let handles = 'n/a'
    try {
      handles = (process._getActiveHandles?.() ?? [])
        .map((h) => h?.constructor?.name ?? typeof h)
        .filter((n, i, a) => a.indexOf(n) === i)
        .join(',')
    } catch {}
    const line = `[WORKER-HB] ${new Date().toISOString()} pid=${process.pid} up=${Math.round((Date.now() - t0) / 1000)}s mem=${Math.round(process.memoryUsage().rss / 1e6)}MB handles=[${handles}]`
    try {
      fs.appendFileSync(HEARTBEAT_FILE, line + '\n')
    } catch {}
  }, 5000)
  iv.unref?.()
}
