// 海图改正测试（借鉴清单 B4，Notices to Mariners 的 Dockmaster 版）：
// usage() 的顶层子命令清单必须与 .agents/workflows/orchestrator.md 手册保持一致——
// 新增子命令而手册没跟时在此红灯，防「文档说 A、代码跑 B」的海图漂移。

import { describe, expect, it } from 'vitest'
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = process.cwd()
const ORCH = path.join(ROOT, '.agents', 'scripts', 'orchestrator.mjs')
const MANUAL = path.join(ROOT, '.agents', 'workflows', 'orchestrator.md')

function usageCommands(): string[] {
  const help = execSync(`node "${ORCH}" help`, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  // usage() 的命令行一律两空格缩进 + 小写命令名开头（如 "  submit <card.md>"）
  const cmds = help
    .split('\n')
    .map((l) => /^ {2}([a-z][a-z-]*)\b/.exec(l)?.[1])
    .filter((c): c is string => Boolean(c))
  return [...new Set(cmds)]
}

describe('orchestrator 海图改正 > usage 与手册一致性', () => {
  it('usage() 每个顶层子命令都出现在 orchestrator.md 手册', () => {
    const cmds = usageCommands()
    expect(cmds.length).toBeGreaterThan(15) // 命令族整体在场，防解析回归
    const manual = fs.readFileSync(MANUAL, 'utf8')
    const missing = cmds.filter((c) => !new RegExp(`\`?${c}\`?`).test(manual))
    expect(missing).toEqual([])
  })

  it('手册速查表（自主模式/核心闭环）也覆盖 usage 命令——速查是日常入口，漂移更致命', () => {
    const manual = fs.readFileSync(MANUAL, 'utf8')
    // 速查区 = 「## 速查」到「详细机制按需查」之间
    const quick = /## 速查[\s\S]*?详细机制按需查/.exec(manual)?.[0] ?? ''
    expect(quick).toContain('## 速查')
    for (const c of ['submit', 'run', 'drain', 'status', 'scan', 'propose', 'nightly', 'watch', 'stats', 'follow', 'drill']) {
      expect(quick).toContain(c)
    }
  })
})
