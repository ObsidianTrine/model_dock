// 卡 15 回归：finish 检测 worktree NOTES.md 仍是 start 生成的空模板（含
// 「<一句话说明本任务要达成什么>」占位符）→ 打 WARNING 但不阻断（NOTES 永不入库，
// 不构成代码风险）。子进程跑真实脚本（参照 finish-lock.test.ts 配方，
// FINISH_LOCK_WAIT_SECONDS=0 免锁等待）。

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
    timeout: 120_000,
    env: { ...process.env, FINISH_LOCK_WAIT_SECONDS: '0' },
  })
  return { status: r.status, out: `${r.stdout ?? ''}\n${r.stderr ?? ''}` }
}

// 对齐真仓库 .gitignore（NOTES.md 永不入库）：临时仓库漏了它，worktree 里的 NOTES.md
// 以未跟踪身份出现在 status → finish 脏检查误报，测不到软门禁本身。
function ignoreNotes(repo: string) {
  fs.appendFileSync(path.join(repo, '.gitignore'), 'NOTES.md\n')
  git(repo, 'add -A')
  git(repo, 'commit -m gitignore-notes')
}

describe('finish NOTES.md 空模板软门禁', () => {
  it('模板 NOTES（占位符还在）→ finish 输出 WARNING 但不阻断', () => {
    const repo = mkRepo()
    try {
      ignoreNotes(repo.root)
      const s = runScript(repo.root, ['start', 'notes-tpl-probe'])
      expect(s.status).toBe(0)
      const wt = path.join(repo.root, '.agents', 'worktrees', 'notes-tpl-probe')
      expect(fs.readFileSync(path.join(wt, 'NOTES.md'), 'utf8')).toContain('<一句话说明本任务要达成什么>')

      const f = runScript(repo.root, ['finish', 'notes-tpl-probe'])
      expect(f.out).toContain('WARNING')
      expect(f.out).toContain('unfilled start template')
      expect(f.out).toContain('NOTES.md')
      expect(f.status).toBe(0) // 警告不阻断：零提交路径照常清理成功
    } finally {
      repo.cleanup()
    }
  })

  it('已填 NOTES（占位符已替换）→ 无 WARNING，正常合并', () => {
    const repo = mkRepo()
    try {
      ignoreNotes(repo.root)
      runScript(repo.root, ['start', 'notes-filled-probe'])
      const wt = path.join(repo.root, '.agents', 'worktrees', 'notes-filled-probe')
      const notes = fs.readFileSync(path.join(wt, 'NOTES.md'), 'utf8')
      fs.writeFileSync(path.join(wt, 'NOTES.md'), notes.replace('<一句话说明本任务要达成什么>', '为 finish 补 NOTES 空模板软门禁'))
      fs.appendFileSync(path.join(wt, 'README.md'), '\nchange\n')
      git(wt, 'add -A')
      git(wt, 'commit -m change') // NOTES.md 已被 ignore，add -A 不会带上

      const f = runScript(repo.root, ['finish', 'notes-filled-probe'])
      expect(f.status).toBe(0)
      expect(f.out).toContain('Merged')
      expect(f.out).not.toContain('unfilled start template')
    } finally {
      repo.cleanup()
    }
  })
})
