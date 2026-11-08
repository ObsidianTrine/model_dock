// transient 瞬时故障签名测试：ERA 连接协商失败（zcode CLI，2026-11-03 航行实证）
// 须命中（可退避重试自愈）；既有 429/网络签名不回归；确定性错误不误报。
// B6 扩展：结构化信号优先——网关日志窗口（429/5xx/quota）命中即 transient（source=gateway），
// 无网关数据/未命中/读取失败 fail-open 落回 stderr 正则（source=regex）。
// A1 扩展（2026-11）：cause 精读——proto_endpoint_missing/unauthorized 判定性失败、
// quota 建议换 provider、key_cooldown/key_pool_empty 带 keypool 重试窗口；cause 优先于状态码。

import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { AddressInfo } from 'node:net'
import {
  classifyWorkerCrash,
  classifyWorkerCrashFromDisk,
  clampRetryWindowMs,
  fetchGatewayWindowEntries,
  harnessMatches,
  isCrashStatus,
  isTransientWorkerFailure,
  keypoolMinRemainingMs,
  readGatewayWindowEntries,
  RETRY_WINDOW_MAX_MS,
  RETRY_WINDOW_MIN_MS,
  TRANSIENT_RE,
} from '../../.agents/scripts/orchestrator/transient.mjs'

const pad = (n: number, w = 2) => String(n).padStart(w, '0')
const localDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

/** 网关日志条目（LogEntry 子集：分类只认 ts/status/harness；cause 路径另认 cause/hint/tokenHint）。 */
function gwEntry(status: number, ts: string, harness = 'zcode', extra: Record<string, unknown> = {}) {
  return { ts, status, harness, profile: 'glm', model: 'glm-5.3-flash', ...extra }
}

/** 写一条 gateway-*.jsonl 夹具（HTTP 与文件两路用例共用）。 */
function writeLog(dir: string, entry: Record<string, unknown>) {
  fs.mkdirSync(dir, { recursive: true })
  // 文件名按条目 ts 的本地日期派生：实现侧 readGatewayLog 的日期由 toIsoLocal（本地时区）
  // 派生，生产网关的 entry.ts 也是本地时区字符串——这里若用 UTC toISOString 直接切片，
  // 本地零点到早上（UTC+8 为 00:00-07:59）会跨日错一天，readGatewayLog 读不到条目、
  // 用例必红（CORRECT-12 同族的夹具日期坑，2026-11-09 实锤；161 行用例用 localDate
  // 命名所以不受影响）
  const d = localDate(new Date(String(entry.ts)))
  fs.appendFileSync(path.join(dir, `gateway-${d}.jsonl`), JSON.stringify(entry) + '\n')
}

describe('orchestrator transient > 瞬时故障签名', () => {
  it('zcode ERA 连接协商失败命中（两种形态与完整堆栈现场）', () => {
    const stack = [
      'at probe (D:\\Programs\\ZCode\\resources\\glm\\zcode.cjs:2217:81178)',
      'at async negotiateEra (D:\\Programs\\ZCode\\resources\\glm\\zcode.cjs:2217:82502)',
      'at async Wyo._connectNegotiated (D:\\Programs\\ZCode\\resources\\glm\\zcode.cjs:2217:105240)',
      'Node.js v24.18.0',
    ].join('\n')
    expect(isTransientWorkerFailure('', stack)).toBe(true)
    expect(TRANSIENT_RE.test('ERA_NEGOTIATION_FAILED: upstream negotiate failed')).toBe(true)
    expect(TRANSIENT_RE.test('era-negotiation timeout')).toBe(true)
  })

  it('既有签名不回归（429/网络码）；确定性错误不误报', () => {
    expect(isTransientWorkerFailure('request failed: 429 too many requests', '')).toBe(true)
    expect(isTransientWorkerFailure('', 'ECONNRESET socket hang up')).toBe(true)
    expect(isTransientWorkerFailure('SyntaxError: Unexpected token', '')).toBe(false)
    expect(isTransientWorkerFailure('', 'command not found: npm')).toBe(false)
  })
})

describe('orchestrator transient > isCrashStatus（崩溃相关状态码）', () => {
  it('429/402/5xx 命中；200/3xx/4xx（非 429/402）/越界不命中', () => {
    expect(isCrashStatus(429)).toBe(true)
    expect(isCrashStatus(402)).toBe(true)
    expect(isCrashStatus(500)).toBe(true)
    expect(isCrashStatus(503)).toBe(true)
    expect(isCrashStatus(599)).toBe(true)
    expect(isCrashStatus(200)).toBe(false)
    expect(isCrashStatus(302)).toBe(false)
    expect(isCrashStatus(401)).toBe(false)
    expect(isCrashStatus(404)).toBe(false)
    expect(isCrashStatus(600)).toBe(false)
    expect(isCrashStatus(undefined)).toBe(false)
  })
})

describe('orchestrator transient > harnessMatches（执行船与日志 harness 宽容匹配）', () => {
  it('-headless 后缀剥离后按词边界匹配；任一侧缺席放行（缺席 ≠ 无辜）', () => {
    expect(harnessMatches('zcode', 'zcode-headless')).toBe(true)
    expect(harnessMatches('zcode-headless', 'zcode-headless')).toBe(true)
    expect(harnessMatches('ZCode', 'zcode-headless')).toBe(true)
    expect(harnessMatches('claude-code', 'claude-headless')).toBe(true)
    expect(harnessMatches('zcode-dev', 'zcode-headless')).toBe(true)
    expect(harnessMatches('claude', 'zcode-headless')).toBe(false)
    // 缺席放行：旧日志无 harness / '-' 占位 / backend 未知
    expect(harnessMatches('-', 'zcode-headless')).toBe(true)
    expect(harnessMatches('', 'zcode-headless')).toBe(true)
    expect(harnessMatches('zcode', '')).toBe(true)
    expect(harnessMatches(undefined, undefined)).toBe(true)
  })
})

describe('orchestrator transient > classifyWorkerCrash（结构化优先，正则兜底）', () => {
  const WIN = { startMs: Date.parse('2026-11-04T10:00:00+08:00'), endMs: Date.parse('2026-11-04T10:05:00+08:00') }
  const mid = '2026-11-04T10:02:30.000+08:00'
  const before = '2026-11-04T09:59:00.000+08:00'
  const after = '2026-11-04T10:06:00.000+08:00'

  it('窗口内本 harness 的 429 → 结构化 transient（上游改文案不再致盲）', () => {
    const entries = [gwEntry(429, mid)]
    const r = classifyWorkerCrash({ output: '', stderrTail: '', entries, window: WIN, backend: 'zcode-headless' })
    expect(r).toEqual({ transient: true, source: 'gateway', hits: 1, reason: '429×1' })
  })

  it('5xx 与 402 同样命中；多状态汇总进 reason', () => {
    const r = classifyWorkerCrash({
      output: '',
      stderrTail: '',
      entries: [gwEntry(503, mid), gwEntry(402, mid), gwEntry(429, mid)],
      window: WIN,
      backend: 'zcode-headless',
    })
    expect(r.transient).toBe(true)
    expect(r.source).toBe('gateway')
    expect(r.hits).toBe(3)
    expect(r.reason).toBe('402×1, 429×1, 503×1') // 状态码升序（确定性输出）
  })

  it('窗口外（前/后）不命中；他 harness 不命中；非崩溃状态不命中', () => {
    const entries = [gwEntry(429, before), gwEntry(429, after), gwEntry(429, mid, 'claude'), gwEntry(200, mid), gwEntry(404, mid)]
    const r = classifyWorkerCrash({ output: '', stderrTail: '', entries, window: WIN, backend: 'zcode-headless' })
    expect(r.transient).toBe(false)
    expect(r.source).toBe('regex')
    expect(r.hits).toBeUndefined()
  })

  it('窗口内命中 + stderr 也带签名：结构化优先（source=gateway）', () => {
    const r = classifyWorkerCrash({
      output: '',
      stderrTail: 'ECONNRESET',
      entries: [gwEntry(429, mid)],
      window: WIN,
      backend: 'zcode-headless',
    })
    expect(r.source).toBe('gateway')
  })

  it('entries=null（无网关数据）→ 正则兜底；窗口非法同样兜底', () => {
    expect(classifyWorkerCrash({ output: '', stderrTail: '429 too many requests', entries: null, window: WIN, backend: 'zcode' })).toEqual({
      transient: true,
      source: 'regex',
    })
    expect(classifyWorkerCrash({ output: '', stderrTail: '', entries: [gwEntry(429, mid)], window: null, backend: 'zcode' })).toEqual({
      transient: false,
      source: 'regex',
    })
    // 网关数据在但零命中：落回正则（worker 可能绕行网关，stderr 仍是有效证据）
    expect(classifyWorkerCrash({ output: '', stderrTail: 'fetch failed', entries: [gwEntry(200, mid)], window: WIN, backend: 'zcode' })).toEqual({
      transient: true,
      source: 'regex',
    })
  })
})

describe('orchestrator transient > readGatewayWindowEntries（落盘读取，fail-open）', () => {
  it('读窗口覆盖的日文件（跨本地午夜自动补足）；gwDir 未配 → null', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gwlog-'))
    try {
      // 窗口跨午夜：d1 23:55 → d2 00:05（本地时区）
      const start = new Date(); start.setHours(23, 55, 0, 0); start.setDate(start.getDate() - 1)
      const end = new Date(start.getTime() + 10 * 60_000)
      const d1 = localDate(start)
      const d2 = localDate(end)
      expect(d1).not.toBe(d2)
      const iso = (base: Date, addMs: number) => new Date(base.getTime() + addMs).toISOString()
      fs.writeFileSync(path.join(dir, `gateway-${d1}.jsonl`), JSON.stringify(gwEntry(429, iso(start, 60_000))) + '\n')
      fs.writeFileSync(path.join(dir, `gateway-${d2}.jsonl`), JSON.stringify(gwEntry(503, iso(start, 9 * 60_000))) + '\n')
      const entries = readGatewayWindowEntries(dir, { startMs: start.getTime(), endMs: end.getTime() })
      expect(entries).not.toBeNull()
      expect(entries!.length).toBe(2)
      // gwDir 缺失 / 窗口非法 → null（= 无网关数据，落回正则）
      expect(readGatewayWindowEntries(null, { startMs: start.getTime(), endMs: end.getTime() })).toBeNull()
      expect(readGatewayWindowEntries(dir, { startMs: NaN, endMs: end.getTime() })).toBeNull()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('日志文件读不了（目录占位文件）→ null（fail-open 落回正则，绝不抛错）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gwlog-bad-'))
    try {
      const now = new Date()
      // 同名**目录**占位：existsSync 命中但 readFileSync 抛 EISDIR
      fs.mkdirSync(path.join(dir, `gateway-${localDate(now)}.jsonl`))
      expect(readGatewayWindowEntries(dir, { startMs: now.getTime() - 60_000, endMs: now.getTime() })).toBeNull()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('无日志文件 → 空数组（目录在、无数据：不算故障，落回正则）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gwlog-empty-'))
    try {
      const now = Date.now()
      const entries = readGatewayWindowEntries(dir, { startMs: now - 60_000, endMs: now })
      expect(entries).toEqual([])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// A1（2026-11）：cause 精读——状态码只说「失败」，cause 说「为什么失败」
// ---------------------------------------------------------------------------

describe('orchestrator transient > cause 精读（A1）', () => {
  const WIN = { startMs: Date.parse('2026-11-08T10:00:00+08:00'), endMs: Date.parse('2026-11-08T10:05:00+08:00') }
  const mid = '2026-11-08T10:02:30.000+08:00'

  it('proto_endpoint_missing → 判定性失败（非 transient）：reason 带 cause + hint 可操作报错', () => {
    const r = classifyWorkerCrash({
      output: '',
      stderrTail: '',
      entries: [gwEntry(404, mid, 'zcode', { cause: 'proto_endpoint_missing', hint: '模型未配置 anthropic 端点' })],
      window: WIN,
      backend: 'zcode-headless',
    })
    expect(r.transient).toBe(false)
    expect(r.source).toBe('gateway')
    expect(r.decisive).toBe(true)
    expect(r.cause).toBe('proto_endpoint_missing')
    expect(r.hits).toBe(1)
    expect(r.hint).toBe('模型未配置 anthropic 端点')
    expect(r.reason).toContain('proto_endpoint_missing')
    expect(r.reason).toContain('模型未配置 anthropic 端点')
  })

  it('cause 优先于状态码：502 + proto_endpoint_missing → decisive（不因 5xx 误判 transient）', () => {
    const r = classifyWorkerCrash({
      output: '',
      stderrTail: '',
      entries: [gwEntry(502, mid, 'zcode', { cause: 'proto_endpoint_missing' })],
      window: WIN,
      backend: 'zcode-headless',
    })
    expect(r.transient).toBe(false)
    expect(r.decisive).toBe(true)
    // hint 缺席（旧网关）→ 兜底建议也要可操作
    expect(r.reason).toContain('换 provider 或补端点')
  })

  it('决定性 cause 压过同窗的 transient 状态码命中（429 与 proto_endpoint_missing 并存 → decisive）', () => {
    const r = classifyWorkerCrash({
      output: '',
      stderrTail: '',
      entries: [gwEntry(429, mid), gwEntry(404, mid, 'zcode', { cause: 'proto_endpoint_missing' })],
      window: WIN,
      backend: 'zcode-headless',
    })
    expect(r.transient).toBe(false)
    expect(r.decisive).toBe(true)
  })

  it('unauthorized → 判定性失败：tokenHint 点名归因（含 backend）', () => {
    const r = classifyWorkerCrash({
      output: '',
      stderrTail: '',
      entries: [gwEntry(401, mid, 'zcode', { cause: 'unauthorized', tokenHint: 'sk-deadbe', hint: 'token 未注册' })],
      window: WIN,
      backend: 'zcode-headless',
    })
    expect(r.transient).toBe(false)
    expect(r.decisive).toBe(true)
    expect(r.cause).toBe('unauthorized')
    expect(r.tokenHint).toBe('sk-deadbe')
    expect(r.reason).toContain('unauthorized')
    expect(r.reason).toContain('sk-deadbe')
    expect(r.reason).toContain('zcode-headless')
  })

  it('quota → transient + switchProvider 信号', () => {
    const r = classifyWorkerCrash({
      output: '',
      stderrTail: '',
      entries: [gwEntry(402, mid, 'zcode', { cause: 'quota' }), gwEntry(402, mid, 'zcode', { cause: 'quota' })],
      window: WIN,
      backend: 'zcode-headless',
    })
    expect(r.transient).toBe(true)
    expect(r.source).toBe('gateway')
    expect(r.cause).toBe('quota')
    expect(r.switchProvider).toBe(true)
    expect(r.decisive).toBeUndefined()
    expect(r.reason).toContain('quota×2')
  })

  it('key_cooldown/key_pool_empty + keypoolRemainingMs → retryMs（钳制 [1s, 10min]）；缺省无 retryMs', () => {
    const entries = [gwEntry(429, mid, 'zcode', { cause: 'key_cooldown' })]
    const base = { output: '', stderrTail: '', entries, window: WIN, backend: 'zcode-headless' }
    expect(classifyWorkerCrash({ ...base, keypoolRemainingMs: 45_000 }).retryMs).toBe(45_000)
    expect(classifyWorkerCrash({ ...base, keypoolRemainingMs: 5 }).retryMs).toBe(RETRY_WINDOW_MIN_MS)
    expect(classifyWorkerCrash({ ...base, keypoolRemainingMs: 9e9 }).retryMs).toBe(RETRY_WINDOW_MAX_MS)
    // 拿不到 keypool（null）→ 无 retryMs（调用方走既有退避），仍 transient
    const noKp = classifyWorkerCrash(base)
    expect(noKp.transient).toBe(true)
    expect(noKp.retryMs).toBeUndefined()
    // key_pool_empty 同样携带
    expect(classifyWorkerCrash({ ...base, entries: [gwEntry(429, mid, 'zcode', { cause: 'key_pool_empty' })], keypoolRemainingMs: 30_000 }).retryMs).toBe(30_000)
  })

  it('quota 与无 cause 状态码命中并存 → reason 拼「另有」段，hits 只计 cause 条目', () => {
    const r = classifyWorkerCrash({
      output: '',
      stderrTail: '',
      entries: [gwEntry(402, mid, 'zcode', { cause: 'quota' }), gwEntry(429, mid), gwEntry(503, mid)],
      window: WIN,
      backend: 'zcode-headless',
    })
    expect(r.transient).toBe(true)
    expect(r.cause).toBe('quota')
    expect(r.hits).toBe(1)
    expect(r.reason).toContain('429×1, 503×1')
  })

  it('非参与 cause（connect_failed 等）维持状态码路径：不产 cause 字段', () => {
    const r = classifyWorkerCrash({
      output: '',
      stderrTail: '',
      entries: [gwEntry(500, mid, 'zcode', { cause: 'connect_failed' })],
      window: WIN,
      backend: 'zcode-headless',
    })
    expect(r).toEqual({ transient: true, source: 'gateway', hits: 1, reason: '500×1' })
  })

  it('成功条目（status<400）即便带 cause 也不采信（防御：cause 只认失败条目）', () => {
    const r = classifyWorkerCrash({
      output: '',
      stderrTail: '',
      entries: [gwEntry(200, mid, 'zcode', { cause: 'proto_endpoint_missing' })],
      window: WIN,
      backend: 'zcode-headless',
    })
    expect(r).toEqual({ transient: false, source: 'regex' })
  })

  it('clampRetryWindowMs 边界；keypoolMinRemainingMs 从 metrics json 提取全池最小余量', () => {
    expect(clampRetryWindowMs(0)).toBe(RETRY_WINDOW_MIN_MS)
    expect(clampRetryWindowMs(-5)).toBe(RETRY_WINDOW_MIN_MS)
    expect(clampRetryWindowMs(1234.6)).toBe(1235)
    expect(keypoolMinRemainingMs({ keypool: { up: { total: 2, healthy: 0, cooldown: [{ index: 0, remaining_ms: 90_000 }, { index: 1, remaining_ms: 30_000 }] }, p2: { cooldown: [] } } })).toBe(30_000)
    expect(keypoolMinRemainingMs({ keypool: { up: { cooldown: [] } } })).toBeNull()
    expect(keypoolMinRemainingMs({})).toBeNull()
    expect(keypoolMinRemainingMs(null)).toBeNull()
  })
})

describe('orchestrator transient > classifyWorkerCrashFromDisk（A1 异步接线，metrics keypool）', () => {
  it('无 cfg → 不问 metrics：key_cooldown 照常 transient、无 retryMs（既有退避兜底）', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gwlog-cause-'))
    try {
      const mid = new Date(Date.now() - 30_000).toISOString()
      writeLog(dir, { ts: mid, status: 429, harness: 'zcode', profile: 'p', model: 'm', cause: 'key_cooldown' })
      const r = await classifyWorkerCrashFromDisk({
        gwDir: dir,
        cfg: null,
        output: '',
        stderrTail: '',
        window: { startMs: Date.now() - 60_000, endMs: Date.now() },
        backend: 'zcode-headless',
      })
      expect(r.transient).toBe(true)
      expect(r.cause).toBe('key_cooldown')
      expect(r.retryMs).toBeUndefined()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('cfg + admin 可得 → metrics keypool 余量推导 retryMs（最早可用 key）', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gwlog-cause-kp-'))
    let hits = 0
    const server = http.createServer((req, res) => {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        if (req.url !== '/_modeldock/metrics') {
          res.writeHead(404)
          res.end('{}')
          return
        }
        hits += 1
        if (req.headers['x-modeldock-admin'] !== 'mock-admin') {
          res.writeHead(401)
          res.end('{}')
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ keypool: { up: { total: 2, healthy: 0, cooldown: [{ index: 0, remaining_ms: 90_000 }, { index: 1, remaining_ms: 45_000 }] } } }))
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    process.env.ORCH_GATEWAY_BASE = `http://127.0.0.1:${port}`
    process.env.ORCH_GATEWAY_ADMIN_TOKEN = 'mock-admin'
    try {
      const mid = new Date(Date.now() - 30_000).toISOString()
      writeLog(dir, { ts: mid, status: 429, harness: 'zcode', profile: 'p', model: 'm', cause: 'key_cooldown' })
      const r = await classifyWorkerCrashFromDisk({
        gwDir: dir,
        cfg: { gatewayAdmin: true },
        output: '',
        stderrTail: '',
        window: { startMs: Date.now() - 60_000, endMs: Date.now() },
        backend: 'zcode-headless',
      })
      expect(r.transient).toBe(true)
      expect(r.cause).toBe('key_cooldown')
      expect(r.retryMs).toBe(45_000)
      expect(hits).toBe(1)
    } finally {
      delete process.env.ORCH_GATEWAY_BASE
      delete process.env.ORCH_GATEWAY_ADMIN_TOKEN
      server.close()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('无 key 池 cause → 不问 metrics（死端口仅 logs/query 快速失败落回文件直读，状态码路径照常）', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gwlog-cause-plain-'))
    process.env.ORCH_GATEWAY_BASE = 'http://127.0.0.1:1'
    process.env.ORCH_GATEWAY_ADMIN_TOKEN = 'x'
    try {
      const mid = new Date(Date.now() - 30_000).toISOString()
      writeLog(dir, { ts: mid, status: 429, harness: 'zcode', profile: 'p', model: 'm' })
      const t0 = Date.now()
      const r = await classifyWorkerCrashFromDisk({
        gwDir: dir,
        cfg: { gatewayAdmin: true },
        output: '',
        stderrTail: '',
        window: { startMs: Date.now() - 60_000, endMs: Date.now() },
        backend: 'zcode-headless',
      })
      expect(r).toEqual({ transient: true, source: 'gateway', hits: 1, reason: '429×1' })
      // HTTP 优先（2026-11-09）：logs/query 打死端口连接拒绝即时失败 → 落回文件直读；
      // metrics 不问（窗口无 key 池 cause）——死端口超时/挂起不应发生，整体仍要快
      expect(Date.now() - t0).toBeLessThan(5_000)
    } finally {
      delete process.env.ORCH_GATEWAY_BASE
      delete process.env.ORCH_GATEWAY_ADMIN_TOKEN
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// HTTP 优先取数（2026-11-09）：/_modeldock/logs/query 明细端点，文件直读降为 fallback
// ---------------------------------------------------------------------------

/** logs/query mock admin server：记录命中请求（url/admin 头），respond 决定响应，
 *  返回 falsy = 不响应（挂起，超时用例）。listen(0) 随机端口；close 由调用方 finally 负责。 */
async function startLogsQueryMock(
  respond: (u: URL, adminHeader: string | undefined) => { status: number; body: unknown } | undefined,
) {
  const hits: Array<{ url: URL; admin: string | undefined }> = []
  const server = http.createServer((req, res) => {
    const admin = req.headers['x-modeldock-admin'] as string | undefined
    const u = new URL(req.url ?? '/', 'http://x')
    if (u.pathname !== '/_modeldock/logs/query') {
      hits.push({ url: u, admin })
      res.writeHead(404)
      res.end('{}')
      return
    }
    hits.push({ url: u, admin })
    const r = respond(u, admin)
    if (!r) return // 挂起不响应
    res.writeHead(r.status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(r.body))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return { server, port, hits }
}

describe('orchestrator transient > HTTP 优先取数（logs/query，文件 fallback）', () => {
  const WIN = { startMs: Date.parse('2026-11-08T10:00:00+08:00'), endMs: Date.parse('2026-11-08T10:05:00+08:00') }
  const older = '2026-11-08T10:02:00.000+08:00'
  const newer = '2026-11-08T10:03:00.000+08:00'

  it('admin 可得 → 一次窗口查询喂分类（含 cause 精读）：参数 from/to/limit=500、不传 harness', async () => {
    const { server, port, hits } = await startLogsQueryMock((u, admin) => {
      expect(admin).toBe('mock-admin')
      expect(Number(u.searchParams.get('limit'))).toBe(500)
      // 拿不准 backend → 网关实名的映射就不传 harness，客户端 harnessMatches 兜底
      expect(u.searchParams.get('harness')).toBeNull()
      // from/to 与 /usage 同口径（ISO 串）且覆盖窗口
      expect(Date.parse(u.searchParams.get('from') ?? '')).toBeLessThanOrEqual(WIN.startMs)
      expect(Date.parse(u.searchParams.get('to') ?? '')).toBeGreaterThanOrEqual(WIN.endMs)
      // 网关倒序返回（最新在前）：429(新) 在前、decisive cause(旧) 在后
      return {
        status: 200,
        body: {
          ok: true,
          days: ['2026-11-08'],
          filter: null,
          limit: 500,
          entries: [
            gwEntry(429, newer, 'zcode'),
            gwEntry(404, older, 'zcode', { cause: 'proto_endpoint_missing', hint: '模型未配置 anthropic 端点' }),
          ],
        },
      }
    })
    process.env.ORCH_GATEWAY_BASE = `http://127.0.0.1:${port}`
    process.env.ORCH_GATEWAY_ADMIN_TOKEN = 'mock-admin'
    const noDir = path.join(os.tmpdir(), 'no-such-gwdir-http-ok')
    try {
      const r = await classifyWorkerCrashFromDisk({
        gwDir: noDir, // 目录不存在：decisive 结果即证明条目来自 HTTP（未落回文件直读）
        cfg: { gatewayAdmin: true },
        output: '',
        stderrTail: '',
        window: WIN,
        backend: 'zcode-headless',
      })
      // cause 精读路径经 HTTP 条目不回归：决定性归因压过同窗 429
      expect(r.transient).toBe(false)
      expect(r.source).toBe('gateway')
      expect(r.decisive).toBe(true)
      expect(r.cause).toBe('proto_endpoint_missing')
      expect(r.hint).toBe('模型未配置 anthropic 端点')
      expect(r.hits).toBe(1)
      expect(hits.length).toBe(1) // 一次窗口查询，无 metrics 等额外请求
    } finally {
      delete process.env.ORCH_GATEWAY_BASE
      delete process.env.ORCH_GATEWAY_ADMIN_TOKEN
      server.close()
      fs.rmSync(noDir, { recursive: true, force: true })
    }
  })

  it('fetchGatewayWindowEntries：网关倒序条目正序归位（与文件直读追加序一致）', async () => {
    const { server, port } = await startLogsQueryMock(() => ({
      status: 200,
      body: { ok: true, entries: [gwEntry(503, newer), gwEntry(429, older)] },
    }))
    process.env.ORCH_GATEWAY_BASE = `http://127.0.0.1:${port}`
    process.env.ORCH_GATEWAY_ADMIN_TOKEN = 'mock-admin'
    try {
      const entries = await fetchGatewayWindowEntries({ gatewayAdmin: true }, { ...WIN })
      expect(entries).not.toBeNull()
      expect(entries!.map((e) => e.status)).toEqual([429, 503]) // 旧 → 新
    } finally {
      delete process.env.ORCH_GATEWAY_BASE
      delete process.env.ORCH_GATEWAY_ADMIN_TOKEN
      server.close()
    }
  })

  it('网关 500 → 落回文件直读（夹具命中，结果与现状一致）', async () => {
    const { server, port } = await startLogsQueryMock(() => ({ status: 500, body: { ok: false, error: 'boom' } }))
    process.env.ORCH_GATEWAY_BASE = `http://127.0.0.1:${port}`
    process.env.ORCH_GATEWAY_ADMIN_TOKEN = 'mock-admin'
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gwlog-http-500-'))
    try {
      writeLog(dir, { ts: older, status: 429, harness: 'zcode', profile: 'p', model: 'm' })
      const r = await classifyWorkerCrashFromDisk({
        gwDir: dir,
        cfg: { gatewayAdmin: true },
        output: '',
        stderrTail: '',
        window: WIN,
        backend: 'zcode-headless',
      })
      expect(r).toEqual({ transient: true, source: 'gateway', hits: 1, reason: '429×1' })
    } finally {
      delete process.env.ORCH_GATEWAY_BASE
      delete process.env.ORCH_GATEWAY_ADMIN_TOKEN
      server.close()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('响应缺 entries（旧版网关形状不符）→ 落回文件直读', async () => {
    const { server, port } = await startLogsQueryMock(() => ({ status: 200, body: { ok: true, days: [] } }))
    process.env.ORCH_GATEWAY_BASE = `http://127.0.0.1:${port}`
    process.env.ORCH_GATEWAY_ADMIN_TOKEN = 'mock-admin'
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gwlog-http-shape-'))
    try {
      writeLog(dir, { ts: older, status: 402, harness: 'zcode', profile: 'p', model: 'm', cause: 'quota' })
      const r = await classifyWorkerCrashFromDisk({
        gwDir: dir,
        cfg: { gatewayAdmin: true },
        output: '',
        stderrTail: '',
        window: WIN,
        backend: 'zcode-headless',
      })
      expect(r.transient).toBe(true)
      expect(r.source).toBe('gateway')
      expect(r.cause).toBe('quota')
      expect(r.switchProvider).toBe(true)
    } finally {
      delete process.env.ORCH_GATEWAY_BASE
      delete process.env.ORCH_GATEWAY_ADMIN_TOKEN
      server.close()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('挂起响应 → 超时 fail-open 返回 null（小超时直测 fetchGatewayWindowEntries）', async () => {
    const { server, port } = await startLogsQueryMock(() => undefined) // 永不响应
    process.env.ORCH_GATEWAY_BASE = `http://127.0.0.1:${port}`
    process.env.ORCH_GATEWAY_ADMIN_TOKEN = 'mock-admin'
    try {
      const r = await fetchGatewayWindowEntries({ gatewayAdmin: true }, { ...WIN, timeoutMs: 150 })
      expect(r).toBeNull()
    } finally {
      delete process.env.ORCH_GATEWAY_BASE
      delete process.env.ORCH_GATEWAY_ADMIN_TOKEN
      server.close()
    }
  })

  it('未开启 gatewayAdmin（cfg 缺开关）→ 不触网，文件直读行为不变', async () => {
    const { server, port, hits } = await startLogsQueryMock(() => ({ status: 200, body: { ok: true, entries: [] } }))
    process.env.ORCH_GATEWAY_BASE = `http://127.0.0.1:${port}` // env 在但 cfg 门不开：一律不触达
    process.env.ORCH_GATEWAY_ADMIN_TOKEN = 'mock-admin'
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gwlog-http-nogate-'))
    try {
      writeLog(dir, { ts: older, status: 429, harness: 'zcode', profile: 'p', model: 'm' })
      const r = await classifyWorkerCrashFromDisk({
        gwDir: dir,
        cfg: {}, // gatewayAdmin !== true → resolveGatewayAdmin null（可移植红线）
        output: '',
        stderrTail: '',
        window: WIN,
        backend: 'zcode-headless',
      })
      expect(r).toEqual({ transient: true, source: 'gateway', hits: 1, reason: '429×1' })
      expect(hits.length).toBe(0)
    } finally {
      delete process.env.ORCH_GATEWAY_BASE
      delete process.env.ORCH_GATEWAY_ADMIN_TOKEN
      server.close()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('HTTP 成功但窗口无条目 → 权威空数组（不落回文件直读，文件夹具在也不读）→ regex 兜底', async () => {
    const { server, port } = await startLogsQueryMock(() => ({ status: 200, body: { ok: true, entries: [] } }))
    process.env.ORCH_GATEWAY_BASE = `http://127.0.0.1:${port}`
    process.env.ORCH_GATEWAY_ADMIN_TOKEN = 'mock-admin'
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gwlog-http-empty-'))
    try {
      writeLog(dir, { ts: older, status: 429, harness: 'zcode', profile: 'p', model: 'm' }) // 文件有数据也不读
      const r = await classifyWorkerCrashFromDisk({
        gwDir: dir,
        cfg: { gatewayAdmin: true },
        output: '',
        stderrTail: '',
        window: WIN,
        backend: 'zcode-headless',
      })
      expect(r).toEqual({ transient: false, source: 'regex' })
    } finally {
      delete process.env.ORCH_GATEWAY_BASE
      delete process.env.ORCH_GATEWAY_ADMIN_TOKEN
      server.close()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('两路都无数据（HTTP 404 + gwDir 空目录）→ regex 兜底', async () => {
    const { server, port } = await startLogsQueryMock(() => ({ status: 404, body: {} })) // 旧实例无端点
    process.env.ORCH_GATEWAY_BASE = `http://127.0.0.1:${port}`
    process.env.ORCH_GATEWAY_ADMIN_TOKEN = 'mock-admin'
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gwlog-http-none-'))
    try {
      const r = await classifyWorkerCrashFromDisk({
        gwDir: dir,
        cfg: { gatewayAdmin: true },
        output: '429 too many requests', // 正则兜底证据
        stderrTail: '',
        window: WIN,
        backend: 'zcode-headless',
      })
      expect(r).toEqual({ transient: true, source: 'regex' })
    } finally {
      delete process.env.ORCH_GATEWAY_BASE
      delete process.env.ORCH_GATEWAY_ADMIN_TOKEN
      server.close()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('harness 过滤语义：HTTP 条目实名 zcode 与 backend zcode-headless 宽容匹配计入，claude-code 不计入', async () => {
    const { server, port } = await startLogsQueryMock(() => ({
      status: 200,
      body: {
        ok: true,
        entries: [gwEntry(429, newer, 'zcode'), gwEntry(503, older, 'claude-code')],
      },
    }))
    process.env.ORCH_GATEWAY_BASE = `http://127.0.0.1:${port}`
    process.env.ORCH_GATEWAY_ADMIN_TOKEN = 'mock-admin'
    try {
      const r = await classifyWorkerCrashFromDisk({
        gwDir: path.join(os.tmpdir(), 'no-such-gwdir-harness'),
        cfg: { gatewayAdmin: true },
        output: '',
        stderrTail: '',
        window: WIN,
        backend: 'zcode-headless',
      })
      expect(r).toEqual({ transient: true, source: 'gateway', hits: 1, reason: '429×1' }) // 只计 zcode 条目
      // backend 与窗口内全部实名都不匹配（claude-code 与 codex 船不同源）→ 零条目计入 → regex 兜底
      const r2 = await classifyWorkerCrashFromDisk({
        gwDir: path.join(os.tmpdir(), 'no-such-gwdir-harness'),
        cfg: { gatewayAdmin: true },
        output: '',
        stderrTail: '',
        window: WIN,
        backend: 'codex-headless',
      })
      expect(r2).toEqual({ transient: false, source: 'regex' })
    } finally {
      delete process.env.ORCH_GATEWAY_BASE
      delete process.env.ORCH_GATEWAY_ADMIN_TOKEN
      server.close()
    }
  })
})
