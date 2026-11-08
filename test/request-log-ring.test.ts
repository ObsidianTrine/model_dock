import { describe, expect, it } from 'vitest'
import { buildRuntime, logRequest, type LogEntry } from '../src/gateway/state.js'
import type { Config } from '../src/config/types.js'
import { localIsoTs } from '../src/util/time.js'
import { fakeHome } from './helpers.js'

/** logRequest 的 level 补写与 okRing 分流（2026-11-08 请求日志可读性改造）：
 *  失败=error 进 ring；改发成功（reason 非空）=warn 进 ring；普通成功=info 进 okRing 小缓冲。 */
function buildRt(): ReturnType<typeof buildRuntime> {
  const cfg = { providers: {}, profiles: {}, harness: {} } as unknown as Config
  return buildRuntime(cfg, 'tok')
}

function req(over: Partial<LogEntry> = {}): LogEntry {
  return { ts: localIsoTs(), harness: 'claude-code', profile: 'p', provider: 'a', path: '/v1/messages', ...over }
}

describe('logRequest · level 补写与 okRing 分流', () => {
  it('失败 → ring+error；改发成功 → ring+warn；普通成功 → okRing+info', () => {
    const h = fakeHome()
    try {
      const rt = buildRt()
      logRequest(rt, req({ status: 404, err: 'upstream' }))
      logRequest(rt, req({ status: 200, reason: 'failover_to:b,replayed_from:a' }))
      logRequest(rt, req({ status: 200, ms: 12 }))
      expect(rt.ring).toHaveLength(2)
      expect(rt.okRing).toHaveLength(1)
      expect(rt.ring.map((e) => (e as LogEntry).level)).toEqual(['error', 'warn'])
      expect(rt.okRing![0].level).toBe('info')
      expect(rt.okRing![0].status).toBe(200)
    } finally {
      h.restore()
    }
  })

  it('okRing 上限 200：滚动挤掉最旧，ring 不受影响', () => {
    const h = fakeHome()
    try {
      const rt = buildRt()
      for (let i = 0; i < 205; i++) logRequest(rt, req({ status: 200, ms: i }))
      expect(rt.okRing).toHaveLength(200)
      expect(rt.ring).toHaveLength(0)
    } finally {
      h.restore()
    }
  })

  it('显式传入 level 时尊重不覆盖（调用方可自定级）', () => {
    const h = fakeHome()
    try {
      const rt = buildRt()
      logRequest(rt, req({ status: 200, level: 'warn' }))
      expect(rt.okRing![0].level).toBe('warn')
    } finally {
      h.restore()
    }
  })
})
