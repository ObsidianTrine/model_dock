// vitest 自定义 reporter：测试悬死排查观测器（跑在 vitest 主进程）。
// 观测输出默认关闭，VITEST_WATCHDOG=1 时开启——FILE-START/DONE 每文件一行、
// WATCHDOG 每 10s 一组，日常跑测试不该有这些噪音。
// 例外：8 分钟无文件进展的自毁检查（exit 86）常开——健康时零输出，悬死时
// 快速失败并留现场（触发 test.yml 诊断步骤），不再静默等 job 超时。
// 三个观测面：
//   1. [FILE-START]/[FILE-DONE] —— 文件级生命周期（默认 reporter 只打完成行，卡死时看不出卡在哪）
//   2. [WATCHDOG] 每 10s 从主进程扫描 /proc（纯 fs 读取，不依赖 ps/权限）：
//      worker 的 state(R/S/D/Z)、wchan(内核等待通道——区分管道写阻塞/futex/IO)、
//      utime/stime(CPU 时钟——区分死循环与挂起)、线程数、上下文切换数
//   3. 心跳文件尾部（watchdog-heartbeat.mjs 写入）——worker 事件循环活性
// 解读指南（卡死时看最后一条 WATCHDOG）：
//   wchan=pipe_write 且 state=S → worker 卡在管道写（stdout 转发死锁）
//   state=R 且 utime/stime 线性暴涨（stime≫utime）→ 同步 fs syscall 风暴死循环
//   state=D → 不可中断 IO（文件系统层）
//   心跳停跳而 worker 存活 → worker 事件循环被同步阻塞

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 与 watchdog-heartbeat.mjs 中的 HEARTBEAT_FILE 一致（不 import：该模块顶层会挂
// interval，主进程 reporter 不需要它）
const HEARTBEAT_FILE = path.join(os.tmpdir(), 'vitest-heartbeat.log')

const pending = new Set()
const pick = (m) => m?.moduleId ?? m?.filepath ?? m?.name ?? m?.file?.filepath ?? String(m)
const now = () => new Date().toISOString()

function scanNodeProcs() {
  if (!fs.existsSync('/proc')) return { note: 'non-linux' }
  const rows = []
  let pids
  try {
    pids = fs.readdirSync('/proc').filter((p) => /^\d+$/.test(p))
  } catch {
    return { note: 'proc-unreadable' }
  }
  for (const pid of pids) {
    try {
      const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim()
      if (!/node|vitest/.test(cmd)) continue
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
      const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
      // rest[0]=state, rest[11]=utime, rest[12]=stime（tick，100/s）
      const state = rest[0]
      const utime = Number(rest[11])
      const stime = Number(rest[12])
      let wchan = ''
      try {
        wchan = fs.readFileSync(`/proc/${pid}/wchan`, 'utf8').trim() || '-'
      } catch {}
      let threads = ''
      let ctxt = ''
      try {
        const st = fs.readFileSync(`/proc/${pid}/status`, 'utf8')
        threads = /Threads:\s+(\d+)/.exec(st)?.[1] ?? '?'
        const v = /voluntary_ctxt_switches:\s+(\d+)/.exec(st)?.[1]
        const nv = /nonvoluntary_ctxt_switches:\s+(\d+)/.exec(st)?.[1]
        ctxt = `${v ?? '?'}/${nv ?? '?'}`
      } catch {}
      rows.push({ pid, state, wchan, cpu: `${utime}/${stime}`, th: threads, ctx: ctxt, cmd: cmd.slice(0, 90) })
    } catch {
      /* 进程已退出等，跳过 */
    }
  }
  return rows
}

export default function watchdog() {
  const enabled = process.env.VITEST_WATCHDOG === '1'
  // 调试模式下截断心跳文件：只看本次 run 的心跳
  try {
    if (enabled) fs.rmSync(HEARTBEAT_FILE, { force: true })
  } catch {}
  // 自毁阈值：8 分钟无文件开始/完成进展 → 打印现场并 exit(86)。不受 enabled
  // 门控（健康时零输出）；进展时间戳在 FILE-START/DONE 里无论开关都更新。
  const SELF_DESTRUCT_MS = 8 * 60_000
  let lastProgressAt = Date.now()
  const timer = setInterval(() => {
    const idleMs = Date.now() - lastProgressAt
    if (idleMs > SELF_DESTRUCT_MS) {
      const procs = scanNodeProcs()
      console.log(
        `[WATCHDOG] ${now()} 已 ${Math.round(idleMs / 1000)}s 无文件进展，判定悬死，主动退出（exit 86）。\n` +
          `[WATCHDOG] pending=[${[...pending].join(' | ') || '无'}]\n[WATCHDOG] procs=${JSON.stringify(procs)}`,
      )
      process.exit(86)
    }
    if (!enabled) return
    const procs = scanNodeProcs()
    console.log(
      `[WATCHDOG] ${now()} idle=${Math.round(idleMs / 1000)}s pending=[${[...pending].join(' | ') || '无'}]\n[WATCHDOG] procs=${JSON.stringify(procs)}`,
    )
    try {
      const hb = fs.readFileSync(HEARTBEAT_FILE, 'utf8').split('\n').filter(Boolean)
      console.log(`[WATCHDOG] heartbeat 尾部:\n${hb.slice(-6).join('\n')}`)
    } catch {
      console.log('[WATCHDOG] heartbeat 尚无内容')
    }
  }, 10_000)
  timer.unref?.()
  return {
    onTestModuleStart(m) {
      const name = pick(m)
      pending.add(name)
      lastProgressAt = Date.now()
      if (!enabled) return
      console.log(`[FILE-START] ${name} @ ${now()}`)
    },
    onTestModuleEnd(m) {
      const name = pick(m)
      pending.delete(name)
      lastProgressAt = Date.now()
      if (!enabled) return
      console.log(`[FILE-DONE]   ${name} @ ${now()}`)
    },
    onTestRunEnd() {
      clearInterval(timer)
    },
  }
}
