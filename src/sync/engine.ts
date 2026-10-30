/**
 * 同步引擎（docs/design-cloud-sync.md §6.2/§7.4-7.5）：推送/拉取/冲突(D6) + 轮询 + 本地变更即时推(防抖 3s)。
 * target 模式 120s±30%；cloud 模式 60s±20%（心跳兼轮询，D4 分钟级语义）并在 tick 内做 desired 应用。
 * 网关进程内挂载（remountSyncEngine）；CLI status/overview 只读 syncStatus()。
 * 关键不变式：lastSyncedHash = 本机最近一次推/拉后的可同步态指纹——tick 据此区分「本地有未推改动」与「远端有新版本」，
 * 两者同时成立 → D6 冲突（远端胜、本地待推内容快照后丢弃，绝不自动合并）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { request } from 'undici'
import { applySyncdoc, collectSyncdoc } from './collect.js'
import { openWithKeys, sealWithKeys } from './crypto.js'
import { createTarget, hashDoc, keysFromState, targetFromState } from './runtime.js'
import { blobRefOf } from './targets/types.js'
import { loadConfig, configLockPath } from '../config/store.js'
import { withFileLock } from '../util/fsx.js'
import { readSyncState, updateSyncState, type SyncState } from './state.js'
import { validateSyncdoc, type Syncdoc } from './types.js'
import { VERSION } from '../version.js'
import { atomicWrite } from '../util/fsx.js'
import { backupsDir, displayPath, modeldockDir } from '../util/paths.js'
import { t } from '../util/i18n.js'

export const DEFAULT_POLL_MS = 120_000
export const DEFAULT_DEBOUNCE_MS = 3_000
/** cloud 模式轮询（=心跳周期，D4：分钟级生效） */
export const CLOUD_POLL_MS = 60_000
const CLOUD_TIMEOUT_MS = 10_000

export interface SyncHooks {
  log?: (line: string) => void
  /** cloud 模式 desired 应用回调（网关注入：switchToService + reloadRuntime） */
  applySwitch?: (serviceId: string) => Promise<void>
}

export type TickOutcome = 'pushed' | 'pulled' | 'conflict' | 'idle' | 'skipped'

function syncModeReady(state: SyncState | null): boolean {
  if (!state || state.paused || !state.key) return false
  if (state.mode === 'target') return !!state.target
  if (state.mode === 'cloud') return !!state.cloud
  return false
}

/** tick 期间 home 稳定性校验：env 被切走（测试收尾 restoreHomes）后，在飞 tick 的后续写盘
 *  （apply 改 config、updateSyncState 簿记）会按「当时的」home 解析路径——入口钉扎检查管不住
 *  已开始的 tick，写盘前再校验一次才闭环。抛错走 safeSyncTick 的记账/跳过路径。 */
function assertStableHome(homeAtStart: string): void {
  if (modeldockDir() === homeAtStart) return
  throw new Error(
    t(
      '[modeldock] 同步 tick 期间 home 已变化（{a} → {b}）：中止本 tick，防止配置与簿记写错 home',
      '[modeldock] Home changed mid-tick ({a} → {b}): aborting this tick to avoid writing the wrong home',
      { a: displayPath(homeAtStart), b: displayPath(modeldockDir()) }
    )
  )
}

/** 单次 tick（读 sync.json → 比对 manifest → 拉取或推送；cloud 模式附带心跳与 desired 应用）。状态不满足返回 'skipped' */
export async function syncTickOnce(opts?: SyncHooks): Promise<TickOutcome> {
  const homeAtStart = modeldockDir()
  const state = await readSyncState()
  if (!syncModeReady(state) || !state) return 'skipped'
  const keys = keysFromState(state)
  const target = targetFromState(state)
  const now = new Date().toISOString()

  // cloud 模式先心跳：上报当前激活服务 + 取回云端 desired（状态机应用，详设 §7.4）；随后做文档同步
  if (state.mode === 'cloud' && state.cloud) {
    await cloudHeartbeat(state, opts)
  }
  const manifest = await target.readManifest()
  const { doc: localDoc } = await collectSyncdoc()
  const localHash = hashDoc(localDoc)

  if (manifest && manifest.rev > state.lastAppliedRev) {
    // 远端有新版本。本地同时有未推改动 → D6 冲突：本地待推内容快照后由远端覆盖。
    // readBlob/解密（网络 + KDF，最长 15s）留在锁外，不拉长持锁时间
    const envText = await target.readBlob(manifest.blobRef)
    let remoteDoc: Syncdoc
    try {
      remoteDoc = openWithKeys(JSON.parse(envText), keys)
    } catch (e) {
      throw new Error(
        t('拉取失败：解不开最新同步包（{msg}）。可能其他机器更换了同步口令，请在本机重跑 modeldock sync setup', 'Pull failed: cannot open the latest package ({msg}). The passphrase may have been changed on another machine; run modeldock sync setup again on this machine', { msg: (e as Error).message })
      )
    }
    // CORRECT-06 原子化：冲突判定、本地待推快照、apply、post-apply 基线重收集整段对 config 写锁
    // 原子化。并发本地写只能排在锁后——任何一段不进锁都有同型静默丢失窗口：改动落在「判定收集」
    // 与「快照落盘」之间 → 被远端覆盖且不留快照；落在「apply 落盘」与「基线重收集」之间 → 被计入
    // lastSyncedHash，此后 tick 判 idle，既不推送也不冲突。持锁期间 collectSyncdoc 的密钥解析
    // （file 后端读盘 / keychain 后端可能 spawn）也在锁内，极端时延后并发 config 写毫秒级——
    // tick 分钟级一次可接受。withFileLock 同路径重入内联（AsyncLocalStorage 识别持有者调用树）：
    // applySyncdoc 内部的 mutateConfig 不会自锁死。
    assertStableHome(homeAtStart)
    let conflict = false
    let afterHash = ''
    await withFileLock(configLockPath(), undefined, async () => {
      const { doc: localNow } = await collectSyncdoc()
      conflict = hashDoc(localNow) !== state.lastSyncedHash
      if (conflict) {
        const file = path.join(backupsDir(), `sync-conflict-${Date.now()}.json`)
        await atomicWrite(file, JSON.stringify(localNow, null, 2) + '\n', 0o600)
        opts?.log?.(t('[modeldock] 配置同步冲突：本机改动已快照到 {file}，已应用其他机器的最新配置（不做自动合并，差异请在任一机器重做）', '[modeldock] Config sync conflict: local changes were snapshotted to {file}; the latest config from another machine was applied (no auto-merge — redo the differences on either machine)', { file: displayPath(file) }))
      }
      await applySyncdoc(validateSyncdoc(remoteDoc))
      const { doc: after } = await collectSyncdoc()
      afterHash = hashDoc(after)
    })
    await updateSyncState({
      lastAppliedRev: manifest.rev,
      lastAppliedTs: manifest.ts,
      lastSyncedHash: afterHash,
      lastPullTs: now,
      lastError: null,
      ...(conflict ? { lastConflictTs: now } : {}),
    })
    if (!conflict) {
      opts?.log?.(t('[modeldock] 配置已从其他机器同步更新（第 {rev} 版）', '[modeldock] Config synced from another machine (rev {rev})', { rev: manifest.rev }))
    }
    return conflict ? 'conflict' : 'pulled'
  }

  if (localHash !== state.lastSyncedHash) {
    assertStableHome(homeAtStart) // 推送写盘（blob/manifest 本身 home 无关，但随后的簿记 updateSyncState 按当前 home 落盘）
    const baseRev = manifest?.rev ?? 0
    const rev = baseRev + 1
    const sealed = sealWithKeys(localDoc, keys)
    await target.writeBlob(rev, state.devid, JSON.stringify(sealed, null, 2) + '\n')
    const r = await target.writeManifest({ rev, ts: localDoc.ts, byDevid: state.devid, blobRef: blobRefOf(rev, state.devid) }, baseRev)
    if (r === 'conflict') {
      // 他人抢先推了新版本：不改 lastSyncedHash，下个 tick 自然走上方冲突分支
      await updateSyncState({ lastError: t('推送时发现其他机器的新版本，下个周期按冲突流程处理', 'Another machine pushed during our push; the conflict flow will run next cycle'), lastErrorTs: now })
      return 'conflict'
    }
    // 成功推送 = 用户已在收敛后的基础上继续改动，冲突提醒（lastConflictTs）随之销项
    await updateSyncState({ lastAppliedRev: rev, lastAppliedTs: localDoc.ts, lastSyncedHash: localHash, lastPushTs: now, lastError: null, lastConflictTs: null })
    opts?.log?.(t('[modeldock] 本机配置已推送到同步目标（第 {rev} 版）', '[modeldock] Local config pushed to the sync target (rev {rev})', { rev }))
    return 'pushed'
  }

  return 'idle'
}

/** 云端心跳 + desired 应用状态机（详设 §7.4）：desired_profile ≠ 当前激活 且 desired_ts > lastLocalSwitchTs 才切 */
async function cloudHeartbeat(state: SyncState, opts?: SyncHooks): Promise<void> {
  const cloud = state.cloud!
  const cfg = await loadConfig()
  const currentProvider = cfg.active_profile ? cfg.profiles[cfg.active_profile]?.provider ?? null : null
  let res
  try {
    res = await request(`${cloud.url.replace(/\/+$/, '')}/v1/heartbeat`, {
      method: 'POST',
      headers: { authorization: `Bearer ${cloud.token}`, 'content-type': 'application/json' },
      // services：本机可用服务目录（id+显示名）——云端只见密文，控制台切换下拉靠各机上报的目录并集
      body: JSON.stringify({
        devid: state.devid,
        version: VERSION,
        reportedProfile: currentProvider,
        services: Object.entries(cfg.providers)
          .filter(([, p]) => p.enabled !== false)
          .map(([id, p]) => ({ id, name: p.name ?? id })),
      }),
      signal: AbortSignal.timeout(CLOUD_TIMEOUT_MS),
    })
  } catch (e) {
    throw new Error(t('云端心跳失败（{url}）：{err}', 'Cloud heartbeat failed ({url}): {err}', { url: cloud.url, err: (e as Error).message }))
  }
  const text = await res.body.text().catch(() => '')
  if (res.statusCode !== 200) {
    throw new Error(t('云端心跳被拒（HTTP {code}）', 'Cloud heartbeat rejected (HTTP {code})', { code: res.statusCode }))
  }
  let body: { desiredProfile?: string | null; desiredTs?: string | null }
  try {
    body = JSON.parse(text || '{}')
  } catch {
    // 云端经反代可能回 200+错误页（HTML）：显式报错进 lastError、下一轮重试，不让 SyntaxError 裸穿
    throw new Error(t('云端心跳返回非 JSON（可能经反代返回了错误页）：{url}', 'Cloud heartbeat returned non-JSON (likely a reverse-proxy error page): {url}', { url: cloud.url }))
  }
  const desired = body.desiredProfile ?? null
  const desiredTs = body.desiredTs ?? null
  if (!desired || !desiredTs) return
  if (desired === currentProvider) return
  // 时间戳保护：防止云端的旧指令覆盖用户在本机更新的手动切换（本机任何切换都经 switchToService 记 lastLocalSwitchTs）
  const lastSwitchMs = state.lastLocalSwitchTs ? Date.parse(state.lastLocalSwitchTs) : 0
  // NaN <= x 恒 false：畸形 desiredTs 不显式判有限会反过来绕过本保护
  const desiredMs = Date.parse(desiredTs)
  if (!Number.isFinite(desiredMs) || desiredMs <= lastSwitchMs) return
  if (!opts?.applySwitch) return // 无应用回调（如 CLI 手动 tick）则只上报不切
  opts?.log?.(t('[modeldock] 应用云端远程切换：当前服务 → {svc}', '[modeldock] Applying remote switch from the cloud: current service → {svc}', { svc: desired }))
  // 失败只记错不外抛：desired 指向本机没有的服务（「应用到全部」下发到部分机器）时
  // switchToService 会 throw，若让它冒泡会阻断本 tick 的文档推拉，同步每 60s 永续重试不收敛
  try {
    await opts.applySwitch(desired)
  } catch (e) {
    opts?.log?.(t('[modeldock] 应用云端切换失败（不阻断文档同步）：{err}', '[modeldock] Failed to apply cloud switch (doc sync continues): {err}', { err: (e as Error).message }))
  }
}

/** 带兜底的 tick：任何错误记入 sync.json.lastError（状态行可见），绝不向上抛——同步永远不影响网关本职 */
export async function safeSyncTick(opts?: SyncHooks): Promise<TickOutcome> {
  const homeAtEntry = modeldockDir()
  try {
    return await syncTickOnce(opts)
  } catch (e) {
    // home 在 tick 期间被切走：簿记 updateSyncState 会按「当时的」home 落盘，写进另一个 home 的
    // sync.json（串场）——直接放弃记账。真实 home 写穿另由 fsx 门禁兜底。
    if (modeldockDir() !== homeAtEntry) {
      opts?.log?.(t('[modeldock] 同步 tick 期间 home 已变化，跳过错误记账', '[modeldock] Home changed mid-tick; error bookkeeping skipped'))
      return 'skipped'
    }
    const msg = (e as Error).message
    try {
      await updateSyncState({ lastError: msg, lastErrorTs: new Date().toISOString() })
    } catch {
      /* sync.json 本身不可写时只能放弃记录 */
    }
    opts?.log?.(t('[modeldock] 配置同步失败：{msg}（不影响网关工作，稍后自动重试）', '[modeldock] Config sync failed: {msg} (gateway unaffected; will retry automatically)', { msg }))
    return 'skipped'
  }
}

export interface SyncLoopOpts extends SyncHooks {
  pollMs?: number
  jitterRatio?: number
  debounceMs?: number
  /** 挂载时钉扎的 home（remountSyncEngine 注入）：每次 tick 前校验 modeldockDir() 仍是它，
   *  否则整体跳过——测试进程恢复 env 后的长尾 tick 不再把簿记/apply 写进真实 home
   *  （2026-10-05 / 2026-10-30 两次事故不变式，与 stopSyncEngine 可等待互为双保险）。
   *  直连 new SyncLoop 不带钉扎（测试自建实例，生命周期自己负责）。 */
  pinnedHome?: string
  /** 测试注入：替换 fs.watch 以触发异步 error（默认 = fs.watch）。返回值的 .on('error') 订阅必须可用 */
  watchFn?: (watchPath: string, listener: fs.WatchListener<string>) => fs.FSWatcher
}

/** 轮询 + 本地变更监听的循环。多触发源（定时/文件变更/手动）共用单飞tick，不并发推拉 */
export class SyncLoop {
  private timer: NodeJS.Timeout | undefined
  private watcher: fs.FSWatcher | undefined
  private debounce: NodeJS.Timeout | undefined
  private inflight: Promise<TickOutcome> | null = null
  /** 在飞期间又有触发到达（文件变更/手动 tick/轮询）：记一次，收尾后立即补跑一轮，
   *  否则这批改动要等下轮轮询（60/120s±抖动）才推出——上游慢时单 tick 可拖 15s，感知明显 */
  private trailing = false
  private stopped = false
  private homeMismatchLogged = false

  constructor(private opts: SyncLoopOpts = {}) {}

  /** 单飞：在飞期间所有触发源共用同一 promise。跟踪在飞是为了 stop() 能等它收尾——
   *  否则测试进程切换/清除 MODELRDOCK_FAKE_HOME 后，长尾 tick 会把簿记写进真实 home（2026-10-05 事故根因）。
   *  双保险第二层：挂载时钉扎的 home 与当前不符（env 已被切走）→ 本 tick 直接跳过，绝不写盘 */
  private beginTick(mode: 'safe' | 'raw'): Promise<TickOutcome> {
    if (this.opts.pinnedHome && modeldockDir() !== this.opts.pinnedHome) {
      if (!this.homeMismatchLogged) {
        this.homeMismatchLogged = true
        const msg = t(
          '[modeldock] 配置同步引擎的 home 已变化（挂载于 {mounted}，当前 {current}）：跳过同步防止写穿真实 home；如为本机数据目录迁移请重启网关',
          '[modeldock] Sync engine home changed (mounted at {mounted}, now {current}): sync is skipped to prevent writing into the real home; restart the gateway if you migrated the data directory',
          { mounted: displayPath(this.opts.pinnedHome), current: displayPath(modeldockDir()) }
        )
        this.opts.log?.(msg)
        console.error(msg)
      }
      return Promise.resolve('skipped')
    }
    if (this.inflight) {
      this.trailing = true
      return this.inflight
    }
    const base = mode === 'raw' ? syncTickOnce(this.opts) : safeSyncTick(this.opts)
    const wrapped = base.finally(() => {
      this.inflight = null
      // 补跑只在循环存活时进行：stop() 后绝不写盘（同上 2026-10-05 事故不变式）。
      // 补跑固定走 safe：自身 apply 的写盘经 lastSyncedHash 令下轮空转，链自然终止，不会回环推送
      if (this.trailing && !this.stopped) {
        this.trailing = false
        this.beginTick('safe').catch(() => {})
      }
    })
    this.inflight = wrapped
    return wrapped
  }

  start(): void {
    // 启动即拉取一次：加入目标的新机器立即收敛
    void this.beginTick('safe')
    this.schedulePoll()
    const watch = this.opts.watchFn ?? ((p: string, l: fs.WatchListener<string>) => fs.watch(p, l))
    try {
      this.watcher = watch(modeldockDir(), (_event, filename) => {
        // 引擎自己 apply 远端也会写这三个文件：此刻 lastSyncedHash 已更新，tick 空转跳过，不会回环推送
        if (filename !== 'config.toml' && filename !== 'secrets.json' && filename !== 'presets.json') return
        clearTimeout(this.debounce)
        this.debounce = setTimeout(() => void this.beginTick('safe'), this.opts.debounceMs ?? DEFAULT_DEBOUNCE_MS)
      })
      // watcher 同步构造不抛、但异步失败（EMFILE/ENOSPC 或目录被删）会发 'error'：
      // 不接则变成 uncaught exception 杀网关，这里挂兜底——清理引用、降级为仅轮询（只损失「即时推」）
      this.watcher.on('error', (err) => {
        this.watcher = undefined
        this.opts.log?.(t('[modeldock] 配置同步本地文件监听失效（{msg}）：不再即时推送，改为仅轮询同步（不影响网关工作）', '[modeldock] Local file watcher for config sync failed ({msg}): realtime push disabled, polling only (gateway unaffected)', { msg: (err as Error).message }))
      })
    } catch {
      /* 目录监听失败只损失「即时推」，轮询兜底 */
    }
  }

  /** 停止并等待在飞 tick 结束（此后不再有任何本循环的写盘） */
  async stop(): Promise<void> {
    this.stopped = true
    clearTimeout(this.timer)
    clearTimeout(this.debounce)
    this.watcher?.close()
    await this.inflight?.catch(() => {})
  }

  private schedulePoll(): void {
    const poll = this.opts.pollMs ?? DEFAULT_POLL_MS
    const jitter = this.opts.jitterRatio ?? 0.3
    const ms = Math.max(1_000, Math.round(poll * (1 + (Math.random() * 2 - 1) * jitter)))
    this.timer = setTimeout(() => {
      if (this.stopped) return
      void this.beginTick('safe')
      this.schedulePoll()
    }, ms)
  }

  async tick(): Promise<TickOutcome> {
    if (this.stopped) return 'skipped'
    return this.beginTick('raw')
  }
}

// 网关进程内挂载（单例）

let active: SyncLoop | null = null
let activeSig: string | null = null

function stateSignature(st: SyncState | null): string | null {
  if (!st || st.paused || !st.key) return null
  if (st.mode === 'target' && st.target) return JSON.stringify({ mode: 'target', target: st.target, devid: st.devid })
  if (st.mode === 'cloud' && st.cloud) return JSON.stringify({ mode: 'cloud', url: st.cloud.url, token: st.cloud.token, devid: st.cloud.devid })
  return null
}

async function stopLoop(): Promise<void> {
  const loop = active
  active = null
  activeSig = null
  await loop?.stop().catch(() => {})
}

/** 按 sync.json 现状挂载/摘除/重挂引擎（幂等）：签名未变则不动。网关启动与 sync.json 变更时调用 */
export async function remountSyncEngine(opts?: SyncLoopOpts): Promise<void> {
  let st: SyncState | null = null
  try {
    st = await readSyncState()
  } catch {
    await stopLoop()
    return
  }
  const sig = stateSignature(st)
  if (sig === null) {
    if (active) opts?.log?.(t('[modeldock] 配置同步已停用或暂停', '[modeldock] Config sync disabled or paused'))
    await stopLoop()
    return
  }
  if (active && activeSig === sig) return
  await stopLoop()
  // cloud 模式 60s±20%（D4 心跳节奏）；target 模式 120s±30%
  const pollMs = st?.mode === 'cloud' ? (opts?.pollMs ?? CLOUD_POLL_MS) : (opts?.pollMs ?? DEFAULT_POLL_MS)
  const jitterRatio = st?.mode === 'cloud' ? (opts?.jitterRatio ?? 0.2) : (opts?.jitterRatio ?? 0.3)
  active = new SyncLoop({ ...opts, pollMs, jitterRatio, pinnedHome: modeldockDir() })
  activeSig = sig
  active.start()
}

/** 网关退出与测试收尾调用。返回可等待的停止 promise：**测试必须在 restoreHomes/清 env 前
 *  await 它**——在飞 tick 的后续步骤按「当时的」home 解析路径，env 已切走就会写穿真实 home
 *  （2026-10-05 / 2026-10-30 两次事故根因；与 SyncLoop home 钉扎互为双保险）。
 *  网关退出路径维持 fire-and-forget（进程将退，钉扎层兜底）。 */
export function stopSyncEngine(): Promise<void> {
  return stopLoop().catch(() => {})
}

/** 测试专用：触发单例 loop 的一轮 raw tick（home 钉扎等用例观察用）；无挂载 loop 返回 null */
export function __testTickActiveSyncLoop(): Promise<TickOutcome> | null {
  return active ? active.tick() : null
}

export interface SyncStatusView {
  mode: 'off' | 'target' | 'cloud'
  paused: boolean
  running: boolean
  targetKind: string | null
  targetLabel: string | null
  devid: string | null
  lastAppliedRev: number | null
  lastPushTs: string | null
  lastPullTs: string | null
  lastError: string | null
  lastConflictTs: string | null
}

/** 状态总览（overview 端点与 CLI status 共用，只读不副作用） */
export async function syncStatus(): Promise<SyncStatusView> {
  let st: SyncState | null = null
  let corrupt: string | null = null
  try {
    st = await readSyncState()
  } catch (e) {
    corrupt = (e as Error).message
  }
  if (!st || st.mode === 'off' || (st.mode === 'target' && !st.target) || (st.mode === 'cloud' && !st.cloud)) {
    return { mode: 'off', paused: false, running: false, targetKind: null, targetLabel: null, devid: null, lastAppliedRev: null, lastPushTs: null, lastPullTs: null, lastError: corrupt ?? st?.lastError ?? null, lastConflictTs: null }
  }
  const kind = st.mode === 'cloud' ? 'cloud' : st.target!.kind
  const label =
    st.mode === 'cloud'
      ? st.cloud!.url
      : st.target!.kind === 'webdav'
        ? `${st.target!.url}${st.target!.dir ? '/' + st.target!.dir : ''}`
        : displayPath(st.target!.dir)
  return {
    mode: st.mode,
    paused: st.paused,
    running: !!active,
    targetKind: kind,
    targetLabel: label,
    devid: st.devid,
    lastAppliedRev: st.lastAppliedRev,
    lastPushTs: st.lastPushTs,
    lastPullTs: st.lastPullTs,
    lastError: corrupt ?? st.lastError,
    lastConflictTs: st.lastConflictTs,
  }
}
