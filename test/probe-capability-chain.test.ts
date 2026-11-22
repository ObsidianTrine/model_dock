import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { fakeHome } from './helpers.js'
import { buildRuntime, type GatewayRuntime } from '../src/gateway/state.js'
import { applyVerdictEvidence, probeCapabilityView } from '../src/gateway/probe/verdict.js'
import { resolveModelMeta } from '../src/providers/resolve.js'
import { buildOverview } from '../src/gateway/overview-view.js'
import type { Config, ProviderConfig } from '../src/config/types.js'

// 探针能力采集落库（provider-probe-suite 任务 10，design 方案 6）：
// - resolveModelMeta 链插入探针层，位次 config 显式 > upstream /models > probe > 内置表，永不覆盖前两级
// - probeCapabilityView 从 rt.probeVerdicts 派生 (provider, model) 的实测能力
// - buildOverview 模型投影带 capability_source（取值仅 实测|目录），实测带 capability_at 探针时间戳

// overview 构建会后台拉节假日日历 / 目录刷新（外网）：测试环境一律禁用（与 gateway-audit 同款护栏）
process.env.MODELRDOCK_DISABLE_HOLIDAY_FETCH = '1'
process.env.MODELRDOCK_DISABLE_CATALOG_FETCH = '1'

// 桌面客户端 presence 探测可能起子进程：overview 构建统一按「未安装」判定跳过（与 gateway-audit 同款）
const DESKTOP_PRESENCE_IDS = ['workbuddy', 'zcode', 'mimo-desktop']
beforeEach(() => {
  for (const id of DESKTOP_PRESENCE_IDS) {
    process.env[`MODELRDOCK_FAKE_${id.toUpperCase().replace(/-/g, '_')}_PRESENT`] = '0'
  }
})
afterEach(() => {
  for (const id of DESKTOP_PRESENCE_IDS) {
    delete process.env[`MODELRDOCK_FAKE_${id.toUpperCase().replace(/-/g, '_')}_PRESENT`]
  }
})

function mkRt(cfg?: Partial<Config>): GatewayRuntime {
  return buildRuntime({ providers: {}, profiles: {}, harness: {}, ...cfg } as unknown as Config, 'tok')
}

function providerCfg(id: string, over: Partial<ProviderConfig> = {}): ProviderConfig {
  return { name: id, base_url: 'http://127.0.0.1:1', protocol: 'anthropic', auth_style: 'bearer', key_ref: `file:${id}`, priority: 0, ...over }
}

describe('resolveModelMeta 探针层（位次：config 显式 > /models > probe > 内置表）', () => {
  it('config 显式 capabilities 存在时探针结论不落最终值（显式 [] 同样最高）', () => {
    // config ['vision'] 压过探针实测无视觉（[]=明确无）——探针永不覆盖用户显式值
    expect(resolveModelMeta('gpt-4o', { capabilities: ['vision'] }, { probeCapabilities: [] }))
      .toEqual({ context_window: 128_000, max_output: 16_384, capabilities: ['vision'] })
    // config 显式 []（明确无视觉）压过探针实测有视觉
    expect(resolveModelMeta('gpt-4o', { capabilities: [] }, { probeCapabilities: ['vision'] }))
      .toEqual({ context_window: 128_000, max_output: 16_384 })
  })

  it('上游 /models 已表态（含 []）时探针结论不覆盖', () => {
    // /models 明确无视觉（[]）短路探针与内置表；长度照旧由内置表补
    expect(resolveModelMeta('gpt-4o', null, { upstream: { capabilities: [] }, probeCapabilities: ['vision'] }))
      .toEqual({ context_window: 128_000, max_output: 16_384 })
    // /models 支持视觉压过探针实测无视觉（[]=明确无）
    expect(resolveModelMeta('gpt-4o', null, { upstream: { capabilities: ['vision'] }, probeCapabilities: [] }))
      .toEqual({ context_window: 128_000, max_output: 16_384, capabilities: ['vision'] })
  })

  it('无显式无 /models 表态时探针结论进最终值；[]=实测明确无短路内置表', () => {
    // 表外模型探针实测有视觉 → capabilities=['vision']
    expect(resolveModelMeta('zz-probe-cap-only', null, { probeCapabilities: ['vision'] }))
      .toEqual({ capabilities: ['vision'] })
    // 内置表带 vision 的模型被探针实测无视觉（[]）→ 不再落内置表 vision；长度照旧补
    expect(resolveModelMeta('gpt-4o', null, { probeCapabilities: [] }))
      .toEqual({ context_window: 128_000, max_output: 16_384 })
    // 探针未表态（undefined）→ 零行为变化，照旧落内置表
    expect(resolveModelMeta('gpt-4o', null, {}))
      .toEqual({ context_window: 128_000, max_output: 16_384, capabilities: ['vision'] })
  })

  it('探针层只动 capabilities：长度字段照常按既有链解析', () => {
    expect(resolveModelMeta('zz-probe-cap-only', null, { probeCapabilities: ['vision'], upstream: { context_window: 777 } }))
      .toEqual({ context_window: 777, capabilities: ['vision'] })
  })
})

describe('probeCapabilityView（rt.probeVerdicts → 探针实测能力派生）', () => {
  // 证据时间用 now 基准：effectiveVerdictState 按 7 天保鲜判 stale，远古时间戳会整批被判过期
  const now = Date.now()
  it('P4 healthy → vision；其余能力探针 healthy 并进标记（排序确定、at 取最新证据）', () => {
    const h = fakeHome()
    try {
      const rt = mkRt()
      applyVerdictEvidence(rt, { provider: 'pv', keyFp: 'fp1', model: 'm1', source: 'probe:p4', kind: 'canary', state: 'healthy', evidence: { at: now - 2000, status: 200 } })
      applyVerdictEvidence(rt, { provider: 'pv', keyFp: 'fp1', model: 'm1', source: 'probe:p5', kind: 'canary', state: 'healthy', evidence: { at: now - 1000, status: 200 } })
      applyVerdictEvidence(rt, { provider: 'pv', keyFp: 'fp1', model: 'm1', source: 'probe:p7', kind: 'canary', state: 'healthy', evidence: { at: now, status: 200 } })
      expect(probeCapabilityView(rt, 'pv', 'm1')).toEqual({ capabilities: ['reasoning', 'tools', 'vision'], at: now })
    } finally {
      h.restore()
    }
  })

  it('P4 degraded → []（实测明确无）；非 P4 能力探针单独通过不得替 vision 表态', () => {
    const h = fakeHome()
    try {
      const rt = mkRt()
      applyVerdictEvidence(rt, { provider: 'pv', keyFp: 'fp1', model: 'm1', source: 'probe:p4', kind: 'canary', state: 'degraded', evidence: { at: now, status: 200 } })
      expect(probeCapabilityView(rt, 'pv', 'm1')).toEqual({ capabilities: [], at: now })
      // 只有 P6（结构化输出）通过：探针层对 vision 未表态 → undefined（防 P6 通过短路内置表 vision）
      const rt2 = mkRt()
      applyVerdictEvidence(rt2, { provider: 'pv', keyFp: 'fp1', model: 'm1', source: 'probe:p6', kind: 'canary', state: 'healthy', evidence: { at: now, status: 200 } })
      expect(probeCapabilityView(rt2, 'pv', 'm1')).toBeUndefined()
    } finally {
      h.restore()
    }
  })

  it('P4 不可判定（unreachable）与证据过期（stale 读面）不表态', () => {
    const h = fakeHome()
    try {
      const rt = mkRt()
      applyVerdictEvidence(rt, { provider: 'pv', keyFp: 'fp1', model: 'm1', source: 'probe:p4', kind: 'canary', state: 'unreachable', evidence: { at: Date.now(), err: 'connect failed' } })
      expect(probeCapabilityView(rt, 'pv', 'm1')).toBeUndefined()
      // 8 天前的 healthy 证据：读面状态已 stale → 探针层弃权回落目录
      const rt2 = mkRt()
      applyVerdictEvidence(rt2, { provider: 'pv', keyFp: 'fp1', model: 'm1', source: 'probe:p4', kind: 'canary', state: 'healthy', evidence: { at: Date.now() - 8 * 86_400_000, status: 200 } })
      expect(probeCapabilityView(rt2, 'pv', 'm1')).toBeUndefined()
    } finally {
      h.restore()
    }
  })

  it('多把 key 各有 verdict：证据最新者胜出；非能力探针与异 (provider, model) 不掺和', () => {
    const h = fakeHome()
    try {
      const rt = mkRt()
      applyVerdictEvidence(rt, { provider: 'pv', keyFp: 'fp1', model: 'm1', source: 'probe:p4', kind: 'canary', state: 'healthy', evidence: { at: now - 5000, status: 200 } })
      applyVerdictEvidence(rt, { provider: 'pv', keyFp: 'fp2', model: 'm1', source: 'probe:p4', kind: 'canary', state: 'degraded', evidence: { at: now, status: 200 } })
      expect(probeCapabilityView(rt, 'pv', 'm1')).toEqual({ capabilities: [], at: now })
      // p1（鉴权回声）不是能力探针；单独存在不产生能力表态
      const rt2 = mkRt()
      applyVerdictEvidence(rt2, { provider: 'pv', keyFp: 'fp1', model: 'm1', source: 'probe:p1', kind: 'canary', state: 'healthy', evidence: { at: now, status: 200 } })
      expect(probeCapabilityView(rt2, 'pv', 'm1')).toBeUndefined()
      // (provider, model) 不匹配的 verdict 不掺和
      const rt3 = mkRt()
      applyVerdictEvidence(rt3, { provider: 'other', keyFp: 'fp1', model: 'm1', source: 'probe:p4', kind: 'canary', state: 'healthy', evidence: { at: now, status: 200 } })
      expect(probeCapabilityView(rt3, 'pv', 'm1')).toBeUndefined()
      expect(probeCapabilityView(rt3, 'pv', 'm2')).toBeUndefined()
    } finally {
      h.restore()
    }
  })
})

describe('buildOverview 能力徽标两态（capability_source 取值仅 实测|目录）', () => {
  it('探针实测标「实测」带 capability_at；config 显式与目录标「目录」；全部取值落在两态内', async () => {
    const h = fakeHome()
    try {
      const cfg = {
        providers: {
          pv: providerCfg('pv', {
            models: {
              'm-probe': { source: 'manual' },
              'm-config': { source: 'manual', capabilities: ['vision'] },
              'gpt-4o': { source: 'manual' },
            },
          }),
        },
        profiles: {},
        harness: {},
      } as unknown as Config
      const rt = mkRt(cfg)
      const at = Date.now()
      // m-probe：P4 实测有视觉；m-config：P4 实测无视觉但 config 显式 ['vision'] 最优先
      applyVerdictEvidence(rt, { provider: 'pv', keyFp: 'fp1', model: 'm-probe', source: 'probe:p4', kind: 'canary', state: 'healthy', evidence: { at, status: 200 } })
      applyVerdictEvidence(rt, { provider: 'pv', keyFp: 'fp1', model: 'm-config', source: 'probe:p4', kind: 'canary', state: 'degraded', evidence: { at, status: 200 } })
      const view = (await buildOverview(rt)) as { services: Array<{ id: string; models: Array<Record<string, unknown>> }> }
      const svc = view.services.find((s) => s.id === 'pv')
      expect(svc).toBeDefined()
      const byId = new Map(svc!.models.map((m) => [String(m.id), m]))
      // 实测态：探针层接管能力表态，带探针时间戳
      const probe = byId.get('m-probe')!
      expect(probe.capability_source).toBe('实测')
      expect(probe.capability_at).toBe(at)
      expect(probe.capabilities).toContain('vision')
      // config 显式值最优先：探针实测无视觉也不覆盖，徽标保持目录态
      const conf = byId.get('m-config')!
      expect(conf.capability_source).toBe('目录')
      expect(conf.capabilities).toEqual(['vision'])
      // 目录态：内置表（gpt-4o vision）未经探针实测
      const catalog = byId.get('gpt-4o')!
      expect(catalog.capability_source).toBe('目录')
      expect(catalog.capabilities).toContain('vision')
      // 全部模型的 capability_source 取值仅 实测|目录
      for (const m of svc!.models) expect(['实测', '目录']).toContain(m.capability_source)
    } finally {
      h.restore()
    }
  })
})
