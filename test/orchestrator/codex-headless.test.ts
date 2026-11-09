// codex-headless 后端单测（codex-catalog-ship 卡，2026-11-09）：纯函数组装 + ORCH_CODEX_CLI
// 桩 e2e。红线语义锚点：worker=workspace-write（沙箱默认禁网 → push/publish 物理不可达）、
// reviewer/researcher=read-only（fail-closed）。

import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  buildCodexArgs,
  codexCliSpec,
  codexHeadlessBackend,
  codexSpawnInvocation,
  usageFromEvent,
} from '../../.agents/scripts/orchestrator/backends/codex-headless.mjs'
import { resolveReviewBackendName as staticRef } from '../../.agents/scripts/orchestrator/backends/claude-headless.mjs'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'codex-backend-test-'))

describe('buildCodexArgs > 沙箱即红线', () => {
  it('worker：workspace-write（默认禁网，push/publish 物理不可达）；prompt 走 stdin（-）', () => {
    const args = buildCodexArgs({ lastMessageFile: '/tmp/last.txt' })
    expect(args[0]).toBe('exec')
    expect(args).toContain('--json')
    expect(args).toContain('--skip-git-repo-check')
    expect(args).toContain('workspace-write')
    expect(args[args.length - 1]).toBe('-')
    expect(args).not.toContain('-m') // 未点名模型 → codex config 缺省（路由烤入值）
  })

  it('reviewer：read-only（fail-closed，写不可能发生）', () => {
    const args = buildCodexArgs({ readonly: true, lastMessageFile: '/tmp/last.txt' })
    expect(args).toContain('read-only')
    expect(args).not.toContain('workspace-write')
  })

  it('researcher：read-only + web_search 打开 + -m 点名', () => {
    const args = buildCodexArgs({ web: true, model: 'mimo-v2.6-pro', lastMessageFile: '/tmp/last.txt' })
    expect(args).toContain('read-only')
    const ci = args.indexOf('-c')
    expect(args[ci + 1]).toBe('tools.web_search=true')
    const mi = args.indexOf('-m')
    expect(args[mi + 1]).toBe('mimo-v2.6-pro')
  })
})

describe('codexSpawnInvocation > 平台分支', () => {
  it('unix：无 shell + detached（独立进程组供熔断杀树）', () => {
    const inv = codexSpawnInvocation('linux', 'codex', ['exec', '--json'], { cwd: '/w', envPatch: {} })
    expect(inv.cmd).toBe('codex')
    expect(inv.options.shell).toBeUndefined()
    expect(inv.options.detached).toBe(true)
    expect(inv.options.cwd).toBe('/w')
  })
  it('win32：shell 包装（npm .cmd 命中）+ 无 detached，整串化拼行（整条命令并入 cmd）', () => {
    const inv = codexSpawnInvocation('win32', 'codex', ['exec', '-o', 'a b/c.txt'], { cwd: 'C:\\w', envPatch: {} })
    expect(inv.options.shell).toBe(true)
    expect(inv.options.detached).toBe(false)
    expect(inv.cmd).toContain('exec')
    expect(inv.cmd).toContain('"a b/c.txt"')
    expect(inv.args).toEqual([])
  })
  it('envPatch 并入子进程环境（tier 凭据透传）', () => {
    const inv = codexSpawnInvocation('linux', 'codex', ['exec'], { cwd: '/w', envPatch: { MDK_TIER_TOKEN: 'x' } })
    expect(inv.options.env.MDK_TIER_TOKEN).toBe('x')
  })
})

describe('codexCliSpec > ORCH_CODEX_CLI seam', () => {
  it('未设 → PATH codex；脚本型 → 当前 node 直跑；缺失 → 不可用', () => {
    const saved = process.env.ORCH_CODEX_CLI
    try {
      delete process.env.ORCH_CODEX_CLI
      expect(codexCliSpec()).toEqual({ ok: true, cmd: 'codex', baseArgs: [] })
      const stub = path.join(tmp(), 'stub.mjs')
      fs.writeFileSync(stub, 'process.exit(0)\n')
      process.env.ORCH_CODEX_CLI = stub
      const spec = codexCliSpec()
      expect(spec.ok).toBe(true)
      expect(spec.cmd).toBe(process.execPath)
      expect(spec.baseArgs).toEqual([stub])
      process.env.ORCH_CODEX_CLI = path.join(os.tmpdir(), 'no-such-codex-bin')
      expect(codexCliSpec().ok).toBe(false)
    } finally {
      if (saved === undefined) delete process.env.ORCH_CODEX_CLI
      else process.env.ORCH_CODEX_CLI = saved
    }
  })
})

describe('resolveReviewBackendName > codex 异构次选（不破坏既有 claude↔zcode 优先序）', () => {
  const probeOf = (map) => (name) => map[name] ?? false
  it('worker=codex-headless：claude 可用 → claude；claude 不可用 → zcode', () => {
    expect(staticRef({ worker: 'codex-headless', probe: probeOf({ 'claude-headless': true, 'zcode-headless': false }) })).toEqual({ name: 'claude-headless', mode: 'heterogeneous' })
    expect(staticRef({ worker: 'codex-headless', probe: probeOf({ 'claude-headless': false, 'zcode-headless': true }) })).toEqual({ name: 'zcode-headless', mode: 'heterogeneous' })
    expect(staticRef({ worker: 'codex-headless', probe: probeOf({}) })).toEqual({ name: 'codex-headless', mode: 'fallback' })
  })
  it('worker=zcode-headless 且 claude 可用 → 仍优先 claude（既有优先序回归锚点）', () => {
    expect(staticRef({ worker: 'zcode-headless', probe: probeOf({ 'claude-headless': true, 'codex-headless': true }) })).toEqual({ name: 'claude-headless', mode: 'heterogeneous' })
  })
})

describe('usageFromEvent > 防御式解析', () => {
  it('turn.completed usage 形态与 token_count total_token_usage 形态都收', () => {
    expect(usageFromEvent({ usage: { input_tokens: 10, cached_input_tokens: 5, output_tokens: 3 } })).toEqual({ input: 10, cached: 5, output: 3 })
    expect(usageFromEvent({ info: { total_token_usage: { input_tokens: 7, output_tokens: 2 } } })).toEqual({ input: 7, cached: 0, output: 2 })
    expect(usageFromEvent({ type: 'turn.started' })).toBeNull()
    expect(usageFromEvent({ usage: 'garbage' })).toBeNull()
  })
})

describe('spawn e2e（ORCH_CODEX_CLI 桩）', () => {
  it('stdin prompt、--json 事件计账、-o 产物回读、role 标注全链', async () => {
    const dir = tmp()
    const stub = path.join(dir, 'stub-codex.mjs')
    fs.writeFileSync(
      stub,
      [
        `import fs from 'node:fs'`,
        `const args = process.argv.slice(2)`,
        `const oi = args.indexOf('-o')`,
        `const outFile = oi >= 0 ? args[oi + 1] : null`,
        `let stdin = ''`,
        `process.stdin.setEncoding('utf8')`,
        `process.stdin.on('data', (c) => { stdin += c })`,
        `process.stdin.on('end', () => {`,
        `  if (outFile) {`,
        `    fs.writeFileSync(outFile, 'STUB OK')`,
        `    if (process.env.ORCH_STUB_ARGS) fs.writeFileSync(process.env.ORCH_STUB_ARGS, JSON.stringify(args))`,
        `  }`,
        `  process.stdout.write(JSON.stringify({ type: 'token_count', info: { total_token_usage: { input_tokens: 100, cached_input_tokens: 20, output_tokens: 30 } } }) + '\\n')`,
        `  process.exit(0)`,
        `})`,
      ].join('\n')
    )
    const promptFile = path.join(dir, 'prompt.md')
    fs.writeFileSync(promptFile, '# 任务\n做一点事')
    const saved = process.env.ORCH_CODEX_CLI
    process.env.ORCH_CODEX_CLI = stub
    const events = []
    try {
      const r = await codexHeadlessBackend.spawn({
        promptFile,
        cwd: dir,
        maxTurns: 10,
        onEvent: (e) => events.push(e),
        envPatch: { ORCH_STUB_ARGS: path.join(dir, 'args.json') },
      })
      expect(r.exitCode).toBe(0)
      expect(r.output).toBe('STUB OK')
      expect(r.usage).toEqual({ tokensIn: 120, tokensOut: 30 }) // input+cached 合计入 tokensIn
      const spawned = events.find((e) => e.type === 'worker_spawned')
      expect(spawned.backend).toBe('codex-headless')
      expect(spawned.role).toBe('worker')
      expect(events.some((e) => e.type === 'budget_snapshot' && e.tokens_in === 120 && e.tokens_billable > 0)).toBe(true)
      // 桩收到的实参：sandbox 与 -o 形态回验
      const stubArgs = JSON.parse(fs.readFileSync(path.join(dir, 'args.json'), 'utf8'))
      expect(stubArgs).toContain('workspace-write')
      expect(stubArgs.filter((a) => a === '-').length).toBe(1)
    } finally {
      if (saved === undefined) delete process.env.ORCH_CODEX_CLI
      else process.env.ORCH_CODEX_CLI = saved
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reviewer 会话 role 标注为 reviewer', async () => {
    const dir = tmp()
    const stub = path.join(dir, 'stub-codex.mjs')
    fs.writeFileSync(stub, `process.exit(0)\n`)
    const promptFile = path.join(dir, 'prompt.md')
    fs.writeFileSync(promptFile, 'x')
    const saved = process.env.ORCH_CODEX_CLI
    process.env.ORCH_CODEX_CLI = stub
    const events = []
    try {
      const r = await codexHeadlessBackend.spawn({ promptFile, cwd: dir, maxTurns: 1, onEvent: (e) => events.push(e), readonly: true })
      expect(r.exitCode).toBe(0)
      expect(events.find((e) => e.type === 'worker_spawned').role).toBe('reviewer')
    } finally {
      if (saved === undefined) delete process.env.ORCH_CODEX_CLI
      else process.env.ORCH_CODEX_CLI = saved
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('ORCH_CODEX_CLI 指向不存在文件 → reject 且给可操作指引', async () => {
    const dir = tmp()
    const promptFile = path.join(dir, 'prompt.md')
    fs.writeFileSync(promptFile, 'x')
    const saved = process.env.ORCH_CODEX_CLI
    process.env.ORCH_CODEX_CLI = path.join(dir, 'no-such.mjs')
    try {
      await expect(
        codexHeadlessBackend.spawn({ promptFile, cwd: dir, maxTurns: 1, onEvent: () => {} })
      ).rejects.toThrow(/ORCH_CODEX_CLI/)
    } finally {
      if (saved === undefined) delete process.env.ORCH_CODEX_CLI
      else process.env.ORCH_CODEX_CLI = saved
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
