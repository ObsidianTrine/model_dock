// 异构审查（执行/审查分体）+ zcode-headless 后端 + ui_check 门禁。
// 纯函数矩阵用注入 probe 测（不真探 CLI）；集成测试全走 mock 后端
// （mock worker 永不异构——零外部调用前提，真实 CLI 探测不在测试路径上）。

import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {
  resolveReviewBackendName,
  getBackend,
} from '../../.agents/scripts/orchestrator/backends/claude-headless.mjs'
import { buildZcodeArgs, parseHeadlessJson, zcodeCliSpec } from '../../.agents/scripts/orchestrator/backends/zcode-headless.mjs'
import { gateUiCheck } from '../../.agents/scripts/orchestrator/gates.mjs'
import { cardText, eventsOf, mkRepo, readCard, runOrch, tryOrch } from './helpers.js'

const probeOf = (map: Record<string, boolean>) => (name: string) => map[name] ?? true

describe('resolveReviewBackendName > 解析顺序与异构矩阵', () => {
  it('显式 --review-backend 优先；same = 强制与 worker 同源', () => {
    expect(resolveReviewBackendName({ worker: 'claude-headless', explicit: 'mock' })).toEqual({ name: 'mock', mode: 'explicit' })
    expect(resolveReviewBackendName({ worker: 'zcode-headless', explicit: 'same' })).toEqual({ name: 'zcode-headless', mode: 'explicit' })
  })

  it('上次 review_spawned 的后端其次（retry/resume 不换审查引擎）；prior=mock 且 worker 已换真实后端时忽略', () => {
    expect(resolveReviewBackendName({ worker: 'claude-headless', explicit: 'mock', prior: 'zcode-headless' })).toEqual({
      name: 'mock',
      mode: 'explicit',
    })
    expect(resolveReviewBackendName({ worker: 'claude-headless', prior: 'claude-headless', probe: probeOf({ 'zcode-headless': true }) })).toEqual({
      name: 'claude-headless',
      mode: 'prior',
    })
    // mock reviewer 固定输出「无阻塞」—— worker 换真实后端后继续沿用 mock 等于静默跳过审查
    expect(resolveReviewBackendName({ worker: 'claude-headless', prior: 'mock', probe: probeOf({ 'zcode-headless': true }) })).toEqual({
      name: 'zcode-headless',
      mode: 'heterogeneous',
    })
    expect(resolveReviewBackendName({ worker: 'claude-headless', prior: 'mock', probe: probeOf({ 'zcode-headless': false }) })).toEqual({
      name: 'claude-headless',
      mode: 'fallback',
    })
  })

  it('worker=claude-headless 且 zcode 可用 → 自动异构 zcode-headless', () => {
    expect(resolveReviewBackendName({ worker: 'claude-headless', probe: probeOf({ 'zcode-headless': true }) })).toEqual({
      name: 'zcode-headless',
      mode: 'heterogeneous',
    })
  })

  it('worker=zcode-headless 且 claude 可用 → 自动异构 claude-headless', () => {
    expect(resolveReviewBackendName({ worker: 'zcode-headless', probe: probeOf({ 'claude-headless': true }) })).toEqual({
      name: 'claude-headless',
      mode: 'heterogeneous',
    })
  })

  it('异构候选 CLI 不可用 → 回落 worker 同源（fallback）', () => {
    expect(resolveReviewBackendName({ worker: 'claude-headless', probe: probeOf({ 'zcode-headless': false }) })).toEqual({
      name: 'claude-headless',
      mode: 'fallback',
    })
    expect(resolveReviewBackendName({ worker: 'zcode-headless', probe: probeOf({ 'claude-headless': false }) })).toEqual({
      name: 'zcode-headless',
      mode: 'fallback',
    })
  })

  it('mock worker 永不异构（测试零外部调用前提）', () => {
    expect(resolveReviewBackendName({ worker: 'mock' })).toEqual({ name: 'mock', mode: 'fallback' })
  })
})

describe('getBackend > 三后端注册', () => {
  it('zcode-headless 可取且名字正确；未知后端报错含允许清单', async () => {
    const zcode = await getBackend('zcode-headless')
    expect(zcode.name).toBe('zcode-headless')
    expect(typeof zcode.spawn).toBe('function')
    await expect(getBackend('bogus')).rejects.toThrow('claude-headless | zcode-headless | mock')
  })
})

describe('zcode-headless > 纯函数', () => {
  it('buildZcodeArgs：worker yolo 无 disallowed；reviewer plan + 逗号串整工具禁用', () => {
    const worker = buildZcodeArgs({ prompt: 'P', mode: 'yolo' })
    expect(worker).toEqual(['-p', 'P', '--json', '--no-color', '--mode', 'yolo'])
    const reviewer = buildZcodeArgs({ prompt: 'P', mode: 'plan', disallowed: ['Edit', 'Write', 'Bash'] })
    expect(reviewer).toContain('--mode')
    expect(reviewer).toContain('plan')
    expect(reviewer.slice(reviewer.indexOf('--disallowed-tools'))).toEqual(['--disallowed-tools', 'Edit,Write,Bash'])
  })

  it('parseHeadlessJson：正常单对象 / 混入日志行 / 垃圾输出', () => {
    const good = JSON.stringify({ response: '好的', usage: { inputTokens: 10, outputTokens: 2 } })
    expect(parseHeadlessJson(good)?.response).toBe('好的')
    expect(parseHeadlessJson(`log line\n{"level":"info"}\n${good}`)?.response).toBe('好的')
    expect(parseHeadlessJson('不是 JSON')).toBeNull()
    expect(parseHeadlessJson('')).toBeNull()
  })

  it('zcodeCliSpec：ORCH_ZCODE_CLI 指向不存在文件 → ok:false 附可操作原因', () => {
    const saved = process.env.ORCH_ZCODE_CLI
    try {
      process.env.ORCH_ZCODE_CLI = '/nonexistent/zcode.cjs'
      const spec = zcodeCliSpec()
      expect(spec.ok).toBe(false)
      if (!spec.ok) expect(spec.reason).toContain('/nonexistent/zcode.cjs')
    } finally {
      if (saved === undefined) delete process.env.ORCH_ZCODE_CLI
      else process.env.ORCH_ZCODE_CLI = saved
    }
  })
})

describe('异构审查集成（mock worker）> review_spawned 事件与显式后端', () => {
  it('run --backend mock → 审查沿用 mock（review_spawned.backend=mock）', () => {
    const repo = mkRepo()
    try {
      const cardFile = path.join(repo.root, 'card-het.md')
      fs.writeFileSync(cardFile, cardText({ id: 'het' }))
      runOrch(repo.root, `submit "${cardFile}"`)
      runOrch(repo.root, 'run het --backend mock')
      const spawned = eventsOf(repo.root, 'het').find((e) => e.type === 'review_spawned')
      expect(spawned?.backend).toBe('mock')
      expect(readCard(repo.root, 'awaiting-human', 'het')).toBeTruthy()
    } finally {
      repo.cleanup()
    }
  })

  it('--review-backend mock 显式生效；未知后端名快速失败（任务留 pending）', () => {
    const repo = mkRepo()
    try {
      const cardFile = path.join(repo.root, 'card-exp.md')
      fs.writeFileSync(cardFile, cardText({ id: 'exp' }))
      runOrch(repo.root, `submit "${cardFile}"`)
      runOrch(repo.root, 'run exp --backend mock --review-backend mock')
      expect(eventsOf(repo.root, 'exp').find((e) => e.type === 'review_spawned')?.backend).toBe('mock')

      const cardFile2 = path.join(repo.root, 'card-bad.md')
      fs.writeFileSync(cardFile2, cardText({ id: 'bad-rb' }))
      runOrch(repo.root, `submit "${cardFile2}"`)
      const r = tryOrch(repo.root, 'run bad-rb --backend mock --review-backend bogus')
      expect(r.status).toBe(1)
      expect(r.stderr).toContain('未知后端')
      // 快速失败发生在迁移之前：卡仍在 pending，可修复后重跑
      expect(readCard(repo.root, 'pending', 'bad-rb')).toBeTruthy()
    } finally {
      repo.cleanup()
    }
  })
})

describe('ui_check 门禁', () => {
  it('gateUiCheck：未配置命令跳过；命令失败抛 GateError(gate=ui_check)', () => {
    expect(gateUiCheck(process.cwd(), '')).toMatchObject({ ok: true, skipped: true })
    try {
      gateUiCheck(process.cwd(), 'node -e "process.exit(3)"')
      expect.unreachable('应抛出 GateError')
    } catch (e) {
      expect((e as { gate?: string }).gate).toBe('ui_check')
    }
  })

  it('ui_check: true + uiCheckCmd 通过 → gate ui_check:pass，任务到 awaiting-human', () => {
    const repo = mkRepo({ uiCheckCmd: 'node -e "process.exit(0)"' })
    try {
      const cardFile = path.join(repo.root, 'card-ui.md')
      fs.writeFileSync(cardFile, cardText({ id: 'ui-ok', ui_check: true }))
      runOrch(repo.root, `submit "${cardFile}"`)
      runOrch(repo.root, 'run ui-ok --backend mock')
      const gates = eventsOf(repo.root, 'ui-ok')
        .filter((e) => e.type === 'gate_result' && e.gate === 'ui_check')
        .map((e) => e.result)
      expect(gates).toContain('pass')
      expect(readCard(repo.root, 'awaiting-human', 'ui-ok')).toBeTruthy()
    } finally {
      repo.cleanup()
    }
  })

  it('ui_check 失败 → 进调试子循环；超限（max_test_iterations=1）→ blocked', () => {
    const repo = mkRepo({ uiCheckCmd: 'node -e "process.exit(1)"' })
    try {
      const cardFile = path.join(repo.root, 'card-uifail.md')
      fs.writeFileSync(cardFile, cardText({ id: 'ui-fail', ui_check: true, budget: { max_test_iterations: 1 } }))
      runOrch(repo.root, `submit "${cardFile}"`)
      const r = tryOrch(repo.root, 'run ui-fail --backend mock')
      expect(r.status).toBe(1)
      const types = eventsOf(repo.root, 'ui-fail').map((e) => `${e.type}:${(e as Record<string, unknown>).trigger ?? ''}`)
      expect(types).toContain('debug_iteration:ui_check_failure')
      expect(types.some((t) => t.startsWith('circuit_breaker'))).toBe(true)
      expect(readCard(repo.root, 'blocked', 'ui-fail')).toBeTruthy()
    } finally {
      repo.cleanup()
    }
  })

  it('ui_check: true 但 workflow.json 无 uiCheckCmd → 快速失败，卡留 pending', () => {
    const repo = mkRepo()
    try {
      const cardFile = path.join(repo.root, 'card-uinocfg.md')
      fs.writeFileSync(cardFile, cardText({ id: 'ui-nocfg', ui_check: true }))
      runOrch(repo.root, `submit "${cardFile}"`)
      const r = tryOrch(repo.root, 'run ui-nocfg --backend mock')
      expect(r.status).toBe(1)
      expect(r.stderr).toContain('uiCheckCmd')
      expect(readCard(repo.root, 'pending', 'ui-nocfg')).toBeTruthy()
    } finally {
      repo.cleanup()
    }
  })

  it('ui_check 非布尔 → 卡校验拒绝', () => {
    const repo = mkRepo()
    try {
      const cardFile = path.join(repo.root, 'card-uibad.md')
      fs.writeFileSync(cardFile, cardText({ id: 'ui-bad', ui_check: 'yes' as unknown as boolean }))
      const r = tryOrch(repo.root, `submit "${cardFile}"`)
      expect(r.status).toBe(1)
      expect(r.stderr).toContain('ui_check')
    } finally {
      repo.cleanup()
    }
  })
})
