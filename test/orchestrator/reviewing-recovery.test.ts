// 卡 19（orch-run-recovery-gaps，2026-10-31）回归——评测考题
// 2026-10-orch-awaiting-human-crash 复核挖出的两条 run/恢复路径缺陷：
// ① run/resume 白名单放行 reviewing——审查阶段硬崩的卡此前唯一程序化出口是
//    abandon 强制落 failed，而状态机 TRANSITIONS 本就允许 reviewing→running；
// ② reviewer 临时目录（orch-review-*/orch-review-settings-*）收进 finally 清单——
//    旧实现只清 worker 的两个，审查阶段每轮泄漏 1-2 个。
// 全程 mock 后端（零外部调用）；不动状态机 TRANSITIONS 与 awaiting-human 迁移语义。

import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { cardText, eventsOf, mkRepo, readCard, runOrch } from './helpers.js'

/** 模拟「审查阶段硬崩」的现场：卡移入 reviewing/，事件线留上次会话痕迹。 */
function stageReviewingCrash(repoRoot: string, id: string): void {
  const q = path.join(repoRoot, '.agents', 'orchestrator', 'queue')
  fs.mkdirSync(path.join(q, 'reviewing'), { recursive: true })
  fs.renameSync(path.join(q, 'pending', `${id}.md`), path.join(q, 'reviewing', `${id}.md`))
  const qdir = path.join(repoRoot, '.agents', 'orchestrator', 'logs', id)
  fs.mkdirSync(qdir, { recursive: true })
  const lines = [
    { ts: '2026-10-31T00:00:00.000+08:00', seq: 1, type: 'task_accepted', backend: 'mock' },
    { ts: '2026-10-31T00:00:01.000+08:00', seq: 2, type: 'worker_spawned', backend: 'mock', pid: 999999 },
    { ts: '2026-10-31T00:00:02.000+08:00', seq: 3, type: 'worker_done', summary: '上次已完成实现' },
  ].map((e) => JSON.stringify(e))
  fs.writeFileSync(path.join(qdir, 'events.jsonl'), `${lines.join('\n')}\n`)
}

describe('reviewing 卡恢复（run/resume 白名单）', () => {
  it('resume 放行 reviewing：归位 running、注入恢复上下文（task_accepted from_state=reviewing）、闭环跑到 awaiting-human', () => {
    const repo = mkRepo()
    try {
      const cardFile = path.join(repo.root, 'card-rev.md')
      fs.writeFileSync(cardFile, cardText({ id: 'rev' }))
      runOrch(repo.root, `submit "${cardFile}"`)
      stageReviewingCrash(repo.root, 'rev')

      runOrch(repo.root, 'resume rev --backend mock')

      expect(readCard(repo.root, 'awaiting-human', 'rev')).toBeTruthy()
      const evs = eventsOf(repo.root, 'rev')
      expect(evs.some((e) => e.type === 'resumed')).toBe(true)
      expect(evs.some((e) => e.type === 'task_accepted' && (e as Record<string, unknown>).from_state === 'reviewing')).toBe(true)
      // 闭环完整走完：新会话的 worker/review 均有事件（非半途中断）
      expect(evs.filter((e) => e.type === 'review_spawned').length).toBeGreaterThanOrEqual(1)
    } finally {
      repo.cleanup()
    }
  })

  it('run 也放行 reviewing（run 白名单同修）：归位后正常跑完', () => {
    const repo = mkRepo()
    try {
      const cardFile = path.join(repo.root, 'card-revrun.md')
      fs.writeFileSync(cardFile, cardText({ id: 'rev-run' }))
      runOrch(repo.root, `submit "${cardFile}"`)
      stageReviewingCrash(repo.root, 'rev-run')

      runOrch(repo.root, 'run rev-run --backend mock')

      expect(readCard(repo.root, 'awaiting-human', 'rev-run')).toBeTruthy()
      expect(
        eventsOf(repo.root, 'rev-run').some(
          (e) => e.type === 'task_accepted' && (e as Record<string, unknown>).from_state === 'reviewing',
        ),
      ).toBe(true)
    } finally {
      repo.cleanup()
    }
  })
})

describe('reviewer 临时目录清理', () => {
  it('run 正常结束后 os.tmpdir() 无 orch-review-* 残留（finally 统一清，含每轮新建）', () => {
    const repo = mkRepo()
    const tmp = fs.realpathSync(os.tmpdir())
    const reviewDirs = () =>
      fs
        .readdirSync(tmp)
        .filter((d) => d.startsWith('orch-review-'))
        .map((d) => path.join(tmp, d))
    try {
      const before = new Set(reviewDirs())
      const cardFile = path.join(repo.root, 'card-tmp.md')
      fs.writeFileSync(cardFile, cardText({ id: 'tmpclean' }))
      runOrch(repo.root, `submit "${cardFile}"`)
      runOrch(repo.root, 'run tmpclean --backend mock')
      expect(readCard(repo.root, 'awaiting-human', 'tmpclean')).toBeTruthy()
      // 本轮新建的 reviewer 临时目录必须全部清理；其他进程的旧目录不动（只比增量）
      const leaked = reviewDirs().filter((d) => !before.has(d))
      expect(leaked).toEqual([])
    } finally {
      repo.cleanup()
    }
  })
})
