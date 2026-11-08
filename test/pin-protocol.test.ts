import { describe, expect, it } from 'vitest'
import { pinProtocolConflict } from '../src/adapters/shared.js'
import { AdapterError, type HarnessAdapter } from '../src/adapters/types.js'
import { pinRouteProtocolError, planAttach } from '../src/ops.js'
import type { Config, ProviderConfig } from '../src/config/types.js'
import { fakeHome } from './helpers.js'

/** 钉路由/接入的协议兼容校验（2026-11-08 claude-code 钉 bigmodel 404 事故的堵洞）：
 *  网关不做跨协议翻译，单协议客户端钉到不支持其协议的服务 = 请求永远被静默改发。
 *  校验器只读 adapter.label / clientProtocols，桩用最小形态即可（真实 adapter 由各 adapter 测试覆盖）。 */
function stubAdapter(over: { label: string; clientProtocols?: string[] }): HarnessAdapter {
  return { id: 'stub', label: over.label, clientProtocols: over.clientProtocols } as unknown as HarnessAdapter
}

function openaiOnly(over: Partial<ProviderConfig> = {}): ProviderConfig {
  return { name: 'BigModel-130', base_url: 'https://open.bigmodel.cn/api/paas/v4', protocol: 'openai', auth_style: 'bearer', ...over }
}

const claudeCode = stubAdapter({ label: 'Claude Code', clientProtocols: ['anthropic'] })
const zcode = stubAdapter({ label: 'ZCode' }) // 多协议（anthropic/openai/responses 自适应）：未声明 = 不校验

describe('pinProtocolConflict（钉路由协议兼容校验器）', () => {
  it('单协议客户端 × 无该协议端点的服务 → 冲突，文案点名客户端/服务/协议并给两条修复路径', () => {
    const msg = pinProtocolConflict(claudeCode, openaiOnly(), 'bigmodel')
    expect(msg).toBeTruthy()
    expect(msg!).toContain('Claude Code')
    expect(msg!).toContain('BigModel-130')
    expect(msg!).toContain('anthropic')
  })

  it('补了 endpoints.anthropic 的多协议服务 → 通过（同 relay.upstreamEndpoint 口径）', () => {
    expect(pinProtocolConflict(claudeCode, openaiOnly({ endpoints: { anthropic: 'https://open.bigmodel.cn/api/anthropic' } }))).toBeUndefined()
  })

  it('provider 自身就是 anthropic 协议 → 通过', () => {
    expect(pinProtocolConflict(claudeCode, openaiOnly({ name: 'Anthro', base_url: 'https://a.example.com', protocol: 'anthropic' }))).toBeUndefined()
  })

  it('多协议客户端未声明 clientProtocols → 放行不校验（宁漏检不误拦）', () => {
    expect(pinProtocolConflict(zcode, openaiOnly())).toBeUndefined()
  })
})

describe('pinRouteProtocolError（ops 包装：adapter 查找 + 服务解析）', () => {
  const cfg = {
    providers: { bigmodel: openaiOnly() },
    profiles: {},
    harness: {},
  } as unknown as Config

  it('claude-code × openai-only 服务 → 冲突文案', async () => {
    const h = fakeHome()
    try {
      const msg = await pinRouteProtocolError('claude-code', 'bigmodel', cfg)
      expect(msg).toContain('BigModel-130')
    } finally {
      h.restore()
    }
  })

  it('zcode（多协议未声明）× openai-only 服务 → 放行；服务不存在 → 放行', async () => {
    const h = fakeHome()
    try {
      expect(await pinRouteProtocolError('zcode', 'bigmodel', cfg)).toBeUndefined()
      expect(await pinRouteProtocolError('claude-code', 'no-such-svc', cfg)).toBeUndefined()
    } finally {
      h.restore()
    }
  })
})

describe('planAttach 显式 profile 的协议校验', () => {
  const cfg = {
    version: 1,
    active_profile: 'ok-profile',
    security: { store: 'file' },
    providers: {
      bigmodel: openaiOnly(),
      anthro: { name: 'Anthro', base_url: 'https://a.example.com', protocol: 'anthropic', auth_style: 'bearer', key_ref: 'file:k' },
    },
    profiles: {
      'p-openai': { provider: 'bigmodel', default_model: 'glm-4.5-air' },
      'ok-profile': { provider: 'anthro', default_model: 'm' },
    },
    harness: {},
  } as unknown as Config

  it('显式钉定 openai-only profile → AdapterError（写入前拒绝）', async () => {
    const h = fakeHome()
    try {
      const err = await planAttach('claude-code', { profile: 'p-openai', gatewayPort: 18999 }, cfg).then(
        () => null,
        (e) => e,
      )
      expect(err).toBeInstanceOf(AdapterError)
      expect((err as AdapterError).message).toContain('BigModel-130')
    } finally {
      h.restore()
    }
  })

  it('跟随全局（不显式 profile）不查——全局路由动态变化，混合客户端靠改发兜底', async () => {
    const h = fakeHome()
    // planAttach 要求 claude 命令在场（CI 机器没装）：注入「已安装」，与宿主机解耦（见 presence.ts fakePresence）
    process.env.MODELRDOCK_FAKE_CLAUDE_CODE_PRESENT = '1'
    try {
      const plan = await planAttach('claude-code', { gatewayPort: 18999 }, cfg)
      expect(plan.plan).toBeTruthy()
    } finally {
      delete process.env.MODELRDOCK_FAKE_CLAUDE_CODE_PRESENT
      h.restore()
    }
  })
})
