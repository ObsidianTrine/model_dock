#!/usr/bin/env node
// reviewer-eval.mjs — Dockmaster 验船师（orchestrator reviewer）评测集跑分器。
//
// 与 scripts/review-eval.mjs（PR 审查 bot 的历史 bug 考题）平级：那边考「PR 审查者」，
// 这边考「Dockmaster 闭环里的验船师」——reviewer 拿到的是 任务卡目标 + files_hint +
// REVIEW.md 纪律摘要（截 8000 字符，与 orchestrator reviewDiscipline 同口径）+ diff，
// 输出 REVIEW_SUMMARY 契约行（与 prompt.mjs buildReviewerPrompt/parseReviewVerdict
// 同一契约）。评测集在 .agents/review-evals/reviewer/cases/（<id>.diff.md 合成 diff +
// <id>.expect.md 期望判定成对，出题纪律见同目录 README.md）。
//
// 用法：
//   node .agents/scripts/reviewer-eval.mjs                    # 默认 dry-run：打印将执行的案例与后端，零消耗
//   node .agents/scripts/reviewer-eval.mjs --list             # 只列案例（id + 考点一行）
//   node .agents/scripts/reviewer-eval.mjs --grade <输出目录>  # 对既有输出静态重放评分（不 spawn LLM，CI 可用）
//   node .agents/scripts/reviewer-eval.mjs --run --backend zcode-headless|claude-headless \
//        [--model m] [--cases a,b] [--timeout-min 10] [--max-turns 30]   # 真跑（烧钱，人工发起）
//
// 设计要点：
// - spawn 复刻 orchestrator 两条后端纪律：zcode 无 shell 直 argv（ORCH_ZCODE_CLI 定位，
//   mode plan + 整工具禁用双保险）；claude 走 stream-json + --allowedTools 只读白名单，
//   Windows 必须 shell（.cmd 包装）。
// - diff 不进 argv：完整材料（纪律摘要 + diff）写进输出目录的 <id>.material.md，prompt
//   只带文件引用——zcode headless 的 prompt 走 argv，30k 字符上限是 orchestrator 的
//   血泪教训（escalation 升档判定同源），材料内联必炸。
// - 单案例超时（默认 10 分钟）由 spawnSync timeout 兜底：超时/启动失败记「运行失败」
//   继续其余案例（夜里无人值守，一题卡死不应丢掉整轮分数）。
// - 评分是启发式（expect 关键词命中 + REVIEW_SUMMARY 契约计数），是否真审出以
//   <id>.output.txt 原文人工复核为准——关键词 ✅ 有「红线清单复述」型假阳性先例
//   （见 .agents/review-evals/README.md tray-jsonunescape-double 行）。
// - 零第三方依赖；不用 import.meta（以 process.argv[1] 文件名判定直跑）；路径全 path.join。

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { buildZcodeArgs, parseHeadlessJson, zcodeCliSpec, ZCODE_PROMPT_LIMIT } from './orchestrator/backends/zcode-headless.mjs'

const BACKENDS = ['zcode-headless', 'claude-headless']
/** REVIEW.md 纪律摘要截断口径：与 orchestrator.mjs reviewDiscipline 一致。 */
const DISCIPLINE_CAP = 8000
/** 单案例材料体积护栏（对齐 scripts/review-eval.mjs 的 120KB 上限）。 */
const MATERIAL_CAP = 120_000
/** claude 审查会话默认轮次上限（对齐 orchestrator reviewMaxTurns 缺省 30）。 */
const DEFAULT_MAX_TURNS = 30
/** 单案例默认超时（分钟）。 */
const DEFAULT_TIMEOUT_MIN = 10
/** reviewer 整工具禁用清单：与 orchestrator zcode-headless 的 REVIEWER_DISALLOWED 同款（未导出，此处镜像）。 */
const REVIEWER_DISALLOWED = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash', 'WebFetch']

const VERDICT_RE = /REVIEW_SUMMARY:\s*blockers=(\d+)\s+suggestions=(\d+)\s+notes=(\d+)/
const FAXIAN_RE = /发现\s*[1-9]\d*\s*个问题/

// ---------------------------------------------------------------- 仓库与案例定位

/** 仓库根：向上找 .agents/workflow.json（不用 import.meta，从 cwd 出发，任何子目录可跑）。 */
function findRepoRoot(start = process.cwd()) {
  let dir = path.resolve(start)
  for (;;) {
    if (fs.existsSync(path.join(dir, '.agents', 'workflow.json'))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) return path.resolve(start)
    dir = parent
  }
}

function casesDirOf(root) {
  return path.join(root, '.agents', 'review-evals', 'reviewer', 'cases')
}

/** 从 diff.md 的头部 HTML 注释解析案例元信息（考点/goal/acceptance/files_hint）。 */
export function parseCaseHeader(diffMd) {
  const m = /<!--([\s\S]*?)-->/.exec(diffMd)
  const header = { kaodian: '', goal: '', acceptance: '', filesHint: '' }
  if (!m) return header
  const lines = m[1].split('\n').map((l) => l.trim()).filter(Boolean)
  const KEY_RE = /^(考点|goal|acceptance|files_hint)\s*[:：]\s*(.*)$/
  let current = null
  for (const line of lines) {
    const km = KEY_RE.exec(line)
    if (km) {
      current = km[1]
      if (current === '考点') header.kaodian = km[2]
      if (current === 'goal') header.goal = km[2]
      if (current === 'acceptance') header.acceptance = km[2]
      if (current === 'files_hint') header.filesHint = km[2]
    } else if (current === '考点') {
      header.kaodian += `\n${line}` // 考点允许多行续写（到下一个 key 行为止）
    }
  }
  return header
}

/** 提取 ```diff 围栏里的 diff 正文（考点注释绝不进审查材料——那是答案）。 */
export function extractDiff(diffMd, caseId = '?') {
  const m = /```diff\n([\s\S]*?)```/.exec(diffMd)
  if (!m || !m[1].trim()) {
    throw new Error(`案例 ${caseId}：diff.md 里没有 \`\`\`diff 围栏块（出题格式见 reviewer/README.md）。`)
  }
  return m[1]
}

/**
 * 解析 expect.md 机器可读段：
 *   clean: true|false               （缺省 false；true = 干净负样本，应抓段必须为空）
 *   ## 应抓（阻塞点）               行格式：- [P0] 关键词: a|b — 说明
 *   ## 不应抓（噪音）               行格式：- 关键词: a|b — 说明（机器核对）；无关键词条目仅展示
 */
export function parseExpect(md) {
  const body = md.replace(/<!--[\s\S]*?-->/g, '')
  const cleanM = /^\s*clean:\s*(true|false)\s*$/m.exec(body)
  const clean = cleanM ? cleanM[1] === 'true' : false
  const blockers = []
  const noise = []
  const notes = []
  let section = null
  for (const raw of body.split('\n')) {
    const line = raw.trim()
    if (/^##/.test(line)) {
      // 先判噪音段：「不应抓」含子串「应抓」，顺序反了会把噪音行吞进应抓段
      section = /噪音|不应抓/.test(line) ? 'noise' : /应抓/.test(line) ? 'catch' : null
      continue
    }
    if (!section || !line.startsWith('-')) continue
    if (section === 'catch') {
      const m = /^-\s*\[(P[012])\]\s*关键词[:：]\s*(\S+)\s*(?:[—–-]+\s*(.*))?$/.exec(line)
      if (m) blockers.push({ level: m[1], keywords: m[2].split('|').filter(Boolean), desc: (m[3] ?? '').trim() })
    } else {
      const m = /^-\s*关键词[:：]\s*(\S+)\s*(?:[—–-]+\s*(.*))?$/.exec(line)
      if (m) noise.push({ keywords: m[1].split('|').filter(Boolean), desc: (m[2] ?? '').trim() })
      else notes.push(line.replace(/^-\s+/, ''))
    }
  }
  return { clean, blockers, noise, notes }
}

/** 加载案例（成对校验 + 排序）。 */
export function loadCases(casesDir) {
  if (!fs.existsSync(casesDir)) throw new Error(`评测集目录不存在：${casesDir}`)
  const files = fs.readdirSync(casesDir)
  const ids = [...new Set(files.filter((f) => f.endsWith('.diff.md')).map((f) => f.slice(0, -'.diff.md'.length)))].sort((a, b) => a.localeCompare(b))
  if (!ids.length) throw new Error(`评测集目录为空：${casesDir}`)
  return ids.map((id) => {
    const expectPath = path.join(casesDir, `${id}.expect.md`)
    if (!fs.existsSync(expectPath)) throw new Error(`案例 ${id} 缺少成对的 <id>.expect.md（期望判定）。`)
    const diffMd = fs.readFileSync(path.join(casesDir, `${id}.diff.md`), 'utf8')
    return {
      id,
      header: parseCaseHeader(diffMd),
      diffText: extractDiff(diffMd, id),
      expect: parseExpect(fs.readFileSync(expectPath, 'utf8')),
    }
  })
}

/** --cases 过滤：未知 id 直接报错并给可用清单（打错字静默全跑会白烧钱）。 */
export function filterCases(all, casesFlag) {
  if (!casesFlag) return all
  const wanted = casesFlag.split(',').map((s) => s.trim()).filter(Boolean)
  const known = new Set(all.map((c) => c.id))
  const unknown = wanted.filter((w) => !known.has(w))
  if (unknown.length) {
    throw new Error(`未知案例 id：${unknown.join(', ')}。可用：${all.map((c) => c.id).join(', ')}`)
  }
  return all.filter((c) => wanted.includes(c.id))
}

// ---------------------------------------------------------------- 审查输入组装

/** REVIEW.md 纪律摘要（截 8000 字符，与 orchestrator reviewDiscipline 同口径）。 */
export function reviewDisciplineText(root) {
  const p = path.join(root, 'REVIEW.md')
  if (!fs.existsSync(p)) return ''
  const text = fs.readFileSync(p, 'utf8')
  if (!text.trim()) return ''
  return text.length > DISCIPLINE_CAP
    ? `${text.slice(0, DISCIPLINE_CAP)}\n…（REVIEW.md 超 ${DISCIPLINE_CAP} 字符已截断，全文见仓库根）`
    : text
}

/** 审查材料 = 纪律摘要 + diff（写文件传引用，防 zcode 30k argv 上限）。 */
export function buildMaterial(discipline, diffText) {
  const d = discipline || '（本仓库未提供 REVIEW.md，按通用审查纪律执行）'
  return (
    `# 审查纪律（REVIEW.md 摘要，与人工/PR 审查同一标准）\n\n${d}\n\n` +
    `---\n\n# 待审查 diff（git diff <base>...HEAD）\n\n\`\`\`diff\n${diffText}\`\`\`\n`
  )
}

/** reviewer 指令 prompt：结构与 orchestrator buildReviewerPrompt 的四检查项 + REVIEW_SUMMARY 契约一致；
 *  diff 本体经 materialPath 文件引用（zcode argv 上限教训）。 */
export function buildEvalPrompt({ goal, acceptance, filesHint, materialPath }) {
  const hint = filesHint || '（未声明）'
  return (
    `请审查这个 diff。任务目标是：${goal || '（未声明，按 diff 自身意图审）'}\n\n` +
    '请检查：\n' +
    `1. 改动是否完整实现了目标（对照验收标准：\n${acceptance || '（未声明）'}\n）？\n` +
    '2. 有没有引入明显 bug、安全问题、或破坏项目红线（审查纪律见待审材料中的 REVIEW.md 摘要，与人工/PR 审查同一标准）？\n' +
    '3. 测试是否覆盖了改动路径？\n' +
    `4. 有没有不必要的改动混入（顺手重构、无关格式化、超出预期范围：${hint}）？\n\n` +
    '只报告问题，不修改代码。每个问题给出严重级别（阻塞/建议/提示）。输出末尾用一行汇总：\n' +
    'REVIEW_SUMMARY: blockers=<n> suggestions=<n> notes=<n>\n\n' +
    '# 待审查 diff 与审查纪律\n\n' +
    `完整材料（REVIEW.md 纪律摘要 + diff 全文）已写入文件：${materialPath}\n` +
    '请先读取该文件再开始审查。\n'
  )
}

// ---------------------------------------------------------------- 后端 spawn（复刻 orchestrator 纪律）

/** zcode-headless：无 shell 直 argv（Windows 套 shell 会截断/改写参数），mode plan 只读 + 整工具禁用双保险。 */
function runZcodeReview(prompt, { cwd, timeoutMs }) {
  if (prompt.length > ZCODE_PROMPT_LIMIT) {
    throw new Error(`reviewer 指令 prompt ${prompt.length} 字符超 zcode argv 上限 ${ZCODE_PROMPT_LIMIT}（材料应走文件引用，指令只留小段）——这是跑分器自身的问题，请回报。`)
  }
  const spec = zcodeCliSpec()
  if (!spec.ok) {
    throw new Error(`ZCode CLI 不可用：${spec.reason}\n修复：设 ORCH_ZCODE_CLI=<zcode.cjs 绝对路径>` +
      `（macOS 例：/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs），或安装 PATH 版 zcode CLI。`)
  }
  const args = [...spec.baseArgs, ...buildZcodeArgs({ prompt, mode: 'plan', disallowed: REVIEWER_DISALLOWED })]
  const r = spawnSync(spec.cmd, args, {
    cwd,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, ORCH_POLICY_ENFORCE: '1' },
  })
  return {
    output: parseHeadlessJson(r.stdout ?? '')?.response ?? String(r.stdout ?? ''),
    exitCode: r.status,
    spawnError: r.error ? String(r.error.message ?? r.error) : null,
    timedOut: r.error?.code === 'ETIMEDOUT',
    stderrTail: String(r.stderr ?? '').slice(-2000),
  }
}

/** claude-headless：stream-json + 只读白名单（与 orchestrator buildClaudeArgs readonly 同款参数）；
 *  Windows 上 claude 是 .cmd 包装，spawn 必须走 shell（探测与 spawn 同语义纪律）。 */
function runClaudeReview(prompt, { cwd, timeoutMs, model, maxTurns }) {
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--max-turns', String(maxTurns)]
  if (model) args.push('--model', model)
  args.push('--allowedTools', 'Read', 'Glob', 'Grep')
  const r = spawnSync('claude', args, {
    cwd,
    input: prompt,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
    shell: process.platform === 'win32',
  })
  return {
    output: extractStreamJsonResult(r.stdout) ?? String(r.stdout ?? ''),
    exitCode: r.status,
    spawnError: r.error ? String(r.error.message ?? r.error) : null,
    timedOut: r.error?.code === 'ETIMEDOUT',
    stderrTail: String(r.stderr ?? '').slice(-2000),
  }
}

/** 从 claude stream-json 输出提取最后一个 result 事件（缺省回落原始 stdout，契约块解析仍可能工作）。 */
export function extractStreamJsonResult(stdout) {
  let result = null
  for (const line of String(stdout ?? '').split('\n')) {
    const t = line.trim()
    if (!t.startsWith('{')) continue
    try {
      const evt = JSON.parse(t)
      if (evt.type === 'result' && 'result' in evt) result = String(evt.result ?? '')
    } catch {
      // 非 JSON 行（版本差异），容错跳过
    }
  }
  return result
}

// ---------------------------------------------------------------- 评分

/** 单案例评分：expect 关键词命中（启发式）+ REVIEW_SUMMARY 契约计数。
 *  - 应抓：任一关键词命中即该阻塞点命中；全中=caught，有缺=漏报。
 *  - 误报：clean 负样本报任何阻塞（契约行 blockers>0 或「发现 N 个问题」）即误报；
 *    非负样本 = 噪音关键词命中数 + 超出命中数的 excess blockers。 */
export function gradeOutput(expect, outputText) {
  const text = String(outputText ?? '')
  const hay = text.toLowerCase()
  const v = VERDICT_RE.exec(text)
  const verdict = v ? { blockers: Number(v[1]), suggestions: Number(v[2]), notes: Number(v[3]) } : null

  const hits = []
  const misses = []
  for (const b of expect.blockers) {
    const matched = b.keywords.filter((k) => hay.includes(k.toLowerCase()))
    ;(matched.length ? hits : misses).push({ ...b, matched })
  }
  const noiseHits = []
  for (const n of expect.noise) {
    const matched = n.keywords.filter((k) => hay.includes(k.toLowerCase()))
    if (matched.length) noiseHits.push({ ...n, matched })
  }

  if (expect.clean) {
    const falsePositive = (verdict ? verdict.blockers > 0 : false) || FAXIAN_RE.test(text)
    return {
      verdict, hits, misses: [], noiseHits,
      falsePositive, excessBlockers: 0, contractMissing: !verdict,
      clean: true, caught: true, missed: 0,
      status: falsePositive ? 'fp' : 'pass',
    }
  }
  const caught = hits.length
  const missed = misses.length
  const excessBlockers = verdict ? Math.max(0, verdict.blockers - caught) : 0
  let status
  if (missed === 0 && noiseHits.length === 0 && excessBlockers === 0) status = 'pass'
  else if (caught === 0) status = 'miss_all'
  else if (missed > 0) status = 'partial_miss'
  else status = 'fp_noise'
  return {
    verdict, hits, misses, noiseHits,
    falsePositive: noiseHits.length > 0, excessBlockers, contractMissing: !verdict,
    clean: false, caught, missed, status,
  }
}

const STATUS_LABEL = {
  pass: '✅ 通过',
  partial_miss: '⚠️ 部分漏报',
  miss_all: '❌ 全漏',
  fp_noise: '⚠️ 误报',
  fp: '❌ 误报（干净改动被报阻塞）',
  failed: '⚠️ 运行失败',
  no_expect: '⚠️ 缺期望判定',
}

/** 对输出目录静态评分（--grade 与 --run 收尾共用）：读 manifest + 各案例输出/期望，落 score.json + report.md。 */
export function gradeRunDir(outDir) {
  const manifest = JSON.parse(fs.readFileSync(path.join(outDir, 'manifest.json'), 'utf8'))
  const rows = []
  for (const entry of manifest.cases) {
    const parsed = readExpectFor(entry, outDir, manifest)
    if (!parsed) {
      rows.push({ id: entry.id, status: 'no_expect', error: 'expect.json 缺失且仓库案例目录中找不到该案例' })
      continue
    }
    const outputFile = path.join(outDir, `${entry.id}.output.txt`)
    if (entry.status === 'failed' || !fs.existsSync(outputFile)) {
      rows.push({ id: entry.id, status: 'failed', error: entry.error ?? '无输出文件', goal: parsed.header.goal, kaodian: parsed.header.kaodian })
      continue
    }
    const output = fs.readFileSync(outputFile, 'utf8')
    rows.push({
      id: entry.id,
      goal: parsed.header.goal,
      kaodian: parsed.header.kaodian,
      clean: parsed.expect.clean,
      expectedCount: parsed.expect.blockers.length,
      outputFile,
      ...gradeOutput(parsed.expect, output),
    })
  }
  const sum = (sel) => rows.filter(sel).length
  const summary = {
    cases: rows.length,
    pass: sum((r) => r.status === 'pass'),
    partialMiss: sum((r) => r.status === 'partial_miss'),
    missAll: sum((r) => r.status === 'miss_all'),
    fpNoise: sum((r) => r.status === 'fp_noise'),
    cleanFp: sum((r) => r.status === 'fp'),
    failed: sum((r) => r.status === 'failed' || r.status === 'no_expect'),
    missedBlockers: rows.reduce((n, r) => n + (r.misses?.length ?? 0), 0),
    falsePositives: rows.reduce((n, r) => n + (r.clean ? (r.falsePositive ? 1 : 0) : (r.noiseHits?.length ?? 0) + (r.excessBlockers ?? 0)), 0),
  }
  const score = { outDir, gradedAt: new Date().toISOString(), backend: manifest.backend, model: manifest.model ?? null, summary, rows }
  fs.writeFileSync(path.join(outDir, 'score.json'), JSON.stringify(score, null, 2))
  fs.writeFileSync(path.join(outDir, 'report.md'), renderReport(score))
  return score
}

/** 期望判定读取：优先输出目录内自带的 <id>.expect.json（--run 时已固化，重放自包含），
 *  缺失时回落当前仓库案例目录（--grade 手工造目录的场景）。 */
function readExpectFor(entry, outDir, manifest) {
  const expectFile = path.join(outDir, `${entry.id}.expect.json`)
  if (fs.existsSync(expectFile)) return JSON.parse(fs.readFileSync(expectFile, 'utf8'))
  try {
    const c = loadCases(manifest.casesDir ?? casesDirOf(findRepoRoot())).find((x) => x.id === entry.id)
    return c ? { id: c.id, header: c.header, expect: c.expect } : null
  } catch {
    return null
  }
}

function renderReport(score) {
  const { summary, rows } = score
  const lines = [
    '# reviewer-eval 评分报告',
    '',
    `- 后端：${score.backend}${score.model ? `（模型 ${score.model}）` : ''}`,
    `- 案例：${summary.cases}，通过：${summary.pass}，部分漏报：${summary.partialMiss}，全漏：${summary.missAll}，误报：${summary.fpNoise + summary.cleanFp}，运行失败：${summary.failed}`,
    `- 漏报阻塞点合计：${summary.missedBlockers}；误报合计：${summary.falsePositives}`,
    '- 评分口径：expect 关键词命中（启发式）；是否真审出以各 <id>.output.txt 原文人工复核为准。',
    '',
    '| 案例 | clean | 结果 | 命中 | 漏报 | 误报 | verdict |',
    '|---|---|---|---|---|---|---|',
  ]
  for (const r of rows) {
    const verdict = r.verdict ? `blockers=${r.verdict.blockers} suggestions=${r.verdict.suggestions} notes=${r.verdict.notes}` : r.contractMissing ? '无契约行' : '-'
    const hit = r.clean ? '-' : `${r.caught ?? 0}/${r.expectedCount ?? '?'}`
    const miss = r.clean ? '-' : String(r.missed ?? 0)
    const fp = r.clean ? (r.falsePositive ? '1' : '0') : String((r.noiseHits?.length ?? 0) + (r.excessBlockers ?? 0))
    lines.push(`| ${r.id} | ${r.clean ? '是' : '否'} | ${STATUS_LABEL[r.status] ?? r.status} | ${hit} | ${miss} | ${fp} | ${verdict} |`)
  }
  lines.push('', '## 明细', '')
  for (const r of rows) {
    lines.push(`### ${r.id} — ${STATUS_LABEL[r.status] ?? r.status}`, '')
    if (r.kaodian) lines.push(`- 考点：${r.kaodian.replace(/\n/g, ' / ')}`)
    if (r.error) lines.push(`- 错误：${r.error}`)
    if (r.clean) {
      lines.push(`- 口径：clean 负样本，报任何阻塞即误报${r.falsePositive ? '——**本轮报了阻塞，判误报**' : '——本轮未报阻塞'}`)
    } else {
      for (const h of r.hits ?? []) lines.push(`- 命中 [${h.level}] ${h.desc}（关键词：${h.matched.join('、')}）`)
      for (const m of r.misses ?? []) lines.push(`- 漏报 [${m.level}] ${m.desc}（关键词全未中：${m.keywords.join('、')}）`)
      for (const n of r.noiseHits ?? []) lines.push(`- 疑似误报（噪音命中）：${n.desc}（关键词：${n.matched.join('、')}）`)
      if (r.excessBlockers > 0) lines.push(`- 超出命中数的阻塞报告 ${r.excessBlockers} 条（对照原文定性是否误报）`)
      if (r.contractMissing) lines.push('- ⚠ 输出缺 REVIEW_SUMMARY 契约行（审查者没守输出契约，本身值得记录）')
    }
    if (r.outputFile) {
      lines.push('', '<details><summary>模型原文</summary>', '', '```text', (fs.existsSync(r.outputFile) ? fs.readFileSync(r.outputFile, 'utf8') : '').trim(), '```', '', '</details>')
    }
    lines.push('')
  }
  return lines.join('\n')
}

// ---------------------------------------------------------------- 命令

function tsStamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '')
}

function cmdList(opts) {
  const root = findRepoRoot()
  const cases = filterCases(loadCases(casesDirOf(root)), opts.cases)
  for (const c of cases) {
    const tag = c.expect.clean ? ' [clean 负样本]' : ''
    console.log(`${c.id}${tag} — 应抓 ${c.expect.blockers.length} 项 — ${c.header.kaodian.replace(/\n/g, ' / ') || '（无考点注释）'}`)
  }
  console.log(`\n共 ${cases.length} 个案例（${casesDirOf(root)}）`)
  return 0
}

function cmdDryRun(opts) {
  const root = findRepoRoot()
  const cdir = casesDirOf(root)
  const cases = filterCases(loadCases(cdir), opts.cases)
  const nClean = cases.filter((c) => c.expect.clean).length
  const discipline = reviewDisciplineText(root)
  const disciplineLen = discipline.length
  console.log('reviewer-eval dry-run（零消耗：不 spawn 任何 CLI、不建输出目录）')
  console.log(`仓库根：${root}`)
  console.log(`案例：${cases.length} 个（clean 负样本 ${nClean} 个）`)
  console.log(`REVIEW.md 纪律摘要：${disciplineLen ? `${disciplineLen} 字符（截 ${DISCIPLINE_CAP}）` : '⚠ 仓库根未找到 REVIEW.md，材料将缺纪律面'}`)
  console.log(`后端：未指定——--run 必须显式 --backend ${BACKENDS.join('|')}（真跑烧钱，防误触）`)
  console.log(`单案例超时：${opts.timeoutMin} 分钟；claude 轮次上限：${opts.maxTurns}；输出目录（--run 时）：<仓库根>/.agents/orchestrator/logs/reviewer-eval-<ts>`)
  if (opts.backend === 'zcode-headless') {
    const spec = zcodeCliSpec()
    console.log(`zcode CLI 定位：${spec.ok ? (process.env.ORCH_ZCODE_CLI ? `ORCH_ZCODE_CLI=${process.env.ORCH_ZCODE_CLI}（文件存在性已校验，探测/真跑留 --run）` : `PATH 中的 zcode（dry-run 不探测）`) : `⚠ ${spec.reason}`}`)
  } else if (opts.backend === 'claude-headless') {
    console.log(`claude CLI：PATH 中的 claude（dry-run 不探测；Windows 走 shell 形态）`)
  }
  console.log('')
  console.log('#   案例                        材料    应抓  clean  考点')
  let i = 1
  let oversize = 0
  for (const c of cases) {
    const materialBytes = Buffer.byteLength(buildMaterial(discipline, c.diffText))
    const kb = `${(materialBytes / 1024).toFixed(1)}KB`
    const flag = materialBytes > MATERIAL_CAP ? ' ⚠超限' : ''
    if (materialBytes > MATERIAL_CAP) oversize++
    console.log(`${String(i++).padStart(2)}  ${c.id.padEnd(24)}  ${kb.padStart(7)}${flag}  ${String(c.expect.blockers.length).padStart(4)}  ${c.expect.clean ? '是' : '否'}     ${(c.header.kaodian.split('\n')[0] ?? '').slice(0, 60)}`)
  }
  if (oversize) console.log(`\n⚠ ${oversize} 个案例材料超 ${Math.round(MATERIAL_CAP / 1024)}KB 上限——--run 会跳过这些案例，先收窄出题材料。`)
  console.log('\ndry-run 结束：未执行任何后端。真跑示例：')
  console.log(`  node .agents/scripts/reviewer-eval.mjs --run --backend claude-headless --model glm-5.3-flash`)
  console.log(`  node .agents/scripts/reviewer-eval.mjs --run --backend zcode-headless --cases port-redline,scope-drift`)
  return 0
}

function cmdRun(opts) {
  if (!opts.backend || !BACKENDS.includes(opts.backend)) {
    throw new Error(`--run 必须显式指定 --backend ${BACKENDS.join('|')}（真跑烧钱，不设默认；当前值：${opts.backend ?? '缺省'}）`)
  }
  if (opts.backend === 'zcode-headless' && opts.model) {
    console.error('⚠ zcode-headless 不支持 --model（模型跟随 ZCode 默认），参数忽略——与 orchestrator 行为一致。')
  }
  const root = findRepoRoot()
  const cdir = casesDirOf(root)
  const cases = filterCases(loadCases(cdir), opts.cases)
  const discipline = reviewDisciplineText(root)
  if (!discipline) console.error('⚠ 仓库根未找到 REVIEW.md，纪律摘要为空（审查输入缺纪律面，评分照常）')
  const outDir = path.join(root, '.agents', 'orchestrator', 'logs', `reviewer-eval-${tsStamp()}`)
  fs.mkdirSync(outDir, { recursive: true })
  const timeoutMs = opts.timeoutMin * 60 * 1000
  const manifest = {
    version: 1,
    startedAt: new Date().toISOString(),
    backend: opts.backend,
    model: opts.backend === 'claude-headless' ? (opts.model ?? null) : null,
    maxTurns: opts.maxTurns,
    timeoutMinutes: opts.timeoutMin,
    repoRoot: root,
    casesDir: cdir,
    cases: [],
  }
  console.log(`输出目录：${outDir}`)
  for (const c of cases) {
    process.stderr.write(`跑 ${c.id} …\n`)
    // 期望判定与材料先落盘：失败案例也有现场，--grade 可重放
    fs.writeFileSync(path.join(outDir, `${c.id}.expect.json`), JSON.stringify({ id: c.id, header: c.header, expect: c.expect }, null, 2))
    const material = buildMaterial(discipline, c.diffText)
    const materialPath = path.join(outDir, `${c.id}.material.md`)
    fs.writeFileSync(materialPath, material)
    const entry = { id: c.id, goal: c.header.goal, filesHint: c.header.filesHint, clean: c.expect.clean, blockers: c.expect.blockers.length, status: 'ok' }
    if (Buffer.byteLength(material) > MATERIAL_CAP) {
      entry.status = 'failed'
      entry.error = `材料 ${Math.round(Buffer.byteLength(material) / 1024)}KB 超 ${Math.round(MATERIAL_CAP / 1024)}KB 上限（会撑爆上下文）——收窄出题材料后重跑该案例`
      manifest.cases.push(entry)
      console.error(`  ⚠ ${c.id}：${entry.error}`)
      continue
    }
    const prompt = buildEvalPrompt({ ...c.header, materialPath })
    fs.writeFileSync(path.join(outDir, `${c.id}.prompt.txt`), prompt)
    const t0 = Date.now()
    let res
    try {
      res = opts.backend === 'zcode-headless'
        ? runZcodeReview(prompt, { cwd: root, timeoutMs })
        : runClaudeReview(prompt, { cwd: root, timeoutMs, model: opts.model, maxTurns: opts.maxTurns })
    } catch (e) {
      entry.status = 'failed'
      entry.error = String(e?.message ?? e).slice(0, 400)
      manifest.cases.push(entry)
      console.error(`  ⚠ ${c.id}：${entry.error.split('\n')[0]}`)
      continue
    }
    const durationMs = Date.now() - t0
    fs.writeFileSync(path.join(outDir, `${c.id}.output.txt`), res.output ?? '')
    fs.writeFileSync(path.join(outDir, `${c.id}.meta.json`), JSON.stringify({ durationMs, exitCode: res.exitCode, spawnError: res.spawnError, timedOut: res.timedOut, stderrTail: res.stderrTail }, null, 2))
    if (res.timedOut || res.spawnError) {
      entry.status = 'failed'
      entry.error = res.timedOut ? `超时（>${opts.timeoutMin} 分钟，进程已被终止）` : `CLI 启动失败：${res.spawnError}`
      manifest.cases.push(entry)
      console.error(`  ⚠ ${c.id}：${entry.error}`)
      continue
    }
    manifest.cases.push(entry)
    const v = VERDICT_RE.exec(res.output ?? '')
    console.log(`  ✔ ${c.id} 完成（${(durationMs / 1000).toFixed(0)}s，${v ? `blockers=${v[1]}` : '无契约行'}）`)
  }
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2))
  const score = gradeRunDir(outDir)
  console.log('')
  console.log(renderReport(score))
  console.log(`评分与报告已写入 ${outDir}（score.json / report.md）；真审出与否请人工复核各 <id>.output.txt 原文。`)
  return 0
}

function cmdGrade(dir) {
  if (!dir) throw new Error('--grade 需要输出目录参数（--grade <输出目录>），目录内须有 manifest.json')
  const abs = path.resolve(dir)
  if (!fs.existsSync(path.join(abs, 'manifest.json'))) {
    throw new Error(`目录里没有 manifest.json：${abs}（--grade 只对 --run 产出或同构目录评分，不 spawn 任何 CLI）`)
  }
  const score = gradeRunDir(abs)
  console.log(renderReport(score))
  console.log(`score.json / report.md 已更新到 ${abs}`)
  return 0
}

function parseOpts(argv) {
  const flag = (name) => {
    const i = argv.indexOf(name)
    return i >= 0 ? argv[i + 1] : undefined
  }
  return {
    list: argv.includes('--list'),
    run: argv.includes('--run'),
    grade: flag('--grade'),
    backend: flag('--backend'),
    model: flag('--model'),
    cases: flag('--cases'),
    timeoutMin: Number(flag('--timeout-min')) > 0 ? Number(flag('--timeout-min')) : DEFAULT_TIMEOUT_MIN,
    maxTurns: Number(flag('--max-turns')) > 0 ? Number(flag('--max-turns')) : DEFAULT_MAX_TURNS,
    help: argv.includes('--help') || argv.includes('-h'),
  }
}

function main() {
  const opts = parseOpts(process.argv.slice(2))
  if (opts.help) {
    console.log([
      '用法：node .agents/scripts/reviewer-eval.mjs [--list] [--grade <目录>] [--run --backend <b> ...]',
      '',
      '  （默认）                dry-run：打印将执行的案例与后端，零消耗、不 spawn',
      '  --list                  只列案例（id + 考点一行）',
      '  --run                   真跑（烧钱，人工发起）：--backend zcode-headless|claude-headless 必填，',
      '                          可选 --model m（仅 claude 生效）--cases a,b --timeout-min 10 --max-turns 30',
      '  --grade <输出目录>      对既有输出静态重放评分（不 spawn LLM，CI 可用）',
      '',
      '  退出码恒为 0（评测是信息不是门禁）。出题纪律与评分口径见',
      '  .agents/review-evals/reviewer/README.md。',
    ].join('\n'))
    return 0
  }
  if (opts.grade) return cmdGrade(opts.grade)
  if (opts.list && !opts.run) return cmdList(opts)
  if (opts.run) return cmdRun(opts)
  return cmdDryRun(opts)
}

// 直跑判定不用 import.meta（硬约束）：argv[1] 基名匹配即可；被测试 import 时 argv[1] 是 vitest 入口，不会误触
if (path.basename(process.argv[1] ?? '') === 'reviewer-eval.mjs') {
  try {
    process.exit(main())
  } catch (e) {
    console.error(`✗ ${String(e?.message ?? e)}`)
    process.exit(1)
  }
}
