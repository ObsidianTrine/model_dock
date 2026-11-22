// dsh-headless 后端单测（dsh-ship-backend 卡，2026-11-22）：纯函数组装 + ORCH_DSH_CLI
// 桩 e2e。红线语义锚点：worker=DSH_PERMISSION_MODE workspace-write（沙箱物理拒绝
// workspace 外 file-write，fail-closed）、reviewer=read-only；hook 桥 matcher=`bash|pwsh`
// （dsh 工具名全小写，claude 字面量集内精确匹配）；无 usage 事件（wall 熔断兜底）。

import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  buildDshArgs,
  dshCliSpec,
  dshHeadlessBackend,
  dshSpawnInvocation,
  outputFromEvents,
  DSH_HOOK_MATCHER,
  writeDshHookOverlay,
} from '../../.agents/scripts/orchestrator/backends/dsh-headless.mjs'
import { resolveReviewBackendName as staticRef } from '../../.agents/scripts/orchestrator/backends/claude-headless.mjs'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-backend-test-'))

describe('buildDshArgs > headless 形态', () => {
  it('profile headless + --json + `-` stdin 占位；--patch 指向 overlay', () => {
    const args = buildDshArgs({ patchFile: '/tmp/ov.yml' })
    expect(args[0]).toBe('--profile')
    expect(args[1]).toBe('headless')
    expect(args).toContain('--json')
    const pi = args.indexOf('--patch')
    expect(args[pi + 1]).toBe('/tmp/ov.yml')
    expect(args[args.length - 1]).toBe('-')
  })
  it('无 overlay 时不带 --patch（防御：直跑形态）', () => {
    const args = buildDshArgs({})
    expect(args).not.toContain('--patch')
    expect(args[args.length - 1]).toBe('-')
  })
})

describe('writeDshHookOverlay > hook 桥即红线', () => {
  it('hooks.json matcher=bash|pwsh 且复用 policy-worker；overlay 挂 claude-code 桥', () => {
    const dir = tmp()
    try {
      const overlay = writeDshHookOverlay(dir, { cwd: '/w' })
      expect(fs.existsSync(overlay)).toBe(true)
      const yaml = fs.readFileSync(overlay, 'utf8')
      expect(yaml).toContain('dsh-hooks-claude-code')
      expect(yaml).toContain('- insert:')
      // configPath/projectDir 经 JSON.stringify 引号包裹（YAML 双引号标量，路径免转义歧义）
      expect(yaml).toContain(JSON.stringify(path.join(dir, 'hooks.json')))
      expect(yaml).toContain(JSON.stringify('/w'))
      const hooks = JSON.parse(fs.readFileSync(path.join(dir, 'hooks.json'), 'utf8'))
      const group = hooks.hooks.PreToolUse[0]
      expect(group.matcher).toBe('bash|pwsh')
      expect(group.hooks[0].command).toContain('policy-worker.mjs')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
  it('DSH_HOOK_MATCHER 契约：claude 字面量集内精确匹配（Bash|PowerShell 在 dsh 不命中）', () => {
    expect(DSH_HOOK_MATCHER).toBe('bash|pwsh')
    expect(/^[A-Za-z0-9_|]+$/.test(DSH_HOOK_MATCHER)).toBe(true)
    expect(DSH_HOOK_MATCHER.split('|')).toEqual(['bash', 'pwsh'])
  })
})

describe('dshSpawnInvocation > 平台分支', () => {
  it('unix：无 shell + detached（独立进程组供熔断杀树）', () => {
    const inv = dshSpawnInvocation('linux', 'dsh', ['--profile', 'headless'], { cwd: '/w', envPatch: {} })
    expect(inv.cmd).toBe('dsh')
    expect(inv.options.shell).toBeUndefined()
    expect(inv.options.detached).toBe(true)
    expect(inv.options.cwd).toBe('/w')
  })
  it('win32：shell 包装（npm .cmd 命中）+ 无 detached，整串化拼行', () => {
    const inv = dshSpawnInvocation('win32', 'dsh', ['--patch', 'a b/ov.yml'], { cwd: 'C:\\w', envPatch: {} })
    expect(inv.options.shell).toBe(true)
    expect(inv.options.detached).toBe(false)
    expect(inv.cmd).toContain('--patch')
    expect(inv.cmd).toContain('"a b/ov.yml"')
    expect(inv.args).toEqual([])
  })
  it('envPatch 并入子进程环境（tier 凭据透传）', () => {
    const inv = dshSpawnInvocation('linux', 'dsh', ['-'], { cwd: '/w', envPatch: { MDK_TIER_TOKEN: 'x' } })
    expect(inv.options.env.MDK_TIER_TOKEN).toBe('x')
  })
})

describe('dshCliSpec > ORCH_DSH_CLI seam', () => {
  it('未设 → PATH dsh；脚本型 → 当前 node 直跑；缺失 → 不可用', () => {
    const saved = process.env.ORCH_DSH_CLI
    try {
      delete process.env.ORCH_DSH_CLI
      expect(dshCliSpec()).toEqual({ ok: true, cmd: 'dsh', baseArgs: [] })
      const stub = path.join(tmp(), 'stub.mjs')
      fs.writeFileSync(stub, 'process.exit(0)\n')
      process.env.ORCH_DSH_CLI = stub
      const spec = dshCliSpec()
      expect(spec.ok).toBe(true)
      expect(spec.cmd).toBe(process.execPath)
      expect(spec.baseArgs).toEqual([stub])
      process.env.ORCH_DSH_CLI = path.join(os.tmpdir(), 'no-such-dsh-bin')
      expect(dshCliSpec().ok).toBe(false)
    } finally {
      if (saved === undefined) delete process.env.ORCH_DSH_CLI
      else process.env.ORCH_DSH_CLI = saved
    }
  })
})

describe('outputFromEvents > NDCL final 事件解析', () => {
  it('final.text 提取；多 final 取最后；非 JSON 行容错；无 final 返回 null', () => {
    const ndcl = [
      '非 JSON 告警行',
      JSON.stringify({ type: 'session', sessionId: 'session-x', cwd: '/w' }),
      JSON.stringify({ type: 'final', text: '第一版' }),
      JSON.stringify({ type: 'final', text: '最终答案' }),
      '',
    ].join('\n')
    expect(outputFromEvents(ndcl)).toBe('最终答案')
    expect(outputFromEvents('')).toBeNull()
    expect(outputFromEvents(JSON.stringify({ type: 'error', code: 'x', message: 'm' }))).toBeNull()
  })
})

describe('resolveReviewBackendName > dsh 异构次选（不破坏既有优先序）', () => {
  const probeOf = (map) => (name) => map[name] ?? false
  it('worker=dsh-headless：claude 可用 → claude；全不可用 → dsh 回落', () => {
    expect(staticRef({ worker: 'dsh-headless', probe: probeOf({ 'claude-headless': true }) })).toEqual({ name: 'claude-headless', mode: 'heterogeneous' })
    expect(staticRef({ worker: 'dsh-headless', probe: probeOf({ 'claude-headless': false, 'zcode-headless': true }) })).toEqual({ name: 'zcode-headless', mode: 'heterogeneous' })
    expect(staticRef({ worker: 'dsh-headless', probe: probeOf({}) })).toEqual({ name: 'dsh-headless', mode: 'fallback' })
  })
  it('worker=claude-headless：zcode/codex 全不可用而 dsh 可用 → dsh 兜底（2026-11-22 扩环）', () => {
    expect(staticRef({ worker: 'claude-headless', probe: probeOf({ 'zcode-headless': false, 'codex-headless': false, 'dsh-headless': true }) })).toEqual({ name: 'dsh-headless', mode: 'heterogeneous' })
  })
})

describe('spawn e2e（ORCH_DSH_CLI 桩）', () => {
  it('stdin prompt、--json final 回读、permission mode 注入、role 标注全链', async () => {
    const dir = tmp()
    const stub = path.join(dir, 'stub-dsh.mjs')
    fs.writeFileSync(
      stub,
      [
        `import fs from 'node:fs'`,
        `let stdin = ''`,
        `process.stdin.setEncoding('utf8')`,
        `process.stdin.on('data', (c) => { stdin += c })`,
        `process.stdin.on('end', () => {`,
        `  if (process.env.ORCH_STUB_ARGS) fs.writeFileSync(process.env.ORCH_STUB_ARGS, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), mode: process.env.DSH_PERMISSION_MODE, stdinLen: stdin.length }))`,
        `  process.stdout.write(JSON.stringify({ type: 'session', sessionId: 'session-stub' }) + '\\n')`,
        `  process.stdout.write(JSON.stringify({ type: 'final', text: 'STUB OK' }) + '\\n')`,
        `  process.exit(0)`,
        `})`,
      ].join('\n')
    )
    const promptFile = path.join(dir, 'prompt.md')
    const promptText = '# 任务\n' + 'x'.repeat(40000) // 40k 字符：stdin 无长度上限的回归锚点
    fs.writeFileSync(promptFile, promptText)
    const saved = process.env.ORCH_DSH_CLI
    process.env.ORCH_DSH_CLI = stub
    const events = []
    try {
      const r = await dshHeadlessBackend.spawn({
        promptFile,
        cwd: dir,
        maxTurns: 10, // 接受但忽略（dsh 无轮次旗标）
        onEvent: (e) => events.push(e),
        envPatch: { ORCH_STUB_ARGS: path.join(dir, 'args.json') },
      })
      expect(r.exitCode).toBe(0)
      expect(r.output).toBe('STUB OK')
      expect(r.usage).toEqual({ tokensIn: 0, tokensOut: 0 }) // 无 usage 事件：token 预算不发 snapshot
      const spawned = events.find((e) => e.type === 'worker_spawned')
      expect(spawned.backend).toBe('dsh-headless')
      expect(spawned.role).toBe('worker')
      expect(events.some((e) => e.type === 'budget_snapshot')).toBe(false)
      // 桩收到的实参与环境：headless 形态 + permission mode + stdin 全量回验
      const seen = JSON.parse(fs.readFileSync(path.join(dir, 'args.json'), 'utf8'))
      expect(seen.args).toContain('--profile')
      expect(seen.args).toContain('headless')
      expect(seen.args).toContain('--json')
      expect(seen.args).toContain('--patch')
      expect(seen.args.filter((a) => a === '-').length).toBe(1)
      expect(seen.mode).toBe('workspace-write')
      expect(seen.stdinLen).toBe(promptText.length)
      // overlay 落在桩 cwd 之外的临时目录（orch-dsh- 前缀），任务结束已清理
      const pi = seen.args.indexOf('--patch')
      expect(fs.existsSync(seen.args[pi + 1])).toBe(false)
    } finally {
      if (saved === undefined) delete process.env.ORCH_DSH_CLI
      else process.env.ORCH_DSH_CLI = saved
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reviewer 会话：role 标注 reviewer + DSH_PERMISSION_MODE=read-only', async () => {
    const dir = tmp()
    const stub = path.join(dir, 'stub-dsh.mjs')
    fs.writeFileSync(stub, `if (process.env.ORCH_STUB_ARGS) process.stdout.write(JSON.stringify({ type: 'final', text: process.env.DSH_PERMISSION_MODE }) + '\\n'); process.exit(0)\n`)
    const promptFile = path.join(dir, 'prompt.md')
    fs.writeFileSync(promptFile, 'x')
    const saved = process.env.ORCH_DSH_CLI
    process.env.ORCH_DSH_CLI = stub
    const events = []
    try {
      const r = await dshHeadlessBackend.spawn({ promptFile, cwd: dir, maxTurns: 1, onEvent: (e) => events.push(e), readonly: true, envPatch: { ORCH_STUB_ARGS: path.join(dir, 'mode.json') } })
      expect(r.output).toBe('read-only')
      expect(events.find((e) => e.type === 'worker_spawned').role).toBe('reviewer')
    } finally {
      if (saved === undefined) delete process.env.ORCH_DSH_CLI
      else process.env.ORCH_DSH_CLI = saved
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('退出码非 0 原样上抛（失败信号，turn 内失败 final 可空）', async () => {
    const dir = tmp()
    const stub = path.join(dir, 'stub-dsh.mjs')
    fs.writeFileSync(stub, `process.stdout.write(JSON.stringify({ type: 'error', code: 'llm', message: 'boom' }) + '\\n'); process.exit(1)\n`)
    const promptFile = path.join(dir, 'prompt.md')
    fs.writeFileSync(promptFile, 'x')
    const saved = process.env.ORCH_DSH_CLI
    process.env.ORCH_DSH_CLI = stub
    try {
      const r = await dshHeadlessBackend.spawn({ promptFile, cwd: dir, maxTurns: 1, onEvent: () => {} })
      expect(r.exitCode).toBe(1)
      expect(r.output).toBe('')
    } finally {
      if (saved === undefined) delete process.env.ORCH_DSH_CLI
      else process.env.ORCH_DSH_CLI = saved
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('ORCH_DSH_CLI 指向不存在文件 → reject 且给可操作指引', async () => {
    const dir = tmp()
    const promptFile = path.join(dir, 'prompt.md')
    fs.writeFileSync(promptFile, 'x')
    const saved = process.env.ORCH_DSH_CLI
    process.env.ORCH_DSH_CLI = path.join(dir, 'no-such.mjs')
    try {
      await expect(
        dshHeadlessBackend.spawn({ promptFile, cwd: dir, maxTurns: 1, onEvent: () => {} })
      ).rejects.toThrow(/ORCH_DSH_CLI/)
    } finally {
      if (saved === undefined) delete process.env.ORCH_DSH_CLI
      else process.env.ORCH_DSH_CLI = saved
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
