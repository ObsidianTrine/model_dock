// nightly 测试：巡检编排端到端——scan 落卡 + drift 报告 + 摘要；默认零烧钱（不跑 worker）。
// 另覆盖幂等补跑（nightly-state）：中断恢复 + 双跑防护（Windows 强制重启后 nightly 静默缺失的防护）。

import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { listCards, queueRoot } from '../../.agents/scripts/orchestrator/queue.mjs'
import { readNightlyState, writeNightlyState } from '../../.agents/scripts/orchestrator/nightly-state.mjs'
import { mkRepo, runOrch, cardText, type TestRepo } from './helpers.js'

describe('orchestrator nightly > 巡检编排端到端', () => {
  it('TODO 信号出提案落 drafts + 漂移报告 + 摘要；无 --auto 不跑 worker（提案不进队列）', () => {
    const repo = mkRepo()
    try {
      const src = path.join(repo.root, 'src')
      fs.mkdirSync(src, { recursive: true })
      fs.writeFileSync(path.join(src, 'a.ts'), '// TODO: 待办事项\nexport {}\n')
      const out = runOrch(repo.root, 'nightly')
      expect(out.stdout).toContain('nightly 巡检')
      expect(out.stdout).toContain('已生成提案：drafts/scan-todo-')
      expect(out.stdout).toContain('质量漂移报告')
      expect(out.stdout).toContain('nightly 摘要')
      expect(out.stdout).toContain('待调度（pending）: 0')
      const pending = listCards(queueRoot(repo.root), 'pending')
      expect(pending).toHaveLength(0)
      const drafts = fs.readdirSync(path.join(repo.root, '.agents', 'orchestrator', 'drafts')).filter((f) => f.endsWith('.md'))
      expect(drafts).toHaveLength(1)
      // 提案是 scanner 产物：worker 未被拉起（无事件日志）
      expect(fs.existsSync(path.join(repo.root, '.agents', 'orchestrator', 'logs', drafts[0].replace(/\.md$/, '')))).toBe(false)
    } finally {
      repo.cleanup()
    }
  })

  // 串行跑 2 个 nightly 子进程（内部含 npm audit / git remote / gh 探测），可能超出两套 vitest
  // 配置共用的全局 20s（vitest.config.ts testTimeout，workflow 配置 spread 继承同值）——
  // 用例级第三参单独放宽到 60s，只覆盖本用例不动全局
  it('重复跑同夜去重（内容不变 → 同 id → 已存在跳过；同刻二跑须 --manual 绕过双跑防护）', () => {
    const repo = mkRepo()
    try {
      const src = path.join(repo.root, 'src')
      fs.mkdirSync(src, { recursive: true })
      fs.writeFileSync(path.join(src, 'a.ts'), '// TODO: 同一条\nexport {}\n')
      runOrch(repo.root, 'nightly')
      // 同刻第二次触发：调度器语境（非 TTY）被 20h 双跑防护跳过（见「幂等补跑」组）——
      // 人工语境（--manual）才重跑巡检，去重靠内容哈希
      const again = runOrch(repo.root, 'nightly --manual')
      expect(again.stdout).toContain('已存在，跳过')
      expect(listCards(queueRoot(repo.root), 'pending')).toHaveLength(0)
      expect(fs.readdirSync(path.join(repo.root, '.agents', 'orchestrator', 'drafts')).filter((f) => f.endsWith('.md'))).toHaveLength(1)
    } finally {
      repo.cleanup()
    }
  }, 60_000)

  it('无信号仓库：不落提案 + 空队列摘要（audit 无 lock 的容错警告属预期）', () => {
    const repo = mkRepo()
    try {
      const out = runOrch(repo.root, 'nightly')
      expect(out.stdout).not.toContain('已生成提案')
      expect(out.stdout).toContain('待调度（pending）: 0')
      expect(out.stdout).toContain('nightly 摘要')
    } finally {
      repo.cleanup()
    }
  })

  it('--plan：planner 需求综合（mock）出提案进 drafts，摘要含人工审阅指引', () => {
    const repo = mkRepo()
    try {
      const out = runOrch(repo.root, 'nightly --plan --backend mock')
      expect(out.stdout).toContain('nightly --plan → propose')
      const drafts = fs.readdirSync(path.join(repo.root, '.agents', 'orchestrator', 'drafts')).filter((f) => f.endsWith('.md'))
      expect(drafts.some((f) => f.startsWith('planner-'))).toBe(true)
      const proposal = fs.readFileSync(path.join(repo.root, '.agents', 'orchestrator', 'drafts', drafts.find((f) => f.startsWith('planner-'))), 'utf8')
      expect(proposal).toContain('proposal: true')
      expect(proposal).toContain('gate: L3')
      expect(out.stdout).toContain('批量 submit')
    } finally {
      repo.cleanup()
    }
  })
})

// ---------------------------------------------------------------------------
// 幂等补跑（nightly-state）：runOrch 的子进程 stdin 非 TTY = 调度器语境
// ---------------------------------------------------------------------------

describe('orchestrator nightly > 幂等补跑（中断恢复 + 双跑防护）', () => {
  it('距上次完成不足 20h 且非人工触发：跳过（exit 0、不巡检），--manual 强跑放行并落 finishedAt', () => {
    const repo = mkRepo()
    try {
      const H = 3_600_000
      writeNightlyState(repo.root, {
        startedAt: new Date(Date.now() - 2 * H).toISOString(),
        finishedAt: new Date(Date.now() - 1 * H).toISOString(),
        result: {},
      })
      const out = runOrch(repo.root, 'nightly')
      expect(out.stdout).toContain('nightly 跳过')
      expect(out.stdout).toContain('双跑')
      expect(out.stdout).not.toContain('nightly 巡检') // 未真正执行巡检
      expect(out.stdout).toContain('--manual') // 给出强跑指引
      // 状态未动：完成记录没有被改成「未收尾」（否则 20h 防护失明）
      const st = readNightlyState(repo.root)
      expect(st?.finishedAt).toBeTruthy()

      // --manual 显式人工触发：不受限，正常执行；但不参与调度器状态机——
      // manual 完成态若覆盖 finishedAt，当晚 02:30 调度触发会因「距上次完成
      // <20h 且非人工」被双跑防护误挡（2026-11-01 设计修正，见 cmdNightly）
      const m = runOrch(repo.root, 'nightly --manual')
      expect(m.stdout).toContain('nightly 巡检')
      expect(m.stdout).toContain('nightly 摘要')
      const st2 = readNightlyState(repo.root)
      expect(st2?.finishedAt).toBeTruthy() // 调度器自己的完成记录保持原样
      expect(st2?.startedAt).toBe(st?.startedAt) // 未被 manual 改写
    } finally {
      repo.cleanup()
    }
  })

  it('--manual 不写调度器 state（无先前 state 时跑完也不创建）', () => {
    const repo = mkRepo()
    try {
      const src = path.join(repo.root, 'src')
      fs.mkdirSync(src, { recursive: true })
      fs.writeFileSync(path.join(src, 'a.ts'), '// TODO: manual state 隔离\nexport {}\n')
      const out = runOrch(repo.root, 'nightly --manual')
      expect(out.stdout).toContain('nightly 摘要') // 巡检真跑了
      expect(readNightlyState(repo.root)).toBeNull() // 但不留调度器运行记录
    } finally {
      repo.cleanup()
    }
  })

  it('上次未收尾（finishedAt 缺失）：记 nightly_recovered + 照常执行接续', () => {
    const repo = mkRepo()
    try {
      const src = path.join(repo.root, 'src')
      fs.mkdirSync(src, { recursive: true })
      fs.writeFileSync(path.join(src, 'a.ts'), '// TODO: 中断恢复场景\nexport {}\n')
      writeNightlyState(repo.root, { startedAt: new Date(Date.now() - 3_600_000).toISOString(), finishedAt: null })
      const out = runOrch(repo.root, 'nightly')
      expect(out.stdout).toContain('nightly_recovered')
      expect(out.stdout).toContain('已生成提案') // 巡检照常执行
      const st = readNightlyState(repo.root)
      expect(st?.finishedAt).toBeTruthy() // 正常收尾落完成态
    } finally {
      repo.cleanup()
    }
  })
})

// ---------------------------------------------------------------------------
// --auto 选卡硬禁区（P2-15）：deps/feature/核心·发布路径提案 submit+run 后必被引水闸
// 打回 pending——白烧一次 run 启动。选卡阶段按 hardZoneReason（sail.mjs 单一口径）跳过；
// 普通 high 提案照常提交闭环。
// ---------------------------------------------------------------------------

/** 种一张 high 优先级提案进 drafts/（nightly --auto 的选卡候选）。
 *  created_at 缺省取 1 天前（相对真实 now）：老化自动档会把超龄（缺省 14 天）未提交
 *  机器提案在 --auto 选卡前清退——选卡候选必须是「新鲜」提案，写死日历日会随时间漂移
 *  撞上清退闸。 */
function seedDraft(repo: TestRepo, id: string, overrides: Record<string, unknown>): void {
  const dir = path.join(repo.root, '.agents', 'orchestrator', 'drafts')
  fs.mkdirSync(dir, { recursive: true })
  const fresh = overrides.created_at ?? new Date(Date.now() - 86_400_000).toISOString()
  fs.writeFileSync(path.join(dir, `${id}.md`), cardText({ id, priority: 'high', created_at: fresh, created_by: 'planner', ...overrides }))
}

describe('orchestrator nightly > --auto 选卡硬禁区', () => {
  it('deps 提案不提交（留 drafts、不起 run）；普通 high 提案照常提交闭环', () => {
    const repo = mkRepo({ workerBackend: 'mock' })
    try {
      seedDraft(repo, 'night-deps-hard', { type: 'deps', files_hint: ['package.json'] })
      seedDraft(repo, 'night-bugfix-ok', { type: 'bugfix', files_hint: ['mock-worker-output.txt'] })
      const out = runOrch(repo.root, 'nightly --auto 1')
      // 硬禁区：deps 类型选卡阶段跳过——日志给原因、草稿原地保留、无 run 启动标记
      expect(out.stdout).toContain('night-deps-hard 不自动提交')
      expect(out.stdout).toContain('deps 类型永不自动提交')
      expect(out.stdout).not.toContain('nightly --auto → night-deps-hard')
      expect(fs.existsSync(path.join(repo.root, '.agents', 'orchestrator', 'drafts', 'night-deps-hard.md'))).toBe(true)
      // 普通 high：照常提交（离开 drafts/ 并起 run）
      expect(out.stdout).toContain('nightly --auto → night-bugfix-ok')
      expect(fs.existsSync(path.join(repo.root, '.agents', 'orchestrator', 'drafts', 'night-bugfix-ok.md'))).toBe(false)
    } finally {
      repo.cleanup()
    }
  }, 120_000)

  it('feature 提案不提交（上游管线，硬禁区）', () => {
    const repo = mkRepo({ workerBackend: 'mock' })
    try {
      seedDraft(repo, 'night-feature-hard', { type: 'feature', files_hint: ['docs/**'] })
      const out = runOrch(repo.root, 'nightly --auto 1')
      expect(out.stdout).toContain('night-feature-hard 不自动提交')
      expect(out.stdout).toContain('上游管线')
      expect(fs.existsSync(path.join(repo.root, '.agents', 'orchestrator', 'drafts', 'night-feature-hard.md'))).toBe(true)
      expect(listCards(queueRoot(repo.root), 'pending')).toHaveLength(0)
    } finally {
      repo.cleanup()
    }
  }, 120_000)

  it('files_hint 命中 corePaths 的提案不提交（硬禁区）', () => {
    const repo = mkRepo({ workerBackend: 'mock', extra: { corePaths: ['src/gateway/server.ts'] } })
    try {
      seedDraft(repo, 'night-core-hard', { type: 'refactor', files_hint: ['src/gateway/relay.ts'] })
      const out = runOrch(repo.root, 'nightly --auto 1')
      expect(out.stdout).toContain('night-core-hard 不自动提交')
      expect(out.stdout).toContain('命中核心/发布路径')
      expect(fs.existsSync(path.join(repo.root, '.agents', 'orchestrator', 'drafts', 'night-core-hard.md'))).toBe(true)
      expect(listCards(queueRoot(repo.root), 'pending')).toHaveLength(0)
    } finally {
      repo.cleanup()
    }
  }, 120_000)
})

// ---------------------------------------------------------------------------
// drafts gc 自动清退（老化自动档接线）：nightly 周期内自动执行一次「superseded +
// 超龄未提交」两类保守清退 → drafts/superseded/。队列痕迹/人工草稿/未超龄不动。
// ---------------------------------------------------------------------------

describe('orchestrator nightly > drafts gc 自动清退（老化自动档）', () => {
  it('超龄未提交机器提案自动迁 superseded/（aged-out 标注）一次；队列痕迹/人工草稿/未超龄不动，队列卡零改动', () => {
    const repo = mkRepo({ workerBackend: 'mock' })
    try {
      const draftsDir = path.join(repo.root, '.agents', 'orchestrator', 'drafts')
      const pendingDir = path.join(repo.root, '.agents', 'orchestrator', 'queue', 'pending')
      fs.mkdirSync(draftsDir, { recursive: true })
      fs.mkdirSync(pendingDir, { recursive: true })
      // 相对真实 now 取龄：nightly 子进程内 Date.now() 有毫秒级偏移，14 天档位下无影响
      const stale = new Date(Date.now() - 20 * 86_400_000).toISOString()
      const fresh = new Date(Date.now() - 3 * 86_400_000).toISOString()
      fs.writeFileSync(path.join(draftsDir, 'gc-stale-auto.md'), cardText({ id: 'gc-stale-auto', created_at: stale, created_by: 'scanner', files_hint: ['src/cli/a.ts'] }))
      fs.writeFileSync(path.join(draftsDir, 'gc-stale-traced.md'), cardText({ id: 'gc-stale-traced', created_at: stale, created_by: 'scanner', files_hint: ['src/cli/b.ts'] }))
      // 队列痕迹：pending/ 有同名卡（提案已在队列等待——提交态不是「积压」）
      fs.writeFileSync(path.join(pendingDir, 'gc-stale-traced.md'), cardText({ id: 'gc-stale-traced', created_at: stale, created_by: 'human', files_hint: ['mock-worker-output.txt'] }))
      fs.writeFileSync(path.join(draftsDir, 'gc-stale-manual.md'), cardText({ id: 'gc-stale-manual', created_at: stale, created_by: 'human', files_hint: ['src/cli/c.ts'] }))
      fs.writeFileSync(path.join(draftsDir, 'gc-fresh.md'), cardText({ id: 'gc-fresh', created_at: fresh, created_by: 'scanner', files_hint: ['src/cli/d.ts'] }))
      const out = runOrch(repo.root, 'nightly')
      expect(out.stdout).toContain('nightly 摘要') // 巡检完整跑完（清退失败会中断走不到摘要）
      expect(out.stdout).toContain('drafts gc 自动清退')
      // 超龄未提交机器提案：迁入 superseded/ 并带 aged-out 标注
      expect(fs.existsSync(path.join(draftsDir, 'gc-stale-auto.md'))).toBe(false)
      const swept = fs.readFileSync(path.join(draftsDir, 'superseded', 'gc-stale-auto.md'), 'utf8')
      expect(swept).toContain('superseded_by: aged-out')
      // 三类保护对象留原地
      for (const keep of ['gc-stale-traced.md', 'gc-stale-manual.md', 'gc-fresh.md']) {
        expect(fs.existsSync(path.join(draftsDir, keep))).toBe(true)
      }
      // 队列目录零改动：pending 痕迹卡原样、无新增
      expect(fs.existsSync(path.join(pendingDir, 'gc-stale-traced.md'))).toBe(true)
      expect(listCards(queueRoot(repo.root), 'pending')).toEqual(['gc-stale-traced'])
    } finally {
      repo.cleanup()
    }
  }, 120_000)
})
