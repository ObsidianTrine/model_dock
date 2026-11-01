import { describe, expect, it } from 'vitest'
import http from 'node:http'
import { fakeHome } from './helpers.js'
import { listenWithRetry } from '../src/gateway/shared.js'
import { forwardToUpstream, UpstreamError } from '../src/gateway/relay.js'
import { buildRuntime, resolveTarget, type GatewayRuntime, type ResolvedTarget } from '../src/gateway/state.js'
import { setSecret } from '../src/config/secrets.js'
import { drainAppendStreams } from '../src/util/fsx.js'

function targetWithBase(base_url: string): ResolvedTarget {
  return {
    harness: 'test',
    profileName: 'p',
    profile: { name: 'p', provider: 'prov' },
    provider: { base_url, protocol: 'anthropic', auth_style: 'bearer', key_ref: 'file:k' },
  }
}

describe('error-hints-audit：四类高频失败路径的可操作 hint（卡 error-hints-audit）', () => {
  it('② harness token 无效：401 hint 含精确补救命令 modeldock attach', () => {
    const rt: GatewayRuntime = buildRuntime({ providers: {}, profiles: {}, harness: {} } as never, 'admin')
    const r = resolveTarget(rt, 'bogus-token')
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.status).toBe(401)
      expect(r.hint).toContain('modeldock attach')
      expect(r.hint).toContain('modeldock status')
    }
  })

  it('③ 上游连接失败（拒绝类）：502 hint 指向 modeldock test 与 provider.proxy', async () => {
    const h = fakeHome()
    try {
      await setSecret('k', 'sk-test-key', 'file')
      const rt = buildRuntime({ providers: {}, profiles: {}, harness: {} } as never, 'admin')
      // 占一个端口再关掉：确定性的「连接被拒」上游
      const s = http.createServer()
      await new Promise<void>((res) => s.listen(0, '127.0.0.1', res))
      const port = (s.address() as { port: number }).port
      await new Promise<void>((res) => s.close(() => res()))
      let caught: unknown = null
      try {
        await forwardToUpstream(rt, targetWithBase(`http://127.0.0.1:${port}`), {
          method: 'POST', path: '/v1/messages', headers: {},
          body: Buffer.from('{"model":"m"}'), idleTimeoutMs: 1000, retries: 1,
        })
      } catch (e) {
        caught = e
      }
      expect(caught).toBeInstanceOf(UpstreamError)
      const ue = caught as UpstreamError
      expect(ue.message).toContain('上游连接失败')
      expect(ue.hint).toContain('modeldock test')
      expect(ue.hint).toContain('provider.proxy')
    } finally {
      await drainAppendStreams()
      h.restore()
    }
  })

  it('① 端口冲突顺延穷尽：连续 11 个端口被占时报可操作错误（不再裸 EADDRINUSE）', async () => {
    // 找一段连续 11 个空闲端口全部占住（从 21000 起扫，避开 189xx 测试段与受保护端口）
    for (let base = 21000; base < 40000; base += 11) {
      const servers: http.Server[] = []
      let ok = true
      for (let p = base; p < base + 11; p++) {
        try {
          const s = http.createServer()
          await new Promise<void>((res, rej) => {
            s.once('error', rej)
            s.listen(p, '127.0.0.1', () => res())
          })
          servers.push(s)
        } catch {
          ok = false
          break
        }
      }
      if (!ok) {
        for (const x of servers) x.close()
        continue
      }
      try {
        const s = http.createServer()
        let err: Error | null = null
        try {
          await listenWithRetry(s, base, '127.0.0.1')
        } catch (e) {
          err = e as Error
        }
        expect(err).toBeTruthy()
        expect(err!.message).toContain('全部被占用')
        expect(err!.message).toContain('modeldock status')
        expect(err!.message).toContain('[gateway]')
        return // 成功构造出穷尽现场，测试完成
      } finally {
        for (const x of servers) x.close()
      }
    }
    throw new Error('未能构造连续 11 端口占用现场（环境异常）')
  }, 30_000)
})
