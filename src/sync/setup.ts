/**
 * sync setup 的非交互核心（CLI 交互壳与测试共用）：配置同步目标 + 派生密钥 + 首推/加入收敛 + 落 sync.json。
 * 语义（详设 §6.3/§4.4）：目标已有清单 → 按「加入既有同步」处理（口令先对远端包验证，一致才应用远端）；
 * 全新目标 → 把本机可同步态作为 rev 1 推上去。
 */
import { randomBytes } from 'node:crypto'
import os from 'node:os'
import { request } from 'undici'
import { collectSyncdoc, applySyncdoc, type SyncdocReport } from './collect.js'
import { deriveSyncKeys, openWithKeys, sealWithKeys } from './crypto.js'
import { createCloudTargetFrom, createTarget, hashDoc, keysToCache } from './runtime.js'
import { blobRefOf, type SyncManifest } from './targets/types.js'
import { emptySyncState, writeSyncState, type SyncState, type SyncTargetConfig } from './state.js'
import { validateSyncdoc, type Syncdoc } from './types.js'
import { randomToken } from '../util/fsx.js'
import { t } from '../util/i18n.js'

export { createTarget } from './runtime.js'

export interface SetupResult {
  /** true=加入既有目标（应用了远端）；false=全新目标（本机作为 rev 1 首推） */
  joined: boolean
  rev: number
  report: SyncdocReport | null
}

export async function setupSyncTarget(
  targetCfg: SyncTargetConfig,
  passphrase: string,
  opts?: { backend?: 'file' | 'keychain' | 'secret-service'; devid?: string }
): Promise<SetupResult> {
  const target = createTarget(targetCfg)
  const devid = opts?.devid ?? randomToken('mdksync')
  const deviceName = os.hostname()
  const now = new Date().toISOString()

  const manifest = await target.readManifest()
  if (manifest) {
    // 加入既有同步：密钥必须从远端信封自包含的 KDF 参数派生（同口令 → 同密钥），
    // 口令不一致时 openWithKeys 的 verifier 先拦下，不污染目标
    const envText = await target.readBlob(manifest.blobRef)
    let env: unknown
    try {
      env = JSON.parse(envText)
    } catch {
      throw new Error(t('同步目标上的最新包不是合法 JSON：目标内容可能被破坏', 'The latest package on the sync target is not valid JSON: the target contents may be corrupted'))
    }
    const kdf = (env as Record<string, unknown> | null)?.kdf as { salt?: unknown; hkdfSalt?: unknown } | undefined
    if (typeof kdf?.salt !== 'string' || typeof kdf?.hkdfSalt !== 'string') {
      throw new Error(t('同步目标上的最新包缺少 KDF 参数，文件不完整', 'The latest package on the sync target is missing KDF parameters; the file is incomplete'))
    }
    const keys = deriveSyncKeys(passphrase, Buffer.from(kdf.salt, 'base64'), Buffer.from(kdf.hkdfSalt, 'base64'))
    let remoteDoc: Syncdoc
    try {
      remoteDoc = openWithKeys(env, keys)
    } catch {
      throw new Error(
        t(
          '口令与该同步目标不一致（解不开最新同步包）。请输入与其他机器相同的同步口令',
          'The passphrase does not match this sync target (cannot open the latest package). Use the same passphrase as on your other machines'
        )
      )
    }
    const validated = validateSyncdoc(remoteDoc)
    const report = await applySyncdoc(validated, { backend: opts?.backend })
    const { doc: after } = await collectSyncdoc()
    const state: SyncState = {
      ...emptySyncState(),
      mode: 'target',
      target: targetCfg,
      key: keysToCache(keys),
      devid,
      deviceName,
      paused: false,
      lastAppliedRev: manifest.rev,
      lastAppliedTs: manifest.ts,
      lastSyncedHash: hashDoc(after),
      lastPullTs: now,
    }
    await writeSyncState(state)
    return { joined: true, rev: manifest.rev, report }
  }

  // 全新目标：随机生成 salt/hkdfSalt（成为该同步目标的口令身份，之后所有机器都从信封内嵌参数派生）
  const keys = deriveSyncKeys(passphrase, randomBytes(16), randomBytes(32))
  const { doc, report } = await collectSyncdoc()
  const sealed = sealWithKeys(doc, keys)
  await target.writeBlob(1, devid, JSON.stringify(sealed, null, 2) + '\n')
  const first: SyncManifest = { rev: 1, ts: doc.ts, byDevid: devid, blobRef: blobRefOf(1, devid) }
  const r = await target.writeManifest(first, 0)
  if (r === 'conflict') {
    throw new Error(t('首推时目标上已出现更新版本（其他机器同时在配置？），请重跑 modeldock sync setup', 'Another machine pushed while this machine was setting up; re-run modeldock sync setup'))
  }
  const state: SyncState = {
    ...emptySyncState(),
    mode: 'target',
    target: targetCfg,
    key: keysToCache(keys),
    devid,
    deviceName,
    paused: false,
    lastAppliedRev: 1,
    lastAppliedTs: first.ts,
    lastSyncedHash: hashDoc(doc),
    lastPushTs: now,
  }
  await writeSyncState(state)
  return { joined: false, rev: 1, report }
}

export interface EnrollResult {
  /** true=云端已有文档（已应用）；false=云端为空（本机作为 rev 1 首推） */
  joined: boolean
  rev: number
  report: SyncdocReport | null
  deviceName: string
}

async function cloudJson(url: string, method: string, body: unknown, timeoutMs = 10_000): Promise<{ code: number; json: any }> {
  let res
  try {
    res = await request(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) })
  } catch (e) {
    throw new Error(t('云端不可达（{url}）：{err}', 'Cloud unreachable ({url}): {err}', { url, err: (e as Error).message }))
  }
  const text = await res.body.text().catch(() => '')
  let json: any = null
  try {
    json = JSON.parse(text)
  } catch {
    /* 非 JSON 响应按原样报错 */
  }
  return { code: res.statusCode, json }
}

function cloudError(code: number, json: any, fallback: string): Error {
  const msg = json?.error?.message ?? fallback
  return new Error(t('云端错误（HTTP {code}）：{msg}', 'Cloud error (HTTP {code}): {msg}', { code, msg }))
}

/** M3 云端入网（详设 §7.5）：配对换设备 token → 密钥派生（云端有文档则从其 KDF 参数派生并验证口令）→ 收敛/首推 → 写 sync.json（mode=cloud）。
 *  注意：配对码一次性，口令输错时设备已入网但本机未落 sync.json——重试需在控制台重新生成配对码。 */
export async function enrollCloud(
  serverUrl: string,
  pairCode: string,
  passphrase: string,
  opts?: { backend?: 'file' | 'keychain' | 'secret-service'; devid?: string; deviceName?: string }
): Promise<EnrollResult> {
  const url = serverUrl.replace(/\/+$/, '')
  const devid = opts?.devid ?? randomToken('mdksync')
  const deviceName = opts?.deviceName ?? os.hostname()
  const now = new Date().toISOString()

  // 1) 配对：一次性码换设备 token
  const pair = await cloudJson(`${url}/v1/pair`, 'POST', { pairCode, devid, deviceName })
  if (pair.code !== 200 || !pair.json?.deviceToken) {
    throw cloudError(pair.code, pair.json, '配对失败')
  }
  const token = String(pair.json.deviceToken)

  // 2) 云端已有文档则按「加入」处理：从信封自包含 KDF 参数派生密钥并验证口令
  const target = createCloudTargetFrom({ url, devid, token })
  const manifest = await target.readManifest()
  if (manifest) {
    const envText = await target.readBlob(manifest.blobRef)
    let env: unknown
    try {
      env = JSON.parse(envText)
    } catch {
      throw new Error(t('云端最新包不是合法 JSON：云端内容可能被破坏', 'The latest cloud package is not valid JSON: the cloud contents may be corrupted'))
    }
    const kdf = (env as Record<string, unknown> | null)?.kdf as { salt?: unknown; hkdfSalt?: unknown } | undefined
    if (typeof kdf?.salt !== 'string' || typeof kdf?.hkdfSalt !== 'string') {
      throw new Error(t('云端最新包缺少 KDF 参数，文件不完整', 'The latest cloud package is missing KDF parameters; the file is incomplete'))
    }
    const keys = deriveSyncKeys(passphrase, Buffer.from(kdf.salt, 'base64'), Buffer.from(kdf.hkdfSalt, 'base64'))
    let remoteDoc: Syncdoc
    try {
      remoteDoc = openWithKeys(env, keys)
    } catch {
      throw new Error(
        t(
          '口令与云端不一致（解不开云端最新包）。请输入其他机器相同的同步口令后重试——配对码已被使用，请在云端控制台重新生成',
          'The passphrase does not match the cloud (cannot open the latest package). Use the same passphrase as your other machines and retry — the pair code was consumed; generate a new one in the cloud console'
        )
      )
    }
    const report = await applySyncdoc(validateSyncdoc(remoteDoc), { backend: opts?.backend })
    const { doc: after } = await collectSyncdoc()
    const state: SyncState = {
      ...emptySyncState(),
      mode: 'cloud',
      cloud: { url, devid, token, deviceName },
      key: keysToCache(keys),
      devid,
      deviceName,
      paused: false,
      lastAppliedRev: manifest.rev,
      lastAppliedTs: manifest.ts,
      lastSyncedHash: hashDoc(after),
      lastPullTs: now,
    }
    await writeSyncState(state)
    return { joined: true, rev: manifest.rev, report, deviceName }
  }

  // 3) 云端为空：本机可同步态作为 rev 1 首推
  const keys = deriveSyncKeys(passphrase, randomBytes(16), randomBytes(32))
  const { doc, report } = await collectSyncdoc()
  const sealed = sealWithKeys(doc, keys)
  await target.writeBlob(1, devid, JSON.stringify(sealed, null, 2) + '\n')
  const first: SyncManifest = { rev: 1, ts: doc.ts, byDevid: devid, blobRef: blobRefOf(1, devid) }
  const r = await target.writeManifest(first, 0)
  if (r === 'conflict') {
    throw new Error(t('首推时云端已出现更新版本（其他机器同时在入网？），请重新配对重试', 'Another device pushed while this one was enrolling; pair again and retry'))
  }
  const state: SyncState = {
    ...emptySyncState(),
    mode: 'cloud',
    cloud: { url, devid, token, deviceName },
    key: keysToCache(keys),
    devid,
    deviceName,
    paused: false,
    lastAppliedRev: 1,
    lastAppliedTs: first.ts,
    lastSyncedHash: hashDoc(doc),
    lastPushTs: now,
  }
  await writeSyncState(state)
  return { joined: false, rev: 1, report, deviceName }
}
