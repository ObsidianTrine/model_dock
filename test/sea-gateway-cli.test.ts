// --sea-gateway 分支手工解析 --port 的校验（2026-11-12 审查 F12）：值缺失/非数字/越界直接
// exit(1) + 可操作报错（带修复建议），不再把 NaN 传进 startForeground 以 ERR_SOCKET_BAD_PORT
// 裸栈收场。分支是 cli.ts 顶层副作用（命中即起网关），无法进程内测——走 CLI 子进程 + 独立沙箱
// （reset.test.ts 同配方）。报错落 logs/daemon-<date>.log（本分支入口 redirectDaemonStderrToLog
// 已接管 fd 2），断言读日志文件而非子进程 stderr。只测失败路径：合法端口会真的起网关并阻塞，
// 快乐路径由 daemon/autostart 既有套件覆盖。

import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fakeHome, REPO_ROOT, TSX_LOADER } from './helpers.js'

const CLI_ENTRY = path.join(REPO_ROOT, 'src', 'cli.ts')

function runSeaGateway(sandbox: string, args: string[]): { status: number; daemonLog: string } {
  // 显式标注 ProcessEnv：TS7 对 spread 字面量的推断收窄成只剩显式键（索引签名丢失），
  // delete env.MODELRDOCK_HOME 会报 TS2551（noderuntime.ts:62 同款惯例）
  const env: NodeJS.ProcessEnv = { ...process.env, MODELRDOCK_FAKE_HOME: sandbox }
  delete env.MODELRDOCK_HOME
  const r = spawnSync(process.execPath, ['--import', TSX_LOADER, CLI_ENTRY, '--sea-gateway', ...args], {
    cwd: sandbox,
    env,
    encoding: 'utf8',
    timeout: 120_000,
    // stdio ignore = 生产 daemon 拉起形态（spawnDaemonAndWait 同款）。管道 stderr 下 daemon 的
    // stderr 接管会把 net.Socket 误当 SyncWriteStream 重绑（既有边角，生产形态不触发），
    // 报错反而不落 daemon 日志；ignore 下接管走 SyncWriteStream 正轨
    stdio: 'ignore',
  })
  // stderr 已重定向：报错正文在沙箱 logs/daemon-*.log
  const logDir = path.join(sandbox, '.modeldock', 'logs')
  const daemonLog = fs.existsSync(logDir)
    ? fs.readdirSync(logDir).filter((f) => f.startsWith('daemon-')).map((f) => fs.readFileSync(path.join(logDir, f), 'utf8')).join('\n')
    : ''
  return { status: r.status ?? -1, daemonLog }
}

describe('--sea-gateway --port 校验（值缺失/非数字/越界 → 可操作报错后退出）', () => {
  it('--port 缺值（旗标为最后一个参数）：exit(1)，报错落 daemon 日志，网关未拉起', () => {
    const h = fakeHome()
    try {
      const { status, daemonLog } = runSeaGateway(h.home, ['--port'])
      expect(status).toBe(1)
      expect(daemonLog).toContain('--port')
      expect(daemonLog).toContain('1-65535')
      expect(daemonLog).toContain('--sea-gateway --port 8687') // 修复建议示例在报错里
      expect(fs.existsSync(path.join(h.home, '.modeldock', 'gateway.json'))).toBe(false)
    } finally {
      h.restore()
    }
  })

  it('--port 非数字：exit(1)，报错带回原值', () => {
    const h = fakeHome()
    try {
      const { status, daemonLog } = runSeaGateway(h.home, ['--port', 'abc'])
      expect(status).toBe(1)
      expect(daemonLog).toContain('abc')
      expect(daemonLog).toContain('1-65535')
    } finally {
      h.restore()
    }
  })

  it('--port 越界（0 与 70000）：exit(1)', () => {
    const h = fakeHome()
    try {
      expect(runSeaGateway(h.home, ['--port', '0']).status).toBe(1)
      expect(runSeaGateway(h.home, ['--port', '70000']).status).toBe(1)
    } finally {
      h.restore()
    }
  })
})
