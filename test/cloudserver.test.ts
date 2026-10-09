import fs from 'node:fs'
import fsp from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { CloudStore } from '../src/cloud/store.js'
import { createCloudServer, generatePairCode } from '../src/cloud/server.js'

const dirs: string[] = []
afterAll(async () => {
  for (const d of dirs) await fsp.rm(d, { recursive: true, force: true }).catch(() => {})
})

function tmpDataDir(): string {
  // os.tmpdir()：Windows 上写死 '/tmp' 会被 path.join 归一成无盘符的 '\tmp'（CI 实测 ENOENT）
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'md-cloud-data-'))
  dirs.push(d)
  return d
}

interface Server {
  port: number
  store: CloudStore
  consoleToken: string
  close: () => Promise<void>
}

async function startServer(opts?: { rateLimitPerMin?: number }): Promise<Server> {
  const dataDir = tmpDataDir()
  const store = new CloudStore(dataDir)
  const consoleToken = 'mdkcloud_' + 'a'.repeat(32)
  const server = createCloudServer(store, { consoleToken, rateLimitPerMin: opts?.rateLimitPerMin ?? 60 })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const addr = server.address() as net.AddressInfo
  return {
    port: addr.port,
    store,
    consoleToken,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve())
        store.close()
      }),
  }
}

async function req(
  port: number,
  method: string,
  p: string,
  o?: { token?: string; body?: unknown; headers?: Record<string, string> }
): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = { ...(o?.headers ?? {}) }
  if (o?.token) headers.authorization = `Bearer ${o.token}`
  let body: string | undefined
  if (o?.body !== undefined) {
    body = JSON.stringify(o.body)
    headers['content-type'] = 'application/json'
  }
  const res = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers, body })
  let json: any = null
  try {
    json = await res.json()
  } catch {
    /* 304 等无 body */
  }
  return { status: res.status, json }
}

const ENVELOPE = (ts: string): string => JSON.stringify({ fmt: 'modeldock-syncenv', v: 1, ts })

async function pairDevice(port: number, consoleToken: string, devid: string, name: string): Promise<string> {
  const pc = await req(port, 'POST', '/v1/paircode', { token: consoleToken, body: {} })
  expect(pc.status).toBe(200)
  const pair = await req(port, 'POST', '/v1/pair', { body: { pairCode: pc.json.pairCode, devid, deviceName: name } })
  expect(pair.status).toBe(200)
  return pair.json.deviceToken as string
}

describe('云端控制面 API v1', () => {
  it('配对：一次性码用后即焚、过期拒绝；生成格式 XXXX-XXXX', async () => {
    const s = await startServer()
    try {
      expect(generatePairCode()).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/)
      const pc = await req(s.port, 'POST', '/v1/paircode', { token: s.consoleToken, body: {} })
      const code = pc.json.pairCode as string
      // 过期码：直接往库里插一条已过期的
      s.store.createPairCode('EXPI-RED1', new Date(Date.now() - 1000).toISOString())
      const ok = await req(s.port, 'POST', '/v1/pair', { body: { pairCode: code, devid: 'mdksync_a', deviceName: '笔记本' } })
      expect(ok.status).toBe(200)
      expect(ok.json.deviceToken).toMatch(/^mdkdev_[0-9a-f]{32,}$/)
      // 同码重放拒绝
      const replay = await req(s.port, 'POST', '/v1/pair', { body: { pairCode: code, devid: 'mdksync_b' } })
      expect(replay.status).toBe(400)
      // 过期码拒绝
      const expired = await req(s.port, 'POST', '/v1/pair', { body: { pairCode: 'EXPI-RED1', devid: 'mdksync_c' } })
      expect(expired.status).toBe(400)
    } finally {
      await s.close()
    }
  })

  it('doc：首推 rev1 → If-None-Match 304 → 基线不符 409 → ts 回滚 422', async () => {
    const s = await startServer()
    try {
      const tok = await pairDevice(s.port, s.consoleToken, 'mdksync_a', 'A')
      // 云端无文档
      expect((await req(s.port, 'GET', '/v1/doc', { token: tok })).status).toBe(404)
      // 首推（If-Match 0）
      const put1 = await req(s.port, 'PUT', '/v1/doc', { token: tok, headers: { 'if-match': '0' }, body: { envelope: ENVELOPE('2026-10-05T01:00:00.000Z'), ts: '2026-10-05T01:00:00.000Z' } })
      expect(put1.status).toBe(200)
      expect(put1.json.rev).toBe(1)
      // If-None-Match 命中 → 304
      const cache = await fetch(`http://127.0.0.1:${s.port}/v1/doc`, { headers: { authorization: `Bearer ${tok}`, 'if-none-match': '1' } })
      expect(cache.status).toBe(304)
      // 未命中 → 全量
      const full = await req(s.port, 'GET', '/v1/doc', { token: tok })
      expect(full.json.rev).toBe(1)
      expect(full.json.byDevid).toBe('mdksync_a')
      // 正常推进 rev2
      const put2 = await req(s.port, 'PUT', '/v1/doc', { token: tok, headers: { 'if-match': '1' }, body: { envelope: ENVELOPE('2026-10-05T02:00:00.000Z'), ts: '2026-10-05T02:00:00.000Z' } })
      expect(put2.json.rev).toBe(2)
      // 基线不符 → 409 带当前 rev/ts
      const stale = await req(s.port, 'PUT', '/v1/doc', { token: tok, headers: { 'if-match': '1' }, body: { envelope: ENVELOPE('2026-10-05T03:00:00.000Z'), ts: '2026-10-05T03:00:00.000Z' } })
      expect(stale.status).toBe(409)
      expect(stale.json.rev).toBe(2)
      // ts 早于现有 → 422 拒收回滚
      const rollback = await req(s.port, 'PUT', '/v1/doc', { token: tok, headers: { 'if-match': '2' }, body: { envelope: ENVELOPE('2026-10-05T00:00:00.000Z'), ts: '2026-10-05T00:00:00.000Z' } })
      expect(rollback.status).toBe(422)
      // 非 ModelDock 信封拒收
      const garbage = await req(s.port, 'PUT', '/v1/doc', { token: tok, headers: { 'if-match': '2' }, body: { envelope: '{"fmt":"other"}', ts: '2026-10-05T04:00:00.000Z' } })
      expect(garbage.status).toBe(400)
      // 缺 If-Match → 400
      const noBase = await req(s.port, 'PUT', '/v1/doc', { token: tok, body: { envelope: ENVELOPE('2026-10-05T04:00:00.000Z'), ts: '2026-10-05T04:00:00.000Z' } })
      expect(noBase.status).toBe(400)
    } finally {
      await s.close()
    }
  })

  it('heartbeat 上报与 desired 返回；devices 在线态；desire 单台与 all', async () => {
    const s = await startServer()
    try {
      const tokA = await pairDevice(s.port, s.consoleToken, 'mdksync_a', 'A')
      const tokB = await pairDevice(s.port, s.consoleToken, 'mdksync_b', 'B')
      // 心跳上报
      const hb = await req(s.port, 'POST', '/v1/heartbeat', { token: tokA, body: { devid: 'mdksync_a', version: '1.2.0', reportedProfile: 'ark' } })
      expect(hb.status).toBe(200)
      expect(hb.json.desiredProfile).toBeNull()
      // devid 与凭据不符被拒
      const spoof = await req(s.port, 'POST', '/v1/heartbeat', { token: tokA, body: { devid: 'mdksync_b' } })
      expect(spoof.status).toBe(403)
      // desire 单台
      const d1 = await req(s.port, 'POST', '/v1/desire', { token: s.consoleToken, body: { devid: 'mdksync_a', service: 'deepseek' } })
      expect(d1.json.updated).toBe(1)
      // desire all
      const dall = await req(s.port, 'POST', '/v1/desire', { token: s.consoleToken, body: { devid: 'all', service: 'ark' } })
      expect(dall.json.updated).toBe(2)
      // 心跳带回 desired
      const hb2 = await req(s.port, 'POST', '/v1/heartbeat', { token: tokA, body: { devid: 'mdksync_a' } })
      expect(hb2.json.desiredProfile).toBe('ark')
      expect(hb2.json.desiredTs).toBeTruthy()
      // devices 列表：A 心跳过 → 在线；B 无心跳 → 离线；desired 回显
      const list = await req(s.port, 'GET', '/v1/devices', { token: s.consoleToken })
      const a = list.json.devices.find((d: any) => d.devid === 'mdksync_a')
      const b = list.json.devices.find((d: any) => d.devid === 'mdksync_b')
      expect(a.online).toBe(true)
      expect(a.reportedProfile).toBe('ark')
      expect(a.desiredProfile).toBe('ark')
      expect(b.online).toBe(false)
      // 未知设备 desire → 404
      const dUnknown = await req(s.port, 'POST', '/v1/desire', { token: s.consoleToken, body: { devid: 'mdksync_x', service: 'ark' } })
      expect(dUnknown.status).toBe(404)
    } finally {
      await s.close()
    }
  })

  it('鉴权：无 token 401、假 token 401、设备/控制台角色互斥 403、cookie 登录可用', async () => {
    const s = await startServer()
    try {
      expect((await req(s.port, 'GET', '/v1/devices')).status).toBe(401)
      expect((await req(s.port, 'GET', '/v1/devices', { token: 'mdkdev_bad' })).status).toBe(401)
      const tok = await pairDevice(s.port, s.consoleToken, 'mdksync_a', 'A')
      // 设备凭据不能调控制台端点
      expect((await req(s.port, 'GET', '/v1/devices', { token: tok })).status).toBe(403)
      expect((await req(s.port, 'POST', '/v1/paircode', { token: tok, body: {} })).status).toBe(403)
      // 控制台凭据不能推/读文档
      expect((await req(s.port, 'GET', '/v1/doc', { token: s.consoleToken })).status).toBe(403)
      // cookie 登录后控制台端点可用
      const login = await fetch(`http://127.0.0.1:${s.port}/v1/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: s.consoleToken }) })
      expect(login.status).toBe(200)
      const cookie = login.headers.get('set-cookie') ?? ''
      expect(cookie).toContain('HttpOnly')
      expect(cookie).toContain('SameSite=Strict')
      const list = await fetch(`http://127.0.0.1:${s.port}/v1/devices`, { headers: { cookie } })
      expect(list.status).toBe(200)
      // 错误 cookie 401
      const bad = await fetch(`http://127.0.0.1:${s.port}/v1/devices`, { headers: { cookie: 'mdkcloud=wrong' } })
      expect(bad.status).toBe(401)
      // 控制台页可访问
      const page = await fetch(`http://127.0.0.1:${s.port}/`)
      expect(page.status).toBe(200)
      expect(await page.text()).toContain('ModelDock Cloud')
    } finally {
      await s.close()
    }
  })

  it('限速：超阈值 429（内存计数）', async () => {
    const s = await startServer({ rateLimitPerMin: 3 })
    try {
      const statuses: number[] = []
      for (let i = 0; i < 5; i++) {
        statuses.push((await req(s.port, 'GET', '/v1/devices', { token: s.consoleToken })).status)
      }
      expect(statuses.filter((x) => x === 429).length).toBeGreaterThanOrEqual(1)
      expect(statuses[0]).toBe(200)
    } finally {
      await s.close()
    }
  })

  it('存储：快照 VACUUM INTO 产出单文件；重开库数据仍在', async () => {
    const dataDir = tmpDataDir()
    const store = new CloudStore(dataDir)
    store.createPairCode('ABCD-EFGH', new Date(Date.now() + 60_000).toISOString())
    const dest = path.join(dataDir, 'backups', 'snap.db')
    store.backupTo(dest)
    expect(fs.existsSync(dest)).toBe(true)
    store.close()
    const store2 = new CloudStore(dataDir)
    expect(store2.listDevices()).toEqual([])
    expect(fs.existsSync(dest)).toBe(true)
    store2.close()
  })
})
