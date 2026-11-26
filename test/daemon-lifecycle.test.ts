import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { fakeHome, REPO_ROOT, TSX_LOADER } from './helpers.js'
import { gatewayStatePath, gatewayLockPath } from '../src/util/paths.js'
import { localDateStr } from '../src/util/index.js'

// 网关守护进程生命周期端到端：真 CLI 子进程 + 独立沙箱 + listen(0) 随机端口（绝不写死端口，
// 更不碰 8687/8890）。覆盖此前零测试的单实例锁、陈旧锁复核接管、stop 复核与 status 输出。
const CLI_ENTRY = path.join(REPO_ROOT, 'src', 'cli.ts')

/** 取一个当前空闲的 TCP 端口（listen(0) 由内核分配，关闭后瞬时占用窗口可接受，lan.test.ts 同款） */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port
      srv.close(() => resolve(port))
    })
  })
}

/** 确定性的死 pid：同步起一个立即退出的进程，拿它的 pid（避免猜大数撞上活进程） */
function deadPid(): number {
  const r = spawnSync(process.execPath, ['-e', ''], { timeout: 30_000 })
  if (r.pid == null) throw new Error('无法制造死 pid')
  return r.pid
}

function childEnv(sandbox: string): NodeJS.ProcessEnv {
  // 关更新检查：首启后的异步查更新会把真实 started_at 连同 update_check 写回 gateway.json，
  // 网络往返的落地时间可能闯进篡改用例的窗口（真实值覆盖篡改值 → 二次 start 走 CLI 层
  // 「已在运行」优雅分支 exit 0，纵深断言拿到 0）——慢速 arm64 runner 上实测翻车
  const env: NodeJS.ProcessEnv = { ...process.env, MODELRDOCK_FAKE_HOME: sandbox, MODELRDOCK_LANG: 'zh', MODELRDOCK_DISABLE_UPDATE_CHECK: '1' }
  delete env.MODELRDOCK_HOME
  return env
}

/** 跑一次真实 CLI（输出断言用中文：显式 MODELRDOCK_LANG=zh 固定语言链）。
 *  必须异步 spawn 而非 spawnSync：stop 用例里网关是本进程的子进程，spawnSync 阻塞
 *  事件循环会让它退出后变僵尸无人收尸，stop 的 pid 复核（kill(pid,0)）永远看到
 *  「存活」，误报「未能停止」。异步跑时 libuv 正常 waitpid 收尸，与真实终端一致。 */
function runCli(sandbox: string, args: string[]): Promise<{ status: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--import', TSX_LOADER, CLI_ENTRY, ...args], {
      cwd: sandbox,
      env: childEnv(sandbox),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    const timer = setTimeout(() => { try { child.kill('SIGKILL') } catch { /* 已退出 */ } }, 120_000)
    child.stdout?.on('data', (d: Buffer) => { out += d.toString() })
    child.stderr?.on('data', (d: Buffer) => { out += d.toString() })
    child.on('error', (e) => { clearTimeout(timer); resolve({ status: -1, output: out + String(e) }) })
    child.on('close', (code) => { clearTimeout(timer); resolve({ status: code ?? -1, output: out }) })
  })
}

/** 前台拉起网关子进程（调用方负责 finally 停止） */
function startGateway(sandbox: string, port: number): ChildProcess {
  const child = spawn(process.execPath, ['--import', TSX_LOADER, CLI_ENTRY, 'gateway', 'start', '--port', String(port)], {
    cwd: sandbox,
    env: childEnv(sandbox),
    stdio: 'ignore',
  })
  return child
}

async function waitHealthy(port: number, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/_modeldock/health`, { signal: AbortSignal.timeout(1000) })
      if (res.ok) return
    } catch { /* 未就绪继续等 */ }
    if (Date.now() > deadline) throw new Error(`网关 ${port} 未在超时内就绪`)
    await new Promise((r) => setTimeout(r, 250))
  }
}

async function waitGone(port: number, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      await fetch(`http://127.0.0.1:${port}/_modeldock/health`, { signal: AbortSignal.timeout(1000) })
    } catch {
      return
    }
    if (Date.now() > deadline) throw new Error(`网关 ${port} 停止后 health 仍可达`)
    await new Promise((r) => setTimeout(r, 250))
  }
}

async function exitOf(child: ChildProcess, timeoutMs = 10_000): Promise<void> {
  if (child.exitCode != null) return
  await new Promise<void>((resolve) => {
    child.once('exit', () => resolve())
    setTimeout(resolve, timeoutMs)
  })
}

/** 停掉自己拉起的子进程并等它真正退出（Windows 上沙箱目录被占用会删不掉，必须先等 exit） */
async function stopChild(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode != null) return
  child.kill('SIGKILL') // 清理用硬杀即可；优雅停机语义由 stop 用例专门验证
  await exitOf(child)
}

/**
 * 前台拉起网关子进程并收集输出（调用方负责 finally 停止）。并发启动用例要读败者的报错，
 * 所以不能像 startGateway 那样 stdio: 'ignore'。
 */
function startGatewayCaptured(sandbox: string, port: number): { child: ChildProcess; output: () => string } {
  const child = spawn(process.execPath, ['--import', TSX_LOADER, CLI_ENTRY, 'gateway', 'start', '--port', String(port)], {
    cwd: sandbox,
    env: childEnv(sandbox),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  child.stdout?.on('data', (d: Buffer) => { out += d.toString() })
  child.stderr?.on('data', (d: Buffer) => { out += d.toString() })
  return { child, output: () => out }
}

async function healthOk(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/_modeldock/health`, { signal: AbortSignal.timeout(1000) })
    return res.ok
  } catch {
    return false
  }
}

/** 实例锁文件内容（审计 P-06b）：锁是 daemon 启动的第一道闸，测试直接读盘对账 */
function readLock(): { pid: number; port: number; acquired_at: string } | null {
  try {
    return JSON.parse(fs.readFileSync(gatewayLockPath(), 'utf8'))
  } catch {
    return null
  }
}

function writeLock(state: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(gatewayLockPath()), { recursive: true })
  fs.writeFileSync(gatewayLockPath(), JSON.stringify(state, null, 2))
}

function readState(sandbox: string): { pid: number; port: number; started_at: string } {
  return JSON.parse(fs.readFileSync(gatewayStatePath(), 'utf8'))
}

/** health 首次可达（listen 成功）与 gateway.json 落盘（writeGatewayState）之间存在窗口，
 *  高负载下测试直读会 ENOENT（偶发红，实测轮换命中不同用例）——读前等文件出现。 */
async function waitStateFile(timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (fs.existsSync(gatewayStatePath())) return
    if (Date.now() > deadline) throw new Error('gateway.json 未在期限内落盘')
    await new Promise((r) => setTimeout(r, 100))
  }
}

/** 读 state（接管重写窗口内文件可能被 clear 后短暂缺失）：缺失/损坏返回 null 交调用方重试 */
function readStateSafe(): { pid: number; port: number; started_at: string } | null {
  try {
    return JSON.parse(fs.readFileSync(gatewayStatePath(), 'utf8'))
  } catch {
    return null
  }
}

function writeState(sandbox: string, state: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(gatewayStatePath()), { recursive: true })
  fs.writeFileSync(gatewayStatePath(), JSON.stringify(state, null, 2))
}

describe('网关守护进程生命周期（真实 CLI 子进程 + 独立沙箱）', () => {
  it('start → health 可达、state 落盘 → 二次 start 被单实例保护拒绝 → status 显示运行中', async () => {
    const h = fakeHome()
    let child: ChildProcess | undefined
    try {
      const port = await freePort()
      child = startGateway(h.home, port)
      await waitHealthy(port)

      // state 文件与子进程对账：pid 就是拉起的子进程
      await waitStateFile()
      const state = readState(h.home)
      expect(state.pid).toBe(child.pid)
      expect(state.port).toBe(port)

      // 单实例保护：另起端口再 start，被拒绝且优雅退出（exit 0）
      const other = await freePort()
      const second = await runCli(h.home, ['gateway', 'start', '--port', String(other)])
      expect(second.output).toContain('网关已在运行')

      // status 读活实例：运行中 + 管理端点摘要
      const status = await runCli(h.home, ['gateway', 'status'])
      expect(status.status).toBe(0)
      expect(status.output).toContain('网关运行中')
      expect(status.output).toContain('active_profile')
    } finally {
      await stopChild(child)
      h.restore()
    }
  }, 120_000)

  it('stop：SIGTERM 优雅退出、health 不再可达、status 转为未运行', async () => {
    const h = fakeHome()
    let child: ChildProcess | undefined
    try {
      const port = await freePort()
      child = startGateway(h.home, port)
      await waitHealthy(port)

      const stopped = await runCli(h.home, ['gateway', 'stop'])
      expect(stopped.output).toContain('网关已停止')
      await exitOf(child)
      await waitGone(port)

      const status = await runCli(h.home, ['gateway', 'status'])
      expect(status.status).toBe(0)
      expect(status.output).toContain('网关未在运行')
    } finally {
      await stopChild(child)
      h.restore()
    }
  }, 120_000)

  it('陈旧 gateway.json（死 pid）不阻断启动：正常接管并回写新 pid', async () => {
    const h = fakeHome()
    let child: ChildProcess | undefined
    try {
      writeState(h.home, {
        pid: deadPid(),
        port: 59999,
        admin_token: 'mdkadm_' + '0'.repeat(32),
        started_at: '2026-01-01T00:00:00',
      })
      const port = await freePort()
      child = startGateway(h.home, port)
      await waitHealthy(port)
      // 监听先于落盘（startForeground 在 listen 之后才 writeGatewayState）：health 就绪的瞬间
      // state 可能还是上面预置的陈旧 pid（CI 高负载下偶发挂），轮询等新实例回写完成再断言
      const deadline = Date.now() + 10_000
      let state = readStateSafe()
      while (state?.pid !== child.pid && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100))
        state = readStateSafe()
      }

      expect(state?.pid).toBe(child.pid)
      expect(state?.port).toBe(port)
    } finally {
      await stopChild(child)
      h.restore()
    }
  }, 120_000)

  it('纵深防御：gateway.json 被篡改（pid 活但 started_at 对不上）时二次 start 仍被 startForeground 拦下（exit 1）', async () => {
    const h = fakeHome()
    let child: ChildProcess | undefined
    try {
      const port = await freePort()
      child = startGateway(h.home, port)
      await waitHealthy(port)
      await waitStateFile()
      const real = readState(h.home)

      // 伪造 started_at 骗过 CLI 层 gatewayLive 的三重校验，但 health 仍是真网关
      writeState(h.home, { ...real, started_at: '2000-01-01T00:00:00' })
      const second = await runCli(h.home, ['gateway', 'start', '--port', String(await freePort())])
      expect(second.status).toBe(1)
      expect(second.output).toContain('网关已在运行')
    } finally {
      await stopChild(child)
      h.restore()
    }
  }, 120_000)

  it('无响应实例（pid 活、健康端点不通）：status 报「网关无响应」；stop 复核 pid 已非网关进程时不误杀，只清陈旧状态', async () => {
    const h = fakeHome()
    let dummy: ChildProcess | undefined
    try {
      // 无辜的存活进程（命令行不含 gateway start / modeldock / src/cli.ts）冒充被复用的 pid
      dummy = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
      await new Promise<void>((resolve, reject) => {
        dummy!.once('spawn', () => resolve())
        dummy!.once('error', reject)
      })
      const port = await freePort() // 无人监听 → health 连接被拒 → unresponsive（秒级，不占端口）
      writeState(h.home, {
        pid: dummy.pid,
        port,
        admin_token: 'mdkadm_' + '0'.repeat(32),
        started_at: '2026-01-01T00:00:00',
      })

      const status = await runCli(h.home, ['gateway', 'status'])
      expect(status.output).toContain('网关无响应')
      expect(status.output).not.toContain('网关未在运行')
      expect(fs.existsSync(gatewayStatePath())).toBe(true) // 三态：无响应不清状态文件

      const stopped = await runCli(h.home, ['gateway', 'stop'])
      expect(stopped.output).toContain('网关无响应')
      expect(stopped.output).toContain('已清理陈旧状态文件')
      // 无辜进程（疑似被复用的 pid）必须活着
      expect(() => process.kill(dummy!.pid!, 0)).not.toThrow()
      expect(fs.existsSync(gatewayStatePath())).toBe(false)
    } finally {
      await stopChild(dummy)
      h.restore()
    }
  }, 120_000)

  /** --daemon 真链路 CLI 子进程（内部 spawnDaemonAndWait 拉起 daemon 孙进程）。
   *  必须异步 spawn + 逐段收集输出：就绪后 CLI 是否退出正是本组用例的被测行为。 */
  function spawnDaemonCli(h: { home: string }, port: number): { child: ChildProcess; output: () => string; exit: Promise<{ code: number | null; at: number }> } {
    const cli = spawn(process.execPath, ['--import', TSX_LOADER, CLI_ENTRY, 'gateway', 'start', '--port', String(port), '--daemon'], {
      cwd: h.home,
      env: childEnv(h.home),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    cli.stdout?.on('data', (d: Buffer) => { out += d.toString() })
    cli.stderr?.on('data', (d: Buffer) => { out += d.toString() })
    const exit = new Promise<{ code: number | null; at: number }>((resolve) => {
      cli.on('error', () => resolve({ code: -1, at: Date.now() }))
      cli.on('close', (code) => resolve({ code, at: Date.now() }))
    })
    return { child: cli, output: () => out, exit }
  }

  it('CORRECT-07：--daemon 就绪后 CLI 秒级退出（不挂住），daemon 脱离 CLI 独立存活', async () => {
    const h = fakeHome()
    try {
      const port = await freePort()
      const { output, exit } = spawnDaemonCli(h, port)
      // readiness 时刻为基准：修复后 CLI 应立刻退出（原 bug 在此钉住 ≥45s 不返回）
      await waitHealthy(port)
      const readyAt = Date.now()
      const exitRes = await Promise.race([
        exit,
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('CORRECT-07 复现：CLI 就绪后 5s 未退出')), 5_000)),
      ])
      expect(exitRes.code).toBe(0)
      expect(exitRes.at - readyAt).toBeLessThan(5_000)
      expect(output()).toContain('网关已后台启动')

      // daemon 脱离 CLI 独立存活：CLI 退出后 health 仍可达、登记 pid 活着（detached 语义）
      await waitHealthy(port, 5_000)
      await waitStateFile()
      const state = readStateSafe()
      expect(state).toBeTruthy()
      expect(() => process.kill(state!.pid, 0)).not.toThrow()

      // fd 2 接管产物：daemon 日志文件存在（启动期无报错时可为空）
      expect(fs.existsSync(path.join(h.home, '.modeldock', 'logs', `daemon-${localDateStr()}.log`))).toBe(true)

      // 清理自拉进程并核实端口释放
      const stopped = await runCli(h.home, ['gateway', 'stop'])
      expect(stopped.output).toContain('网关已停止')
      await waitGone(port)
    } finally {
      h.restore()
    }
  }, 60_000)

  it('启动失败场景：坏 argv（--port 非数字）时 CLI 限时退出并报可操作端口错误（先验拦下，不经 daemon 崩溃路径）', async () => {
    const h = fakeHome()
    try {
      // --port 先验（rev-cli-ops-night）：非法值在 spawn daemon 前就被 exitWithError 拦下，
      // 用户直接拿到「端口写错了」+ 示例，不再走 listen(NaN) → daemon 崩溃路径（旧断言的
      // 「网关启动超时」+ daemon 日志 fd 2 接管随该路径一并消失，fd 2 机制对真实崩溃仍生效）
      const { output, exit } = spawnDaemonCli(h, 'notanumber' as unknown as number)
      const exitRes = await Promise.race([
        exit,
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('坏 argv 场景 CLI 15s 未退出')), 15_000)),
      ])
      expect(exitRes.code).toBe(1)
      // 报错不蒸发：端口口径 + 实际收到值 + 修复示例都到用户眼前
      expect(output()).toContain('端口必须是 1–65535 的整数')
      expect(output()).toContain('notanumber')
      expect(output()).toContain('gateway start --port 18901')
      // daemon 未被拉起（校验发生在 spawn 之前，吸收 2026-11-12 审查 F12 批次断言）
      expect(fs.existsSync(path.join(h.home, '.modeldock', 'gateway.json'))).toBe(false)
    } finally {
      h.restore()
    }
  }, 60_000)

  // ── 实例锁（审计 P-06b）─────────────────────────────────────────────────
  // 原缺陷：读 gateway.json → 判 pid → healthOk → 写新状态之间没有锁。两个进程同时通过检查时，
  // 第二个被 listenWithRetry 顺延到下一个端口并覆盖 gateway.json，同一 home 出现两个 daemon。

  it('并发启动两次（同一 home、不同端口）：只有一个实例起来，另一个给可操作报错，gateway.json 只指向胜者', async () => {
    const h = fakeHome()
    let a: ChildProcess | undefined
    let b: ChildProcess | undefined
    try {
      const portA = await freePort()
      let portB = await freePort()
      while (portB === portA) portB = await freePort() // 端口不同：败者只能被实例锁挡下，而非被端口占用挡下
      const first = startGatewayCaptured(h.home, portA)
      const second = startGatewayCaptured(h.home, portB)
      a = first.child
      b = second.child
      const outA = first.output
      const outB = second.output

      // 两个进程几乎同时通过 gatewayProbe（无状态文件）→ 抢同一把实例锁，恰有一个 listen 成功
      const winner = await Promise.race([
        waitHealthy(portA, 60_000).then(() => 'a' as const),
        waitHealthy(portB, 60_000).then(() => 'b' as const),
      ])
      const loser = winner === 'a' ? b : a
      const loserPort = winner === 'a' ? portB : portA
      const winnerPort = winner === 'a' ? portA : portB
      const winnerChild = winner === 'a' ? a : b
      const loserOut = winner === 'a' ? outB : outA

      // 败者必须退出：不是「两个都活着」，也不是悄悄换个端口再起一个
      await exitOf(loser, 20_000)
      expect(loser.exitCode).not.toBeNull()
      expect(await healthOk(loserPort)).toBe(false)
      expect(loserOut()).toContain('已在运行')

      // 胜者是唯一实例：状态文件与锁都只指向它
      const deadline = Date.now() + 15_000
      let state = readStateSafe()
      while (state?.pid !== winnerChild!.pid && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100))
        state = readStateSafe()
      }
      expect(state?.pid).toBe(winnerChild!.pid)
      expect(state?.port).toBe(winnerPort)
      expect(readLock()?.pid).toBe(winnerChild!.pid)
      expect(await healthOk(winnerPort)).toBe(true)
    } finally {
      await stopChild(a)
      await stopChild(b)
      h.restore()
    }
  }, 180_000)

  it('实例锁被存活进程持有（gateway.json 尚未写）→ start 明确拒绝、给可操作提示、不落状态文件', async () => {
    const h = fakeHome()
    try {
      // 本进程 pid 充当「另一个正在启动的实例」：锁活、无状态文件——正是并发启动窗口的形态
      writeLock({ pid: process.pid, port: 59997, acquired_at: new Date().toISOString() })
      const port = await freePort()
      const r = await runCli(h.home, ['gateway', 'start', '--port', String(port)])
      expect(r.status).toBe(1)
      expect(r.output).toContain('已在运行或正在启动')
      expect(r.output).toContain('gateway.lock') // 可操作出路：确认无实例后删锁
      expect(fs.existsSync(gatewayStatePath())).toBe(false)
      expect(await healthOk(port)).toBe(false)
    } finally {
      h.restore()
    }
  }, 120_000)

  it('--daemon 启动：实例锁被存活进程持有时父 CLI 直接给可操作报错（不白等启动超时）', async () => {
    const h = fakeHome()
    try {
      writeLock({ pid: process.pid, port: 59997, acquired_at: new Date().toISOString() })
      const port = await freePort()
      const r = await runCli(h.home, ['gateway', 'start', '--port', String(port), '--daemon'])
      expect(r.status).toBe(1)
      expect(r.output).toContain('已在运行或正在启动')
      expect(r.output).toContain('gateway.lock')
      // 不是「启动超时」的笼统报错，也没落下状态文件
      expect(r.output).not.toContain('启动超时')
      expect(fs.existsSync(gatewayStatePath())).toBe(false)
      expect(await healthOk(port)).toBe(false)
    } finally {
      h.restore()
    }
  }, 120_000)

  it('残留实例锁（pid 已死）→ 新实例接管锁并正常启动', async () => {
    const h = fakeHome()
    let child: ChildProcess | undefined
    try {
      writeLock({ pid: deadPid(), port: 59998, acquired_at: '2026-01-01T00:00:00.000+08:00' })
      const port = await freePort()
      child = startGateway(h.home, port)
      await waitHealthy(port)
      const deadline = Date.now() + 15_000
      let state = readStateSafe()
      while (state?.pid !== child.pid && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100))
        state = readStateSafe()
      }
      expect(state?.pid).toBe(child.pid)
      // 锁被接管：内容换成新实例 pid（残留锁不阻断、也不残留误导信息）
      expect(readLock()?.pid).toBe(child.pid)
    } finally {
      await stopChild(child)
      h.restore()
    }
  }, 120_000)

  it('正常 stop 后实例锁释放（或失效）：下一次 start 能再次起来', async () => {
    const h = fakeHome()
    let child: ChildProcess | undefined
    let again: ChildProcess | undefined
    try {
      const port = await freePort()
      child = startGateway(h.home, port)
      await waitHealthy(port)

      const stopped = await runCli(h.home, ['gateway', 'stop'])
      expect(stopped.output).toContain('网关已停止')
      await exitOf(child)
      await waitGone(port)

      // unix 优雅退出走 exit 钩子删锁；Windows 硬杀走不到 → 锁留着但 pid 已死，必须可被接管
      const lock = readLock()
      if (lock) {
        expect(lock.pid).toBe(child.pid)
        expect(() => process.kill(lock.pid, 0)).toThrow()
      }

      const port2 = await freePort()
      again = startGateway(h.home, port2)
      await waitHealthy(port2)
      const deadline = Date.now() + 15_000
      let state = readStateSafe()
      while (state?.pid !== again.pid && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100))
        state = readStateSafe()
      }
      expect(state?.pid).toBe(again.pid)
      expect(readLock()?.pid).toBe(again.pid)
    } finally {
      await stopChild(child)
      await stopChild(again)
      h.restore()
    }
  }, 180_000)
})
