// Windows 托盘 C# 编译冒烟门禁（2026-10-30，任务卡 10 的结构性缺口）：三 OS CI 此前
// 不编译托盘，改坏 scripts/tray/ModelDockTray.cs 照样全绿，只能靠发版时 build-sea
// 兜底或本机手编。csc 必须经 .cmd 批处理调（Git Bash 直调参数斜杠被 MSYS 吞——历史坑）；
// 非 win32 平台跳过（win runner 自带 .NET Framework 4.x csc）。

import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

describe.skipIf(process.platform !== 'win32')('win 托盘 C# 编译冒烟（csc）', () => {
  it('scripts/tray/ModelDockTray.cs 经 csc 编译通过（.cmd 批处理，与 build-sea.mjs ensureWinTray 同参）', { timeout: 180_000 }, () => {
    const root = process.cwd() // vitest cwd = 仓库根（worktree 内即 worktree 根）
    const cmd = path.join(root, 'scripts', 'tray-compile-check.cmd')
    expect(fs.existsSync(cmd)).toBe(true)
    const r = spawnSync('cmd.exe', ['/d', '/s', '/c', cmd, root], { encoding: 'utf8', timeout: 150_000 })
    const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`
    expect(r.status, out).toBe(0)
    // csc /nologo 下任何警告都会打 stdout：编译门禁不允许新增警告噪音
    expect(out).not.toMatch(/warning\b|警告/i)
  })
})
