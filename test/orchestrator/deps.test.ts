// installWorkspaceDeps 单元测试（deps.mjs 自 orchestrator.mjs 抽出，spawnFn 可注入——
// orchestrator.mjs 顶层即执行 main()，不能直接 import）。重点：Windows 上 npm 是 .cmd
// 包装，spawnSync 直调 ENOENT，必须按平台补 shell（与 gates.mjs runCmd、claudeAvailable 同款）。

import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { installWorkspaceDeps } from '../../.agents/scripts/orchestrator/deps.mjs'

function mkWorktree(withLock = true, withModules = false): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-deps-'))
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 't', version: '0.0.0' }))
  if (withLock) fs.writeFileSync(path.join(dir, 'package-lock.json'), JSON.stringify({ name: 't', lockfileVersion: 3, packages: {} }))
  if (withModules) fs.mkdirSync(path.join(dir, 'node_modules'))
  return dir
}

interface SpawnCall {
  cmd: string
  args: string[]
  opts: Record<string, unknown>
}

function recordingSpawn(calls: SpawnCall[]) {
  return ((_cmd: string, _args: string[], _opts: Record<string, unknown>) => {
    calls.push({ cmd: _cmd, args: _args, opts: _opts })
    return { status: 0 }
  }) as never
}

describe('orchestrator deps > installWorkspaceDeps', () => {
  it('win32 传 shell:true（npm 是 .cmd 包装，直调 ENOENT）；非 win32 不带 shell（行为不变）', () => {
    const calls: SpawnCall[] = []
    const dir = mkWorktree()
    try {
      installWorkspaceDeps(dir, 't1', { spawnFn: recordingSpawn(calls) })
      expect(calls).toHaveLength(1)
      expect(calls[0].cmd).toBe('npm')
      expect(calls[0].args).toEqual(['ci', '--no-fund', '--no-audit'])
      expect(calls[0].opts.cwd).toBe(dir)
      expect(calls[0].opts.stdio).toBe('inherit')
      if (process.platform === 'win32') expect(calls[0].opts.shell).toBe(true)
      else expect(calls[0].opts.shell).toBeFalsy()

      // 另一平台的分支也显式锁定：stub process.platform 后 shell 必须不带
      const desc = Object.getOwnPropertyDescriptor(process, 'platform')!
      const flipped = process.platform === 'win32' ? 'linux' : 'win32'
      Object.defineProperty(process, 'platform', { value: flipped })
      try {
        const dir2 = mkWorktree()
        try {
          const calls2: SpawnCall[] = []
          installWorkspaceDeps(dir2, 't2', { spawnFn: recordingSpawn(calls2) })
          expect(calls2[0].opts.shell).toBe(flipped === 'win32' ? true : false)
        } finally {
          fs.rmSync(dir2, { recursive: true, force: true })
        }
      } finally {
        Object.defineProperty(process, 'platform', desc)
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('缺 lock 或已有 node_modules：跳过安装（不 spawn）', () => {
    const noLock = mkWorktree(false)
    const hasModules = mkWorktree(true, true)
    try {
      const calls: SpawnCall[] = []
      installWorkspaceDeps(noLock, 't3', { spawnFn: recordingSpawn(calls) })
      installWorkspaceDeps(hasModules, 't4', { spawnFn: recordingSpawn(calls) })
      expect(calls).toHaveLength(0)
    } finally {
      fs.rmSync(noLock, { recursive: true, force: true })
      fs.rmSync(hasModules, { recursive: true, force: true })
    }
  })

  it('spawn 非 0：走 die 路径（注入版抛错，附手动 npm ci 指引）', () => {
    const dir = mkWorktree()
    try {
      const fail = ((_cmd: string, _args: string[], _opts: Record<string, unknown>) => ({ status: 7 })) as never
      expect(() => installWorkspaceDeps(dir, 't5', { spawnFn: fail, die: (msg: string) => { throw new Error(msg) } })).toThrow(/依赖安装失败/)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
