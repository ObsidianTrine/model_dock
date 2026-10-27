import { describe, expect, it, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fakeHome } from './helpers.js'
import { listSnapshots, matchesSnapshot, pruneSnapshots, restoreSnapshot, snapshot } from '../src/backup/snapshot.js'
import { saveConfig } from '../src/config/store.js'
import { emptyConfig } from '../src/config/types.js'
import { atomicWrite, ensureDir, fileSha256 } from '../src/util/fsx.js'
import { backupsDir } from '../src/util/paths.js'

afterEach(() => {})

describe('backup snapshot', () => {
  it('快照 → 篡改 → 还原：内容与 sha256 一致，权限保留', async () => {
    const h = fakeHome()
    try {
      const file = path.join(h.home, 'settings.json')
      await atomicWrite(file, '{"a":1}\n', 0o600)
      const m = await snapshot('claude-code', 'attach', [file])
      expect(m.files).toHaveLength(1)
      expect(m.files[0].sha256).toHaveLength(64)

      await atomicWrite(file, '{"a":2,"b":3}\n', 0o644)
      await restoreSnapshot(m)
      expect(fs.readFileSync(file, 'utf8')).toBe('{"a":1}\n')
      expect(await fileSha256(file)).toBe(m.files[0].sha256)
      expect(await matchesSnapshot(m)).toBe(true)
    } finally {
      h.restore()
    }
  })

  it('不存在的文件记录为缺席，还原时跳过', async () => {
    const h = fakeHome()
    try {
      const missing = path.join(h.home, 'nope.yaml')
      const m = await snapshot('dsh', 'attach', [missing])
      expect(m.files[0].stored_as).toBe('')
      await restoreSnapshot(m) // 不应抛错
    } finally {
      h.restore()
    }
  })

  it('多文件快照与列表', async () => {
    const h = fakeHome()
    try {
      const f1 = path.join(h.home, 'a.yaml')
      const f2 = path.join(h.home, 'sub', 'b.json')
      await ensureDir(path.dirname(f2))
      await atomicWrite(f1, 'a: 1\n', 0o600)
      await atomicWrite(f2, '{"b":2}\n', 0o600)
      await snapshot('dsh', 'attach', [f1, f2])
      const snaps = await listSnapshots('dsh')
      expect(snaps).toHaveLength(1)
      expect(snaps[0].files).toHaveLength(2)
    } finally {
      h.restore()
    }
  })

  it('prune 只保留最近 N 份', async () => {
    const h = fakeHome()
    try {
      const file = path.join(h.home, 'x.txt')
      for (let i = 0; i < 5; i++) {
        await atomicWrite(file, `v${i}\n`, 0o600)
        await snapshot('demo', 'attach', [file])
      }
      expect(await pruneSnapshots('demo', 3)).toBe(2)
      expect(await listSnapshots('demo')).toHaveLength(3)
    } finally {
      h.restore()
    }
  })

  it('backup.keep 生效：快照后按配置份数自动修剪', async () => {
    const h = fakeHome()
    try {
      await saveConfig({ ...emptyConfig(), backup: { keep: 3 } })
      const file = path.join(h.home, 'x.txt')
      for (let i = 0; i < 5; i++) {
        await atomicWrite(file, `v${i}\n`, 0o600)
        await snapshot('keepcfg', 'attach', [file]) // snapshot 内部按 backup.keep 修剪
      }
      expect(await listSnapshots('keepcfg')).toHaveLength(3)
    } finally {
      h.restore()
    }
  })

  it('backup.keep 防呆：0 / 非法值钳制为至少保留 1 份', async () => {
    const h = fakeHome()
    try {
      await saveConfig({ ...emptyConfig(), backup: { keep: 0 } })
      const file = path.join(h.home, 'x.txt')
      for (let i = 0; i < 3; i++) {
        await atomicWrite(file, `v${i}\n`, 0o600)
        await snapshot('keepclamp', 'attach', [file])
      }
      expect(await listSnapshots('keepclamp')).toHaveLength(1)
    } finally {
      h.restore()
    }
  })

  it('快照损坏检测：篡改文件后 matchesSnapshot 返回 false', async () => {
    const h = fakeHome()
    try {
      const file = path.join(h.home, 's.json')
      await atomicWrite(file, 'one\n', 0o600)
      const m = await snapshot('h', 'attach', [file])
      await atomicWrite(file, 'two\n', 0o600)
      expect(await matchesSnapshot(m)).toBe(false)
    } finally {
      h.restore()
    }
  })
})

describe('快照孤儿清理竞态（CORRECT-02）', () => {
  it('宽限期内带 .incomplete 占位的半成品不被 prune 删除；无占位孤儿与占位超龄孤儿仍被清理', async () => {
    const h = fakeHome()
    try {
      const root = path.join(backupsDir(), 'claude-code')
      // 他进程半成品：有内容、无 manifest、占位新鲜 → 宽限期内必须幸存
      const halfDone = path.join(root, '20990101T000000-attach-alive')
      fs.mkdirSync(path.join(halfDone, 'files'), { recursive: true })
      fs.writeFileSync(path.join(halfDone, 'files', '0.blob'), 'partial')
      fs.writeFileSync(path.join(halfDone, '.incomplete'), '')
      // 旧版本残留：无占位半成品 → 维持清理
      const legacy = path.join(root, '20990101T000000-attach-legacy')
      fs.mkdirSync(legacy, { recursive: true })
      fs.writeFileSync(path.join(legacy, 'junk'), 'x')
      // 崩溃残留：占位 mtime 回拨 11 分钟（> 10min 宽限）→ 兜底清理
      const stale = path.join(root, '20990101T000000-attach-stale')
      fs.mkdirSync(stale, { recursive: true })
      const staleMarker = path.join(stale, '.incomplete')
      fs.writeFileSync(staleMarker, '')
      const old = new Date(Date.now() - 11 * 60_000)
      fs.utimesSync(staleMarker, old, old)

      const removed = await pruneSnapshots('claude-code', 20)
      expect(fs.existsSync(halfDone)).toBe(true)
      expect(fs.existsSync(legacy)).toBe(false)
      expect(fs.existsSync(stale)).toBe(false)
      expect(removed).toBe(2)
    } finally {
      h.restore()
    }
  })

  it('并发交错：snapshot 内部触发 prune 不删他进程新鲜半成品；对方 manifest 落盘、占位移除后正常入列且被后续 prune 保留', async () => {
    const h = fakeHome()
    try {
      const file = path.join(h.home, 'settings.json')
      await atomicWrite(file, '{"a":1}\n', 0o600)
      // 模拟另一执行流进行到一半：目录建好、blob 已拷、占位已落、manifest 未写
      const root = path.join(backupsDir(), 'claude-code')
      const otherId = '20990101T000000-attach-other'
      const other = path.join(root, otherId)
      fs.mkdirSync(path.join(other, 'files'), { recursive: true })
      fs.writeFileSync(path.join(other, 'files', '0.blob'), 'other-partial')
      fs.writeFileSync(path.join(other, '.incomplete'), '')

      const m = await snapshot('claude-code', 'attach', [file]) // 内部触发 prune
      expect(fs.existsSync(other)).toBe(true) // 交错中的他方半成品幸存
      expect(fs.existsSync(path.join(root, m.id, '.incomplete'))).toBe(false) // 自己完成后占位已撤

      // 他方写完 manifest、撤占位 → 正常入列；再次快照（再次触发 prune）仍按合法快照保留
      const manifest = {
        id: otherId,
        harness: 'claude-code',
        operation: 'attach',
        timestamp: '2099-01-01T00:00:00.000Z',
        tool_version: 'test',
        files: [],
      }
      fs.writeFileSync(path.join(other, 'manifest.json'), JSON.stringify(manifest))
      fs.rmSync(path.join(other, '.incomplete'))
      await snapshot('claude-code', 'detach', [file])
      const listed = await listSnapshots('claude-code')
      expect(listed.some((x) => x.id === otherId)).toBe(true)
    } finally {
      h.restore()
    }
  })

  it('同秒连续两次快照：目录独立、id 不冲突（id 冲突重试死代码修复后语义）', async () => {
    const h = fakeHome()
    try {
      const file = path.join(h.home, 's.json')
      await atomicWrite(file, 'v\n', 0o600)
      const m1 = await snapshot('ids', 'attach', [file])
      const m2 = await snapshot('ids', 'attach', [file])
      expect(m1.id).not.toBe(m2.id)
      const listed = await listSnapshots('ids')
      expect(listed).toHaveLength(2)
    } finally {
      h.restore()
    }
  })
})
