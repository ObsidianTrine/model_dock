import http from 'node:http'
import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { fakeHome } from './helpers.js'
import { loadConfig, saveConfig } from '../src/config/store.js'
import { setSecret, makeKeyRef } from '../src/config/secrets.js'
import { CloudStore } from '../src/cloud/store.js'
import { createCloudServer } from '../src/cloud/server.js'
import { enrollCloud } from '../src/sync/setup.js'
import { safeSyncTick, syncStatus } from '../src/sync/engine.js'
import { readSyncState, updateSyncState, type SyncState } from '../src/sync/state.js'
import type { Config } from '../src/config/types.js'

// cloudHeartbeat 的 desired 状态机回归（审查项 P2-11）：云端心跳走真实协议，用「真云端入网 +
// 手写心跳假件」驱动，不 mock undici（singleFork 跨文件 mock 雷区）。真云端只负责入网拿到合法
// state（key cache 等），心跳阶段把 cloud.url 指向假件——desiredProfile/desiredTs 完全可控。
const h = fakeHome()

const applied: string[] = []
let hbReply: Record<string, unknown> = {}
let hbRaw: string | null = null // 非 null 时心跳原样回该串（反代错误页场景）
let docReqs = 0 // 心跳之后到达的文档同步请求数（验证 desired 应用失败不阻断后续推拉）

const fake = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url?.includes('/v1/heartbeat')) {
    req.resume()
    req.on('end', () => {
      if (hbRaw !== null) {
        res.writeHead(200, { 'content-type': 'text/html' })
        res.end(hbRaw)
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(hbReply))
    })
    return
  }
  docReqs++
  // 心跳之后的文档同步一律 500：safeSyncTick 记账后返回 skipped，不影响心跳断言
  res.writeHead(500)
  res.end('nope')
})

const cloudDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-cloud-hb-'))
const cloudStore = new CloudStore(cloudDataDir)
const cloudServer = createCloudServer(cloudStore, { consoleToken: 'mdkcloud_' + 'c'.repeat(32), rateLimitPerMin: 10_000 })
let cloudPort = 0
let fakePort = 0

afterAll(async () => {
  await new Promise<void>((resolve) => cloudServer.close(() => resolve()))
  await new Promise<void>((resolve) => fake.close(() => resolve()))
  cloudStore.close()
  await fs.promises.rm(cloudDataDir, { recursive: true, force: true }).catch(() => {})
  h.restore()
})

async function listen0(srv: http.Server): Promise<number> {
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', () => resolve()))
  return (srv.address() as net.AddressInfo).port
}

async function seedBase(): Promise<void> {
  await setSecret('ark', 'sk-ark-plaintext', 'file')
  await saveConfig({
    version: 1,
    language: 'zh',
    active_profile: 'main',
    security: { store: 'file' },
    providers: {
      ark: { base_url: 'https://ark.example.com/api', protocol: 'anthropic', auth_style: 'bearer', key_ref: makeKeyRef('file', 'ark') },
    },
    profiles: { main: { provider: 'ark', default_model: 'auto' } },
    gateway: { port: 12345 },
  } as unknown as Config)
}

beforeAll(async () => {
  cloudPort = await listen0(cloudServer)
  fakePort = await listen0(fake)
  await seedBase()
  const res = await fetch(`http://127.0.0.1:${cloudPort}/v1/paircode`, {
    method: 'POST',
    headers: { authorization: `Bearer ${'mdkcloud_' + 'c'.repeat(32)}`, 'content-type': 'application/json' },
    body: '{}',
  })
  const { pairCode } = (await res.json()) as { pairCode: string }
  await enrollCloud(`http://127.0.0.1:${cloudPort}`, pairCode, 'enroll-passphrase-1')
  const st = await readSyncState()
  if (!st?.cloud) throw new Error('入网后应有 cloud 状态')
  await updateSyncState({ cloud: { ...st.cloud, url: `http://127.0.0.1:${fakePort}` } })
})

async function tick(): Promise<string> {
  applied.length = 0
  return safeSyncTick({ applySwitch: async (svc) => { applied.push(svc) } })
}

async function setSwitchAnchor(iso: string | null): Promise<void> {
  await updateSyncState({ lastLocalSwitchTs: iso } as Partial<SyncState>)
}

describe('cloudHeartbeat desired 状态机（P2-11 回归）', () => {
  it('新指令（desired 更新于本机最近切换之后）→ 应用切换', async () => {
    await setSwitchAnchor(null)
    hbReply = { desiredProfile: 'other-svc', desiredTs: new Date().toISOString() }
    const outcome = await tick()
    expect(applied).toEqual(['other-svc'])
    expect(outcome).toBe('skipped') // 心跳后文档同步被假件 500 拒绝，记账为 skipped
  })

  it('畸形 desiredTs（NaN 防绕过回归）→ 不应用', async () => {
    await setSwitchAnchor(null)
    hbReply = { desiredProfile: 'other-svc', desiredTs: 'not-a-date' }
    await tick()
    expect(applied).toEqual([])
  })

  it('旧指令（desired 不晚于本机最近切换）→ 不应用，本机手动切换优先', async () => {
    await setSwitchAnchor(new Date(Date.now() + 3_600_000).toISOString())
    hbReply = { desiredProfile: 'other-svc', desiredTs: new Date().toISOString() }
    await tick()
    expect(applied).toEqual([])
    await setSwitchAnchor(null)
  })

  it('desired 与当前 provider 一致 → 不应用', async () => {
    const cfg = await loadConfig()
    expect(cfg.profiles[cfg.active_profile!]?.provider).toBe('ark')
    hbReply = { desiredProfile: 'ark', desiredTs: new Date().toISOString() }
    await tick()
    expect(applied).toEqual([])
  })

  it('心跳 200 但体非 JSON（反代错误页）→ 显式报错记账，不应用切换', async () => {
    await setSwitchAnchor(null)
    hbRaw = '<html>502 Bad Gateway</html>'
    try {
      const outcome = await tick()
      expect(outcome).toBe('skipped')
      // 修复前记的是裸 SyntaxError（"Unexpected token '<'"）无从排查；修复后报可定位的云端异常
      expect((await syncStatus()).lastError).toContain('非 JSON')
    } finally {
      hbRaw = null
    }
    expect(applied).toEqual([])
  })

  it('applySwitch 抛错 → 只记错，本 tick 文档同步照常走（P1 回归）', async () => {
    await setSwitchAnchor(null)
    hbReply = { desiredProfile: 'other-svc', desiredTs: new Date().toISOString() }
    docReqs = 0
    // desired 指向本机没有的服务：switchToService 会 throw。修复前异常冒泡中止整个 tick，
    // 文档推拉全部停摆、每 60s 永续重试不收敛；修复后只记错、继续推拉。
    const outcome = await safeSyncTick({ applySwitch: async () => { throw new Error('unknown service: other-svc') } })
    expect(docReqs).toBeGreaterThan(0)
    expect(outcome).toBe('skipped') // 文档端点被假件 500 拒绝，记账 skipped
  })
})
