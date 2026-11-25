// switchHarnessMode direct 的取密钥口径（审计 F2 回归）：取密钥必须走 keys 池感知
// （getFirstProviderSecret 同口径）——旧实现只读 key_ref，池 provider 切直连会拿池外
// 旧密钥（key_ref 残留条目）或对池 provider 误报「Key 不可读」。

import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import { fakeHome } from './helpers.js'
import { loadConfig, saveConfig } from '../src/config/store.js'
import { setSecret } from '../src/config/secrets.js'
import { emptyConfig, type Config } from '../src/config/types.js'
import { applyAttach, setAutoRoute, switchHarnessMode, switchToServiceWithRoute } from '../src/ops.js'

/** 池 provider：keys 池两把（首把不落盘模拟不可读），key_ref 另指向一把仍可读的旧密钥——
 *  池存在时 key_ref 不参与转发（providerKeyRefs 池优先），切直连同理不得漏出旧密钥 */
function poolCfg(): Config {
  return {
    ...emptyConfig(),
    active_profile: 'demo',
    security: { store: 'file' },
    providers: {
      up: {
        name: 'mock',
        base_url: 'http://127.0.0.1:1',
        protocol: 'anthropic',
        auth_style: 'bearer',
        key_ref: 'file:stale',
        keys: ['file:gone', 'file:live'],
        models: { 'preset-model': { source: 'preset', context_window: 1000, max_output: 100 } },
      },
    },
    profiles: { demo: { provider: 'up', default_model: 'preset-model' } },
    harness: {},
  }
}

/** 单 key provider（无池）：既有语义钉子——切直连仍按 key_ref 取密钥 */
function singleCfg(): Config {
  const cfg = poolCfg()
  const p = cfg.providers.up!
  delete (p as { keys?: string[] }).keys
  p.key_ref = 'file:up'
  return cfg
}

describe('switchHarnessMode direct 取密钥：keys 池感知（审计 F2）', () => {
  it('池 provider 切直连取池内首把可读 key，key_ref 残留旧密钥不得漏出', async () => {
    const h = fakeHome()
    try {
      await saveConfig(poolCfg())
      await setSecret('stale', 'sk-stale-ref', 'file') // key_ref 指向的旧密钥仍可读——修复前会被误写进客户端
      // 池首把（file:gone）故意不落盘 → 单独读必失败，池内第二把才是答案
      await setSecret('live', 'sk-pool-live', 'file')
      process.env.MODELRDOCK_FAKE_CLAUDE_CODE_PRESENT = '1'
      await applyAttach('claude-code', {}) // 先网关接入（切换要求 harness 已在册）
      const r = await switchHarnessMode('claude-code', 'direct', { yes: true })
      expect(r.mode).toBe('direct')
      const direct = fs.readFileSync(r.files[0]!, 'utf8')
      expect(direct).toContain('sk-pool-live') // 池内可读 key 写入客户端
      expect(direct).not.toContain('sk-stale-ref') // 池外旧密钥不得漏出
      expect(direct).not.toContain('mdk_') // 不再携带网关 token
    } finally {
      delete process.env.MODELRDOCK_FAKE_CLAUDE_CODE_PRESENT
      h.restore()
    }
  })

  it('池全部不可读：报错口径指向 keys 池（不再冒充 key_ref）', async () => {
    const h = fakeHome()
    try {
      await saveConfig(poolCfg()) // file:gone / file:live 均不落盘 → 池全不可读
      process.env.MODELRDOCK_FAKE_CLAUDE_CODE_PRESENT = '1'
      await applyAttach('claude-code', {})
      await expect(switchHarnessMode('claude-code', 'direct', { yes: true })).rejects.toThrow(/keys 池 2 把全部不可读/)
    } finally {
      delete process.env.MODELRDOCK_FAKE_CLAUDE_CODE_PRESENT
      h.restore()
    }
  })

  it('单 key provider（无池）切直连仍按 key_ref 取密钥（既有语义不回归）', async () => {
    const h = fakeHome()
    try {
      await saveConfig(singleCfg())
      await setSecret('up', 'sk-single', 'file')
      process.env.MODELRDOCK_FAKE_CLAUDE_CODE_PRESENT = '1'
      await applyAttach('claude-code', {})
      const r = await switchHarnessMode('claude-code', 'direct', { yes: true })
      const direct = fs.readFileSync(r.files[0]!, 'utf8')
      expect(direct).toContain('sk-single')
    } finally {
      delete process.env.MODELRDOCK_FAKE_CLAUDE_CODE_PRESENT
      h.restore()
    }
  })
})

/** 两服务配置：盘上 auto_failover 由 seed 决定，供「陈旧内存快照不得回写」用例使用 */
function routeCfg(autoFailover: boolean): Config {
  return {
    ...emptyConfig(),
    active_profile: 'main',
    security: { store: 'file' },
    gateway: { auto_failover: autoFailover },
    providers: {
      p1: { name: 'one', base_url: 'http://127.0.0.1:1', protocol: 'anthropic', auth_style: 'bearer', key_ref: 'file:k1', models: { m: { source: 'preset', context_window: 1000, max_output: 100 } } },
      p2: { name: 'two', base_url: 'http://127.0.0.1:2', protocol: 'anthropic', auth_style: 'bearer', key_ref: 'file:k2', models: { m: { source: 'preset', context_window: 1000, max_output: 100 } } },
    },
    profiles: { main: { provider: 'p1', default_model: 'm' } },
    harness: {},
  }
}

describe('路由写回：「保持现状」取盘上现值而不是调用方内存快照（审计 P-04）', () => {
  it('switchToServiceWithRoute 不传 autoFailover：盘上 auto_failover=true 不被内存里的 false 覆盖', async () => {
    const h = fakeHome()
    try {
      await saveConfig(routeCfg(true))
      // 模拟网关 rt.config 陈旧：调用方不再把内存快照传进来（undefined = 保持盘上现值）
      await switchToServiceWithRoute('p2', undefined)
      const after = await loadConfig()
      expect(after.gateway?.auto_failover).toBe(true)
      expect(after.gateway?.auto_route_provider).toBe('p2')
      expect(after.active_profile).toBe('auto-p2')
    } finally {
      h.restore()
    }
  })

  it('setAutoRoute enabled 缺省：盘上 auto_failover=true 保持，返回 resolved 值', async () => {
    const h = fakeHome()
    try {
      await saveConfig(routeCfg(true))
      const r = await setAutoRoute(undefined, 'p2')
      expect(r.enabled).toBe(true)
      expect((await loadConfig()).gateway?.auto_failover).toBe(true)
    } finally {
      h.restore()
    }
  })

  it('setAutoRoute 显式 false 仍可关闭；盘上无该字段时缺省解析为 false（原行为兼容）', async () => {
    const h = fakeHome()
    try {
      await saveConfig(routeCfg(true))
      const off = await setAutoRoute(false)
      expect(off.enabled).toBe(false)
      expect((await loadConfig()).gateway?.auto_failover).toBe(false)
      const cfg = routeCfg(true)
      delete cfg.gateway
      await saveConfig(cfg)
      expect((await setAutoRoute(undefined)).enabled).toBe(false)
    } finally {
      h.restore()
    }
  })
})
