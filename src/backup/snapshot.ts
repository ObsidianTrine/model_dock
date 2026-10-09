import fsp from 'node:fs/promises'
import path from 'node:path'
import { backupsDir } from '../util/paths.js'
import { ensureDir, fileMode, fileSha256, sha256 } from '../util/fsx.js'
import { loadConfig } from '../config/store.js'
import { t } from '../util/i18n.js'
import { VERSION } from '../version.js'

export interface SnapshotFileRec {
  path: string
  stored_as: string
  sha256: string
  mode: number
}

export interface SnapshotManifest {
  id: string
  harness: string
  operation: string
  timestamp: string
  tool_version: string
  active_profile?: string
  files: SnapshotFileRec[]
}

async function snapshotRoot(harness: string): Promise<string> {
  return path.join(backupsDir(), harness)
}

function stamp(): string {
  const d = new Date()
  const p = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}T${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/** 写操作前调用：把涉及文件整份拷贝进快照目录；全部不存在时也记录（files 为空）。
 *  写完自动按 backup.keep（默认 20）修剪旧快照并清理孤儿目录。 */
export async function snapshot(
  harness: string,
  operation: string,
  files: string[],
  activeProfile?: string
): Promise<SnapshotManifest> {
  const root = await snapshotRoot(harness)
  // id 冲突（同秒同随机段）时换一个随机后缀重试，避免静默覆盖上一份快照
  let dir = ''
  let id = ''
  for (let attempt = 0; attempt < 3; attempt++) {
    id = `${stamp()}-${operation}-${Math.random().toString(36).slice(2, 8)}`
    dir = path.join(root, id)
    try {
      await fsp.mkdir(dir, { recursive: true })
      break
    } catch { /* 理论上 recursive 不冲突；保守重试 */ }
  }
  const filesDir = path.join(dir, 'files')
  await ensureDir(filesDir, 0o700)

  const recs: SnapshotFileRec[] = []
  for (let i = 0; i < files.length; i++) {
    const p = files[i]
    const storedAs = `${i}.blob`
    try {
      const buf = await fsp.readFile(p)
      const mode = await fileMode(p)
      await fsp.writeFile(path.join(filesDir, storedAs), buf, { mode })
      recs.push({ path: p, stored_as: storedAs, sha256: sha256(buf), mode })
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') throw e
      recs.push({ path: p, stored_as: '', sha256: '', mode: 0 })
    }
  }

  const manifest: SnapshotManifest = {
    id,
    harness,
    operation,
    timestamp: new Date().toISOString(),
    tool_version: VERSION,
    active_profile: activeProfile,
    files: recs,
  }
  await fsp.writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), {
    mode: 0o600,
  })
  try {
    const cfg = await loadConfig()
    await pruneSnapshots(harness, cfg.backup?.keep ?? 20)
  } catch {
    /* 修剪失败不影响快照本身 */
  }
  return manifest
}

export async function listSnapshots(harness: string): Promise<SnapshotManifest[]> {
  const root = await snapshotRoot(harness)
  let entries: string[]
  try {
    entries = (await fsp.readdir(root)).filter((e) => !e.startsWith('.')).sort()
  } catch {
    return []
  }
  const manifests: SnapshotManifest[] = []
  for (const e of entries) {
    try {
      const m = JSON.parse(await fsp.readFile(path.join(root, e, 'manifest.json'), 'utf8'))
      manifests.push(m)
    } catch {
      /* 损坏的快照跳过 */
    }
  }
  // 最新在前，按 manifest 的毫秒级 timestamp 排。目录名里的 stamp 只有秒级、同秒内顺序取决于随机后缀，
  // 曾导致快速连续两次 attach 时 detach 选错"最近一次接入前"的快照。
  manifests.sort((a, b) => (b.timestamp ?? '').localeCompare(a.timestamp ?? '') || b.id.localeCompare(a.id))
  return manifests
}

export async function getSnapshot(harness: string, id: string): Promise<SnapshotManifest | null> {
  const all = await listSnapshots(harness)
  return all.find((m) => m.id === id || m.id.startsWith(id)) ?? null
}

/** 逐文件还原，并校验 sha256；还原前由调用方决定是否先快照当前状态。
 *  快照时不存在（stored_as 为空）的文件，还原语义是"恢复到当时"→ 删除现在存在的残留。 */
export async function restoreSnapshot(manifest: SnapshotManifest): Promise<void> {
  for (const rec of manifest.files) {
    if (!rec.stored_as) {
      await fsp.rm(rec.path, { force: true })
      continue
    }
    const src = path.join(backupsDir(), manifest.harness, manifest.id, 'files', rec.stored_as)
    const buf = await fsp.readFile(src)
    if (sha256(buf) !== rec.sha256) {
      throw new Error(
        t('快照 {id} 中 {path} 校验失败，已中止还原', 'Checksum mismatch for {path} in snapshot {id}; restore aborted', { id: manifest.id, path: rec.path })
      )
    }
    await ensureDir(path.dirname(rec.path))
    await fsp.writeFile(rec.path, buf, { mode: rec.mode })
  }
}

/** 每个 harness 滚动保留 keep 份；孤儿目录（半成品、无合法 manifest，可能含敏感文件副本）一律清理 */
export async function pruneSnapshots(harness: string, keep = 20): Promise<number> {
  // 防呆：非法或 <1 一律钳到 1——快照是还原底线，不允许配置成"一个不留"
  keep = Number.isFinite(keep) ? Math.max(1, Math.floor(keep)) : 20
  const root = path.join(backupsDir(), harness)
  let entries: string[]
  try {
    entries = (await fsp.readdir(root)).filter((e) => !e.startsWith('.'))
  } catch {
    return 0
  }
  const valid = new Set((await listSnapshots(harness)).map((m) => m.id))
  let removed = 0
  for (const e of entries) {
    if (!valid.has(e)) {
      await fsp.rm(path.join(root, e), { recursive: true, force: true }).catch(() => {})
      removed++
    }
  }
  const all = await listSnapshots(harness)
  for (let i = keep; i < all.length; i++) {
    await fsp.rm(path.join(root, all[i].id), { recursive: true, force: true }).catch(() => {})
    removed++
  }
  return removed
}

/** 文件与快照内容是否一致（detach/restore 校验用） */
export async function matchesSnapshot(manifest: SnapshotManifest): Promise<boolean> {
  for (const rec of manifest.files) {
    if (!rec.stored_as) {
      try {
        await fsp.access(rec.path)
        return false // 快照记录为不存在，但现在存在
      } catch {
        continue
      }
    }
    try {
      if ((await fileSha256(rec.path)) !== rec.sha256) return false
    } catch {
      return false
    }
  }
  return true
}
