// 卡 17（harden-claude-headless-backend，2026-10-31）回归——评测考题
// 2026-10-orch-resume-backend-first-hit 复核挖出的三条缺陷：
// ① newWorkerSettingsPath 用 os.tmpdir()——旧实现 `TMPDIR ?? '/tmp'` 在 Windows 无
//    TMPDIR，回落 '/tmp' 经 path.join 落「当前盘根 \tmp」（通常不存在）→ mkdtempSync ENOENT；
// ② resolveReviewBackendName 反向防御——worker=mock + prior=真实 时旧实现会把真实
//    CLI 审查后端派给 mock 会话（烧真钱），违反「mock 零外部调用、永不异构」不变量；
// ③ writeWorkerSettings 落盘 0600——settings 可能携带 tier 凭据（settings.env 注入
//    token），0644 默认权限过宽（权限断言按平台分支：NTFS 不认 0o600）。

import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  newWorkerSettingsPath,
  resolveReviewBackendName,
  writeWorkerSettings,
} from '../../.agents/scripts/orchestrator/backends/claude-headless.mjs'

const probeOf = (map: Record<string, boolean>) => (name: string) => map[name] ?? true

describe('newWorkerSettingsPath > 临时目录锚点', () => {
  it('落盘在 os.tmpdir()（不写死 /tmp 或盘符，Windows 无 TMPDIR 也成立），目录真实存在', () => {
    const p = newWorkerSettingsPath()
    const dir = path.dirname(p)
    try {
      expect(path.basename(p)).toBe('worker-settings.json')
      expect(path.basename(dir).startsWith('orch-settings-')).toBe(true)
      // 真实 tmpdir 前缀：win32 上旧实现得到「<盘根>\tmp\orch-settings-*」，此断言即红
      expect(dir.startsWith(os.tmpdir())).toBe(true)
      expect(fs.existsSync(dir)).toBe(true)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('resolveReviewBackendName > mock 防御双向', () => {
  it("worker='mock' + prior='zcode-headless' 时仍回 mock（反向防御：mock 会话不派真实审查后端）", () => {
    expect(
      resolveReviewBackendName({ worker: 'mock', prior: 'zcode-headless', probe: probeOf({ 'zcode-headless': true }) }),
    ).toEqual({ name: 'mock', mode: 'fallback' })
    expect(
      resolveReviewBackendName({ worker: 'mock', prior: 'claude-headless', probe: probeOf({ 'claude-headless': true }) }),
    ).toEqual({ name: 'mock', mode: 'fallback' })
    // 无 probe 注入时同样不得触达真实 CLI 探测路径之外的后端
    expect(resolveReviewBackendName({ worker: 'mock', prior: 'zcode-headless' })).toEqual({ name: 'mock', mode: 'fallback' })
  })

  it('原单向防御不回归：prior=mock 且 worker=真实 → 忽略 prior 走异构/fallback', () => {
    expect(
      resolveReviewBackendName({ worker: 'claude-headless', prior: 'mock', probe: probeOf({ 'zcode-headless': true }) }),
    ).toEqual({ name: 'zcode-headless', mode: 'heterogeneous' })
    expect(
      resolveReviewBackendName({ worker: 'claude-headless', prior: 'mock', probe: probeOf({ 'zcode-headless': false }) }),
    ).toEqual({ name: 'claude-headless', mode: 'fallback' })
  })

  it('真实后端间的 prior 沿用不受防御影响（retry/resume 不换审查引擎）', () => {
    expect(
      resolveReviewBackendName({ worker: 'zcode-headless', prior: 'claude-headless', probe: probeOf({}) }),
    ).toEqual({ name: 'claude-headless', mode: 'prior' })
  })
})

describe('writeWorkerSettings > 凭据文件权限', () => {
  it('落盘 0600（settings 可能携带 tier 凭据；NTFS 不认权限位按平台分支断言）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-settings-mode-'))
    try {
      const p = path.join(dir, 'worker-settings.json')
      writeWorkerSettings(p, { ANTHROPIC_AUTH_TOKEN: 'tok-17' })
      // mode 选项在所有平台都不应影响内容正确性
      const parsed = JSON.parse(fs.readFileSync(p, 'utf8'))
      expect(parsed.env.ANTHROPIC_AUTH_TOKEN).toBe('tok-17')
      expect(parsed.hooks.PreToolUse[0].matcher).toBe('Bash|PowerShell')
      if (process.platform === 'win32') {
        // NTFS 不生效 0o600（仓库已知限制）：仅断言 mode 选项被接受、文件已落盘
        expect(fs.existsSync(p)).toBe(true)
      } else {
        expect(fs.statSync(p).mode & 0o777).toBe(0o600)
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
