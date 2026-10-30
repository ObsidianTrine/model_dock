// 卡 18 回归：finish 的 git merge --no-ff 撞冲突时，必须 git merge --abort 恢复主检出
// （不留 merging 状态），并 die 给「回 worktree rebase 解决后重跑」的可操作指引——
// 对照 rebase 段既有写法。冲突制造法：behind==0 跳过 rebase 后，借 testCmd 钩子
// （verification 在 merge 之前跑）在主检出落一个同文件冲突提交，merge 必撞。
// 子进程跑真实脚本（参照 finish-lock.test.ts 配方，FINISH_LOCK_WAIT_SECONDS=0 免锁等待）。

import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { mkRepo, git } from './helpers.js'

function runScript(repo: string, args: string[], extraEnv: Record<string, string> = {}) {
  const script = path.join(repo, '.agents', 'scripts', 'feature-branch.mjs')
  const r = spawnSync(process.execPath, [script, ...args], {
    cwd: repo,
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env, FINISH_LOCK_WAIT_SECONDS: '0', ...extraEnv },
  })
  return { status: r.status, out: `${r.stdout ?? ''}\n${r.stderr ?? ''}` }
}

// testCmd 钩子：在主检出（develop）落一个与分支改同一行的冲突提交。主仓库根由测试经
// ORCH_TEST_MAIN_REPO 注入（testCmd 以 worktree 为 cwd 被 finish 调起，env 沿进程透传）。
const ADVANCE_HELPER = `import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
const main = process.env.ORCH_TEST_MAIN_REPO
if (!main) { console.error('ORCH_TEST_MAIN_REPO not set'); process.exit(1) }
fs.writeFileSync(path.join(main, 'shared.txt'), 'base-side\\n')
execSync('git add -A', { cwd: main, stdio: 'ignore' })
execSync('git commit -m base-advance', { cwd: main, stdio: 'ignore' })
`

function makeRepoWithHelper(): { root: string; cleanup: () => void } {
  const repo = mkRepo({ testCmd: 'node advance-develop.mjs' })
  fs.writeFileSync(path.join(repo.root, 'advance-develop.mjs'), ADVANCE_HELPER)
  fs.writeFileSync(path.join(repo.root, 'shared.txt'), 'init-line\n')
  git(repo.root, 'add -A')
  git(repo.root, 'commit -m helper-and-shared')
  return repo
}

function commitBranchSide(repo: string, task: string) {
  const wt = path.join(repo, '.agents', 'worktrees', task)
  fs.writeFileSync(path.join(wt, 'shared.txt'), 'branch-side\n')
  git(wt, 'add -A')
  git(wt, 'commit -m branch-change')
  return wt
}

describe('finish merge 冲突处理', () => {
  it('merge 撞冲突 → git merge --abort 恢复主检出（无 MERGE_HEAD），错误含 worktree rebase 指引', () => {
    const repo = makeRepoWithHelper()
    try {
      const s = runScript(repo.root, ['start', 'conflict-probe'])
      expect(s.status).toBe(0)
      const wt = commitBranchSide(repo.root, 'conflict-probe')

      const r = runScript(repo.root, ['finish', 'conflict-probe'], { ORCH_TEST_MAIN_REPO: repo.root })
      expect(r.status).toBe(1)
      expect(r.out).toContain('has conflicts')
      expect(r.out).toContain('rebase')
      expect(r.out).toContain('finish conflict-probe')
      expect(r.out).toContain('aborted') // 主检出已被恢复
      // 主检出干净：无 merging 状态、无未提交改动、develop 停在冲突侧提交（未产出合并提交）
      expect(fs.existsSync(path.join(repo.root, '.git', 'MERGE_HEAD'))).toBe(false)
      expect(git(repo.root, 'status --porcelain --untracked-files=no')).toBe('')
      expect(git(repo.root, 'log -1 --format=%s develop')).toBe('base-advance')
      // worktree 仍在 → 「回 worktree 解决」的指引可执行
      expect(fs.existsSync(wt)).toBe(true)
    } finally {
      repo.cleanup()
    }
  })

  it('恢复后重跑 → 冲突改在 worktree 的 rebase 段浮出（指引闭环成立）', () => {
    const repo = makeRepoWithHelper()
    try {
      runScript(repo.root, ['start', 'retry-probe'])
      commitBranchSide(repo.root, 'retry-probe')
      runScript(repo.root, ['finish', 'retry-probe'], { ORCH_TEST_MAIN_REPO: repo.root })

      const r2 = runScript(repo.root, ['finish', 'retry-probe'])
      expect(r2.status).toBe(1)
      expect(r2.out).toContain('rebase has conflicts') // develop 已前进，重跑触发 rebase 冲突路径
    } finally {
      repo.cleanup()
    }
  })

  it('无冲突 → 行为不变：merge --no-ff 成功、worktree 清理', () => {
    const repo = mkRepo()
    try {
      const s = runScript(repo.root, ['start', 'happy-probe'])
      expect(s.status).toBe(0)
      const wt = path.join(repo.root, '.agents', 'worktrees', 'happy-probe')
      fs.appendFileSync(path.join(wt, 'README.md'), '\nchange\n')
      git(wt, 'add -A')
      git(wt, 'commit -m change')
      const r = runScript(repo.root, ['finish', 'happy-probe'])
      expect(r.status).toBe(0)
      expect(r.out).toContain('Merged')
      expect(fs.existsSync(wt)).toBe(false)
    } finally {
      repo.cleanup()
    }
  })
})
