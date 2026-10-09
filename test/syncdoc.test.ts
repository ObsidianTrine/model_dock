import { describe, expect, it } from 'vitest'
import { openEnvelope, sealEnvelope, verifyEnvelopeHmac } from '../src/sync/crypto.js'
import {
  ENVELOPE_FMT,
  SYNCDOC_FMT,
  validateSyncdoc,
  type Syncdoc,
} from '../src/sync/types.js'

function sampleDoc(over: Partial<Syncdoc> = {}): Syncdoc {
  return {
    fmt: SYNCDOC_FMT,
    v: 1,
    ts: '2026-10-04T12:00:00.000Z',
    data: {
      providers: {
        ark: { base_url: 'https://ark.example.com/api', protocol: 'anthropic', auth_style: 'bearer', key: 'sk-test' },
        envprov: { base_url: 'https://env.example.com', protocol: 'openai', auth_style: 'bearer', key_ref: 'env:ARK_KEY' },
      },
      profiles: { main: { provider: 'ark', default_model: 'auto' } },
      userPresets: [],
      scheduleRules: [{ start: '09:00', end: '18:00', target: 'ark' }],
    },
    ...over,
  }
}

describe('syncdoc schema 校验', () => {
  it('合法文档通过', () => {
    expect(() => validateSyncdoc(sampleDoc())).not.toThrow()
  })

  it('未知 schema 版本拒绝并提示升级客户端', () => {
    expect(() => validateSyncdoc(sampleDoc({ v: 99 }))).toThrow(/升级|upgrade/)
  })

  it('fmt 不符拒绝', () => {
    expect(() => validateSyncdoc(sampleDoc({ fmt: 'other' as never }))).toThrow()
  })

  it('缺 ts / data 拒绝', () => {
    expect(() => validateSyncdoc({ fmt: SYNCDOC_FMT, v: 1, data: sampleDoc().data } as unknown as Syncdoc)).toThrow()
    expect(() => validateSyncdoc({ fmt: SYNCDOC_FMT, v: 1, ts: 'x' } as unknown as Syncdoc)).toThrow()
  })

  it('provider 缺 base_url / 未知 protocol 拒绝', () => {
    const d = sampleDoc()
    delete (d.data.providers.ark as Record<string, unknown>).base_url
    expect(() => validateSyncdoc(d)).toThrow()
    const d2 = sampleDoc()
    ;(d2.data.providers.ark as Record<string, unknown>).protocol = 'grpc'
    expect(() => validateSyncdoc(d2)).toThrow()
  })

  it('provider 既无 key_ref 也无 key 拒绝', () => {
    const d = sampleDoc()
    const p = d.data.providers.ark as Record<string, unknown>
    delete p.key_ref
    delete p.key
    expect(() => validateSyncdoc(d)).toThrow()
  })

  it('profile 缺 provider 拒绝；定时规则缺 target 拒绝', () => {
    const d = sampleDoc()
    delete (d.data.profiles.main as Record<string, unknown>).provider
    expect(() => validateSyncdoc(d)).toThrow()
    const d2 = sampleDoc()
    delete (d2.data.scheduleRules[0] as Record<string, unknown>).target
    expect(() => validateSyncdoc(d2)).toThrow()
  })

  it('userPresets 只接受数组或 {presets:[...]}', () => {
    expect(() => validateSyncdoc(sampleDoc({ data: { ...sampleDoc().data, userPresets: { presets: [] } } }))).not.toThrow()
    expect(() => validateSyncdoc(sampleDoc({ data: { ...sampleDoc().data, userPresets: { nope: 1 } as never } }))).toThrow()
  })
})

describe('加密信封 seal/open', () => {
  it('roundtrip：解出的文档与原文逐字段相等', () => {
    const doc = sampleDoc()
    const env = sealEnvelope(doc, '口令正确')
    expect(env.fmt).toBe(ENVELOPE_FMT)
    expect(env.v).toBe(1)
    for (const b64 of [env.kdf.salt, env.kdf.hkdfSalt, env.iv, env.ct, env.hmac, env.verifier]) {
      expect(b64.length).toBeGreaterThan(0)
    }
    const out = openEnvelope(JSON.parse(JSON.stringify(env)) as typeof env, '口令正确')
    expect(out).toEqual(doc)
  })

  it('错误口令失败', () => {
    const env = sealEnvelope(sampleDoc(), 'right')
    expect(() => openEnvelope(env, 'wrong')).toThrow(/口令不正确|incorrect/)
  })

  it('篡改 ct 失败（GCM 认证）', () => {
    const env = sealEnvelope(sampleDoc(), 'pw')
    const raw = Buffer.from(env.ct, 'base64')
    raw[raw.length - 1] ^= 0x01
    env.ct = raw.toString('base64')
    expect(() => openEnvelope(env, 'pw')).toThrow()
  })

  it('篡改密文对应的 syncdoc.ts 后 HMAC 校验失败', () => {
    const doc = sampleDoc()
    const env = sealEnvelope(doc, 'pw')
    const opened = openEnvelope(env, 'pw')
    const forged = { ...opened, ts: '2020-01-01T00:00:00.000Z' }
    expect(() => verifyEnvelopeHmac(forged, env, 'pw')).toThrow()
  })

  it('信封 fmt 或 v 不认识拒绝', () => {
    const env = sealEnvelope(sampleDoc(), 'pw')
    expect(() => openEnvelope({ ...env, fmt: 'nope' } as typeof env, 'pw')).toThrow()
    expect(() => openEnvelope({ ...env, v: 2 } as typeof env, 'pw')).toThrow()
  })

  it('每个信封 salt/iv 独立（同口令两次密封密文不同）', () => {
    const doc = sampleDoc()
    const a = sealEnvelope(doc, 'pw')
    const b = sealEnvelope(doc, 'pw')
    expect(a.ct).not.toBe(b.ct)
    expect(a.kdf.salt).not.toBe(b.kdf.salt)
  })
})
