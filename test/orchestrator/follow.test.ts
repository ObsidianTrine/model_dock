// follow 直通通道测试（订阅直通）：运行中任务的中途补充指令写 inbox，会话边界
// （初始 spawn / fixup / 审查返工 / resume）由 cmdRun 读出注入 prompt 尾部。全程
// mock 后端（零外部调用）；注入点用预置 inbox + follow_up_delivered 事件断言。

import { describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { cardText, eventsOf, mkRepo, readCard, runOrch, tryOrch } from './helpers.js'

const ORCH = path.join(process.cwd(), '.agents', 'scripts', 'orchestrator.mjs')

function submitCard(repo: string, id: string, overrides: Record<string, unknown> = {}) {
  const cardFile = path.join(repo, `card-${id}.md`)
  fs.writeFileSync(cardFile, cardText({ id, ...overrides }))
  runOrch(repo, `submit "${cardFile}"`)
}

function inboxPath(repo: string, id: string) {
  return path.join(repo, '.agents', 'orchestrator', 'logs', id, 'inbox.md')
}

describe('orchestrator follow > 状态闸门', () => {
  it('pending 卡拒绝 follow：只有运行中的闭环有注入点', () => {
    const repo = mkRepo()
    try {
      submitCard(repo.root, 'f-pending')
      const r = tryOrch(repo.root, 'follow f-pending 补充一句：优先改适配器层')
      expect(r.status).not.toBe(0)
      expect(r.stderr).toContain('只有 running/')
    } finally {
      repo.cleanup()
    }
  })

  it('不存在的任务拒绝；awaiting-human 卡指向 retry --note', () => {
    const repo = mkRepo()
    try {
      const miss = tryOrch(repo.root, 'follow no-such-task hello')
      expect(miss.status).not.toBe(0)
      expect(miss.stderr).toContain('不在队列中')

      submitCard(repo.root, 'f-await')
      runOrch(repo.root, 'run f-await --backend mock') // gate L3 缺省 → 落 awaiting-human
      const r = tryOrch(repo.root, 'follow f-await 再补一句')
      expect(r.status).not.toBe(0)
      expect(r.stderr).toContain('retry --note')
    } finally {
      repo.cleanup()
    }
  })

  it('空文本拒绝', () => {
    const repo = mkRepo()
    try {
      submitCard(repo.root, 'f-empty')
      const r = tryOrch(repo.root, 'follow f-empty')
      expect(r.status).not.toBe(0)
      expect(r.stderr).toContain('用法')
    } finally {
      repo.cleanup()
    }
  })
})

describe('orchestrator follow > 运行中写入与送达', () => {
  it('running 卡 follow 成功：inbox.md 落盘 + follow_up 事件 + 闭环结束时任务正常落位', async () => {
    const repo = mkRepo()
    try {
      submitCard(repo.root, 'f-live')
      // 后台拉起闭环；mock worker 延迟 2.5s，给 follow 留出落在 running 窗口的时间
      const child = spawn(process.execPath, [ORCH, 'run', 'f-live', '--backend', 'mock'], {
        cwd: repo.root,
        env: { ...process.env, ORCH_MOCK_DELAY_MS: '2500', ORCH_MOCK_WORKER_STATUS: 'stuck' },
        stdio: 'ignore',
      })
      // 等 pending → running（cmdRun 认领即迁）
      const deadline = Date.now() + 30_000
      let running = false
      while (Date.now() < deadline) {
        try {
          readCard(repo.root, 'running', 'f-live')
          running = true
          break
        } catch {
          await new Promise((r) => setTimeout(r, 100))
        }
      }
      expect(running).toBe(true)

      const r = runOrch(repo.root, 'follow f-live 中途补充：优先跑 tests 再收尾')
      expect(r.stdout).toContain('已写入')
      expect(fs.readFileSync(inboxPath(repo.root, 'f-live'), 'utf8')).toContain('中途补充')
      const types = eventsOf(repo.root, 'f-live').map((e) => e.type)
      expect(types).toContain('follow_up')

      // 闭环自然收尾（stuck → blocked），follow 不影响原生命周期
      await new Promise<void>((resolve) => child.on('exit', () => resolve()))
      expect(readCard(repo.root, 'blocked', 'f-live')).toBeTruthy()
    } finally {
      repo.cleanup()
    }
  }, 60_000)

  it('会话边界送达：预置 inbox 后 run，follow_up_delivered 事件落盘（count 对齐条数）', () => {
    const repo = mkRepo()
    try {
      submitCard(repo.root, 'f-deliver')
      // 直接预置 inbox（follow 命令要求 running；送达逻辑与写入方式无关）
      const logsDir = path.join(repo.root, '.agents', 'orchestrator', 'logs', 'f-deliver')
      fs.mkdirSync(logsDir, { recursive: true })
      fs.writeFileSync(
        inboxPath(repo.root, 'f-deliver'),
        '\n## 2026-11-01T09:00:00.000+08:00\n第一条补充指令\n\n## 2026-11-01T09:05:00.000+08:00\n第二条补充指令\n',
      )
      runOrch(repo.root, 'run f-deliver --backend mock')
      const delivered = eventsOf(repo.root, 'f-deliver').find((e) => e.type === 'follow_up_delivered')
      expect(delivered).toMatchObject({ count: 2 })
    } finally {
      repo.cleanup()
    }
  })

  it('inbox 为空时零改动：不写 follow_up_delivered（普通 run 不受影响）', () => {
    const repo = mkRepo()
    try {
      submitCard(repo.root, 'f-clean')
      runOrch(repo.root, 'run f-clean --backend mock')
      expect(eventsOf(repo.root, 'f-clean').map((e) => e.type)).not.toContain('follow_up_delivered')
      expect(fs.existsSync(inboxPath(repo.root, 'f-clean'))).toBe(false)
    } finally {
      repo.cleanup()
    }
  })
})
