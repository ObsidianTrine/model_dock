// fastlane 轻卡快速通道测试：任务卡声明 fastlane: true 跳过 LLM 审查子循环（省最大
// 开销），门禁/红线/调试子循环/分级闸门一个不省。每个失效分支都必须有 fastlane_skipped
// 事件留痕（永不静默）。全程 mock 后端（零外部调用），集成断言为主。

import { describe, expect, it } from 'vitest'
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { cardText, eventsOf, mkRepo, readCard, runOrch } from './helpers.js'

function submitCard(repo: string, id: string, overrides: Record<string, unknown> = {}) {
  const cardFile = path.join(repo, `card-${id}.md`)
  fs.writeFileSync(cardFile, cardText({ id, ...overrides }))
  runOrch(repo, `submit "${cardFile}"`)
}

describe('orchestrator fastlane > 跳审查不跳门禁', () => {
  it('fastlane 卡：审查进程不被 spawn，review_verdict 记 skipped，直落人工闸门', () => {
    const repo = mkRepo()
    try {
      // gate L0 + 实际分级 L1（src/ 文件）：fastlane 生效（L1 不在失效档），但实际分级
      // 超 gate 上限 → 仍回人工闸门——fastlane 只省审查，不降闸门
      submitCard(repo.root, 'fl-skip', { fastlane: true, gate: 'L0', files_hint: ['src/**'] })
      runOrch(repo.root, 'run fl-skip --backend mock', { ORCH_MOCK_FILE: 'src/feat.ts' })
      const events = eventsOf(repo.root, 'fl-skip')
      const types = events.map((e) => e.type)
      expect(types).toContain('fastlane_active')
      expect(types).not.toContain('review_spawned') // 不 spawn 审查进程
      expect(types).not.toContain('fastlane_skipped') // 全程未失效
      const verdict = events.find((e) => e.type === 'review_verdict')
      expect(verdict).toMatchObject({ verdict: 'skipped', reason: 'fastlane' })
      expect(readCard(repo.root, 'awaiting-human', 'fl-skip')).toBeTruthy()
    } finally {
      repo.cleanup()
    }
  })

  it('fastlane 卡门禁失败仍进调试子循环：fixup 重跑转绿后才继续（审查照跳）', () => {
    // 有状态 testCmd：第一次跑失败（写标记），第二次起通过——标记放仓库外，不污染改动分级
    const marker = path.join(os.tmpdir(), `fastlane-gate-${process.pid}-${Date.now()}.flag`).replace(/\\/g, '/')
    const repo = mkRepo({
      testCmd: `node -e "const fs=require('fs');if(fs.existsSync('${marker}')){process.exit(0)}fs.writeFileSync('${marker}','1');process.exit(1)"`,
    })
    try {
      submitCard(repo.root, 'fl-fix', { fastlane: true, gate: 'L0', files_hint: ['docs/**'] })
      const run = runOrch(repo.root, 'run fl-fix --backend mock', { ORCH_MOCK_FILE: 'docs/notes.md' })
      const events = eventsOf(repo.root, 'fl-fix')
      const types = events.map((e) => e.type)
      // 门禁真的跑了两次：fail → debug_iteration → fixup 重跑 → pass（fastlane 不省门禁）
      expect(events.filter((e) => e.type === 'gate_result' && e.gate === 'npm_test').map((e) => e.result)).toEqual(['fail', 'pass'])
      expect(types).toContain('debug_iteration')
      // worker 被返工重跑，fastlane 每轮 worker 会话都重新声明生效
      expect(types.filter((t) => t === 'fastlane_active').length).toBe(2)
      // 第二轮门禁转绿后 fastlane 生效：审查被跳过，直接自动合并（gate L0 + 实际 L0）
      expect(types).not.toContain('review_spawned')
      expect(readCard(repo.root, 'merged', 'fl-fix')).toBeTruthy()
      expect(run.stdout).toContain('自动合并')
    } finally {
      repo.cleanup()
      fs.rmSync(marker, { force: true })
    }
  })
})

describe('orchestrator fastlane > 失效规则（都要 fastlane_skipped 留痕）', () => {
  it('实际分级 L2 的卡：fastlane 失效回常规链路（照跑审查）', () => {
    const repo = mkRepo()
    try {
      // lib/ 不在 L0 白名单也不在 src/ → classifyChange 判 L2（未识别文件保守归高）
      submitCard(repo.root, 'fl-l2', { fastlane: true, gate: 'L1', files_hint: ['lib/**'] })
      runOrch(repo.root, 'run fl-l2 --backend mock', { ORCH_MOCK_FILE: 'lib/native.js' })
      const events = eventsOf(repo.root, 'fl-l2')
      const types = events.map((e) => e.type)
      expect(types).toContain('fastlane_active') // worker 轮先按 fastlane 跑
      expect(events.find((e) => e.type === 'fastlane_skipped')).toMatchObject({ reason: 'actual_level_l2', level: 'L2' })
      expect(types).toContain('review_spawned') // 失效回常规链路：审查照跑
      const verdict = events.find((e) => e.type === 'review_verdict')
      expect(verdict?.blockers).toBe(0) // 正常 verdict，不是 skipped
      // 实际 L2 超 gate L1 上限 → 人工闸门（分级闸门原样生效）
      expect(readCard(repo.root, 'awaiting-human', 'fl-l2')).toBeTruthy()
    } finally {
      repo.cleanup()
    }
  })

  it('drift 降级期间：fastlane 失效回常规链路，且自动合并同样关闭', () => {
    const repo = mkRepo()
    try {
      fs.mkdirSync(path.join(repo.root, '.agents', 'orchestrator'), { recursive: true })
      fs.writeFileSync(
        path.join(repo.root, '.agents', 'orchestrator', 'degraded.json'),
        JSON.stringify({ degraded_at: new Date().toISOString(), reason: '测试注入：降级期' }),
      )
      submitCard(repo.root, 'fl-drift', { fastlane: true, gate: 'L0', files_hint: ['docs/**'] })
      runOrch(repo.root, 'run fl-drift --backend mock', { ORCH_MOCK_FILE: 'docs/notes.md' })
      const events = eventsOf(repo.root, 'fl-drift')
      const types = events.map((e) => e.type)
      expect(types).not.toContain('fastlane_active') // 跑前已知降级，fastlane 从未生效
      expect(events.find((e) => e.type === 'fastlane_skipped')).toMatchObject({ reason: 'drift_degraded' })
      expect(types).toContain('review_spawned')
      expect(types).not.toContain('auto_merge') // 降级保险丝不因 fastlane 松动
      expect(readCard(repo.root, 'awaiting-human', 'fl-drift')).toBeTruthy()
    } finally {
      repo.cleanup()
    }
  })

  it('gate=L3 的卡声明 fastlane：跑前即失效（reason=gate_l3），审查照跑', () => {
    const repo = mkRepo()
    try {
      submitCard(repo.root, 'fl-l3gate', { fastlane: true }) // gate 缺省 L3（全人工）
      runOrch(repo.root, 'run fl-l3gate --backend mock')
      const events = eventsOf(repo.root, 'fl-l3gate')
      const types = events.map((e) => e.type)
      expect(types).not.toContain('fastlane_active')
      expect(events.find((e) => e.type === 'fastlane_skipped')).toMatchObject({ reason: 'gate_l3' })
      expect(types).toContain('review_spawned')
      expect(readCard(repo.root, 'awaiting-human', 'fl-l3gate')).toBeTruthy()
    } finally {
      repo.cleanup()
    }
  })

  it('fastlaneAllowed:false（workflow.json）：卡声明被忽略，照跑审查（reason=disabled_by_config）', () => {
    const repo = mkRepo({ extra: { fastlaneAllowed: false } })
    try {
      submitCard(repo.root, 'fl-off', { fastlane: true, gate: 'L0', files_hint: ['docs/**'] })
      runOrch(repo.root, 'run fl-off --backend mock', { ORCH_MOCK_FILE: 'docs/notes.md' })
      const events = eventsOf(repo.root, 'fl-off')
      const types = events.map((e) => e.type)
      expect(types).not.toContain('fastlane_active')
      expect(events.find((e) => e.type === 'fastlane_skipped')).toMatchObject({ reason: 'disabled_by_config' })
      expect(types).toContain('review_spawned')
    } finally {
      repo.cleanup()
    }
  })
})

describe('orchestrator fastlane > 自动合并与卡校验', () => {
  it('L0 fastlane 卡自动合并可达：跳过审查后照走四前提自动合并进 develop', () => {
    const repo = mkRepo()
    try {
      submitCard(repo.root, 'fl-auto', { fastlane: true, gate: 'L0', files_hint: ['docs/**'] })
      const run = runOrch(repo.root, 'run fl-auto --backend mock', { ORCH_MOCK_FILE: 'docs/notes.md' })
      expect(run.stdout).toContain('自动合并')
      expect(readCard(repo.root, 'merged', 'fl-auto')).toBeTruthy()
      const events = eventsOf(repo.root, 'fl-auto')
      const types = events.map((e) => e.type)
      expect(types).toContain('fastlane_active')
      expect(types).not.toContain('review_spawned')
      expect(types).not.toContain('awaiting_human') // 全程未停人工闸门
      expect(types).toContain('auto_merge')
      const merged = events.find((e) => e.type === 'merged')
      expect(merged?.auto).toBe(true)
    } finally {
      repo.cleanup()
    }
  })

  it('fastlane 写了非法值：按 false 处理并告警（不拒绝提交，走常规链路）', () => {
    const repo = mkRepo()
    try {
      const cardFile = path.join(repo.root, 'card-fl-bad.md')
      fs.writeFileSync(cardFile, cardText({ id: 'fl-bad', fastlane: 'yes' as unknown as boolean }))
      // 告警走 console.warn（stderr）：runOrch 成功路径不回传 stderr，用 2>&1 合流捕获
      const orch = path.join(process.cwd(), '.agents', 'scripts', 'orchestrator.mjs')
      const out = execSync(`node "${orch}" submit "${cardFile}" 2>&1`, { cwd: repo.root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      expect(out).toContain('fastlane')
      expect(out).toContain('按 false 处理')
      runOrch(repo.root, 'run fl-bad --backend mock')
      const events = eventsOf(repo.root, 'fl-bad')
      const types = events.map((e) => e.type)
      expect(types).not.toContain('fastlane_active')
      expect(types).not.toContain('fastlane_skipped') // 声明等于没写，无失效事件
      expect(types).toContain('review_spawned')
    } finally {
      repo.cleanup()
    }
  })
})
