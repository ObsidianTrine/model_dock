import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { AddressInfo } from 'node:net'
import { describe, expect, it } from 'vitest'
import { fakeHome } from './helpers.js'
import {
  buildRuntime,
  filterLogEntries,
  latencyQuantiles,
  logEvent,
  logRequest,
  readRequestLogDay,
  recordOutcome,
  reportEvent,
  setEventRingSink,
  summarizeUsage,
  summarizeUsageDays,
} from '../src/gateway/state.js'
import type { EventEntry, LogEntry } from '../src/gateway/state.js'
import { appendCrashLog, installCrashHandlers } from '../src/util/crash.js'
import { appendLineErrorCount, drainAppendStreams } from '../src/util/fsx.js'
import { logsDir } from '../src/util/paths.js'
import { localIsoTs } from '../src/util/time.js'
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

describe('metrics 熔断暴露与 /_modeldock/usage 聚合端点（E2E）', () => {
  const ADMIN = { 'x-modeldock-admin': 'admin-token-obs' }

  async function setup() {
    const h = fakeHome()
    const cfg = {
      providers: { up: { base_url: 'https://up.example.com', protocol: 'anthropic', auth_style: 'bearer', key_ref: 'file:k' } },
      profiles: { default: { provider: 'up', default_model: 'm1' } },
      harness: {},
    } as never
    const rt = buildRuntime(cfg, 'admin-token-obs')
    const server = createGatewayServer(rt, { port: 0 })
    const port = await listenEphemeral(server)
    return {
      rt,
      port,
      close: () => {
        server.closeAllConnections?.()
        server.close()
        h.restore()
      },
    }
  }

  it('metrics.meltdown：quota×3 触发（class/remaining_ms），连续成功×3 解除（风暴闸外部海况数据源）', async () => {
    const t = await setup()
    try {
      for (let i = 0; i < 3; i++) recordOutcome(t.rt, 'up', { ok: false, cls: 'quota' })
      const m1 = JSON.parse((await request(t.port, '/_modeldock/metrics', ADMIN)).body)
      expect(m1.meltdown).toHaveLength(1)
      expect(m1.meltdown[0]).toMatchObject({ provider: 'up', class: 'quota' })
      expect(m1.meltdown[0].remaining_ms).toBeGreaterThan(0)
      expect(typeof m1.meltdown[0].until).toBe('string')
      for (let i = 0; i < 3; i++) recordOutcome(t.rt, 'up', { ok: true })
      const m2 = JSON.parse((await request(t.port, '/_modeldock/metrics', ADMIN)).body)
      expect(m2.meltdown).toEqual([])
    } finally {
      t.close()
    }
  })

  it('usage 聚合：成功/失败/无 status 分布、维度 tally、时延分位、用量口径（缓存计入输入）', async () => {
    const t = await setup()
    try {
      const now = new Date()
      const today = localIsoTs(now).slice(0, 10)
      const entry = (over: Partial<LogEntry>): LogEntry => ({
        ts: localIsoTs(now),
        harness: 'zcode',
        profile: 'p',
        provider: 'up',
        model: 'glm-4.7',
        path: '/v1/messages',
        ...over,
      })
      logRequest(t.rt, entry({ status: 200, ms: 1200, usage: { input_tokens: 1500, output_tokens: 200, cache_read_tokens: 900, cache_creation_tokens: 0 } }))
      logRequest(t.rt, entry({ harness: 'claude-code', status: 200, ms: 2400, usage: { input_tokens: 100, output_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 0 } }))
      logRequest(t.rt, entry({ status: 429, ms: 30 }))
      logRequest(t.rt, entry({ status: 500, ms: 40, reason: 'down_all' }))
      logRequest(t.rt, entry({ model: undefined })) // 无 status（中止）：归入失败 n/a；无 model 不进模型 tally
      await drainAppendStreams()

      const noAuth = await request(t.port, `/_modeldock/usage?date=${today}`)
      expect(noAuth.status).toBe(401) // admin 门内
      const res = await request(t.port, `/_modeldock/usage?date=${today}`, ADMIN)
      expect(res.status).toBe(200)
      const body = JSON.parse(res.body)
      expect(body.days).toEqual([today])
      expect(body.filter).toBeNull()
      const u = body.usage
      expect(u.requests).toBe(5)
      expect(u.ok).toBe(2)
      expect(u.failed).toBe(3)
      expect(u.by_status).toEqual({ '429': 1, '500': 1, 'n/a': 1 })
      expect(u.by_provider).toEqual({ up: 5 })
      expect(u.by_model).toEqual({ 'glm-4.7': 4 })
      expect(u.latency.p50).toBe(1800) // [1200,2400] 线性插值
      expect(u.tokens.input).toBe(2500) // 1500+900（缓存读计入输入）+ 100
      expect(u.tokens.output).toBe(210)
      expect(u.tokens.cache_read).toBe(900)
      expect(u.window.first).toBeTruthy()

      // harness 精确过滤：滤掉 claude-code 一条
      const f = JSON.parse((await request(t.port, `/_modeldock/usage?date=${today}&harness=zcode`, ADMIN)).body)
      expect(f.usage.requests).toBe(4)
      expect(f.filter).toEqual({ harness: 'zcode' })
    } finally {
      t.close()
    }
  })

  it('usage from/to 跨日：昨日+今日两笔都命中；days 列表按本地日展开', async () => {
    const t = await setup()
    try {
      const now = new Date()
      const today = localIsoTs(now).slice(0, 10)
      const yesterdayTs = new Date(now.getTime() - 86_400_000)
      const yesterday = localIsoTs(yesterdayTs).slice(0, 10)
      const entry = (over: Partial<LogEntry>): LogEntry => ({
        ts: localIsoTs(now),
        harness: 'zcode',
        profile: 'p',
        provider: 'up',
        path: '/v1/messages',
        ...over,
      })
      logRequest(t.rt, entry({ ts: localIsoTs(yesterdayTs), status: 200, ms: 100 }))
      logRequest(t.rt, entry({ status: 200, ms: 200 }))
      await drainAppendStreams()
      const body = JSON.parse((await request(t.port, `/_modeldock/usage?from=${yesterday}&to=${today}`, ADMIN)).body)
      expect(body.days).toEqual([yesterday, today])
      expect(body.usage.requests).toBe(2)
    } finally {
      t.close()
    }
  })

  it('usage 400：date 格式非法 / to 早于 from / 窗口超上限，均带双语报错与示例 hint', async () => {
    const t = await setup()
    try {
      const badDate = await request(t.port, '/_modeldock/usage?date=20261101', ADMIN)
      expect(badDate.status).toBe(400)
      expect(JSON.parse(badDate.body).error.message).toContain('date')
      const badRange = await request(t.port, '/_modeldock/usage?from=2026-11-10&to=2026-11-01', ADMIN)
      expect(badRange.status).toBe(400)
      const tooWide = await request(t.port, '/_modeldock/usage?from=2000-01-01&to=2030-01-01', ADMIN)
      expect(tooWide.status).toBe(400)
      expect(JSON.parse(tooWide.body).modeldock.hint).toContain('/_modeldock/usage')
    } finally {
      t.close()
    }
  })
})

describe('summarizeUsageDays 流式聚合（卡 33：不落全量数组，口径与数组路径一致）', () => {
  it('与 readRequestLogDay+filterLogEntries+summarizeUsage 同输入同输出；坏行容错', async () => {
    const h = fakeHome()
    try {
      const cfg = { providers: {}, profiles: {}, harness: {} } as never
      const rt = buildRuntime(cfg, 't')
      const now = new Date()
      const today = localIsoTs(now).slice(0, 10)
      const base = { ts: localIsoTs(now), harness: 'zcode', profile: 'p', provider: 'up', model: 'm1', path: '/v1/messages' }
      logRequest(rt, { ...base, status: 200, ms: 100, usage: { input_tokens: 10, output_tokens: 2, cache_read_tokens: 0, cache_creation_tokens: 0 } })
      logRequest(rt, { ...base, harness: 'dsh', status: 500, ms: 10 })
      logRequest(rt, { ...base, status: 200, ms: 200, usage: { input_tokens: 5, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 } })
      await drainAppendStreams()
      fs.appendFileSync(path.join(logsDir(), `gateway-${today}.jsonl`), '{"broken\n') // 崩溃半行
      const f = { harness: 'zcode' }
      const streamed = await summarizeUsageDays([today], f)
      const arrayed = summarizeUsage(filterLogEntries(readRequestLogDay(today), f))
      expect(streamed).toEqual(arrayed)
      expect(streamed.requests).toBe(2)
      expect(streamed.ok).toBe(2)
      expect(streamed.tokens.input).toBe(15)
    } finally {
      h.restore()
    }
  })
})
