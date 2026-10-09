// guard-develop.mjs 行为锁定测试：这是所有会话（含人工）的分支保护，回归代价最高。
// 分支×文件类型矩阵（2026-10-02 分支卫生规则）：
//   develop：代码拦、纯文档（*.md）放行；main：代码与文档一律拦。
// 用临时 git 仓库构造 develop/feature/worktree 三种真实拓扑。

import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execSync } from 'node:child_process'

const HOOK = path.resolve(process.cwd(), '.agents', 'hooks', 'guard-develop.mjs')

function mkRepo(): string {
  const raw = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-dev-'))
  // macOS 的 TMPDIR(/var/folders)是符号链接，git --show-toplevel 返回 /private/var/folders——
  // realpath 化后与 git 输出一致，否则路径前缀比对失配（原版 hook 同样如此）
  const repo = fs.realpathSync(raw)
  const g = (a: string) => execSync(`git ${a}`, { cwd: repo, stdio: 'ignore' })
  g('init')
  g('symbolic-ref HEAD refs/heads/develop')
  g('config user.email t@l')
  g('config user.name t')
  fs.writeFileSync(path.join(repo, 'a.ts'), 'export {}\n')
  fs.writeFileSync(path.join(repo, 'README.md'), '# t\n')
  g('add -A')
  g('commit -m init')
  return repo
}

/** 以 repo 为 cwd 跑 hook（hook 内部 git 调用继承 cwd），返回退出码。 */
function hookVerdict(repo: string, input: object, env: Record<string, string> = {}): number {
  const r = spawnSync('node', [HOOK], {
    cwd: repo,
    input: JSON.stringify(input),
    encoding: 'utf8',
    env: { ...process.env, ...env },
    stdio: ['pipe', 'ignore', 'ignore'],
  })
  return r.status ?? 1
}

const edit = (filePath: string) => ({ tool_name: 'Edit', tool_input: { file_path: filePath } })

describe('guard-develop hook > 行为锁定（重构前后逐字一致）', () => {
  // 临时诊断：定位 Windows 上漏拦时 hook 到底取到了什么（定位后删除）。
  it('DEBUG 取证', () => {
    const repo = mkRepo()
    try {
      const fp = path.join(repo, 'a.ts')
      const g = (a: string[], cwd: string) => {
        const r = spawnSync('git', a, { cwd, encoding: 'utf8' })
        return r.status === 0 ? (r.stdout ?? '').trim() : `ERR(${r.status}): ${String(r.stderr ?? r.error?.message ?? '').trim()}`
      }
      const real = (p: string) => {
        try { return fs.realpathSync(p) } catch (e) { return `ERR: ${(e as Error).message}` }
      }
      const hook = spawnSync('node', [HOOK], { cwd: repo, input: JSON.stringify(edit(fp)), encoding: 'utf8' })
      console.log('GUARD-DEBUG ' + JSON.stringify({
        platform: process.platform,
        tmpdir: os.tmpdir(),
        repo,
        filePath: fp,
        realRepo: real(repo),
        realFile: real(fp),
        branchInRepo: g(['rev-parse', '--abbrev-ref', 'HEAD'], repo),
        branchInRealRepo: g(['rev-parse', '--abbrev-ref', 'HEAD'], real(repo)),
        toplevel: g(['rev-parse', '--show-toplevel'], repo),
        fileRoot: g(['-C', path.dirname(fp), 'rev-parse', '--show-toplevel'], repo),
        hookStatus: hook.status,
        hookStderr: String(hook.stderr ?? '').slice(0, 400),
      }, null, 2))
    } finally {
      fs.rmSync(repo, { recursive: true, force: true })
    }
  })

  it('develop/main 直改本仓库文件 → 拦截（exit 2）', () => {
    const repo = mkRepo()
    try {
      expect(hookVerdict(repo, edit(path.join(repo, 'a.ts')))).toBe(2)
      execSync('git checkout -b main', { cwd: repo, stdio: 'ignore' })
      expect(hookVerdict(repo, edit(path.join(repo, 'a.ts')))).toBe(2)
    } finally {
      fs.rmSync(repo, { recursive: true, force: true })
    }
  })

  it('develop 上文档直改 → 放行；main 上文档直改 → 拦截（分支卫生规则）', () => {
    const repo = mkRepo()
    try {
      expect(hookVerdict(repo, edit(path.join(repo, 'README.md')))).toBe(0)
      execSync('git checkout -b main', { cwd: repo, stdio: 'ignore' })
      expect(hookVerdict(repo, edit(path.join(repo, 'README.md')))).toBe(2)
    } finally {
      fs.rmSync(repo, { recursive: true, force: true })
    }
  })

  it('develop 上非 .md 文档（.txt）放行；带执行语义的配置（.yml/.json）仍拦截', () => {
    const repo = mkRepo()
    try {
      fs.writeFileSync(path.join(repo, 'guide.txt'), 'doc\n')
      fs.writeFileSync(path.join(repo, 'pipe.yml'), 'on: push\n')
      fs.writeFileSync(path.join(repo, 'conf.json'), '{}\n')
      expect(hookVerdict(repo, edit(path.join(repo, 'guide.txt')))).toBe(0)
      expect(hookVerdict(repo, edit(path.join(repo, 'pipe.yml')))).toBe(2)
      expect(hookVerdict(repo, edit(path.join(repo, 'conf.json')))).toBe(2)
    } finally {
      fs.rmSync(repo, { recursive: true, force: true })
    }
  })

  it('feature 分支 → 放行', () => {
    const repo = mkRepo()
    try {
      execSync('git checkout -b feature/x', { cwd: repo, stdio: 'ignore' })
      expect(hookVerdict(repo, edit(path.join(repo, 'a.ts')))).toBe(0)
    } finally {
      fs.rmSync(repo, { recursive: true, force: true })
    }
  })

  it('linked worktree 内的文件 → 放行（worktree 编辑正是工作流 prescribed）', () => {
    const repo = mkRepo()
    try {
      execSync('git worktree add .agents/worktrees/t1 -b feature/t1', { cwd: repo, stdio: 'ignore' })
      expect(hookVerdict(repo, edit(path.join(repo, '.agents/worktrees/t1/a.ts')))).toBe(0)
    } finally {
      fs.rmSync(repo, { recursive: true, force: true })
    }
  })

  it('仓库外文件 → 放行；非编辑类工具 → 放行', () => {
    const repo = mkRepo()
    try {
      expect(hookVerdict(repo, edit('/tmp/elsewhere/a.ts'))).toBe(0)
      expect(hookVerdict(repo, { tool_name: 'Bash', tool_input: { command: 'echo hi' } })).toBe(0)
      expect(hookVerdict(repo, { tool_name: 'Edit', tool_input: {} })).toBe(0) // 无路径
    } finally {
      fs.rmSync(repo, { recursive: true, force: true })
    }
  })

  it('escape hatch：AGENTS_ALLOW_BASE_EDIT=1（新名）→ 放行', () => {
    const repo = mkRepo()
    try {
      expect(hookVerdict(repo, edit(path.join(repo, 'a.ts')), { AGENTS_ALLOW_BASE_EDIT: '1' })).toBe(0)
    } finally {
      fs.rmSync(repo, { recursive: true, force: true })
    }
  })

  it('escape hatch：旧项目名 MODELRDOCK_ALLOW_DEVELOP_EDIT=1 兼容放行', () => {
    const repo = mkRepo()
    try {
      expect(hookVerdict(repo, edit(path.join(repo, 'a.ts')), { MODELRDOCK_ALLOW_DEVELOP_EDIT: '1' })).toBe(0)
    } finally {
      fs.rmSync(repo, { recursive: true, force: true })
    }
  })
})
