import os from 'node:os'
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  pbkdf2Sync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto'
import { ENVELOPE_FMT, SCHEMA_VERSION, SYNCDOC_FMT, type SyncEnvelope, type Syncdoc } from './types.js'
import { t } from '../util/i18n.js'

/** 信封加密（docs/design-cloud-sync.md §4.3）：
 *  master = PBKDF2-HMAC-SHA256(口令, salt, 600000, 32B)
 *  encKey || macKey = HKDF-SHA256(master, hkdfSalt, info="modeldock/syncdoc/v1")  各 32B
 *  ct = AES-256-GCM(encKey, iv, syncdocJSON)（认证标签拼在密文尾部）
 *  hmac = HMAC-SHA256(macKey, ts || "||" || ct)——M1 无服务端修订号，HMAC 覆盖 (ts||ct)；
 *  防回滚在 M3 由「信封 ts 单调性 + 服务端 422」实现。 */

const PBKDF2_ITER = 600_000
const HKDF_INFO = 'modeldock/syncdoc/v1'
const VERIFIER_INFO = 'modeldock/syncenv/verifier/v1'

function deriveKeys(passphrase: string, salt: Buffer, hkdfSalt: Buffer): { encKey: Buffer; macKey: Buffer } {
  const master = pbkdf2Sync(passphrase, salt, PBKDF2_ITER, 32, 'sha256')
  const okm = Buffer.from(hkdfSync('sha256', master, hkdfSalt, HKDF_INFO, 64))
  return { encKey: okm.subarray(0, 32), macKey: okm.subarray(32, 64) }
}

function hmacOverCt(macKey: Buffer, ts: string, ctB64: string): Buffer {
  return createHmac('sha256', macKey).update(`${ts}||${ctB64}`, 'utf8').digest()
}

/** M2 自动同步用的密钥材料（sync.json 缓存的派生密钥 + 生成它的 salt/hkdfSalt）。
 *  信封必须内嵌 salt/hkdfSalt：任何机器凭口令都能独立解包（自包含）；缓存密钥只是免掉本机重复 PBKDF2。 */
export interface SyncKeys {
  encKey: Buffer
  macKey: Buffer
  salt: Buffer
  hkdfSalt: Buffer
}

/** 密封 syncdoc → 加密信封。iv 每次密封独立随机；salt/hkdfSalt 随 keys 固定（同步目标的口令身份）。 */
export function sealWithKeys(doc: Syncdoc, keys: SyncKeys): SyncEnvelope {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', keys.encKey, iv)
  const ct = Buffer.concat([cipher.update(JSON.stringify(doc), 'utf8'), cipher.final(), cipher.getAuthTag()])
  const ctB64 = ct.toString('base64')
  return {
    fmt: ENVELOPE_FMT,
    v: SCHEMA_VERSION,
    kdf: { alg: 'PBKDF2-HMAC-SHA256', iter: PBKDF2_ITER, salt: keys.salt.toString('base64'), hkdfSalt: keys.hkdfSalt.toString('base64') },
    iv: iv.toString('base64'),
    ct: ctB64,
    hmac: hmacOverCt(keys.macKey, doc.ts, ctB64).toString('base64'),
    verifier: createHmac('sha256', keys.macKey).update(VERIFIER_INFO, 'utf8').digest('base64'),
    created_by: os.hostname(),
    created_at: new Date().toISOString(),
  }
}

/** 拆封（密钥直用，不经 PBKDF2）：口令材料不一致时 verifier 先拦，密文被动过 GCM 认证拦 */
export function openWithKeys(env: unknown, keys: SyncKeys): Syncdoc {
  if (typeof env !== 'object' || env === null || Array.isArray(env)) throw new Error(t('同步包不是合法的 JSON 对象', 'The sync package is not a valid JSON object'))
  const e = env as Record<string, unknown>
  if (e.fmt !== ENVELOPE_FMT || e.v !== SCHEMA_VERSION || typeof e.iv !== 'string' || typeof e.ct !== 'string' || typeof e.hmac !== 'string' || typeof e.verifier !== 'string') {
    throw new Error(t('同步包缺少加密封装字段，文件不完整', 'The sync package is missing envelope fields; the file is incomplete'))
  }
  const expectVerifier = createHmac('sha256', keys.macKey).update(VERIFIER_INFO, 'utf8').digest('base64')
  if (e.verifier !== expectVerifier) {
    throw new Error(t('同步密钥不一致：该包不是用本同步目标当前的口令密封的', 'Key mismatch: this package was not sealed with the current passphrase of this sync target'))
  }
  let plain: Buffer
  try {
    const ct = Buffer.from(e.ct, 'base64')
    if (ct.length < 17) throw new Error('ct too short')
    const decipher = createDecipheriv('aes-256-gcm', keys.encKey, Buffer.from(e.iv, 'base64'))
    decipher.setAuthTag(ct.subarray(ct.length - 16))
    plain = Buffer.concat([decipher.update(ct.subarray(0, ct.length - 16)), decipher.final()])
  } catch {
    throw new Error(t('同步包内容校验失败：密文已被篡改或文件损坏', 'Sync package verification failed: the ciphertext has been tampered with or the file is corrupted'))
  }
  let doc: unknown
  try {
    doc = JSON.parse(plain.toString('utf8'))
  } catch {
    throw new Error(t('同步包解密后不是合法 JSON：文件已损坏', 'The decrypted sync package is not valid JSON: the file is corrupted'))
  }
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc) || (doc as Record<string, unknown>).fmt !== SYNCDOC_FMT) {
    throw new Error(t('解密后的内容不是 ModelDock 配置文档，文件可能被调包', 'The decrypted content is not a ModelDock sync document; the file may have been swapped'))
  }
  verifyHmacWithKeys(doc as Syncdoc, e as unknown as SyncEnvelope, keys.macKey)
  return doc as Syncdoc
}

/** M2 setup：从口令派生同步密钥（salt/hkdfSalt 由调用方随机生成并随 sync.json 缓存） */
export function deriveSyncKeys(passphrase: string, salt: Buffer, hkdfSalt: Buffer): SyncKeys {
  return { ...deriveKeys(passphrase, salt, hkdfSalt), salt, hkdfSalt }
}

/** 口令一致性校验值：sync.json 缓存、openWithKeys 以同式校验 */
export function syncVerifier(macKey: Buffer): string {
  return createHmac('sha256', macKey).update(VERIFIER_INFO, 'utf8').digest('base64')
}

/** 密封 syncdoc → 加密信封。每个信封独立 salt/iv/hkdfSalt（同口令两次密封密文也不同） */
export function sealEnvelope(doc: Syncdoc, passphrase: string): SyncEnvelope {
  const salt = randomBytes(16)
  const hkdfSalt = randomBytes(32)
  const { encKey, macKey } = deriveKeys(passphrase, salt, hkdfSalt)
  return sealWithKeys(doc, { encKey, macKey, salt, hkdfSalt })
}

/** HMAC 兜底校验（密钥直用）：覆盖 (ts || ct)，防存储端改内容不改时间轴 */
export function verifyHmacWithKeys(doc: Syncdoc, env: SyncEnvelope, macKey: Buffer): void {
  const expect = hmacOverCt(macKey, doc.ts, env.ct)
  const got = Buffer.from(env.hmac, 'base64')
  if (got.length !== expect.length || !timingSafeEqual(got, expect)) {
    throw new Error(t('同步包完整性校验失败（HMAC 不匹配）：文件可能被篡改，请勿导入', 'Sync package integrity check failed (HMAC mismatch): the file may have been tampered with; do not import it'))
  }
}

/** HMAC 兜底校验：与 openEnvelope 内部逻辑同源，供测试/审计独立调用 */
export function verifyEnvelopeHmac(doc: Syncdoc, env: SyncEnvelope, passphrase: string): void {
  const { macKey } = deriveKeys(passphrase, Buffer.from(env.kdf.salt, 'base64'), Buffer.from(env.kdf.hkdfSalt, 'base64'))
  verifyHmacWithKeys(doc, env, macKey)
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** 拆封：口令错误 / 包损坏 / 被篡改各自给出可区分的可操作报错 */
export function openEnvelope(env: unknown, passphrase: string): Syncdoc {
  if (!isPlainObject(env)) throw new Error(t('同步包不是合法的 JSON 对象', 'The sync package is not a valid JSON object'))
  if (env.fmt !== ENVELOPE_FMT) throw new Error(t('不是 ModelDock 配置同步包（fmt={f}）', 'Not a ModelDock sync package (fmt={f})', { f: String(env.fmt ?? '') }))
  if (env.v !== SCHEMA_VERSION)
    throw new Error(
      t(
        '同步包格式版本不支持（v={v}，当前支持 v={max}），请升级 modeldock 后重试',
        'Unsupported package format version (v={v}; supported: v={max}); upgrade modeldock and retry',
        { v: String(env.v ?? ''), max: SCHEMA_VERSION }
      )
    )
  const kdf = env.kdf as SyncEnvelope['kdf'] | undefined
  if (!isPlainObject(kdf) || typeof kdf.salt !== 'string' || typeof kdf.hkdfSalt !== 'string' || typeof env.iv !== 'string' || typeof env.ct !== 'string') {
    throw new Error(t('同步包缺少加密封装字段，文件不完整', 'The sync package is missing envelope fields; the file is incomplete'))
  }
  const { encKey, macKey } = deriveKeys(passphrase, Buffer.from(kdf.salt, 'base64'), Buffer.from(kdf.hkdfSalt, 'base64'))
  // 先验 verifier 再解密：「口令不正确」与「包被篡改」才报得出两种错
  const expectVerifier = createHmac('sha256', macKey).update(VERIFIER_INFO, 'utf8').digest('base64')
  if (typeof env.verifier !== 'string' || env.verifier !== expectVerifier) {
    throw new Error(t('口令不正确。若遗忘口令，包内容无法恢复，请向导出方重新获取', 'Incorrect passphrase. If forgotten, the package contents cannot be recovered; ask the exporter for a new package'))
  }
  let plain: Buffer
  try {
    const ct = Buffer.from(env.ct, 'base64')
    if (ct.length < 17) throw new Error('ct too short')
    const decipher = createDecipheriv('aes-256-gcm', encKey, Buffer.from(env.iv, 'base64'))
    decipher.setAuthTag(ct.subarray(ct.length - 16))
    plain = Buffer.concat([decipher.update(ct.subarray(0, ct.length - 16)), decipher.final()])
  } catch {
    throw new Error(t('同步包内容校验失败：密文已被篡改或文件损坏', 'Sync package verification failed: the ciphertext has been tampered with or the file is corrupted'))
  }
  let doc: unknown
  try {
    doc = JSON.parse(plain.toString('utf8'))
  } catch {
    throw new Error(t('同步包解密后不是合法 JSON：文件已损坏', 'The decrypted sync package is not valid JSON: the file is corrupted'))
  }
  if (!isPlainObject(doc) || doc.fmt !== SYNCDOC_FMT) {
    throw new Error(t('解密后的内容不是 ModelDock 配置文档，文件可能被调包', 'The decrypted content is not a ModelDock sync document; the file may have been swapped'))
  }
  verifyEnvelopeHmac(doc as unknown as Syncdoc, env as unknown as SyncEnvelope, passphrase)
  return doc as unknown as Syncdoc
}
