// Web 控制台模型级容灾（model_fallback）编辑面 HTTP 层测试：
// ① /service/update 的 model_fallback 分支：合法映射过 resolveModelFallback（价格闸门/目录成员/
//    查环）落盘；价格超限/目录外/环 → 400 + modeldock.hint 信封；null/空表 → 删除字段；
//    字段缺省 → 不动（回填失败的弹层不得整表清空既有映射）；
// ② /service/model-fallback 按需回填端点：返回已存映射（未配置返回 null）；未知服务 → 400。
// 照 web-key-pool.test.ts 的网关 HTTP 测试模式（buildRuntime + createGatewayServer + 随机端口）；
// 价格走手写 pricing.json（lookupPrice 有 models.dev 目录兜底，手写保证确定性）+ clearPricingMemo；
// 零 vi.mock（singleFork 共享进程纪律）。

import { describe, expect, it } from 'vitest'
import type { AddressInfo } from 'node:net'
import http from 'node:http'
import fs from 'node:fs'
import { parse as tomlParse } from 'smol-toml'
import { fakeHome } from './helpers.js'
import { buildRuntime, type GatewayRuntime } from '../src/gateway/state.js'
import { createGatewayServer } from '../src/gateway/server.js'
import { saveConfig } from '../src/config/store.js'
import { emptyConfig, type Config } from '../src/config/types.js'
import { configPath, pricingJsonPath } from '../src/util/paths.js'
import { clearPricingMemo } from '../src/gateway/pricing.js'

function fbCfg(modelFallback?: Record<string, string>): Config {
  return {
    ...emptyConfig(),
    active_profile: 'demo',
    security: { store: 'file' },
    providers: {
      up: {
        name: 'fb',
        base_url: 'https://api.example.com/v1',
        protocol: 'anthropic',
        auth_style: 'bearer',
        key_ref: 'plain:sk-up',
        models: { m1: { source: 'manual' }, m2: { source: 'manual' }, m3: { source: 'manual' } },
        ...(modelFallback ? { model_fallback: modelFallback } : {}),
      },
    },
    profiles: { demo: { provider: 'up', default_model: 'm1' } },
    harness: {},
  }
}

/** 手写价目（USD/百万 token）：m1/m2 同档（合法映射），m3 贵 10 倍（超 5% 闸门） */
function seedPrices(): void {
  fs.writeFileSync(
    pricingJsonPath(),
    JSON.stringify({ m1: { input: 1, output: 2 }, m2: { input: 1, output: 2 }, m3: { input: 10, output: 20 } }),
    'utf8'
  )
  clearPricingMemo()
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
  seedPrices()
  const rt = buildRuntime(JSON.parse(JSON.stringify(cfg)), 'admin-tok')
  const server = createGatewayServer(rt, { port: 0 })
  const gwPort = await listen(server)
  return { gwPort, rt, close: () => closeServer(server) }
}

const ADMIN = { 'content-type': 'application/json', 'x-modeldock-admin': 'admin-tok' }

function post(gwPort: number, path: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(`http://127.0.0.1:${gwPort}/_modeldock/${path}`, {
    method: 'POST',
    headers: ADMIN,
    body: JSON.stringify(body),
  })
}

/** 读盘上 provider 的 model_fallback（TOML 事实） */
function modelFallbackOnDisk(id: string): Record<string, string> | undefined {
  const doc: any = tomlParse(fs.readFileSync(configPath(), 'utf8'))
  return doc.providers?.[id]?.model_fallback
}

describe('Web /service/update 的 model_fallback 分支', () => {
  it('合法映射：200 落盘，TOML 可读回', async () => {
    const h = fakeHome()
    let close: () => void = () => {}
    try {
      await saveConfig(fbCfg())
      const g = await startGateway(fbCfg())
      close = g.close
      const resp = await post(g.gwPort, 'service/update', { provider: 'up', model_fallback: { m1: 'm2' } })
      expect(resp.status).toBe(200)
      expect(((await resp.json()) as any).ok).toBe(true)
      expect(modelFallbackOnDisk('up')).toEqual({ m1: 'm2' })
    } finally {
      close()
      h.restore()
    }
  })

  it('价格差超限：400 + hint 信封，不落盘', async () => {
    const h = fakeHome()
    let close: () => void = () => {}
    try {
      await saveConfig(fbCfg())
      const g = await startGateway(fbCfg())
      close = g.close
      const resp = await post(g.gwPort, 'service/update', { provider: 'up', model_fallback: { m1: 'm3' } })
      expect(resp.status).toBe(400)
      const j: any = await resp.json()
      expect(String(j.error?.message ?? '')).toContain('超限')
      expect(String(j.modeldock?.hint ?? '')).toContain('同价位')
      expect(modelFallbackOnDisk('up')).toBeUndefined()
    } finally {
      close()
      h.restore()
    }
  })

  it('目录外模型：400（目录成员校验经 ctx.models 生效）', async () => {
    const h = fakeHome()
    let close: () => void = () => {}
    try {
      await saveConfig(fbCfg())
      const g = await startGateway(fbCfg())
      close = g.close
      const resp = await post(g.gwPort, 'service/update', { provider: 'up', model_fallback: { nope: 'm2' } })
      expect(resp.status).toBe(400)
      const j: any = await resp.json()
      expect(String(j.error?.message ?? '')).toContain('不在')
    } finally {
      close()
      h.restore()
    }
  })

  it('回环映射：400', async () => {
    const h = fakeHome()
    let close: () => void = () => {}
    try {
      await saveConfig(fbCfg())
      const g = await startGateway(fbCfg())
      close = g.close
      const resp = await post(g.gwPort, 'service/update', { provider: 'up', model_fallback: { m1: 'm2', m2: 'm1' } })
      expect(resp.status).toBe(400)
      const j: any = await resp.json()
      expect(String(j.error?.message ?? '')).toContain('环')
    } finally {
      close()
      h.restore()
    }
  })

  it('null / 空表：删除字段（config.toml 整字段移除）', async () => {
    const h = fakeHome()
    let close: () => void = () => {}
    try {
      await saveConfig(fbCfg({ m1: 'm2' }))
      const g = await startGateway(fbCfg({ m1: 'm2' }))
      close = g.close
      const r1 = await post(g.gwPort, 'service/update', { provider: 'up', model_fallback: null })
      expect(r1.status).toBe(200)
      expect(modelFallbackOnDisk('up')).toBeUndefined()
      expect(fs.readFileSync(configPath(), 'utf8').replace(/\r\n/g, '\n')).not.toContain('model_fallback')
      // 空表同语义
      const r2 = await post(g.gwPort, 'service/update', { provider: 'up', model_fallback: { m1: 'm2' } })
      expect(r2.status).toBe(200)
      const r3 = await post(g.gwPort, 'service/update', { provider: 'up', model_fallback: {} })
      expect(r3.status).toBe(200)
      expect(modelFallbackOnDisk('up')).toBeUndefined()
    } finally {
      close()
      h.restore()
    }
  })

  it('字段缺省：不动既有映射（无关编辑不清空）', async () => {
    const h = fakeHome()
    let close: () => void = () => {}
    try {
      await saveConfig(fbCfg({ m1: 'm2' }))
      const g = await startGateway(fbCfg({ m1: 'm2' }))
      close = g.close
      const resp = await post(g.gwPort, 'service/update', { provider: 'up', name: '改名不碰容灾' })
      expect(resp.status).toBe(200)
      expect(modelFallbackOnDisk('up')).toEqual({ m1: 'm2' })
    } finally {
      close()
      h.restore()
    }
  })
})

describe('Web /service/model-fallback 按需回填端点', () => {
  it('返回该服务已存映射；未配置返回 null；未知服务 400', async () => {
    const h = fakeHome()
    let close: () => void = () => {}
    try {
      await saveConfig(fbCfg({ m1: 'm2' }))
      const g = await startGateway(fbCfg({ m1: 'm2' }))
      close = g.close
      const resp = await post(g.gwPort, 'service/model-fallback', { id: 'up' })
      expect(resp.status).toBe(200)
      const j: any = await resp.json()
      expect(j.ok).toBe(true)
      expect(j.id).toBe('up')
      expect(j.model_fallback).toEqual({ m1: 'm2' })
      const resp2 = await post(g.gwPort, 'service/model-fallback', { id: 'ghost' })
      expect(resp2.status).toBe(400)
    } finally {
      close()
      h.restore()
    }
  })
})
