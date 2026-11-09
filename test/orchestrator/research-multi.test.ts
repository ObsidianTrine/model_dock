// research-multi：research multi 多维度调研（2026-11-09，multi-dim 方案 P1 串行版）——
// topic-id slug 派生与 -2…-9 冲突兜底、rollupTopicVerdict 最差档聚合（unsafe 一票否决）、
// topic.json 不混入 listBriefs；e2e（mock）：3 维齐全（模型自报 id 被覆盖为 <topic>-d<N>）、
// 单维失败隔离（rollup 标 partial）、全维失败 die 汇总、maxDims 上限、verify topic 逐维复核
// 后 rollup 重算。与既有 research*.test.ts 分文件（helpers 复用同款 mkRepo/runOrch）。

import { describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  slugifyTopic,
  deriveTopicId,
  readTopic,
  writeTopic,
  writeBrief,
  listBriefs,
  rollupTopicVerdict,
  buildResearchMultiNotifyBody,
} from '../../.agents/scripts/orchestrator/research.mjs'
import { loadWorkflowConfig } from '../../.agents/scripts/workflow-config.mjs'
import { mkRepo, runOrch, tryOrch } from './helpers.js'

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'research-multi-'))
}

const TODAY = new Date().toISOString().slice(0, 10)

/** 五段齐全、结论带可回查 token 的 brief 正文（供 verify topic 的 ok 维证据链）。 */
const CLAIM_BODY = [
  '# 结论',
  'DeepSeek V4.1 周下载 56.5T，占 43.6%；2026-09 起 GPT-6 与 Kimi K3.1 领跑质量榜 [1]。',
  '',
  '# 选项对比',
  '- DeepSeek V4.1：用量第一。',
  '',
  '# 引用',
  `- ${TODAY} https://a.com/rankings — 支撑`,
  '',
  '# 建议',
  '预设库补齐用量头部。',
  '',
  '# 罗盘对齐',
  '对齐配置托管定位。',
].join('\n')

const SNAPSHOT_TEXT = 'url: https://a.com/rankings\n\n榜单页：DeepSeek V4.1 周下载 56.5T、份额 43.6%、GPT-6 与 Kimi K3.1 领跑'

function researchBase(repo: string): string {
  return path.join(repo, '.agents', 'orchestrator', 'research')
}

function readTopicFile(repo: string, topicId: string): any {
  return JSON.parse(fs.readFileSync(path.join(researchBase(repo), 'topics', `${topicId}.json`), 'utf8'))
}

function seedSnapshot(repo: string, briefId: string): void {
  const srcDir = path.join(researchBase(repo), briefId, 'sources')
  fs.mkdirSync(srcDir, { recursive: true })
  fs.writeFileSync(path.join(srcDir, '1.txt'), SNAPSHOT_TEXT)
}

describe('orchestrator research-multi > topic-id 与 rollup 纯函数', () => {
  it('slugifyTopic：小写化/非字母数字折叠/截断；短 slug 加哈希尾（中文折叠兜底）', () => {
    expect(slugifyTopic('LLM Trust Probe')).toBe('llm-trust-probe')
    expect(slugifyTopic('LLM 可信度——技术选型')).toMatch(/^llm-[0-9a-f]{8}$/) // 中文折叠成短横线 → 短 slug 加哈希尾
    expect(slugifyTopic('  --多--维--  ')).toMatch(/^topic-[0-9a-f]{8}$/) // 全非 [a-z0-9] → 兜底 + 哈希尾
    expect(slugifyTopic('x'.repeat(80)).length).toBeLessThanOrEqual(48)
    // TASK_ID_RE 兼容：小写字母/数字/短横线
    expect(slugifyTopic('A_B.C')).toMatch(/^[a-z0-9][a-z0-9-]*$/)
  })

  it('deriveTopicId：冲突沿用 -2…-9 派生；9 个全占用抛可操作报错', () => {
    const root = tmpRoot()
    try {
      expect(deriveTopicId(root, 'probe')).toBe('probe')
      writeTopic(root, { id: 'probe', topic: 't', created_at: 'x', dims: [], rollup: {} })
      expect(deriveTopicId(root, 'probe')).toBe('probe-2')
      writeTopic(root, { id: 'probe-2', topic: 't', created_at: 'x', dims: [], rollup: {} })
      expect(deriveTopicId(root, 'probe')).toBe('probe-3')
      for (const n of [3, 4, 5, 6, 7, 8, 9]) writeTopic(root, { id: `probe-${n}`, topic: 't', created_at: 'x', dims: [], rollup: {} })
      expect(() => deriveTopicId(root, 'probe')).toThrow(/-2…-9 已全部占用[\s\S]*归档/)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('rollupTopicVerdict：最差档聚合 + unsafe 一票否决 + failed 维不参与但标 partial', () => {
    // 全 ok 全优 → ok/pass，无 partial
    const allOk = rollupTopicVerdict([
      { dim: 'a', status: 'ok', verdict_level: 'pass', internal_decision: 'ok' },
      { dim: 'b', status: 'ok', verdict_level: 'pass', internal_decision: 'ok' },
    ])
    expect(allOk).toEqual({ level: 'pass', internal_decision: 'ok' })
    // 任一 unsafe → 整批 unsafe（一票否决）；verdict_level 取 fail
    const vetoed = rollupTopicVerdict([
      { dim: 'a', status: 'ok', verdict_level: 'pass', internal_decision: 'ok' },
      { dim: 'b', status: 'ok', verdict_level: 'fail', internal_decision: 'unsafe' },
    ])
    expect(vetoed).toEqual({ level: 'fail', internal_decision: 'unsafe' })
    // needs_review 比 undetermined 差（severity 序：unsafe > needs_review > undetermined > ok）
    expect(rollupTopicVerdict([
      { dim: 'a', status: 'ok', verdict_level: 'warn', internal_decision: 'undetermined' },
      { dim: 'b', status: 'ok', verdict_level: 'pass', internal_decision: 'needs_review' },
    ]).internal_decision).toBe('needs_review')
    // failed 维留痕不参与；partial: true
    const partial = rollupTopicVerdict([
      { dim: 'a', status: 'ok', verdict_level: 'pass', internal_decision: 'ok' },
      { dim: 'b', status: 'failed', verdict_level: null, internal_decision: null },
    ])
    expect(partial).toEqual({ level: 'pass', internal_decision: 'ok', partial: true })
    // 无任何可聚合判定（全 failed）→ unknown 兜底
    expect(rollupTopicVerdict([{ dim: 'a', status: 'failed' }])).toEqual({ level: 'unknown', internal_decision: 'unknown', partial: true })
  })

  it('buildResearchMultiNotifyBody：rollup 行 + 每维一行（failed 维带 reason 摘要）', () => {
    const body = buildResearchMultiNotifyBody({
      id: 'llm-trust',
      rollup: { level: 'warn', internal_decision: 'unsafe', partial: true },
      dims: [
        { dim: '技术', brief_id: 'llm-trust-d1', status: 'ok', verdict_level: 'pass', internal_decision: 'ok' },
        { dim: '成本', brief_id: null, status: 'failed', reason: 'unrecognized_model 签名', verdict_level: null, internal_decision: null },
      ],
    })
    expect(body).toContain('⚠️ rollup：warn（internal_decision=unsafe）——partial')
    expect(body).toContain('✅ 技术（llm-trust-d1）——pass / ok')
    expect(body).toContain('✗ 成本（brief 未产出）——failed：unrecognized_model')
  })

  it('listBriefs 回归：topics/ 子目录不收录（无 meta.json 天然排除）', () => {
    const root = tmpRoot()
    try {
      writeBrief(root, { id: 'plain-brief', title: 't', body: CLAIM_BODY })
      writeTopic(root, { id: 'some-topic', topic: 't', created_at: 'x', dims: [], rollup: {} })
      expect(listBriefs(root)).toEqual(['plain-brief'])
      expect(readTopic(root, 'some-topic')?.id).toBe('some-topic')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('orchestrator research-multi > resolveResearch maxDims 校验', () => {
  function cfgWith(research: unknown): { root: string; cleanup: () => void } {
    const root = tmpRoot()
    fs.mkdirSync(path.join(root, '.agents'), { recursive: true })
    fs.writeFileSync(path.join(root, '.agents', 'workflow.json'), JSON.stringify({ baseBranch: 'develop', testCmd: 'node -e "process.exit(0)"', research }))
    return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) }
  }

  it('合法正整数生效；键缺失不产出该键（调用方回落缺省 4）', () => {
    const withTwo = cfgWith({ maxDims: 2 })
    try {
      expect(loadWorkflowConfig(withTwo.root).research?.maxDims).toBe(2)
    } finally {
      withTwo.cleanup()
    }
    const noKey = cfgWith(undefined)
    try {
      expect(loadWorkflowConfig(noKey.root).research?.maxDims).toBeUndefined()
    } finally {
      noKey.cleanup()
    }
  })

  it('非法值（0/负数/非整数/字符串）console.warn 报错并忽略——回落缺省，不阻断其他键', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      for (const bad of [0, -1, 1.5, 'four']) {
        const c = cfgWith({ maxDims: bad, model: 'glm-5.3-flash' })
        try {
          const r = loadWorkflowConfig(c.root).research
          expect(r?.maxDims).toBeUndefined()
          expect(r?.model).toBe('glm-5.3-flash') // 其他键不受连坐
          expect(warnSpy.mock.calls.some((args) => String(args[0]).includes('research.maxDims'))).toBe(true)
          warnSpy.mockClear()
        } finally {
          c.cleanup()
        }
      }
    } finally {
      warnSpy.mockRestore()
    }
  })
})

describe('orchestrator research-multi > e2e（mock）', () => {
  it('3 维 multi：brief id 强制 <topic>-d1..d3（模型自报 id 被覆盖）、meta 带 topic 溯源、rollup 聚合、台账每维一条', () => {
    const repo = mkRepo()
    try {
      const out = runOrch(repo.root, 'research multi "llm trust probe" --dim "技术选型" --dim "成本" --dim "风险" --backend mock')
      const base = researchBase(repo.root)
      // topic.json 齐全
      const topic = readTopicFile(repo.root, 'llm-trust-probe')
      expect(topic.id).toBe('llm-trust-probe')
      expect(topic.topic).toBe('llm trust probe')
      expect(topic.dims).toHaveLength(3)
      for (const [i, d] of topic.dims.entries()) {
        expect(d).toMatchObject({ dim: ['技术选型', '成本', '风险'][i], brief_id: `llm-trust-probe-d${i + 1}`, status: 'ok', reason: null })
      }
      // 每维 brief 落盘：id 被强制覆盖（mock 自报 id 恒为 llm-trust-probe，绝不出现）
      expect(fs.existsSync(path.join(base, 'llm-trust-probe', 'brief.md'))).toBe(false)
      for (const n of [1, 2, 3]) {
        const id = `llm-trust-probe-d${n}`
        expect(fs.existsSync(path.join(base, id, 'brief.md'))).toBe(true)
        const meta = JSON.parse(fs.readFileSync(path.join(base, id, 'meta.json'), 'utf8'))
        expect(meta.id).toBe(id)
        expect(meta.topic_id).toBe('llm-trust-probe')
        expect(meta.dim).toBe(['技术选型', '成本', '风险'][n - 1])
      }
      // L1 初判（mock 结论无可回查 token）：各维 unknown / undetermined → rollup 同档，无 partial
      expect(topic.dims[0].verdict_level).toBe('unknown')
      expect(topic.dims[0].internal_decision).toBe('undetermined')
      expect(topic.rollup).toEqual({ level: 'unknown', internal_decision: 'undetermined' })
      expect(topic.rollup.partial).toBeUndefined()
      // 台账每维一条 l1（附 topic_id/dim 溯源）
      const ledger = fs.readFileSync(path.join(base, 'ledger.jsonl'), 'utf8')
      expect(ledger.match(/"kind":"l1"/g)).toHaveLength(3)
      expect(ledger).toContain('"topic_id":"llm-trust-probe"')
      expect(ledger).toContain('"dim":"成本"')
      // 汇总日志
      expect(out.stdout).toContain('多维调研：llm trust probe（3 维，topic-id llm-trust-probe')
      expect(out.stdout).toContain('topic 汇总已落盘')
      expect(out.stdout).toContain('research verify llm-trust-probe')
    } finally {
      repo.cleanup()
    }
  }, 120_000)

  it('单维失败隔离：failed 维留痕（reason 带 stderr 签名）、批次不炸、rollup 标 partial', () => {
    const repo = mkRepo()
    try {
      const out = runOrch(repo.root, 'research multi "iso probe" --dim "技术" --dim "成本" --backend mock', {
        ORCH_MOCK_RESEARCH_FAIL_DIM: '成本',
        ORCH_MOCK_RESEARCH_STDERR: '1',
      })
      const topic = readTopicFile(repo.root, 'iso-probe')
      expect(topic.dims).toHaveLength(2)
      expect(topic.dims[0]).toMatchObject({ dim: '技术', brief_id: 'iso-probe-d1', status: 'ok' })
      expect(topic.dims[1].status).toBe('failed')
      expect(topic.dims[1].brief_id).toBeNull()
      expect(topic.dims[1].reason).toContain('unrecognized_model')
      expect(topic.dims[1].verdict_level).toBeNull()
      // 只有成功的 d1 落盘
      expect(fs.existsSync(path.join(researchBase(repo.root), 'iso-probe-d1', 'brief.md'))).toBe(true)
      expect(fs.existsSync(path.join(researchBase(repo.root), 'iso-probe-d2', 'brief.md'))).toBe(false)
      // rollup：只聚合成功维 + partial 标记
      expect(topic.rollup).toEqual({ level: 'unknown', internal_decision: 'undetermined', partial: true })
      expect(out.stdout).toContain('已隔离，继续下一维')
      // failed 维不记 l1 台账（只记成功维）
      const ledger = fs.readFileSync(path.join(researchBase(repo.root), 'ledger.jsonl'), 'utf8')
      expect(ledger.match(/"kind":"l1"/g)).toHaveLength(1)
    } finally {
      repo.cleanup()
    }
  }, 120_000)

  it('全维失败 → die 汇总每维 stderr 尾摘要，topic.json 不落盘', () => {
    const repo = mkRepo()
    try {
      const r = tryOrch(repo.root, 'research multi "all fail probe" --dim "技术" --dim "成本" --backend mock', {
        ORCH_MOCK_PLANNER_INVALID: '1',
        ORCH_MOCK_RESEARCH_STDERR: '1',
      })
      expect(r.status).toBe(1)
      expect(r.stderr).toContain('多维调研全部 2 个维度失败')
      expect(r.stderr).toContain('- 技术：')
      expect(r.stderr).toContain('unrecognized_model')
      expect(fs.existsSync(path.join(researchBase(repo.root), 'topics', 'all-fail-probe.json'))).toBe(false)
    } finally {
      repo.cleanup()
    }
  }, 120_000)

  it('维度数闸门：<2 die 指路单维 research；超 research.maxDims die 可操作报错', () => {
    const repo = mkRepo()
    try {
      const one = tryOrch(repo.root, 'research multi "t probe" --dim "只给一维" --backend mock')
      expect(one.status).toBe(1)
      expect(one.stderr).toContain('multi 调研至少 2 个维度（收到 1 个）')
      expect(one.stderr).toContain('单维问题直接用 research')
      const none = tryOrch(repo.root, 'research multi --backend mock')
      expect(none.status).toBe(1)
      expect(none.stderr).toContain('用法：research multi')
      // 本仓 workflow.json 无 research.maxDims → 缺省 4，3 维放行（maxDims=2 的收紧见下条用例）
      const three = runOrch(repo.root, 'research multi "cap probe" --dim a --dim b --dim c --backend mock')
      expect(three.stdout).toContain('topic 汇总已落盘')
    } finally {
      repo.cleanup()
    }
  }, 120_000)

  it('research.maxDims=2 生效：3 维 die、2 维放行；非法 maxDims=0 回落缺省不拦', () => {
    const capped = mkRepo({ extra: { research: { maxDims: 2 } } })
    try {
      const die = tryOrch(capped.root, 'research multi "cap2 probe" --dim a --dim b --dim c --backend mock')
      expect(die.status).toBe(1)
      expect(die.stderr).toContain('维度数 3 超过上限 research.maxDims=2')
      expect(die.stderr).toContain('research.maxDims 调大')
      const ok = runOrch(capped.root, 'research multi "cap2 probe" --dim a --dim b --backend mock')
      expect(ok.stdout).toContain('topic 汇总已落盘')
    } finally {
      capped.cleanup()
    }
    const invalid = mkRepo({ extra: { research: { maxDims: 0 } } })
    try {
      // 非法值回落缺省 4（console.warn 在子进程 stderr，不影响放行）
      const ok = runOrch(invalid.root, 'research multi "bad cap" --dim a --dim b --dim c --backend mock')
      expect(ok.stdout).toContain('topic 汇总已落盘')
    } finally {
      invalid.cleanup()
    }
  }, 180_000)

  it('research verify <topic-id>：逐维 L2 复核、rollup 重算、topic-verify 台账、l2 条目带 topic 溯源', () => {
    const repo = mkRepo()
    try {
      runOrch(repo.root, 'research multi "verify probe" --dim "技术" --dim "成本" --backend mock')
      const base = researchBase(repo.root)
      // 干净 mock 产物跑 verify：每维 supported（L1 回查维持）→ coverage/coherence 100
      //（mock 结论无可回查 token → evidence null → 决策仍 undetermined，判级 unknown）
      const out = runOrch(repo.root, 'research verify verify-probe --backend mock')
      expect(out.stdout).toContain('topic 复核：verify-probe（2 维，逐维 L2')
      const topic = readTopicFile(repo.root, 'verify-probe')
      for (const d of topic.dims) {
        expect(d.status).toBe('ok')
        expect(d.internal_decision).toBe('undetermined')
      }
      expect(topic.rollup).toEqual({ level: 'unknown', internal_decision: 'undetermined' })
      // 逐维 verdict.json 已从 L1-only 升级为 L2（claims 非空 + verifier 字段）
      for (const n of [1, 2]) {
        const v = JSON.parse(fs.readFileSync(path.join(base, `verify-probe-d${n}`, 'verdict.json'), 'utf8'))
        expect(v.claims).toHaveLength(1)
        expect(v.claims[0].status).toBe('supported')
        expect(v.usage.internal_decision).toBe('undetermined')
      }
      // 台账：2 条 l2（带 topic_id/dim）+ 1 条 topic-verify
      const ledger = fs.readFileSync(path.join(base, 'ledger.jsonl'), 'utf8')
      expect(ledger.match(/"kind":"l2"/g)).toHaveLength(2)
      expect(ledger).toContain('"topic_id":"verify-probe"')
      expect(ledger).toContain('"dim":"成本"')
      expect(ledger).toContain('"kind":"topic-verify"')
      expect(out.stdout).toContain('rollup 重算')
    } finally {
      repo.cleanup()
    }
  }, 180_000)

  it('rollup 一票否决：某维 unsafe（brief 缺失保留原判定）→ 整批 rollup unsafe/fail；ok 维照常复核', () => {
    const repo = mkRepo()
    try {
      const base = researchBase(repo.root)
      // d1：证据链齐全（快照命中）→ verify 后 ok/pass；d2：构造为已判 unsafe 但 brief 已被删
      writeBrief(repo.root, { id: 'veto-probe-d1', title: 't1', question: 'q1', backend: 'mock', body: CLAIM_BODY, topicId: 'veto-probe', dim: '技术' })
      seedSnapshot(repo.root, 'veto-probe-d1')
      writeTopic(repo.root, {
        id: 'veto-probe',
        topic: 'veto probe',
        created_at: '2026-11-09T10:00:00+08:00',
        dims: [
          { dim: '技术', brief_id: 'veto-probe-d1', status: 'ok', reason: null, verdict_level: 'unknown', internal_decision: 'undetermined' },
          { dim: '合规', brief_id: 'veto-probe-d2', status: 'ok', reason: null, verdict_level: 'fail', internal_decision: 'unsafe' },
        ],
        rollup: { level: 'fail', internal_decision: 'unsafe' },
      })
      fs.rmSync(path.join(base, 'veto-probe-d2'), { recursive: true, force: true })
      const out = runOrch(repo.root, 'research verify veto-probe --backend mock')
      expect(out.stdout).toContain('veto-probe-d2 已不存在——保留原判定')
      const topic = readTopicFile(repo.root, 'veto-probe')
      // d1 复核后 ok/pass（L1 数字回查全命中 → evidence 100）
      expect(topic.dims[0]).toMatchObject({ dim: '技术', verdict_level: 'pass', internal_decision: 'ok' })
      // d2 保留 unsafe → 一票否决传导到 rollup
      expect(topic.dims[1]).toMatchObject({ dim: '合规', verdict_level: 'fail', internal_decision: 'unsafe' })
      expect(topic.rollup).toEqual({ level: 'fail', internal_decision: 'unsafe' })
      const ledger = fs.readFileSync(path.join(base, 'ledger.jsonl'), 'utf8')
      expect(ledger).toContain('"kind":"topic-verify"')
      expect(ledger).toContain('"decision":"unsafe"')
      expect(out.stdout).toContain('rollup 重算：fail / unsafe')
    } finally {
      repo.cleanup()
    }
  }, 120_000)
})
