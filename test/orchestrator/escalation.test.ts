// escalation 升级链测试（借鉴清单分级审批落地）：shouldEscalatePrompt 纯函数矩阵 +
// resolveEscalation 配置解析 + 集成（zcode 船 prompt 超限自动切 fallback 船，留痕）。

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

describe('escalation > 集成（zcode 船 prompt 超限自动换 fallback 船）', () => {
  function bigCard(repo: string, id: string): string {
    // 背景段 ~28k 字符：把装配后的 prompt 顶过 30000（mkRepo 的 AGENTS/playbook 很小）
    const cardFile = path.join(repo, `card-${id}.md`)
    const filler = '历史背景填充段，用于把 prompt 顶过 zcode argv 上限。'.repeat(1200)
    fs.writeFileSync(
      cardFile,
      cardText({ id, files_hint: ['docs/**'] }, `测试目标。`) + `\n\n# 背景\n${filler}\n`,
    )
    return cardFile
  }

  it('开启 escalation：engine_escalated 留痕 + 任务照常跑完（fallback 船交付）', () => {
    const repo = mkRepo({ workerBackend: 'zcode-headless', extra: { escalation: { enabled: true, fallbackBackend: 'mock' } } })
    try {
      const cardFile = bigCard(repo.root, 'esc-a')
      runOrch(repo.root, `submit "${cardFile}"`)
      runOrch(repo.root, 'run esc-a --review-backend mock')
      const ev = eventsOf(repo.root, 'esc-a')
      const esc = ev.find((e) => e.type === 'engine_escalated')
      expect(esc).toMatchObject({ reason: 'prompt_oversize', from: 'zcode-headless', to: 'mock' })
      expect(readCard(repo.root, 'awaiting-human', 'esc-a')).toBeTruthy() // fallback 船交付，任务没死
    } finally {
      repo.cleanup()
    }
  }, 120_000)

  it('未开 escalation：同样的大卡直接 blocked（prompt 过大，行为回归不变）', () => {
    const repo = mkRepo({ workerBackend: 'zcode-headless' })
    try {
      const cardFile = bigCard(repo.root, 'esc-off')
      runOrch(repo.root, `submit "${cardFile}"`)
      const out = tryOrch(repo.root, 'run esc-off --review-backend mock')
      expect(out.status).not.toBe(0) // die = 卡已安全落 blocked，零浪费
      expect(out.stderr).toContain('prompt 过大')
      expect(readCard(repo.root, 'blocked', 'esc-off')).toBeTruthy()
      expect(eventsOf(repo.root, 'esc-off').some((e) => e.type === 'engine_escalated')).toBe(false)
    } finally {
      repo.cleanup()
    }
  }, 120_000)
})
