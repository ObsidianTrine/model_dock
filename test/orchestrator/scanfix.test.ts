// scan 型卡自动转修复卡测试（scanfix.mjs，B10）：id 前缀判定 / 修复卡组装（过 validateCard）
// / scanAutoFixAfterFailure（创建、去重、开关、容错）。全部临时仓库 fixture，不触真实队列。

import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildFixCardText, fixCardId, isScanCardId, scanAutoFixAfterFailure } from '../../.agents/scripts/orchestrator/scanfix.mjs'
import { ensureQueue, loadCard, queueRoot } from '../../.agents/scripts/orchestrator/queue.mjs'
import { cardText } from './helpers.js'

const SCAN_CARD_TEXT = [
  '---',
  'id: scan-ci-414aba6c',
  'type: bugfix',
  'priority: high',
  'created_at: 2026-11-02T02:32:19.689+08:00',
  'created_by: scanner',
  'signal_hashes: [9fea6cfd]',
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
  '修复主干（develop）test 失败 run #41266336061',
  '',
  '# 验收标准',
  '- 失败测试修复；对应提交全绿',
  '',
  '# 背景',
  '巡检发现主干 test 失败。',
].join('\n')

function mkRepo(): { root: string; root_q: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scanfix-'))
  const root_q = queueRoot(root)
  ensureQueue(root_q)
  return { root, root_q, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) }
}

function seedFailedScan(repo: { root: string; root_q: string }, id = 'scan-ci-414aba6c', events: Array<Record<string, unknown>> = []) {
  fs.writeFileSync(path.join(repo.root_q, 'failed', `${id}.md`), SCAN_CARD_TEXT.replace('id: scan-ci-414aba6c', `id: ${id}`))
  const dir = path.join(repo.root, '.agents', 'orchestrator', 'logs', id)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n')
}

describe('orchestrator scanfix > id 判定与修复卡 id', () => {
  it('scan- 前缀命中（各信号源命名）；fix- 卡与普通卡不命中（防循环的第一道保险）', () => {
    for (const id of ['scan-ci-414aba6c', 'scan-todo-abc', 'scan-audit-x', 'scan-ki-xplat-09']) {
      expect(isScanCardId(id)).toBe(true)
    }
    for (const id of ['fix-scan-ci-414aba6c', 'test-gap-gateway-util', 'scan', 'Scan-ci-1', '']) {
      expect(isScanCardId(id)).toBe(false)
    }
    expect(fixCardId('scan-ci-414aba6c')).toBe('fix-scan-ci-414aba6c')
  })
})

describe('orchestrator scanfix > buildFixCardText（组装即合法任务卡）', () => {
  it('继承 type/priority/files_hint/workflows/gate；正文引用 incident.md 与失败摘要；过 loadCard 校验', () => {
    const { meta, body } = loadCard(SCAN_CARD_TEXT, 'scan.md')
    const text = buildFixCardText({
      scanId: 'scan-ci-414aba6c',
      scanMeta: meta,
      scanBody: body,
      failReason: '人工 abandon（按 worktree-rescue 流程处理）',
      iso: '2026-11-04T12:00:00.000+08:00',
    })
    const parsed = loadCard(text, 'fix.md') // 修复卡必须过既有校验（files_hint 非空、workflows 非空、gate 合法）
    expect(parsed.meta.id).toBe('fix-scan-ci-414aba6c')
    expect(parsed.meta.type).toBe('bugfix')
    expect(parsed.meta.priority).toBe('high')
    expect(parsed.meta.gate).toBe('L3')
    expect(parsed.meta.files_hint).toEqual(['src/**', 'test/**'])
    expect(parsed.body.goal).toContain('scan-ci-414aba6c')
    expect(text).toContain('incident.md')
    expect(text).toContain('人工 abandon')
    expect(text).toContain('- 失败测试修复') // 验收标准继承
  })

  it('验收标准缺失回落兜底；失败摘要缺失标（未记录）', () => {
    const meta = { id: 'scan-x', type: 'refactor', files_hint: ['src/**'], workflows: ['feature-branch'] }
    const text = buildFixCardText({ scanId: 'scan-x', scanMeta: meta, scanBody: { goal: '目标', acceptance: '', background: '' }, failReason: '', iso: '2026-11-04T12:00:00.000+08:00' })
    const parsed = loadCard(text, 'fix.md')
    expect(parsed.meta.type).toBe('refactor')
    expect(parsed.body.acceptance).toContain('测试全绿')
    expect(text).toContain('失败摘要：（未记录）')
  })
})

describe('orchestrator scanfix > scanAutoFixAfterFailure（drain 落位点接线）', () => {
  it('failed scan 卡 → 创建 pending 修复卡 + scan_autofix 事件留痕（事件落在原卡日志）', () => {
    const repo = mkRepo()
    try {
      seedFailedScan(repo, 'scan-ci-abc', [
        { ts: '2026-11-03T10:00:00.000+08:00', seq: 1, type: 'failed', reason: '红线门禁 port_scan：src/ 命中 8687' },
      ])
      const r = scanAutoFixAfterFailure(repo.root, repo.root_q, 'scan-ci-abc')
      expect(r.created).toBe(true)
      expect(r.id).toBe('fix-scan-ci-abc')
      const text = fs.readFileSync(path.join(repo.root_q, 'pending', 'fix-scan-ci-abc.md'), 'utf8')
      expect(text).toContain('id: fix-scan-ci-abc')
      expect(text).toContain('8687') // 失败摘要进了卡
      const events = fs.readFileSync(path.join(repo.root, '.agents', 'orchestrator', 'logs', 'scan-ci-abc', 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
      const ev = events.at(-1) as Record<string, unknown>
      expect(ev.type).toBe('scan_autofix')
      expect(ev.fix).toBe('fix-scan-ci-abc')
    } finally {
      repo.cleanup()
    }
  })

  it('去重（防循环）：同名修复卡已存在任一状态即跳过（merged/failed 也算）', () => {
    const repo = mkRepo()
    try {
      seedFailedScan(repo, 'scan-ci-dup')
      fs.writeFileSync(path.join(repo.root_q, 'failed', 'fix-scan-ci-dup.md'), cardText({ id: 'fix-scan-ci-dup' }))
      const r = scanAutoFixAfterFailure(repo.root, repo.root_q, 'scan-ci-dup')
      expect(r.skipped).toBe(true)
      expect(String(r.reason)).toContain('已存在')
      // pending 同名同样跳过
      fs.rmSync(path.join(repo.root_q, 'failed', 'fix-scan-ci-dup.md'))
      fs.writeFileSync(path.join(repo.root_q, 'pending', 'fix-scan-ci-dup.md'), cardText({ id: 'fix-scan-ci-dup' }))
      expect(scanAutoFixAfterFailure(repo.root, repo.root_q, 'scan-ci-dup').skipped).toBe(true)
    } finally {
      repo.cleanup()
    }
  })

  it('非 scan 卡 / enabled=false / 原卡读不了 / 原卡损坏：全部安全跳过', () => {
    const repo = mkRepo()
    try {
      expect(scanAutoFixAfterFailure(repo.root, repo.root_q, 'test-gap-gateway-util', { enabled: true })).toBeNull()
      seedFailedScan(repo, 'scan-ci-off')
      expect(scanAutoFixAfterFailure(repo.root, repo.root_q, 'scan-ci-off', { enabled: false }).skipped).toBe(true)
      expect(fs.existsSync(path.join(repo.root_q, 'pending', 'fix-scan-ci-off.md'))).toBe(false)
      // 原卡损坏（无 frontmatter）：跳过不抛错
      fs.writeFileSync(path.join(repo.root_q, 'failed', 'scan-ci-broken.md'), '损坏卡')
      const r = scanAutoFixAfterFailure(repo.root, repo.root_q, 'scan-ci-broken')
      expect(r.skipped).toBe(true)
      expect(String(r.reason)).toContain('解析失败')
    } finally {
      repo.cleanup()
    }
  })
})
