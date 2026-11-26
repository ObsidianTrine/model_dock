// policy-worker.mjs 是 PreToolUse hook：stdin 收 JSON、exit 2 = 拦截。
// 以子进程方式测端到端行为（裁决走 policy.mjs 的 evaluateCommand）。
// hook 从 mkRepo 工具链临时仓运行：policy.mjs 的 audit() 自 2026-11-17 起脚本锚定
// <repoRoot>/.agents/policy/audit.jsonl（见 policy.mjs SCRIPT_ANCHORED_AUDIT_FILE），
// 跑主仓 hook 会把测试事件写进真实仓库审计日志——临时仓副本让审计落隔离目录。

import { afterAll, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readAudit } from '../../.agents/scripts/policy.mjs'
import { mkRepo } from './helpers.js'

// 工具链临时仓：自带 .agents/scripts 全量副本 + 合法 workflow.json，是裁决与审计的锚定根。
// 会话 cwd 用非 git 临时目录 → hookIntegrity/scriptsTamper 两层环境校验对无基线会话整体跳过。
// protectedPorts / listenCommandNames 显式随夹具：evaluateCommand 两键缺省空 = 不做端口
// 红线，端口类用例需与主仓 workflow.json 同配才能复现真实裁决。
const repo = mkRepo({
  extra: { protectedPorts: ['8687', '8890'], listenCommandNames: ['modeldock', 'gateway'] },
})
const HOOK = path.join(repo.root, '.agents', 'hooks', 'policy-worker.mjs')
fs.mkdirSync(path.dirname(HOOK), { recursive: true })
fs.copyFileSync(path.resolve(process.cwd(), '.agents', 'hooks', 'policy-worker.mjs'), HOOK)
afterAll(() => repo.cleanup())

/** 跑 hook（cwd=临时非 git 目录，审计随 hook 副本脚本锚定落 fixture 仓）。 */
function runHook(command: string, tool = 'Bash'): number {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-worker-'))
  try {
    const r = spawnSync('node', [HOOK], {
      cwd,
      input: JSON.stringify({ tool_name: tool, tool_input: { command } }),
      encoding: 'utf8',
      stdio: ['pipe', 'ignore', 'ignore'],
    })
    return r.status ?? 1
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true })
  }
}

describe('policy-worker hook > 红线拦截（exit 2）', () => {
  it('git push / git tag / npm publish 全拦', () => {
    expect(runHook('git push origin feature/x')).toBe(2)
    expect(runHook('git -C repo push origin main')).toBe(2)
    expect(runHook('git tag -a v1.0 -m v1.0')).toBe(2)
    expect(runHook('npm publish')).toBe(2)
  })

  it('kill/stop 8687 或 8890 相关进程拦', () => {
    expect(runHook('kill -9 $(lsof -t -i :8687)')).toBe(2)
    expect(runHook('pkill -f "gateway --port 8687"')).toBe(2)
    expect(runHook('taskkill /pid 123 /F  # 8687 gateway')).toBe(2)
    expect(runHook('gateway stop 8890')).toBe(2)
  })

  it('启动监听受保护端口拦', () => {
    expect(runHook('node src/cli.ts --sea-gateway --port 8687')).toBe(2)
  })
})

describe('policy-worker hook > 合法操作放行（exit 0）', () => {
  it('日常开发命令全放行', () => {
    expect(runHook('git add -A')).toBe(0)
    expect(runHook('git commit -m "fix"')).toBe(0)
    expect(runHook('git diff develop...HEAD')).toBe(0)
    expect(runHook('npm test')).toBe(0)
    expect(runHook('npm run build')).toBe(0)
  })

  it('只读探查受保护端口放行（诊断需要）', () => {
    expect(runHook('lsof -nP -iTCP:8687 -sTCP:LISTEN')).toBe(0)
    expect(runHook('gateway status')).toBe(0)
    expect(runHook('gateway logs 8687')).toBe(0)
  })

  it('普通测试端口 18990 不受影响', () => {
    expect(runHook('node src/cli.ts --port 18990')).toBe(0)
  })

  it('非 Bash 工具不拦截', () => {
    expect(runHook('随便什么内容', 'Edit')).toBe(0)
  })
})

describe('policy-worker hook > 拦截审计（策略守护完整版）', () => {
  it('拦截与放行都写审计日志，含 hook/裁决/原因/目标', () => {
    const auditFile = path.join(repo.root, '.agents', 'policy', 'audit.jsonl')
    // 前置裁决用例也写审计：先清累计事件，断言只对本轮两条 invocation 负责
    fs.rmSync(auditFile, { force: true })
    expect(runHook('git push origin main')).toBe(2)
    expect(runHook('npm test')).toBe(0)
    const events = readAudit(auditFile)
    const blocked = events.find((e: { decision: string }) => e.decision === 'blocked')
    const allowed = events.find((e: { decision: string }) => e.decision === 'allowed')
    expect(blocked).toMatchObject({ hook: 'policy-worker', tool: 'Bash', decision: 'blocked' })
    expect(blocked.reason).toContain('git push')
    expect(blocked.target).toBe('git push origin main')
    expect(allowed?.decision).toBe('allowed')
  })
})
