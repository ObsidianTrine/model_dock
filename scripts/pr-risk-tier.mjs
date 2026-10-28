#!/usr/bin/env node
// PR 风险分级：按改动文件把 PR 分为 低/中/高 三档，供人工审查力度对齐（分层审查第 5 层）。
// 设计来源：Anthropic《How the Claude Code team does code review》
//（https://claude.dev/blog/solving-code-review-at-anthropic/）——「改动决定档位，而不是作者」。
//
// 规则来源（对齐既有编排配置，不另造清单）：
//   .agents/workflow.json 的 corePaths（网关核心/配置存储/密钥/路径锚点/CLI 入口）→ 高
//   .agents/workflow.json 的 releasePaths（CI 工作流与发布构建面）→ 高
//   本脚本补充：安装器/SEA 配置、密钥注入面（gateway/proxy.ts）、访问控制面 → 高；
//               文档/模板/约定类 → 低；其余默认中。
//
// 用法：
//   git diff --name-only develop...HEAD | node scripts/pr-risk-tier.mjs                # 文本摘要
//   gh pr diff --name-only <PR> | node scripts/pr-risk-tier.mjs --markdown            # PR 评论体
//   gh pr diff --name-only <PR> | node scripts/pr-risk-tier.mjs --tier-only           # 仅 low|medium|high
//   node scripts/pr-risk-tier.mjs --base develop                                      # 无 stdin 时本地取 git diff
//
// 退出码恒为 0（分级是信息不是门禁；门禁由 CI 与分支保护承担）。

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const TIER_ORDER = { low: 0, medium: 1, high: 2 }
const TIER_BADGE = { low: '🟢', medium: '🟡', high: '🔴' }
const TIER_REQUIREMENT = {
  low: '自动检查（CI + AI 审查）全绿即可合并，人工抽查可选。',
  medium: '需要人工批准：owner 实际读过 diff 与审查发现后再合并。',
  high: '必须人工逐项核对 AI 审查与安全审查的全部发现，PR 描述写清测试方式与回滚方案。'
}

/** 单条模式匹配：'dir/**' 与 'dir/' 前缀匹配；'*.ext' 按扩展名；其余精确路径。分隔符归一为 /。 */
export function matchPattern(pattern, file) {
  const p = pattern.split('\\').join('/')
  const f = file.split('\\').join('/')
  if (p === '**') return true
  if (p.endsWith('/**')) return f.startsWith(p.slice(0, -2))
  if (p.endsWith('/')) return f.startsWith(p)
  if (p.startsWith('*')) return f.endsWith(p.slice(1))
  return f === p
}

/** 组装分级规则；corePaths/releasePaths 来自 .agents/workflow.json，其余为本仓库补充面。 */
export function buildRules({ corePaths = [], releasePaths = [] } = {}) {
  const rules = []
  const push = (tier, rule, patterns) => {
    if (patterns.length) rules.push({ tier, rule, patterns })
  }
  push('high', 'corePaths：网关核心 / 配置存储 / 密钥 / 路径锚点 / CLI 入口', corePaths)
  push('high', 'releasePaths：CI 工作流与发布构建面', releasePaths)
  push('high', '发布面：安装器与 SEA 配置', [
    'scripts/installer.iss',
    'scripts/inno/**',
    'scripts/sea-config.json'
  ])
  push('high', '密钥注入面：上游转发注入真实 key', ['src/gateway/proxy.ts'])
  push('high', '访问控制面', ['.github/CODEOWNERS'])
  push('low', '文档', [
    '*.md',
    'docs/**',
    '.agents/conventions/**',
    '.agents/workflows/**',
    '.agents/review-evals/**',
    'LICENSE',
    '.gitignore'
  ])
  push('low', 'issue / PR 模板', ['.github/ISSUE_TEMPLATE/**', '.github/PULL_REQUEST_TEMPLATE.md'])
  return rules
}

/**
 * 分级：取所有命中的最高档；没有任何规则命中、但有改动文件的记中风险（未覆盖面不默认放行）。
 * @returns {{ tier: 'low'|'medium'|'high', hits: Array<{tier, rule, files: string[]}>, unmatched: string[] }}
 */
export function classifyRisk(files, rules) {
  const hits = []
  const matched = new Set()
  for (const rule of rules) {
    const hit = files.filter((f) => rule.patterns.some((p) => matchPattern(p, f)))
    if (hit.length) {
      hits.push({ tier: rule.tier, rule: rule.rule, files: hit })
      for (const f of hit) matched.add(f)
    }
  }
  const unmatched = files.filter((f) => !matched.has(f))
  let tier = 'low'
  if (unmatched.length) tier = 'medium'
  for (const h of hits) if (TIER_ORDER[h.tier] > TIER_ORDER[tier]) tier = h.tier
  return { tier, hits, unmatched }
}

function loadWorkflowConfig() {
  try {
    const raw = JSON.parse(readFileSync(join(ROOT, '.agents', 'workflow.json'), 'utf8'))
    return {
      corePaths: Array.isArray(raw.corePaths) ? raw.corePaths : [],
      releasePaths: Array.isArray(raw.releasePaths) ? raw.releasePaths : []
    }
  } catch {
    process.stderr.write('warn: 读取 .agents/workflow.json 失败，仅用内置补充规则分级\n')
    return {}
  }
}

function markdown({ tier, hits, unmatched }) {
  const lines = [`## 风险分级：${{ low: '低', medium: '中', high: '高' }[tier]} ${TIER_BADGE[tier]}`, '']
  if (hits.length) {
    lines.push('| 级别 | 判定规则 | 命中文件 |', '|---|---|---|')
    for (const h of hits) {
      lines.push(`| ${{ low: '低', medium: '中', high: '高' }[h.tier]} | ${h.rule} | ${h.files.join('、')} |`)
    }
  }
  if (unmatched.length) {
    lines.push('')
    lines.push(`另有 ${unmatched.length} 个改动文件未命中任何规则，按默认中风险计。`)
  }
  lines.push('')
  lines.push(`**该等级要求**：${TIER_REQUIREMENT[tier]}`)
  lines.push('')
  lines.push('> 自动判定：`scripts/pr-risk-tier.mjs`（规则对齐 `.agents/workflow.json` 的 corePaths / releasePaths）。等级含义与调整方法见 docs/ai-review-system.md「风险分级」。')
  return lines.join('\n')
}

function text(result) {
  const { tier, hits, unmatched } = result
  const lines = [`风险等级：${tier} ${TIER_BADGE[tier]}`]
  for (const h of hits) lines.push(`  [${h.tier}] ${h.rule}: ${h.files.join(', ')}`)
  if (unmatched.length) lines.push(`  [默认中风险] 未命中规则: ${unmatched.length} 个文件`)
  lines.push(`要求：${TIER_REQUIREMENT[tier]}`)
  return lines.join('\n')
}

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('')
    let data = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (c) => (data += c))
    process.stdin.on('end', () => resolve(data))
  })
}

async function main() {
  const argv = process.argv.slice(2)
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(
      [
        '用法：cat <文件列表> | node scripts/pr-risk-tier.mjs [flags]',
        '',
        '  文件列表：每行一个仓库相对路径（git diff --name-only / gh pr diff --name-only 的输出）。',
        '  stdin 为空（TTY）时回落到 git diff --name-only <base>...HEAD。',
        '',
        'flags:',
        '  --markdown   输出 PR 评论 Markdown',
        '  --tier-only  只输出 low | medium | high',
        '  --json       输出结构化 JSON',
        '  --base <br>  无 stdin 时的 git diff 基准分支（默认 develop）'
      ].join('\n')
    )
    return
  }
  const stdin = await readStdin()
  let files = stdin.split('\n').map((l) => l.trim()).filter(Boolean)
  if (!files.length && process.stdin.isTTY) {
    const base = argv.includes('--base') ? argv[argv.indexOf('--base') + 1] : 'develop'
    files = execFileSync('git', ['diff', '--name-only', `${base}...HEAD`], {
      cwd: process.cwd(),
      encoding: 'utf8'
    })
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
  }
  if (!files.length) {
    console.log('没有读到改动文件列表：用管道传入 git diff --name-only 的输出，或加 --base 本地取 diff。')
    return
  }
  const rules = buildRules(loadWorkflowConfig())
  const result = classifyRisk(files, rules)
  if (argv.includes('--tier-only')) console.log(result.tier)
  else if (argv.includes('--json')) console.log(JSON.stringify(result, null, 2))
  else if (argv.includes('--markdown')) console.log(markdown(result))
  else console.log(text(result))
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main()
}
