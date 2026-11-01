#!/usr/bin/env node
// 审查评测集运行器：拿历史上真实逃过审查的 bug 当考题，给当前审查者打分。
// 闭环设计见 .agents/review-evals/README.md（来源：Anthropic《How the Claude Code team
// does code review》——事故变考题，审查者的任何改动先在全量考题上重跑，分数升了才保留）。
//
// 用法：
//   node scripts/review-eval.mjs --dry                     # 只打印组装好的 prompt，不调模型
//   node scripts/review-eval.mjs                           # 全量跑（本地 claude CLI）
//   node scripts/review-eval.mjs --case 2026-10-update-stoptray
//   node scripts/review-eval.mjs --model deepseek-v4-pro   # 透传给 claude --model
//   node scripts/review-eval.mjs --out eval-report.md      # 报告落盘（默认 stdout）
//
// 前置：本机装有 claude CLI 且已登录/配好端点（脚本透传环境变量，不自带 key）。
// 打分是启发式（expect 关键词命中），只作趋势参考；是否真审出，看报告里的模型原文。

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CASES_DIR = join(ROOT, '.agents', 'review-evals', 'cases')

function listCases() {
  if (!existsSync(CASES_DIR)) throw new Error(`评测集目录不存在：${CASES_DIR}`)
  return readdirSync(CASES_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(CASES_DIR, f), 'utf8')))
    .sort((a, b) => String(a.id).localeCompare(String(b.id)))
}

/** 从 reviewRef 物化考题文件（带行号），返回 {dir, blocks}。
 *  cleanSha 存在时（噪声对照题）物化该提交对 files 的 diff——干净题考的是「改动该不该报」。
 *  diffRef 存在时（diff 题型）物化该提交对 files 的 diff——bug 随 diff 合入的场景。根因文件
 *  超 120KB 整文件护栏（如 orchestrator.mjs）时改用此题型：考「引入提交的 diff」，贴近真实 PR 审查。 */
function materialize(c, dir) {
  if (c.cleanSha && c.diffRef) {
    throw new Error(`考题 ${c.id}：cleanSha 与 diffRef 互斥（前者考「干净改动不该报」，后者考「diff 里埋着 bug」）。`)
  }
  const blocks = []
  for (const rel of c.files) {
    const args = c.cleanSha
      ? ['show', `${c.cleanSha}`, '--', rel]
      : c.diffRef
        ? ['show', `${c.diffRef}`, '--', rel]
        : ['show', `${c.reviewRef}:${rel}`]
    const show = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' })
    if (show.status !== 0) {
      throw new Error(`git show ${args.slice(1).join(' ')} 失败（reviewRef/cleanSha/diffRef 写错？）：${show.stderr.trim()}`)
    }
    // 体积护栏：整文件/大 diff 进 prompt，超大（如历史上的巨型 ui.ts）会撑爆上下文/烧钱——提前拦下换更窄的材料
    if (Buffer.byteLength(show.stdout) > 120_000) {
      throw new Error(
        `考题材料 ${rel}@${c.cleanSha ?? c.diffRef ?? c.reviewRef} 有 ${Math.round(Buffer.byteLength(show.stdout) / 1024)}KB（>120KB 上限），` +
          `进 prompt 会撑爆上下文。换根因所在的更小文件/更窄的引入提交，或拆分考题。`
      )
    }
    if (c.cleanSha || c.diffRef) {
      const ref = c.cleanSha ?? c.diffRef
      writeFileSync(join(dir, `${basename(rel)}.diff`), show.stdout)
      blocks.push(`### 改动 diff：${rel}（提交 ${ref}）\n\n\`\`\`diff\n${show.stdout}\n\`\`\``)
    } else {
      const lines = show.stdout.split('\n').map((l, i) => `${String(i + 1).padStart(4)} | ${l}`)
      const dest = join(dir, basename(rel))
      writeFileSync(dest, lines.join('\n'))
      blocks.push(`### 文件 ${rel}（${c.reviewRef} 版本，行号已标）\n\n\`\`\`\n${show.stdout.split('\n').length > 0 ? lines.join('\n') : ''}\n\`\`\``)
    }
  }
  return blocks
}

function buildPrompt(c, blocks) {
  const reviewMd = existsSync(join(ROOT, 'REVIEW.md')) ? readFileSync(join(ROOT, 'REVIEW.md'), 'utf8') : ''
  if (c.cleanSha) {
    return [
      `下面是一个真实仓库里的维护性改动（提交 ${c.cleanSha}，已确认为干净改动）。你的任务：`,
      '只读审查这个 diff，判断它有没有需要报告的真问题。',
      '',
      reviewMd ? `== 审查纪律（REVIEW.md）==\n${reviewMd}\n` : '',
      '== 待审改动 ==',
      ...blocks,
      '',
      '== 输出要求 ==',
      '- 确证没有真问题时，顶层结论只写「未发现问题」，不要为了凑数报告风格/诊断/清理类。',
      '- 若确有真问题，顶层结论以「发现 N 个问题」开头，每条给文件+行号与证据。'
    ]
      .filter(Boolean)
      .join('\n')
  }
  if (c.diffRef) {
    return [
      `下面是一个真实仓库里已合入的改动（提交 ${c.diffRef}）。这个 diff 之后补了一个真实 bug 的修复——你的任务：`,
      '只读审查这个 diff，找出其中引入或暴露的缺陷（就是后来要发修复的那个，以及其它你能确证的问题）。',
      '',
      reviewMd ? `== 审查纪律（REVIEW.md）==\n${reviewMd}\n` : '',
      '== 待审改动 ==',
      ...blocks,
      '',
      '== 输出要求 ==',
      '- 顶层结论以「发现 N 个问题」开头；每条给 文件+行号 与证据；没有把握不报。',
      '- 不确定的问题单独放「存疑」一节，说明缺什么证据。'
    ]
      .filter(Boolean)
      .join('\n')
  }
  return [
    '以下是某仓库在某一历史版本的源码片段。这个版本之后补了一个真实 bug 的修复——你的任务：',
    '只读审查下面的代码，找出潜伏的缺陷（就是后来要发修复的那个，以及其它你能确证的问题）。',
    '',
    reviewMd ? `== 审查纪律（REVIEW.md）==\n${reviewMd}\n` : '',
    '== 待审代码 ==',
    ...blocks,
    '',
    '== 输出要求 ==',
    '- 顶层结论以「发现 N 个问题」开头；每条给 文件+行号 与证据；没有把握不报。',
    '- 不确定的问题单独放「存疑」一节，说明缺什么证据。'
  ]
    .filter(Boolean)
    .join('\n')
}

function runClaude(prompt, model, timeoutMin = 15) {
  const args = ['-p']
  if (model) args.push('--model', model)
  // Windows 上 claude 是 .cmd 包装，直调 spawn 会 ENOENT（项目硬约定），走 shell；prompt 从 stdin 进
  const r = spawnSync('claude', args, {
    cwd: ROOT,
    input: prompt,
    encoding: 'utf8',
    timeout: timeoutMin * 60 * 1000,
    maxBuffer: 32 * 1024 * 1024,
    shell: process.platform === 'win32'
  })
  if (r.error && r.error.code === 'ENOENT') {
    throw new Error('本机未找到 claude CLI：请安装并登录后重跑（或先用 --dry 检查 prompt 组装）。')
  }
  if (r.status !== 0) {
    // claude CLI 的认证/配额错误打在 stdout（如 401 key invalid），stderr 常为空——两头都带上
    throw new Error(`claude CLI 退出码 ${r.status}：${String(r.stderr || '').slice(0, 300) || String(r.stdout || '').slice(0, 300)}`)
  }
  return String(r.stdout || '')
}

function score(output, c) {
  const text = String(output)
  if (c.cleanSha) {
    // 噪声对照题：干净改动报了「发现 N 个问题」即误报；只留存疑不算
    const falsePositive = /发现 [1-9]\d* 个问题/.test(text)
    return { hits: [], caught: !falsePositive, clean: true }
  }
  const hay = text.toLowerCase()
  const keywords = c.expect.map((k) => String(k).toLowerCase())
  const hits = keywords.map((k) => ({ keyword: k, hit: hay.includes(k) }))
  return { hits, caught: hits.some((h) => h.hit) }
}

function main() {
  const argv = process.argv.slice(2)
  const flag = (name) => {
    const i = argv.indexOf(name)
    return i >= 0 ? argv[i + 1] : undefined
  }
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(
      [
        '用法：node scripts/review-eval.mjs [--dry] [--case <id>] [--model <m>] [--out <file>] [--timeout-min <n>]',
        '',
        '  考题在 .agents/review-evals/cases/*.json，加题与判读见同目录 README.md。',
        '  退出码恒为 0（评测是信息不是门禁）；--strict 时有未审出的题则退出码 1。',
        '  单题超时/报错记「运行失败」并继续其余题（--timeout-min 调整，默认 15 分钟）。'
      ].join('\n')
    )
    return 0
  }
  const strict = argv.includes('--strict')
  const dry = argv.includes('--dry')
  const model = flag('--model')
  const out = flag('--out')
  let cases = listCases()
  const only = flag('--case')
  if (only) cases = cases.filter((c) => c.id === only)
  if (!cases.length) {
    console.log(`没有匹配的考题（${only ?? '全量'}）。考题目录：${CASES_DIR}`)
    return 0
  }

  const tmp = mkdtempSync(join(tmpdir(), 'modeldock-review-eval-'))
  const report = []
  let missed = 0
  let failed = 0
  const timeoutMin = Number(flag('--timeout-min')) || 15
  try {
    for (const c of cases) {
      const blocks = materialize(c, tmp)
      const prompt = buildPrompt(c, blocks)
      if (dry) {
        report.push(`# [dry] ${c.id}\n\n${prompt}`)
        continue
      }
      process.stderr.write(`跑 ${c.id} …\n`)
      let output
      try {
        output = runClaude(prompt, model, timeoutMin)
      } catch (e) {
        // 逐题容错：单题超时/CLI 报错只记失败不炸整轮——全量跑分常在夜里无人值守，
        // 一题卡死不应该丢掉其余题的分数与报告
        failed++
        report.push(
          `## ${c.id} — ⚠️ 运行失败\n\n- 考题：${c.title}\n- 错误：${String(e && e.message || e).slice(0, 400)}\n`
        )
        continue
      }
      const s = score(output, c)
      if (!s.caught) missed++
      const outputFile = join(tmp, `${c.id}.output.txt`)
      writeFileSync(outputFile, output)
      report.push(
        [
          `## ${c.id} — ${c.cleanSha ? (s.caught ? '✅ 无误报' : '❌ 误报（干净改动被报问题）') : s.caught ? '✅ 审出' : '❌ 未审出'}`,
          '',
          `- 考题：${c.title}`,
          s.clean ? '- 口径：已知干净改动，报「发现 N 个问题」即误报' : `- 关键词：${s.hits.map((h) => `${h.keyword}=${h.hit ? '中' : '未中'}`).join('，')}`,
          `- 完整输出：${outputFile}`,
          '',
          '<details><summary>模型原文</summary>',
          '',
          '```text',
          output.trim(),
          '```',
          '',
          '</details>'
        ].join('\n')
      )
    }
  } finally {
    if (!dry) {
      // 输出文件留在系统临时目录供查阅；目录本体尽力清理（失败不阻塞）
      // ——报告里已写文件路径，清理后路径仅当日有效，判读以报告内嵌原文为准
      rmSync(tmp, { recursive: true, force: true })
    }
  }

  const head = dry
    ? `# 审查评测 prompt 预览（--dry，共 ${cases.length} 题）`
    : `# 审查评测报告\n\n- 考题：${cases.length}，审出：${cases.length - missed - failed}，未审出：${missed}${failed ? `，运行失败：${failed}` : ''}${model ? `\n- 模型：${model}` : ''}\n- 评分口径：expect 关键词命中（启发式），精确判定看原文`
  const full = `${head}\n\n${report.join('\n\n')}`
  if (out) {
    mkdirSync(dirname(out), { recursive: true })
    writeFileSync(out, full)
    console.log(`报告已写入 ${out}`)
  } else {
    console.log(full)
  }
  if (strict && missed > 0) return 1
  return 0
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(main())
}
