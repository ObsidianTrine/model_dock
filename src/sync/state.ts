/**
 * 本机同步凭据与状态（docs/design-cloud-sync.md §4.4 的 ~/.modeldock/sync.json）。
 * 与被同步的 config.toml 分文件：凭据不能随包被同步回去。0600 atomicWrite。
 */
import os from 'node:os'
import { atomicWrite, readTextIfExists, withFileLock } from '../util/fsx.js'
import { syncJsonPath } from '../util/paths.js'
import { t } from '../util/i18n.js'

export const SYNC_STATE_VERSION = 1

export type SyncMode = 'off' | 'target' | 'cloud'

export type SyncTargetConfig =
  | { kind: 'webdav'; url: string; dir?: string; username?: string; password?: string }
  | { kind: 'localdir'; dir: string }

/** M3 云端模式凭据（详设 §4.4）：与 target 模式互斥，由 sync enroll 写入 */
export interface SyncCloudConfig {
  url: string
  devid: string
  token: string
  deviceName: string
}

/** 派生密钥材料缓存（与 secrets.json 同信任级别）：encKey/macKey 让 agent 免口令自动推拉；
 *  salt/hkdfSalt 保证信封自包含（新机器凭口令可解）；verifier 供 setup 校验口令一致性 */
export interface SyncKeyCache {
  salt: string
  hkdfSalt: string
  encKey: string
  macKey: string
  verifier: string
}

export interface SyncState {
  v: number
  mode: SyncMode
  target?: SyncTargetConfig
  /** M3 云端模式凭据（mode=cloud 时存在） */
  cloud?: SyncCloudConfig
  key?: SyncKeyCache
  devid: string
  deviceName: string
  paused: boolean
  /** 最近一次应用到本地的远端修订号（幂等锚点） */
  lastAppliedRev: number
  lastAppliedTs: string | null
  /** 最近一次推/拉后本机可同步态的内容指纹：判断「本地有无未同步改动」 */
  lastSyncedHash: string | null
  lastPushTs: string | null
  lastPullTs: string | null
  lastError: string | null
  lastErrorTs: string | null
  lastConflictTs: string | null
  /** M3 云端 desired 状态机预留（防止云端旧指令覆盖本机更新的手动切换） */
  lastLocalSwitchTs: string | null
}

export function emptySyncState(): SyncState {
  return {
    v: SYNC_STATE_VERSION,
    mode: 'off',
    devid: '',
    deviceName: os.hostname(),
    paused: false,
    lastAppliedRev: 0,
    lastAppliedTs: null,
    lastSyncedHash: null,
    lastPushTs: null,
    lastPullTs: null,
    lastError: null,
    lastErrorTs: null,
    lastConflictTs: null,
    lastLocalSwitchTs: null,
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** 读取 sync.json；文件不存在返回 null，格式错误抛可操作报错（阻断启用，不静默丢弃） */
export async function readSyncState(): Promise<SyncState | null> {
  const text = await readTextIfExists(syncJsonPath())
  if (text === null) return null
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (e) {
    throw new Error(
      t('sync.json 不是合法 JSON（{err}）：修复或删除该文件后重试（modeldock sync status 查看当前状态）', 'sync.json is not valid JSON ({err}): fix or delete the file and retry (run modeldock sync status to inspect)', { err: (e as Error).message })
    )
  }
  if (!isPlainObject(raw) || typeof raw.mode !== 'string' || !['off', 'target', 'cloud'].includes(raw.mode)) {
    throw new Error(t('sync.json 内容不完整（缺 mode 或 mode 非法）：修复或删除该文件后重试', 'sync.json is incomplete (missing or invalid mode): fix or delete the file and retry'))
  }
  if (raw.v !== SYNC_STATE_VERSION) {
    throw new Error(
      t('sync.json 版本不受支持（v={v}，当前支持 v={max}）：请升级 modeldock', 'Unsupported sync.json version (v={v}; supported: v={max}): upgrade modeldock', { v: String(raw.v ?? ''), max: SYNC_STATE_VERSION })
    )
  }
  // 缺省字段补默认：手改/旧版本文件不致崩溃
  return { ...emptySyncState(), ...(raw as object), v: SYNC_STATE_VERSION } as SyncState
}

/** sync.json 读改写跨进程锁：config.toml / secrets.json 都有锁，网关引擎 tick 与另一进程的
 *  sync setup/enroll 并发写此前是整文件互相覆盖（丢的多是簿记字段，可自愈，但语义不齐） */
function syncStateLockPath(): string {
  return syncJsonPath() + '.lock'
}

export async function writeSyncState(state: SyncState): Promise<void> {
  await withFileLock(syncStateLockPath(), undefined, async () => {
    await atomicWrite(syncJsonPath(), JSON.stringify(state, null, 2) + '\n', 0o600)
  })
}

/** 读-改-写 sync.json（仅补丁字段）。读在锁内：与网关 tick / 另一进程 setup 并发时不丢补丁。
 *  锁内直接 atomicWrite——同进程对同一锁文件再入 withFileLock 会死锁。 */
export async function updateSyncState(patch: Partial<SyncState>): Promise<SyncState> {
  return withFileLock(syncStateLockPath(), undefined, async () => {
    const cur = (await readSyncState()) ?? emptySyncState()
    const next: SyncState = { ...cur, ...patch, v: SYNC_STATE_VERSION }
    await atomicWrite(syncJsonPath(), JSON.stringify(next, null, 2) + '\n', 0o600)
    return next
  })
}

/** 记录本机最近一次切换时间（云端 desired 状态机的保护锚点，详设 §7.4-5）。
 *  switchToService 统一调用——UI/CLI/agent 三路切换都经过它。未启用同步时静默跳过。 */
export async function noteLocalSwitch(now = new Date().toISOString()): Promise<void> {
  const st = await readSyncState().catch(() => null)
  if (!st || st.mode === 'off') return
  await updateSyncState({ lastLocalSwitchTs: now })
}
