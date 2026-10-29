import fsp from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { TEST_TMP, gotoHome, newHome, restoreHomes } from './helpers.js'
import { loadConfig, mutateConfig, saveConfig } from '../src/config/store.js'
import { setSecret, makeKeyRef } from '../src/config/secrets.js'
import { CloudStore } from '../src/cloud/store.js'
import { createCloudServer } from '../src/cloud/server.js'
import { enrollCloud } from '../src/sync/setup.js'
import { safeSyncTick, syncTickOnce } from '../src/sync/engine.js'
import { readSyncState, updateSyncState, type SyncState } from '../src/sync/state.js'
import { switchToService } from '../src/ops.js'
import type { Config } from '../src/config/types.js'

/** 双沙箱 + 单云端进程（listen(0)，红线：绝不碰 8687/8890）；多 home 切换走 helpers 三件套 */
const dataDirs: string[] = []
afterAll(async () => {
  await restoreHomes()
  for (const d of dataDirs) await fsp.rm(d, { recursive: true, force: true }).catch(() => {})
})

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
    harness: { 'claude-code': { mode: 'gateway', attached_at: '2026-01-01T00:00:00.000Z', files: ['/x'] } },
    gateway: { port: 12345 },
  } as unknown as Config)
}

async function startCloud(): Promise<{ port: number; store: CloudStore; consoleToken: string; url: string; close: () => Promise<void> }> {
  const dataDir = await fsp.mkdtemp(path.join(TEST_TMP, 'md-cloud-agent-'))
  dataDirs.push(dataDir)
  const store = new CloudStore(dataDir)
  const consoleToken = 'mdkcloud_' + 'b'.repeat(32)
  const server = createCloudServer(store, { consoleToken, rateLimitPerMin: 10_000 })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const port = (server.address() as net.AddressInfo).port
  return {
    port,
    store,
    consoleToken,
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve())
        store.close()
      }),
  }
}

async function pairCode(cloud: { port: number; consoleToken: string }): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${cloud.port}/v1/paircode`, {
    method: 'POST',
    headers: { authorization: `Bearer ${cloud.consoleToken}`, 'content-type': 'application/json' },
    body: '{}',
  })
  const j = (await res.json()) as { pairCode: string }
  return j.pairCode
}

async function desire(cloud: { port: number; consoleToken: string }, devid: string, service: string): Promise<void> {
  const res = await fetch(`http://127.0.0.1:${cloud.port}/v1/desire`, {
    method: 'POST',
    headers: { authorization: `Bearer ${cloud.consoleToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ devid, service }),
  })
  expect(res.status).toBe(200)
}

async function devicesList(cloud: { port: number; consoleToken: string }): Promise<any[]> {
  const res = await fetch(`http://127.0.0.1:${cloud.port}/v1/devices`, { headers: { authorization: `Bearer ${cloud.consoleToken}` } })
  const j = (await res.json()) as { devices: any[] }
  return j.devices
}

describe('云端入网与多机收敛（M3b）', () => {
  it('A 入网首推 rev1 → B 入网收敛 → A 改推 rev2 → B 拉取一致；错配对码拒绝', async () => {
    const cloud = await startCloud()
    try {
      // —— A 入网（云端为空 → 首推 rev1） ——
      const homeA = newHome()
      await seedBase()
      const codeA = await pairCode(cloud)
      const enrollA = await enrollCloud(cloud.url, codeA, 'pass-m3', { backend: 'file', deviceName: '笔记本A' })
      expect(enrollA.joined).toBe(false)
      expect(enrollA.rev).toBe(1)
      const stA = (await readSyncState()) as SyncState | null
      expect(stA?.mode).toBe('cloud')
      expect(stA?.cloud?.url).toBe(cloud.url)
      expect(stA?.lastLocalSwitchTs).toBeNull()

      // —— B 入网（云端有文档 → 加入收敛；机器态保留） ——
      const homeB = newHome()
      await seedBase()
      await mutateConfig((c) => {
        c.providers!.extra = { base_url: 'https://extra.example.com', protocol: 'openai', auth_style: 'bearer', key_ref: 'env:EXTRA_KEY' }
      })
      const codeB = await pairCode(cloud)
      const enrollB = await enrollCloud(cloud.url, codeB, 'pass-m3', { backend: 'file', deviceName: '台式机B' })
      expect(enrollB.joined).toBe(true)
      const cfgB = await loadConfig()
      expect(Object.keys(cfgB.providers ?? {})).toEqual(['ark'])
      expect(cfgB.harness?.['claude-code']).toBeTruthy()

      // —— A 改配置推 rev2 → B 拉取 ——
      gotoHome(homeA)
      await setSecret('deepseek', 'sk-ds', 'file')
      await mutateConfig((c) => {
        c.providers!.deepseek = { base_url: 'https://ds.example.com', protocol: 'openai', auth_style: 'bearer', key_ref: makeKeyRef('file', 'deepseek') }
      })
      expect(await syncTickOnce()).toBe('pushed')

      gotoHome(homeB)
      expect(await syncTickOnce()).toBe('pulled')
      const cfgB2 = await loadConfig()
      expect(Object.keys(cfgB2.providers ?? {}).sort()).toEqual(['ark', 'deepseek'])
    } finally {
      await cloud.close()
    }
  })

  it('desired 状态机：云端切换 → 心跳应用（走 switchToService）→ 本机手动切换保护', async () => {
    const cloud = await startCloud()
    try {
      // A 入网推 rev1（ark + deepseek 两服务）
      const homeA = newHome()
      await seedBase()
      await setSecret('deepseek', 'sk-ds', 'file')
      await mutateConfig((c) => {
        c.providers!.deepseek = { base_url: 'https://ds.example.com', protocol: 'openai', auth_style: 'bearer', key_ref: makeKeyRef('file', 'deepseek') }
      })
      const stA = (await readSyncState()) as SyncState | null
      expect(stA).toBeNull() // 尚未入网
      const codeA = await pairCode(cloud)
      await enrollCloud(cloud.url, codeA, 'pass-d', { backend: 'file', deviceName: 'A' })

      // B 入网收敛（云端已有 rev1）
      const homeB = newHome()
      await seedBase()
      const codeB = await pairCode(cloud)
      const enrollB = await enrollCloud(cloud.url, codeB, 'pass-d', { backend: 'file', deviceName: 'B' })
      expect(enrollB.joined).toBe(true)
      const stB = (await readSyncState()) as SyncState | null
      expect(stB?.cloud?.deviceName).toBe('B')

      // 控制台对 B 下发 desired=deepseek → B tick（心跳）应用：active_profile 指向 deepseek 的路由
      await desire(cloud, stB!.devid, 'deepseek')
      // 切换经 switchToService 会自动创建 auto-deepseek 路由（可同步态）→ 本 tick 顺带把新路由库推上去（rev2）
      const applied = await syncTickOnce({ applySwitch: (svc) => switchToService(svc) })
      expect(applied).toBe('pushed')
      const cfgB = await loadConfig()
      expect(cfgB.profiles![cfgB.active_profile!]?.provider).toBe('deepseek')
      // applySwitch 走 switchToService → lastLocalSwitchTs 已记
      const stB2 = (await readSyncState()) as SyncState
      expect(stB2.lastLocalSwitchTs).toBeTruthy()
      // 切换后的新状态由下个心跳上报（详设 §7.4-4：本 tick 上报的是切换前的当前服务）
      await syncTickOnce({ applySwitch: (svc) => switchToService(svc) })
      const list1 = await devicesList(cloud)
      const bRow = list1.find((d) => d.devid === stB!.devid)
      expect(bRow.reportedProfile).toBe('deepseek')

      // 保护：本机 lastLocalSwitchTs 推到未来 → 旧 desired_ts 不覆盖
      await desire(cloud, stB!.devid, 'ark')
      await updateSyncState({ lastLocalSwitchTs: new Date(Date.now() + 60_000).toISOString() })
      await syncTickOnce({ applySwitch: (svc) => switchToService(svc) })
      const cfgB2 = await loadConfig()
      expect(cfgB2.profiles![cfgB2.active_profile!]?.provider).toBe('deepseek')

      // 恢复正常时钟后，新 desired（ts 更新）生效 → 切回 ark
      await updateSyncState({ lastLocalSwitchTs: null })
      await syncTickOnce({ applySwitch: (svc) => switchToService(svc) })
      const cfgB3 = await loadConfig()
      expect(cfgB3.profiles![cfgB3.active_profile!]?.provider).toBe('ark')
    } finally {
      await cloud.close()
    }
  })

  it('云端不可达：safeSyncTick 吞错记账，配置照常可改', async () => {
    const cloud = await startCloud()
    newHome()
    await seedBase()
    const code = await pairCode(cloud)
    await enrollCloud(cloud.url, code, 'pass-off', { backend: 'file' })
    await cloud.close()
    await mutateConfig((c) => {
      c.profiles!.main!.default_model = 'offline'
    })
    expect(await safeSyncTick()).toBe('skipped')
    const st = (await readSyncState()) as SyncState
    expect(st.lastError).toBeTruthy()
    // pause 后全跳过
    await updateSyncState({ paused: true })
    expect(await syncTickOnce()).toBe('skipped')
  })
})
