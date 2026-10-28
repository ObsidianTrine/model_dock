// 任务等级（tier）→ 凭据/模型：解析规则、目录校验、端到端事件留痕。
// tiers.mjs 纯函数直测 + mkRepo/mock 后端闭环（凭据走环境变量，token 不入库）。

import { describe, expect, it } from 'vitest'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadWorkflowConfig } from '../../.agents/scripts/workflow-config.mjs'
import { validateCard } from '../../.agents/scripts/orchestrator/queue.mjs'
import { resolveTier, tierEnvPatch, validateTierModel } from '../../.agents/scripts/orchestrator/tiers.mjs'
import { writeWorkerSettings } from '../../.agents/scripts/orchestrator/backends/claude-headless.mjs'
import { cardText, mkRepo, runOrch, eventsOf } from './helpers.js'

const CFG = {
  tiers: {
    heavy: { tokenEnv: 'T_HEAVY', workerModel: 'flagship-x', reviewModel: 'judge-x', provider: 'ark', gatewayBase: 'http://127.0.0.1:1' },
    light: { tokenEnv: 'T_LIGHT' },
  },
  corePaths: ['src/gateway/server.ts'],
  releasePaths: [],
}

describe('tiers > resolveTier', () => {
  it('未配置 tiers / 无卡 tier 且不命中核心路径 → null（静默默认路由）', () => {
    expect(resolveTier({}, { tiers: {}, corePaths: [] })).toBeNull()
    expect(resolveTier({ files_hint: ['docs/a.md'] }, CFG)).toBeNull()
  })

  it('显式点名 + token 就位 → 全量生效；模型/服务字段透传', () => {
    const t = resolveTier({ tier: 'heavy' }, CFG, { T_HEAVY: 'tok-1' })
    expect(t).toMatchObject({ name: 'heavy', token: 'tok-1', tokenEnv: 'T_HEAVY', workerModel: 'flagship-x', reviewModel: 'judge-x', provider: 'ark', auto: false })
  })

  it('显式点名但键未配置 / token 环境变量未设 → inactive（不抛错，调用方决定告警口径）', () => {
    expect(resolveTier({ tier: 'nope' }, CFG, {})).toMatchObject({ inactive: 'unconfigured', name: 'nope' })
    expect(resolveTier({ tier: 'heavy' }, CFG, {})).toMatchObject({ inactive: 'token', name: 'heavy', tokenEnv: 'T_HEAVY' })
  })

  it('自动升级：files_hint 命中 corePaths → heavy/auto；未命中不升级；token 未设仍标 inactive', () => {
    const hit = resolveTier({ files_hint: ['src/gateway/other.ts'] }, CFG, { T_HEAVY: 'tok' })
    expect(hit).toMatchObject({ name: 'heavy', auto: true, token: 'tok' })
    expect(resolveTier({ files_hint: ['docs/a.md'] }, CFG, { T_HEAVY: 'tok' })).toBeNull()
    expect(resolveTier({ files_hint: ['src/gateway/other.ts'] }, CFG, {})).toMatchObject({ inactive: 'token', auto: true })
  })
})

describe('tiers > tierEnvPatch', () => {
  it('有 token 注入 ANTHROPIC_AUTH_TOKEN；无 token / 无 tier → 空（不覆盖子进程环境）', () => {
    expect(tierEnvPatch({ token: 't' })).toEqual({ ANTHROPIC_AUTH_TOKEN: 't' })
    expect(tierEnvPatch({ inactive: 'token' })).toEqual({})
    expect(tierEnvPatch(null)).toEqual({})
  })
})

describe('tiers > 目录校验 validateTierModel', () => {
  const catalog = JSON.stringify({ data: [{ id: 'flagship-x' }, { id: 'b-model' }] })

  function serve(status: number, body: string): Promise<{ url: string; close: () => void }> {
    return new Promise((resolve) => {
      const s = http.createServer((req, res) => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(body)
      })
      s.listen(0, '127.0.0.1', () => {
        const { port } = s.address() as { port: number }
        resolve({ url: `http://127.0.0.1:${port}`, close: () => s.close() })
      })
    })
  }

  it('模型在目录内 → ok；不在 → missing 列出', async () => {
    const s = await serve(200, catalog)
    try {
      expect(await validateTierModel({ gatewayBase: s.url, token: 't', provider: 'ark', models: ['flagship-x'] })).toEqual({ ok: true, missing: [] })
      const miss = await validateTierModel({ gatewayBase: s.url, token: 't', provider: 'ark', models: ['flagship-x', 'ghost-1'] })
      expect(miss.ok).toBe(false)
      expect((miss as { missing: string[] }).missing).toEqual(['ghost-1'])
    } finally {
      s.close()
    }
  })

  it('非 200 / 端口不通 / 未配 gatewayBase → ok:false 可告警，不抛异常', async () => {
    const s = await serve(404, '{}')
    try {
      expect((await validateTierModel({ gatewayBase: s.url, token: 't', provider: 'nope', models: ['m'] })).ok).toBe(false)
    } finally {
      s.close()
    }
    expect((await validateTierModel({ gatewayBase: 'http://127.0.0.1:1', token: 't', provider: 'ark', models: ['m'] })).ok).toBe(false)
    expect((await validateTierModel({ gatewayBase: null as unknown as string, token: 't', provider: 'ark', models: ['m'] })).ok).toBe(false)
    // 无模型可查 → 直接通过（不发起请求）
    expect(await validateTierModel({ gatewayBase: null as unknown as string, token: 't', provider: 'ark', models: [] })).toEqual({ ok: true, missing: [] })
  })
})

describe('tiers > 配置解析与卡校验', () => {
  it('workflow.json tiers 解析：合法保留、坏形状丢弃、缺省空表', () => {
    const repo = mkRepo()
    try {
      const p = path.join(repo.root, '.agents', 'workflow.json')
      fs.writeFileSync(p, JSON.stringify({ baseBranch: 'develop', testCmd: 'x', tiers: { heavy: { tokenEnv: 'T' }, bad: 'nope', 'Bad-Key': {} } }))
      const cfg = loadWorkflowConfig(repo.root)
      expect(cfg.tiers.heavy).toMatchObject({ tokenEnv: 'T' })
      expect(Object.keys(cfg.tiers)).toEqual(['heavy'])
      fs.writeFileSync(p, JSON.stringify({ baseBranch: 'develop', testCmd: 'x' }))
      expect(loadWorkflowConfig(repo.root).tiers).toEqual({})
    } finally {
      repo.cleanup()
    }
  })

  it('任务卡 tier：合法通过；非法形状 fail-fast', () => {
    expect(validateCard({ ...cardBase(), tier: 'heavy' }).tier).toBe('heavy')
    for (const bad of ['Heavy', 'a b', '']) {
      expect(() => validateCard({ ...cardBase(), tier: bad })).toThrow(/tier/)
    }
  })

  function cardBase() {
    return {
      id: 't-tier',
      type: 'bugfix',
      files_hint: ['a.txt'],
      workflows: ['feature-branch'],
      budget: { max_turns: 1, max_tokens: 1000, max_wall_minutes: 1, max_test_iterations: 1, max_review_iterations: 1 },
    }
  }
})

describe('tiers > settings 注入', () => {
  it('writeWorkerSettings 带 envPatch 时写入 settings.env；不带保持仅 hooks', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tier-set-'))
    try {
      const withEnv = JSON.parse(fs.readFileSync(writeWorkerSettings(path.join(dir, 'a.json'), { ANTHROPIC_AUTH_TOKEN: 'tok' }), 'utf8'))
      expect(withEnv.env).toEqual({ ANTHROPIC_AUTH_TOKEN: 'tok' })
      expect(withEnv.hooks.PreToolUse).toBeTruthy()
      const plain = JSON.parse(fs.readFileSync(writeWorkerSettings(path.join(dir, 'b.json')), 'utf8'))
      expect(plain.env).toBeUndefined()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('tiers > run 端到端（mock）', () => {
  it('显式 tier：token 注入生效，tier_resolved / worker_spawned 留痕 tier 模型', () => {
    const repo = mkRepo()
    try {
      fs.writeFileSync(
        path.join(repo.root, '.agents', 'workflow.json'),
        JSON.stringify({
          baseBranch: 'develop',
          testCmd: 'node -e "process.exit(0)"',
          tiers: { heavy: { tokenEnv: 'MDK_TEST_TIER_TOKEN', workerModel: 'flagship-x' } },
        }),
      )
      const cardFile = path.join(repo.root, 'c.md')
      fs.writeFileSync(cardFile, cardText({ tier: 'heavy' }))
      runOrch(repo.root, `submit "${cardFile}"`)
      runOrch(repo.root, 'run test-task --backend mock', { MDK_TEST_TIER_TOKEN: 'tok-e2e' })
      const ev = eventsOf(repo.root, 'test-task')
      const resolved = ev.find((e) => e.type === 'tier_resolved') as Record<string, unknown> | undefined
      expect(resolved).toMatchObject({ tier: 'heavy', worker_model: 'flagship-x' })
      const spawned = ev.find((e) => e.type === 'worker_spawned') as Record<string, unknown> | undefined
      expect(spawned?.model).toBe('flagship-x')
    } finally {
      repo.cleanup()
    }
  }, 120_000)

  it('显式 tier 未配置 → 告警降级不阻断；tier_resolved 记 inactive', () => {
    const repo = mkRepo()
    try {
      fs.writeFileSync(
        path.join(repo.root, '.agents', 'workflow.json'),
        JSON.stringify({
          baseBranch: 'develop',
          testCmd: 'node -e "process.exit(0)"',
          tiers: { heavy: { tokenEnv: 'MDK_TEST_TIER_TOKEN' }, light: { tokenEnv: 'MDK_TEST_TIER_LIGHT_TOKEN' } },
        }),
      )
      // 卡点名 light，token 环境变量未设 → inactive: token
      const cardFile = path.join(repo.root, 'c.md')
      fs.writeFileSync(cardFile, cardText({ tier: 'light' }))
      runOrch(repo.root, `submit "${cardFile}"`)
      const out = runOrch(repo.root, 'run test-task --backend mock', {})
      expect(out.stdout).toContain('tier "light" 未生效')
      expect(out.stdout).toContain('MDK_TEST_TIER_LIGHT_TOKEN')
      const resolved = eventsOf(repo.root, 'test-task').find((e) => e.type === 'tier_resolved') as Record<string, unknown> | undefined
      expect(resolved).toMatchObject({ tier: 'light', inactive: 'token' })
    } finally {
      repo.cleanup()
    }
  }, 120_000)
})
