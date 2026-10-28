import { afterEach, describe, expect, it, vi } from 'vitest'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { fakeHome } from './helpers.js'
import {
  autostartLine,
  cmdGatewayLog,
  cmdGatewayRotateToken,
  cmdGatewayStart,
  cmdGatewayStatus,
  cmdUi,
} from '../src/cli/gatewaycmd.js'
import { requireGateway } from '../src/cli/shared.js'
import { readGatewayState, writeGatewayState, type GatewayStateFile } from '../src/gateway/state.js'
import type { AutostartStatus } from '../src/autostart.js'
import { localDateStr } from '../src/util/index.js'
import { logsDir, modeldockDir } from '../src/util/paths.js'

// gatewaycmd.ts 命令壳：start/stop/status/rotate/log/ui 的编排分支。活网关用「本地 http server
// + gateway.json（pid=本进程）」伪造（gatewayLive 三重校验：pid 存活 + /_modeldock/health 200 +
// started_at 一致），绝不真起网关、绝不碰生产实例。
// 跨文件 mock 纪律：uninstall.test.ts 把本模块的 cmdGatewayStop / sweepGatewayProcesses mock 成
// 桩（importOriginal 只摊开其余导出）——这两个符号本文件一律经 vi.importActual 取真实实现；
// 走静态 import 会按文件执行顺序解析到桩（isolate:false 下单文件跑绿、一起跑红的已知雷区）。
// 其余导出不受 uninstall 桩影响，照常静态 import。

class ExitError extends Error {
  constructor(public code: number | undefined) {
    super(`exit:${code}`)
  }
}

let logs: string[] = []
let errs: string[] = []
function captureConsole(): void {
  logs = []
  errs = []
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
    logs.push(a.map(String).join(' '))
  })
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
    errs.push(a.map(String).join(' '))
  })
}

function stubExit(): void {
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new ExitError(code)
  }) as never)
}

afterEach(() => {
  vi.mocked(process.exit).mockRestore?.()
  vi.mocked(console.log).mockRestore?.()
  vi.mocked(console.error).mockRestore?.()
})

function listenEphemeral(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port))
  })
}

/** 伪造活网关：健康端点 200（started_at 缺省即跳过一致性比对），其余路由按需返回。
 *  adminStatus 'broken' 时 /_modeldock/status 返回非 JSON（验证「管理端点无响应」分支）。
 *  ⚠ pid 用 process.pid 只为通过 pidAlive——严禁对这份假活状态跑 cmdGatewayStop（其 kill
 *  分支会 SIGTERM/SIGKILL 本 vitest worker 自身）。 */
async function fakeLiveGateway(opts: { adminStatus?: 'ok' | 'broken' } = {}): Promise<{
  port: number
  state: GatewayStateFile
  hits: string[]
  close: () => void
}> {
  const hits: string[] = []
  const server = http.createServer((req, res) => {
    hits.push(req.url ?? '')
    if (req.url === '/_modeldock/health') {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ ok: true }))
      return
    }
    if (req.url === '/_modeldock/admin/rotate') {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ console_url: 'http://127.0.0.1:9/console' }))
      return
    }
    if (req.url === '/_modeldock/status') {
      if (opts.adminStatus === 'broken') {
        res.end('not json at all')
        return
      }
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ active_profile: 'main', providers: ['pv'], profiles: [], harness: [], reloads: 3 }))
      return
    }
    res.statusCode = 404
    res.end('nope')
  })
  const port = await listenEphemeral(server)
  const state: GatewayStateFile = { port, pid: process.pid, admin_token: 'adm-t', started_at: 't-1' }
  fs.mkdirSync(modeldockDir(), { recursive: true })
  await writeGatewayState(state)
  return { port, state, hits, close: () => server.close() }
}

describe('cmdGatewayStart / requireGateway（活网关伪造）', () => {
  it('已在运行：只提示不重启', async () => {
    const h = fakeHome()
    captureConsole()
    const gw = await fakeLiveGateway()
    try {
      await cmdGatewayStart({})
      expect(logs.join('\n')).toContain('已在运行')
    } finally {
      gw.close()
      h.restore()
    }
  })

  it('requireGateway 活网关：返回状态文件内容', async () => {
    const h = fakeHome()
    captureConsole()
    const gw = await fakeLiveGateway()
    try {
      const live = await requireGateway()
      expect(live.admin_token).toBe('adm-t')
      expect(live.port).toBe(gw.port)
    } finally {
      gw.close()
      h.restore()
    }
  })
})

describe('cmdGatewayRotateToken', () => {
  it('活网关：调运行时轮换接口，旧 token 立即失效', async () => {
    const h = fakeHome()
    captureConsole()
    const gw = await fakeLiveGateway()
    try {
      await cmdGatewayRotateToken()
      expect(logs.join('\n')).toContain('已轮换')
      expect(logs.join('\n')).toContain('新控制台地址')
      expect(gw.hits).toContain('/_modeldock/admin/rotate')
    } finally {
      gw.close()
      h.restore()
    }
  })

  it('未运行且无状态文件：无需轮换', async () => {
    const h = fakeHome()
    captureConsole()
    try {
      await cmdGatewayRotateToken()
      expect(logs.join('\n')).toContain('无需轮换')
    } finally {
      h.restore()
    }
  })

  it('未运行但有残留状态文件：直接换 token 下次启动生效', async () => {
    const h = fakeHome()
    captureConsole()
    try {
      fs.mkdirSync(modeldockDir(), { recursive: true })
      await writeGatewayState({ port: 18971, pid: 99999999, admin_token: 'old-t', started_at: 't-0' })
      await cmdGatewayRotateToken()
      const st = await readGatewayState()
      expect(st?.admin_token).not.toBe('old-t')
      expect(st?.admin_token.startsWith('mdkadm')).toBe(true)
      expect(logs.join('\n')).toContain('下次网关启动生效')
    } finally {
      h.restore()
    }
  })
})

describe('cmdGatewayStatus', () => {
  it('未运行：给启动指引 + 自启未安装提示', async () => {
    const h = fakeHome()
    captureConsole()
    try {
      await cmdGatewayStatus()
      const out = logs.join('\n')
      expect(out).toContain('网关未在运行')
      expect(out).toContain('开机自启未安装')
    } finally {
      h.restore()
    }
  })

  it('活网关：管理端点数据（active_profile / providers / 热加载次数）', async () => {
    const h = fakeHome()
    captureConsole()
    const gw = await fakeLiveGateway()
    try {
      await cmdGatewayStatus()
      const out = logs.join('\n')
      expect(out).toContain('网关运行中')
      expect(out).toContain('active_profile: main')
      expect(out).toContain('配置热加载次数: 3')
    } finally {
      gw.close()
      h.restore()
    }
  })

  it('活网关但管理端点返回非 JSON：降级提示不抛错', async () => {
    const h = fakeHome()
    captureConsole()
    const gw = await fakeLiveGateway({ adminStatus: 'broken' })
    try {
      await cmdGatewayStatus()
      expect(logs.join('\n')).toContain('管理端点无响应')
    } finally {
      gw.close()
      h.restore()
    }
  })
})

describe('cmdGatewayStop / cmdUi / sweepGatewayProcesses', () => {
  it('未运行：直接提示（不清扫任何进程）', async () => {
    const h = fakeHome()
    captureConsole()
    try {
      // importActual 取真实实现：uninstall.test.ts 会把本符号 mock 成桩（见文件头注释）
      const real = await vi.importActual<typeof import('../src/cli/gatewaycmd.js')>('../src/cli/gatewaycmd.js')
      await real.cmdGatewayStop()
      expect(logs.join('\n')).toContain('网关未在运行')
    } finally {
      h.restore()
    }
  })

  it('cmdUi 网关未运行：exit(1) 并提示先启动', async () => {
    const h = fakeHome()
    stubExit()
    captureConsole()
    try {
      await expect(cmdUi()).rejects.toBeInstanceOf(ExitError)
      expect(errs.join('\n')).toContain('网关未运行')
    } finally {
      h.restore()
    }
  })

  it('沙箱模式：游离网关清扫直接跳过（不波及其他实例）', async () => {
    const h = fakeHome()
    captureConsole()
    try {
      // importActual 取真实实现：uninstall.test.ts 会把本符号 mock 成桩（见文件头注释）
      const real = await vi.importActual<typeof import('../src/cli/gatewaycmd.js')>('../src/cli/gatewaycmd.js')
      real.sweepGatewayProcesses()
      expect(logs.join('\n')).toContain('沙箱模式')
    } finally {
      h.restore()
    }
  })
})

describe('cmdGatewayLog', () => {
  function writeLogLine(file: string, line: unknown): void {
    fs.appendFileSync(file, typeof line === 'string' ? line + '\n' : JSON.stringify(line) + '\n', 'utf8')
  }

  it('logs 目录为空：提示暂无请求日志', async () => {
    const h = fakeHome()
    captureConsole()
    try {
      await cmdGatewayLog({})
      expect(logs.join('\n')).toContain('暂无请求日志')
    } finally {
      h.restore()
    }
  })

  it('有日志：按条数取尾、harness 过滤、坏行跳过、>=400 标红展示', async () => {
    const h = fakeHome()
    captureConsole()
    try {
      const file = path.join(logsDir(), `gateway-${localDateStr()}.jsonl`)
      fs.mkdirSync(logsDir(), { recursive: true })
      writeLogLine(file, { ts: '2026-10-29T10:00:01.000Z', harness: 'h1', profile: 'p1', model: 'm1', status: 200, ms: 11 })
      writeLogLine(file, { ts: '2026-10-29T10:00:02.000Z', harness: 'h2', profile: 'p2', model: 'm2', status: 500, ms: 12 })
      writeLogLine(file, 'garbage-not-json')
      writeLogLine(file, { ts: '2026-10-29T10:00:03.000Z', harness: 'h3', profile: 'p3', model: 'm3', status: 201, ms: 13 })
      writeLogLine(file, { ts: '2026-10-29T10:00:04.000Z', harness: 'h4', profile: 'p4', model: 'm4', status: 202, ms: 14 })

      await cmdGatewayLog({ n: '2' })
      let out = logs.join('\n')
      expect(out).toContain('h3') // tail 2：最早的 h1/h2 被裁掉
      expect(out).toContain('h4')
      expect(out).not.toContain('h1')
      expect(out).not.toContain('garbage') // 坏行静默跳过

      logs = []
      await cmdGatewayLog({ n: '30', harness: 'h2' })
      out = logs.join('\n')
      expect(out).toContain('h2')
      expect(out).toContain('500') // >=400 走红色分支仍输出状态码
      expect(out).not.toContain('h3')
    } finally {
      h.restore()
    }
  })
})

describe('autostartLine（纯函数四态）', () => {
  const fake = (o: Partial<AutostartStatus>): AutostartStatus => ({
    kind: 'systemd',
    installed: true,
    loaded: true,
    stale: false,
    file: '/x/unit',
    argv: [],
    ...o,
  })

  it('null：空行', () => {
    expect(autostartLine(null)).toBe('')
  })

  it('未安装：给安装指引', () => {
    expect(autostartLine(fake({ installed: false }))).toContain('未安装')
  })

  it('已安装但启动命令失效：stale 黄牌', () => {
    expect(autostartLine(fake({ stale: true }))).toContain('启动命令失效')
  })

  it('已安装未加载：下次登录生效提示', () => {
    expect(autostartLine(fake({ loaded: false }))).toContain('未加载')
  })

  it('已安装已加载：kind 标签（systemd / launchd）', () => {
    expect(autostartLine(fake({})).replace(/\x1b\[[0-9;]*m/g, '')).toContain('systemd')
    expect(autostartLine(fake({ kind: 'launchd' })).replace(/\x1b\[[0-9;]*m/g, '')).toContain('macOS LaunchAgent')
  })
})
