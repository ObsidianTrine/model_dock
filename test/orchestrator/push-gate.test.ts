// push-gate 测试（push-review-gate 卡，2026-11）：三段覆盖——
//   ① orch push-review 命令 e2e（mkRepo + mock 船：pass/fail/diff 超限/缺省 range）
//   ② policy-dispatch push 闸判定矩阵（子进程跑真实 hook + mkRepo 夹具，实测 8 情形）
//   ③ push-gate.mjs 纯函数矩阵（注入 fake git，覆盖难以在真仓摆出的解析形态）
// 无 vi.mock（singleFork 跨文件 mock 雷区规避）；mock 船行为由 ORCH_MOCK_* env 在子进程注入。

import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { mkRepo, git, runOrch, tryOrch } from './helpers.js'
import * as gate from '../../.agents/hooks/push-gate.mjs'
import * as policy from '../../.agents/scripts/policy.mjs'

const WORKTREE_ROOT = path.resolve(process.cwd()) // vitest 的 cwd = 仓库根（worktree 内）
const DISPATCHER = path.join(WORKTREE_ROOT, '.agents', 'hooks', 'policy-dispatch.mjs')

interface RunResult {
  status: number
  stdout: string
  stderr: string
}

/** 跑 dispatcher：stdin 喂 hook 事件 JSON（默认 ORCH_POLICY_ENFORCE=1；env 可覆盖/删键）。 */
function runDispatch(input: unknown, env: Record<string, string | undefined> = {}): RunResult {
  const merged: Record<string, string> = { ...process.env, ORCH_POLICY_ENFORCE: '1' }
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete merged[k]
    else merged[k] = v
  }
  const r = spawnSync('node', [DISPATCHER], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8',
    env: merged,
  })
  return { status: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

const bashEvent = (cwd: string, command: string) => ({ tool_name: 'Bash', cwd, tool_input: { command } })

/** 在夹具仓里写一份 push-review 结论（缺省指向当前 HEAD、刚刚审查、verdict=pass）。 */
function writeArtifact(repo: string, patch: Record<string, unknown> = {}): Record<string, unknown> {
  const dir = path.join(repo, '.agents', 'orchestrator', 'push-review')
  fs.mkdirSync(dir, { recursive: true })
  const art = {
    schema: 'push-verdict/1',
    branch: 'develop',
    head: git(repo, 'rev-parse HEAD'),
    range: 'HEAD~1..HEAD',
    verdict: 'pass',
    overall: 88,
    findings: [],
    reasons: ['夹具注入：通过'],
    reviewer_model: null,
    backend: 'mock',
    reviewed_at: new Date().toISOString(),
    ...patch,
  }
  fs.writeFileSync(path.join(dir, 'latest.json'), `${JSON.stringify(art, null, 2)}\n`)
  return art
}

const artifactPath = (repo: string) => path.join(repo, '.agents', 'orchestrator', 'push-review', 'latest.json')

/** 夹具仓追加一个提交（改动 README，保证 range 里有 diff）。 */
function commitChange(repo: string, file = 'README.md', body = 'change\n'): void {
  fs.writeFileSync(path.join(repo, file), body)
  git(repo, 'add -A')
  git(repo, 'commit -m "docs: push-gate fixture change"')
}

// -----------------------------------------------------------------------
// ① orch push-review 命令 e2e（mock 船）
// -----------------------------------------------------------------------

describe('orch push-review > mock 船 e2e', () => {
  it('mock pass：latest.json 字段齐全（head 与 rev-parse 一致）+ fleet 留痕 + stdout 摘要', () => {
    const repo = mkRepo()
    try {
      commitChange(repo.root)
      const r = runOrch(repo.root, 'push-review --range HEAD~1..HEAD --backend mock')
      expect(r.stdout).toContain('push 审查结论：pass')
      expect(r.stdout).toContain('HEAD 再变即失效')
      const art = JSON.parse(fs.readFileSync(artifactPath(repo.root), 'utf8'))
      expect(art.schema).toBe('push-verdict/1')
      expect(art.verdict).toBe('pass')
      expect(art.head).toBe(git(repo.root, 'rev-parse HEAD'))
      expect(art.range).toBe('HEAD~1..HEAD')
      expect(art.branch).toBe('develop')
      expect(typeof art.reviewed_at).toBe('string')
      expect(Array.isArray(art.findings)).toBe(true)
      const fleet = fs
        .readFileSync(path.join(repo.root, '.agents', 'orchestrator', 'logs', 'fleet.jsonl'), 'utf8')
        .trim()
        .split('\n')
      const ev = JSON.parse(fleet[fleet.length - 1])
      expect(ev.type).toBe('push_review')
      expect(ev.verdict).toBe('pass')
      expect(ev.head).toBe(art.head)
    } finally {
      repo.cleanup()
    }
  })

  it('ORCH_MOCK_REVIEW_BLOCKERS=1 注入 fail：退出码非 0 + verdict=fail 落盘', () => {
    const repo = mkRepo()
    try {
      commitChange(repo.root)
      const r = tryOrch(repo.root, 'push-review --range HEAD~1..HEAD --backend mock', { ORCH_MOCK_REVIEW_BLOCKERS: '1' })
      expect(r.status).not.toBe(0)
      expect(r.stderr).toContain('未通过')
      const art = JSON.parse(fs.readFileSync(artifactPath(repo.root), 'utf8'))
      expect(art.verdict).toBe('fail')
      expect(art.findings.length).toBeGreaterThan(0)
    } finally {
      repo.cleanup()
    }
  })

  it('diff 超 400KB：die 可操作报错（建议分段/缩 range），不落结论', () => {
    const repo = mkRepo()
    try {
      commitChange(repo.root, 'big.md', 'x'.repeat(450 * 1024))
      const r = tryOrch(repo.root, 'push-review --range HEAD~1..HEAD --backend mock')
      expect(r.status).not.toBe(0)
      expect(r.stderr).toContain('400KB')
      expect(r.stderr).toContain('range')
      expect(fs.existsSync(artifactPath(repo.root))).toBe(false)
    } finally {
      repo.cleanup()
    }
  })

  it('无 upstream 且无 origin/develop：die 提示显式传 --range', () => {
    const repo = mkRepo()
    try {
      const r = tryOrch(repo.root, 'push-review --backend mock')
      expect(r.status).not.toBe(0)
      expect(r.stderr).toContain('--range')
    } finally {
      repo.cleanup()
    }
  })
})

// -----------------------------------------------------------------------
// ② policy-dispatch push 闸判定矩阵（子进程实测）
// -----------------------------------------------------------------------

describe('policy-dispatch push 闸 > 判定矩阵（子进程实测）', () => {
  it('无结论推 develop → 拦（exit 2 + 可操作三选一文案）', () => {
    const repo = mkRepo()
    try {
      const r = runDispatch(bashEvent(repo.root, 'git push origin develop'))
      expect(r.status).toBe(2)
      expect(r.stderr).toContain('push-review')
      expect(r.stderr).toContain('AGENTS_ALLOW_PUSH')
      expect(r.stderr).toContain('三选一')
    } finally {
      repo.cleanup()
    }
  })

  it('结论 pass + HEAD 一致 + 24h 内 → 放行（exit 0，正常路径不写旁路日志）', () => {
    const repo = mkRepo()
    const logFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pushgate-log-')), 'push-gate.log')
    try {
      writeArtifact(repo.root)
      const r = runDispatch(bashEvent(repo.root, 'git push origin develop'), { AGENTS_PUSH_GATE_LOG: logFile })
      expect(r.status).toBe(0)
      expect(fs.existsSync(logFile)).toBe(false) // artifact 放行不写日志
    } finally {
      fs.rmSync(path.dirname(logFile), { recursive: true, force: true })
      repo.cleanup()
    }
  })

  it('HEAD 已变（结论针对旧 sha）→ 拦', () => {
    const repo = mkRepo()
    try {
      writeArtifact(repo.root, { head: '0'.repeat(40) })
      const r = runDispatch(bashEvent(repo.root, 'git push origin develop'))
      expect(r.status).toBe(2)
      expect(r.stderr).toContain('HEAD 已变')
    } finally {
      repo.cleanup()
    }
  })

  it('结论超 24h → 拦', () => {
    const repo = mkRepo()
    try {
      writeArtifact(repo.root, { reviewed_at: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString() })
      const r = runDispatch(bashEvent(repo.root, 'git push origin develop'))
      expect(r.status).toBe(2)
      expect(r.stderr).toContain('24h')
    } finally {
      repo.cleanup()
    }
  })

  it('AGENTS_ALLOW_PUSH=1 环境注入 → 放行 + 显眼警告 + 旁路日志一行', () => {
    const repo = mkRepo()
    const logFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pushgate-log-')), 'push-gate.log')
    try {
      const r = runDispatch(bashEvent(repo.root, 'git push origin develop'), { AGENTS_ALLOW_PUSH: '1', AGENTS_PUSH_GATE_LOG: logFile })
      expect(r.status).toBe(0)
      expect(r.stderr).toContain('旁路')
      expect(r.stderr).toContain('责任在人')
      const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n')
      expect(lines.length).toBe(1)
      const entry = JSON.parse(lines[0])
      expect(entry.bypass).toBe(true)
      expect(entry.branch).toContain('develop')
      expect(entry.hook).toBe('policy-dispatch')
    } finally {
      fs.rmSync(path.dirname(logFile), { recursive: true, force: true })
      repo.cleanup()
    }
  })

  it('AGENTS_ALLOW_PUSH=1 命令前缀 hatch（env 未注入）→ 同样放行 + 留痕', () => {
    const repo = mkRepo()
    const logFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pushgate-log-')), 'push-gate.log')
    try {
      const r = runDispatch(bashEvent(repo.root, 'AGENTS_ALLOW_PUSH=1 git push origin develop'), { AGENTS_PUSH_GATE_LOG: logFile })
      expect(r.status).toBe(0)
      const entry = JSON.parse(fs.readFileSync(logFile, 'utf8').trim())
      expect(entry.bypass).toBe(true)
    } finally {
      fs.rmSync(path.dirname(logFile), { recursive: true, force: true })
      repo.cleanup()
    }
  })

  it('显式推其他分支（本地存在的分支）→ 放行', () => {
    const repo = mkRepo()
    try {
      git(repo.root, 'branch feature/nightly-work')
      const r = runDispatch(bashEvent(repo.root, 'git push origin feature/nightly-work'))
      expect(r.status).toBe(0)
    } finally {
      repo.cleanup()
    }
  })

  it('git -C 形态：分支与结论均按 -C 路径解析（事件 cwd 无关）', () => {
    const repoA = mkRepo() // 事件 cwd（develop，无结论）
    const repoB = mkRepo() // -C 目标仓
    try {
      // repoB 停在非保护分支：裸 push 放行——若误用事件 cwd（repoA=develop）会拦
      git(repoB.root, 'checkout -b feature/from-c')
      expect(runDispatch(bashEvent(repoA.root, `git -C ${repoB.root} push`)).status).toBe(0)
      // 结论在 repoB、repoA 无结论：-C 推 develop 放行——若按事件 cwd 找结论会拦
      git(repoB.root, 'checkout develop')
      writeArtifact(repoB.root)
      expect(runDispatch(bashEvent(repoA.root, `git -C ${repoB.root} push origin develop`)).status).toBe(0)
      // 反向：结论在事件 cwd、-C 仓无结论 → 拦（结论不跨仓借道）
      writeArtifact(repoA.root)
      fs.rmSync(path.join(repoB.root, '.agents', 'orchestrator', 'push-review'), { recursive: true, force: true })
      const r = runDispatch(bashEvent(repoA.root, `git -C ${repoB.root} push origin develop`))
      expect(r.status).toBe(2)
      expect(r.stderr).toContain('三选一')
    } finally {
      repoA.cleanup()
      repoB.cleanup()
    }
  })

  it('混入 tag / 推 tag / force push → defer 回既有裁决（原样拦截，非新文案）', () => {
    const repo = mkRepo()
    try {
      // push + tag 混合：门禁不借道放行，走既有 publish 拦截原文案
      const mixed = runDispatch(bashEvent(repo.root, 'git push origin develop && git tag -d v9.9.9'))
      expect(mixed.status).toBe(2)
      expect(mixed.stderr).toContain('发布动作人工授权制')
      expect(mixed.stderr).not.toContain('三选一')
      // 纯 tag 推送（refspec 是 tag）：同样 defer 原样拦截
      const tag = runDispatch(bashEvent(repo.root, 'git push origin v9.9.9'))
      expect(tag.status).toBe(2)
      expect(tag.stderr).not.toContain('三选一')
      // force push：永不借道审查放行
      const force = runDispatch(bashEvent(repo.root, 'git push --force origin develop'))
      expect(force.status).toBe(2)
      expect(force.stderr).not.toContain('三选一')
      // 有结论也拦 force（结论只担保 HEAD 内容，不担保非快进改写）
      writeArtifact(repo.root)
      expect(runDispatch(bashEvent(repo.root, 'git push -f origin develop')).status).toBe(2)
    } finally {
      repo.cleanup()
    }
  })

  it('非 push 命令不受门禁影响（既有放行/拦截面零变化）', () => {
    const repo = mkRepo()
    try {
      expect(runDispatch(bashEvent(repo.root, 'git status')).status).toBe(0)
      expect(runDispatch(bashEvent(repo.root, 'npm test')).status).toBe(0)
      expect(runDispatch(bashEvent(repo.root, 'git tag -a v9.9.9 -m x')).status).toBe(2)
    } finally {
      repo.cleanup()
    }
  })
})

// -----------------------------------------------------------------------
// ③ push-gate.mjs 纯函数矩阵（注入 fake git，覆盖真仓难摆的形态）
// -----------------------------------------------------------------------

/** fake show-ref：只有指定 ref 存在。 */
const fakeOkFor = (...refs: string[]) => (_cwd: string, args: string[]) => {
  const target = args[args.length - 1] ?? ''
  return args[0] === 'show-ref' && refs.includes(target)
}
const fakeHead = (branch: string) => (cwd: string, args: string[]) => (args[1] === '--abbrev-ref' ? branch : 'a'.repeat(40))

describe('push-gate 纯函数矩阵', () => {
  it('refspecTarget：显式分支 / refs/heads / 显式 dst / HEAD:develop / 删除保护分支 / tag 全 defer', () => {
    const okBranches = fakeOkFor('refs/heads/feature/x', 'refs/heads/develop', 'refs/heads/main')
    expect(gate.refspecTarget('feature/x', '/r', gate.defaultRunGit, okBranches)).toEqual({ branch: 'feature/x' })
    expect(gate.refspecTarget('refs/heads/main', '/r', gate.defaultRunGit, okBranches)).toEqual({ branch: 'main' })
    expect(gate.refspecTarget('HEAD:develop', '/r', gate.defaultRunGit, okBranches)).toEqual({ branch: 'develop' })
    expect(gate.refspecTarget('develop:feature/x', '/r', gate.defaultRunGit, okBranches)).toEqual({ branch: 'feature/x' })
    expect(gate.refspecTarget('+develop', '/r', gate.defaultRunGit, okBranches)).toEqual({ branch: 'develop' })
    expect(gate.refspecTarget(':develop', '/r', gate.defaultRunGit, okBranches)).toEqual({ branch: 'develop' }) // 删除保护分支同判
    // tag 形态一律 defer（发布动作绝不借道）
    expect(gate.refspecTarget('refs/tags/v1.2.3', '/r', gate.defaultRunGit, okBranches)).toHaveProperty('deferReason')
    expect(gate.refspecTarget('v1.2.3', '/r', gate.defaultRunGit, fakeOkFor('refs/tags/v1.2.3'))).toHaveProperty('deferReason')
    expect(gate.refspecTarget(':refs/tags/v1.2.3', '/r', gate.defaultRunGit, okBranches)).toHaveProperty('deferReason')
    // 裸名既非本地分支也非 tag：保守 defer
    expect(gate.refspecTarget('new-branch', '/r', gate.defaultRunGit, fakeOkFor())).toHaveProperty('deferReason')
    // 分支与 tag 同名歧义：保守 defer
    expect(gate.refspecTarget('ghost', '/r', gate.defaultRunGit, fakeOkFor('refs/heads/ghost', 'refs/tags/ghost'))).toHaveProperty('deferReason')
  })

  it('parsePushSegment：-C 提取 / 未知 flag unreliable / force / broad / 前缀 hatch / 非 push 段', () => {
    const p = gate.parsePushSegment('git -C /tmp/repo push -u origin feature/x', policy)
    expect(p?.gitDir).toBe('/tmp/repo')
    expect(p?.args).toEqual(['origin', 'feature/x'])
    expect(p?.unreliable).toBe(false)
    expect(gate.parsePushSegment('git push --frobnicate origin main', policy)?.unreliable).toBe(true)
    expect(gate.parsePushSegment('git push -f origin main', policy)?.force).toBe(true)
    expect(gate.parsePushSegment('git push --force-with-lease origin main', policy)?.force).toBe(true)
    expect(gate.parsePushSegment('git push --all', policy)?.broad).toBe(true)
    expect(gate.parsePushSegment('git push --mirror', policy)?.broad).toBe(true)
    expect(gate.parsePushSegment('AGENTS_ALLOW_PUSH=1 git push origin develop', policy)?.auth).toBe(true)
    expect(gate.parsePushSegment('git push origin develop', policy)?.auth).toBe(false)
    // 带值 flag 的值不被误当 refspec；= 附着形态不吞下一 token
    expect(gate.parsePushSegment('git push --repo upstream develop', policy)?.args).toEqual(['develop'])
    expect(gate.parsePushSegment('git push --push-option=ci origin develop', policy)?.args).toEqual(['origin', 'develop'])
    expect(gate.parsePushSegment('git status', policy)).toBeNull()
  })

  it('scanPushCommand：混入 tag / npm publish 全量上报（defer 依据）', () => {
    const s1 = gate.scanPushCommand('git push origin develop && git tag -d v1.0.0', policy)
    expect(s1.hasPush).toBe(true)
    expect(s1.hasTag).toBe(true)
    const s2 = gate.scanPushCommand('npm publish && git push origin feature/x', policy)
    expect(s2.hasPush).toBe(true)
    expect(s2.hasNpmPublish).toBe(true)
    expect(gate.scanPushCommand('git status', policy).hasPush).toBe(false)
  })

  it('evaluatePushGate：裸 push 当前分支矩阵 + 环境旁路 + 真实 artifact 放行（注入 fake git）', () => {
    const head = fakeHead('develop')
    const ok = fakeOkFor('refs/heads/develop')
    // 裸 push 命中保护分支、无结论 → block
    expect(gate.evaluatePushGate({ cmd: 'git push', cwd: '/r', policy, runGit: head, runGitOk: ok }).decision).toBe('block')
    // 只给 remote 的裸 push 同判
    expect(gate.evaluatePushGate({ cmd: 'git push origin', cwd: '/r', policy, runGit: head, runGitOk: ok }).decision).toBe('block')
    // 当前分支为非保护 → pass-unprotected
    expect(gate.evaluatePushGate({ cmd: 'git push', cwd: '/r', policy, runGit: fakeHead('feature/wip'), runGitOk: ok }).decision).toBe('pass-unprotected')
    // 环境旁路 → allow-bypass + 日志条目
    const bypass = gate.evaluatePushGate({ cmd: 'git push', cwd: '/r', env: { AGENTS_ALLOW_PUSH: '1' }, policy, runGit: head, runGitOk: ok })
    expect(bypass.decision).toBe('allow-bypass')
    expect((bypass.logEntry as Record<string, unknown>)?.bypass).toBe(true)
    // 有效结论（真实 tmp 仓落盘）→ allow-review
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pushgate-eval-'))
    try {
      fs.mkdirSync(path.join(dir, '.agents', 'orchestrator', 'push-review'), { recursive: true })
      fs.writeFileSync(
        path.join(dir, '.agents', 'orchestrator', 'push-review', 'latest.json'),
        JSON.stringify({ schema: 'push-verdict/1', verdict: 'pass', head: 'a'.repeat(40), reviewed_at: new Date().toISOString() }),
      )
      expect(gate.evaluatePushGate({ cmd: 'git push origin develop', cwd: dir, policy, runGit: head, runGitOk: ok }).decision).toBe('allow-review')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('loadPushArtifact：schema/verdict/超期/head 四道要件逐项判否', () => {
    const now = Date.now()
    const dirs: string[] = []
    const mk = (patch: Record<string, unknown>) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pushgate-art-'))
      dirs.push(dir)
      fs.mkdirSync(path.join(dir, '.agents', 'orchestrator', 'push-review'), { recursive: true })
      const art = { schema: 'push-verdict/1', verdict: 'pass', head: 'a'.repeat(40), reviewed_at: new Date(now).toISOString(), ...patch }
      fs.writeFileSync(path.join(dir, '.agents', 'orchestrator', 'push-review', 'latest.json'), JSON.stringify(art))
      return dir
    }
    try {
      const good = mk({})
      expect(gate.loadPushArtifact(good, now, () => 'a'.repeat(40)).ok).toBe(true)
      expect(gate.loadPushArtifact(mk({ schema: 'x' }), now, () => 'a'.repeat(40)).ok).toBe(false)
      expect(gate.loadPushArtifact(mk({ verdict: 'fail' }), now, () => 'a'.repeat(40)).ok).toBe(false)
      expect(gate.loadPushArtifact(mk({ reviewed_at: new Date(now - 25 * 3600 * 1000).toISOString() }), now, () => 'a'.repeat(40)).ok).toBe(false)
      expect(gate.loadPushArtifact(mk({}), now, () => 'b'.repeat(40)).ok).toBe(false)
      // cwd 不在仓库内（读不到文件）视为无
      expect(gate.loadPushArtifact(path.join(os.tmpdir(), 'pushgate-nonrepo-xyz'), now).ok).toBe(false)
    } finally {
      for (const d of dirs) fs.rmSync(d, { recursive: true, force: true })
    }
  })
})
