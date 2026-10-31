import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { AddressInfo } from 'node:net'
import { describe, expect, it } from 'vitest'
import { fakeHome } from './helpers.js'
import {
  buildRuntime,
  latencyQuantiles,
  logEvent,
  logRequest,
  reportEvent,
  setEventRingSink,
} from '../src/gateway/state.js'
import type { EventEntry } from '../src/gateway/state.js'
import { appendCrashLog, installCrashHandlers } from '../src/util/crash.js'
import { appendLineErrorCount, drainAppendStreams } from '../src/util/fsx.js'
import { logsDir } from '../src/util/paths.js'
import { createGatewayServer } from '../src/gateway/server.js'

function listenEphemeral(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port))
  })
}

function request(port: number, path: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, headers }, (res) => {
      let body = ''
      res.on('data', (c) => (body += c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }))
    })
    req.on('error', reject)
    req.end()
  })
}

describe('latencyQuantiles（纯函数，Prometheus 线性插值口径）', () => {
  it('空数组三个分位均为 null；不改原数组顺序', () => {
    const samples = [30, 10, 20]
    expect(latencyQuantiles([])).toEqual({ p50: null, p95: null, p99: null })
    expect(latencyQuantiles(samples)).toEqual({ p50: 20, p95: 29, p99: 29.8 })
    expect(samples).toEqual([30, 10, 20])
  })

  it('单元素与偶数长度的插值边界', () => {
    expect(latencyQuantiles([5])).toEqual({ p50: 5, p95: 5, p99: 5 })
    const r = latencyQuantiles([1, 2])
    expect(r.p50).toBe(1.5)
  })
})

describe('后台事件上报（logEvent / reportEvent / setEventRingSink）', () => {
  it('logEvent：错误 ring 可见（EventEntry 形状）+ events.jsonl 落盘', async () => {
    const h = fakeHome()
    try {
      const rt = buildRuntime({ providers: {}, profiles: {}, harness: {} }, 'tok')
      logEvent(rt, { level: 'warn', op: 'secrets_migrate', err: '磁盘故障' })
      const e = rt.ring.at(-1) as EventEntry
      expect(e.kind).toBe('event')
      expect(e.level).toBe('warn')
      expect(e.op).toBe('secrets_migrate')
      expect(e.err).toBe('磁盘故障')
      expect(e.harness).toBe('-')
      expect(e.path).toBe('event:secrets_migrate')
      await drainAppendStreams() // 常驻流异步刷盘后再读
      const eventsFile = path.join(logsDir(), 'events.jsonl')
      const line = JSON.parse(fs.readFileSync(eventsFile, 'utf8').trim())
      expect(line.op).toBe('secrets_migrate')
    } finally {
      h.restore()
    }
  })

  it('reportEvent：无 rt 只落文件；eventRingSink 注册后同步进 ring；传 null 撤销', async () => {
    const h = fakeHome()
    try {
      const rt = buildRuntime({ providers: {}, profiles: {}, harness: {} }, 'tok')
      const seen: EventEntry[] = []
      setEventRingSink((entry) => seen.push(entry))
      reportEvent({ level: 'error', op: 'switch_to_service', err: '目标不存在' })
      expect(seen).toHaveLength(1)
      expect(rt.ring).toHaveLength(0) // reportEvent 不直写 rt，经 sink 进来
      setEventRingSink(null)
      reportEvent({ level: 'warn', op: 'x', err: 'y' })
      expect(seen).toHaveLength(1) // 撤销后不再转发
    } finally {
      setEventRingSink(null)
      h.restore()
    }
  })
})

describe('崩溃痕迹与追加写观测', () => {
  it('appendCrashLog 落 logs/crash-YYYYMMDD.log（同步写，崩中崩不抛）；installCrashHandlers 幂等', () => {
    const h = fakeHome()
    try {
      expect(() => installCrashHandlers()).not.toThrow()
      expect(() => installCrashHandlers()).not.toThrow() // 重复安装不重复注册
      appendCrashLog('uncaughtException: boom')
      const dir = logsDir()
      const file = fs.readdirSync(dir).find((f) => f.startsWith('crash-') && f.endsWith('.log'))
      expect(file).toBeTruthy()
      expect(fs.readFileSync(path.join(dir, file!), 'utf8')).toContain('uncaughtException: boom')
    } finally {
      h.restore()
    }
  })

  it('appendLineErrorCount：写失败路径计数递增（目录被拔后追加写触发 stream error）', async () => {
    const h = fakeHome()
    try {
      const dir = path.join(h.home, 'volatile-logs')
      fs.mkdirSync(dir, { recursive: true })
      const file = path.join(dir, 'x.jsonl')
      const before = appendLineErrorCount()
      // appendLine 契约：调用方保证目录存在——先写一条建立常驻流，再拔目录制造写入失败
      const { appendLine } = await import('../src/util/fsx.js')
      appendLine(file, '{"n":0}\n')
      fs.rmSync(dir, { recursive: true, force: true })
      appendLine(file, '{"n":1}\n')
      // stream error 是异步事件：轮询等计数变化（上限 2s）
      for (let i = 0; i < 40 && appendLineErrorCount() === before; i++) {
        await new Promise((r) => setTimeout(r, 50))
      }
      expect(appendLineErrorCount()).toBeGreaterThan(before)
    } finally {
      h.restore()
    }
  })
})

describe('请求关联 ID 与健康/指标端点（E2E，隔离沙箱 + 随机端口）', () => {
  it('401 响应带 x-modeldock-request-id（头 + 错误体同值）；无效 token 的 ring 条目带 tokenHint', async () => {
    const h = fakeHome()
    try {
      const TOKEN = 'mdk_tok_observability'
      const cfg = {
        providers: { up: { base_url: 'https://up.example.com', protocol: 'anthropic', auth_style: 'bearer', key_ref: 'file:k' } },
        profiles: { default: { provider: 'up', default_model: 'm1' } },
        harness: { 'claude-code': { mode: 'gateway', route: 'default', token: TOKEN } },
      } as never
      const rt = buildRuntime(cfg, 'admin-token-obs')
      const server = createGatewayServer(rt, { port: 0 })
      const port = await listenEphemeral(server)
      try {
        const noAuth = await request(port, '/v1/models')
        expect(noAuth.status).toBe(401)
        const rid = noAuth.headers['x-modeldock-request-id']
        expect(typeof rid).toBe('string')
        expect(JSON.parse(noAuth.body).modeldock.requestId).toBe(rid)
        // 无效 token：401 归因——ring 条目 err 含前缀点名、tokenHint 只记 8 字符
        const bad = await request(port, '/v1/models', { authorization: 'Bearer mdk_tok_DEADBEEF' })
        expect(bad.status).toBe(401)
        const last = rt.ring.at(-1) as { tokenHint?: string; err?: string; requestId?: string }
        expect(last.tokenHint).toBe('mdk_tok_')
        expect(last.err).toContain('mdk_tok_')
        expect(last.requestId).toBe(bad.headers['x-modeldock-request-id'])
        expect(last.err).not.toContain('mdk_tok_DEADBEEF') // 绝不写完整 token
      } finally {
        server.closeAllConnections?.()
        server.close()
      }
    } finally {
      h.restore()
    }
  })

  it('GET /v1/health 免鉴权 200：全量自检字段齐备；/_modeldock/metrics admin 门内可读', async () => {
    const h = fakeHome()
    try {
      const cfg = {
        providers: { up: { base_url: 'https://up.example.com', protocol: 'anthropic', auth_style: 'bearer', key_ref: 'file:k' } },
        profiles: { default: { provider: 'up', default_model: 'm1' } },
        harness: {},
      } as never
      const rt = buildRuntime(cfg, 'admin-token-obs')
      const server = createGatewayServer(rt, { port: 0 })
      const port = await listenEphemeral(server)
      try {
        const health = await request(port, '/v1/health')
        expect(health.status).toBe(200)
        const body = JSON.parse(health.body)
        expect(body.ok).toBe(true)
        expect(typeof body.secrets_ok).toBe('boolean')
        expect(body.watcher_alive).toBeNull() // 未接线（测试直建 rt）→ 未知
        expect(typeof body.log_write_errors).toBe('number')
        expect('disk_free_mb' in body).toBe(true)
        expect(body.sync).toEqual({ mode: null, lastErrorTs: null })

        // metrics：logRequest 采样两条后 p50/p95 可读；未启动采样器 event_loop_lag_ms 为 null
        logRequest(rt, { ts: '2026-10-28T10:00:00.000+08:00', harness: 'c', profile: 'p', provider: 'up', path: '/v1/messages', status: 200, ms: 20 })
        logRequest(rt, { ts: '2026-10-28T10:00:01.000+08:00', harness: 'c', profile: 'p', provider: 'up', path: '/v1/messages', status: 500, ms: 40 })
        const noAuthMetrics = await request(port, '/_modeldock/metrics')
        expect(noAuthMetrics.status).toBe(401) // admin 门内
        const metrics = await request(port, '/_modeldock/metrics', { 'x-modeldock-admin': 'admin-token-obs' })
        expect(metrics.status).toBe(200)
        const m = JSON.parse(metrics.body)
        expect(m.event_loop_lag_ms).toBeNull()
        expect(m.providers.up.count).toBe(2)
        expect(m.providers.up.last_ms).toBe(40)
        expect(m.providers.up.p50).toBe(30)
      } finally {
        server.closeAllConnections?.()
        server.close()
      }
    } finally {
      h.restore()
    }
  })
})
