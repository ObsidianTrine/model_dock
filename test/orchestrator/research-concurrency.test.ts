// research-concurrency：research multi P2 层——①维度并发池（research.concurrency 1–4 缺省 2，
// multi 维度池与 verify topic 逐维复核共用；dims 按 --dim 顺序回填与完成先后无关）+
// writeTopicAuto 落盘瞬间竞态复检（同主题并行 multi 的 topic-id 互覆收口，续派 -2…-9）；
// ②spec --from-brief 的 topic 自动注入（readTopic 命中 → 每 ok 维一节 + failed 维缺口行，
// rollup unsafe 一票否决拒绝注入、undetermined 提示不阻断）。既有 research-multi /
// spec-multi-brief 舱位不覆盖的 P2 行为都在本文件。
// 并发观测与 prompt 捕获同 spec-multi-brief 的手法：module load 钩子在测试子进程里包一层
// mock 后端的 spawn（零 vi.mock，singleFork 下无跨文件 mock 冲突；钩子只在带 --import 的
// 子进程生效）。

import { describe, expect, it, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  buildTopicSpecSections,
  readTopic,
  writeBrief,
  writeTopic,
  writeTopicAuto,
  topicPath,
} from '../../.agents/scripts/orchestrator/research.mjs'
import { loadWorkflowConfig } from '../../.agents/scripts/workflow-config.mjs'
import { mkRepo, runOrch, tryOrch } from './helpers.js'

const WORKTREE_ROOT = path.resolve(process.cwd()) // vitest 的 cwd = 仓库根（worktree 内），同 helpers.ts

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'research-conc-'))
}

function researchBase(repo: string): string {
  return path.join(repo, '.agents', 'orchestrator', 'research')
}

function readTopicFile(repo: string, topicId: string): any {
  return JSON.parse(fs.readFileSync(path.join(researchBase(repo), 'topics', `${topicId}.json`), 'utf8'))
}

/** 在沙箱 repo 手写一个 brief 目录（meta.json + brief.md，与 writeBrief 落盘契约同形）。 */
function writeBriefFixture(repo: string, id: string, body: string): void {
  const dir = path.join(researchBase(repo), id)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'meta.json'),
    JSON.stringify({ id, title: `brief ${id}`, question: 'q', backend: 'mock', created_at: '2026-11-09T10:00:00+08:00' }, null, 2),
  )
  fs.writeFileSync(path.join(dir, 'brief.md'), `${body.trim()}\n`)
}

/** specs/ 目录存在且非空 = 有残留。 */
function specResidue(repo: string): boolean {
  const dir = path.join(repo, '.agents', 'orchestrator', 'specs')
  return fs.existsSync(dir) && fs.readdirSync(dir).length > 0
}

// ---------------------------------------------------------------------------
// module load 钩子（只在测试拉起的 node --import 子进程生效）
// ---------------------------------------------------------------------------

/** 并发观测钩子：包 mock 后端 spawn——按 prompt 含 SLOW-DIM-MARKER 拉长时延（500ms vs 50ms，
 *  让「完成顺序 ≠ 维序」可确定性构造），start/end 事件落 JSONL（测试回放算同时在跑峰值）。
 *  注意：append 进 mock.mjs 的片段内禁用 \n 转义（内层模板会把 \n 变真实换行、炸断字符串
 *  字面量）——换行统一走 String.fromCharCode(10)。 */
const POOL_HOOK = `
export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  if (!url.endsWith('/backends/mock.mjs')) return result;
  result.source = String(result.source) + \`
;{
  const __fs = await import('node:fs');
  const __EOL = String.fromCharCode(10);
  const __origSpawn = mockBackend.spawn.bind(mockBackend);
  mockBackend.spawn = async (inv) => {
    const __log = process.env.ORCH_POOL_TEST_LOG;
    const __slow = __fs.readFileSync(inv.promptFile, 'utf8').includes('SLOW-DIM-MARKER');
    if (__log) { try { __fs.appendFileSync(__log, JSON.stringify({ ev: 'start', slow: __slow }) + __EOL); } catch {} }
    try {
      await new Promise((r) => setTimeout(r, __slow ? 500 : 50));
      return await __origSpawn(inv);
    } finally {
      if (__log) { try { __fs.appendFileSync(__log, JSON.stringify({ ev: 'end', slow: __slow }) + __EOL); } catch {} }
    }
  };
}
\`;
  return { ...result, shortCircuit: true };
}
`

/** prompt 捕获钩子：spawn 时把 spec planner 收到的 promptFile 原文落盘（spec-multi-brief 同款）。 */
const CAPTURE_HOOK = `
export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  if (!url.endsWith('/backends/mock.mjs')) return result;
  result.source = String(result.source) + \`
;{
  const __fs = await import('node:fs');
  const __origSpawn = mockBackend.spawn.bind(mockBackend);
  mockBackend.spawn = async (inv) => {
    const cap = process.env.ORCH_SPEC_TEST_CAPTURE;
    if (cap) { try { __fs.writeFileSync(cap, __fs.readFileSync(inv.promptFile, 'utf8')); } catch {} }
    return __origSpawn(inv);
  };
}
\`;
  return { ...result, shortCircuit: true };
}
`

function makeHookRunner(hookSource: string, envKey: string, tmpPrefix: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), tmpPrefix))
  const registerFile = path.join(dir, 'register.mjs')
  fs.writeFileSync(registerFile, `import { register } from 'node:module';\nregister('./hook.mjs', import.meta.url);\n`)
  fs.writeFileSync(path.join(dir, 'hook.mjs'), hookSource)
  const captureFile = path.join(dir, 'captured.out')
  return {
    run(repo: string, args: string[]): { status: number; stdout: string; stderr: string } {
      const orch = path.join(WORKTREE_ROOT, '.agents', 'scripts', 'orchestrator.mjs')
      const r = spawnSync(process.execPath, ['--import', pathToFileURL(registerFile).href, orch, ...args], {
        cwd: repo,
        encoding: 'utf8',
        env: { ...process.env, [envKey]: captureFile },
        timeout: 180_000,
      })
      return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
    },
    captured(): string | null {
      return fs.existsSync(captureFile) ? fs.readFileSync(captureFile, 'utf8') : null
    },
    /** 捕获文件按 JSONL 解析（并发观测钩子的事件流）。 */
    events(): Array<{ ev: string; slow?: boolean }> {
      const raw = this.captured()
      return raw ? raw.split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []
    },
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  }
}

/** 事件回放：start=+1 / end=-1，返回同时在跑的峰值（事件序 = 落盘序，单进程内 appendFileSync 保序）。 */
function maxInflight(events: Array<{ ev: string; slow?: boolean }>): number {
  let running = 0
  let max = 0
  for (const e of events) {
    running += e.ev === 'start' ? 1 : -1
    max = Math.max(max, running)
  }
  return max
}

describe('orchestrator research-concurrency > resolveResearch concurrency 校验', () => {
  function cfgWith(research: unknown): { root: string; cleanup: () => void } {
    const root = tmpRoot()
    fs.mkdirSync(path.join(root, '.agents'), { recursive: true })
    fs.writeFileSync(path.join(root, '.agents', 'workflow.json'), JSON.stringify({ baseBranch: 'develop', testCmd: 'node -e "process.exit(0)"', research }))
    return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) }
  }

  it('1–4 整数生效；键缺失不产出该键（调用方回落缺省 2）', () => {
    for (const n of [1, 2, 3, 4]) {
      const c = cfgWith({ concurrency: n })
      try {
        expect(loadWorkflowConfig(c.root).research?.concurrency).toBe(n)
      } finally {
        c.cleanup()
      }
    }
    const noKey = cfgWith(undefined)
    try {
      expect(loadWorkflowConfig(noKey.root).research?.concurrency).toBeUndefined()
    } finally {
      noKey.cleanup()
    }
  })

  it('非法值（0/负数/5/非整数/字符串）console.warn 报错并忽略——不阻断其他键', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      for (const bad of [0, -1, 5, 1.5, '2']) {
        const c = cfgWith({ concurrency: bad, maxDims: 3 })
        try {
          const r = loadWorkflowConfig(c.root).research
          expect(r?.concurrency).toBeUndefined()
          expect(r?.maxDims).toBe(3) // 其他键不受连坐
          expect(warnSpy.mock.calls.some((args) => String(args[0]).includes('research.concurrency'))).toBe(true)
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

describe('orchestrator research-concurrency > writeTopicAuto 竞态复检', () => {
  it('id 空闲直落；已占用续派 -2（原文件不被互覆）；9 个派生位全占用抛可操作报错', () => {
    const root = tmpRoot()
    try {
      const a = writeTopicAuto(root, { id: 'probe', topic: '先到者', created_at: 'x', dims: [], rollup: {} })
      expect(a.id).toBe('probe')
      // 模拟并行同主题跑在 derive 之后、落盘之前占住了 probe：复检 → 续派 probe-2
      const b = writeTopicAuto(root, { id: 'probe', topic: '后到者', created_at: 'y', dims: [{ dim: '技术', status: 'ok' }], rollup: {} })
      expect(b.id).toBe('probe-2')
      expect(fs.existsSync(topicPath(root, 'probe-2'))).toBe(true)
      // 先到者的清单逐字节未被覆盖（互覆防线）
      expect(JSON.parse(fs.readFileSync(topicPath(root, 'probe'), 'utf8')).topic).toBe('先到者')
      expect(JSON.parse(fs.readFileSync(topicPath(root, 'probe-2'), 'utf8')).id).toBe('probe-2')
      // 9 位全占用 → 可操作报错（循环安全退出）
      for (const n of [3, 4, 5, 6, 7, 8, 9]) writeTopic(root, { id: `probe-${n}`, topic: 't', created_at: 'x', dims: [], rollup: {} })
      expect(() => writeTopicAuto(root, { id: 'probe', topic: 't', created_at: 'x', dims: [], rollup: {} })).toThrow(/-2…-9 已全部占用[\s\S]*归档/)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('buildTopicSpecSections：ok 维分节带 topic/维度/brief 溯源；failed 维与 brief 已删维落缺口行', () => {
    const root = tmpRoot()
    try {
      writeBriefFixture(root, 'alive-d1', '存活维结论-alive42。')
      const topic = {
        id: 'sec-probe',
        topic: 'sec probe',
        created_at: 'x',
        dims: [
          { dim: '技术', brief_id: 'alive-d1', status: 'ok', reason: null, verdict_level: 'pass', internal_decision: 'ok' },
          { dim: '成本', brief_id: 'sec-probe-d2', status: 'failed', reason: 'unrecognized_model 签名', verdict_level: null, internal_decision: null },
          { dim: '风险', brief_id: 'sec-probe-d3', status: 'ok', reason: null, verdict_level: 'warn', internal_decision: 'needs_review' },
        ],
        rollup: { level: 'warn', internal_decision: 'needs_review', partial: true },
      }
      const text = buildTopicSpecSections(root, topic as any)
      // ok 维分节（节头带三维溯源），正文原样注入
      expect(text).toContain('# 调研结论（topic：sec-probe｜维度：技术｜brief：alive-d1）')
      expect(text).toContain('存活维结论-alive42。')
      // failed 维不注入正文；缺口行在展开末尾（reason 摘要），按 dims 序排列
      expect(text).toContain('（维度 成本 调研失败：unrecognized_model 签名）')
      // brief 已被人工删除的 ok 维：同缺口处理（正文缺失 ≈ 该维无产出）
      expect(text).toContain('（维度 风险 调研失败：brief sec-probe-d3 已不存在）')
      expect(text.indexOf('（维度 成本 调研失败')).toBeGreaterThan(text.indexOf('维度：技术'))
      expect(text.indexOf('（维度 风险 调研失败')).toBeGreaterThan(text.indexOf('（维度 成本 调研失败'))
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('orchestrator research-concurrency > multi 维度并发池 e2e（mock）', () => {
  it('5 维 + concurrency=2：同时在跑恰好 2（上限生效且真实并发）、dims 按 --dim 顺序回填（与完成先后无关）、topic.json 完整', () => {
    const repo = mkRepo({ extra: { research: { concurrency: 2, maxDims: 5 } } })
    const obs = makeHookRunner(POOL_HOOK, 'ORCH_POOL_TEST_LOG', 'research-pool-obs-')
    try {
      const out = obs.run(repo.root, [
        'research', 'multi', 'pool probe',
        '--dim', 'SLOW-DIM-MARKER', '--dim', 'quick-a', '--dim', 'quick-b', '--dim', 'quick-c', '--dim', 'quick-d',
        '--backend', 'mock',
      ])
      expect(out.status).toBe(0)
      expect(out.stdout).toContain('并发 2')
      const ev = obs.events()
      expect(ev.filter((e) => e.ev === 'start')).toHaveLength(5)
      // 上限生效：同时最多 2（串行会得 1，无上限会得 5）
      expect(maxInflight(ev)).toBe(2)
      // 完成顺序 ≠ 维序：slow 维（d1）的 spawn 晚于后续维的 spawn 完成（quick 链先收）——
      // 而 dims 仍按 --dim 顺序回填（断言见下）
      const iSlowEnd = ev.findIndex((e) => e.ev === 'end' && e.slow)
      const iQuickEnd = ev.findIndex((e) => e.ev === 'end' && !e.slow)
      expect(iQuickEnd).toBeGreaterThan(-1)
      expect(iSlowEnd).toBeGreaterThan(iQuickEnd)
      const topic = readTopicFile(repo.root, 'pool-probe')
      expect(topic.dims.map((d: any) => d.dim)).toEqual(['SLOW-DIM-MARKER', 'quick-a', 'quick-b', 'quick-c', 'quick-d'])
      expect(topic.dims.map((d: any) => d.brief_id)).toEqual(['pool-probe-d1', 'pool-probe-d2', 'pool-probe-d3', 'pool-probe-d4', 'pool-probe-d5'])
      for (const d of topic.dims) {
        expect(d).toMatchObject({ status: 'ok', reason: null })
      }
      // 全部 brief 落盘 + meta 带 topic 溯源
      for (const n of [1, 2, 3, 4, 5]) {
        const meta = JSON.parse(fs.readFileSync(path.join(researchBase(repo.root), `pool-probe-d${n}`, 'meta.json'), 'utf8'))
        expect(meta.id).toBe(`pool-probe-d${n}`)
        expect(meta.topic_id).toBe('pool-probe')
      }
      // rollup 完整（mock 无可回查 token → unknown / undetermined）
      expect(topic.rollup).toEqual({ level: 'unknown', internal_decision: 'undetermined' })
    } finally {
      repo.cleanup()
      obs.cleanup()
    }
  }, 180_000)

  it('research verify <topic-id> 逐维复核并入同一并发池：同时在跑 ≤ 上限、dims 保序、rollup 重算正确', () => {
    const repo = mkRepo({ extra: { research: { concurrency: 2 } } })
    const obs = makeHookRunner(POOL_HOOK, 'ORCH_POOL_TEST_LOG', 'research-vpool-obs-')
    try {
      runOrch(repo.root, 'research multi "vpool probe" --dim "技术" --dim "成本" --backend mock')
      const out = obs.run(repo.root, ['research', 'verify', 'vpool-probe', '--backend', 'mock'])
      expect(out.status).toBe(0)
      expect(out.stdout).toContain('逐维 L2 并发 2')
      const ev = obs.events()
      expect(ev.filter((e) => e.ev === 'start')).toHaveLength(2)
      expect(maxInflight(ev)).toBe(2) // 两维真正同时在复核
      const topic = readTopicFile(repo.root, 'vpool-probe')
      // dims 按 topic.json 原维序回填（index 写回，与完成先后无关）
      expect(topic.dims.map((d: any) => d.dim)).toEqual(['技术', '成本'])
      expect(topic.rollup).toEqual({ level: 'unknown', internal_decision: 'undetermined' })
      // 每维 L2 复核已升级（claims 非空 + verifier 字段）
      for (const n of [1, 2]) {
        const v = JSON.parse(fs.readFileSync(path.join(researchBase(repo.root), `vpool-probe-d${n}`, 'verdict.json'), 'utf8'))
        expect(v.claims).toHaveLength(1)
        expect(v.verifier.backend).toBe('mock')
      }
    } finally {
      repo.cleanup()
      obs.cleanup()
    }
  }, 180_000)

  it('同名 topic 竞态回归：预占 topics/<id>.json → 自动派生 -2 落盘，先到者清单不被互覆', () => {
    const repo = mkRepo()
    try {
      // 预占：模拟并行同主题跑已先落盘（derive 阶段的 check-then-write 检查即避开占用）
      writeTopic(repo.root, { id: 'race-probe', topic: '先到者清单', created_at: '2026-11-09T09:00:00+08:00', dims: [], rollup: {} })
      const out = runOrch(repo.root, 'research multi "race probe" --dim "技术" --dim "成本" --backend mock')
      expect(out.stdout).toContain('topic-id race-probe-2')
      const t2 = readTopicFile(repo.root, 'race-probe-2')
      expect(t2.topic).toBe('race probe')
      expect(t2.dims).toHaveLength(2)
      expect(t2.dims.map((d: any) => d.brief_id)).toEqual(['race-probe-2-d1', 'race-probe-2-d2'])
      // 先到者的清单逐字节未被覆盖
      const orig = JSON.parse(fs.readFileSync(topicPath(repo.root, 'race-probe'), 'utf8'))
      expect(orig.topic).toBe('先到者清单')
      expect(orig.dims).toHaveLength(0)
    } finally {
      repo.cleanup()
    }
  }, 120_000)
})

describe('orchestrator research-concurrency > spec --from-brief topic 注入 e2e（mock）', () => {
  it('topic 模式：ok 维分节（topic/维度/brief 溯源）+ failed 维缺口行；undetermined 提示先 verify 但不阻断', () => {
    const repo = mkRepo()
    const cap = makeHookRunner(CAPTURE_HOOK, 'ORCH_SPEC_TEST_CAPTURE', 'research-topic-cap-')
    try {
      // 造带失败维的 topic（rollup = undetermined + partial）
      runOrch(repo.root, 'research multi "gap probe" --dim "技术" --dim "成本" --backend mock', {
        ORCH_MOCK_RESEARCH_FAIL_DIM: '成本',
        ORCH_MOCK_RESEARCH_STDERR: '1',
      })
      const r = cap.run(repo.root, ['spec', 'topic inject spec', '--from-brief', 'gap-probe', '--backend', 'mock'])
      expect(r.status).toBe(0)
      // undetermined：不阻断，但提示先 L2 复核
      expect(r.stdout).toContain('未 L2 复核')
      expect(r.stdout).toContain('research verify gap-probe')
      const prompt = cap.captured()
      expect(prompt).not.toBeNull()
      // ok 维分节：节头带三维溯源 + brief 正文
      expect(prompt).toContain('# 调研结论（topic：gap-probe｜维度：技术｜brief：gap-probe-d1）')
      expect(prompt).toContain('mock 调研结论占位 [1]。')
      // failed 维：不注入正文节，展开末尾附覆盖缺口行（reason 摘要带 stderr 签名）
      expect(prompt).not.toContain('维度：成本')
      expect(prompt).toContain('（维度 成本 调研失败：')
      expect(prompt).toContain('unrecognized_model')
      // 缺口行直接接在节尾（无额外 --- 分隔；基础 prompt 不含 ---）
      expect((prompt as string).split('---')).toHaveLength(1)
      // 端到端不破：三件套照常落盘
      expect(fs.existsSync(path.join(repo.root, '.agents', 'orchestrator', 'specs', 'topic-inject-spec', 'design.md'))).toBe(true)
    } finally {
      repo.cleanup()
      cap.cleanup()
    }
  }, 180_000)

  it('混排：--from-brief <brief>,<topic> 两段都注入（brief 节 + topic 维节，顺序按给定值）', () => {
    const repo = mkRepo()
    const cap = makeHookRunner(CAPTURE_HOOK, 'ORCH_SPEC_TEST_CAPTURE', 'research-mix-cap-')
    try {
      writeBriefFixture(repo.root, 'solo', 'SOLO-特征-mix42：单份调研结论。')
      runOrch(repo.root, 'research multi "mix probe" --dim "技术" --dim "成本" --backend mock')
      const r = cap.run(repo.root, ['spec', 'mixed spec', '--from-brief', 'solo,mix-probe', '--backend', 'mock'])
      expect(r.status).toBe(0)
      const prompt = cap.captured()
      expect(prompt).not.toBeNull()
      // brief 段（多 id 时带 P0 分节包装）
      expect(prompt).toContain('# 调研结论（brief：solo）')
      expect(prompt).toContain('SOLO-特征-mix42：单份调研结论。')
      // topic 段：两个 ok 维全注入
      expect(prompt).toContain('# 调研结论（topic：mix-probe｜维度：技术｜brief：mix-probe-d1）')
      expect(prompt).toContain('# 调研结论（topic：mix-probe｜维度：成本｜brief：mix-probe-d2）')
      // 顺序按给定值：solo 在 topic 前；3 节 → 恰 2 个 --- 分隔
      expect((prompt as string).indexOf('SOLO-特征-mix42')).toBeLessThan((prompt as string).indexOf('维度：技术'))
      expect((prompt as string).split('---')).toHaveLength(3)
    } finally {
      repo.cleanup()
      cap.cleanup()
    }
  }, 180_000)

  it('needs_review topic：正常注入且不提示 verify', () => {
    const repo = mkRepo()
    const cap = makeHookRunner(CAPTURE_HOOK, 'ORCH_SPEC_TEST_CAPTURE', 'research-nr-cap-')
    try {
      writeBriefFixture(repo.root, 'nr-probe-d1', 'NR-技术-特征t1：技术维结论。')
      writeBriefFixture(repo.root, 'nr-probe-d2', 'NR-成本-特征t2：成本维结论。')
      writeTopic(repo.root, {
        id: 'nr-probe',
        topic: 'nr probe',
        created_at: '2026-11-09T10:00:00+08:00',
        dims: [
          { dim: '技术', brief_id: 'nr-probe-d1', status: 'ok', reason: null, verdict_level: 'warn', internal_decision: 'needs_review' },
          { dim: '成本', brief_id: 'nr-probe-d2', status: 'ok', reason: null, verdict_level: 'pass', internal_decision: 'ok' },
        ],
        rollup: { level: 'warn', internal_decision: 'needs_review' },
      })
      const r = cap.run(repo.root, ['spec', 'nr spec', '--from-brief', 'nr-probe', '--backend', 'mock'])
      expect(r.status).toBe(0)
      expect(r.stdout).not.toContain('未 L2 复核') // needs_review 不触发提示
      const prompt = cap.captured() as string
      expect(prompt).toContain('NR-技术-特征t1：技术维结论。')
      expect(prompt).toContain('NR-成本-特征t2：成本维结论。')
      expect(prompt.split('---')).toHaveLength(2)
    } finally {
      repo.cleanup()
      cap.cleanup()
    }
  }, 120_000)

  it('unsafe topic：die 可操作报错（含 topic-id 与处置提示），specs/ 无残留', () => {
    const repo = mkRepo()
    try {
      writeTopic(repo.root, {
        id: 'veto-spec',
        topic: 'veto spec',
        created_at: '2026-11-09T10:00:00+08:00',
        dims: [{ dim: '合规', brief_id: 'veto-spec-d1', status: 'ok', reason: null, verdict_level: 'fail', internal_decision: 'unsafe' }],
        rollup: { level: 'fail', internal_decision: 'unsafe' },
      })
      const r = tryOrch(repo.root, 'spec "veto inject spec" --from-brief veto-spec --backend mock')
      expect(r.status).toBe(1)
      expect(r.stderr).toContain('veto-spec')
      expect(r.stderr).toContain('unsafe')
      expect(r.stderr).toContain('一票否决')
      expect(r.stderr).toContain('research-void')
      expect(specResidue(repo.root)).toBe(false) // die 在规划会话之前
    } finally {
      repo.cleanup()
    }
  })

  it('同名 topic 竞态回归（e2e）：预占 topics/<id>.json → multi 派生 -2 落盘；readTopic 命中新 id 可注入', () => {
    const repo = mkRepo()
    const cap = makeHookRunner(CAPTURE_HOOK, 'ORCH_SPEC_TEST_CAPTURE', 'research-race-cap-')
    try {
      writeTopic(repo.root, { id: 'spec-race', topic: '先到者清单', created_at: 'x', dims: [], rollup: {} })
      runOrch(repo.root, 'research multi "spec race" --dim "技术" --dim "成本" --backend mock')
      const r = cap.run(repo.root, ['spec', 'race inject spec', '--from-brief', 'spec-race-2', '--backend', 'mock'])
      expect(r.status).toBe(0)
      const prompt = cap.captured() as string
      expect(prompt).toContain('# 调研结论（topic：spec-race-2｜维度：技术｜brief：spec-race-2-d1）')
      expect(readTopic(repo.root, 'spec-race-2')?.dims).toHaveLength(2)
    } finally {
      repo.cleanup()
      cap.cleanup()
    }
  }, 180_000)
})
