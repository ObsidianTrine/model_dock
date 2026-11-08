/**
 * 更新预取 staging（单版本槽，docs/design-auto-update.md 预取节）：发现新版本后网关后台把
 * 适配安装包预下载到 ~/.modeldock/updates/staging/<version>/<asset>，下载完成且 SHA256 校验
 * 通过后置 ready；一键更新（update --yes / Web apply，同走 runUpdate）复用就绪包跳过下载段。
 *
 * 设计要点（评审定案）：
 * - meta.json 是槽位账本（atomicWrite）；下载半成品一律 `<asset>.part`，完成+校验通过后 rename
 *   成 `<asset>`——文件名本身携带完整性语义，进程死在任意点都不会把半成品当成品。
 * - SUMS 不落盘（完整性锚点永走官方 API，盘上副本无安全价值）；meta 只记 sumsVerified。
 * - apply 成功只标 consumed，从不同步删除——win-setup 的 Inno 安装器异步读 staging 里的
 *   setup.exe 而 updater 进程先退；删除统一延迟到 sweep（网关启动 / runUpdate 开头 / 换槽）。
 * - 续传起点以 .part 实际字节数为准，meta 仅辅助。
 */
import fsp from 'node:fs/promises'
import { atomicWrite, readTextIfExists } from '../util/fsx.js'
import { updatesStagingDir } from '../util/paths.js'

export interface StagingMeta {
  version: string
  tagName: string
  assetName: string
  assetId: number
  /** 资产总字节数（manifest 口径；完整性断言基线） */
  size: number
  /** 首段响应 ETag（下次续传作 If-Range） */
  etag: string | null
  /** 当前候选 URL（续传仅同候选内进行） */
  url: string | null
  /** 已落盘字节数（下载中 = .part 大小；ready = size） */
  received: number
  /** 官方 SUMS 已拉取且 SHA256 校验通过（apply 时仍会现拉 SUMS 重验——纵深防御） */
  sumsVerified: boolean
  ready: boolean
  /** 已被某次安装使用；等待 sweep 清理（从不同步删除，win-setup 存活期） */
  consumed: boolean
  error: string | null
  startedAt: number
  updatedAt: number
}

/** staging 残留判定：updatedAt 早于该值（7 天）即使未 consumed 也清——预取中断后无人续的残骸 */
export const STAGING_MAX_AGE_MS = 7 * 24 * 3600_000

export function stagingMetaPath(): string {
  return `${updatesStagingDir()}/meta.json`
}

export function stagingSlotDir(version: string): string {
  return `${updatesStagingDir()}/${version}`
}

export function stagingPartFile(version: string, assetName: string): string {
  return `${updatesStagingDir()}/${version}/${assetName}.part`
}

export function stagingFinalFile(version: string, assetName: string): string {
  return `${updatesStagingDir()}/${version}/${assetName}`
}

/** 读槽位账本：缺失/损坏返回 null（调用方按无槽处理，sweep 会收走残骸） */
export async function readStagingMeta(): Promise<StagingMeta | null> {
  const text = await readTextIfExists(stagingMetaPath())
  if (!text) return null
  try {
    const m = JSON.parse(text) as StagingMeta
    if (!m || typeof m.version !== 'string' || typeof m.assetName !== 'string') return null
    return m
  } catch {
    return null
  }
}

/** 写槽位账本（atomicWrite + 刷 updatedAt）。调用方对高频进度自行节流（prefetch 内 3s 合并） */
export async function saveStagingMeta(meta: StagingMeta): Promise<void> {
  meta.updatedAt = Date.now()
  await atomicWrite(stagingMetaPath(), JSON.stringify(meta, null, 2) + '\n', 0o600)
}

/** 清整个 staging（换槽 / sweep 命中）。EBUSY/EPERM 容忍重试（Windows 文件占用），仍失败留给下轮 */
export async function clearStaging(): Promise<void> {
  await fsp.rm(updatesStagingDir(), { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {})
}

/** 清理消费过 / 账本损坏 / 到龄的 staging；在途预取（meta 新鲜且未 consumed）绝不动。
 *  调用时机：网关启动 / runUpdate 开头（持更新锁）/ 预取换槽。 */
export async function sweepStaging(): Promise<void> {
  const meta = await readStagingMeta()
  if (!meta) {
    // 无有效账本但目录有残骸（meta 被删/写坏）：一并清；与预取建槽的竞态窗口毫秒级，
    // 最坏情况是预取半成品被收走重下，无正确性影响
    await clearStaging()
    return
  }
  if (meta.consumed || Date.now() - meta.updatedAt > STAGING_MAX_AGE_MS) await clearStaging()
}

/** 安装成功后标记槽位已消费（runUpdate 校验通过后调用；从不同步删除——win-setup 存活期）。
 *  version 不匹配时不动（预取已换槽，账本归新槽所有）。 */
export async function markStagingConsumed(version: string): Promise<void> {
  const meta = await readStagingMeta()
  if (!meta || meta.consumed || meta.version !== version) return
  meta.consumed = true
  await saveStagingMeta(meta).catch(() => {})
}

/** 取可复用的就绪包：ready && 未消费 && 版本/资产名匹配 && 成品文件在且尺寸对。 */
export async function readReadyStaged(version: string, assetName: string): Promise<{ file: string } | null> {
  const meta = await readStagingMeta()
  if (!meta || meta.consumed || !meta.ready) return null
  if (meta.version !== version || meta.assetName !== assetName) return null
  const file = stagingFinalFile(version, assetName)
  const st = await fsp.stat(file).catch(() => null)
  if (!st || !st.isFile()) return null
  if (meta.size > 0 && st.size !== meta.size) return null
  return { file }
}
