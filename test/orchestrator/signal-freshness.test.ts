// 信号新鲜度（2026-11-17）两道防线：
// ① 「已落地」标注提案（卡体 `> ⚠️ 已落地` 行）不再作为活信号——巡检顺手归档
//    drafts/superseded/（landed 标注）+ planner 输入组装过滤兜底（两道并存）；
// ② CI 失败 streak 级去重——去重键 = test workflow + 分支 + streak 首个 run（非逐 run
//    id）：同一段红 streak 反复巡检同 id，runScan 存在性去重归并为一张卡；旧版逐 run
//    id 的存量卡按卡内 run 号/sha 引用对拍桥接（实证 fixture：scan-ci-a49876e0 与
//    scan-ci-50bd710a 是同一 develop 红 streak 的两张独立卡，原样作夹具不回改）。

import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { LANDED_BY, isLandedDraft, sweepLandedDrafts } from '../../.agents/scripts/orchestrator/drafts-gc.mjs'
import { cardCoversStreak, cardRunRefs, ciFailureStreak, runScan, scanCI } from '../../.agents/scripts/orchestrator/scan.mjs'
import { cardText, git, mkRepo, runOrch, runOrchInproc } from './helpers.js'

/** 已落地提案卡夹具（对齐实证卡形态：标注行 + 常规五段卡体）。 */
function landedCard(id: string, commit = 'b029067'): string {
  return [
    '---',
    `id: ${id}`,
    'type: bugfix',
    'priority: high',
    'created_at: 2026-11-04T10:00:00+08:00',
    'created_by: planner',
    'files_hint:',
    '  - src/gateway/relay.ts',
    'workflows:',
    '  - feature-branch',
    'gate: L3',
    'proposal: true',
    '---',
    '',
    `> ⚠️ 已落地：本卡修复随 ${commit}（2026-11-04）合入 develop/main，勿再派同名修复船。2026-11-09 核实性复航 123 用例全绿。`,
    '',
    '# 目标',
    '修复 relay headers 超时（复航验证）',
    '',
    '# 验收标准',
    '- npx vitest run test/relay.test.ts 全绿',
    '',
    '# 背景',
    '巡检发现 headers 超时（本卡修复已合入，此卡为历史提案）。',
    '',
  ].join('\n')
}

/** 旧版逐 run id 的 scan-ci 存量卡夹具（renderCard 同构措辞，run 号/sha 可被引用对拍）。 */
function legacyCiCard(id: string, runId: number, shortSha: string, title: string): string {
  const fullSha = shortSha + '1122334455667788aabbccddeeff0011'
  return [
    '---',
    `id: ${id}`,
    'type: bugfix',
    'priority: high',
    'created_at: 2026-11-16T23:45:00+08:00',
    'created_by: scanner',
    'signal_hashes: [1a2b3c4d]', // sha8(id)，程序过滤碰撞键（eventfilter.signalHash 口径）
    'evidence:',
    `  - 巡检信号：巡检发现主干 test 失败：run ${runId}（${title}，head ${fullSha}）`,
    'files_hint:',
    '  - src/**',
    '  - test/**',
    'workflows:',
    '  - feature-branch',
    'gate: L3',
    'proposal: true',
    '---',
    '',
    '# 目标',
    `修复主干（develop）test 失败 run #${runId}`,
    '',
    '# 验收标准',
    `- 失败测试修复；对应提交 ${shortSha} 上的 test workflow 全绿`,
    '',
    '# 背景',
    `巡检发现主干 test 失败：run ${runId}（${title}，head ${fullSha}）`,
    '',
  ].join('\n')
}

describe('信号新鲜度 > 已落地提案识别与归档', () => {
  it('isLandedDraft：识别「已落地」标注行（VS16 可省略）；机器归档标注/普通卡不误判', () => {
    expect(isLandedDraft('---\nid: x\n---\n\n> ⚠️ 已落地：本卡修复随 b029067 合入。\n\n# 目标\nx')).toBe(true)
    expect(isLandedDraft('---\nid: x\n---\n\n> ⚠ 已落地：本卡修复随 b029067 合入。\n')).toBe(true)
    expect(isLandedDraft('---\nid: x\n---\n\n> ⚠ 本提案已被合并任务 t-1 覆盖。\n')).toBe(false) // superseded 机器标注
    expect(isLandedDraft('---\nid: x\n---\n\n> ⏳ 本提案超龄未提交。\n')).toBe(false) // aged-out 机器标注
    expect(isLandedDraft('---\nid: x\n---\n\n# 目标\n修复 relay 超时\n')).toBe(false)
    expect(isLandedDraft(null)).toBe(false)
  })

  it('sweepLandedDrafts：两张实证已落地卡迁入 drafts/superseded/（landed 标注），普通卡不动', () => {
    const repo = mkRepo()
    try {
      const draftsDir = path.join(repo.root, '.agents', 'orchestrator', 'drafts')
      fs.mkdirSync(draftsDir, { recursive: true })
      fs.writeFileSync(path.join(draftsDir, 'fix-relay-headers-timeout.md'), landedCard('fix-relay-headers-timeout'))
      fs.writeFileSync(path.join(draftsDir, 'fix-secrets-dpapi-lock-scope.md'), landedCard('fix-secrets-dpapi-lock-scope'))
      fs.writeFileSync(path.join(draftsDir, 'scan-todo-alive.md'), cardText({ id: 'scan-todo-alive', created_by: 'scanner' }))
      const r = sweepLandedDrafts(repo.root)
      expect(r.failed).toEqual([])
      expect(r.moved.sort()).toEqual(['fix-relay-headers-timeout.md', 'fix-secrets-dpapi-lock-scope.md'])
      // drafts/ 顶层不再出现两张已落地卡（活信号面只剩普通卡）
      expect(fs.readdirSync(draftsDir).filter((f) => f.endsWith('.md'))).toEqual(['scan-todo-alive.md'])
      // 归档件带 landed 标注：superseded_by 伪 id + 说明行（区别于「被合并卡覆盖」与超龄清退）
      const text = fs.readFileSync(path.join(draftsDir, 'superseded', 'fix-relay-headers-timeout.md'), 'utf8')
      expect(text).toContain(`superseded_by: ${LANDED_BY}`)
      expect(text).toContain('巡检自动归档迁入 superseded/')
      expect(text).toContain('> ⚠️ 已落地') // 原标注保留（以标注所指合并实现为准）
      // 已处置的不回锅：重扫幂等
      expect(sweepLandedDrafts(repo.root).moved).toEqual([])
    } finally {
      repo.cleanup()
    }
  })

  it('runScan 接线（端到端）：巡检顺手归档 landed 卡；--dry-run 不动盘', async () => {
    const repo = mkRepo()
    try {
      const src = path.join(repo.root, 'src')
      fs.mkdirSync(src, { recursive: true })
      fs.writeFileSync(path.join(src, 'a.ts'), '// TODO: 正常信号照常出卡\nexport {}\n')
      const draftsDir = path.join(repo.root, '.agents', 'orchestrator', 'drafts')
      fs.mkdirSync(draftsDir, { recursive: true })
      fs.writeFileSync(path.join(draftsDir, 'fix-relay-headers-timeout.md'), landedCard('fix-relay-headers-timeout'))
      const out = runOrch(repo.root, 'scan --todo')
      expect(out.status).toBe(0)
      expect(out.stdout).toContain('已落地提案自动归档：fix-relay-headers-timeout.md')
      // 正常信号照常出卡，已落地卡消失
      const top = fs.readdirSync(draftsDir).filter((f) => f.endsWith('.md'))
      expect(top).toHaveLength(1)
      expect(top[0]).toMatch(/^scan-todo-/)
      expect(fs.existsSync(path.join(draftsDir, 'superseded', 'fix-relay-headers-timeout.md'))).toBe(true)
      // dry-run：只报告不动盘
      fs.writeFileSync(path.join(draftsDir, 'fix-secrets-dpapi-lock-scope.md'), landedCard('fix-secrets-dpapi-lock-scope'))
      const dry = await runScan(repo.root, { dryRun: true })
      expect(dry.created).toHaveLength(0)
      expect(fs.existsSync(path.join(draftsDir, 'fix-secrets-dpapi-lock-scope.md'))).toBe(true)
    } finally {
      repo.cleanup()
    }
  })

  it('propose 信号输入过滤：已落地卡不进 planner prompt（两轮巡检之间的窗口期兜底）', async () => {
    const repo = mkRepo()
    try {
      const draftsDir = path.join(repo.root, '.agents', 'orchestrator', 'drafts')
      fs.mkdirSync(draftsDir, { recursive: true })
      fs.writeFileSync(path.join(draftsDir, 'fix-relay-headers-timeout.md'), landedCard('fix-relay-headers-timeout'))
      fs.writeFileSync(path.join(draftsDir, 'scan-todo-alive.md'), cardText({ id: 'scan-todo-alive', created_by: 'scanner' }))
      const out = await runOrchInproc(repo.root, 'propose --backend mock')
      expect(out.status).toBe(0)
      const logsDir = path.join(repo.root, '.agents', 'orchestrator', 'logs')
      const inputs: string[] = []
      for (const s of fs.readdirSync(logsDir).filter((d) => d.startsWith('planner-'))) {
        const decDir = path.join(logsDir, s, 'decisions')
        if (!fs.existsSync(decDir)) continue
        for (const f of fs.readdirSync(decDir).filter((x) => x.startsWith('planner-') && x.endsWith('.json'))) {
          inputs.push(String(JSON.parse(fs.readFileSync(path.join(decDir, f), 'utf8')).input ?? ''))
        }
      }
      expect(inputs.length).toBeGreaterThan(0)
      expect(inputs[0]).toContain('scan-todo-alive') // 活信号照常进规划输入
      expect(inputs[0]).not.toContain('fix-relay-headers-timeout') // 已落地卡不再出现
    } finally {
      repo.cleanup()
    }
  })
})

describe('信号新鲜度 > CI 失败 streak 级去重', () => {
  const TAIL = '1122334455667788aabbccddeeff0011'
  const run = (databaseId: number, shortSha: string, conclusion: string) => ({
    databaseId,
    headSha: shortSha + TAIL,
    displayTitle: `ci: run ${databaseId}`,
    conclusion,
  })
  const ghRun = (runs: Array<Record<string, unknown>>) => () => ({ status: 0, stdout: JSON.stringify(runs), stderr: '' })

  it('ciFailureStreak：自最新连续截取 failure 段，firstRun=段内最旧一条；绿/进行中即止', () => {
    const streak = ciFailureStreak([run(3, 'cccc3333', 'failure'), run(2, 'bbbb2222', 'failure'), run(1, 'aaaa1111', 'success'), run(0, '99990000', 'failure')])
    expect(streak.runs).toHaveLength(2)
    expect(streak.firstRun?.databaseId).toBe(2) // 段内最旧
    expect(ciFailureStreak([])).toEqual({ runs: [], firstRun: null })
    expect(ciFailureStreak(null)).toEqual({ runs: [], firstRun: null })
    expect(ciFailureStreak([run(1, 'aaaa1111', 'in_progress')]).firstRun).toBeNull() // 进行中不算红
  })

  it('cardRunRefs/cardCoversStreak：goal/background/acceptance 的 run 号与 sha 提取，sha 前缀互配', () => {
    const refs = cardRunRefs(legacyCiCard('scan-ci-a49876e0', 18427, 'a49876e0', 'ci: u'))
    expect(refs.runIds.has('18427')).toBe(true)
    expect(refs.shas.has('a49876e0')).toBe(true)
    expect(refs.shas.has('a49876e0' + TAIL)).toBe(true) // background 全 sha 也入集
    // run 号精确命中
    expect(cardCoversStreak(legacyCiCard('scan-ci-a49876e0', 18427, 'a49876e0', 'ci: u'), [{ databaseId: 18427, headSha: 'a49876e0' + TAIL }])).toBe(true)
    // 短 sha 卡引用 vs 全 sha run：前缀互配
    expect(cardCoversStreak(legacyCiCard('scan-ci-a49876e0', 18427, 'a49876e0', 'ci: u'), [{ databaseId: 99999, headSha: 'a49876e0' + TAIL }])).toBe(true)
    expect(cardCoversStreak('无关卡', [{ databaseId: 18427, headSha: 'a49876e0' + TAIL }])).toBe(false)
    expect(cardCoversStreak(legacyCiCard('scan-ci-a49876e0', 18427, 'a49876e0', 'ci: u'), [])).toBe(false)
  })

  it('scanCI streak 级去重：id 由 streak 首个 run 派生；streak 增长 id 不变（归并一张卡，非逐 run id）', () => {
    const repo = mkRepo()
    try {
      git(repo.root, 'remote add origin https://github.com/foo/bar.git')
      const streakOf3 = [run(303, 'cccc3333', 'failure'), run(202, 'bbbb2222', 'failure'), run(101, 'aaaa1111', 'failure')]
      const cards = scanCI(repo.root, { baseBranch: 'develop', run: ghRun(streakOf3) })
      expect(cards).toHaveLength(1)
      expect(cards[0].id).toBe('scan-ci-aaaa1111') // streak 首个 run = 最旧一条，非最新 run
      expect(cards[0].goal).toContain('#101')
      expect(cards[0].background).toContain('连续 3 个 run 失败')
      // streak 增长（新的失败 run 排到头部）：首个 run 不变 → 同 id → runScan 存在性去重归并为一张卡
      const grown = [run(404, 'dddd4444', 'failure'), ...streakOf3]
      const again = scanCI(repo.root, { baseBranch: 'develop', run: ghRun(grown) })
      expect(again).toHaveLength(1)
      expect(again[0].id).toBe('scan-ci-aaaa1111')
      expect(again[0].background).toContain('连续 4 个 run 失败')
    } finally {
      repo.cleanup()
    }
  })

  it('存量两卡 fixture（scan-ci-a49876e0/50bd710a 同一红 streak，原样不回改）：引用对拍桥接，不再开第三卡', async () => {
    const repo = mkRepo()
    try {
      git(repo.root, 'remote add origin https://github.com/foo/bar.git')
      const draftsDir = path.join(repo.root, '.agents', 'orchestrator', 'drafts')
      fs.mkdirSync(draftsDir, { recursive: true })
      fs.writeFileSync(path.join(draftsDir, 'scan-ci-a49876e0.md'), legacyCiCard('scan-ci-a49876e0', 18427, 'a49876e0', 'ci: u'))
      fs.writeFileSync(path.join(draftsDir, 'scan-ci-50bd710a.md'), legacyCiCard('scan-ci-50bd710a', 18433, '50bd710a', 'ci: v'))
      // 当前红 streak 覆盖两卡引用的 run（18427/18433 仍在连续失败窗口内）→ 不开第三卡
      const runs = [run(18440, 'f7e0d1c9', 'failure'), run(18433, '50bd710a', 'failure'), run(18427, 'a49876e0', 'failure')]
      const r = await runScan(repo.root, { ci: true, baseBranch: 'develop', ghRun: ghRun(runs) })
      expect(r.created).toHaveLength(0)
      expect(r.warnings.some((w: string) => w.includes('在途卡 scan-ci-'))).toBe(true)
      expect(fs.readdirSync(draftsDir).filter((f) => f.endsWith('.md')).sort()).toEqual(['scan-ci-50bd710a.md', 'scan-ci-a49876e0.md'])
      // streak 恢复绿后重红 = 新 streak（首个 run 变了，旧卡引用的 run 不在窗口内）→ 正当开新卡
      const fresh = [run(18500, 'deadbeef', 'failure'), run(18499, '0123abcd', 'success')]
      const cards = scanCI(repo.root, { baseBranch: 'develop', run: ghRun(fresh) })
      expect(cards).toHaveLength(1)
      expect(cards[0].id).toBe('scan-ci-deadbeef')
    } finally {
      repo.cleanup()
    }
  })

  it('在途队列卡同样桥接：streak 卡已 submit 进 pending 时不重复开卡', () => {
    const repo = mkRepo()
    try {
      git(repo.root, 'remote add origin https://github.com/foo/bar.git')
      const root = path.join(repo.root, '.agents', 'orchestrator', 'queue')
      fs.mkdirSync(path.join(root, 'pending'), { recursive: true })
      fs.writeFileSync(path.join(root, 'pending', 'scan-ci-a49876e0.md'), legacyCiCard('scan-ci-a49876e0', 18427, 'a49876e0', 'ci: u'))
      const runs = [run(18440, 'f7e0d1c9', 'failure'), run(18433, '50bd710a', 'failure'), run(18427, 'a49876e0', 'failure')]
      const r = scanCI(repo.root, { baseBranch: 'develop', run: ghRun(runs) })
      expect(r.skipped).toBe(true)
      expect(r.reason).toContain('scan-ci-a49876e0')
    } finally {
      repo.cleanup()
    }
  })
})
