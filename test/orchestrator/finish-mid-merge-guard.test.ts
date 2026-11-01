// 卡 21 回归：主检出处于未完成合并（.git/MERGE_HEAD 存在）时，start/finish 必须
// 快速失败并给出两条出路（完成合并 git commit / 放弃 git merge --abort）。
// 2026-10-30 实证：merge 式 pull 撞冲突悬挂 40 分钟期间，feature-branch 全部带伤跑崩。
// 子进程跑真实脚本（参照 finish-lock.test.ts 配方；FINISH_LOCK_WAIT_SECONDS=0 免锁等待）。

import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { mkRepo, git } from './helpers.js'

function runScript(repo: string, args: string[]) {
  const script = path.join(repo, '.agents', 'scripts', 'feature-branch.mjs')
  const r = spawnSync(process.execPath, [script, ...args], {
    cwd: repo,
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, FINISH_LOCK_WAIT_SECONDS: '0' },
  })
  return { status: r.status, out: `${r.stdout ?? ''}\n${r.stderr ?? ''}` }
}

/** 直接写 .git/MERGE_HEAD 把主检出置为 merging 状态（卡面认可的第二种造法）。 */
function plantMergeHead(repo: string) {
  const head = git(repo, 'rev-parse HEAD')
  fs.writeFileSync(path.join(repo, '.git', 'MERGE_HEAD'), head + '\n')
}

describe('start/finish 主检出 mid-merge 守卫', () => {
  it('MERGE_HEAD 存在 → finish 立即拒绝，错误信息含 commit 与 --abort 两条出路', () => {
    const repo = mkRepo()
    try {
      plantMergeHead(repo.root)
      const r = runScript(repo.root, ['finish', 'no-such-task'])
      expect(r.status).toBe(1)
      expect(r.out).toContain('MERGE_HEAD')
      expect(r.out).toContain('git commit')
      expect(r.out).toContain('--abort')
      expect(r.out).not.toContain('no worktree for task') // 守卫先于业务逻辑
    } finally {
      repo.cleanup()
    }
  })

  it('MERGE_HEAD 存在 → start 同样拒绝，不创建 worktree', () => {
    const repo = mkRepo()
    try {
      plantMergeHead(repo.root)
      const r = runScript(repo.root, ['start', 'mid-merge-probe'])
      expect(r.status).toBe(1)
      expect(r.out).toContain('git commit')
      expect(r.out).toContain('--abort')
      expect(fs.existsSync(path.join(repo.root, '.agents', 'worktrees', 'mid-merge-probe'))).toBe(false)
    } finally {
      repo.cleanup()
    }
  })

  it('无 MERGE_HEAD → 行为不变（finish 走到业务错误；start 正常建 worktree）', () => {
    const repo = mkRepo()
    try {
      const f = runScript(repo.root, ['finish', 'no-such-task'])
      expect(f.status).toBe(1)
      expect(f.out).toContain('no worktree for task')
      expect(f.out).not.toContain('MERGE_HEAD')

      const s = runScript(repo.root, ['start', 'clean-probe'])
      expect(s.status).toBe(0)
      expect(s.out).toContain('Worktree ready')
      expect(fs.existsSync(path.join(repo.root, '.git', 'MERGE_HEAD'))).toBe(false)
    } finally {
      repo.cleanup()
    }
  })
})
