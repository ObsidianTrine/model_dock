import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import type { AddressInfo } from 'node:net'
import { fakeHome } from './helpers.js'
import { buildRuntime } from '../src/gateway/state.js'
import { createGatewayServer } from '../src/gateway/server.js'
import { loadConfig, saveConfig } from '../src/config/store.js'
import { SecretsError, __testSetSecretsRawReader, getSecret, invalidateSecretsCache, setSecret } from '../src/config/secrets.js'
import { rollbackKeyWrite, type KeyWritePlan } from '../src/gateway/admin-shared.js'
import { configPath, secretsPath } from '../src/util/paths.js'
import { readTextIfExists } from '../src/util/fsx.js'
import { parse as tomlParse } from 'smol-toml'
import type { Config, ProviderConfig } from '../src/config/types.js'

// 审计 F3/F5 定向回归：密钥槽位推导必须在 config 写锁内按盘上最新态做（锁外推导并发写者撞槽丢 key）；
// setSecret 失败后配置不得残留「指向无值 ref」。注入走 __testSetSecretsRawReader 模块内缝
// （项目认可套路，不碰 vi.mock 跨文件雷区），用例 finally 一律复位。

process.env.MODELRDOCK_DISABLE_HOLIDAY_FETCH = '1'
process.env.MODELRDOCK_DISABLE_CATALOG_FETCH = '1'

const ADMIN = { 'x-modeldock-admin': 'admin-token-x', 'content-type': 'application/json' }

function provider(partial: Partial<ProviderConfig>): ProviderConfig {
  return {
    name: 'p',
    base_url: 'http://127.0.0.1:1',
    protocol: 'anthropic',
    auth_style: 'bearer',
    key_ref: '',
    ...partial,
  }
}

async function setup(providers: Record<string, ProviderConfig>) {
  const h = fakeHome()
  const cfg: Config = {
    version: 1,
    active_profile: 'default',
    security: { store: 'file' }, // 测试固定 file 存储，避免受系统默认(keychain 等)影响
    providers,
    profiles: { default: { name: 'default', provider: Object.keys(providers)[0]! } },
    harness: {},
  }
  await saveConfig(cfg)
  const rt = buildRuntime(cfg, 'admin-token-x')
  const server = createGatewayServer(rt, { port: 0 })
  const port = await new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port))
  })
  return {
    rt,
    port,
    closeAll: () => {
      server.closeAllConnections?.()
      server.close()
      h.restore()
    },
  }
}

/** 盘上 provider 态（toml 直读，绕过内存态——F3 断言「盘上为准」用） */
async function diskProvider(id: string): Promise<{ key_ref?: string; keys?: string[] }> {
  const parsed = tomlParse(fs.readFileSync(configPath(), 'utf8')) as {
    providers?: Record<string, { key_ref?: string; keys?: string[] }>
  }
  return parsed.providers?.[id] ?? {}
}

const addKey = (port: number, providerId: string, key: string) =>
  fetch(`http://127.0.0.1:${port}/_modeldock/key`, {
    method: 'POST',
    headers: ADMIN,
    body: JSON.stringify({ provider: providerId, key }),
  })

const updateService = (port: number, body: Record<string, unknown>) =>
  fetch(`http://127.0.0.1:${port}/_modeldock/service/update`, {
    method: 'POST',
    headers: ADMIN,
    body: JSON.stringify(body),
  })

/** readSecretsRaw 的盘上等价实现（原表透传，密文解密在下游 decryptTable，不受影响） */
const realRaw = async (): Promise<Record<string, string>> => {
  const text = await readTextIfExists(secretsPath())
  if (!text) return {}
  return JSON.parse(text) as Record<string, string>
}

describe('审计 F3：密钥槽位推导在写锁内按盘上最新态', () => {
  it('盘上池比内存态多一把（模拟他写者已提交）时，新槽位顺延不撞槽、他者 key 原值不丢', async () => {
    const t = await setup({
      sd: provider({ key_ref: 'file:sd-k1', keys: ['file:sd-k1'] }),
    })
    try {
      await setSecret('sd-k1', 'key1', 'file')
      // 模拟另一写者（CLI/另一实例）已提交 k2：直接落盘，网关内存态保持旧池（watcher 未在
      // createGatewayServer 内启动，内存态不会自己追平——分歧窗口确定性复现）
      const cfg = await loadConfig()
      cfg.providers['sd']!.keys = ['file:sd-k1', 'file:sd-k2']
      await saveConfig(cfg)
      await setSecret('sd-k2', 'writerB', 'file')

      const res = await addKey(t.port, 'sd', 'keyC')
      expect(res.status).toBe(200)

      const prov = await diskProvider('sd')
      // 修复前：锁外按旧内存池推导出 sd-k2，追加后池内两把 k2 且 keyB 明文被覆盖
      expect(prov.keys).toEqual(['file:sd-k1', 'file:sd-k2', 'file:sd-k3'])
      expect(await getSecret('file:sd-k2')).toBe('writerB')
      expect(await getSecret('file:sd-k3')).toBe('keyC')
    } finally {
      t.closeAll()
    }
  })

  it('两个并发 set-key 追加同一池：各占独立槽位、两把 key 都落盘可读', async () => {
    const t = await setup({
      pp: provider({ key_ref: 'file:pp-k1', keys: ['file:pp-k1'] }),
    })
    try {
      await setSecret('pp-k1', 'key1', 'file')
      // 拟钥匙环 spawn 的读延迟（生产 40ms+）：拉宽「读内存态→persist」窗口，两请求都从
      // 同一内存态出发——修复后槽位在锁内按盘上态推导，仍各自顺延
      __testSetSecretsRawReader(async () => {
        await new Promise((r) => setTimeout(r, 40))
        return realRaw()
      })
      const [ra, rb] = await Promise.all([addKey(t.port, 'pp', 'keyA'), addKey(t.port, 'pp', 'keyB')])
      expect(ra.status).toBe(200)
      expect(rb.status).toBe(200)
      expect(((await ra.json()) as { appended?: boolean }).appended).toBe(true)
      expect(((await rb.json()) as { appended?: boolean }).appended).toBe(true)

      const prov = await diskProvider('pp')
      expect(prov.keys).toEqual(['file:pp-k1', 'file:pp-k2', 'file:pp-k3'])
      expect(prov.key_ref).toBe('file:pp-k1')
      const stored = [(await getSecret('file:pp-k2'))!, (await getSecret('file:pp-k3'))!].sort()
      expect(stored).toEqual(['keyA', 'keyB'].sort())
    } finally {
      __testSetSecretsRawReader()
      t.closeAll()
    }
  })
})

describe('审计 F5：setSecret 失败回滚，配置不留指向无值 ref', () => {
  it('首 key 写入失败：key_ref 还原为空，secrets 不落半套值，响应 400', async () => {
    const t = await setup({ sk: provider({}) })
    try {
      __testSetSecretsRawReader(async () => {
        throw new SecretsError('注入：密钥写盘失败', 'injected secrets write failure')
      })
      const res = await addKey(t.port, 'sk', 'newKey')
      expect(res.status).toBe(400)
      const body = (await res.json()) as { error?: { message?: string } }
      expect(body.error?.message ?? '').toContain('注入')

      const prov = await diskProvider('sk')
      expect(prov.key_ref ?? '').toBe('')
      expect(prov.keys).toBeUndefined()
      // seam 复位后再读 secrets（seam 在位时自身读取也会被注入击中）
      __testSetSecretsRawReader()
      expect(await getSecret('file:sk')).toBeNull()
    } finally {
      __testSetSecretsRawReader()
      t.closeAll()
    }
  })

  it('覆盖场景写入失败：旧 key 原值不丢、key_ref 不变', async () => {
    const t = await setup({ ov: provider({ key_ref: 'file:ov' }) })
    try {
      await setSecret('ov', 'oldKey', 'file')
      // 清解密缓存：否则写路径 loadFileSecrets(false) 按盘上指纹复用缓存、不再触发 raw read，
      // 注入缝打不进 setSecret 的读路径（指纹复用见 secrets.ts loadFileSecrets 注）
      invalidateSecretsCache()
      __testSetSecretsRawReader(async () => {
        throw new SecretsError('注入：密钥写盘失败', 'injected secrets write failure')
      })
      const res = await addKey(t.port, 'ov', 'newKey')
      expect(res.status).toBe(400)

      const prov = await diskProvider('ov')
      expect(prov.key_ref).toBe('file:ov')
      __testSetSecretsRawReader()
      expect(await getSecret('file:ov')).toBe('oldKey')
    } finally {
      __testSetSecretsRawReader()
      t.closeAll()
    }
  })

  it('rollbackKeyWrite：既有池按 ref 精确摘除；建池回滚整体还原单 key 态', async () => {
    const t = await setup({
      pw: provider({ key_ref: 'file:pw-k1', keys: ['file:pw-k1', 'file:pw-k2'] }),
      pb: provider({ key_ref: 'file:pb' }),
    })
    try {
      const plan: KeyWritePlan = {
        pool: true, secretId: 'pw-k2', ref: 'file:pw-k2', backend: 'file', createdPool: false, prevKeyRef: '',
      }
      await rollbackKeyWrite(t.rt, 'pw', plan)
      expect((await diskProvider('pw')).keys).toEqual(['file:pw-k1'])
      expect((await diskProvider('pw')).key_ref).toBe('file:pw-k1')

      const plan2: KeyWritePlan = {
        pool: true, secretId: 'pb-k1', ref: 'file:pb-k1', backend: 'file', createdPool: true, prevKeyRef: '',
      }
      await rollbackKeyWrite(t.rt, 'pb', plan2)
      expect((await diskProvider('pb')).keys).toBeUndefined()
      expect((await diskProvider('pb')).key_ref).toBe('file:pb')
    } finally {
      t.closeAll()
    }
  })
})

describe('hServiceUpdate / hKey 常态绿路径（重构不改行为）', () => {
  it('service/update 池 provider 提交新 key：追加独立槽位且密文落盘', async () => {
    const t = await setup({
      svc: provider({ key_ref: 'file:svc-k1', keys: ['file:svc-k1'] }),
    })
    try {
      await setSecret('svc-k1', 'k1', 'file')
      const res = await updateService(t.port, { provider: 'svc', key: 'newK' })
      expect(res.status).toBe(200)

      const prov = await diskProvider('svc')
      expect(prov.keys).toEqual(['file:svc-k1', 'file:svc-k2'])
      expect(prov.key_ref).toBe('file:svc-k1')
      expect(await getSecret('file:svc-k2')).toBe('newK')
    } finally {
      t.closeAll()
    }
  })

  it('service/update 单 key provider：覆盖 key_ref 且密文更新', async () => {
    const t = await setup({ sv2: provider({ key_ref: 'file:sv2' }) })
    try {
      await setSecret('sv2', 'old', 'file')
      const res = await updateService(t.port, { provider: 'sv2', key: 'new2' })
      expect(res.status).toBe(200)

      const prov = await diskProvider('sv2')
      expect(prov.key_ref).toBe('file:sv2')
      expect(prov.keys).toBeUndefined()
      expect(await getSecret('file:sv2')).toBe('new2')
    } finally {
      t.closeAll()
    }
  })
})
