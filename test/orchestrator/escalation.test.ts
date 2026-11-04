// escalation 升级链测试（借鉴清单分级审批落地）：shouldEscalatePrompt 纯函数矩阵 +
// resolveEscalation 配置解析 + 集成（2026-11 D17 起：大 prompt 先落文件收缩，escalation
// 换船退为「收缩体仍超限」的最后兜底——常规路径不再触发，见集成 describe 头注）。

import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { shouldEscalatePrompt } from '../../.agents/scripts/orchestrator/escalation.mjs'
import { loadWorkflowConfig } from '../../.agents/scripts/workflow-config.mjs'
import { ZCODE_PROMPT_LIMIT } from '../../.agents/scripts/orchestrator/backends/zcode-headless.mjs'
import { cardText, eventsOf, mkRepo, readCard, runOrch, tryOrch } from './helpers.js'

function tmpCfg(raw: unknown): ReturnType<typeof loadWorkflowConfig> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-esc-'))
  try {
    fs.mkdirSync(path.join(dir, '.agents'), { recursive: true })
    fs.writeFileSync(path.join(dir, '.agents', 'workflow.json'), JSON.stringify(raw))
    return loadWorkflowConfig(dir)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

const CFG_ON = {
  escalation: { enabled: true, fallbackBackend: 'claude-headless' },
}

describe('escalation > shouldEscalatePrompt 纯函数矩阵', () => {
  it('全条件满足 → 升档到 fallback', () => {
    const r = shouldEscalatePrompt({ backend: 'zcode-headless', promptLen: ZCODE_PROMPT_LIMIT + 1, cfg: CFG_ON })
    expect(r).toEqual({ escalate: true, to: 'claude-headless', reason: expect.stringContaining('字符') })
  })

  it('任一条件不满足都不升档：未启用 / 非 zcode / 未超限 / fallback 未配或自环', () => {
    expect(shouldEscalatePrompt({ backend: 'zcode-headless', promptLen: ZCODE_PROMPT_LIMIT + 1, cfg: { escalation: { enabled: false, fallbackBackend: 'claude-headless' } } }).escalate).toBe(false)
    expect(shouldEscalatePrompt({ backend: 'claude-headless', promptLen: ZCODE_PROMPT_LIMIT + 1, cfg: CFG_ON }).escalate).toBe(false)
    expect(shouldEscalatePrompt({ backend: 'zcode-headless', promptLen: ZCODE_PROMPT_LIMIT, cfg: CFG_ON }).escalate).toBe(false) // 恰达上限不算超
    expect(shouldEscalatePrompt({ backend: 'zcode-headless', promptLen: ZCODE_PROMPT_LIMIT + 1, cfg: {} }).escalate).toBe(false)
    expect(shouldEscalatePrompt({ backend: 'zcode-headless', promptLen: ZCODE_PROMPT_LIMIT + 1, cfg: { escalation: { enabled: true } } }).escalate).toBe(false)
    expect(
      shouldEscalatePrompt({ backend: 'zcode-headless', promptLen: ZCODE_PROMPT_LIMIT + 1, cfg: { escalation: { enabled: true, fallbackBackend: 'zcode-headless' } } }).escalate,
    ).toBe(false) // 自环防护
  })

  it('ZCODE_PROMPT_LIMIT=30000：与 zcode 后端 buildZcodeArgs 校验同口径', () => {
    expect(ZCODE_PROMPT_LIMIT).toBe(30_000)
  })
})

describe('escalation > workflow.json 配置解析', () => {
  it('缺省全关（行为回归底线）；显式开启生效；非法值回落', () => {
    expect(tmpCfg({}).escalation).toEqual({ enabled: false, fallbackBackend: 'claude-headless' })
    expect(tmpCfg({ escalation: { enabled: true, fallbackBackend: 'zcode-headless' } }).escalation).toEqual({ enabled: true, fallbackBackend: 'zcode-headless' })
    expect(tmpCfg({ escalation: 'yes' }).escalation.enabled).toBe(false)
    expect(tmpCfg({ escalation: { enabled: 'on' } }).escalation).toEqual({ enabled: false, fallbackBackend: 'claude-headless' })
  })
})

describe('escalation > 集成（D17 大 prompt 落文件后，escalation 退为兜底）', () => {
  // 2026-11 D17：worker prompt 超 20k 先落 logs/<id>/prompt-full.md、正文收缩为文件引用
  // + 摘要——30k argv 上限在常规路径不再触达，escalation 换船只在「收缩体仍超限」的异常
  // 配置下兜底。下列集成测试按新语义断言；换船判定逻辑本身由上方纯函数矩阵锁定。
  function bigCard(repo: string, id: string): string {
    // 背景段 ~28k 字符：把装配后的 prompt 顶过 20000（mkRepo 的 AGENTS/playbook 很小）
    const cardFile = path.join(repo, `card-${id}.md`)
    const filler = '历史背景填充段，用于把 prompt 顶过落文件阈值。'.repeat(1200)
    fs.writeFileSync(
      cardFile,
      cardText({ id, files_hint: ['docs/**'] }, `测试目标。`) + `\n\n# 背景\n${filler}\n`,
    )
    return cardFile
  }

  it('大卡照常交付（D17）：prompt_file_ref 留痕 + 全文落 logs/<id>/prompt-full.md + 不再触发换船', () => {
    const repo = mkRepo({ extra: { escalation: { enabled: true, fallbackBackend: 'mock' } } })
    try {
      const cardFile = bigCard(repo.root, 'esc-a')
      runOrch(repo.root, `submit "${cardFile}"`)
      runOrch(repo.root, 'run esc-a --backend mock --review-backend mock')
      const ev = eventsOf(repo.root, 'esc-a')
      const ref = ev.find((e) => e.type === 'prompt_file_ref')
      expect(ref).toBeTruthy()
      expect(Number(ref!.chars)).toBeGreaterThan(20_000)
      expect(Number(ref!.threshold)).toBe(20_000)
      const fullPath = String(ref!.path)
      expect(fs.existsSync(fullPath)).toBe(true)
      expect(fs.readFileSync(fullPath, 'utf8')).toContain('历史背景填充段') // 全文（含背景段）在文件里
      expect(ev.some((e) => e.type === 'engine_escalated')).toBe(false) // 收缩体远小于 30k，换船兜底不触发
      expect(readCard(repo.root, 'awaiting-human', 'esc-a')).toBeTruthy() // 任务照常交付
    } finally {
      repo.cleanup()
    }
  }, 120_000)

  it('zcode 船大卡：不再因 prompt 过大被拒（D17 抢在换船/硬失败之前；CLI 不可用才 blocked）', () => {
    const repo = mkRepo({ workerBackend: 'zcode-headless', extra: { escalation: { enabled: true, fallbackBackend: 'mock' } } })
    try {
      const cardFile = bigCard(repo.root, 'esc-z')
      runOrch(repo.root, `submit "${cardFile}"`)
      // ORCH_ZCODE_CLI 指向不存在文件：spawn 必拒（确定性，且与机器是否装 zcode 无关）——
      // 旧语义这里会先撞「prompt 过大」；D17 后 prompt 已收缩，spawn 真正走到 CLI 定位
      const out = tryOrch(repo.root, 'run esc-z --review-backend mock', { ORCH_ZCODE_CLI: path.join(repo.root, 'no-such-zcode.cjs') })
      expect(out.status).not.toBe(0) // die = 卡已安全落 blocked，零浪费
      expect(out.stderr).toContain('ZCode CLI 不可用')
      expect(out.stderr).not.toContain('prompt 过大') // D17：30k 硬失败不再是常规路径
      expect(readCard(repo.root, 'blocked', 'esc-z')).toBeTruthy()
      const ev = eventsOf(repo.root, 'esc-z')
      expect(ev.some((e) => e.type === 'engine_escalated')).toBe(false) // 收缩后未超限，不换船
      expect(ev.some((e) => e.type === 'prompt_file_ref')).toBe(true)
    } finally {
      repo.cleanup()
    }
  }, 120_000)
})
