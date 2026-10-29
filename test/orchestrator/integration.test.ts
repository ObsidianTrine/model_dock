// 集成测试：mock 后端端到端跑通 orchestrator 单任务闭环（docs 第 7 章验收 2）。
// 真实 feature-branch.mjs + 真实门禁 + mock worker/reviewer，临时 git 仓库内秒级完成、零外部调用。

import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { cardText, eventsOf, git, mkRepo, readCard, runOrch, tryOrch } from './helpers.js'

function submitCard(repo: string, id: string, overrides: Record<string, unknown> = {}, body?: string) {
  const cardFile = path.join(repo, `card-${id}.md`)
  fs.writeFileSync(cardFile, cardText({ id, ...overrides }, body))
  runOrch(repo, `submit "${cardFile}"`)
}

const GATE_EVENTS = (repo: string, id: string) => eventsOf(repo, id).filter((e) => e.type === 'gate_result')

describe('orchestrator 集成 > approve 全流程（submit→run→gates→review→awaiting-human→merged）', () => {
  it('任务合并进 develop，worktree 与分支清理，事件链完整', () => {
    const repo = mkRepo()
    try {
      submitCard(repo.root, 'happy')
      const run = runOrch(repo.root, 'run happy --backend mock')
      expect(run.stdout).toContain('awaiting-human')
      expect(readCard(repo.root, 'awaiting-human', 'happy')).toBeTruthy()

      // 门禁记录：npm_test / tsc_build / port_scan / native_scan / scope_purity 全过
      const gates = GATE_EVENTS(repo.root, 'happy').map((e) => `${e.gate}:${e.result}`)
      expect(gates).toContain('npm_test:pass')
      expect(gates).toContain('tsc_build:pass')
      expect(gates).toContain('port_scan:pass')
      expect(gates).toContain('native_scan:pass')
      expect(eventsOf(repo.root, 'happy').map((e) => e.type)).toContain('review_verdict')

      const approve = runOrch(repo.root, 'approve happy')
      expect(approve.stdout).toContain('已合并')
      expect(readCard(repo.root, 'merged', 'happy')).toBeTruthy()
      // merge commit 真实落到 develop
      const log = git(repo.root, 'log --oneline develop -2')
      expect(log).toMatch(/Merge branch 'feature\/happy'/)
      // worktree 与分支已清理
      expect(fs.existsSync(path.join(repo.root, '.agents', 'worktrees', 'happy'))).toBe(false)
      expect(() => git(repo.root, 'rev-parse --verify feature/happy')).toThrow()

      const types = eventsOf(repo.root, 'happy').map((e) => e.type)
      expect(types).toContain('task_accepted')
      expect(types).toContain('worktree_ready')
      expect(types).toContain('worker_spawned')
      expect(types).toContain('worker_done')
      expect(types).toContain('human_gate')
      expect(types).toContain('merged')
    } finally {
      repo.cleanup()
    }
  })
})

describe('orchestrator 集成 > L0/L1 自动合并（Phase 2）', () => {
  it('gate=L1 + 改动分级 L0（docs）→ 跳过人工闸门直接 merged，事件带 auto 标记', () => {
    const repo = mkRepo()
    try {
      submitCard(repo.root, 'auto0', { gate: 'L1', files_hint: ['docs/**'] })
      const run = runOrch(repo.root, 'run auto0 --backend mock', { ORCH_MOCK_FILE: 'docs/notes.md' })
      expect(run.stdout).toContain('自动合并')
      expect(readCard(repo.root, 'merged', 'auto0')).toBeTruthy()
      expect(fs.existsSync(path.join(repo.root, '.agents', 'worktrees', 'auto0'))).toBe(false)
      const types = eventsOf(repo.root, 'auto0').map((e) => e.type)
      expect(types).toContain('auto_merge')
      expect(types).toContain('auto_merge_decision')
      expect(types).not.toContain('awaiting_human')
      expect(types).not.toContain('human_gate')
      const merged = eventsOf(repo.root, 'auto0').find((e) => e.type === 'merged')
      expect(merged?.auto).toBe(true)
    } finally {
      repo.cleanup()
    }
  })

  it('gate=L1 + 改动分级 L2（未识别文件）→ 回人工闸门', () => {
    const repo = mkRepo()
    try {
      submitCard(repo.root, 'upg', { gate: 'L1', files_hint: ['mock-worker-output.txt'] })
      runOrch(repo.root, 'run upg --backend mock')
      expect(readCard(repo.root, 'awaiting-human', 'upg')).toBeTruthy()
      const ah = eventsOf(repo.root, 'upg').find((e) => e.type === 'awaiting_human')
      expect(String(ah?.reason)).toContain('L2')
      runOrch(repo.root, 'approve upg') // 人工兜底仍可合并
      expect(readCard(repo.root, 'merged', 'upg')).toBeTruthy()
    } finally {
      repo.cleanup()
    }
  })

  it('gate=L3（缺省）+ 改动分级 L0 → 仍人工（任务卡要求全人工）', () => {
    const repo = mkRepo()
    try {
      submitCard(repo.root, 'manu', { gate: 'L3', files_hint: ['docs/**'] })
      runOrch(repo.root, 'run manu --backend mock', { ORCH_MOCK_FILE: 'docs/notes.md' })
      expect(readCard(repo.root, 'awaiting-human', 'manu')).toBeTruthy()
      const types = eventsOf(repo.root, 'manu').map((e) => e.type)
      expect(types).not.toContain('auto_merge')
    } finally {
      repo.cleanup()
    }
  })

  it('改动超出 files_hint（scope 越界）→ 即使 L0 也回人工', () => {
    const repo = mkRepo()
    try {
      submitCard(repo.root, 'stray', { gate: 'L1', files_hint: ['other/**'] })
      runOrch(repo.root, 'run stray --backend mock', { ORCH_MOCK_FILE: 'docs/notes.md' })
      expect(readCard(repo.root, 'awaiting-human', 'stray')).toBeTruthy()
      const ah = eventsOf(repo.root, 'stray').find((e) => e.type === 'awaiting_human')
      expect(String(ah?.reason)).toContain('scope_outside')
    } finally {
      repo.cleanup()
    }
  })
})

describe('orchestrator 集成 > 队列自动调度（run --next 与 drain，Phase 2）', () => {
  it('run --next 自动取 pending 任务并跑完闭环', () => {
    const repo = mkRepo()
    try {
      submitCard(repo.root, 'nexted')
      const run = runOrch(repo.root, 'run --next --backend mock')
      expect(run.stdout).toContain('调度下一个任务：nexted')
      expect(readCard(repo.root, 'awaiting-human', 'nexted')).toBeTruthy()
      // 队列已空：再 --next 提示无任务
      const empty = runOrch(repo.root, 'run --next --backend mock')
      expect(empty.stdout).toContain('队列空')
    } finally {
      repo.cleanup()
    }
  })

  it('drain 循环清空队列', () => {
    const repo = mkRepo()
    try {
      submitCard(repo.root, 'd1')
      submitCard(repo.root, 'd2')
      const out = runOrch(repo.root, 'drain --backend mock')
      expect(out.stdout).toContain('队列已清空：本次 drain 共跑完 2 个任务')
      expect(readCard(repo.root, 'awaiting-human', 'd1')).toBeTruthy()
      expect(readCard(repo.root, 'awaiting-human', 'd2')).toBeTruthy()
    } finally {
      repo.cleanup()
    }
  })

  it('熔断任务不阻塞 drain 后续（blocked 落位，队列照常清空）', () => {
    const repo = mkRepo({ testCmd: 'node -e "process.exit(1)"' })
    try {
      for (const id of ['f1', 'f2']) {
        submitCard(repo.root, id, { budget: { max_turns: 5, max_tokens: 100000, max_wall_minutes: 10, max_test_iterations: 1, max_review_iterations: 1 } })
      }
      const out = runOrch(repo.root, 'drain --backend mock')
      expect(out.stdout).toContain('队列已清空：本次 drain 共跑完 2 个任务')
      expect(readCard(repo.root, 'blocked', 'f1')).toBeTruthy()
      expect(readCard(repo.root, 'blocked', 'f2')).toBeTruthy()
    } finally {
      repo.cleanup()
    }
  })

  it('drain --max 限制轮数', () => {
    const repo = mkRepo()
    try {
      submitCard(repo.root, 'm1')
      submitCard(repo.root, 'm2')
      const out = runOrch(repo.root, 'drain --max 1 --backend mock')
      expect(out.stdout).toContain('已达 --max 1 轮上限')
      expect(listCardsOf(repo.root, 'pending')).toContain('m2')
    } finally {
      repo.cleanup()
    }
  })
})

function listCardsOf(repo: string, state: string): string[] {
  const dir = path.join(repo, '.agents', 'orchestrator', 'queue', state)
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3)) : []
}

describe('orchestrator 集成 > reject 与 retry 分支', () => {
  it('reject --reason → failed/，worktree 保留现场', () => {
    const repo = mkRepo()
    try {
      submitCard(repo.root, 'nope')
      runOrch(repo.root, 'run nope --backend mock')
      const r = runOrch(repo.root, 'reject nope --reason "实现方向不对"')
      expect(r.stdout).toContain('failed')
      expect(readCard(repo.root, 'failed', 'nope')).toBeTruthy()
      expect(fs.existsSync(path.join(repo.root, '.agents', 'worktrees', 'nope'))).toBe(true) // 保留现场
      const types = eventsOf(repo.root, 'nope').map((e) => e.type)
      expect(types).toContain('human_gate')
      expect(types).toContain('failed')
    } finally {
      repo.cleanup()
    }
  })

  it('retry --note → 回 running 重新闭环 → approve 合并', () => {
    const repo = mkRepo()
    try {
      submitCard(repo.root, 'again')
      runOrch(repo.root, 'run again --backend mock')
      runOrch(repo.root, 'retry again --note "把 summary 写清楚一点"')
      expect(readCard(repo.root, 'awaiting-human', 'again')).toBeTruthy()
      // 补充指令已写进任务卡
      expect(readCard(repo.root, 'awaiting-human', 'again')).toContain('把 summary 写清楚一点')
      runOrch(repo.root, 'approve again')
      expect(readCard(repo.root, 'merged', 'again')).toBeTruthy()
    } finally {
      repo.cleanup()
    }
  })
})

describe('orchestrator 集成 > 调试子循环熔断', () => {
  it('testCmd 永远失败 → debug_iteration 达上限 → blocked/ + circuit_breaker', () => {
    const repo = mkRepo({
      testCmd: 'node -e "console.error(\'simulated failure\'); process.exit(1)"',
    })
    try {
      submitCard(repo.root, 'flaky', { budget: { max_turns: 5, max_tokens: 100000, max_wall_minutes: 10, max_test_iterations: 2, max_review_iterations: 2 } })
      const r = tryOrch(repo.root, 'run flaky --backend mock')
      expect(r.status).not.toBe(0)
      expect(r.stderr).toContain('调试子循环超限')
      expect(readCard(repo.root, 'blocked', 'flaky')).toBeTruthy()
      const types = eventsOf(repo.root, 'flaky').map((e) => e.type)
      const debugs = types.filter((t) => t === 'debug_iteration')
      expect(debugs.length).toBe(3) // 初次 fail + 2 次 fixup fail（> max=2 判熔断）
      expect(types).toContain('circuit_breaker')
    } finally {
      repo.cleanup()
    }
  })
})

describe('orchestrator 集成 > stuck 与崩溃恢复', () => {
  it('worker 自报 stuck → blocked/；resume 带恢复上下文续做到 awaiting-human', () => {
    const repo = mkRepo()
    try {
      submitCard(repo.root, 'stuckish')
      const r = tryOrch(repo.root, 'run stuckish --backend mock', { ORCH_MOCK_WORKER_STATUS: 'stuck' })
      // stuck 不算失败退出： orchestrator 正常收尾并转 blocked
      expect(r.stdout).toContain('blocked')
      expect(readCard(repo.root, 'blocked', 'stuckish')).toBeTruthy()

      // resume：mock 正常完成后走完门禁与审查
      const r2 = runOrch(repo.root, 'resume stuckish --backend mock')
      expect(r2.stdout).toContain('awaiting-human')
      const types = eventsOf(repo.root, 'stuckish').map((e) => e.type)
      expect(types).toContain('resumed')
    } finally {
      repo.cleanup()
    }
  })

  it('abandon：清理孤儿提示 + 转 failed/', () => {
    const repo = mkRepo()
    try {
      submitCard(repo.root, 'give-up')
      tryOrch(repo.root, 'run give-up --backend mock', { ORCH_MOCK_WORKER_STATUS: 'stuck' })
      runOrch(repo.root, 'abandon give-up')
      expect(readCard(repo.root, 'failed', 'give-up')).toBeTruthy()
    } finally {
      repo.cleanup()
    }
  })
})

describe('orchestrator 集成 > 守门与边界', () => {
  it('pending → awaiting-human 跳变被拒（只能 approve awaiting-human）', () => {
    const repo = mkRepo()
    try {
      submitCard(repo.root, 'notyet')
      const r = tryOrch(repo.root, 'approve notyet')
      expect(r.status).not.toBe(0)
      expect(r.stderr).toContain('pending')
    } finally {
      repo.cleanup()
    }
  })

  it('同 id 重复 submit 拒绝', () => {
    const repo = mkRepo()
    try {
      submitCard(repo.root, 'dup')
      const cardFile = path.join(repo.root, 'card-dup2.md')
      fs.writeFileSync(cardFile, cardText({ id: 'dup' }))
      const r = tryOrch(repo.root, `submit "${cardFile}"`)
      expect(r.status).not.toBe(0)
      expect(r.stderr).toContain('已存在')
    } finally {
      repo.cleanup()
    }
  })

  it('status：队列全貌与单任务时间线', () => {
    const repo = mkRepo()
    try {
      submitCard(repo.root, 's1')
      const all = runOrch(repo.root, 'status')
      expect(all.stdout).toContain('pending')
      expect(all.stdout).toContain('s1')
      runOrch(repo.root, 'run s1 --backend mock')
      const one = runOrch(repo.root, 'status s1')
      expect(one.stdout).toContain('awaiting-human')
      expect(one.stdout).toContain('worker_spawned')
    } finally {
      repo.cleanup()
    }
  })
})

describe('orchestrator 集成 > 状态/语义回归（任务卡 09）', () => {
  it('awaiting-human 卡直跑 run 不崩：先迁移 running，正常走完状态机回到 awaiting-human', () => {
    const repo = mkRepo()
    try {
      submitCard(repo.root, 'reah')
      runOrch(repo.root, 'run reah --backend mock')
      expect(readCard(repo.root, 'awaiting-human', 'reah')).toBeTruthy()
      // 修复前：卡留在 awaiting-human/ 进整轮 worker，审查后 moveCard('running',…)
      // 抛 QueueError，兜底 failTaskToBlocked 只认 running/reviewing → 裸栈崩出
      const again = tryOrch(repo.root, 'run reah --backend mock')
      expect(again.status).toBe(0)
      expect(again.stderr).not.toMatch(/QueueError|任务卡不存在/)
      expect(readCard(repo.root, 'awaiting-human', 'reah')).toBeTruthy()
      const accepted = eventsOf(repo.root, 'reah').filter((e) => e.type === 'task_accepted')
      expect(accepted).toHaveLength(2)
      expect(accepted[1].from_state).toBe('awaiting-human')
    } finally {
      repo.cleanup()
    }
  })

  it('baseBranch 非 develop：changedFiles/gateScopePurity 按配置基准取 diff，闭环照常走到 awaiting-human', () => {
    const repo = mkRepo({ baseBranch: 'main' })
    try {
      submitCard(repo.root, 'brmb')
      // 修复前：purity/分级用默认 'develop' 取 diff，仓库无 develop 分支 → git diff fatal → 卡落 blocked
      const run = tryOrch(repo.root, 'run brmb --backend mock', { ORCH_MOCK_FILE: 'docs/notes.md' })
      expect(run.status).toBe(0)
      expect(readCard(repo.root, 'awaiting-human', 'brmb')).toBeTruthy()
      const gates = GATE_EVENTS(repo.root, 'brmb').map((e) => `${e.gate}:${e.result}`)
      expect(gates).toContain('scope_purity:pass')
      // change_classification 由 changedFiles(baseBranch) 驱动：能产出分级即证明 diff 基准正确
      const classification = eventsOf(repo.root, 'brmb').find((e) => e.type === 'gate_result' && e.gate === 'change_classification')
      expect(classification?.result).toBe('L0')
    } finally {
      repo.cleanup()
    }
  })
})
