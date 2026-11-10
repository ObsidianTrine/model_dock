// sail 自由航行 × researchAutoDim 自动拆维度调研（multi-dim 方案 P3，mock 后端零外部调用）：
// 纯函数（parseDimsPlan 拆维解析 / buildResearchDimsPrompt 契约 / resolveFreeSail researchAutoDim
// 校验）+ e2e：拆维成功 → multi topic（<topic>-dN）→ spec 按维注入（维序正确）；拆维失败/
// 不足 2 维优雅降级单 brief；rollup unsafe → 不升级 spec + 草稿留痕 + 后续航次零调研（成本
// 闸门）；undetermined 提示后照常升级；autoDim 关（缺省）→ 现行为零变化；researchPerCycle
// cap 对 multi 计 1。与 sail.test.ts / research-multi.test.ts 分文件（helpers 复用同款
// mkRepo/runOrch）。
// prompt 捕获同 research-concurrency 的手法：module load 钩子包一层 mock 后端的 spawn
// （零 vi.mock，singleFork 下无跨文件 mock 冲突；钩子只在带 --import 的子进程生效）。

import { describe, expect, it, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseDimsPlan } from '../../.agents/scripts/orchestrator/research.mjs'
import { DIMS_SPLIT_MARKER, buildResearchDimsPrompt } from '../../.agents/scripts/orchestrator/prompt.mjs'
import { loadWorkflowConfig } from '../../.agents/scripts/workflow-config.mjs'
import { mkRepo, runOrch, tryOrch } from './helpers.js'

const WORKTREE_ROOT = path.resolve(process.cwd()) // vitest 的 cwd = 仓库根（worktree 内），同 helpers.ts

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sail-autodim-'))
}

type RepoLike = string | { root: string }
const rootOf = (r: RepoLike): string => (typeof r === 'string' ? r : r.root)

function orchBase(repo: RepoLike): string {
  return path.join(rootOf(repo), '.agents', 'orchestrator')
}

function readDraft(repo: RepoLike, id = 'planner-mock-task'): string {
  return fs.readFileSync(path.join(orchBase(repo), 'drafts', `${id}.md`), 'utf8')
}

function readTopicFile(repo: RepoLike, topicId: string): any {
  return JSON.parse(fs.readFileSync(path.join(orchBase(repo), 'research', 'topics', `${topicId}.json`), 'utf8'))
}

// ---------------------------------------------------------------------------
// 全量 prompt 捕获钩子（JSONL 逐会话追加；断言「派了哪些会话、什么顺序」用）
// ---------------------------------------------------------------------------

const CAPTURE_ALL_HOOK = `
export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  if (!url.endsWith('/backends/mock.mjs')) return result;
  result.source = String(result.source) + \`
;{
  const __fs = await import('node:fs');
  const __EOL = String.fromCharCode(10);
  const __origSpawn = mockBackend.spawn.bind(mockBackend);
  mockBackend.spawn = async (inv) => {
    const __cap = process.env.ORCH_SAIL_TEST_CAPTURE;
    let __text = '';
    try { __text = __fs.readFileSync(inv.promptFile, 'utf8'); } catch {}
    if (__cap) { try { __fs.appendFileSync(__cap, JSON.stringify({ prompt: __text }) + __EOL); } catch {} }
    return await __origSpawn(inv);
  };
}
\`;
  return { ...result, shortCircuit: true };
}
`

/** sail 航次专用 runner：捕获全部 mock 会话 prompt（JSONL）。 */
function makeCaptureRunner() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sail-autodim-cap-'))
  const registerFile = path.join(dir, 'register.mjs')
  fs.writeFileSync(registerFile, `import { register } from 'node:module';\nregister('./hook.mjs', import.meta.url);\n`)
  fs.writeFileSync(path.join(dir, 'hook.mjs'), CAPTURE_ALL_HOOK)
  const captureFile = path.join(dir, 'captured.jsonl')
  return {
    run(repo: string, args: string, env: Record<string, string> = {}): { status: number; stdout: string; stderr: string } {
      const orch = path.join(WORKTREE_ROOT, '.agents', 'scripts', 'orchestrator.mjs')
      const r = spawnSync(process.execPath, ['--import', pathToFileURL(registerFile).href, orch, ...args.split(' ')], {
        cwd: repo,
        encoding: 'utf8',
        env: { ...process.env, ORCH_SAIL_TEST_CAPTURE: captureFile, ...env },
        timeout: 180_000,
        maxBuffer: 32 * 1024 * 1024,
      })
      return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
    },
    prompts(): string[] {
      if (!fs.existsSync(captureFile)) return []
      return fs
        .readFileSync(captureFile, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l).prompt as string)
    },
    /** 清空捕获（两段式航次之间分段断言用）。 */
    reset(): void {
      fs.rmSync(captureFile, { force: true })
    },
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  }
}

const isDimsPrompt = (p: string) => p.includes('拆分调研维度')
const isResearchPrompt = (p: string) => p.includes('调研问题：')
const isSpecPrompt = (p: string) => p.includes('把下面的意图编译成规格三件套')
const isProposePrompt = (p: string) => p.includes('项目需求综合')

describe('orchestrator sail-autodim > 纯函数', () => {
  it('parseDimsPlan：围栏/裸文本/序号项目符号容忍、去重保序、<2 null、>4 截断', () => {
    // 围栏包裹（agents-dims 契约）
    expect(parseDimsPlan('```agents-dims\n技术选型\n成本\n```')).toEqual(['技术选型', '成本'])
    // 普通围栏（无标记）也容忍
    expect(parseDimsPlan('分析如下：\n```\n- 技术选型\n2. 成本与维护\n```')).toEqual(['技术选型', '成本与维护'])
    // 无围栏裸文本 + 行首装饰剔除 + 精确去重保序
    expect(parseDimsPlan('维度如下\n1. 技术选型\n- 成本\n技术选型\n① 风险')).toEqual(['技术选型', '成本', '风险'])
    // 标题行/空行/围栏残留剔除
    expect(parseDimsPlan('# 维度\n\n技术选型\n成本\n```')).toEqual(['技术选型', '成本'])
    // 超长行（一句话解释混入）按非维度丢弃
    expect(parseDimsPlan('技术选型\n成本\n这一行的意思是说我们需要仔细评估这个提案在各个维度上的投入产出比与长期维护成本收益')).toEqual(['技术选型', '成本'])
    // >4 截断（契约上限）
    expect(parseDimsPlan('a\nb\nc\nd\ne\nf')).toEqual(['a', 'b', 'c', 'd'])
    // 不足 2 维 → null（调用方降级单 brief）
    expect(parseDimsPlan('只有一维')).toBeNull()
    expect(parseDimsPlan('```agents-dims\n技术选型\n```')).toBeNull()
    expect(parseDimsPlan('')).toBeNull()
    expect(parseDimsPlan(null)).toBeNull()
  })

  it('buildResearchDimsPrompt：DIMS_SPLIT_MARKER 契约块 + 提案目标注入 + 硬性要求（planner 家族同构）', () => {
    const repo = mkRepo()
    try {
      const prompt = buildResearchDimsPrompt('给网关加多维调研', repo.root)
      expect(prompt).toContain('拆分调研维度')
      expect(prompt).toContain('提案目标：给网关加多维调研')
      expect(prompt).toContain('```' + DIMS_SPLIT_MARKER)
      expect(prompt).toContain('每行一个维度')
      // planner 家族同构：AGENTS.md 注入 + 意图消毒 + 硬性要求
      expect(prompt).toContain('# 系统层：仓库约定（AGENTS.md')
      expect(prompt).toContain('硬性要求')
      expect(prompt).toContain('你没有 Bash')
    } finally {
      repo.cleanup()
    }
  })
})

describe('orchestrator sail-autodim > resolveFreeSail researchAutoDim 校验', () => {
  function cfgOf(freeSail: unknown) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wfcfg-autodim-'))
    try {
      fs.mkdirSync(path.join(dir, '.agents'))
      fs.writeFileSync(path.join(dir, '.agents', 'workflow.json'), JSON.stringify({ baseBranch: 'develop', freeSail }))
      return loadWorkflowConfig(dir)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }

  it('bool true/false 生效；键缺失不产出该键（调用方回落缺省 false，行为零漂移）', () => {
    expect(cfgOf({ researchAutoDim: true }).freeSail).toEqual({ researchAutoDim: true })
    expect(cfgOf({ researchAutoDim: false }).freeSail).toEqual({ researchAutoDim: false })
    expect(cfgOf(undefined).freeSail).toEqual({})
    expect(cfgOf({ researchPerCycle: 1 }).freeSail).toEqual({ researchPerCycle: 1 }) // 其他键不受连坐
  })

  it('非 bool 值（字符串/数字）console.warn 报错并忽略——回落缺省关', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      for (const bad of ['yes', 1, null]) {
        const cfg = cfgOf({ researchAutoDim: bad })
        expect(cfg.freeSail?.researchAutoDim).toBeUndefined()
        expect(warn.mock.calls.some((args) => String(args[0]).includes('researchAutoDim'))).toBe(true)
        warn.mockClear()
      }
    } finally {
      warn.mockRestore()
    }
  })
})

describe('orchestrator sail-autodim > autoDim 开 + 拆维成功（mock e2e）', () => {
  it('拆维会话 → multi topic（<topic>-dN）→ spec 按维注入（维序正确）→ 草稿盖 topic-id + research_kind', () => {
    const repo = mkRepo({ extra: { freeSail: { researchAutoDim: true } } })
    const cap = makeCaptureRunner()
    try {
      const out = cap.run(repo.root, 'sail --duration 12s --interval 1 --backend mock', { ORCH_MOCK_PLANNER_FEATURE: '1' })
      expect(out.status).toBe(0)
      expect(out.stdout).toContain('到达时长上限')
      // 拆维会话被派（propose → 拆维 → 3 个维度 researcher → spec，顺序固定）
      const prompts = cap.prompts()
      const iPropose = prompts.findIndex(isProposePrompt)
      const iDims = prompts.findIndex(isDimsPrompt)
      const dimResearchIdx = prompts.map((p, i) => (isResearchPrompt(p) ? i : -1)).filter((i) => i >= 0)
      const iSpec = prompts.findIndex(isSpecPrompt)
      expect(iDims).toBeGreaterThan(iPropose)
      expect(dimResearchIdx).toHaveLength(3)
      expect(dimResearchIdx[0]).toBeGreaterThan(iDims)
      expect(iSpec).toBeGreaterThan(dimResearchIdx[2])
      // multi 出 topic：brief id 强制 <topic>-d<N>、meta 带 topic 溯源、维序 = 拆维输出序
      const topic = readTopicFile(repo.root, 'mock-planner')
      expect(topic.dims.map((d: any) => d.dim)).toEqual(['技术选型', '成本与维护', '生态兼容风险'])
      expect(topic.dims.map((d: any) => d.brief_id)).toEqual(['mock-planner-d1', 'mock-planner-d2', 'mock-planner-d3'])
      expect(topic.rollup).toEqual({ level: 'unknown', internal_decision: 'undetermined' })
      for (const n of [1, 2, 3]) {
        const meta = JSON.parse(fs.readFileSync(path.join(orchBase(repo), 'research', `mock-planner-d${n}`, 'meta.json'), 'utf8'))
        expect(meta.topic_id).toBe('mock-planner')
      }
      // spec 注入含各维内容 + 维序正确（每 ok 维一节，节头带 topic/维度/brief 溯源）
      const specPrompt = prompts[iSpec]
      expect(specPrompt).toContain('# 调研结论（topic：mock-planner｜维度：技术选型｜brief：mock-planner-d1）')
      expect(specPrompt.indexOf('维度：技术选型')).toBeLessThan(specPrompt.indexOf('维度：成本与维护'))
      expect(specPrompt.indexOf('维度：成本与维护')).toBeLessThan(specPrompt.indexOf('维度：生态兼容风险'))
      // undetermined：提示未 L2 复核但不阻断，spec 照常落盘待人审
      expect(out.stdout).toContain('未 L2 复核')
      expect(out.stdout).toContain('research verify mock-planner')
      expect(fs.existsSync(path.join(orchBase(repo), 'specs', 'planner-mock-task', 'design.md'))).toBe(true)
      // 草稿盖章：research = topic-id + research_kind: topic（向后兼容新字段）
      const draft = readDraft(repo.root)
      expect(draft).toMatch(/research: mock-planner$/m)
      expect(draft).toMatch(/^research_kind: topic$/m)
      // 航海报告收录多维调研去向
      expect(out.stdout).toContain('上游管线：多维调研 topic mock-planner 已落盘（3 维，rollup unknown/undetermined）')
      expect(out.stdout).toContain('spec 按维注入')
    } finally {
      repo.cleanup()
      cap.cleanup()
    }
  }, 180_000)
})

describe('orchestrator sail-autodim > 拆维失败优雅降级（mock e2e）', () => {
  it('拆维只解析出 1 维 → 降级单 brief 调研，管线不炸（brief 非 topic 盖章）', () => {
    const repo = mkRepo({ extra: { freeSail: { researchAutoDim: true } } })
    const cap = makeCaptureRunner()
    try {
      const out = cap.run(repo.root, 'sail --duration 12s --interval 1 --backend mock', {
        ORCH_MOCK_PLANNER_FEATURE: '1',
        ORCH_MOCK_DIMS_SPLIT: 'one',
      })
      expect(out.status).toBe(0)
      // 拆维会话照派，但降级单 brief：有拆维 prompt + 恰 1 个调研 prompt（非 3 个）
      const prompts = cap.prompts()
      expect(prompts.some(isDimsPrompt)).toBe(true)
      expect(prompts.filter(isResearchPrompt)).toHaveLength(1)
      expect(out.stdout).toContain('拆维不可用（会话失败或解析不足 2 维）——降级单 brief 调研')
      // 单 brief 盖章（无 research_kind、无 topic 清单）
      const draft = readDraft(repo.root)
      expect(draft).toMatch(/research: mock-planner$/m)
      expect(draft).not.toMatch(/^research_kind:/m)
      expect(fs.existsSync(path.join(orchBase(repo), 'research', 'topics', 'mock-planner.json'))).toBe(false)
      expect(fs.existsSync(path.join(orchBase(repo), 'research', 'mock-planner', 'brief.md'))).toBe(true)
      // 管线不炸：spec 照常落盘
      expect(fs.existsSync(path.join(orchBase(repo), 'specs', 'planner-mock-task', 'design.md'))).toBe(true)
    } finally {
      repo.cleanup()
      cap.cleanup()
    }
  }, 180_000)

  it('拆维输出无法解析（无围栏无维度行）→ 同样降级单 brief', () => {
    const repo = mkRepo({ extra: { freeSail: { researchAutoDim: true } } })
    try {
      const out = runOrch(repo.root, 'sail --duration 12s --interval 1 --backend mock', {
        ORCH_MOCK_PLANNER_FEATURE: '1',
        ORCH_MOCK_DIMS_SPLIT: 'invalid',
      })
      expect(out.status).toBe(0)
      expect(out.stdout).toContain('拆维不可用')
      expect(fs.existsSync(path.join(orchBase(repo), 'research', 'mock-planner', 'brief.md'))).toBe(true)
      expect(fs.existsSync(path.join(orchBase(repo), 'specs', 'planner-mock-task', 'design.md'))).toBe(true)
    } finally {
      repo.cleanup()
    }
  }, 180_000)
})

describe('orchestrator sail-autodim > unsafe 决策闸门（mock e2e）', () => {
  it('rollup unsafe（verify 造 contradicted）→ 下一航次不升级 spec、草稿留痕、零调研零拆维（成本闸门）', () => {
    const repo = mkRepo({ extra: { freeSail: { researchAutoDim: true } } })
    const cap = makeCaptureRunner()
    try {
      // 航次 1：autoDim 正常走通（topic undetermined → spec 升级）
      const v1 = cap.run(repo.root, 'sail --duration 12s --interval 1 --backend mock', { ORCH_MOCK_PLANNER_FEATURE: '1' })
      expect(v1.status).toBe(0)
      expect(fs.existsSync(path.join(orchBase(repo), 'specs', 'planner-mock-task', 'design.md'))).toBe(true)
      // L2 复核把 rollup 翻成 unsafe（ORCH_MOCK_REVIEW_BLOCKERS>0 → 每维 contradicted 一票
      // 否决；ORCH_MOCK_ARB_RULING=overturned 让仲裁维持否决——mock 仲裁缺省 upheld 会翻案）
      const verify = runOrch(repo.root, 'research verify mock-planner --backend mock', { ORCH_MOCK_REVIEW_BLOCKERS: '3', ORCH_MOCK_ARB_RULING: 'overturned' })
      expect(verify.stdout).toContain('rollup 重算')
      const topic = readTopicFile(repo.root, 'mock-planner')
      expect(topic.rollup).toEqual({ level: 'unknown', internal_decision: 'unsafe' })
      // 航次 2 准备：删 spec（模拟未升级）+ 删旧 draft（让 propose 重出新提案，research 行由
      // ORCH_MOCK_PLANNER_RESEARCH 指回既有 topic——模拟真 planner「引用既有 brief id」）
      fs.rmSync(path.join(orchBase(repo), 'specs'), { recursive: true, force: true })
      fs.rmSync(path.join(orchBase(repo), 'drafts', 'planner-mock-task.md'), { force: true })
      cap.reset() // 分段断言：航次 2 的会话清零重计
      const v2 = cap.run(repo.root, 'sail --duration 12s --interval 1 --backend mock', {
        ORCH_MOCK_PLANNER_FEATURE: '1',
        ORCH_MOCK_PLANNER_RESEARCH: 'mock-planner',
      })
      expect(v2.status).toBe(0)
      // 成本闸门：整个航次零调研、零拆维、零 spec（防自治循环反复烧钱）
      const prompts2 = cap.prompts()
      expect(prompts2.filter(isResearchPrompt)).toHaveLength(0)
      expect(prompts2.filter(isDimsPrompt)).toHaveLength(0)
      expect(prompts2.filter(isSpecPrompt)).toHaveLength(0)
      expect(fs.existsSync(path.join(orchBase(repo), 'specs'))).toBe(false)
      // 草稿留痕：research_status: unsafe（后续周期见此即跳过）
      const draft = readDraft(repo.root)
      expect(draft).toMatch(/research: mock-planner$/m)
      expect(draft).toMatch(/^research_status: unsafe$/m)
      // 航次报告 + fleet 台账留痕
      expect(v2.stdout).toContain('⛔ 上游管线：planner-mock-task——调研 topic mock-planner 判 unsafe（决策契约一票否决），spec 不升级，已留痕跳过')
      expect(v2.stdout).toContain('作废重跑')
      const fleet = fs.readFileSync(path.join(orchBase(repo), 'logs', 'fleet.jsonl'), 'utf8')
      expect(fleet).toContain('sail_research_unsafe')
      expect(fleet).toContain('"draft":"planner-mock-task"')
    } finally {
      repo.cleanup()
      cap.cleanup()
    }
  }, 240_000)

  it('undetermined topic 续接：提示未复核后照常升级（spec 落盘本就待人审）', () => {
    const repo = mkRepo({ extra: { freeSail: { researchAutoDim: true } } })
    const cap = makeCaptureRunner()
    try {
      // 先跑一次 multi 造 undetermined topic（含维 brief），删 draft 让 propose 重出引用它的提案
      runOrch(repo.root, 'research multi "seed probe" --dim "技术" --dim "成本" --backend mock')
      fs.rmSync(path.join(orchBase(repo), 'drafts'), { recursive: true, force: true })
      const out = cap.run(repo.root, 'sail --duration 12s --interval 1 --backend mock', {
        ORCH_MOCK_PLANNER_FEATURE: '1',
        ORCH_MOCK_PLANNER_RESEARCH: 'seed-probe',
      })
      expect(out.status).toBe(0)
      // undetermined：提示 + 照常升级（不派调研、不派拆维——续接既有 topic）
      expect(out.stdout).toContain('⚠ topic seed-probe 未 L2 复核（internal_decision=undetermined）')
      expect(out.stdout).toContain('research verify seed-probe')
      const prompts = cap.prompts()
      expect(prompts.filter(isResearchPrompt)).toHaveLength(0)
      expect(prompts.filter(isDimsPrompt)).toHaveLength(0)
      expect(prompts.filter(isSpecPrompt)).toHaveLength(1)
      expect(fs.existsSync(path.join(orchBase(repo), 'specs', 'planner-mock-task', 'design.md'))).toBe(true)
      const specPrompt = prompts.find(isSpecPrompt) as string
      expect(specPrompt).toContain('# 调研结论（topic：seed-probe｜维度：技术｜brief：seed-probe-d1）')
    } finally {
      repo.cleanup()
      cap.cleanup()
    }
  }, 180_000)
})

describe('orchestrator sail-autodim > autoDim 关（缺省）与 cap', () => {
  it('autoDim 关（缺省）：现行为零变化——直接派单 brief researcher，无拆维会话、无 research_kind', () => {
    const repo = mkRepo()
    const cap = makeCaptureRunner()
    try {
      const out = cap.run(repo.root, 'sail --duration 12s --interval 1 --backend mock', { ORCH_MOCK_PLANNER_FEATURE: '1' })
      expect(out.status).toBe(0)
      const prompts = cap.prompts()
      expect(prompts.filter(isDimsPrompt)).toHaveLength(0)
      expect(prompts.filter(isResearchPrompt)).toHaveLength(1)
      expect(fs.existsSync(path.join(orchBase(repo), 'research', 'topics'))).toBe(false)
      const draft = readDraft(repo.root)
      expect(draft).toMatch(/research: mock-planner$/m)
      expect(draft).not.toMatch(/^research_kind:/m)
      expect(draft).not.toMatch(/^research_status:/m)
      expect(fs.existsSync(path.join(orchBase(repo), 'specs', 'planner-mock-task', 'design.md'))).toBe(true)
    } finally {
      repo.cleanup()
      cap.cleanup()
    }
  }, 180_000)

  it('researchPerCycle=1：multi 计 1 个调研动作（拆维+N 维会话照跑），第二个提案超 cap 记失败', () => {
    const repo = mkRepo({ extra: { freeSail: { researchAutoDim: true, researchPerCycle: 1 } } })
    try {
      const out = runOrch(repo.root, 'sail --duration 12s --interval 1 --backend mock', {
        ORCH_MOCK_PLANNER_FEATURE: '1',
        ORCH_MOCK_PLANNER_FEATURE_COUNT: '2',
      })
      expect(out.status).toBe(0)
      // 提案 1：multi 完整跑通（拆维 + 3 维 researcher 都在 cap=1 下发生——multi 是一个动作）
      const topic = readTopicFile(repo.root, 'mock-planner')
      expect(topic.dims).toHaveLength(3)
      expect(fs.existsSync(path.join(orchBase(repo), 'specs', 'planner-mock-task', 'design.md'))).toBe(true)
      // 提案 2：超 cap——不派调研，记可操作失败原因
      expect(out.stdout).toContain('planner-mock-task-2')
      expect(out.stdout).toContain('缺调研 brief（派发失败或超本周期上限）——下一周期重试')
      expect(fs.existsSync(path.join(orchBase(repo), 'research', 'topics', 'mock-planner-2.json'))).toBe(false)
    } finally {
      repo.cleanup()
    }
  }, 180_000)
})
