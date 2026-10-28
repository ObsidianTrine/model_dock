import fs from 'node:fs'
import path from 'node:path'
import { atomicWrite } from '../util/fsx.js'
import { t } from '../util/i18n.js'
import { expandHome, homeDir } from '../util/paths.js'

/**
 * 文本资产跨机同步（白名单目录）：用户把自建 skills / 全局记忆 / AGENTS.md 这类"一个目录"
 * 加入白名单后，目录内的文本文件随 syncdoc 跨机收敛。
 * 边界：只收敛白名单内的文本；远端有的本机没有 → 写入，内容一致 → 跳过，本机多出的 → 绝不删除；
 * env 值/密钥文件不入包（~/.modeldock 整体排除）；二进制一律跳过。
 */

/** 上限（超限抛可操作报错，拒绝导出/应用） */
export const ASSET_MAX_FILE_BYTES = 512 * 1024
export const ASSET_MAX_TOTAL_BYTES = 4 * 1024 * 1024
export const ASSET_MAX_FILES = 200

/** 白名单目录内的排除段：ModelDock 自身数据（含 secrets）绝不入包；node_modules 体量失控且非资产 */
const ASSET_EXCLUDED_SEGMENTS = new Set(['.modeldock', 'node_modules'])

/** 资产 key（家目录相对 POSIX 路径）是否安全：相对、无盘符、无反斜杠与 .. / 空段，排除段拒绝。
 *  纯字符串判定（不触 fs），validateSyncdoc 与 applyAssets 共用。 */
export function isSafeAssetKey(key: unknown): key is string {
  if (typeof key !== 'string' || key === '') return false
  if (key.startsWith('/') || key.includes('\\') || /^[a-zA-Z]:/.test(key)) return false
  for (const seg of key.split('/')) {
    if (seg === '' || seg === '.' || seg === '..') return false
    if (ASSET_EXCLUDED_SEGMENTS.has(seg.toLowerCase())) return false
  }
  return true
}

/** 把用户输入的目录归一化为家目录相对 POSIX 路径（~/x、绝对路径、~\x 都收）；
 *  不在 home 内或不是目录则抛可操作报错。 */
export function normalizeAssetDir(input: string): string {
  const abs = path.resolve(expandHome(input.trim()))
  const home = path.resolve(homeDir())
  const rel = path.relative(home, abs)
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(t('目录必须在 home 目录内：{d}', 'The directory must be inside the home directory: {d}', { d: abs }))
  }
  const relPosix = rel.split(path.sep).join('/')
  for (const seg of relPosix.split('/')) {
    if (ASSET_EXCLUDED_SEGMENTS.has(seg.toLowerCase())) {
      throw new Error(t('目录「{seg}」不参与资产同步（ModelDock 数据与依赖目录不入包）', 'The "{seg}" segment is excluded from asset sync (ModelDock data and dependency dirs are never packaged)', { seg }))
    }
  }
  return relPosix
}

/** key → 本机绝对路径；不安全 key 返回 null（调用方拒绝） */
export function assetKeyToPath(key: string): string | null {
  if (!isSafeAssetKey(key)) return null
  return path.join(path.resolve(homeDir()), ...key.split('/'))
}

export interface AssetCollect {
  /** 家目录相对 POSIX 路径 → 文件内容 */
  files: Record<string, string>
  /** 跳过的二进制/超限文件（相对路径清单） */
  skipped: string[]
}

function walkAssets(dir: string, home: string, out: AssetCollect, totals: { bytes: number }): void {
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  for (const ent of entries) {
    // 符号链接一律不跟随（目录软链可能指向 home 之外；文件软链指向的内容不受用户白名单本意约束）
    if (ent.isSymbolicLink()) continue
    const full = path.join(dir, ent.name)
    if (ent.isDirectory()) {
      if (ASSET_EXCLUDED_SEGMENTS.has(ent.name.toLowerCase())) continue
      walkAssets(full, home, out, totals)
      continue
    }
    if (!ent.isFile()) continue
    const relPosix = path.relative(home, full).split(path.sep).join('/')
    let st: fs.Stats
    try {
      st = fs.statSync(full)
    } catch {
      continue
    }
    if (st.size > ASSET_MAX_FILE_BYTES) {
      out.skipped.push(relPosix)
      continue
    }
    if (totals.bytes + st.size > ASSET_MAX_TOTAL_BYTES || Object.keys(out.files).length >= ASSET_MAX_FILES) {
      throw new Error(
        t(
          '文本资产超出同步上限（总量 {max}MB / {n} 个文件）：请缩减白名单目录或调小目录',
          'Text assets exceed the sync limits ({max}MB / {n} files): shrink the whitelisted directories',
          { max: ASSET_MAX_TOTAL_BYTES / (1024 * 1024), n: ASSET_MAX_FILES }
        )
      )
    }
    const buf = fs.readFileSync(full)
    if (buf.includes(0)) {
      // 二进制（含 NUL）不入包
      out.skipped.push(relPosix)
      continue
    }
    totals.bytes += st.size
    out.files[relPosix] = buf.toString('utf8')
  }
}

/** 收集白名单目录内的文本资产。目录不存在视为空（正常：另一台机器同步后才出现）；上限超限抛错。 */
export function collectAssetFiles(dirs: string[]): AssetCollect {
  const out: AssetCollect = { files: {}, skipped: [] }
  const totals = { bytes: 0 }
  const home = path.resolve(homeDir())
  for (const dir of dirs) {
    // 白名单条目本身先过安全校验：手写 config.toml 可能塞进 '../x' 之类的逃逸路径——
    // 收集侧直接给出可操作报错（否则包里会出现对端校验必拒的 key，报错远离根因）
    if (!isSafeAssetKey(dir)) {
      throw new Error(
        t(
          'config.toml sync_assets.dirs 含非法目录「{d}」：必须是 home 内的相对路径（不含 .. 与反斜杠）',
          'config.toml sync_assets.dirs contains an invalid directory "{d}": must be a home-relative path (no ".." or backslashes)',
          { d: dir }
        )
      )
    }
    const abs = path.join(home, ...dir.split('/'))
    if (!fs.existsSync(abs)) continue
    try {
      walkAssets(abs, home, out, totals)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EACCES' || (e as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw e
    }
  }
  return out
}

export interface AssetApply {
  /** 实际写入的文件（家目录相对路径） */
  written: string[]
  /** 内容一致未写入的数量 */
  unchanged: number
}

/** 应用远端资产：先全量校验（key 安全 + 上限），再对有差异的文件原子写入；绝不删除本机多出的文件。 */
export async function applyAssets(files: Record<string, string>): Promise<AssetApply> {
  const keys = Object.keys(files)
  for (const key of keys) {
    if (!isSafeAssetKey(key)) {
      throw new Error(t('同步包含不安全的资产路径「{k}」，已拒绝应用', 'The sync package contains an unsafe asset path "{k}"; apply refused', { k: key }))
    }
    if (Buffer.byteLength(files[key], 'utf8') > ASSET_MAX_FILE_BYTES) {
      throw new Error(t('资产文件「{k}」超过单文件上限 {n}KB，已拒绝应用', 'Asset file "{k}" exceeds the {n}KB per-file limit; apply refused', { k: key, n: Math.round(ASSET_MAX_FILE_BYTES / 1024) }))
    }
  }
  if (keys.length > ASSET_MAX_FILES) {
    throw new Error(t('同步包含 {n} 个资产文件，超过上限 {max}，已拒绝应用', 'The sync package has {n} asset files, over the {max} limit; apply refused', { n: keys.length, max: ASSET_MAX_FILES }))
  }
  let total = 0
  for (const key of keys) total += Buffer.byteLength(files[key], 'utf8')
  if (total > ASSET_MAX_TOTAL_BYTES) {
    throw new Error(t('同步包资产总量超过上限 {max}MB，已拒绝应用', 'The sync package assets exceed the {max}MB total limit; apply refused', { max: ASSET_MAX_TOTAL_BYTES / (1024 * 1024) }))
  }
  const written: string[] = []
  let unchanged = 0
  for (const key of keys) {
    const p = assetKeyToPath(key)!
    let current: string | null = null
    try {
      current = fs.readFileSync(p, 'utf8')
    } catch {
      current = null
    }
    if (current === files[key]) {
      unchanged++
      continue
    }
    fs.mkdirSync(path.dirname(p), { recursive: true })
    await atomicWrite(p, files[key], 0o600)
    written.push(key)
  }
  return { written, unchanged }
}

/** 应用前快照清单：包内资产中已存在于本机的路径（snapshot 只收存在的文件） */
export function existingAssetPaths(files: Record<string, string>): string[] {
  const paths: string[] = []
  for (const key of Object.keys(files)) {
    const p = assetKeyToPath(key)
    if (p && fs.existsSync(p)) paths.push(p)
  }
  return paths
}
