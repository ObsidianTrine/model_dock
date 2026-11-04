// Web 控制台改 Key 与多 key 池（2026-11-04 审查 P1/P2 回归）：
// ① 池 provider（keys 非空）转发恒走 keys（providerKeyRefs），Web 改 Key 只写 key_ref 静默无效
//   ——现应对齐 CLI set-key --add 追加进池，且同地址同 Key 去重走池内全量 key 比对；
// ② 先落配置后动密钥（REVIEW-10 同序）：config 写失败时密钥不得先动（孤儿/半套状态）。
// 锁占用用「手工造锁文件」模拟跨进程写者：同进程 withFileLock 走串行队列只会排队、
// 永远到不了文件锁竞争，测不出 acquire 超时路径。

import { describe, expect, it } from 'vitest'
import type { AddressInfo } from 'node:net'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fakeHome } from './helpers.js'
import { buildRuntime, type GatewayRuntime } from '../src/gateway/state.js'
import { createGatewayServer } from '../src/gateway/server.js'
import { configLockPath, loadConfig, saveConfig } from '../src/config/store.js'
import { emptyConfig, type Config } from '../src/config/types.js'
import { configPath } from '../src/util/paths.js'
import { getSecret, setSecret } from '../src/config/secrets.js'
import { __testSetLockTiming } from '../src/util/fsx.js'
import { stopLan } from '../src/gateway/lan.js'
import { parse as tomlParse } from 'smol-toml'

function poolCfg(): Config {
  return {
    ...emptyConfig(),
    active_profile: 'demo',
    security: { store: 'file' },
    providers: {
      // 池 provider：keys 非空 → 转发/去重都以池为准（key_ref 仅为向后兼容保留）
      up: {
        name: 'pool',
        base_url: 'https://api.example.com/v1',
        protocol: 'anthropic',
        auth_style: 'bearer',
        key_ref: 'file:up',
        keys: ['file:up-a', 'file:up-b'],
        models: { m1: { source: 'manual' } },
      },
      // 单 key provider：key_ref 覆盖语义保持不变
      solo: {
        name: 'solo',
        base_url: 'https://other.example.com/v1',
        protocol: 'anthropic',
        auth_style: 'bearer',
        key_ref: 'file:solo',
        models: { m1: { source: 'manual' } },
      },
    },
    profiles: { demo: { provider: 'up', default_model: 'm1' } },
    harness: {},
  }
}

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port))
  })
}

function closeServer(s: http.Server): void {
  ;(s as unknown as { closeAllConnections?: () => void }).closeAllConnections?.()
  s.close()
}

async function startGateway(cfg: Config): Promise<{ gwPort: number; rt: GatewayRuntime; close: () => void }> {
  const rt = buildRuntime(JSON.parse(JSON.stringify(cfg)), 'admin-tok')
  const server = createGatewayServer(rt, { port: 0 })
  const gwPort = await listen(server)
  return {
    gwPort,
    rt,
    close: () => closeServer(server),
  }
}

const ADMIN = { 'content-type': 'application/json', 'x-modeldock-admin': 'admin-tok' }

function post(gwPort: number, path: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(`http://127.0.0.1:${gwPort}/_modeldock/${path}`, {
    method: 'POST',
    headers: ADMIN,
    body: JSON.stringify(body),
  })
}

/** 模拟另一进程占住 config 写锁：手工造一把 mtime 新鲜的锁文件（不触发陈锁抢占） */
function holdConfigLockExternally(): void {
  fs.mkdirSync(path.dirname(configLockPath()), { recursive: true })
  fs.writeFileSync(configLockPath(), String(process.pid), 'utf8')
}

function releaseConfigLockExternally(): void {
  try { fs.rmSync(configLockPath(), { force: true }) } catch { /* 收尾尽力 */ }
}

/** 读盘上 provider 的 keys 池与 key_ref（TOML 事实） */
function providerOnDisk(id: string): { keys?: string[]; key_ref?: string } {
  const doc: any = tomlParse(fs.readFileSync(configPath(), 'utf8'))
  return { keys: doc.providers[id]?.keys, key_ref: doc.providers[id]?.key_ref }
}

describe('Web 改 Key 与多 key 池（2026-11-04 审查 P1）', () => {
  it('service/update：池 provider 提交新 key 追加进 keys 池（不再只写 key_ref 静默无效）', async () => {
    const h = fakeHome()
    let close: () => void = () => {}
    try {
      const cfg = poolCfg()
      await saveConfig(cfg)
      await setSecret('up-a', 'sk-a', 'file')
      await setSecret('up-b', 'sk-b', 'file')
      const g = await startGateway(cfg)
      close = g.close

      const resp = await post(g.gwPort, 'service/update', { provider: 'up', key: 'sk-new' })
      expect(resp.status).toBe(200)
      const onDisk = providerOnDisk('up')
      // keys 数组尾插新引用（槽位 = 池长 + 1，与 CLI --add 同款），key_ref 不动
      expect(onDisk.keys).toEqual(['file:up-a', 'file:up-b', 'file:up-k3'])
      expect(onDisk.key_ref).toBe('file:up')
      // 密钥文本确实落到新引用下，转发经 providerKeyRefs 即可读到
      expect(await getSecret('file:up-k3')).toBe('sk-new')
    } finally {
      close()
      h.restore()
    }
  })

  it('/key：池 provider 追加进池；提交池内已有 key 时幂等零追加', async () => {
    const h = fakeHome()
    let close: () => void = () => {}
    try {
      const cfg = poolCfg()
      await saveConfig(cfg)
      await setSecret('up-a', 'sk-a', 'file')
      await setSecret('up-b', 'sk-b', 'file')
      const g = await startGateway(cfg)
      close = g.close

      const resp = await post(g.gwPort, 'key', { provider: 'up', key: 'sk-new2' })
      expect(resp.status).toBe(200)
      expect(((await resp.json()) as any).ok).toBe(true)
      expect(providerOnDisk('up').keys).toEqual(['file:up-a', 'file:up-b', 'file:up-k3'])
      expect(await getSecret('file:up-k3')).toBe('sk-new2')

      // 幂等：再次提交池内已有 key（sk-b）→ 零追加
      const resp2 = await post(g.gwPort, 'key', { provider: 'up', key: 'sk-b' })
      expect(resp2.status).toBe(200)
      expect(((await resp2.json()) as any).appended).toBe(false)
      expect(providerOnDisk('up').keys).toEqual(['file:up-a', 'file:up-b', 'file:up-k3'])
    } finally {
      close()
      h.restore()
    }
  })

  it('service/update：单 key provider 保持 key_ref 覆盖语义（既有行为不回归）', async () => {
    const h = fakeHome()
    let close: () => void = () => {}
    try {
      const cfg = poolCfg()
      await saveConfig(cfg)
      await setSecret('solo', 'sk-solo', 'file')
      const g = await startGateway(cfg)
      close = g.close

      const resp = await post(g.gwPort, 'service/update', { provider: 'solo', key: 'sk-solo-2' })
      expect(resp.status).toBe(200)
      const onDisk = providerOnDisk('solo')
      expect(onDisk.key_ref).toBe('file:solo')
      expect(onDisk.keys).toBeUndefined()
      expect(await getSecret('file:solo')).toBe('sk-solo-2')
    } finally {
      close()
      h.restore()
    }
  })

  it('同地址同 Key 去重走池内全量比对：目标 key 在另一服务的 key 池里 → 400', async () => {
    const h = fakeHome()
    let close: () => void = () => {}
    try {
      const cfg = poolCfg()
      await saveConfig(cfg)
      await setSecret('up-a', 'sk-a', 'file')
      await setSecret('up-b', 'sk-b', 'file')
      await setSecret('solo', 'sk-solo', 'file')
      const g = await startGateway(cfg)
      close = g.close

      // solo 改成与 up 同地址，key 用 up 池内的 sk-b：旧实现只比 up 的 key_ref（无密钥文本）
      // 会漏判放行——转发时两服务实际共用同一把池内 key
      const clash = await post(g.gwPort, 'service/update', { provider: 'solo', base_url: 'https://api.example.com/v1', key: 'sk-b' })
      expect(clash.status).toBe(400)
      const j: any = await clash.json()
      expect(String(j.error?.message ?? '')).toContain('同地址同 Key')

      // 同地址但 key 不在对方池内：合法共存（同一厂商多账号）
      const ok = await post(g.gwPort, 'service/update', { provider: 'solo', base_url: 'https://api.example.com/v1', key: 'sk-other-account' })
      expect(ok.status).toBe(200)
    } finally {
      close()
      h.restore()
    }
  })

  it('service/update：池内已有 key 的重复提交不重复追加（幂等）', async () => {
    const h = fakeHome()
    let close: () => void = () => {}
    try {
      const cfg = poolCfg()
      await saveConfig(cfg)
      await setSecret('up-a', 'sk-a', 'file')
      await setSecret('up-b', 'sk-b', 'file')
      const g = await startGateway(cfg)
      close = g.close

      const resp = await post(g.gwPort, 'service/update', { provider: 'up', key: 'sk-a' })
      expect(resp.status).toBe(200)
      expect(providerOnDisk('up').keys).toEqual(['file:up-a', 'file:up-b'])
    } finally {
      close()
      h.restore()
    }
  })
})

describe('先落配置后动密钥（2026-11-04 审查 P2，REVIEW-10 同序）', () => {
  it('config 写锁被占时 /key 报错且密钥未动（旧实现 setSecret 在前会先改密钥）', async () => {
    const h = fakeHome()
    let close: () => void = () => {}
    __testSetLockTiming({ acquireTimeoutMs: 500 })
    try {
      const cfg = poolCfg()
      await saveConfig(cfg)
      await setSecret('solo', 'sk-solo', 'file')
      const g = await startGateway(cfg)
      close = g.close

      holdConfigLockExternally()
      const resp = await post(g.gwPort, 'key', { provider: 'solo', key: 'sk-must-not-land' })
      expect(resp.status).toBe(400)
      const j: any = await resp.json()
      expect(String(j.error?.message ?? '')).toContain('配置写入超时')
      // 密钥未动：旧值仍可读，配置也保持原状
      expect(await getSecret('file:solo')).toBe('sk-solo')
      expect(providerOnDisk('solo').key_ref).toBe('file:solo')
    } finally {
      releaseConfigLockExternally()
      __testSetLockTiming()
      close()
      h.restore()
    }
  })
})

describe('hLanPost 失败路径（2026-11-04 审查 P2）', () => {
  it('业务错误走 sendError（ConfigError → 400），不再 200+{ok:false} 被前端当成功吞掉', async () => {
    const h = fakeHome()
    let close: () => void = () => {}
    __testSetLockTiming({ acquireTimeoutMs: 500 })
    try {
      const cfg = { ...poolCfg(), lan: { port: 0 } }
      await saveConfig(cfg)
      const g = await startGateway(cfg)
      close = g.close

      holdConfigLockExternally()
      const resp = await post(g.gwPort, 'lan', { enabled: true })
      expect(resp.status).toBe(400)
      const j: any = await resp.json()
      expect(String(j.error?.message ?? '')).toContain('配置写入超时')
      // 失败前 startLanServer 可能已拉起监听（先启停后落配置的既有时序），收尾断干净
      stopLan(g.rt)
    } finally {
      releaseConfigLockExternally()
      __testSetLockTiming()
      close()
      h.restore()
    }
  })
})
