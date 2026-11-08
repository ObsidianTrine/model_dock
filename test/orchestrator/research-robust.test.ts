// research-robust：调研会话健壮性（2026-11-08 P1 ④⑤）——
// ④ brief id 冲突自动派生唯一 id（writeBriefAuto + runResearchSession 成功路径回执）；
// ⑤ researcher 3 次全败 die 文案带最后一跳 stderrTail 摘要 + 死因处置建议。
// 与 research.test.ts 分文件（并行改动防撞；helpers 复用同款 mkRepo/runOrch）。

import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { writeBrief, writeBriefAuto } from '../../.agents/scripts/orchestrator/research.mjs'
import { mkRepo, runOrch, tryOrch } from './helpers.js'

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'research-robust-'))
}

const TODAY = new Date().toISOString().slice(0, 10)

/** 五段齐全的最小可落盘 brief 正文（同 research.test.ts 的契约样例）。 */
const BRIEF_BODY = [
  '# 结论',
  'mock 调研结论占位 [1]。',
  '',
  '# 选项对比',
  '- 方案 A：mock——优劣占位。',
  '',
  '# 引用',
  `- ${TODAY} https://docs.example.com/probe — 支撑 [1]`,
  '',
  '# 建议',
  'mock 建议占位。',
  '',
  '# 罗盘对齐',
  'mock 对齐说明占位。',
].join('\n')

describe('orchestrator research-robust > writeBriefAuto（P1-④）', () => {
  it('id 冲突自动派生 <id>-2/-3 落盘，返回实际落盘 id；原 id 保留不覆盖', () => {
    const root = tmpRoot()
    try {
      writeBrief(root, { id: 'dup-probe', title: 't1', question: 'q1', backend: 'mock', body: BRIEF_BODY })
      const second = writeBriefAuto(root, { id: 'dup-probe', title: 't2', question: 'q2', backend: 'mock', body: BRIEF_BODY })
      expect(second.id).toBe('dup-probe-2')
      expect(fs.existsSync(path.join(second.dir, 'brief.md'))).toBe(true)
      expect(fs.existsSync(path.join(root, '.agents/orchestrator/research/dup-probe/brief.md'))).toBe(true)
      expect(fs.existsSync(path.join(root, '.agents/orchestrator/research/dup-probe-2/brief.md'))).toBe(true)
      const third = writeBriefAuto(root, { id: 'dup-probe', title: 't3', body: BRIEF_BODY })
      expect(third.id).toBe('dup-probe-3')
      // meta 各归各：回读校验 meta.id 与落盘 id 一致（回执契约）
      const meta2 = JSON.parse(fs.readFileSync(path.join(root, '.agents/orchestrator/research/dup-probe-2/meta.json'), 'utf8'))
      expect(meta2.id).toBe('dup-probe-2')
      expect(meta2.title).toBe('t2')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('9 个候选全占用 → 抛可操作报错（指引清点/归档/换表述）；无冲突时原 id 直接落盘', () => {
    const root = tmpRoot()
    try {
      writeBrief(root, { id: 'full-probe', title: 't', body: BRIEF_BODY })
      for (const n of [2, 3, 4, 5, 6, 7, 8, 9]) writeBrief(root, { id: `full-probe-${n}`, title: 't', body: BRIEF_BODY })
      expect(() => writeBriefAuto(root, { id: 'full-probe', title: 't', body: BRIEF_BODY })).toThrow(/-2…-9 已全部占用[\s\S]*research list/)
      // 无冲突：首候选即原 id
      const fresh = writeBriefAuto(root, { id: 'fresh-probe', title: 't', body: BRIEF_BODY })
      expect(fresh.id).toBe('fresh-probe')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('orchestrator research-robust > research 会话 e2e（mock）', () => {
  it('同一问题连跑两次：第二次自动派生 <id>-2 落盘，回执/后续引用全部用新 id（不裸崩）', () => {
    const repo = mkRepo()
    try {
      const q = 'research id collision probe'
      const base = path.join(repo.root, '.agents', 'orchestrator', 'research')
      const first = runOrch(repo.root, `research "${q}" --backend mock`)
      expect(first.stdout).toContain('--from-brief research-id-collision-probe')
      expect(fs.existsSync(path.join(base, 'research-id-collision-probe', 'brief.md'))).toBe(true)
      // 第二次：同 id 冲突 → writeBriefAuto 派生 -2，die 不再发生
      const second = runOrch(repo.root, `research "${q}" --backend mock`)
      expect(second.stdout).toContain('--from-brief research-id-collision-probe-2')
      expect(fs.existsSync(path.join(base, 'research-id-collision-probe-2', 'brief.md'))).toBe(true)
      const meta = JSON.parse(fs.readFileSync(path.join(base, 'research-id-collision-probe-2', 'meta.json'), 'utf8'))
      expect(meta.id).toBe('research-id-collision-probe-2')
      expect(fs.existsSync(path.join(base, 'research-id-collision-probe', 'brief.md'))).toBe(true) // 第一次的产物未被覆盖
    } finally {
      repo.cleanup()
    }
  }, 120_000)

  it('3 次均无契约块 → die 文案带最后一跳 stderr 摘要 + unrecognized_model/</tool_call> 处置建议', () => {
    const repo = mkRepo()
    try {
      // stderr 有留痕（复刻真实 claude CLI「模型无权/不存在」死法）
      const withTail = tryOrch(repo.root, 'research "die path probe" --backend mock', {
        ORCH_MOCK_PLANNER_INVALID: '1',
        ORCH_MOCK_RESEARCH_STDERR: '1',
      })
      expect(withTail.status).toBe(1)
      expect(withTail.stderr).toContain('3 次均未产出合规 brief')
      expect(withTail.stderr).toContain('最后一跳 stderr：')
      expect(withTail.stderr).toContain('unrecognized_model')
      expect(withTail.stderr).toContain('换 --model 或检查服务商模型接入')
      // stderr 无留痕：占位文案 + 处置建议仍在
      const noTail = tryOrch(repo.root, 'research "die path probe" --backend mock', { ORCH_MOCK_PLANNER_INVALID: '1' })
      expect(noTail.status).toBe(1)
      expect(noTail.stderr).toContain('最后一跳 stderr：（无 stderr 留痕）')
      expect(noTail.stderr).toContain('若报 unrecognized_model 或输出含 </tool_call>')
    } finally {
      repo.cleanup()
    }
  }, 120_000)
})
