import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { fetchEnvelopeFromUrl, listenWithRetry, projectModel } from '../src/gateway/shared.js'
import { gatewayLive, gatewayProbe, writeGatewayState } from '../src/gateway/state/state-file.js'
import { acquireInstanceLock, readInstanceLock } from '../src/gateway/state/instance-lock.js'
import { gatewayLockPath, modeldockDir } from '../src/util/paths.js'
import { fakeHome } from './helpers.js'
import type { ModelMeta } from '../src/config/types.js'

// gateway/shared.ts 三个导出的纯单测：分享链接拉取的安全属性（fragment 不出网、10MB 封顶、协议
// 白名单、禁重定向）、端口顺延重试、模型元数据投影。全部走 listen(0) 随机端口。

interface Captured {
  url: string
  headers: http.IncomingHttpHeaders
}

const servers: http.Server[] = []
afterAll(async () => {
  await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))))
})

async function startStub(
  respond: (req: Captured, res: http.ServerResponse) => void
): Promise<{ port: number; seen: Captured[] }> {
  const seen: Captured[] = []
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url ?? '', headers: req.headers })
    respond(seen[seen.length - 1], res)
  })
  servers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  return { port: (server.address() as AddressInfo).port, seen }
}

describe('fetchEnvelopeFromUrl', () => {
  it('正常拉取：fragment（口令）不发往网络，返回响应体原文', async () => {
    const stub = await startStub((_req, res) => {
      res.setHeader('content-type', 'text/plain')
      res.end('ENV-BODY')
    })
    const out = await fetchEnvelopeFromUrl(`http://127.0.0.1:${stub.port}/pull?x=1#p=secret123`)
    expect(out).toBe('ENV-BODY')
    expect(stub.seen[0].url).toBe('/pull?x=1')
    expect(stub.seen[0].url).not.toContain('secret123')
  })

  it('非 http/https 协议与非法 URL 分别抛可操作报错', async () => {
    await expect(fetchEnvelopeFromUrl('ftp://example.com/x')).rejects.toThrow('仅支持 http/https 链接')
    await expect(fetchEnvelopeFromUrl('not a url')).rejects.toThrow('链接格式不正确')
  })

  it('HTTP 404 抛「拉取失败：HTTP 404」', async () => {
    const stub = await startStub((_req, res) => {
      res.statusCode = 404
      res.end()
    })
    await expect(fetchEnvelopeFromUrl(`http://127.0.0.1:${stub.port}/pull`)).rejects.toThrow('拉取失败：HTTP 404')
  })

  it('302 重定向被 redirect:error 拒绝，包装为「拉取失败」', async () => {
    const stub = await startStub((_req, res) => {
      res.statusCode = 302
      res.setHeader('location', 'http://127.0.0.1:1/elsewhere')
      res.end()
    })
    await expect(fetchEnvelopeFromUrl(`http://127.0.0.1:${stub.port}/pull`)).rejects.toThrow('拉取失败')
  })

  it('响应体超过 10MB 封顶：中止读取并抛「疑似异常来源」', async () => {
    const stub = await startStub((_req, res) => {
      res.end(Buffer.alloc(10 * 1024 * 1024 + 1, 97))
    })
    await expect(fetchEnvelopeFromUrl(`http://127.0.0.1:${stub.port}/pull`)).rejects.toThrow('响应体超过 10MB 上限')
  })
})

describe('listenWithRetry', () => {
  it('端口被占用：顺延到后续端口成功监听', async () => {
    const a = http.createServer()
    await new Promise<void>((r) => a.listen(0, '127.0.0.1', () => r()))
    const occupied = (a.address() as AddressInfo).port
    const b = http.createServer()
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const got = await listenWithRetry(b, occupied, '127.0.0.1')
      expect(got).toBeGreaterThan(occupied)
      expect(got).toBeLessThanOrEqual(occupied + 10)
      expect((b.address() as AddressInfo).port).toBe(got)
    } finally {
      spy.mockRestore()
      await new Promise<void>((r) => b.close(() => r()))
      await new Promise<void>((r) => a.close(() => r()))
    }
  })

  it('port 0（内核分配）：返回实际监听端口', async () => {
    const s = http.createServer()
    const got = await listenWithRetry(s, 0, '127.0.0.1')
    try {
      expect(got).toBeGreaterThan(0)
      expect((s.address() as AddressInfo).port).toBe(got)
    } finally {
      await new Promise<void>((r) => s.close(() => r()))
    }
  })
})

describe('projectModel：三视图字段投影', () => {
  const meta: ModelMeta = {
    display_name: 'GLM 模型',
    context_window: 200_000,
    max_output: 32_000,
    capabilities: ['vision'],
    source: 'manual',
  }

  it('桌面视图（默认）：display_name 缺省为 null，不带 capabilities/source 内部字段', () => {
    expect(projectModel('m1', meta)).toEqual({
      id: 'm1',
      display_name: 'GLM 模型',
      context_window: 200_000,
      max_output: 32_000,
    })
    expect(projectModel('m1', meta)).not.toHaveProperty('capabilities')
    expect(projectModel('m1', meta)).not.toHaveProperty('source')
  })

  it('手机视图 nameKey：display_name 缺省回落模型 id', () => {
    const r = projectModel('m1', meta, { nameKey: true })
    expect(r.name).toBe('GLM 模型')
    const r2 = projectModel('m2', { source: 'manual' }, { nameKey: true })
    expect(r2.name).toBe('m2')
    expect(r2.display_name).toBeUndefined()
  })

  it('includeCapabilities / includeSource 按需携带；四层皆无时数值落 null', () => {
    const r = projectModel('m1', meta, { includeCapabilities: true, includeSource: true })
    expect(r.capabilities).toEqual(['vision'])
    expect(r.source).toBe('manual')
    // 明显不在内置表/目录里的 id：推测字段落 null 而非 undefined
    const unknown = projectModel('mdk-hc-unknown-model', { source: 'manual' })
    expect(unknown.context_window).toBeNull()
    expect(unknown.max_output).toBeNull()
    expect(unknown.display_name).toBeNull()
  })
})

describe('gatewayProbe 三态判活（审计 P-06a）', () => {
  /** 活 pid 用本进程：pidAlive(process.pid) 恒真，且绝不真起网关 */
  function stateOf(port: number, pid: number): { port: number; pid: number; admin_token: string; started_at: string } {
    return { port, pid, admin_token: 'mdkadm_' + '0'.repeat(32), started_at: '2026-01-01T00:00:00' }
  }

  /** 接受连接但永不回响应（模拟健康端点卡住/hang）：1s 超时后应判 unresponsive */
  async function startHangingServer(): Promise<{ port: number; close: () => Promise<void> }> {
    const server = http.createServer(() => { /* 故意不回 */ })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => resolve())
    })
    const port = (server.address() as AddressInfo).port
    return {
      port,
      close: () =>
        new Promise<void>((resolve) => {
          server.closeAllConnections()
          server.close(() => resolve())
        }),
    }
  }

  it('pid 活 + health 200 + started_at 一致 → live，gatewayLive 原样返回', async () => {
    const h = fakeHome()
    const stub = await startStub((_req, res) => {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ ok: true, started_at: '2026-01-01T00:00:00' }))
    })
    try {
      await writeGatewayState(stateOf(stub.port, process.pid))
      const p = await gatewayProbe()
      expect(p.status).toBe('live')
      expect(p.status === 'live' && p.identityMismatch).toBeFalsy()
      expect((await gatewayLive())?.pid).toBe(process.pid)
    } finally {
      h.restore()
    }
  })

  it('health 200 但 started_at 不符（pid 复用）→ live + identityMismatch，gatewayLive 不认', async () => {
    const h = fakeHome()
    const stub = await startStub((_req, res) => {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ ok: true, started_at: '1999-01-01T00:00:00' }))
    })
    try {
      await writeGatewayState(stateOf(stub.port, process.pid))
      const p = await gatewayProbe()
      expect(p.status).toBe('live')
      expect(p.status === 'live' && p.identityMismatch).toBe(true)
      expect(await gatewayLive()).toBeNull()
    } finally {
      h.restore()
    }
  })

  it('pid 活 + health 超时 → unresponsive：状态文件保留，gatewayLive 不判「未运行」', async () => {
    const h = fakeHome()
    const hang = await startHangingServer()
    try {
      await writeGatewayState(stateOf(hang.port, process.pid))
      const started = Date.now()
      const p = await gatewayProbe()
      expect(p.status).toBe('unresponsive')
      expect(Date.now() - started).toBeLessThan(5_000)
      // 无响应不得清状态文件（审计 P-06a 的核心断言）
      expect(p.status !== 'stopped' && p.state.port).toBe(hang.port)
      expect((await gatewayProbe()).status).toBe('unresponsive')
    } finally {
      await hang.close()
      h.restore()
    }
  })

  it('pid 已死 → stopped，但仍带回残留状态（启动侧复用 devices/update_check）', async () => {
    const h = fakeHome()
    try {
      await writeGatewayState(stateOf(59999, 99999999))
      const p = await gatewayProbe()
      expect(p.status).toBe('stopped')
      expect(p.state?.pid).toBe(99999999)
    } finally {
      h.restore()
    }
  })

  it('无状态文件 → stopped 且 state 为 null', async () => {
    const h = fakeHome()
    try {
      const p = await gatewayProbe()
      expect(p).toEqual({ status: 'stopped', state: null })
    } finally {
      h.restore()
    }
  })
})

describe('gateway 实例锁（审计 P-06b）', () => {
  /** 死 pid：不存在的极限值（同 gatewayProbe 用例口径），绝不真起进程 */
  const DEAD_PID = 99_999_999

  function writeLockRaw(text: string): void {
    fs.mkdirSync(modeldockDir(), { recursive: true })
    fs.writeFileSync(gatewayLockPath(), text)
  }

  it('获取成功 → 再次获取失败并带回持有者 pid/port → 释放后可再次获取', async () => {
    const h = fakeHome()
    try {
      const first = await acquireInstanceLock(18901)
      expect(first.acquired).toBe(true)
      expect(fs.existsSync(gatewayLockPath())).toBe(true)
      expect((await readInstanceLock())?.pid).toBe(process.pid)

      const second = await acquireInstanceLock(18902)
      expect(second.acquired).toBe(false)
      if (!second.acquired) {
        expect(second.holder?.pid).toBe(process.pid)
        expect(second.holder?.port).toBe(18901)
      }
      // 锁内容仍是第一个持有者（第二个没写坏/覆盖）
      expect((await readInstanceLock())?.port).toBe(18901)

      if (first.acquired) first.release()
      expect(fs.existsSync(gatewayLockPath())).toBe(false)

      const third = await acquireInstanceLock(18903)
      expect(third.acquired).toBe(true)
      if (third.acquired) third.release()
    } finally {
      h.restore()
    }
  })

  it('残留锁（pid 已死）→ 新实例接管，锁内容换成当前 pid', async () => {
    const h = fakeHome()
    try {
      writeLockRaw(JSON.stringify({ pid: DEAD_PID, port: 59998, acquired_at: '2026-01-01T00:00:00.000+08:00' }))
      const got = await acquireInstanceLock(18904)
      expect(got.acquired).toBe(true)
      expect((await readInstanceLock())?.pid).toBe(process.pid)
      if (got.acquired) got.release()
    } finally {
      h.restore()
    }
  })

  it('损坏/半截锁文件 → 有界等待后接管（不永久卡死）', async () => {
    const h = fakeHome()
    try {
      writeLockRaw('{"pid":') // 创建者写完前崩溃的形态
      const started = Date.now()
      const got = await acquireInstanceLock(18905)
      expect(got.acquired).toBe(true)
      expect(Date.now() - started).toBeLessThan(5_000)
      if (got.acquired) got.release()
    } finally {
      h.restore()
    }
  })

  it('释放做归属校验：锁已被他人接管时不删别人的锁', async () => {
    const h = fakeHome()
    try {
      const mine = await acquireInstanceLock(18906)
      expect(mine.acquired).toBe(true)
      // 模拟「我的锁被判陈/接管后别人重建」：内容换成另一个 pid
      writeLockRaw(JSON.stringify({ pid: DEAD_PID, port: 18907, acquired_at: '2026-01-01T00:00:00.000+08:00' }))
      if (mine.acquired) mine.release()
      expect(fs.existsSync(gatewayLockPath())).toBe(true)
      expect((await readInstanceLock())?.pid).toBe(DEAD_PID)
    } finally {
      h.restore()
    }
  })
})
