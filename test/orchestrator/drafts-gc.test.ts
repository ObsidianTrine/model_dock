// drafts 提案生命周期测试（drafts-gc.mjs，B9）：listDrafts 扫描 / planGc 三清单
// （superseded 重叠 / aged 老化 / titleSimilar 仅提示）/ annotateSuperseded 标注 /
// applyGc 迁移（不删只迁、同名不覆盖）/ supersedeForMerged 闭环内动作 /
// CLI drafts gc（dry-run 与 --apply）。全部走临时目录 fixture，不触真实 drafts/。

import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { mkRepo, runOrch } from './helpers.js'
import {
  annotateSuperseded,
  applyGc,
  draftAgeMs,
  goalSimilarity,
  listDrafts,
  pathsOverlap,
  planGc,
  supersedeForMerged,
} from '../../.agents/scripts/orchestrator/drafts-gc.mjs'
import { loadCard } from '../../.agents/scripts/orchestrator/queue.mjs'

function mkDrafts(): { root: string; dir: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'drafts-gc-'))
  const dir = path.join(root, '.agents', 'orchestrator', 'drafts')
  fs.mkdirSync(dir, { recursive: true })
  return { root, dir, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) }
}

function draft(name: string, id: string, filesHint: string[], opts: { created?: string; goal?: string; body?: string } = {}) {
  const fm = [
    '---',
    `id: ${id}`,
    'type: bugfix',
    'priority: normal',
    `created_at: ${opts.created ?? '2026-11-01T00:00:00+08:00'}`,
    'created_by: scanner',
    'files_hint:',
    ...filesHint.map((h) => `  - ${h}`),
    'workflows:',
    '  - feature-branch',
    'gate: L3',
    '---',
  ].join('\n')
  return `${fm}\n\n# 目标\n${opts.goal ?? `修复 ${id} 相关问题`}\n\n# 验收标准\n- 通过${opts.body ? `\n\n# 背景\n${opts.body}` : ''}\n`
}

const NOW = Date.parse('2026-11-04T12:00:00+08:00')

describe('orchestrator drafts-gc > listDrafts', () => {
  it('只扫顶层 .md；子目录（superseded/archived）不回锅；解析失败进 unreadable', () => {
    const d = mkDrafts()
    try {
      fs.writeFileSync(path.join(d.dir, 'a.md'), draft('a.md', 'feat-a', ['src/gateway/relay.ts']))
      fs.writeFileSync(path.join(d.dir, 'broken.md'), '不是任务卡')
      fs.mkdirSync(path.join(d.dir, 'superseded'), { recursive: true })
      fs.writeFileSync(path.join(d.dir, 'superseded', 'old.md'), draft('old.md', 'old', ['src/**']))
      const { drafts, unreadable } = listDrafts(d.root)
      expect(drafts.map((x) => x.file).sort()).toEqual(['a.md'])
      expect(unreadable).toEqual(['broken.md'])
      expect(drafts[0].meta.id).toBe('feat-a')
    } finally {
      d.cleanup()
    }
  })

  it('drafts/ 不存在 → 空清单（新仓库/未启用提案场景）', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'drafts-gc-none-'))
    try {
      expect(listDrafts(root)).toEqual({ drafts: [], unreadable: [] })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('orchestrator drafts-gc > goalSimilarity / draftAgeMs', () => {
  it('Jaccard：同句 1、无关 0、部分重叠取中；空串 0（中文无分词按空格切，整段计一 token）', () => {
    expect(goalSimilarity('修复 relay failover 可观测性', '修复 relay failover 可观测性')).toBe(1)
    expect(goalSimilarity('修复 relay failover', '升级 npm 依赖')).toBe(0)
    const partial = goalSimilarity('修复 relay failover 缺陷', 'relay failover 缺陷修复方案')
    expect(partial).toBeGreaterThan(0.3)
    expect(partial).toBeLessThan(1)
    expect(goalSimilarity('', 'x')).toBe(0)
  })

  it('年龄：created_at 优先，缺失回落 mtime，都缺 → NaN（保守不老化）', () => {
    const recent = { meta: { created_at: '2026-11-03T00:00:00+08:00' }, mtimeMs: NOW - 1000 }
    expect(draftAgeMs(recent, NOW)).toBe(NOW - Date.parse('2026-11-03T00:00:00+08:00'))
    expect(draftAgeMs({ meta: {}, mtimeMs: NOW - 5000 }, NOW)).toBe(5000)
    expect(draftAgeMs({ meta: {}, mtimeMs: 0 }, NOW)).toBeNaN()
  })
})

describe('orchestrator drafts-gc > planGc（三清单，纯函数）', () => {
  it('files_hint 与 merged 卡重叠 → superseded；仅标题相似 → 只进 titleSimilar（防误杀）', () => {
    const drafts = [
      { id: 't28', file: 't28.md', meta: { id: 't28', files_hint: ['src/gateway/relay.ts'] }, body: { goal: '修复 relay failover 可观测性' }, mtimeMs: NOW, text: '' },
      { id: 'same', file: 'same.md', meta: { id: 'same', files_hint: ['src/config/store.ts'] }, body: { goal: '修复 relay failover 可观测性' }, mtimeMs: NOW, text: '' },
      { id: 'other', file: 'other.md', meta: { id: 'other', files_hint: ['src/util/**'] }, body: { goal: '整理 util 目录' }, mtimeMs: NOW, text: '' },
    ]
    const merged = [{ id: 'fix-relay-obs', filesHint: ['src/gateway/relay.ts', 'test/relay.test.ts'], goal: '修复 relay failover 可观测性' }]
    const plan = planGc(drafts, merged, { now: NOW })
    expect(plan.superseded.map((s) => s.draft.id)).toEqual(['t28'])
    expect(plan.superseded[0].mergedId).toBe('fix-relay-obs')
    expect(plan.titleSimilar.map((s) => s.draft.id)).toEqual(['same']) // 目标相似但 hint 不重叠 → 只提示
    expect(plan.aged).toEqual([])
  })

  it('通配 hint（src/**）与具体路径重叠；目录通配覆盖目录下文件', () => {
    const drafts = [
      { id: 'w', file: 'w.md', meta: { id: 'w', files_hint: ['src/**'] }, body: { goal: '广撒网提案' }, mtimeMs: NOW, text: '' },
      { id: 's', file: 's.md', meta: { id: 's', files_hint: ['src/gateway/relay.ts'] }, body: { goal: '具体提案' }, mtimeMs: NOW, text: '' },
    ]
    const plan = planGc(drafts, [{ id: 'm', filesHint: ['src/gateway/**'], goal: '' }], { now: NOW })
    expect(plan.superseded.map((s) => s.draft.id)).toEqual(['w', 's'])
  })

  it('老化：超 archiveDays → aged；已入 superseded 清单的不重复入 aged；created_at/mtime 双口径', () => {
    const old = { id: 'old', file: 'old.md', meta: { id: 'old', files_hint: ['src/util/**'], created_at: '2026-09-01T00:00:00+08:00' }, body: { goal: '老提案' }, mtimeMs: NOW, text: '' }
    const oldNoTs = { id: 'old2', file: 'old2.md', meta: { id: 'old2', files_hint: ['src/cli/**'] }, body: { goal: '老提案2' }, mtimeMs: NOW - 40 * 86_400_000, text: '' }
    const fresh = { id: 'new', file: 'new.md', meta: { id: 'new', files_hint: ['src/cli/**'], created_at: '2026-11-01T00:00:00+08:00' }, body: { goal: '新提案' }, mtimeMs: NOW, text: '' }
    const plan = planGc([old, oldNoTs, fresh], [], { now: NOW, archiveDays: 30 })
    expect(plan.aged.map((a) => a.draft.id)).toEqual(['old', 'old2'])
    // archiveDays 自定义（7 天）：11-01 的提案（3 天龄）不老化
    const plan7 = planGc([fresh], [], { now: NOW, archiveDays: 7 })
    expect(plan7.aged).toEqual([])
  })

  it('已标注 superseded_by 的不回锅（重复 gc 幂等）', () => {
    const done = { id: 'done', file: 'done.md', meta: { id: 'done', files_hint: ['src/gateway/relay.ts'], superseded_by: 'fix-x' }, body: { goal: '修复 relay' }, mtimeMs: NOW, text: '' }
    const plan = planGc([done], [{ id: 'fix-x', filesHint: ['src/gateway/relay.ts'], goal: '' }], { now: NOW })
    expect(plan.superseded).toEqual([])
    expect(plan.titleSimilar).toEqual([])
  })
})

describe('orchestrator drafts-gc > pathsOverlap（路径前缀精确口径，防误杀）', () => {
  it('同文件/同目录/前缀目录重叠；跨目录不误杀；完全通配独占；反斜杠归一', () => {
    expect(pathsOverlap(['src/gateway/relay.ts'], ['src/gateway/relay.ts'])).toBe(true)
    expect(pathsOverlap(['src/gateway/relay.ts'], ['src/gateway/**'])).toBe(true)
    expect(pathsOverlap(['src/gateway/**'], ['src/gateway/state.ts'])).toBe(true)
    expect(pathsOverlap(['src/gateway/relay.ts'], ['src/gateway/relay.ts', 'test/relay.test.ts'])).toBe(true)
    expect(pathsOverlap(['src/gateway/relay.ts'], ['src/config/**'])).toBe(false) // 顶层同 src 但路径不重叠
    expect(pathsOverlap(['src/**'], ['test/foo.ts'])).toBe(false)
    expect(pathsOverlap(['**'], ['src/x.ts'])).toBe(true) // 完全通配 = 独占
    expect(pathsOverlap([], ['src/x.ts'])).toBe(false) // 空清单建立不了重叠 → 不迁（防误杀）
    expect(pathsOverlap(['src\\gateway\\relay.ts'], ['src/gateway/relay.ts'])).toBe(true)
  })
})

describe('orchestrator drafts-gc > annotateSuperseded / applyGc（不删只迁）', () => {
  it('标注：frontmatter 加 superseded_by/at 两键 + 正文顶部说明行；标注后仍可 parseCard', () => {
    const text = draft('a.md', 'feat-a', ['src/gateway/relay.ts'])
    const next = annotateSuperseded(text, 'fix-relay-obs', '2026-11-04T12:00:00+08:00')
    expect(next).toContain('superseded_by: fix-relay-obs')
    expect(next).toContain('superseded_at: 2026-11-04T12:00:00+08:00')
    expect(next).toContain('已被合并任务 fix-relay-obs 覆盖')
    // 标注后的文件仍是合法任务卡（frontmatter 在前、目标段保留）
    const { meta, body } = loadCard(next, 'a.md')
    expect(meta.id).toBe('feat-a')
    expect(meta.superseded_by).toBe('fix-relay-obs')
    expect(body.goal).toContain('修复 feat-a')
  })

  it('applyGc：superseded 带标注迁移、aged 原文迁移、原文件消失；重复 gc 不覆盖不报错', () => {
    const d = mkDrafts()
    try {
      fs.writeFileSync(path.join(d.dir, 'overlap.md'), draft('overlap.md', 'ov', ['src/gateway/relay.ts']))
      fs.writeFileSync(path.join(d.dir, 'aged.md'), draft('aged.md', 'ag', ['src/util/**'], { created: '2026-09-01T00:00:00+08:00' }))
      const { drafts } = listDrafts(d.root)
      const plan = planGc(drafts, [{ id: 'fix-relay-obs', filesHint: ['src/gateway/relay.ts'], goal: '' }], { now: NOW })
      const r = applyGc(d.root, plan, { now: NOW })
      expect(r.movedSuperseded.map((m) => m.file)).toEqual(['overlap.md'])
      expect(r.movedAged.map((m) => m.file)).toEqual(['aged.md'])
      expect(r.failed).toEqual([])
      // 原文件消失，目标目录有内容
      expect(fs.existsSync(path.join(d.dir, 'overlap.md'))).toBe(false)
      expect(fs.existsSync(path.join(d.dir, 'aged.md'))).toBe(false)
      const movedSup = fs.readFileSync(path.join(d.dir, 'superseded', 'overlap.md'), 'utf8')
      expect(movedSup).toContain('superseded_by: fix-relay-obs')
      expect(fs.readFileSync(path.join(d.dir, 'archived', 'aged.md'), 'utf8')).toContain('id: ag')
      // 幂等：再次 gc 同一批 → 清单为空（顶层已无提案）
      const again = planGc(listDrafts(d.root).drafts, [{ id: 'fix-relay-obs', filesHint: ['src/gateway/relay.ts'], goal: '' }], { now: NOW })
      expect(again.superseded).toEqual([])
      expect(again.aged).toEqual([])
    } finally {
      d.cleanup()
    }
  })

  it('目标同名文件已存在 → 跳过并记 failed（绝不覆盖，Windows rename 语义安全）', () => {
    const d = mkDrafts()
    try {
      fs.writeFileSync(path.join(d.dir, 'x.md'), draft('x.md', 'x', ['src/gateway/relay.ts']))
      fs.mkdirSync(path.join(d.dir, 'superseded'), { recursive: true })
      fs.writeFileSync(path.join(d.dir, 'superseded', 'x.md'), '历史遗留文件')
      const { drafts } = listDrafts(d.root)
      const plan = planGc(drafts, [{ id: 'm', filesHint: ['src/gateway/relay.ts'], goal: '' }], { now: NOW })
      const r = applyGc(d.root, plan, { now: NOW })
      expect(r.movedSuperseded).toEqual([])
      expect(r.failed).toHaveLength(1)
      expect(r.failed[0].file).toBe('x.md')
      // 原文件保留在原地（绝不删除）
      expect(fs.existsSync(path.join(d.dir, 'x.md'))).toBe(true)
    } finally {
      d.cleanup()
    }
  })
})

describe('orchestrator drafts-gc > supersedeForMerged（merge 时的闭环内动作）', () => {
  it('重叠提案自动迁 superseded/ 并返回迁移清单；无重叠时零动作', () => {
    const d = mkDrafts()
    try {
      fs.writeFileSync(path.join(d.dir, 'hit.md'), draft('hit.md', 'hit', ['src/gateway/relay.ts']))
      fs.writeFileSync(path.join(d.dir, 'miss.md'), draft('miss.md', 'miss', ['src/config/**']))
      const moved = supersedeForMerged(d.root, { mergedId: 'fix-relay-obs', filesHint: ['src/gateway/relay.ts'], now: NOW })
      expect(moved).toEqual(['hit.md'])
      expect(fs.existsSync(path.join(d.dir, 'superseded', 'hit.md'))).toBe(true)
      expect(fs.existsSync(path.join(d.dir, 'miss.md'))).toBe(true)
      expect(supersedeForMerged(d.root, { mergedId: 'x', filesHint: ['nope/**'], now: NOW })).toEqual([])
    } finally {
      d.cleanup()
    }
  })
})

// ---------------------------------------------------------------------------
// CLI drafts gc（dry-run 与 --apply；临时目录 + 真实 orchestrator.mjs 子进程）
// ---------------------------------------------------------------------------

describe('orchestrator drafts-gc > CLI drafts gc', () => {
  it('dry-run 只列清单不动文件；--apply 迁移（superseded 带标注）', () => {
    const repo = mkRepo() // git 仓库：orchestrator main() 先 findRepoRoot
    const dir = path.join(repo.root, '.agents', 'orchestrator', 'drafts')
    const mergedDir = path.join(repo.root, '.agents', 'orchestrator', 'queue', 'merged')
    fs.mkdirSync(dir, { recursive: true })
    fs.mkdirSync(mergedDir, { recursive: true })
    try {
      fs.writeFileSync(path.join(dir, 'ov.md'), draft('ov.md', 'ov', ['src/gateway/relay.ts']))
      fs.writeFileSync(path.join(mergedDir, 'fix-relay-obs.md'), draft('fix-relay-obs.md', 'fix-relay-obs', ['src/gateway/relay.ts']))
      const dry = runOrch(repo.root, 'drafts gc')
      expect(dry.stdout).toContain('superseded 候选')
      expect(dry.stdout).toContain('ov.md')
      expect(dry.stdout).toContain('--apply')
      expect(fs.existsSync(path.join(dir, 'ov.md'))).toBe(true) // dry-run 不动文件
      const applied = runOrch(repo.root, 'drafts gc --apply')
      expect(applied.stdout).toContain('迁移 ov.md')
      expect(fs.existsSync(path.join(dir, 'superseded', 'ov.md'))).toBe(true)
      expect(fs.readFileSync(path.join(dir, 'superseded', 'ov.md'), 'utf8')).toContain('superseded_by: fix-relay-obs')
    } finally {
      repo.cleanup()
    }
  })
})
