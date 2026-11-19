// 后端缺省回落测试：裸跑 intent/spec（不带 --backend）不得把 undefined 直喂 getBackend
// （曾炸「未知后端 "undefined"」；历史测试全带 --backend mock 从未暴露，全链真跑实测踩中）。

import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolveBackendName, getBackend } from '../../.agents/scripts/orchestrator/backends/claude-headless.mjs'
import { mockBackend } from '../../.agents/scripts/orchestrator/backends/mock.mjs'
import { RESULT_MARKER } from '../../.agents/scripts/orchestrator/prompt.mjs'
import { readEvents } from '../../.agents/scripts/orchestrator/events.mjs'
import { mkRepo } from './helpers.js'

describe('backend 缺省回落（resolveBackendName）', () => {
  it('显式 --backend 优先；无 qdir（规划会话）缺省 claude-headless，不返回 undefined', () => {
    expect(resolveBackendName({ backend: 'mock' }, null)).toEqual({ name: 'mock', inherited: false })
    expect(resolveBackendName({}, null).name).toBe('claude-headless')
    expect(resolveBackendName({ backend: undefined }, null).name).toBe('claude-headless')
    expect(resolveBackendName({}, null).inherited).toBe(false)
  })

  it('run 场景沿用任务上次会话的后端（retry/resume 不换引擎）', () => {
    const repo = mkRepo()
    try {
      const qdir = path.join(repo.root, '.agents', 'orchestrator', 'logs', 't1')
      fs.mkdirSync(qdir, { recursive: true })
      fs.writeFileSync(path.join(qdir, 'events.jsonl'), JSON.stringify({ type: 'worker_spawned', backend: 'mock' }) + '\n')
      expect(resolveBackendName({}, qdir, readEvents)).toEqual({ name: 'mock', inherited: true })
      // 显式 --backend 覆盖沿用
      expect(resolveBackendName({ backend: 'claude-headless' }, qdir, readEvents).name).toBe('claude-headless')
    } finally {
      repo.cleanup()
    }
  })

  it('append-only 下沿用最后一次 worker_spawned（两次运行后 resume 不静默切回最初引擎）', () => {
    const repo = mkRepo()
    try {
      const qdir = path.join(repo.root, '.agents', 'orchestrator', 'logs', 't2')
      fs.mkdirSync(qdir, { recursive: true })
      // 模拟两次运行：第一次 mock，第二次 claude-headless——resume 必须沿用最后者
      fs.writeFileSync(
        path.join(qdir, 'events.jsonl'),
        JSON.stringify({ type: 'worker_spawned', backend: 'mock' }) + '\n' +
          JSON.stringify({ type: 'worker_spawned', backend: 'claude-headless' }) + '\n',
      )
      expect(resolveBackendName({}, qdir, readEvents)).toEqual({ name: 'claude-headless', inherited: true })
    } finally {
      repo.cleanup()
    }
  })

  it('回落产物始终能被 getBackend 接受（不再出现未知后端）', async () => {
    const { name } = resolveBackendName({}, null)
    await expect(getBackend(name)).resolves.toBeTruthy()
  })

  it('异构互审后 retry 不误沿用 reviewer 引擎（role=reviewer 的 spawn 不参与沿用）', () => {
    const repo = mkRepo()
    try {
      const qdir = path.join(repo.root, '.agents', 'orchestrator', 'logs', 't-reviewer')
      fs.mkdirSync(qdir, { recursive: true })
      // worker=zcode-headless 跑完 → reviewer=claude-headless 审查完：retry 必须仍沿用 zcode-headless
      fs.writeFileSync(
        path.join(qdir, 'events.jsonl'),
        JSON.stringify({ type: 'worker_spawned', role: 'worker', backend: 'zcode-headless' }) + '\n' +
          JSON.stringify({ type: 'worker_spawned', role: 'reviewer', backend: 'claude-headless' }) + '\n',
      )
      expect(resolveBackendName({}, qdir, readEvents)).toEqual({ name: 'zcode-headless', inherited: true })
    } finally {
      repo.cleanup()
    }
  })

  it('mock 后端 spawn 事件带 role：worker 会话 role=worker', async () => {
    process.env.ORCH_MOCK_TRANSIENT = '1' // 提前返回路径：只观测 worker_spawned，不写文件不提交
    try {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mock-role-'))
      try {
        const promptFile = path.join(dir, 'p.md')
        fs.writeFileSync(promptFile, '干活\n')
        const seen: Array<Record<string, unknown>> = []
        await mockBackend.spawn({ promptFile, cwd: dir, onEvent: (e) => seen.push(e) })
        expect(seen.find((e) => e.type === 'worker_spawned')?.role).toBe('worker')
      } finally {
        fs.rmSync(dir, { recursive: true, force: true })
      }
    } finally {
      delete process.env.ORCH_MOCK_TRANSIENT
    }
  })

  it('mock 后端 spawn 事件带 role：readonly=true 的审查会话 role=reviewer', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mock-role-'))
    try {
      const promptFile = path.join(dir, 'p.md')
      fs.writeFileSync(promptFile, '审查一下\nREVIEW_SUMMARY')
      const seen: Array<Record<string, unknown>> = []
      await mockBackend.spawn({ promptFile, cwd: dir, onEvent: (e) => seen.push(e), readonly: true })
      expect(seen.find((e) => e.type === 'worker_spawned')?.role).toBe('reviewer')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('mock 角色判定 > 显式契约优先（orch-mock-role-detection 卡）', () => {
  // 分支判别器：worker 分支输出 RESULT_MARKER 结果块；reviewer 分支输出 REVIEW_SUMMARY 契约行。
  // 两向断言（卡验收）：worker prompt 内嵌 REVIEW_SUMMARY 全文仍判 worker；reviewer 正常判 reviewer。
  const reviewFullText = '🔴 阻塞（1 个）\n- mock：验收标准第 1 条未实现\nREVIEW_SUMMARY: blockers=1 suggestions=0 notes=0'
  const fixupLikePrompt = `# 返工指令\n\n## 上轮审查失败输出（全文内嵌）\n\n${reviewFullText}\n\n请修复上述阻塞项后重跑门禁。`

  async function spawnOut(promptText: string, opts: Record<string, unknown> = {}): Promise<string> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mock-contract-'))
    try {
      const promptFile = path.join(dir, 'p.md')
      fs.writeFileSync(promptFile, promptText)
      const r = await mockBackend.spawn({ promptFile, cwd: dir, onEvent: () => {}, ...opts })
      return String(r.output ?? '')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }

  it('worker prompt 内嵌 REVIEW_SUMMARY 全文（fixup 嵌审查场景）+ role=worker → 仍判 worker', async () => {
    const out = await spawnOut(fixupLikePrompt, { role: 'worker' })
    expect(out).toContain(RESULT_MARKER) // worker 结果块
    expect(out).not.toContain('REVIEW_SUMMARY: blockers=') // 未被带成 reviewer 行为
  })

  it('reviewer prompt + role=reviewer → 正常判 reviewer', async () => {
    const out = await spawnOut('独立审查以下 diff……', { role: 'reviewer', readonly: true })
    expect(out).toContain('REVIEW_SUMMARY: blockers=') // reviewer 契约行
    expect(out).not.toContain(RESULT_MARKER)
  })

  it('显式未实现角色（watchdog 判定会话）不嗅探正文——含 REVIEW_SUMMARY 也落 worker 分支', async () => {
    const out = await spawnOut(fixupLikePrompt, { role: 'watchdog' })
    expect(out).toContain(RESULT_MARKER)
    expect(out).not.toContain('REVIEW_SUMMARY: blockers=')
  })

  it('未传 role（旧调用方直调）回落正文嗅探：含 REVIEW_SUMMARY 判 reviewer', async () => {
    const out = await spawnOut('审查一下\nREVIEW_SUMMARY', { readonly: true })
    expect(out).toContain('REVIEW_SUMMARY: blockers=') // 嗅探兜底语义不变
  })
})
