import { describe, expect, it, afterEach } from 'vitest'
import http from 'node:http'
import { AddressInfo } from 'node:net'
import { fakeHome } from './helpers.js'
import { buildRuntime } from '../src/gateway/state.js'
import { createGatewayServer } from '../src/gateway/server.js'
import { startLanServer, stopLan } from '../src/gateway/lan.js'
import { saveConfig } from '../src/config/store.js'
import type { Config } from '../src/config/types.js'

// overview 构建会触达假期/模型目录的异步拉取，屏蔽避免测试里意外联网；与既有 lan/gateway 套件同法。
process.env.MODELRDOCK_DISABLE_HOLIDAY_FETCH = '1'
process.env.MODELRDOCK_DISABLE_CATALOG_FETCH = '1'

const ADMIN = { 'x-modeldock-admin': 'admin-token-x' }

function cfg(): Config {
  return {
    version: 1,
    active_profile: 'demo',
    security: { store: 'file' }, // 固定 file 存储，避免受系统默认(keychain 等)影响
    providers: {
      up: {
        name: 'mock',
        base_url: 'http://127.0.0.1:9',
        protocol: 'anthropic',
        auth_style: 'bearer',
        key_ref: 'sk-upstream-secret',
        models: { 'preset-model': { source: 'preset', context_window: 1000, max_output: 100 } },
      },
    },
    profiles: {
      demo: { provider: 'up', default_model: 'preset-model' },
    },
    harness: {
      'claude-code': { mode: 'gateway', route: 'default', token: 'mdk_harness_token_abcdef' },
    },
  }
}

function listenEphemeral(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port))
  })
}

interface TestCtx {
  gwPort: number
  lanPort: number
  base: string
  close: () => void
}

// 在独立 fakeHome 沙箱里起网关（overview/控制台 HTML）与 LAN 第二监听器（PWA 图标）。
// 不 mock 任何共享模块（vitest singleFork 共享 mock 注册表，避免与其它文件冲突）；
// autostartOverview 等只做只读 exists 探测，跨平台安全。
async function start(): Promise<TestCtx> {
  const h = fakeHome()
  await saveConfig(cfg())
  const rt = buildRuntime(cfg(), 'admin-token-x')
  const server = createGatewayServer(rt, { port: 0 })
  const gwPort = await listenEphemeral(server)
  const lan = await startLanServer(rt, { port: 0, token: 'mdklan_' + 'a'.repeat(32), host: '127.0.0.1' })
  return {
    gwPort,
    lanPort: lan.port,
    base: `http://127.0.0.1:${gwPort}/_modeldock`,
    close: () => {
      stopLan(rt)
      server.closeAllConnections?.()
      server.close()
      h.restore()
    },
  }
}

describe('控制台缓存与轮询优化', () => {
  const ctxs: TestCtx[] = []
  afterEach(() => {
    for (const c of ctxs.splice(0)) c.close()
  })

  it('overview：TTL 内二次请求返回体逐字节一致且 content-type 正确（命中不再重序列化）', async () => {
    const t = await start()
    ctxs.push(t)
    const url = `${t.base}/overview`
    const first = await fetch(url, { headers: ADMIN })
    expect(first.status).toBe(200)
    const body1 = await first.text()
    expect(first.headers.get('content-type')).toMatch(/application\/json/)
    // 两次请求紧邻（远小于 2s TTL），确保第二次命中缓存
    const second = await fetch(url, { headers: ADMIN })
    expect(second.status).toBe(200)
    expect(second.headers.get('content-type')).toMatch(/application\/json/)
    expect(await second.text()).toBe(body1)
  })

  it('overview：JSON API 响应仍带 no-store（总策略未被 ETag/304 波及）', async () => {
    const t = await start()
    ctxs.push(t)
    const res = await fetch(`${t.base}/overview`, { headers: ADMIN })
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toContain('no-store')
  })

  it('控制台 HTML：首次 200 + ETag；带匹配 ETag 的 If-None-Match 二次请求 304 且无 body', async () => {
    const t = await start()
    ctxs.push(t)
    const url = `${t.base}/ui`
    const first = await fetch(url)
    expect(first.status).toBe(200)
    expect(first.headers.get('content-type')).toMatch(/text\/html/)
    const etag = first.headers.get('etag')
    expect(etag).toBeTruthy()
    expect(await first.text()).toContain('reloginBtn')

    const second = await fetch(url, { headers: { 'if-none-match': etag! } })
    expect(second.status).toBe(304)
    expect(await second.text()).toBe('')
  })

  it('PWA 图标：两个图标的 cache-control 都含 immutable（内容编译期常量，长缓存）', async () => {
    const t = await start()
    ctxs.push(t)
    const auth = { authorization: `Bearer mdklan_${'a'.repeat(32)}` }
    for (const name of ['icon-192.png', 'icon-512.png']) {
      const res = await fetch(`http://127.0.0.1:${t.lanPort}/m/${name}`, { headers: auth })
      expect(res.status).toBe(200)
      expect(res.headers.get('cache-control')).toContain('immutable')
    }
  })
})