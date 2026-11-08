// /_modeldock/logs/query 请求日志明细查询端点（编排器/Dockmaster 排障数据面）：
// from/to 与 /usage 同口径（31 天封顶）、harness/provider/cause/status_class 过滤、
// limit 缺省 100 上限 500、按时间倒序（最新在前）；条目为落盘 LogEntry 原样投影
// （脱敏在落盘侧完成：tokenHint 仅前 8 字符，端点绝不新增明文密钥字段）。
// 取数走 streamRequestLogDays（与 /usage 聚合共用同一流式解析管道）。

import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { AddressInfo } from 'node:net'
import { describe, expect, it } from 'vitest'
import { fakeHome } from './helpers.js'
import {
  buildRuntime,
  filterLogEntries,
  logEntryMatches,
  readRequestLogDay,
  streamRequestLogDays,
} from '../src/gateway/state.js'
import type { LogEntry } from '../src/gateway/state.js'
import { createGatewayServer } from '../src/gateway/server.js'
import { logsDir } from '../src/util/paths.js'
import { localIsoTs } from '../src/util/time.js'

function listenEphemeral(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port))
  })
}

function request(port: number, reqPath: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: reqPath, headers }, (res) => {
      let out = ''
      res.on('data', (c) => (out += c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: out }))
    })
    req.on('error', reject)
    req.end()
  })
}

const ADMIN = { 'x-modeldock-admin': 'admin-token-lq' }

async function setup() {
  const h = fakeHome()
  const cfg = {
    providers: { up: { base_url: 'https://up.example.com', protocol: 'anthropic', auth_style: 'bearer', key_ref: 'file:k' } },
    profiles: { default: { provider: 'up', default_model: 'm1' } },
    harness: {},
  } as never
  const rt = buildRuntime(cfg, 'admin-token-lq')
  const server = createGatewayServer(rt, { port: 0 })
  const port = await listenEphemeral(server)
  return {
    port,
    close: () => {
      server.closeAllConnections?.()
      server.close()
      h.restore()
    },
  }
}

/** 直写日文件（绕开常驻追加流池，无刷盘时序；路径一律经 logsDir()，跨平台无盘符硬编码） */
function writeDayFile(day: string, entries: LogEntry[]): void {
  fs.mkdirSync(logsDir(), { recursive: true })
  fs.writeFileSync(path.join(logsDir(), `gateway-${day}.jsonl`), entries.map((e) => JSON.stringify(e)).join('\n') + '\n')
}

const now = new Date()
const today = localIsoTs(now).slice(0, 10)
const yesterdayTs = new Date(now.getTime() - 86_400_000)
const yesterday = localIsoTs(yesterdayTs).slice(0, 10)

const entry = (over: Partial<LogEntry>): LogEntry =>
  ({
    ts: localIsoTs(now),
    harness: 'zcode',
    profile: 'p',
    provider: 'up',
    model: 'glm-4.7',
    path: '/v1/messages',
    ...over,
  }) as LogEntry

describe('/_modeldock/logs/query（admin 门内只读，明细查询）', () => {
  it('401 无凭据；200 带 cache-control: no-store（管理面统一口径）', async () => {
    const t = await setup()
    try {
      const noAuth = await request(t.port, `/_modeldock/logs/query?date=${today}`)
      expect(noAuth.status).toBe(401)
      writeDayFile(today, [entry({ status: 200 })])
      const ok = await request(t.port, `/_modeldock/logs/query?date=${today}`, ADMIN)
      expect(ok.status).toBe(200)
      expect(ok.headers['cache-control']).toBe('no-store')
      const j = JSON.parse(ok.body)
      expect(j.ok).toBe(true)
      expect(j.days).toEqual([today])
      expect(j.filter).toBeNull()
      expect(j.limit).toBe(100) // 缺省 limit
      expect(j.entries).toHaveLength(1)
    } finally {
      t.close()
    }
  })

  it('按时间倒序（最新在前）；缺省 limit=100', async () => {
    const t = await setup()
    try {
      const entries: LogEntry[] = []
      for (let i = 0; i < 150; i++) {
        entries.push(entry({ ts: localIsoTs(new Date(now.getTime() - (150 - i) * 1_000)), status: 200 }))
      }
      writeDayFile(today, entries)
      const j = JSON.parse((await request(t.port, `/_modeldock/logs/query?date=${today}`, ADMIN)).body)
      expect(j.entries).toHaveLength(100) // 缺省 100
      // 倒序：第一条是文件里最新的，最后一条是第 51 条写入的（150 条中第 100 新）
      expect(j.entries[0].ts).toBe(entries[149].ts)
      expect(j.entries[99].ts).toBe(entries[50].ts)
    } finally {
      t.close()
    }
  })

  it('limit 封顶 500：超配夹到上限；非法值回落缺省 100', async () => {
    const t = await setup()
    try {
      const entries: LogEntry[] = []
      for (let i = 0; i < 600; i++) {
        entries.push(entry({ ts: localIsoTs(new Date(now.getTime() - (600 - i) * 1_000)), status: 200 }))
      }
      writeDayFile(today, entries)
      const capped = JSON.parse((await request(t.port, `/_modeldock/logs/query?date=${today}&limit=9999`, ADMIN)).body)
      expect(capped.limit).toBe(500)
      expect(capped.entries).toHaveLength(500)
      expect(capped.entries[0].ts).toBe(entries[599].ts) // 仍是最新 500 条
      const bad = JSON.parse((await request(t.port, `/_modeldock/logs/query?date=${today}&limit=abc`, ADMIN)).body)
      expect(bad.limit).toBe(100)
      expect(bad.entries).toHaveLength(100)
    } finally {
      t.close()
    }
  })

  it('过滤维度：harness / provider / cause / status_class 各自生效（全部 AND）', async () => {
    const t = await setup()
    try {
      writeDayFile(today, [
        entry({ ts: localIsoTs(new Date(now.getTime() - 5_000)), status: 200 }),
        entry({ ts: localIsoTs(new Date(now.getTime() - 4_000)), harness: 'claude-code', status: 200 }),
        entry({ ts: localIsoTs(new Date(now.getTime() - 3_000)), provider: 'other', status: 200 }),
        entry({ ts: localIsoTs(new Date(now.getTime() - 2_000)), status: 429, cause: 'quota', hint: '换 Key 或等冷却' }),
        entry({ ts: localIsoTs(new Date(now.getTime() - 1_000)), status: 500, cause: 'upstream_5xx' }),
      ])
      const byHarness = JSON.parse((await request(t.port, `/_modeldock/logs/query?date=${today}&harness=claude-code`, ADMIN)).body)
      expect(byHarness.filter).toEqual({ harness: 'claude-code' })
      expect(byHarness.entries).toHaveLength(1)
      expect(byHarness.entries[0].harness).toBe('claude-code')
      const byProvider = JSON.parse((await request(t.port, `/_modeldock/logs/query?date=${today}&provider=other`, ADMIN)).body)
      expect(byProvider.entries).toHaveLength(1)
      expect(byProvider.entries[0].provider).toBe('other')
      const byCause = JSON.parse((await request(t.port, `/_modeldock/logs/query?date=${today}&cause=quota`, ADMIN)).body)
      expect(byCause.entries).toHaveLength(1)
      expect(byCause.entries[0].hint).toBe('换 Key 或等冷却')
      const by4xx = JSON.parse((await request(t.port, `/_modeldock/logs/query?date=${today}&status_class=4xx`, ADMIN)).body)
      expect(by4xx.entries).toHaveLength(1)
      expect(by4xx.entries[0].status).toBe(429)
      const by5xx = JSON.parse((await request(t.port, `/_modeldock/logs/query?date=${today}&status_class=5xx`, ADMIN)).body)
      expect(by5xx.entries).toHaveLength(1)
      expect(by5xx.entries[0].status).toBe(500)
      // 组合过滤：harness + cause
      const combo = JSON.parse((await request(t.port, `/_modeldock/logs/query?date=${today}&harness=zcode&cause=quota`, ADMIN)).body)
      expect(combo.entries).toHaveLength(1)
      expect(combo.entries[0].status).toBe(429)
      expect(combo.filter).toEqual({ harness: 'zcode', cause: 'quota' })
      // 非法 status_class → 400 双语报错
      const bad = await request(t.port, `/_modeldock/logs/query?date=${today}&status_class=xx4`, ADMIN)
      expect(bad.status).toBe(400)
      expect(JSON.parse(bad.body).error.message).toContain('status_class')
    } finally {
      t.close()
    }
  })

  it('from/to 跨日窗口：倒序跨日归并（今日在前、昨日在后）；窗口外条目不出现', async () => {
    const t = await setup()
    try {
      writeDayFile(yesterday, [
        entry({ ts: localIsoTs(new Date(yesterdayTs.getTime() - 2_000)), status: 200 }),
        entry({ ts: localIsoTs(new Date(yesterdayTs.getTime() - 1_000)), status: 200 }),
      ])
      writeDayFile(today, [
        entry({ ts: localIsoTs(new Date(now.getTime() - 2_000)), status: 200 }),
        entry({ ts: localIsoTs(new Date(now.getTime() - 1_000)), status: 200 }),
      ])
      const j = JSON.parse((await request(t.port, `/_modeldock/logs/query?from=${yesterday}&to=${today}`, ADMIN)).body)
      expect(j.days).toEqual([yesterday, today])
      expect(j.entries.map((e: LogEntry) => e.ts)).toEqual([
        localIsoTs(new Date(now.getTime() - 1_000)),
        localIsoTs(new Date(now.getTime() - 2_000)),
        localIsoTs(new Date(yesterdayTs.getTime() - 1_000)),
        localIsoTs(new Date(yesterdayTs.getTime() - 2_000)),
      ])
      // 窗口只圈昨日：今日条目不出现
      const onlyY = JSON.parse((await request(t.port, `/_modeldock/logs/query?date=${yesterday}`, ADMIN)).body)
      expect(onlyY.entries).toHaveLength(2)
      expect(onlyY.entries[0].ts).toBe(localIsoTs(new Date(yesterdayTs.getTime() - 1_000)))
    } finally {
      t.close()
    }
  })

  it('窗口与参数复用 /usage 口径：31 天封顶 / to 早于 from / date 非法 → 400 双语', async () => {
    const t = await setup()
    try {
      const tooWide = await request(t.port, '/_modeldock/logs/query?from=2000-01-01&to=2030-01-01', ADMIN)
      expect(tooWide.status).toBe(400)
      expect(JSON.parse(tooWide.body).error.message).toContain('31')
      const badRange = await request(t.port, '/_modeldock/logs/query?from=2026-11-10&to=2026-11-01', ADMIN)
      expect(badRange.status).toBe(400)
      const badDate = await request(t.port, '/_modeldock/logs/query?date=20261101', ADMIN)
      expect(badDate.status).toBe(400)
      expect(JSON.parse(badDate.body).modeldock.hint).toContain('/_modeldock/logs/query')
    } finally {
      t.close()
    }
  })

  it('明细字段原样投影：cause/attempts/hint/tokenHint 原样返回，绝不新增明文密钥字段', async () => {
    const t = await setup()
    try {
      const withDetail = entry({
        status: 502,
        cause: 'upstream_5xx',
        hint: '检查上游地址与网络（境外上游需代理）',
        tokenHint: 'mdk_tok_',
        attempts: [
          { provider: 'up', status: 502, ms: 120 },
          { provider: 'fb', note: 'connect_failed' },
        ],
        requestId: 'abcd1234efgh5678',
      })
      writeDayFile(today, [withDetail])
      const j = JSON.parse((await request(t.port, `/_modeldock/logs/query?date=${today}`, ADMIN)).body)
      expect(j.entries).toHaveLength(1)
      expect(j.entries[0]).toEqual(withDetail) // 原样：不多不少
      expect(j.entries[0].tokenHint).toHaveLength(8) // 脱敏口径不破（前 8 字符）
      expect(JSON.stringify(j)).not.toContain('sk-') // 无任何 key 材料
    } finally {
      t.close()
    }
  })
})

describe('streamRequestLogDays / logEntryMatches 扩展（cause / statusClass）', () => {
  it('logEntryMatches：cause 与 statusClass 过滤；无 status 条目不命中任何状态类', () => {
    const base = { ts: localIsoTs(now), harness: 'zcode', profile: 'p', provider: 'up', path: '/v1/messages' }
    const ok200 = entry({ ...base, status: 200 })
    const e500 = entry({ ...base, status: 500, cause: 'upstream_5xx' })
    const aborted = entry({ ...base }) // 无 status（客户端中止）
    expect(logEntryMatches(e500, { cause: 'upstream_5xx' })).toBe(true)
    expect(logEntryMatches(e500, { cause: 'quota' })).toBe(false)
    expect(logEntryMatches(ok200, { statusClass: '2xx' })).toBe(true)
    expect(logEntryMatches(e500, { statusClass: '5xx' })).toBe(true)
    expect(logEntryMatches(e500, { statusClass: '2xx' })).toBe(false)
    expect(logEntryMatches(aborted, { statusClass: '2xx' })).toBe(false) // 无 status 不命中
  })

  it('streamRequestLogDays 与数组路径（readRequestLogDay+filterLogEntries）同输入同输出；limit 提前终止不悬挂', async () => {
    const h = fakeHome()
    try {
      const entries: LogEntry[] = []
      for (let i = 0; i < 40; i++) {
        entries.push(entry({ ts: localIsoTs(new Date(now.getTime() - (40 - i) * 1_000)), status: i % 2 ? 200 : 500, cause: i % 2 ? undefined : 'upstream_5xx' }))
      }
      writeDayFile(today, entries)
      const f = { statusClass: '5xx' }
      const streamed: LogEntry[] = []
      for await (const e of streamRequestLogDays([today], f)) streamed.push(e)
      expect(streamed).toEqual(filterLogEntries(readRequestLogDay(today), f))
      expect(streamed).toHaveLength(20)
      // 提前终止（取 3 条即 break）：正常返回不悬挂 fd
      const early: LogEntry[] = []
      for await (const e of streamRequestLogDays([today], {})) {
        early.push(e)
        if (early.length === 3) break
      }
      expect(early).toHaveLength(3)
    } finally {
      h.restore()
    }
  })
})
