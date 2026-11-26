// 宿主仓哨兵（host-guard.mjs）单测：锚定解析 / 快照形状 / 对账差异 / teardown 语义
// （零改动绿、队列被迁移红、分支被删红、锚定仓消失 fail-closed 红）。
// 全程自造临时 git 仓（os.tmpdir + path.join），零宿主仓触达；git 不可用的环境跳过
// （哨兵本体与被测代码同源依赖，环境缺 git 时套件里也没法跑任何真实编排命令）。

import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { diffSnapshots, resolveAnchorRepo, snapshotRepo, startHostGuard } from './host-guard.mjs'

const GIT_READY = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] })
    return true
  } catch {
    return false
  }
})()

/** git 对象落盘/异步收尾可能让 rmSync 瞬间 EBUSY/EPERM：退避重试（同 helpers 策略）。 */
function rmRfRetry(p: string): void {
  const backoffMs = [10, 50, 100, 250, 500, 1000]
  for (let i = 0; ; i++) {
    try {
      fs.rmSync(p, { recursive: true, force: true })
      return
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? ''
      if (!['ENOTEMPTY', 'EBUSY', 'EPERM', 'EACCES'].includes(code) || i >= backoffMs.length) throw e
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, backoffMs[i])
    }
  }
}

interface Fixture {
  root: string
  git(args: string[] | string, opts?: { cwd?: string }): string
  cleanup(): void
}

/** 最小 git 仓：develop 初始提交 + feature/wt 分支的 linked worktree + 两张队列卡。 */
function mkGitRepo(): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'host-guard-'))
  // git 参数走数组直调（路径可能含空格，split(' ') 分词会劈碎路径）
  const g = (args: string[] | string, opts: { cwd?: string } = {}) =>
    execFileSync('git', Array.isArray(args) ? args : args.split(' '), {
      cwd: opts.cwd ?? root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
  g('init')
  g('symbolic-ref HEAD refs/heads/develop')
  g('config user.email guard@local')
  g('config user.name guard')
  fs.writeFileSync(path.join(root, 'README.md'), '# guard fixture\n')
  g('add -A')
  g('commit -m init')
  const wt = path.join(root, 'wts', 'probe')
  g(['worktree', 'add', wt, '-b', 'feature/probe'])
  const queueDir = path.join(root, '.agents', 'orchestrator', 'queue')
  fs.mkdirSync(path.join(queueDir, 'blocked'), { recursive: true })
  fs.mkdirSync(path.join(queueDir, 'running'), { recursive: true })
  fs.writeFileSync(path.join(queueDir, 'blocked', 'card-a.md'), '---\nid: card-a\n---\n')
  fs.writeFileSync(path.join(queueDir, 'running', '.keep'), '')
  return {
    root,
    git: g,
    cleanup: () => {
      try { g(['worktree', 'remove', '--force', wt]) } catch { /* 已不在则忽略（cleanup 尽力而为） */ }
      rmRfRetry(root)
    },
  }
}

const maybeGit = GIT_READY ? describe : describe.skip

maybeGit('host-guard > 锚定解析', () => {
  it('仓根返回自身；子目录上溯到仓根；非仓目录返回 null', () => {
    const repo = mkGitRepo()
    try {
      const expectRoot = fs.realpathSync(repo.root)
      expect(fs.realpathSync(resolveAnchorRepo(repo.root)!)).toBe(expectRoot)
      const sub = path.join(repo.root, 'wts', 'probe')
      expect(fs.realpathSync(resolveAnchorRepo(sub)!)).toBe(expectRoot)
      const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'host-guard-plain-'))
      try {
        expect(resolveAnchorRepo(plain)).toBeNull()
      } finally {
        rmRfRetry(plain)
      }
    } finally {
      repo.cleanup()
    }
  })
})

maybeGit('host-guard > 快照形状', () => {
  it('三类快照齐备：分支 / worktree 注册 / 队列卡', () => {
    const repo = mkGitRepo()
    try {
      const snap = snapshotRepo(repo.root)
      // 分支行带 tip（名字 + 40 位对象名）：并发 merge 推进主干 tip 也在对账面内
      expect(snap.branches.some((l: string) => /^develop [0-9a-f]{40}$/.test(l))).toBe(true)
      expect(snap.branches.some((l: string) => /^feature\/probe [0-9a-f]{40}$/.test(l))).toBe(true)
      // worktree 注册行归一为 / 分隔（win 反斜杠已转）：目录基名必在列
      expect(snap.worktrees.some((l: string) => l.includes('wts/probe'))).toBe(true)
      expect(snap.queue).toEqual(['blocked/card-a.md', 'running/.keep'])
      // 快照幂等：同仓连拍两次零差异
      expect(diffSnapshots(snap, snapshotRepo(repo.root))).toEqual([])
    } finally {
      repo.cleanup()
    }
  })
})

maybeGit('host-guard > 对账差异', () => {
  it('队列卡被迁移（删+增）→ 差异点名；零改动 → 空差异', () => {
    const repo = mkGitRepo()
    try {
      const before = snapshotRepo(repo.root)
      // 模拟 incident 里的卡迁移：blocked → merged（队列状态变异）
      const mergedDir = path.join(repo.root, '.agents', 'orchestrator', 'queue', 'merged')
      fs.mkdirSync(mergedDir, { recursive: true })
      fs.renameSync(
        path.join(repo.root, '.agents', 'orchestrator', 'queue', 'blocked', 'card-a.md'),
        path.join(mergedDir, 'card-a.md'),
      )
      const diffs = diffSnapshots(before, snapshotRepo(repo.root))
      expect(diffs.some((d: string) => d.includes('队列卡') && d.includes('blocked/card-a.md'))).toBe(true)
      expect(diffs.some((d: string) => d.includes('队列卡') && d.includes('merged/card-a.md'))).toBe(true)
    } finally {
      repo.cleanup()
    }
  })

  it('分支引用被删 → 差异点名（-d/-D 即红的核心维度）', () => {
    const repo = mkGitRepo()
    try {
      const before = snapshotRepo(repo.root)
      // worktree 先摘除再删分支：git 不允许删被 worktree 占用的分支
      repo.git(['worktree', 'remove', '--force', path.join(repo.root, 'wts', 'probe')])
      repo.git('branch -D feature/probe')
      const diffs = diffSnapshots(before, snapshotRepo(repo.root))
      expect(diffs.some((d: string) => d.includes('分支引用') && d.includes('feature/probe'))).toBe(true)
    } finally {
      repo.cleanup()
    }
  })
})

maybeGit('host-guard > teardown 语义', () => {
  it('零改动 → teardown 静默通过', () => {
    const repo = mkGitRepo()
    try {
      const teardown = startHostGuard(repo.root)
      expect(typeof teardown).toBe('function')
      expect(() => teardown()).not.toThrow()
    } finally {
      repo.cleanup()
    }
  })

  it('运行窗口内队列被改 → teardown 抛可操作错误（越界即红）', () => {
    const repo = mkGitRepo()
    try {
      const teardown = startHostGuard(repo.root)
      fs.renameSync(
        path.join(repo.root, '.agents', 'orchestrator', 'queue', 'blocked', 'card-a.md'),
        path.join(repo.root, '.agents', 'orchestrator', 'queue', 'blocked', 'card-b.md'),
      )
      expect(() => teardown()).toThrow(/宿主仓被改动/)
    } finally {
      repo.cleanup()
    }
  })

  it('锚定仓中途消失 → fail-closed 红（无法验证 ≠ 通过）', () => {
    const repo = mkGitRepo()
    const teardown = startHostGuard(repo.root)
    // 先摘 worktree 再整仓删除（否则注册行挡删）
    try { repo.git(['worktree', 'remove', '--force', path.join(repo.root, 'wts', 'probe')]) } catch { /* 尽力而为 */ }
    rmRfRetry(repo.root)
    expect(() => teardown()).toThrow(/fail-closed/)
  })
})
