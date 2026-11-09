#!/usr/bin/env node
// discovery-eval.mjs — Dockmaster 上游调研（researcher）评测集跑分器。
//
// 与 reviewer-eval.mjs（验船师）平级：那边考「合成 diff 的红线拦截」，这边考「调研
// 会话的产出质量」——researcher 拿到 调研问题 + goals 罗盘，产出五段契约 brief（与
// research.mjs validateBriefBody 同一契约）。评测集 .agents/discovery-evals/cases/
// （<id>.json：question + 期望关键词）。出题纪律：真实需求场景反推——信号在案（用户
// 反馈/事故/航次报告）的问题才有资格成题，题干写背景不写答案。
//
// 用法：
//   node .agents/scripts/discovery-eval.mjs                # 默认 dry-run：校验案例 schema，零消耗
//   node .agents/scripts/discovery-eval.mjs --list         # 只列案例
//   node .agents/scripts/discovery-eval.mjs --run --backend mock   # 真跑（烧钱，人工发起）
//        [--cases a,b] [--max-turns 25]
//
// 评分是确定性规则（无引用即拒收 + 期望关键词命中率），引用真伪以 brief.md 引用段 +
// sources/ 快照人工复核为准。零第三方依赖；不用 import.meta。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { getBackend, writeWorkerSettings } from './orchestrator/backends/claude-headless.mjs'
import { buildResearchPrompt } from './orchestrator/prompt.mjs'
import { parseBriefBlock, validateBriefBody } from './orchestrator/research.mjs'
import { loadWorkflowConfig } from './workflow-config.mjs'

const CASES_DIR = '.agents/discovery-evals/cases'
const OUTPUTS_DIR = '.agents/discovery-evals/outputs'

function log(s) { console.log(s) }
function die(msg) { console.error(msg); process.exit(1) }

/** 仓库根：向上找 .agents/workflow.json（从 cwd 出发，任何子目录可跑）。 */
function findRepoRoot(start = process.cwd()) {
  let dir = path.resolve(start)
  for (;;) {
    if (fs.existsSync(path.join(dir, '.agents', 'workflow.json'))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) return path.resolve(start)
    dir = parent
  }
}

/** 案例加载 + schema 校验（dry-run 也跑——坏题早暴露，不烧钱才发现）。校验失败 throw（可测试），CLI 层统一 die。 */
export function loadCases(repoRoot, onlyIds = null) {
  const dir = path.join(repoRoot, CASES_DIR)
  let files = []
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'))
  } catch {
    throw new Error(`评测集目录不存在：${dir}`)
  }
  const cases = []
  const problems = []
  for (const f of files) {
    const id = f.replace(/\.json$/, '')
    if (onlyIds && !onlyIds.includes(id)) continue
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))
      for (const k of ['question', 'expect']) if (!j[k]) problems.push(`${id}: 缺 ${k} 字段`)
      if (j.expect && !Array.isArray(j.expect.mustFind)) problems.push(`${id}: expect.mustFind 应为关键词数组`)
      cases.push({
        id,
        question: String(j.question ?? ''),
        goals: String(j.goals ?? ''),
        minCitations: Number.isInteger(j.minCitations) && j.minCitations > 0 ? j.minCitations : 1,
        mustFind: (j.expect?.mustFind ?? []).map((s) => String(s).toLowerCase()),
        mustFindAny: Number.isInteger(j.expect?.mustFindAny) ? j.expect.mustFindAny : (j.expect?.mustFind?.length ?? 0),
      })
    } catch (e) {
      problems.push(`${id}: JSON 解析失败（${String(e.message).slice(0, 120)}）`)
    }
  }
  if (problems.length) throw new Error(`案例 schema 校验失败：\n- ${problems.join('\n- ')}`)
  return cases.sort((a, b) => a.id.localeCompare(b.id))
}

/** 确定性评分：带当日访问日期的引用数达标 + 期望关键词命中率达标。
 *  opts.today 注入固定时钟供测试（缺省真实今天——真跑时 researcher 被要求以当日日期引用）。 */
export function gradeCase(c, briefBody, { today } = {}) {
  if (!briefBody) return { pass: false, reasons: ['无 brief 产出'] }
  const reasons = []
  let citations = 0
  try {
    citations = validateBriefBody(briefBody, { minCitations: c.minCitations, today }).citations.length
  } catch (e) {
    return { pass: false, reasons: [String(e.message).slice(0, 200)] }
  }
  const lower = briefBody.toLowerCase()
  const hits = c.mustFind.filter((k) => lower.includes(k))
  if (hits.length < c.mustFindAny) {
    reasons.push(`关键词命中 ${hits.length}/${c.mustFindAny}（[${c.mustFind.join(', ')}] 中命中 [${hits.join(', ')}]）`)
  }
  return { pass: reasons.length === 0, reasons, citations, hits }
}

async function main() {
  const argv = process.argv.slice(2)
  const flags = new Set(argv.filter((a) => a.startsWith('--')))
  const vals = {}
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--backend') vals.backend = argv[++i]
    if (argv[i] === '--cases') vals.cases = argv[++i]
    if (argv[i] === '--max-turns') vals.maxTurns = parseInt(argv[++i], 10)
    if (argv[i] === '--model') vals.model = argv[++i]
  }
  const repoRoot = findRepoRoot()
  let cases
  try {
    cases = loadCases(repoRoot, vals.cases ? vals.cases.split(',').map((s) => s.trim()) : null)
  } catch (e) {
    die(String(e.message))
  }
  if (!cases.length) die('没有匹配的案例。')
  if (flags.has('--list') || !flags.has('--run')) {
    log(`discovery-eval：${cases.length} 个案例（dry-run 零消耗；--run --backend <name> [--model m] 真跑）`)
    for (const c of cases) {
      log(`- ${c.id}\n    问：${c.question.slice(0, 80)}\n    考：关键词 ≥${c.mustFindAny}/${c.mustFind.length} + 引用 ≥${c.minCitations}`)
    }
    return
  }
  const backendName = vals.backend || 'mock'
  const backend = await getBackend(backendName)
  const maxTurns = Number.isInteger(vals.maxTurns) && vals.maxTurns > 0 ? vals.maxTurns : 25
  // 调研船解耦选型（同 research 命令）：--model 显式 > workflow.json research.model > claude CLI 全局默认
  //——评测不吃全局默认，否则换船时分数与模型档位对不上（2026-11-08 glm-4.5-air 事故同款）
  const model = vals.model || loadWorkflowConfig(repoRoot).research?.model || undefined
  const ts = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19)
  const outDir = path.join(repoRoot, OUTPUTS_DIR, ts)
  fs.mkdirSync(outDir, { recursive: true })
  log(`═══ discovery-eval 真跑：${cases.length} 案 × 后端 ${backendName}${model ? ` / 调研船 ${model}` : ''}（输出 ${outDir}）═══`)
  let pass = 0
  for (const c of cases) {
    const promptFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'disco-eval-')), 'prompt.md')
    const settingsFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'disco-eval-s-')), 'settings.json')
    try {
      fs.writeFileSync(promptFile, buildResearchPrompt(c.question, repoRoot, { goalsText: c.goals, minCitations: c.minCitations }))
      if (backendName === 'claude-headless') writeWorkerSettings(settingsFile, {}, repoRoot)
      const result = await backend.spawn({ promptFile, cwd: repoRoot, maxTurns, onEvent: () => {}, web: true, model, settingsFile })
      // 每案写入前幂等重建 outDir：长会话期间 outputs/ 被并行清理（git clean 等）不再炸整案
      //（2026-11-09 实测：outputs/ 未入 gitignore 且被中途删除，5 案全 ENOENT）
      fs.mkdirSync(outDir, { recursive: true })
      fs.writeFileSync(path.join(outDir, `${c.id}.output.txt`), String(result.output ?? ''))
      const parsed = parseBriefBlock(result.output ?? '')
      const g = gradeCase(c, parsed?.body ?? null)
      if (g.pass) pass++
      log(`${g.pass ? '✅' : '❌'} ${c.id}——${g.pass ? `PASS（引用 ${g.citations}，关键词 ${g.hits.length}/${c.mustFind.length}）` : g.reasons.join('；')}`)
    } catch (e) {
      log(`❌ ${c.id}——运行失败：${String(e?.message ?? e).slice(0, 200)}`)
    } finally {
      fs.rmSync(path.dirname(promptFile), { recursive: true, force: true })
      fs.rmSync(path.dirname(settingsFile), { recursive: true, force: true })
    }
  }
  log(`═══ 结果：${pass}/${cases.length} 通过（输出留档 ${outDir}，人工复核引用真伪）═══`)
  if (pass < cases.length) process.exit(1)
}

// 直跑判定（工具链约定不用 import.meta）：测试 import 本模块只取纯函数，main 不执行
const IS_MAIN = process.argv[1] && path.basename(process.argv[1]) === 'discovery-eval.mjs'
if (IS_MAIN) await main()
