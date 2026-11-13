// debug 日志能力回归：开关矩阵（默认关/三通道）、落盘按天命名与保留期清理、
// 管理面访问日志（2026-11-07 事故盲区：attach/plan 此前零痕迹）、doctor 自描述项。
// fakeHome 隔离；server 集成用裸 http.request（对齐 observability.test.ts 范式）。
import { describe, expect, it, afterEach, afterAll } from 'vitest'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { fakeHome } from './helpers.js'
import { debugEnabled, debugLog, debugOn, refreshDebugOn, setDebugFlag } from '../src/gateway/state/debuglog.js'
import { eventsLogName, pruneExpiredLogs } from '../src/gateway/state/logs.js'
import { logsDir } from '../src/util/paths.js'
import { localDateStr } from '../src/util/index.js'
import { drainAppendStreams } from '../src/util/fsx.js'
import { buildRuntime } from '../src/gateway/state.js'
import { createGatewayServer } from '../src/gateway/server.js'
import { collectDoctorFindings } from '../src/cli/diag.js'

const h = fakeHome()
afterAll(async () => {
  await drainAppendStreams()
  h.restore()
})

// debug 文件名日期 = localIsoTs().slice(0,10)（带横线 ISO 本地日期），与 localDateStr 同口径
function ymdOf(d: Date): string {
  return localDateStr(d)
}

/** 还原三源开关模块态：本文件改过的旗标/env 必须每例复位，防跨文件污染 */
const prevDebugEnv = process.env.MODELRDOCK_DEBUG
afterEach(() => {
  setDebugFlag(false)
  refreshDebugOn(undefined)
  if (prevDebugEnv === undefined) delete process.env.MODELRDOCK_DEBUG
  else process.env.MODELRDOCK_DEBUG = prevDebugEnv
})

describe('debugEnabled 三源合并（纯函数）', () => {
  it('默认全关；config/env/flag 任一为真即开；env 严格 === \'1\'', () => {
    delete process.env.MODELRDOCK_DEBUG
    expect(debugEnabled({})).toBe(false)
    expect(debugEnabled({ config: { debug: false } })).toBe(false)
    expect(debugEnabled({ config: { debug: true } })).toBe(true)
    expect(debugEnabled({ flag: true, config: { debug: false } })).toBe(true)
    process.env.MODELRDOCK_DEBUG = '1'
    expect(debugEnabled({})).toBe(true)
    expect(debugEnabled({ config: { debug: false } })).toBe(true) // env 开覆盖 config 关
    process.env.MODELRDOCK_DEBUG = 'true'
    expect(debugEnabled({})).toBe(false) // 非 '1' 不算开（严格口径）
  })
})

describe('debugOn 模块态（启动旗标 + 热加载重算）', () => {
  it('setDebugFlag/refreshDebugOn 按三源重算', () => {
    delete process.env.MODELRDOCK_DEBUG
    setDebugFlag(true)
    refreshDebugOn(undefined)
    expect(debugOn()).toBe(true)
    setDebugFlag(false)
    refreshDebugOn(undefined)
    expect(debugOn()).toBe(false)
    refreshDebugOn({ debug: true })
    expect(debugOn()).toBe(true)
  })
})

describe('debugLog 落盘与保留期', () => {
  it('写入 debug-<今天>.jsonl，行含 level/scope/op 与 data 字段', async () => {
    debugLog('spawn', 'cli_version', { cmd: 'x --version', ok: true })
    await drainAppendStreams() // 追加流异步建文件：读前先排空
    const file = path.join(logsDir(), `debug-${ymdOf(new Date())}.jsonl`)
    expect(fs.existsSync(file)).toBe(true)
    const line = JSON.parse(fs.readFileSync(file, 'utf8').trim())
    expect(line.level).toBe('debug')
    expect(line.scope).toBe('spawn')
    expect(line.op).toBe('cli_version')
    expect(line.cmd).toBe('x --version')
    expect(typeof line.ts).toBe('string')
  })

  it('保留期清理覆盖 debug 前缀：过期日文件删除、新文件保留', async () => {
    const dir = logsDir()
    fs.writeFileSync(path.join(dir, 'debug-2020-01-01.jsonl'), '{}\n')
    fs.writeFileSync(path.join(dir, 'debug-2020-01-01.jsonl.bak'), '{}\n') // 非日文件诱饵
    const n = await pruneExpiredLogs(30, new Date('2026-11-07T12:00:00'))
    expect(n).toBeGreaterThanOrEqual(1)
    expect(fs.existsSync(path.join(dir, 'debug-2020-01-01.jsonl'))).toBe(false)
    expect(fs.existsSync(path.join(dir, 'debug-2020-01-01.jsonl.bak'))).toBe(true) // 非日文件不动
  })
})

function listenEphemeral(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port))
  })
}

function post(port: number, reqPath: string, headers: Record<string, string>, body: string): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: reqPath, method: 'POST', headers }, (res) => {
      res.resume()
      res.on('end', () => resolve({ status: res.statusCode ?? 0 }))
    })
    req.on('error', reject)
    req.end(body)
  })
}

function readDebugLines(): Array<Record<string, unknown>> {
  const dir = logsDir()
  return fs
    .readdirSync(dir)
    .filter((f) => /^debug-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
    .flatMap((f) => fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n').filter(Boolean))
    .map((l) => JSON.parse(l) as Record<string, unknown>)
}

describe('管理面访问日志（handleAdmin finish 钩子）', () => {
  it('debug 开启：attach/plan 请求落 {method,path,status,ms} 行；4xx 另有无条件 events 行', async () => {
    setDebugFlag(true)
    refreshDebugOn(undefined)
    const cfg = { providers: {}, profiles: {}, harness: {} } as never
    const rt = buildRuntime(cfg, 'admin-token-dbg')
    const server = createGatewayServer(rt, { port: 0 })
    const port = await listenEphemeral(server)
    try {
      // harness 传不存在 id → planAttach 同步 400（确定性，不依赖宿主装了哪些 CLI）
      const res = await post(port, '/_modeldock/attach/plan', { 'x-modeldock-admin': 'admin-token-dbg' }, JSON.stringify({ harness: '__nonexistent__' }))
      expect(res.status).toBe(400)
      await drainAppendStreams()
      const hit = readDebugLines().find((l) => l.scope === 'admin' && l.op === 'http' && l.path === '/_modeldock/attach/plan')
      expect(hit).toBeTruthy()
      expect(hit?.method).toBe('POST')
      expect(hit?.status).toBe(400)
      expect(typeof hit?.ms).toBe('number')
      const events = fs.readFileSync(path.join(logsDir(), eventsLogName()), 'utf8')
      expect(events).toContain('admin_http_error')
      expect(events).toContain('/_modeldock/attach/plan')
    } finally {
      server.closeAllConnections?.()
      server.close()
    }
  })

  it('debug 关闭：不落 admin debug 行（events 行仍无条件）', async () => {
    setDebugFlag(false)
    refreshDebugOn(undefined)
    const cfg = { providers: {}, profiles: {}, harness: {} } as never
    const rt = buildRuntime(cfg, 'admin-token-dbg')
    const server = createGatewayServer(rt, { port: 0 })
    const port = await listenEphemeral(server)
    try {
      const before = readDebugLines().filter((l) => l.scope === 'admin').length
      const res = await post(port, '/_modeldock/attach/plan', { 'x-modeldock-admin': 'admin-token-dbg' }, JSON.stringify({ harness: '__nonexistent__' }))
      expect(res.status).toBe(400)
      await drainAppendStreams()
      const after = readDebugLines().filter((l) => l.scope === 'admin').length
      expect(after).toBe(before)
      expect(fs.readFileSync(path.join(logsDir(), eventsLogName()), 'utf8')).toContain('admin_http_error')
    } finally {
      server.closeAllConnections?.()
      server.close()
    }
  })
})

describe('doctor logs.debug 自描述项', () => {
  it('关态给 info + 开启方法 hint；env 开启后为 ok', async () => {
    setDebugFlag(false)
    refreshDebugOn(undefined)
    const off = await collectDoctorFindings()
    const fOff = off.find((x) => x.id === 'logs.debug')
    expect(fOff?.level).toBe('info')
    expect(fOff?.hint).toContain('debug')
    process.env.MODELRDOCK_DEBUG = '1'
    try {
      const on = await collectDoctorFindings()
      expect(on.find((x) => x.id === 'logs.debug')?.level).toBe('ok')
    } finally {
      delete process.env.MODELRDOCK_DEBUG
    }
  })
})
