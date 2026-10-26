// policy-dispatch 测试：机器级 Bash 红线 dispatcher 端到端（子进程跑真实 hook，无 mock）。
// 覆盖：受保护项目拦截/放行、审计落点随事件 cwd、无 .agents 直通、ORCH_POLICY_ENFORCE 门控、
// 坏 JSON/空命令容错、policy.mjs 损坏 fail-open。

import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { mkRepo, git } from './helpers.js'

const WORKTREE_ROOT = path.resolve(process.cwd()) // vitest 的 cwd = 仓库根（worktree 内）
const DISPATCHER = path.join(WORKTREE_ROOT, '.agents', 'hooks', 'policy-dispatch.mjs')

interface RunResult {
  status: number
  stdout: string
  stderr: string
}

/** 跑 dispatcher：stdin 喂 hook 事件 JSON，env 可覆盖（默认带 ORCH_POLICY_ENFORCE=1；undefined = 删键）。 */
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

describe('policy-dispatch > 受保护项目（mkRepo 夹具自带 .agents/scripts/policy.mjs）', () => {
  it('发布动作拦截（exit 2 + stderr 指引）；普通命令放行（exit 0）', () => {
    const repo = mkRepo()
    try {
      const blocked = runDispatch(bashEvent(repo.root, 'git push origin main'))
      expect(blocked.status).toBe(2)
      expect(blocked.stderr).toContain('[policy-dispatch] 已拦截')
      expect(blocked.stderr).toContain('git push')

      const allowed = runDispatch(bashEvent(repo.root, 'npm test'))
      expect(allowed.status).toBe(0)
      expect(allowed.stderr).not.toContain('已拦截')
    } finally {
      repo.cleanup()
    }
  })

  it('受保护端口拦截遵循项目 workflow.json（夹具未配 protectedPorts → 不启用端口红线）', () => {
    const repo = mkRepo()
    try {
      // mkRepo 的 workflow.json 无 protectedPorts → 端口红线关闭，仅发布红线生效
      expect(runDispatch(bashEvent(repo.root, 'node server.js --port 8687')).status).toBe(0)
      // 给夹具配上端口后同一命令被拦
      const wfPath = path.join(repo.root, '.agents', 'workflow.json')
      const wf = JSON.parse(fs.readFileSync(wfPath, 'utf8'))
      wf.protectedPorts = ['8687']
      wf.listenCommandNames = ['my-cli']
      fs.writeFileSync(wfPath, JSON.stringify(wf))
      expect(runDispatch(bashEvent(repo.root, 'node server.js --port 8687')).status).toBe(2)
      expect(runDispatch(bashEvent(repo.root, 'my-cli --port 8687')).status).toBe(2)
    } finally {
      repo.cleanup()
    }
  })

  it('审计随事件 cwd 落到该项目（process.chdir 生效），hook 名 policy-dispatch', () => {
    const repo = mkRepo()
    try {
      runDispatch(bashEvent(repo.root, 'git tag -a v9.9.9 -m x'))
      const auditFile = path.join(repo.root, '.agents', 'policy', 'audit.jsonl')
      expect(fs.existsSync(auditFile)).toBe(true)
      const last = fs.readFileSync(auditFile, 'utf8').trim().split('\n').pop() ?? ''
      const entry = JSON.parse(last)
      expect(entry.hook).toBe('policy-dispatch')
      expect(entry.decision).toBe('blocked')
      expect(entry.target).toContain('git tag')
    } finally {
      repo.cleanup()
    }
  })
})

describe('policy-dispatch > 直通与容错（fail-open 语义）', () => {
  it('无 .agents/ 的目录直通（exit 0）', () => {
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-bare-'))
    try {
      expect(runDispatch(bashEvent(bare, 'git push origin main')).status).toBe(0)
    } finally {
      fs.rmSync(bare, { recursive: true, force: true })
    }
  })

  it('ORCH_POLICY_ENFORCE 未设 → 日常会话直通（连受保护项目也不裁决）', () => {
    const repo = mkRepo()
    try {
      const r = runDispatch(bashEvent(repo.root, 'git push origin main'), { ORCH_POLICY_ENFORCE: undefined })
      expect(r.status).toBe(0)
    } finally {
      repo.cleanup()
    }
  })

  it('坏 JSON / 空命令 / 无 tool_input → exit 0', () => {
    expect(runDispatch('{ broken').status).toBe(0)
    expect(runDispatch(bashEvent(os.tmpdir(), '')).status).toBe(0)
    expect(runDispatch({ tool_name: 'Bash', cwd: os.tmpdir() }).status).toBe(0)
  })

  it('cwd 缺失 → 回落进程 cwd（spawn cwd 指向项目时仍裁决）', () => {
    const repo = mkRepo()
    try {
      const r = spawnSync('node', [DISPATCHER], {
        input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git push origin main' } }),
        encoding: 'utf8',
        cwd: repo.root,
        env: { ...process.env, ORCH_POLICY_ENFORCE: '1' },
      })
      expect(r.status).toBe(2)
    } finally {
      repo.cleanup()
    }
  })

  it('项目 policy.mjs 损坏 → fail-open 放行 + stderr 告警（不卡死会话）', () => {
    const repo = mkRepo()
    try {
      fs.writeFileSync(path.join(repo.root, '.agents', 'scripts', 'policy.mjs'), 'export function broken( {', 'utf8')
      const r = runDispatch(bashEvent(repo.root, 'git push origin main'))
      expect(r.status).toBe(0)
      expect(r.stderr).toContain('委托')
    } finally {
      repo.cleanup()
    }
  })
})
