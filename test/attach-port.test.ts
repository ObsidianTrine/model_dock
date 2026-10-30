// 回归测试：写客户端文件的目标端口解析（docs 无、2026-10-01 用户实测 bug）。
// 现场：生产 + dev 双实例（本测试用 28687/28890 非保留端口替身）共用单一网关状态文件，
// dev 后启动劫持状态；旧代码 planAttach/refreshBakedModelClients 采信状态文件，把真实
// 客户端文件重写到 dev 端口（生产控制台接入后 detail 恒为 dev 端口）。
// 修复：实例侧操作显式传 rt.port；CLI 启发式改为生产默认端口优先。

import { describe, expect, it, afterEach } from 'vitest'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { fakeHome } from './helpers.js'
import { writeGatewayState } from '../src/gateway/state.js'
import { planAttach, refreshBakedModelClients } from '../src/ops.js'
import { saveConfig } from '../src/config/store.js'
import type { Config } from '../src/config/types.js'
import { gatewayBase } from '../src/adapters/types.js'

const TOKEN = 'mdk_claude_code_test_token_123'

afterEach(() => {
  delete process.env.MODELRDOCK_FAKE_CLAUDE_CODE_PRESENT
})

function baseCfg(): Config {
  return {
    version: 1,
    active_profile: 'demo',
    security: { store: 'file' },
    providers: {
      up: {
        name: 'mock',
        base_url: 'http://127.0.0.1:1',
        protocol: 'anthropic',
        auth_style: 'bearer',
        key_ref: 'sk-upstream-secret',
        models: { 'preset-model': { source: 'preset', context_window: 1000, max_output: 100 } },
      },
    },
    profiles: { demo: { provider: 'up', default_model: 'preset-model' } },
    harness: { 'claude-code': { mode: 'gateway', route: 'default', token: TOKEN } },
  }
}

/** 起一个 health 端点应答的假网关（随机端口），并把状态文件写成它——
 *  gatewayLive() 会据此返回该端口，精确复现"dev 实例后启动劫持状态文件"。 */
function startFakeGateway(): Promise<{ port: number; close: () => void }> {
  const server = http.createServer((req, res) => {
    if (req.url === '/_modeldock/health') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
      return
    }
    res.writeHead(404)
    res.end()
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port
      resolve({ port, close: () => server.close() })
    })
  })
}

async function hijackStateWithFakeGateway(): Promise<{ port: number; close: () => void }> {
  const fake = await startFakeGateway()
  await writeGatewayState({ pid: process.pid, port: fake.port, admin_token: 'x', started_at: new Date().toISOString() })
  return fake
}

describe('客户端写入端口解析 > 显式端口压过被劫持的状态文件', () => {
  it('planAttach 带 gatewayPort → 计划写显式端口，无视状态文件里的另一实例', async () => {
    const h = fakeHome()
    const fake = await hijackStateWithFakeGateway()
    process.env.MODELRDOCK_FAKE_CLAUDE_CODE_PRESENT = '1'
    try {
      await saveConfig(baseCfg())
      const plan = await planAttach('claude-code', { gatewayPort: 28687 })
      expect(plan.port).toBe(28687)
      expect(JSON.stringify(plan.plan.changes)).toContain(gatewayBase(28687))
      expect(JSON.stringify(plan.plan.changes)).not.toContain(gatewayBase(fake.port))
    } finally {
      fake.close()
      h.restore()
    }
  })

  it('不带 gatewayPort（CLI 启发式）→ 沙箱不探测生产端口，按状态文件', async () => {
    const h = fakeHome()
    const fake = await hijackStateWithFakeGateway()
    process.env.MODELRDOCK_FAKE_CLAUDE_CODE_PRESENT = '1'
    try {
      await saveConfig(baseCfg())
      // 2026-10 复审收口：沙箱（FAKE_HOME）是「独立机器」，不探测生产默认端口——
      // 沙箱内的 harness token 生产网关并不认识，把客户端文件指到生产默认端口只会 401。
      // 即使真机生产默认端口存活也按状态文件（沙箱自己的）端口走；生产机器上的「生产默认
      // 端口存活优先」启发式仅非沙箱路径生效，测试无法安全覆盖（绝不监听生产端口）
      const plan = await planAttach('claude-code', {})
      expect(plan.port).toBe(fake.port)
    } finally {
      fake.close()
      h.restore()
    }
  })
})

describe('客户端写入端口解析 > 全局切换重写烙模型客户端', () => {
  it('refreshBakedModelClients({ port }) 重写 zcode 用显式端口，不吃状态文件', async () => {
    const h = fakeHome()
    const fake = await hijackStateWithFakeGateway()
    process.env.MODELRDOCK_FAKE_ZCODE_PRESENT = '1'
    // claude-code 现已纳入烙模型客户端（modelPicker），baseCfg 里有它的接入登记：
    // presence 需一并放行，否则刷新会以「未安装」告警污染 warnings
    process.env.MODELRDOCK_FAKE_CLAUDE_CODE_PRESENT = '1'
    try {
      const cfg = baseCfg()
      cfg.harness['zcode'] = { mode: 'gateway', route: 'default', token: 'mdk_zcode_t' }
      await saveConfig(cfg)

      const r = await refreshBakedModelClients({ port: 28687 })
      expect(r.warnings).toEqual([])
      expect(r.refreshed).toContain('zcode')

      const pp = path.join(h.home, '.zcode', 'v2', 'provider_config.json')
      const text = fs.readFileSync(pp, 'utf8')
      expect(text).toContain(gatewayBase(28687))
      expect(text).not.toContain(gatewayBase(fake.port))
    } finally {
      fake.close()
      h.restore()
    }
  })
})
