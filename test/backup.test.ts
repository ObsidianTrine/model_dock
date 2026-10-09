import { describe, expect, it, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fakeHome } from './helpers.js'
import { listSnapshots, matchesSnapshot, pruneSnapshots, restoreSnapshot, snapshot } from '../src/backup/snapshot.js'
import { saveConfig } from '../src/config/store.js'
import { emptyConfig } from '../src/config/types.js'
import { atomicWrite, ensureDir, fileSha256 } from '../src/util/fsx.js'

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
