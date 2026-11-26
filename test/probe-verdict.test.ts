import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { buildRuntime } from '../src/gateway/state.js'
import type { GatewayRuntime } from '../src/gateway/state.js'
import { sha256, closeAppendStreams, drainAppendStreams } from '../src/util/fsx.js'
import { logsDir } from '../src/util/paths.js'
import { fakeHome } from './helpers.js'
import type { Config } from '../src/config/types.js'
import {
  PROBE_ERR_SUMMARY_MAX,
  PROBE_VERDICT_STALE_MS,
  applyVerdictEvidence,
  effectiveVerdictState,
  getProbeVerdict,
  keyFingerprint,
  pruneOrphanKeyVerdicts,
  replayProbeVerdicts,
  sanitizeErrorSummary,
  sweepStaleVerdicts,
  verdictKey,
} from '../src/gateway/probe/verdict.js'
import type { ProbeVerdictInput } from '../src/gateway/probe/verdict.js'

// 探针 verdict 状态机（provider-probe-suite 任务 1）：
// - 三元组键 = (provider, sha256(key) 前 8 位指纹, model)，绝不含 key 明文
// - canary 单次判定；jittery 单次冲突不翻状态（3 取中位共识后才翻）
// - 7 天无证据转 stale（读面兜底 + 清扫固化）
// - 按天 JSONL append-only，重启回放重建热态

function mkRt(): GatewayRuntime {
  return buildRuntime({ providers: {}, profiles: {}, harness: {} } as unknown as Config, 'tok')
}

const now = Date.now()

function canaryHealthy(provider: string, keyFp: string, model: string, at = now): ProbeVerdictInput {
  return { provider, keyFp, model, source: 'probe:p1', kind: 'canary', state: 'healthy', evidence: { at, status: 200, ms: 12 } }
}

describe('probe-verdict · 三元组键与脱敏', () => {
  it('keyFingerprint = sha256 前 8 位十六进制', () => {
    const key = 'sk-live-abcdef12'
    expect(keyFingerprint(key)).toBe(sha256(key).slice(0, 8))
    expect(keyFingerprint(key)).toMatch(/^[0-9a-f]{8}$/)
  })

  it('三元组键含 sha256 前 8 位指纹且不含 key 明文', () => {
    const key = 'sk-very-secret-value-9f8e7d6c'
    const k = verdictKey('acme', keyFingerprint(key), 'gpt-x')
    expect(k).toContain('acme')
    expect(k).toContain(keyFingerprint(key))
    expect(k).not.toContain(key)
  })

  it('sanitizeErrorSummary：首行 + 剥离 key 明文 + ≤400 字符；截断边界不漏脱敏', () => {
    expect(sanitizeErrorSummary('first line\nsecond line')).toBe('first line')
    expect(sanitizeErrorSummary('err sk-abcdefgh-1234 tail', ['sk-abcdefgh-1234'])).toBe('err [redacted] tail')
    expect(sanitizeErrorSummary('x'.repeat(500)).length).toBe(PROBE_ERR_SUMMARY_MAX)
    const pad = 'a'.repeat(390)
    const secret = 'sk-abcdefgh-12345678'
    const out = sanitizeErrorSummary(pad + secret, [secret])
    expect(out).toBe(pad + '[redacted]')
    expect(out.length).toBeLessThanOrEqual(PROBE_ERR_SUMMARY_MAX)
    // 过短替换串不生效（防误伤正文）
    expect(sanitizeErrorSummary('key is abcd', ['abcd'])).toBe('key is abcd')
  })
})

describe('probe-verdict · 状态机', () => {
  it('canary 单次证据即定状态，证据五件套齐备', () => {
    const rt = mkRt()
    const v = applyVerdictEvidence(rt, canaryHealthy('acme', 'fp1', 'm1'))
    expect(v.state).toBe('healthy')
    expect(v.evidence.source).toBe('probe:p1')
    expect(v.evidence.status).toBe(200)
    expect(v.evidence.ms).toBe(12)
    expect(getProbeVerdict(rt, 'acme', 'fp1', 'm1')?.state).toBe('healthy')
  })

  it('无状态证据（advisory）只记证据不翻既有状态', () => {
    const rt = mkRt()
    applyVerdictEvidence(rt, canaryHealthy('acme', 'fp1', 'm1'))
    const v = applyVerdictEvidence(rt, { provider: 'acme', keyFp: 'fp1', model: 'm1', source: 'probe:p12', kind: 'jittery', evidence: { at: now + 1, status: 200 } })
    expect(v.state).toBe('healthy') // advisory 不翻状态
    expect(v.evidence.at).toBe(now + 1) // freshness 刷新
  })

  it('jittery 单次冲突不翻状态（证据标 unverified）；3 次一致冲突才翻转', () => {
    const rt = mkRt()
    applyVerdictEvidence(rt, canaryHealthy('acme', 'fp1', 'm1'))
    // 第 1 次冲突：维持 healthy，冲突证据标 unverified
    const v1 = applyVerdictEvidence(rt, { provider: 'acme', keyFp: 'fp1', model: 'm1', source: 'probe:p14', kind: 'jittery', state: 'unreachable', evidence: { at: now + 1, status: 503 } })
    expect(v1.state).toBe('healthy')
    expect(v1.evidence.unverified).toBe(true)
    expect(v1.pending).toHaveLength(1)
    // 第 2 次冲突：仍不翻
    const v2 = applyVerdictEvidence(rt, { provider: 'acme', keyFp: 'fp1', model: 'm1', source: 'probe:p14', kind: 'jittery', state: 'unreachable', evidence: { at: now + 2, status: 503 } })
    expect(v2.state).toBe('healthy')
    // 第 3 次冲突：多数派（3/3 unreachable）达成 → 翻转
    const v3 = applyVerdictEvidence(rt, { provider: 'acme', keyFp: 'fp1', model: 'm1', source: 'probe:p14', kind: 'jittery', state: 'unreachable', evidence: { at: now + 3, status: 503 } })
    expect(v3.state).toBe('unreachable')
    expect(v3.pending).toBeUndefined()
    expect(v3.evidence.unverified).toBeUndefined()
  })

  it('jittery 冲突中途出现一致样本即解除（缓冲清零、freshness 刷新）', () => {
    const rt = mkRt()
    applyVerdictEvidence(rt, canaryHealthy('acme', 'fp1', 'm1'))
    applyVerdictEvidence(rt, { provider: 'acme', keyFp: 'fp1', model: 'm1', source: 'probe:p14', kind: 'jittery', state: 'unreachable', evidence: { at: now + 1 } })
    const v = applyVerdictEvidence(rt, { provider: 'acme', keyFp: 'fp1', model: 'm1', source: 'probe:p14', kind: 'jittery', state: 'healthy', evidence: { at: now + 2, status: 200 } })
    expect(v.state).toBe('healthy')
    expect(v.pending).toBeUndefined()
    expect(v.evidence.unverified).toBeUndefined()
  })

  it('jittery 首样本不立状态（unverified），3 样本多数派后立', () => {
    const rt = mkRt()
    const input = (at: number): ProbeVerdictInput => ({ provider: 'b', keyFp: 'fp9', model: 'm', source: 'probe:p10', kind: 'jittery', state: 'degraded', evidence: { at } })
    const v1 = applyVerdictEvidence(rt, input(now))
    expect(v1.state).toBe('unverified')
    expect(v1.pending).toHaveLength(1)
    applyVerdictEvidence(rt, input(now + 1))
    const v3 = applyVerdictEvidence(rt, input(now + 2))
    expect(v3.state).toBe('degraded') // 3/3 degraded 达成共识
  })
})

describe('probe-verdict · 7 天 stale', () => {
  it('证据超 7 天读面即 stale；清扫固化翻转；新证据解除 stale', () => {
    const rt = mkRt()
    const old = now - PROBE_VERDICT_STALE_MS - 60_000
    applyVerdictEvidence(rt, canaryHealthy('acme', 'fp1', 'm1', old))
    const v1 = getProbeVerdict(rt, 'acme', 'fp1', 'm1')!
    expect(v1.state).toBe('healthy') // 存储态未动
    expect(effectiveVerdictState(v1, now)).toBe('stale') // 读面兜底
    expect(sweepStaleVerdicts(rt, now)).toBe(1) // 清扫固化
    expect(v1.state).toBe('stale')
    expect(sweepStaleVerdicts(rt, now)).toBe(0) // 已 stale 不重复计
    // 新证据到来：解除 stale
    const v2 = applyVerdictEvidence(rt, canaryHealthy('acme', 'fp1', 'm1', now))
    expect(v2.state).toBe('healthy')
    expect(effectiveVerdictState(v2, now)).toBe('healthy')
    // 未满 7 天不受影响
    applyVerdictEvidence(rt, canaryHealthy('fresh', 'fp2', 'm', now - 1000))
    expect(effectiveVerdictState(getProbeVerdict(rt, 'fresh', 'fp2', 'm')!, now)).toBe('healthy')
  })
})

describe('probe-verdict · 换 key 销账（pruneOrphanKeyVerdicts）', () => {
  it('孤儿指纹结论删除；存活指纹与「-」占位保留；其他服务不受影响', () => {
    const rt = mkRt()
    applyVerdictEvidence(rt, canaryHealthy('acme', 'live1111', 'm1'))
    applyVerdictEvidence(rt, { ...canaryHealthy('acme', 'dead2222', 'm1'), state: 'auth-dead' })
    applyVerdictEvidence(rt, canaryHealthy('acme', '-', 'm1')) // 被动 P15 占位
    applyVerdictEvidence(rt, canaryHealthy('other', 'dead2222', 'm1'))
    expect(pruneOrphanKeyVerdicts(rt, 'acme', new Set(['live1111']))).toBe(1)
    expect(getProbeVerdict(rt, 'acme', 'live1111', 'm1')).toBeDefined()
    expect(getProbeVerdict(rt, 'acme', '-', 'm1')).toBeDefined()
    expect(getProbeVerdict(rt, 'acme', 'dead2222', 'm1')).toBeUndefined()
    expect(getProbeVerdict(rt, 'other', 'dead2222', 'm1')).toBeDefined()
  })
  it('liveFps 空集直接跳过：区分不了「真没 key」与「钥匙环暂时不可读」，宁保留勿误删', () => {
    const rt = mkRt()
    applyVerdictEvidence(rt, canaryHealthy('acme', 'dead2222', 'm1'))
    expect(pruneOrphanKeyVerdicts(rt, 'acme', new Set())).toBe(0)
    expect(getProbeVerdict(rt, 'acme', 'dead2222', 'm1')).toBeDefined()
  })
})

describe('probe-verdict · JSONL 回放', () => {
  it('按天落盘 probe-<date>.jsonl，新 rt 回放重建热态（后写覆盖先写），文件不含 key 明文', async () => {
    const h = fakeHome()
    try {
      const rt = mkRt()
      const key = 'sk-replay-leak-check-7777'
      const fp = keyFingerprint(key)
      applyVerdictEvidence(rt, canaryHealthy('acme', fp, 'm1', now))
      applyVerdictEvidence(rt, {
        provider: 'acme',
        keyFp: fp,
        model: 'm1',
        source: 'probe:p1',
        kind: 'canary',
        state: 'quota',
        evidence: { at: now + 1, status: 402, err: 'insufficient quota' },
      })
      applyVerdictEvidence(rt, { provider: 'acme', keyFp: 'fp1', model: 'm2', source: 'probe:p15', kind: 'passive', state: 'auth-dead', evidence: { at: now, status: 401 } })
      await drainAppendStreams() // end() 是异步刷盘：等 close 再读目录（常驻流缓冲不等待会漏文件）
      const dir = logsDir()
      const files = fs.readdirSync(dir).filter((n) => /^probe-\d{4}-\d{2}-\d{2}\.jsonl$/.test(n))
      expect(files).toHaveLength(1)
      const text = fs.readFileSync(path.join(dir, files[0]), 'utf8')
      expect(text).not.toContain(key)
      // 新 rt 模拟重启回放
      const rt2 = mkRt()
      const n = await replayProbeVerdicts(rt2)
      expect(n).toBe(3)
      const v2 = getProbeVerdict(rt2, 'acme', fp, 'm1')
      expect(v2?.state).toBe('quota') // 后写覆盖先写
      expect(v2?.evidence.status).toBe(402)
      expect(v2?.evidence.err).toBe('insufficient quota')
      expect(getProbeVerdict(rt2, 'acme', 'fp1', 'm2')?.state).toBe('auth-dead')
    } finally {
      h.restore()
    }
  })

  it('坏行与外来条目跳过不致命', async () => {
    const h = fakeHome()
    try {
      const dir = logsDir()
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(
        path.join(dir, 'probe-2026-01-01.jsonl'),
        ['not json', JSON.stringify({ kind: 'audit' }), JSON.stringify({ kind: 'probe-verdict', provider: 'p', key_fp: 'fp', model: 'm', state: 'healthy', source: 's', at: new Date(2026, 0, 1).toISOString() }), ''].join('\n')
      )
      const rt = mkRt()
      const n = await replayProbeVerdicts(rt)
      expect(n).toBe(1)
      expect(getProbeVerdict(rt, 'p', 'fp', 'm')?.state).toBe('healthy')
    } finally {
      h.restore()
    }
  })
})
