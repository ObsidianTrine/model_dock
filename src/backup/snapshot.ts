import fsp from 'node:fs/promises'
import path from 'node:path'
import { backupsDir } from '../util/paths.js'
import { atomicWrite, ensureDir, fileMode, fileSha256, sha256 } from '../util/fsx.js'
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

/** 半成品占位标记：snapshot 目录建好后先落此文件、manifest 写盘后移除。pruneSnapshots 见到
 *  新鲜占位即视为他进程正在写，宽限期内不动（CORRECT-02）。 */
const INCOMPLETE_MARKER = '.incomplete'
/** 占位超龄阈值：写入方崩溃后的残留目录，超龄后允许清理兜底 */
const ORPHAN_GRACE_MS = 10 * 60_000

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
  await ensureDir(root, 0o700)
  // id 冲突：旧实现对叶子目录 recursive mkdir——已存在时不抛错，重试永不触发（死代码），真撞 id
  // （同秒同随机段，概率≈0）会静默共用目录互踩。改为非 recursive mkdir：叶子已存在即 EEXIST
  // （跨进程原子判定），撞了换随机后缀重试。
  let dir = ''
  let id = ''
  for (let attempt = 0; attempt < 3; attempt++) {
    id = `${stamp()}-${operation}-${Math.random().toString(36).slice(2, 8)}`
    dir = path.join(root, id)
    try {
      await fsp.mkdir(dir)
      break
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code !== 'EEXIST') throw e
      dir = ''
    }
  }
  if (!dir) {
    throw new Error(t('快照目录 id 连续 3 次冲突（{root}），请重试', 'Snapshot directory id collided 3 times in a row ({root}); please retry', { root }))
  }
  // 半成品占位：pruneSnapshots 以「有合法 manifest」为 valid 判据，跨进程并发时（网关
  // pickerSync/attach 与 CLI 同时写快照）会把他进程「已开写、未写 manifest」的目录当孤儿整删
  // （CORRECT-02）。先落占位、manifest 落盘后移除。
  const marker = path.join(dir, INCOMPLETE_MARKER)
  await fsp.writeFile(marker, '', { mode: 0o600 })
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
  // manifest 已落盘、目录自洽，撤掉占位（force：撤除失败不致命——prune 按占位 mtime 宽限，不会误删）
  await fsp.rm(marker, { force: true }).catch(() => {})
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
    // 与 engine.applyChanges 同规：tmp+rename 原子写——还原是用户最脆弱的时刻，就地截断重写
    // 遇中途断电/崩溃会留下半截客户端配置（快照 blob 完好可再还原，但一次成功还原不该有此风险）
    await atomicWrite(rec.path, buf, rec.mode)
  }
}

/** 每个 harness 滚动保留 keep 份；孤儿目录（无合法 manifest，可能含敏感文件副本）一律清理——
 *  唯独带新鲜 .incomplete 占位的除外：那是他进程「已开写、未写 manifest」的半成品（CORRECT-02），
 *  删了会让对方 applyChanges 假失败。占位超龄（>10min，兜底写入方崩溃残留）或无占位（旧版本
 *  残留半成品）才清。 */
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
  // listSnapshots 只调一次：清理孤儿（无合法 manifest 的目录）不会改变合法快照集合，
  // 修剪 keep 之外的最旧份直接复用同一份列表（此前每次写快照把备份目录 manifest 全量读两遍）
  const manifests = await listSnapshots(harness)
  const valid = new Set(manifests.map((m) => m.id))
  let removed = 0
  for (const e of entries) {
    if (!valid.has(e)) {
      const target = path.join(root, e)
      try {
        const st = await fsp.stat(path.join(target, INCOMPLETE_MARKER))
        if (Date.now() - st.mtimeMs < ORPHAN_GRACE_MS) continue // 他进程正在写，宽限期内不动
      } catch {
        /* 无占位：旧版本半成品或占位写盘前崩溃，维持删除 */
      }
      await fsp.rm(target, { recursive: true, force: true }).catch(() => {})
      removed++
    }
  }
  for (let i = keep; i < manifests.length; i++) {
    await fsp.rm(path.join(root, manifests[i].id), { recursive: true, force: true }).catch(() => {})
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
