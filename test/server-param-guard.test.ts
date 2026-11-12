// rev-server-night：server.ts 请求参数类型护栏 + 全滤空链 503 model_mismatch 日志投影端到端回归。
// ①ttl_minutes / max_daily_tokens 此前经 Number() 强转：布尔 true 被静默当 1（1 分钟 TTL /
//   1 token 日限额，Number(true)===1 走合法路径）；修复后非 number 类型一律 400 与 NaN 同路，
//   只放行 JSON number（UI/编排侧均传 number，无回归面）。
// ②relay「候选被模型相容过滤全剔除」503 出口（routeReason=model_mismatch，无 cause）经 server
//   日志投影 cause: e.cause ?? e.routeReason 必须落 model_mismatch——编排侧按 cause 分诊的数据源，
//   投影断链会让 503 全滤空链被误诊成 generic 5xx。只加测试不改实现。
// E2E 全走 server.listen(0) 随机端口 + fakeHome 隔离，无模块 mock（isolate:false 雷区规避）。

import http from 'node:http'
import { AddressInfo } from 'node:net'
import { describe, expect, it } from 'vitest'
import { fakeHome } from './helpers.js'
import { buildRuntime, recordOutcome } from '../src/gateway/state.js'
import { createGatewayServer } from '../src/gateway/server.js'
import type { Config } from '../src/config/types.js'

const ADMIN = 'admin-tok'

function listenEphemeral(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port))
  })
}

function request(port: number, path: string, headers: Record<string, string> = {}, body?: string): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, headers, method: body !== undefined ? 'POST' : 'GET' }, (res) => {
      let data = ''
      res.on('data', (c) => (data += c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data, headers: res.headers }))
    })
    req.on('error', reject)
    if (body !== undefined) req.write(body)
    req.end()
  })
}

function adminPost(port: number, path: string, body: unknown): Promise<{ status: number; body: string }> {
  return request(port, path, { 'content-type': 'application/json', 'x-modeldock-admin': ADMIN }, JSON.stringify(body))
}

function adminGet(port: number, path: string): Promise<{ status: number; body: string }> {
  return request(port, path, { 'x-modeldock-admin': ADMIN })
}

/** 基础配置：provider/profile/persistent-harness 齐备，无真实上游（本文件不触达上游） */
function baseConfig(): Config {
  return {
    version: 1,
    active_profile: 'demo',
    security: { store: 'file' },
    providers: {
      A: { name: 'A', base_url: 'http://a.example', protocol: 'anthropic', auth_style: 'bearer', key_ref: 'k1' },
    },
    profiles: { demo: { provider: 'A', default_model: 'm1' } },
    harness: { zcode: { mode: 'gateway', token: 'mdk_zcode_tok' } },
  } as never as Config
}

async function setup(cfg: Config = baseConfig()) {
  const h = fakeHome()
  const rt = buildRuntime(cfg, ADMIN)
  // 出站定时器（节假日/目录/探测）一律禁用：本文件用例不触网，也避免 90s 首查定时器噪音
  const server = createGatewayServer(rt, { port: 0, autoHolidayRefresh: false, autoCatalogRefresh: false, autoModelProbe: false })
  const port = await listenEphemeral(server)
  return {
    rt,
    port,
    close: () => {
      server.closeAllConnections?.()
      server.close()
      h.restore()
    },
  }
}

describe('请求体数字参数类型护栏（ttl_minutes / max_daily_tokens，rev-server-night）', () => {
  it('provision：布尔 true → 400（不再被 Number(true)===1 静默当 1 分钟 TTL）', async () => {
    const t = await setup()
    try {
      const r = await adminPost(t.port, '/_modeldock/harness/provision', { ttl_minutes: true })
      expect(r.status).toBe(400)
      const j = JSON.parse(r.body) as { error?: { message?: string } }
      expect(j.error?.message ?? '').toContain('ttl_minutes')
    } finally {
      t.close()
    }
  })

  it('provision：非 number 类型（字符串数字 / 数组 / 对象）一律 400 与 NaN 同路', async () => {
    const t = await setup()
    try {
      // 显式 null 同为非 number：与旧行为一致走 400（不放宽成「未提供」）
      for (const bad of [null, '480', [480], { minutes: 480 }]) {
        const r = await adminPost(t.port, '/_modeldock/harness/provision', { ttl_minutes: bad })
        expect(r.status).toBe(400)
      }
      // 原有数值护栏不回退：NaN 同路 / 非正 / 超上限
      for (const bad of ['abc', 0, -5, 1441]) {
        const r = await adminPost(t.port, '/_modeldock/harness/provision', { ttl_minutes: bad })
        expect(r.status).toBe(400)
      }
    } finally {
      t.close()
    }
  })

  it('provision：合法数字放行、缺省 480 分钟（TTL 不再吞布尔，正常路径零变化）', async () => {
    const t = await setup()
    try {
      const r = await adminPost(t.port, '/_modeldock/harness/provision', { ttl_minutes: 45 })
      expect(r.status).toBe(200)
      const j = JSON.parse(r.body) as { ok: boolean; id: string; token: string; expires_at: string }
      expect(j.ok).toBe(true)
      expect(j.token).toBeTruthy()
      const ttlMs = Date.parse(j.expires_at) - Date.now()
      expect(ttlMs).toBeGreaterThan(44 * 60_000)
      expect(ttlMs).toBeLessThan(46 * 60_000)
      // 缺省 = EPHEMERAL_TTL_DEFAULT_MINUTES（480）
      const d = await adminPost(t.port, '/_modeldock/harness/provision', {})
      expect(d.status).toBe(200)
      const dj = JSON.parse(d.body) as { expires_at: string }
      const defMs = Date.parse(dj.expires_at) - Date.now()
      expect(defMs).toBeGreaterThan(479 * 60_000)
      expect(defMs).toBeLessThan(481 * 60_000)
    } finally {
      t.close()
    }
  })

  it('provision：max_daily_tokens 布尔 → 400（不再被当 1 token 日限额）；数字放行、字符串拒绝', async () => {
    const t = await setup()
    try {
      const bad = await adminPost(t.port, '/_modeldock/harness/provision', { max_daily_tokens: true })
      expect(bad.status).toBe(400)
      const badNull = await adminPost(t.port, '/_modeldock/harness/provision', { max_daily_tokens: null })
      expect(badNull.status).toBe(400)
      const badStr = await adminPost(t.port, '/_modeldock/harness/provision', { max_daily_tokens: '5000' })
      expect(badStr.status).toBe(400)
      const ok = await adminPost(t.port, '/_modeldock/harness/provision', { max_daily_tokens: 5000 })
      expect(ok.status).toBe(200)
    } finally {
      t.close()
    }
  })

  it('renew：布尔 ttl_minutes → 400；合法数字放行且按只延不缩续期', async () => {
    const t = await setup()
    try {
      const p = await adminPost(t.port, '/_modeldock/harness/provision', {})
      expect(p.status).toBe(200)
      const { id } = JSON.parse(p.body) as { id: string }
      const bad = await adminPost(t.port, '/_modeldock/harness/renew', { harnessId: id, ttl_minutes: true })
      expect(bad.status).toBe(400)
      const badStr = await adminPost(t.port, '/_modeldock/harness/renew', { harnessId: id, ttl_minutes: '600' })
      expect(badStr.status).toBe(400)
      const ok = await adminPost(t.port, '/_modeldock/harness/renew', { harnessId: id, ttl_minutes: 600 })
      expect(ok.status).toBe(200)
      const oj = JSON.parse(ok.body) as { ok: boolean; expires_at: string; ttl_minutes: number }
      expect(oj.ok).toBe(true)
      // 续后到期 = max(旧到期 now+480, now+600) = now+600（响应 ttl_minutes 为剩余寿命）
      expect(oj.ttl_minutes).toBeGreaterThan(599)
      expect(oj.ttl_minutes).toBeLessThan(601)
      // 未知 id 维持 404 口径
      const nf = await adminPost(t.port, '/_modeldock/harness/renew', { harnessId: 'eph-nope', ttl_minutes: 30 })
      expect(nf.status).toBe(404)
    } finally {
      t.close()
    }
  })
})

describe('全滤空链 503 model_mismatch 日志投影（rev-relay-round2-night 转交验证）', () => {
  /** 主候选 A 熔断后 pickTarget 只剩自动补尾候选 B；B 目录已管理且不含请求模型 m1 →
   *  filterModelCompatible 全剔除 → relay「cands.length===0」503 出口（routeReason=model_mismatch）。
   *  两家 base_url 均不可达也不该被触达：主候选被熔断剔除、B 在转发前被过滤（零真实上游请求）。 */
  function mismatchConfig(): Config {
    return {
      version: 1,
      active_profile: 'demo',
      security: { store: 'file' },
      providers: {
        A: {
          name: 'primary',
          base_url: 'http://127.0.0.1:1',
          protocol: 'anthropic',
          auth_style: 'bearer',
          key_ref: 'k1',
          models: { m1: { source: 'preset' } },
        },
        B: {
          name: 'auto-b',
          base_url: 'http://127.0.0.1:1',
          protocol: 'anthropic',
          auth_style: 'bearer',
          key_ref: 'k2',
          models: { 'other-m': { source: 'preset' } },
        },
      },
      profiles: { demo: { provider: 'A', default_model: 'm1' } },
      harness: { 'claude-code': { mode: 'gateway', route: 'default', token: 'mdk_harness_tok' } },
    } as never as Config
  }

  it('503 出口经日志投影落 cause=model_mismatch（reason 同值、attempts 逐候选留痕）', async () => {
    const h = fakeHome()
    const rt = buildRuntime(mismatchConfig(), ADMIN)
    // 主候选 A 打进熔断（connect 档 3 次即熔断 60s）：pickTarget 剔除主候选，只剩 auto 候选 B
    for (let i = 0; i < 3; i++) recordOutcome(rt, 'A', { ok: false, cls: 'connect' })
    const server = createGatewayServer(rt, { port: 0, autoHolidayRefresh: false, autoCatalogRefresh: false, autoModelProbe: false })
    const port = await listenEphemeral(server)
    try {
      const res = await request(
        port,
        '/v1/messages',
        { authorization: 'Bearer mdk_harness_tok', 'content-type': 'application/json' },
        JSON.stringify({ model: 'm1', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] })
      )
      expect(res.status).toBe(503)
      const j = JSON.parse(res.body) as { error?: { message?: string }; modeldock?: { hint?: string } }
      // 命中「没有候选可伺服该请求模型」专用出口（zh；与 down_all「候选服务全部不可达」文案区分）
      expect(j.error?.message ?? '').toContain('没有候选')
      expect(j.modeldock?.hint).toBeTruthy()
      // 请求日志（管理面 /logs 端到端读取，非直读 ring）：cause 投影必须落 model_mismatch
      const logs = await adminGet(port, '/_modeldock/logs?kind=err')
      expect(logs.status).toBe(200)
      const lj = JSON.parse(logs.body) as {
        logs: Array<{ path?: string; status?: number; harness?: string; provider?: string; cause?: string; reason?: string; attempts?: Array<{ provider: string; note?: string }> }
      }
      const entry = lj.logs.find((e) => e.path === '/v1/messages' && e.status === 503)
      expect(entry).toBeTruthy()
      expect(entry!.cause).toBe('model_mismatch')
      expect(entry!.reason).toBe('model_mismatch')
      expect(entry!.harness).toBe('claude-code')
      expect(entry!.provider).toBe('A') // 归因仍按请求解析目标（主候选），未被过滤候选覆盖
      expect(entry!.attempts).toEqual([{ provider: 'B', note: 'model_mismatch' }])
    } finally {
      server.closeAllConnections?.()
      server.close()
      h.restore()
    }
  })
})
