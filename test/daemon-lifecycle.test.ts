import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { fakeHome } from './helpers.js'
import { gatewayStatePath } from '../src/util/paths.js'

// 网关守护进程生命周期端到端：真 CLI 子进程 + 独立沙箱 + listen(0) 随机端口（绝不写死端口，
// 更不碰 8687/8890）。覆盖此前零测试的单实例锁、陈旧锁复核接管、stop 复核与 status 输出。
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CLI_ENTRY = path.join(REPO_ROOT, 'src', 'cli.ts')
const TSX_LOADER = pathToFileURL(createRequire(path.join(REPO_ROOT, 'package.json')).resolve('tsx/esm')).href

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
  const env = { ...process.env, MODELRDOCK_FAKE_HOME: sandbox, MODELRDOCK_LANG: 'zh' }
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
})
