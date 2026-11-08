/**
 * 更新预取编排（docs/design-auto-update.md 预取节）：发现新版本后网关后台静默预下载+校验
 * 适配安装包到 staging，一键更新点击时只剩秒级「SUMS 现拉 + 本地重 hash + 替换」。
 *
 * 守卫链（任一命中静默跳过——预取是加速器不是依赖，失败一律降级回「点击后现下」）：
 * - MODELRDOCK_DISABLE_UPDATE_CHECK=1 → 预取一并禁用
 * - manifest 不高于当前版本 / 发布不适配本机 → 无目标
 * - 开发态（execPath basename 以 node 开头，同 run.ts 守卫）→ 禁
 * - 测试/agent 上下文 + 数据源非本地 mock → 禁（防测试真网流量；apiBase 注入的本地 mock 不受限）
 * - update.lock 被存活进程持有（runUpdate 在跑）→ 本轮让路
 * - 单飞：inflight 全局一份（占位在同步前缀，并发触发被挡）
 * - 失败 30min 退避：重启后从 meta.updatedAt 恢复退避窗；自动重试驱动 = 60s status 轮询 + 启动
 *
 * 进度记账：meta.json 节流写（3s 合并，终态立即）——进度绝不进 gateway.json（防写风暴）、
 * 不写 update-progress.json（那是「安装中」专用，避免托盘把预取误显示成更新中）。
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import { VERSION } from '../version.js'
import { DEFAULT_UPDATE_MIRRORS } from '../config/types.js'
import { inTestContext } from '../util/fsx.js'
import { resolveUpdateProxyUrl } from '../util/sysproxy.js'
import { compareVersions, downloadAsset, fetchChecksums, findAsset, selectAssetName, verifyChecksum, type ReleaseManifest } from './check.js'
import { detectInstallShape, hasWindowsUninstaller } from './install.js'
import { updateLockHeld } from './lock.js'
import { readStagingMeta, saveStagingMeta, stagingFinalFile, stagingPartFile, stagingSlotDir, clearStaging, type StagingMeta } from './staging.js'

/** 预取失败后的重试退避：失败不该占满 24h 检查窗口（否则断网一次要隔天才能续传） */
export const PREFETCH_FAIL_RETRY_MS = 30 * 60_000

/** status 载荷里的预取态（GET /admin/update/status 透传；consumed 槽位不透出） */
export interface StagedStatus {
  version: string
  ready: boolean
  received: number
  total: number
  error: string | null
}

export interface PrefetchOpts {
  repo: string
  token: string | null
  /** 测试注入缝隙：注入即本地 mock，绝不代理（与 run.ts/checkUpdate 同口径） */
  apiBase?: string
  mirrors?: string[]
  manifest: ReleaseManifest
}

let inflight: Promise<void> | null = null
let lastFailAt = 0
let lastFailVersion: string | null = null

/** meta.json 进度节流（字节进度 3s 合并；初始/就绪/失败等终态直接 saveStagingMeta 不走此路） */
let lastMetaSave = 0
const META_SAVE_INTERVAL_MS = 3000

async function saveMetaThrottled(meta: StagingMeta): Promise<void> {
  const now = Date.now()
  if (now - lastMetaSave < META_SAVE_INTERVAL_MS) return
  lastMetaSave = now
  await saveStagingMeta(meta).catch(() => {})
}

/** 读预取态（status 载荷用）：无槽位 / 已消费返回 null */
export async function getStagedStatus(): Promise<StagedStatus | null> {
  const meta = await readStagingMeta()
  if (!meta || meta.consumed) return null
  return { version: meta.version, ready: meta.ready, received: meta.received, total: meta.size, error: meta.error }
}

/** 触发一次预取（fire-and-forget）：守卫链内命中即静默跳过；绝不外抛。 */
export function maybeStartPrefetch(opts: PrefetchOpts): void {
  if (inflight) return
  const p = (async () => {
    try {
      await runPrefetch(opts)
    } catch {
      /* 静默：失败已记进 meta.error，预取绝不影响检查/更新主流程 */
    } finally {
      inflight = null
    }
  })()
  inflight = p
}

/** 测试专用：清模块级状态（单飞/退避/节流跨用例泄漏会让守卫误判） */
export function resetPrefetchStateForTests(): void {
  inflight = null
  lastFailAt = 0
  lastFailVersion = null
  lastMetaSave = 0
}

/** 测试专用：注入失败退避时间戳（免真实等待 30min） */
export function setPrefetchFailAtForTests(at: number, version: string): void {
  lastFailAt = at
  lastFailVersion = version
}

async function runPrefetch(opts: PrefetchOpts): Promise<void> {
  const m = opts.manifest
  if (process.env.MODELRDOCK_DISABLE_UPDATE_CHECK === '1') return
  if (compareVersions(m.version, VERSION) <= 0) return
  // 安装形态与资产选择（第三/四参同 run.ts 口径：LOCALAPPDATA 显式传、win 查卸载器指纹）
  const shape = detectInstallShape(
    process.execPath,
    process.platform,
    process.env.LOCALAPPDATA,
    process.platform === 'win32' ? hasWindowsUninstaller(process.execPath) : false
  )
  // 开发态守卫（同 run.ts）：tsx/npm 态 execPath 是 node 运行时，资产选择无意义
  if ((shape === 'bare' || shape === 'win-bare') && path.basename(process.execPath).toLowerCase().startsWith('node')) return
  if (inTestContext() && !opts.apiBase) return
  const assetName = selectAssetName(shape, process.platform, process.arch, m.version)
  const asset = assetName ? findAsset(m, assetName) : null
  if (!assetName || !asset) return
  if (updateLockHeld()) return
  const prev = await readStagingMeta()
  if (prev && prev.version === m.version && prev.ready && !prev.consumed) {
    // ready 槽位仍要验成品文件在（apply 侧校验失败会删文件/盘上被清）——不在则落回本轮重跑自愈
    const st = await fsp.stat(stagingFinalFile(m.version, prev.assetName)).catch(() => null)
    if (st && st.isFile() && (prev.size <= 0 || st.size === prev.size)) return
  }
  // 失败退避：优先模块内记忆，重启后回落 meta.updatedAt（带 error 的槽位）
  const failAt = lastFailVersion === m.version && lastFailAt ? lastFailAt : prev && prev.version === m.version && prev.error ? prev.updatedAt : 0
  if (failAt && Date.now() - failAt < PREFETCH_FAIL_RETRY_MS) return
  // 换槽：版本变了清旧槽（residual 残骸由 sweep 兜底）
  if (!prev || prev.version !== m.version) await clearStaging()

  const partFile = stagingPartFile(m.version, assetName)
  const finalFile = stagingFinalFile(m.version, assetName)
  const sameSlot = !!prev && prev.version === m.version && prev.assetName === assetName
  const meta: StagingMeta = {
    version: m.version,
    tagName: m.tagName,
    assetName,
    assetId: asset.id,
    size: asset.size,
    etag: sameSlot ? prev.etag : null,
    url: sameSlot ? prev.url : null,
    received: sameSlot ? prev.received : 0,
    sumsVerified: false,
    ready: false,
    consumed: false,
    error: null,
    startedAt: sameSlot ? prev.startedAt : Date.now(),
    updatedAt: Date.now(),
  }
  lastMetaSave = Date.now()
  await saveStagingMeta(meta)
  const proxyUrl = opts.apiBase ? null : await resolveUpdateProxyUrl()
  try {
    // 成品已在且尺寸对（上轮 rename 后、校验/记账前进程死）：跳过下载直接校验
    const finalStat = await fsp.stat(finalFile).catch(() => null)
    const finalOk = !!finalStat && finalStat.isFile() && (meta.size <= 0 || finalStat.size === meta.size)
    if (!finalOk) {
      // .part 现状校准：实际字节数为准，meta 仅辅助
      const partStat = await fsp.stat(partFile).catch(() => null)
      const partBytes = partStat?.size ?? 0
      if (partBytes !== meta.received) {
        meta.received = partBytes
        if (meta.size > 0 && partBytes > meta.size) {
          // 半成品超过资产尺寸 = 残骸：清掉重下（Range 起点已越界，硬发必 416）
          await fsp.rm(partFile, { force: true }).catch(() => {})
          meta.received = 0
          meta.url = null
          meta.etag = null
        }
        await saveStagingMeta(meta)
      }
      if (!(meta.size > 0 && meta.received >= meta.size)) {
        // 半成品未满尺寸：走候选链下载（同候选 Range 续传；换候选自动从 0）
        await downloadAsset(opts.repo, opts.token, asset, stagingSlotDir(m.version), {
          apiBase: opts.apiBase,
          mirrors: opts.mirrors ?? DEFAULT_UPDATE_MIRRORS,
          proxyUrl,
          destName: `${assetName}.part`,
          resume: {
            state: meta.received > 0 ? { url: meta.url, etag: meta.etag, partBytes: meta.received } : null,
            onState: (s) => {
              meta.url = s.url
              meta.etag = s.etag
              meta.received = s.partBytes
              void saveMetaThrottled(meta)
            },
          },
        })
      }
      // .part → 成品（文件名携带完整性语义；Windows rename 目标存在会失败，先清残骸）
      await fsp.rm(finalFile, { force: true }).catch(() => {})
      await fsp.rename(partFile, finalFile)
    }
    meta.received = meta.size
    // SUMS 永远现拉官方（完整性锚点不过磁盘缓存）+ 本地重 hash：staging 在盘上可能被改/腐坏
    const sums = await fetchChecksums(opts.repo, opts.token, m, { apiBase: opts.apiBase, proxyUrl })
    await verifyChecksum(finalFile, sums)
    meta.sumsVerified = true
    meta.ready = true
    meta.error = null
    lastFailAt = 0
    await saveStagingMeta(meta)
  } catch (e) {
    meta.error = (e as Error).message
    lastFailAt = Date.now()
    lastFailVersion = m.version
    await saveStagingMeta(meta).catch(() => {})
  }
}
