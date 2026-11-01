// feature-branch.mjs list 的残留目录检测：.agents/worktrees/ 下已注销的壳目录被点名
// （只读不自动删）；活跃 worktree 与锁文件不误报。

import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { mkRepo } from './helpers.js'

const WORKTREE_ROOT = path.resolve(process.cwd()) // vitest cwd = worktree 根

function runList(repo: string): { status: number | null; output: string } {
  const fb = path.join(WORKTREE_ROOT, '.agents', 'scripts', 'feature-branch.mjs')
  const r = spawnSync(process.execPath, [fb, 'list'], { cwd: repo, encoding: 'utf8', timeout: 60_000 })
  return { status: r.status, output: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

describe('feature-branch list > 残留 worktree 壳目录检测', () => {
  it('已注销壳目录被点名 + 清理指引；git 登记的活跃 worktree 与锁文件不误报', () => {
    const repo = mkRepo()
    try {
      const wtDir = path.join(repo.root, '.agents', 'worktrees')
      fs.mkdirSync(wtDir, { recursive: true })

      // 壳目录：git worktree list 已注销（从未登记），Windows EPERM 清理失败产物的形状
      const shell = path.join(wtDir, '25-fix-tray-modelitem-hidden')
      fs.mkdirSync(shell)
      fs.writeFileSync(path.join(shell, 'NOTES.md'), '残留壳目录（内含未合并工作的可能，删前人工确认）')

      // git 真实登记的活跃 worktree：不得误报为残留
      const real = path.join(wtDir, 'real-task')
      spawnSync('git', ['worktree', 'add', real, '-b', 'feature/real-task'], { cwd: repo.root, encoding: 'utf8' })
      expect(fs.existsSync(path.join(real, 'README.md'))).toBe(true) // add 确实成功（前置有效性）

      // 锁/标记文件（非目录）：不在检测范围
      fs.writeFileSync(path.join(wtDir, '.finish.lock'), '{}')

      const r = runList(repo.root)
      expect(r.status).toBe(0)
      expect(r.output).toContain('feature/real-task') // 活跃任务照常列出
      expect(r.output).toContain('残留目录')
      expect(r.output).toContain('25-fix-tray-modelitem-hidden') // 壳目录被点名（含路径）
      expect(r.output).toContain('git worktree prune && rm -rf') // 一句手工清理指引
      expect(r.output).toContain('只读，不自动删')
      // 活跃 worktree 与锁文件不进残留名单
      expect(r.output).not.toContain('- ' + real)
      expect(r.output).not.toContain('.finish.lock')
    } finally {
      repo.cleanup()
    }
  })

  it('无残留：list 正常收尾且无残留警告', () => {
    const repo = mkRepo()
    try {
      const r = runList(repo.root)
      expect(r.status).toBe(0)
      expect(r.output).toContain('No active task worktrees')
      expect(r.output).not.toContain('残留')
    } finally {
      repo.cleanup()
    }
  })

  it('只有壳目录（无任何活跃任务）：No active 提示之后仍给出残留警告（早退不吞检测）', () => {
    const repo = mkRepo()
    try {
      const wtDir = path.join(repo.root, '.agents', 'worktrees')
      fs.mkdirSync(path.join(wtDir, 'orphan-shell'), { recursive: true })
      const r = runList(repo.root)
      expect(r.status).toBe(0)
      expect(r.output).toContain('No active task worktrees')
      expect(r.output).toContain('残留目录')
      expect(r.output).toContain('orphan-shell')
    } finally {
      repo.cleanup()
    }
  })
})
