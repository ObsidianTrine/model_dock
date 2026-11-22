// 双 critic 并行审查 e2e（orch-dual-critic-review 卡，2026-11-20）：高风险卡（改动实际
// 命中 corePaths/releasePaths）两只异模型 reviewer 并行出 verdict，blockers 取并集去重；
// 单侧失败降级 / 双失败走既有失败路径 / 普通卡与 enabled=false 维持单 critic。
// 全程 mock（零外部调用、秒级）；副 critic 由 spawn 的 model 参数 + ORCH_MOCK_REVIEW_SECOND_MODEL
// 匹配注入（同进程并行 spawn，env 无法按次注入）。
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { classifyChange, hitsCoreOrRelease } from '../../.agents/scripts/policy.mjs'
import { loadWorkflowConfig } from '../../.agents/scripts/workflow-config.mjs'
import { cardText, eventsOf, mkRepo, readCard, runOrch, tryOrch } from './helpers.js'

function submitCard(repo: string, id: string, overrides: Record<string, unknown> = {}) {
  const cardFile = path.join(repo, `card-${id}.md`)
  fs.writeFileSync(cardFile, cardText({ id, ...overrides }))
  runOrch(repo, `submit "${cardFile}"`)
}

/** 副 critic 会话数（worker_spawned 且 role=reviewer）：显式 role 契约（SPAWN_ROLES）计数。 */
function reviewerSpawns(repo: string, id: string): Array<Record<string, unknown>> {
  return eventsOf(repo, id).filter((e) => e.type === 'worker_spawned' && e.role === 'reviewer')
}

describe('orchestrator 双 critic 并行审查 > 高风险卡（corePaths 命中）', () => {
  it('两只 critic 均跑（role=reviewer 两次 spawn）；blockers 并集去重（2+2 去同条 1 → 3）', () => {
    const repo = mkRepo({ extra: { corePaths: ['src/feat.ts'], worker: { model: 'critic-b' } } })
    try {
      submitCard(repo.root, 'dual-union', { files_hint: ['src/**'] })
      // 主 critic 2 条阻塞（第 1/2 条），副 critic 2 条（首条复刻主 critic 第 1 条 + 独立 1 条）
      // → 并集 = { 第1条, 第2条, 独立1 } = 3，去重 1：非和（4）非 max（2），证明真去重
      // --pilot-approved：files_hint src/** 与 corePaths 重叠触发 B3 引水闸（与本卡无关，放行开航）
      const r = tryOrch(repo.root, 'run dual-union --pilot-approved --backend mock', {
        ORCH_MOCK_FILE: 'src/feat.ts',
        ORCH_MOCK_REVIEW_BLOCKERS: '2',
        ORCH_MOCK_REVIEW_SECOND_MODEL: 'critic-b',
        ORCH_MOCK_REVIEW_SECOND_BLOCKERS: '2',
      })
      expect(r.status).toBe(1) // 并集 > 0 反复返工烧满 → 熔断 die（既有失败路径）
      const events = eventsOf(repo.root, 'dual-union')
      const types = events.map((e) => e.type)
      // 双 spawn 断言：显式 role 契约 reviewer 至少两次（首轮两只并行）
      const spawns = reviewerSpawns(repo.root, 'dual-union')
      expect(spawns.length).toBeGreaterThanOrEqual(2)
      expect(spawns[0]).toMatchObject({ role: 'reviewer', backend: 'mock' })
      expect(spawns[1]).toMatchObject({ role: 'reviewer', backend: 'mock' })
      // review_spawned 双份：主 critic 无标记，副 critic 带 critic + model
      const spawnedSecond = events.find((e) => e.type === 'review_spawned' && e.critic === 'second')
      expect(spawnedSecond).toMatchObject({ backend: 'mock', critic: 'second', model: 'critic-b' })
      // 两条 review_verdict 留痕（second 标记）+ 并集字段
      const verdicts = events.filter((e) => e.type === 'review_verdict')
      const firstVerdict = verdicts.find((e) => e.critic === undefined)
      expect(firstVerdict).toMatchObject({ blockers: 2 })
      const secondVerdict = verdicts.find((e) => e.critic === 'second')
      expect(secondVerdict).toMatchObject({ blockers: 2, model: 'critic-b', union_blockers: 3, union_deduped: 1, union_mode: 'deduped' })
      // 并集 > 0 走既有裁决链：返工轮 + 熔断落 blocked
      expect(types).toContain('review_iteration')
      expect(events.find((e) => e.type === 'circuit_breaker')).toMatchObject({ reason: 'max_review_iterations' })
      expect(readCard(repo.root, 'blocked', 'dual-union')).toBeTruthy()
      expect(types).not.toContain('review_critic_degraded') // 双双正常，无降级
    } finally {
      repo.cleanup()
    }
  })

  it('releasePaths 命中同样触发（L3 发布面）：双 critic 均跑，全绿照常落人工闸门', () => {
    const repo = mkRepo({ extra: { releasePaths: ['.github/workflows/'], worker: { model: 'critic-b' } } })
    try {
      submitCard(repo.root, 'dual-l3')
      runOrch(repo.root, 'run dual-l3 --backend mock', {
        ORCH_MOCK_FILE: '.github/workflows/ci.yml',
        ORCH_MOCK_REVIEW_SECOND_MODEL: 'critic-b',
      })
      const events = eventsOf(repo.root, 'dual-l3')
      expect(reviewerSpawns(repo.root, 'dual-l3').length).toBe(2)
      expect(events.find((e) => e.type === 'review_spawned' && e.critic === 'second')).toBeTruthy()
      const verdicts = events.filter((e) => e.type === 'review_verdict')
      expect(verdicts.length).toBe(2)
      expect(verdicts.find((e) => e.critic === 'second')).toMatchObject({ blockers: 0 })
      expect(readCard(repo.root, 'awaiting-human', 'dual-l3')).toBeTruthy()
    } finally {
      repo.cleanup()
    }
  })
})

describe('orchestrator 双 critic 并行审查 > 单 critic 维持（普通卡 / enabled=false）', () => {
  it('普通 L1 卡（未命中 corePaths）仍单 critic：一次 spawn、一条 verdict', () => {
    const repo = mkRepo()
    try {
      submitCard(repo.root, 'single-l1', { gate: 'L3', files_hint: ['src/**'] })
      runOrch(repo.root, 'run single-l1 --backend mock', { ORCH_MOCK_FILE: 'src/feat.ts' })
      const events = eventsOf(repo.root, 'single-l1')
      expect(reviewerSpawns(repo.root, 'single-l1').length).toBe(1)
      expect(events.filter((e) => e.type === 'review_spawned').length).toBe(1)
      const verdicts = events.filter((e) => e.type === 'review_verdict')
      expect(verdicts.length).toBe(1)
      expect(verdicts[0]).toMatchObject({ blockers: 0 })
      expect(verdicts[0].critic).toBeUndefined()
      expect(events.map((e) => e.type)).not.toContain('review_critic_degraded')
      expect(readCard(repo.root, 'awaiting-human', 'single-l1')).toBeTruthy()
    } finally {
      repo.cleanup()
    }
  })

  it('高风险卡 + review.dualCritic.enabled=false：escape hatch 关闭回单 critic', () => {
    const repo = mkRepo({ extra: { corePaths: ['src/feat.ts'], review: { dualCritic: { enabled: false } } } })
    try {
      submitCard(repo.root, 'dual-off')
      runOrch(repo.root, 'run dual-off --backend mock', { ORCH_MOCK_FILE: 'src/feat.ts' })
      const events = eventsOf(repo.root, 'dual-off')
      expect(reviewerSpawns(repo.root, 'dual-off').length).toBe(1)
      expect(events.filter((e) => e.type === 'review_spawned').length).toBe(1)
      expect(events.filter((e) => e.type === 'review_verdict').length).toBe(1)
      expect(events.find((e) => e.type === 'review_spawned' && e.critic === 'second')).toBeFalsy()
      expect(readCard(repo.root, 'awaiting-human', 'dual-off')).toBeTruthy()
    } finally {
      repo.cleanup()
    }
  })
})

describe('orchestrator 双 critic 并行审查 > 失败降级语义', () => {
  it('副 critic 引擎故障 → 降级用主 critic 结果（不丢审查），review_critic_degraded 留痕', () => {
    const repo = mkRepo({ extra: { corePaths: ['src/feat.ts'], worker: { model: 'critic-b' } } })
    try {
      submitCard(repo.root, 'dual-degrade')
      runOrch(repo.root, 'run dual-degrade --backend mock', {
        ORCH_MOCK_FILE: 'src/feat.ts',
        ORCH_MOCK_REVIEW_SECOND_MODEL: 'critic-b',
        ORCH_MOCK_REVIEW_SECOND_FAIL: '1',
      })
      const events = eventsOf(repo.root, 'dual-degrade')
      const types = events.map((e) => e.type)
      const degraded = events.find((e) => e.type === 'review_critic_degraded')
      expect(degraded).toMatchObject({ critic: 'second', reason: 'engine_exit', exit_code: 1 })
      // 只有主 critic 的 verdict（无 second 标记），审查结论没丢
      const verdicts = events.filter((e) => e.type === 'review_verdict')
      expect(verdicts.length).toBe(1)
      expect(verdicts[0]).toMatchObject({ blockers: 0 })
      expect(verdicts[0].critic).toBeUndefined()
      expect(types).not.toContain('review_engine_failed') // 单侧失败不算引擎故障
      expect(types).not.toContain('review_iteration') // 主 critic 全绿，不返工
      expect(readCard(repo.root, 'awaiting-human', 'dual-degrade')).toBeTruthy()
    } finally {
      repo.cleanup()
    }
  })

  it('双 critic 均引擎故障 → 走既有失败路径：review_engine_failed + blocked，无 verdict', () => {
    const repo = mkRepo({ extra: { corePaths: ['src/feat.ts'], worker: { model: 'critic-b' } } })
    try {
      submitCard(repo.root, 'dual-dead')
      const r = tryOrch(repo.root, 'run dual-dead --backend mock', {
        ORCH_MOCK_FILE: 'src/feat.ts',
        ORCH_MOCK_REVIEW_FAIL: '1',
        ORCH_MOCK_REVIEW_SECOND_MODEL: 'critic-b',
        ORCH_MOCK_REVIEW_SECOND_FAIL: '1',
      })
      expect(r.status).toBe(1)
      expect(r.stderr).toContain('审查引擎故障')
      const events = eventsOf(repo.root, 'dual-dead')
      const types = events.map((e) => e.type)
      expect(events.find((e) => e.type === 'review_engine_failed')).toMatchObject({ backend: 'mock', dual: true })
      expect(types).not.toContain('review_verdict') // 引擎故障不算审查意见（与单 critic 同口径）
      expect(types).not.toContain('review_iteration') // 不烧返工轮
      expect(readCard(repo.root, 'blocked', 'dual-dead')).toBeTruthy()
    } finally {
      repo.cleanup()
    }
  })
})

describe('orchestrator 双 critic 并行审查 > 配置与分级同源单测', () => {
  it('resolveReview：dualCritic 缺省 enabled=true；boolean 简写 / secondModel 修剪 / 非法回落；空节维持 null', () => {
    const mk = (review: unknown): Record<string, unknown> => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dual-cfg-'))
      fs.mkdirSync(path.join(dir, '.agents'), { recursive: true })
      fs.writeFileSync(
        path.join(dir, '.agents', 'workflow.json'),
        JSON.stringify({ baseBranch: 'develop', testCmd: 'node -e "process.exit(0)"', review }),
      )
      try {
        return loadWorkflowConfig(dir) as unknown as Record<string, unknown>
      } finally {
        fs.rmSync(dir, { recursive: true, force: true })
      }
    }
    // 只配 backend：引擎键 shape 不变 + dualCritic 缺省开
    expect(mk({ backend: 'mock' })).toMatchObject({ review: { backend: 'mock', model: null, dualCritic: { enabled: true, secondModel: null } } })
    // boolean 简写关闭
    expect(mk({ backend: 'mock', dualCritic: false })).toMatchObject({ review: { dualCritic: { enabled: false } } })
    // 显式对象：secondModel 修剪空白
    expect(mk({ dualCritic: { enabled: false, secondModel: ' m2 ' } })).toMatchObject({ review: { dualCritic: { enabled: false, secondModel: 'm2' } } })
    // 非法值回落缺省（enabled=true 缺省口径）
    expect(mk({ backend: 'mock', dualCritic: 'garbage' })).toMatchObject({ review: { dualCritic: { enabled: true } } })
    // 空节维持 null（与历史零行为变化）
    expect(mk({})).toMatchObject({ review: null })
  })

  it('hitsCoreOrRelease 与 classifyChange 同源：core 精确相等 / release 前缀；保守归高不算命中', () => {
    const cfg = { corePaths: ['src/feat.ts'], releasePaths: ['.github/workflows/'] }
    expect(hitsCoreOrRelease(['src/feat.ts', 'docs/x.md'], cfg)).toEqual(['src/feat.ts'])
    expect(hitsCoreOrRelease(['.github/workflows/ci.yml'], cfg)).toEqual(['.github/workflows/ci.yml'])
    expect(hitsCoreOrRelease(['src/other.ts', 'package.json'], cfg)).toEqual([]) // 保守 L2 不算命中
    expect(hitsCoreOrRelease(['src\\feat.ts'], cfg)).toEqual(['src/feat.ts']) // Windows 分隔符归一
    // 分级非回归：core 命中 L2、release 命中 L3（匹配口径抽共享后行为不变）
    expect(classifyChange(['src/feat.ts'], cfg).level).toBe('L2')
    expect(classifyChange(['.github/workflows/ci.yml'], cfg).level).toBe('L3')
    expect(classifyChange(['package.json'], cfg).level).toBe('L2') // package.json 保守归高保留
  })
})
