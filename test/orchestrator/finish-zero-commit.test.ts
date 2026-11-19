// 零提交假合并残余路径收口回归：worker 漏提交时分支相对 base 零提交，旧 finish 走
// 「nothing to merge」静默删 worktree+分支后 exit 0——假合并伪装成成功且现场被销毁。
// 新行为：die 非零退出 + 可操作报错，worktree 与分支原样保留供人工核对补提交。
// 子进程跑真实脚本（参照 finish-merge-conflict.test.ts 配方，FINISH_LOCK_WAIT_SECONDS=0 免锁等待）。

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

describe('finish 零提交分支显式失败', () => {
  it('分支零提交 → 非零退出，worktree 与分支保留，报错含补提交指引', () => {
    const repo = mkRepo()
    try {
      const s = runScript(repo.root, ['start', 'zero-probe'])
      expect(s.status).toBe(0)
      const wt = path.join(repo.root, '.agents', 'worktrees', 'zero-probe')

      // start 后不提交任何东西（NOTES.md 模板为未跟踪文件，finish 会先自清再判零提交）
      const r = runScript(repo.root, ['finish', 'zero-probe'])
      expect(r.status).toBe(1)
      expect(r.out).toContain('has no commits relative to develop') // base 取 finish 既有 baseBranch 来源
      expect(r.out).toContain('never committed') // 指明多为 worker 漏提交
      expect(r.out).toContain(wt) // worktree 保留路径写进报错
      expect(r.out).toContain('finish zero-probe') // 可操作的重跑指引
      expect(r.out).not.toContain('nothing to merge. Cleaning up') // 旧静默清理文案不再出现
      expect(fs.existsSync(wt)).toBe(true) // 现场保留：worktree 目录仍在
      expect(git(repo.root, 'branch --list feature/zero-probe')).not.toBe('') // 分支仍在
    } finally {
      repo.cleanup()
    }
  })

  it('有提交分支 → 行为不变：exit 0 正常闭环（merge + 清理现场）', () => {
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
      expect(git(repo.root, 'branch --list feature/happy-probe')).toBe('')
    } finally {
      repo.cleanup()
    }
  })
})
