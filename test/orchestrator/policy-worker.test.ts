// policy-worker.mjs 是 PreToolUse hook：stdin 收 JSON、exit 2 = 拦截。
// 以子进程方式测端到端行为（裁决走 policy.mjs 的 evaluateCommand；
// cwd 指向临时目录，让审计日志落在临时目录、测试后清理）。

import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readAudit } from '../../.agents/scripts/policy.mjs'

const HOOK = path.resolve(process.cwd(), '.agents', 'hooks', 'policy-worker.mjs')

/** 跑 hook（cwd=临时目录，拦截/放行审计都写进临时目录）。 */
function runHook(command: string, tool = 'Bash'): { exit: number; auditDir: string } {
  const auditDir = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-worker-'))
  const r = spawnSync('node', [HOOK], {
    cwd: auditDir,
    input: JSON.stringify({ tool_name: tool, tool_input: { command } }),
    encoding: 'utf8',
    stdio: ['pipe', 'ignore', 'ignore'],
  })
  return { exit: r.status ?? 1, auditDir }
}

function hookVerdict(command: string, tool = 'Bash'): number {
  const { exit, auditDir } = runHook(command, tool)
  fs.rmSync(auditDir, { recursive: true, force: true })
  return exit
}

describe('policy-worker hook > 红线拦截（exit 2）', () => {
  it('git push / git tag / npm publish 全拦', () => {
    expect(hookVerdict('git push origin feature/x')).toBe(2)
    expect(hookVerdict('git -C repo push origin main')).toBe(2)
    expect(hookVerdict('git tag -a v1.0 -m v1.0')).toBe(2)
    expect(hookVerdict('npm publish')).toBe(2)
  })

  it('kill/stop 8687 或 8890 相关进程拦', () => {
    expect(hookVerdict('kill -9 $(lsof -t -i :8687)')).toBe(2)
    expect(hookVerdict('pkill -f "gateway --port 8687"')).toBe(2)
    expect(hookVerdict('taskkill /pid 123 /F  # 8687 gateway')).toBe(2)
    expect(hookVerdict('gateway stop 8890')).toBe(2)
  })

  it('启动监听受保护端口拦', () => {
    expect(hookVerdict('node src/cli.ts --sea-gateway --port 8687')).toBe(2)
  })
})

describe('policy-worker hook > 合法操作放行（exit 0）', () => {
  it('日常开发命令全放行', () => {
    expect(hookVerdict('git add -A')).toBe(0)
    expect(hookVerdict('git commit -m "fix"')).toBe(0)
    expect(hookVerdict('git diff develop...HEAD')).toBe(0)
    expect(hookVerdict('npm test')).toBe(0)
    expect(hookVerdict('npm run build')).toBe(0)
  })

  it('只读探查受保护端口放行（诊断需要）', () => {
    expect(hookVerdict('lsof -nP -iTCP:8687 -sTCP:LISTEN')).toBe(0)
    expect(hookVerdict('gateway status')).toBe(0)
    expect(hookVerdict('gateway logs 8687')).toBe(0)
  })

  it('普通测试端口 18990 不受影响', () => {
    expect(hookVerdict('node src/cli.ts --port 18990')).toBe(0)
  })

  it('非 Bash 工具不拦截', () => {
    expect(hookVerdict('随便什么内容', 'Edit')).toBe(0)
  })
})

describe('policy-worker hook > 拦截审计（策略守护完整版）', () => {
  it('拦截与放行都写审计日志，含 hook/裁决/原因/目标', () => {
    const { auditDir } = runHook('git push origin main')
    const { auditDir: dir2 } = runHook('npm test')
    const events = [...readAudit(path.join(auditDir, '.agents', 'policy', 'audit.jsonl')), ...readAudit(path.join(dir2, '.agents', 'policy', 'audit.jsonl'))]
    const blocked = events.find((e) => e.decision === 'blocked')
    const allowed = events.find((e) => e.decision === 'allowed')
    expect(blocked).toMatchObject({ hook: 'policy-worker', tool: 'Bash', decision: 'blocked' })
    expect(blocked.reason).toContain('git push')
    expect(blocked.target).toBe('git push origin main')
    expect(allowed?.decision).toBe('allowed')
    fs.rmSync(auditDir, { recursive: true, force: true })
    fs.rmSync(dir2, { recursive: true, force: true })
  })
})
