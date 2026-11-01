// B7 确定性偏航报警（xte_alarm，observe-only）测试：no_commit / test_loop / scope_drift
// 三条规则各一个集成场景（mock 后端）。只留痕不动作——同时断言任务按既有流程正常落位。

import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { cardText, eventsOf, mkRepo, readCard, runOrch, tryOrch } from './helpers.js'

function submitCard(repo: string, id: string, overrides: Record<string, unknown> = {}) {
  const cardFile = path.join(repo, `card-${id}.md`)
  fs.writeFileSync(cardFile, cardText({ id, ...overrides }))
  runOrch(repo, `submit "${cardFile}"`)
}

function alarmsOf(repo: string, id: string) {
  return eventsOf(repo, id).filter((e) => e.type === 'xte_alarm')
}

describe('orchestrator xte > no_commit（连续 2 会话零新提交）', () => {
  it('审查返工循环且 worker 不提交 → 第 2 个会话末报警一次；任务照常走完流程', () => {
    const repo = mkRepo()
    try {
      // gate L3 + 审查恒有阻塞 → 至少 2 个 worker 会话；ORCH_MOCK_NO_COMMIT 让会话零提交
      submitCard(repo.root, 'xte-nc')
      tryOrch(repo.root, 'run xte-nc --backend mock', { ORCH_MOCK_REVIEW_BLOCKERS: '1', ORCH_MOCK_NO_COMMIT: '1' }) // 终局审查超限 die → exit 1
      const alarms = alarmsOf(repo.root, 'xte-nc').filter((e) => e.rule === 'no_commit')
      expect(alarms).toHaveLength(1) // 每规则每任务只报一次（后续会话仍零提交也不重复）
      expect(String(alarms[0].detail)).toContain('零新提交')
      // observe-only：不改变落位——审查返工超限照常熔断 blocked
      expect(readCard(repo.root, 'blocked', 'xte-nc')).toBeTruthy()
    } finally {
      repo.cleanup()
    }
  }, 120_000)

  it('会话有新提交则不报警（对照）', () => {
    const repo = mkRepo()
    try {
      submitCard(repo.root, 'xte-nc-ok')
      runOrch(repo.root, 'run xte-nc-ok --backend mock') // mock 默认每会话 git commit
      expect(alarmsOf(repo.root, 'xte-nc-ok').filter((e) => e.rule === 'no_commit')).toHaveLength(0)
    } finally {
      repo.cleanup()
    }
  }, 90_000)
})

describe('orchestrator xte > test_loop（npm_test 连续 2 轮 fail）', () => {
  it('有状态 testCmd 失败两次后转绿 → 第二轮 fail 时报警，第三轮转绿照常落位', () => {
    // marker 放仓库外（不污染改动分级）：run1 写 1 fail；run2 见 1 写 2 仍 fail；run3 见 2 通过
    const marker = path.join(os.tmpdir(), `xte-gate-${process.pid}-${Date.now()}.flag`).replace(/\\/g, '/')
    const repo = mkRepo({
      testCmd: `node -e "const fs=require('fs');if(fs.existsSync('${marker}')){if(fs.readFileSync('${marker}','utf8')==='2'){process.exit(0)}fs.writeFileSync('${marker}','2');process.exit(1)}fs.writeFileSync('${marker}','1');process.exit(1)"`,
    })
    try {
      submitCard(repo.root, 'xte-tl')
      runOrch(repo.root, 'run xte-tl --backend mock')
      const results = eventsOf(repo.root, 'xte-tl')
        .filter((e) => e.type === 'gate_result' && e.gate === 'npm_test')
        .map((e) => e.result)
      expect(results).toEqual(['fail', 'fail', 'pass'])
      const alarms = alarmsOf(repo.root, 'xte-tl').filter((e) => e.rule === 'test_loop')
      expect(alarms).toHaveLength(1)
      expect(String(alarms[0].detail)).toContain('连续 2 轮 fail')
      expect(readCard(repo.root, 'awaiting-human', 'xte-tl')).toBeTruthy() // 只留痕：流程照常
    } finally {
      repo.cleanup()
      fs.rmSync(marker, { force: true })
    }
  }, 120_000)
})

describe('orchestrator xte > scope_drift（越界文件数达阈值）', () => {
  it('worktree 累积 hint 外文件 ≥ max(3, hint 长度) → 报警；仍走人工闸门不自动合并', () => {
    const repo = mkRepo()
    try {
      // 第一轮：单个 hint 外文件（1 < 阈值 3）不报警，gate L3 落 awaiting-human
      submitCard(repo.root, 'xte-sd')
      runOrch(repo.root, 'run xte-sd --backend mock', { ORCH_MOCK_FILE: 'docs/notes.md' })
      expect(alarmsOf(repo.root, 'xte-sd').filter((e) => e.rule === 'scope_drift')).toHaveLength(0)
      expect(readCard(repo.root, 'awaiting-human', 'xte-sd')).toBeTruthy()

      // 第二轮（awaiting-human 直跑复用 worktree）：预置 3 个 hint 外未跟踪文件，
      // mock 的 git add -A 一并提交 → outside = 4 ≥ max(3, files_hint 长度 1)
      const wt = path.join(repo.root, '.agents', 'worktrees', 'xte-sd')
      for (const f of ['lib/a.js', 'lib/b.js', 'lib/c.js']) {
        fs.mkdirSync(path.dirname(path.join(wt, f)), { recursive: true })
        fs.writeFileSync(path.join(wt, f), '// xte scope drift test\n')
      }
      runOrch(repo.root, 'run xte-sd --backend mock', { ORCH_MOCK_FILE: 'docs/notes.md' })
      const alarms = alarmsOf(repo.root, 'xte-sd').filter((e) => e.rule === 'scope_drift')
      expect(alarms).toHaveLength(1)
      expect(String(alarms[0].detail)).toContain('≥ 阈值 3')
      expect(readCard(repo.root, 'awaiting-human', 'xte-sd')).toBeTruthy()
    } finally {
      repo.cleanup()
    }
  }, 150_000)
})
