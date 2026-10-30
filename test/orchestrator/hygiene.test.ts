// T15 agents-hygiene-batch 定向断言（卡验收五项）：
//   ① guard-develop 热路径重排——escape hatch 0 次 git / feature 分支 1 次 / 基准分支 3 次
//   ② events appendEvent seq 缓存——热路径零全文件读；invalidateSeqCache 后重新对齐
//   ③ drain run 子进程 spawn 'error'（ENOENT）→ active 清空 + pump 继续 + exit 0（原缺口挂起不退）
//   ④ policy evaluateCommand 单次评估只读一次 workflow.json（原最多 4 次）
//   ⑤ policy audit.jsonl 5MB 轮转（.1 只留一代，审计行内容不变）
// 无 vi.mock（AGENTS vitest 隔离模型）：fs 用 vi.spyOn 作用域内打点，外部进程用真实脚本。

import { describe, expect, it, vi, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { cardText, mkRepo, runOrch } from './helpers.js'
import { appendEvent, invalidateSeqCache, readEvents } from '../../.agents/scripts/orchestrator/events.mjs'
import { audit, evaluateCommand, setAuditFile } from '../../.agents/scripts/policy.mjs'

const REPO = path.resolve(process.cwd()) // vitest cwd = worktree 根
const TMP_DIRS: string[] = []
afterEach(() => {
  while (TMP_DIRS.length) fs.rmSync(TMP_DIRS.pop()!, { recursive: true, force: true })
})

function tmpDir(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  TMP_DIRS.push(d)
  return d
}

// ---------------------------------------------------------------------------
// ① guard-develop hook 的 git 取证次数（fake git 计数）
// ---------------------------------------------------------------------------

// fake git 只在 mac/linux 可行：execFileSync('git') 在 Windows 无 shell 直调只认 .exe，
// 无法用 PATH 注入假实现——执行序逻辑本身平台无关，unix 侧覆盖 + Windows CI 跳过。
const fakeGitScript = [
  '#!/bin/sh',
  'printf x >> "$GIT_CALL_COUNTER"',
  'case "$*" in',
  '  *--abbrev-ref*) printf \'%s\\n\' "$FAKE_BRANCH" ;;',
  '  *) printf \'%s\\n\' "$FAKE_ROOT" ;;',
  'esac',
].join('\n')

function runGuardHook(opts: { fakeBranch: string; gitCounter: string; fakeRoot: string; filePath?: string; hatch?: boolean }): { status: number | null } {
  const hook = path.join(REPO, '.agents', 'hooks', 'guard-develop.mjs')
  // fake git 落 PATH 首位（遮蔽真 git）：hook 的 execFileSync('git') 按 PATH 解析到它
  const fakeDir = tmpDir('t15-path-')
  const fakeGit = path.join(fakeDir, 'git')
  fs.writeFileSync(fakeGit, fakeGitScript, { mode: 0o755 })
  const r = spawnSync(process.execPath, [hook], {
    cwd: tmpDir('t15-audit-'), // audit() 落 cwd 的 .agents/policy/，别污染真仓库
    input: JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: opts.filePath ?? path.join(opts.fakeRoot, 'x.md') } }),
    env: {
      ...process.env,
      PATH: `${fakeDir}${path.delimiter}${process.env.PATH ?? ''}`,
      GIT_CALL_COUNTER: opts.gitCounter,
      FAKE_BRANCH: opts.fakeBranch,
      FAKE_ROOT: opts.fakeRoot,
      ...(opts.hatch ? { AGENTS_ALLOW_BASE_EDIT: '1' } : {}),
    },
    encoding: 'utf8',
    timeout: 30_000,
  })
  return { status: r.status }
}

describe.skipIf(process.platform === 'win32')('T15① guard-develop 取证次数（fake git）', () => {
  it('escape hatch：0 次 git 直接放行', () => {
    const counter = path.join(tmpDir('t15-cnt-'), 'c')
    const r = runGuardHook({ fakeBranch: 'develop', gitCounter: counter, fakeRoot: tmpDir('t15-root-'), hatch: true })
    expect(r.status).toBe(0)
    expect(fs.existsSync(counter)).toBe(false)
  })

  it('feature 分支（工作流常态）：1 次 git（只取 branch），放行', () => {
    const counter = path.join(tmpDir('t15-cnt-'), 'c')
    const root = tmpDir('t15-root-')
    const r = runGuardHook({ fakeBranch: 'feature/t15-demo', gitCounter: counter, fakeRoot: root, filePath: path.join(root, 'a.md') })
    expect(r.status).toBe(0)
    expect(fs.readFileSync(counter, 'utf8')).toBe('x')
  })

  it('基准分支：3 次 git（branch + root + fileRoot），develop 上 .md 文档放行', () => {
    const counter = path.join(tmpDir('t15-cnt-'), 'c')
    const root = tmpDir('t15-root-')
    const r = runGuardHook({ fakeBranch: 'develop', gitCounter: counter, fakeRoot: root, filePath: path.join(root, 'a.md') })
    expect(r.status).toBe(0)
    expect(fs.readFileSync(counter, 'utf8')).toBe('xxx')
  })
})

// ---------------------------------------------------------------------------
// ② events appendEvent seq 缓存
// ---------------------------------------------------------------------------

describe('T15② events appendEvent seq 缓存', () => {
  it('热路径第二次 append 零全文件读；invalidateSeqCache 后重对齐且 seq 连续', () => {
    const dir = path.join(tmpDir('t15-ev-'), 'logs', 't1')
    const first = appendEvent(dir, 'a')
    expect(first.seq).toBe(1)

    const spy = vi.spyOn(fs, 'readFileSync')
    try {
      const second = appendEvent(dir, 'b')
      expect(second.seq).toBe(2)
      expect(spy.mock.calls.filter((c) => String(c[0]).includes('events.jsonl'))).toHaveLength(0)
    } finally {
      spy.mockRestore()
    }

    // 接管/跨进程场景：清缓存后下一次 append 重新读盘对齐，seq 不回退不跳号
    invalidateSeqCache(dir)
    const third = appendEvent(dir, 'c')
    expect(third.seq).toBe(3)
    expect(readEvents(dir).map((e) => [e.seq, e.type])).toEqual([[1, 'a'], [2, 'b'], [3, 'c']])
  })
})

// ---------------------------------------------------------------------------
// ③ drain：run 子进程 spawn 'error' 不再挂起
// ---------------------------------------------------------------------------

describe('T15③ drain 对 spawn ENOENT 的容错', () => {
  it('node 不在 PATH 时 drain 仍退出 0（error → active 清空 → pump 继续）', () => {
    const repo = mkRepo()
    try {
      const cardFile = path.join(repo.root, 'card-t15drain.md')
      fs.writeFileSync(cardFile, cardText({ id: 't15drain' }))
      runOrch(repo.root, `submit "${cardFile}"`)

      // PATH 剔除 node 所在目录（nvm / setup-node / homebrew 链接目录普遍含 node 字样），
      // git 保留——drain 父进程自身仍需 git/findRepoRoot；内层 spawn('node') 才会 ENOENT
      const nodeDir = path.dirname(process.execPath)
      const slimPath = (process.env.PATH ?? '')
        .split(path.delimiter)
        .filter((p) => p && path.resolve(p) !== nodeDir && !/node/i.test(p))
        .join(path.delimiter)
      // 探测：若这台机器 node 仍可解析（如 /usr/bin/node），ENOENT 场景造不出来——
      // 退化为只断言不挂起 + 正常跑完（ Assertions 分支二）
      const probe = spawnSync('node', ['--version'], { env: { ...process.env, PATH: slimPath }, encoding: 'utf8' })
      const enoent = probe.status !== 0

      const orch = path.join(REPO, '.agents', 'scripts', 'orchestrator.mjs')
      const r = spawnSync(process.execPath, [orch, 'drain', '--backend', 'mock'], {
        cwd: repo.root,
        encoding: 'utf8',
        timeout: 120_000,
        maxBuffer: 32 * 1024 * 1024,
        env: { ...process.env, PATH: slimPath },
      })
      // 修复前：active 条目永不清除 → pump 停摆 → drain 挂死（这里会撞 timeout）
      expect(r.error?.code).not.toBe('ABRT')
      expect(r.status).toBe(0)
      const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
      if (enoent) {
        expect(out).toContain('run 子进程启动失败')
        expect(out).toContain('继续调度')
      } else {
        expect(out).toContain('队列已清空')
      }
    } finally {
      repo.cleanup()
    }
  }, 150_000)
})

// ---------------------------------------------------------------------------
// ④ policy evaluateCommand 单次评估只读一次 workflow.json
// ---------------------------------------------------------------------------

describe('T15④ evaluateCommand 配置单读', () => {
  it('单次评估恰读一次 workflow.json；判定结果不变（gateway start 无 --port 仍拦）', () => {
    const spy = vi.spyOn(fs, 'readFileSync')
    try {
      const verdict = evaluateCommand('gateway start')
      const reads = spy.mock.calls.filter((c) => String(c[0]).includes('workflow.json'))
      expect(reads).toHaveLength(1)
      expect(verdict.allowed).toBe(false)
      expect(verdict.rule).toBe('port')
    } finally {
      spy.mockRestore()
    }
  })

  it('无端口命中的普通命令不触发配置外读取（仍恰 1 次）', () => {
    const spy = vi.spyOn(fs, 'readFileSync')
    try {
      const verdict = evaluateCommand('npm test')
      const reads = spy.mock.calls.filter((c) => String(c[0]).includes('workflow.json'))
      expect(reads).toHaveLength(1)
      expect(verdict.allowed).toBe(true)
    } finally {
      spy.mockRestore()
    }
  })
})

// ---------------------------------------------------------------------------
// ⑤ policy audit.jsonl 5MB 轮转
// ---------------------------------------------------------------------------

describe('T15⑤ audit.jsonl 大小轮转', () => {
  it('超 5MB 触发轮转：旧文件 → .1（只留一代），新审计行内容完整', () => {
    const dir = tmpDir('t15-rot-')
    const file = path.join(dir, 'audit.jsonl')
    setAuditFile(file)
    try {
      fs.writeFileSync(file, 'x'.repeat(5 * 1024 * 1024 + 1))
      audit({ hook: 'guard-develop', tool: 'Edit', decision: 'allowed', reason: 't15 rotate probe', target: '/tmp/x.md' })
      expect(fs.existsSync(`${file}.1`)).toBe(true)
      expect(fs.statSync(`${file}.1`).size).toBe(5 * 1024 * 1024 + 1)
      const line = fs.readFileSync(file, 'utf8').trim()
      expect(JSON.parse(line)).toMatchObject({ hook: 'guard-develop', decision: 'allowed', reason: 't15 rotate probe' })

      // 第二轮：.1 被新一代覆盖（不堆积），主文件继续追加
      fs.writeFileSync(file, 'y'.repeat(5 * 1024 * 1024 + 2))
      audit({ hook: 'guard-develop', tool: 'Bash', decision: 'allowed', reason: 't15 rotate probe 2', target: '' })
      expect(fs.statSync(`${file}.1`).size).toBe(5 * 1024 * 1024 + 2)
      const lines = fs.readFileSync(file, 'utf8').trim().split('\n')
      expect(lines).toHaveLength(1)
      expect(JSON.parse(lines[0]).reason).toBe('t15 rotate probe 2')
    } finally {
      setAuditFile(null)
    }
  })
})
