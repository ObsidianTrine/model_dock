import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { secretsPath } from '../util/paths.js'
import { atomicWrite, readTextIfExists, withFileLock } from '../util/fsx.js'
import { t } from '../util/i18n.js'

const exec = promisify(execFile)

export type SecretBackend = 'file' | 'keychain' | 'secret-service'

/** secrets.json 损坏 / 不可操作时的可操作报错（对照 store.ts 的 ConfigError） */
export class SecretsError extends Error {
  constructor(msg: string) {
    super(msg)
    this.name = 'SecretsError'
  }
}

/** secrets.json 写锁文件路径（与 config.toml 的 .lock 同语义、独立文件，互不串扰） */
export const secretsLockPath = () => secretsPath() + '.lock'

export interface KeyRef {
  scheme: 'file' | 'keychain' | 'secret-service' | 'env' | 'plain'
  id: string
}

export function parseKeyRef(ref: string): KeyRef {
  if (ref.startsWith('env:')) return { scheme: 'env', id: ref.slice(4) }
  if (ref.startsWith('keychain:')) return { scheme: 'keychain', id: ref.slice('keychain:'.length) }
  if (ref.startsWith('secret-service:')) return { scheme: 'secret-service', id: ref.slice('secret-service:'.length) }
  if (ref.startsWith('file:')) return { scheme: 'file', id: ref.slice('file:'.length) }
  return { scheme: 'plain', id: ref }
}

export function makeKeyRef(backend: SecretBackend, id: string): string {
  switch (backend) {
    case 'keychain':
      return `keychain:${id}`
    case 'secret-service':
      return `secret-service:${id}`
    default:
      return `file:${id}`
  }
}

/** 当前平台默认的安全后端；未显式配置 security.store 时使用。
 *  win32→file（其内部用 DPAPI 加密），darwin→keychain，linux→secret-service（无钥匙环则回退 file）。 */
export async function defaultStore(): Promise<SecretBackend> {
  switch (process.platform) {
    case 'darwin':
      return 'keychain'
    case 'win32':
      return 'file'
    case 'linux':
      return (await hasSecretTool()) ? 'secret-service' : 'file'
    default:
      return 'file'
  }
}

// Linux Secret Service（secret-tool / libsecret）
// 仅桌面环境（GNOME/KDE 等带钥匙环守护进程）可用；无头服务器通常没有，回退 file 后端。
let secretToolAvailable: boolean | null = null
async function hasSecretTool(): Promise<boolean> {
  if (secretToolAvailable !== null) return secretToolAvailable
  try {
    await exec('secret-tool', ['--help'], { timeout: 3000 })
    secretToolAvailable = true
  } catch {
    secretToolAvailable = false
  }
  return secretToolAvailable
}

/** 用 secret-tool 的 service/modeldock + account=<id> 作为主键；读写走 stdin，避免密钥出现在 argv */
function secretToolOp(op: 'store' | 'lookup' | 'clear', account: string, secret?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const args =
      op === 'store'
        ? ['store', '--label', `modeldock:${account}`, 'service', 'modeldock', 'account', account]
        : op === 'lookup'
          ? ['lookup', 'service', 'modeldock', 'account', account]
          : ['clear', 'service', 'modeldock', 'account', account]
    const child = spawn('secret-tool', args, { windowsHide: true })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    child.on('error', reject)
    child.on('close', (code) => {
      if (op === 'lookup') resolve(out.trim())
      else if (code === 0) resolve(out.trim())
      else reject(new Error(err.trim() || `secret-tool exited ${code}`))
    })
    if (op === 'store' && secret != null) child.stdin.end(Buffer.from(secret, 'utf8'))
    else child.stdin.end()
  })
}

// 外部后端（keychain / secret-service）解密结果缓存：扩展转发每请求读 key，必须避免每请求 spawn 子进程。
// 带 60s TTL：keychain 这类外部源经其他进程 / 控制台直接改 key 不会产生文件事件，TTL 保证最迟 1 分钟生效；
// 命中路径仍是纯内存时间戳比较，不给转发热路径加 I/O。TTL 结构参考 src/adapters/presence.ts 的 regMemo。
const EXT_TTL = 60_000
const externalCache = new Map<string, { at: number; val: string | null }>()
const extKey = (scheme: string, id: string) => `${scheme}:${id}`

type ExternalReader = (scheme: 'keychain' | 'secret-service', id: string) => Promise<string | null>

/** 真实外部读取：keychain 经 `security find-generic-password`，secret-service 经 secret-tool。 */
const realReadExternal: ExternalReader = async (scheme, id) => {
  if (scheme === 'keychain') {
    try {
      const { stdout } = await exec('security', ['find-generic-password', '-s', 'modeldock', '-a', id, '-w'])
      return stdout.trim() || null
    } catch {
      return null
    }
  } else {
    try {
      return (await secretToolOp('lookup', id)) || null
    } catch {
      return null
    }
  }
}

let readExternal: ExternalReader = realReadExternal
/** 测试注入外部读取器（替换 keychain/secret-service 后端读取，避免真 spawn 外部进程）；传 undefined 还原为真实读取器。 */
export function __testSetExternalReader(fn?: ExternalReader): void {
  readExternal = fn ?? realReadExternal
}

async function getExternal(scheme: 'keychain' | 'secret-service', id: string): Promise<string | null> {
  const ck = extKey(scheme, id)
  const memo = externalCache.get(ck)
  if (memo && Date.now() - memo.at < EXT_TTL) return memo.val
  const val = await readExternal(scheme, id)
  externalCache.set(ck, { at: Date.now(), val })
  return val
}

/** 供 keychain 交互模式命令行的值/账号转义：双引号包裹，内部 `"` 与 `\` 转义。
 *  含换行 / NUL 等无法在单个 `-w "<token>"` 内安全表达的控制字符时返回 null（调用方回落 argv 路径）。 */
export function keychainArgValue(value: string): string | null {
  if (/[\r\n\0]/.test(value)) return null
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/** darwin keychain 写入走 `security -i` 交互模式：把子命令喂给 stdin，密钥不进 argv（ps 不可见）。
 *  命令形态 `add-generic-password -s modeldock -a <account> -w "<value>" -U`。 */
function setKeychain(id: string, value: string): Promise<void> {
  const account = keychainArgValue(id)
  const quoted = keychainArgValue(value)
  if (account == null || quoted == null) {
    // 值含换行或无法安全转义：回落 argv 路径（原有形态），保功能不回归优先
    return exec('security', ['add-generic-password', '-s', 'modeldock', '-a', id, '-w', value, '-U']).then(() => undefined)
  }
  return new Promise((resolve, reject) => {
    const child = spawn('security', ['-i'], { windowsHide: true })
    let err = ''
    child.stderr.on('data', (d) => (err += d))
    child.on('error', reject)
    child.on('close', (code) => {
      // 交互模式 `-i`：逐行执行 stdin 的子命令直至 EOF；密钥在 stdin 而非 argv
      if (code === 0) resolve()
      else reject(new Error(err.trim() || `security exited ${code}`))
    })
    child.stdin.end(`add-generic-password -s modeldock -a ${account} -w ${quoted} -U\n`)
  })
}

async function setExternal(scheme: 'keychain' | 'secret-service', id: string, value: string): Promise<void> {
  if (scheme === 'keychain') {
    await setKeychain(id, value)
  } else {
    await secretToolOp('store', id, value)
  }
  externalCache.set(extKey(scheme, id), { at: Date.now(), val: value })
}

async function removeExternal(scheme: 'keychain' | 'secret-service', id: string): Promise<void> {
  if (scheme === 'keychain') {
    await exec('security', ['delete-generic-password', '-s', 'modeldock', '-a', id]).catch(() => {})
  } else {
    await secretToolOp('clear', id).catch(() => {})
  }
  externalCache.set(extKey(scheme, id), { at: Date.now(), val: null })
}

// Windows DPAPI 加密（file 后端在 win32 上加密存储）
// 值前缀 `enc:dpapi:<base64>`；密文绑定当前 Windows 账号，换账号/换机器后解不开
// （getSecret 对解不开的置空，绝不回退明文）。关键：整表批量加/解密用**一次** PowerShell
// 进程处理，避免每条目 spawn 子进程——逐条曾使导入 6 个 key 慢到几十秒。payload 经 stdin 传、
// 密钥不进命令行。
const CAN_DPAPI = process.platform === 'win32'
const DPAPI_PREFIX = 'enc:dpapi:'

// Linux file 后端本机绑定加密（AES-256-GCM，密钥从 machine-id 派生）
// 无 secret-service 钥匙环时，Linux 的 file 后端用本机 machine-id 绑定加密，避免明文落盘。
// 防"secrets.json 单独被拷贝/上传/备份"后直接读到明文 Key（非本机 machine-id 解不出）。
const MACH_PREFIX = 'enc:mach:'

let machIdCache: string | null | undefined
function linuxMachineId(): string | null {
  if (machIdCache !== undefined) return machIdCache
  if (process.platform !== 'linux') { machIdCache = null; return null }
  for (const p of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
    try { const v = readFileSync(p, 'utf8').trim(); if (v) { machIdCache = v; return v } } catch { /* 尝试下一个 */ }
  }
  machIdCache = null
  return null
}
const CAN_MACH = process.platform === 'linux' && !!linuxMachineId()

const machKey = (): Buffer => createHash('sha256').update(linuxMachineId() ?? '').digest()

async function encMach(plainUtf8: string): Promise<string> {
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', machKey(), nonce)
  const enc = Buffer.concat([cipher.update(plainUtf8, 'utf8'), cipher.final()])
  return MACH_PREFIX + Buffer.concat([nonce, cipher.getAuthTag(), enc]).toString('base64')
}
async function decMach(b64: string): Promise<string> {
  const buf = Buffer.from(b64, 'base64')
  const decipher = createDecipheriv('aes-256-gcm', machKey(), buf.subarray(0, 12))
  decipher.setAuthTag(buf.subarray(12, 28))
  return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8')
}

let warnedPlainFile = false
function warnPlainFileOnce(): void {
  if (warnedPlainFile || process.platform !== 'linux') return
  warnedPlainFile = true
  console.error(t('[modeldock] 未检测到 secret-service 钥匙环，secrets.json 将明文存储（0600）。建议安装 gnome-keyring 以启用加密，或设 security.store="keychain"', '[modeldock] No secret-service keychain detected; secrets.json will be stored in plaintext (0600). Install gnome-keyring for encryption, or set security.store="keychain"'))
}

const DPAPI_ENC = `Add-Type -AssemblyName System.Security
[Console]::In.ReadToEnd() -split "\\r?\\n" | ForEach-Object { $s=$_.Trim(); if($s){ [Console]::Out.WriteLine([Convert]::ToBase64String([System.Security.Cryptography.ProtectedData]::Protect([Convert]::FromBase64String($s),$null,'CurrentUser'))) } }`
const DPAPI_DEC = `Add-Type -AssemblyName System.Security
[Console]::In.ReadToEnd() -split "\\r?\\n" | ForEach-Object { $s=$_.Trim(); if($s){ [Console]::Out.WriteLine([Convert]::ToBase64String([System.Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($s),$null,'CurrentUser'))) } }`

/** 测试注入的 DPAPI 批量实现（避免真 spawn PowerShell）；undefined=用真实 dpapiBatch。
 *  与既有 __testSetExternalReader 同套路：模块内 let 替换，不碰 vi.mock 跨文件雷区。 */
let dpapiImpl: ((script: string, b64In: string[]) => Promise<string[]>) | undefined
export function __testSetDpapiBatch(fn?: (script: string, b64In: string[]) => Promise<string[]>): void {
  dpapiImpl = fn
}

/** 一次 PowerShell 进程批量加/解密多份（base64 入，base64 出，逐行对应）。payload 经 stdin 传、
 *  密钥不进命令行。失败重试一次（覆盖瞬时 spawn 失败）；仍失败即抛——DPAPI Protect/Unprotect
 *  依赖的是当前账号 DPAPI 密钥集，与单条 payload 无关，逐条重试既无意义又会逐条 spawn（旧回退
 *  曾让导入 6 个 key 慢到几十秒，故取消逐条回退）。 */
function dpapiBatch(script: string, b64In: string[]): Promise<string[]> {
  if (dpapiImpl) return dpapiImpl(script, b64In)
  return (async () => {
    if (b64In.length === 0) return []
    let lastErr: unknown
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await new Promise<string[]>((resolve, reject) => {
          const child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
            windowsHide: true,
          })
          let out = ''
          let err = ''
          child.stdout.on('data', (d) => (out += d))
          child.stderr.on('data', (d) => (err += d))
          child.on('error', reject)
          child.on('close', (code) => {
            if (code !== 0) return reject(new Error(err.trim() || `powershell exited ${code}`))
            resolve(out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean))
          })
          child.stdin.end(b64In.join('\n'))
        })
      } catch (e) {
        lastErr = e
      }
    }
    throw lastErr
  })()
}

// 整表加解密统一模型（DUP-07：encryptAll/decryptAll 与 encryptMachineAll/decryptMachineAll 同构
// 双实现合并）：file 后端按平台一次选定加密方案，读/写分支只认 { prefix, encryptTable, decryptTable }。
// win32→DPAPI（逐条 spawn 曾致几十秒，改用整表一次 PowerShell），linux 无钥匙环→machine-id 绑定 AES，
// 其余→明文。

interface FileCipher {
  prefix: string
  enabled: boolean
  /** 整表解密：raw（带 prefix 的密文表）→ 明文表；未带 prefix 的值原样透传（存量明文/普通值） */
  decryptTable: (raw: Record<string, string>) => Promise<Record<string, string>>
  /** 整表加密：dec（明文表）→ 带 prefix 的密文表；空值/已带 prefix 原样保留 */
  encryptTable: (dec: Record<string, string>) => Promise<Record<string, string>>
}

/** secrets.json 写路径锁超时的可操作报错（对照 config 的 ConfigError 用 SecretsError 分流） */
function secretsLockTimeoutError(lp: string): SecretsError {
  return new SecretsError(
    t('secrets.json 写锁超时：{lp} 被其他进程长期占用。确认没有其他 modeldock 进程在写密钥后，可删除该 .lock 文件重试',
      'Timed out acquiring the secrets write lock: {lp} has been held by another process for too long. After confirming no other modeldock process is writing keys, delete the .lock file and retry',
      { lp })
  )
}

export const dpapiCipher: FileCipher = {
  prefix: DPAPI_PREFIX,
  enabled: CAN_DPAPI,
  async encryptTable(dec) {
    const entries = Object.entries(dec).filter(
      ([, v]) => typeof v === 'string' && v !== '' && !v.startsWith(DPAPI_PREFIX)
    )
    const raw: Record<string, string> = { ...dec }
    if (entries.length === 0) return raw
    const outs = await dpapiBatch(DPAPI_ENC, entries.map(([, v]) => Buffer.from(v, 'utf8').toString('base64')))
    if (outs.length < entries.length) {
      throw new SecretsError(
        t('DPAPI 加密表行数与输入不匹配（{got}/{want}），secrets.json 可能未完整加密。请重新写入密钥后重试',
          'DPAPI encrypt output line count ({got}/{want}) does not match input; secrets.json may be incompletely encrypted. Re-set your keys and retry',
          { got: String(outs.length), want: String(entries.length) })
      )
    }
    entries.forEach(([k], i) => {
      raw[k] = DPAPI_PREFIX + outs[i]
    })
    return raw
  },
  async decryptTable(raw) {
    const encs = Object.entries(raw).filter(([, v]) => typeof v === 'string' && v.startsWith(DPAPI_PREFIX))
    const dec: Record<string, string> = {}
    for (const [k, v] of Object.entries(raw)) dec[k] = typeof v === 'string' ? v : ''
    if (encs.length === 0) return dec
    const outs = await dpapiBatch(DPAPI_DEC, encs.map(([, v]) => v.slice(DPAPI_PREFIX.length)))
    if (outs.length < encs.length) {
      throw new SecretsError(
        t('DPAPI 解密表行数与输入不匹配（{got}/{want}），secrets.json 可能已损坏。可备份后删除该文件，各密钥重新设置',
          'DPAPI decrypt output line count ({got}/{want}) does not match input; secrets.json may be corrupted. Back it up, delete it, and re-set your keys',
          { got: String(outs.length), want: String(encs.length) })
      )
    }
    encs.forEach(([k], i) => {
      dec[k] = Buffer.from(outs[i], 'base64').toString('utf8')
    })
    return dec
  },
}

export const machCipher: FileCipher = {
  prefix: MACH_PREFIX,
  enabled: CAN_MACH,
  async encryptTable(dec) {
    const raw: Record<string, string> = {}
    for (const [k, v] of Object.entries(dec)) {
      raw[k] = typeof v === 'string' && v !== '' && !v.startsWith(MACH_PREFIX) ? await encMach(v) : v
    }
    return raw
  },
  async decryptTable(raw) {
    const dec: Record<string, string> = {}
    for (const [k, v] of Object.entries(raw)) {
      dec[k] = typeof v === 'string' && v.startsWith(MACH_PREFIX) ? await decMach(v.slice(MACH_PREFIX.length)) : v
    }
    return dec
  },
}

const plainCipher: FileCipher = {
  prefix: '',
  // enabled=false：明文后端「无加密保护」——正是 loadFileSecrets 触发 warnPlainFileOnce 的分支。
  // 设为 true 会让 `!cipher.enabled` 恒假、警告永不触发（安全提示回归，2026-10-12 review 复现）。
  enabled: false,
  async encryptTable(dec) {
    return { ...dec }
  },
  async decryptTable(raw) {
    return { ...raw }
  },
}

/** 按平台一次选定 file 后端加密方案（DPAPI > machine-id AES > 明文） */
export function pickFileCipher(): FileCipher {
  if (CAN_DPAPI) return dpapiCipher
  if (CAN_MACH) return machCipher
  return plainCipher
}

// file 后端的解密缓存：扩展转发每请求读 key，缓存避免每请求 spawn 子进程。
// 缓存按 secrets.json 路径归属（path + data）：切换 MODELRDOCK_FAKE_HOME（测试多沙箱）或换数据源时，
// 路径不同自然失效，避免拿上一份数据（home）的缓存污染当前读取。单 home 生产下路径恒定，行为同旧缓存。
let fileCache: { path: string; data: Record<string, string> } | null = null

/** 读 secrets.json 原始明文表；损坏抛可操作 SecretsError（不再静默当「无密钥」） */
async function readSecretsRaw(): Promise<Record<string, string>> {
  const text = await readTextIfExists(secretsPath())
  if (!text) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (e) {
    throw new SecretsError(
      t('secrets.json 解析失败：{msg}\n文件路径：{p}\n请备份后删除或修正该文件，各密钥重新设置即可',
        'Failed to parse secrets.json: {msg}\nPath: {p}\nBack up, then delete or fix this file; re-set your keys afterwards',
        { msg: (e as Error).message, p: secretsPath() })
    )
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new SecretsError(
      t('secrets.json 内容不是密钥表对象（当前是{kind}）。文件路径：{p}\n请备份后删除或修正该文件，各密钥重新设置即可',
        'secrets.json is not a key-table object (got {kind}). Path: {p}\nBack up, then delete or fix this file; re-set your keys afterwards',
        { kind: Array.isArray(parsed) ? '数组/array' : typeof parsed, p: secretsPath() })
    )
  }
  return parsed as Record<string, string>
}

/** 读取 file 后端解密表；win32/linux 首次加载会把存量明文自动加密迁移（整表一次进程）。
 *  @param useCache 默认读内存缓存（转发热路径）；写路径传 false 强制重读盘，避免跨进程改 key 丢更新。 */
async function loadFileSecrets(useCache = true): Promise<Record<string, string>> {
  if (useCache && fileCache && fileCache.path === secretsPath()) return fileCache.data
  const path = secretsPath()
  const raw = await readSecretsRaw()
  const cipher = pickFileCipher()
  if (!cipher.enabled) {
    warnPlainFileOnce()
    fileCache = { path, data: raw }
    return raw
  }
  const hasLegacyPlain = Object.values(raw).some(
    (v) => typeof v === 'string' && v !== '' && !v.startsWith(cipher.prefix)
  )
  const dec = await cipher.decryptTable(raw)
  if (hasLegacyPlain) {
    await atomicWrite(secretsPath(), JSON.stringify(await cipher.encryptTable(dec), null, 2) + '\n', 0o600)
  }
  fileCache = { path, data: dec }
  return dec
}

/** 解密表整体加密写回文件（file 后端；整表一次进程，而非逐条） */
async function writeFileSecrets(dec: Record<string, string>): Promise<void> {
  const cipher = pickFileCipher()
  const raw = await cipher.encryptTable(dec)
  await atomicWrite(secretsPath(), JSON.stringify(raw, null, 2) + '\n', 0o600)
  fileCache = { path: secretsPath(), data: dec }
}

/** 写路径统一入口：跨进程锁（与 config 同语义）+ 持锁内重读盘拼新鲜的解密表，改后整表写回。
 *  锁内强制跳过内存缓存，避免另一进程刚写入的 key 被本进程旧缓存覆盖（丢更新）。 */
function mutateFileSecrets<T>(fn: (store: Record<string, string>) => T | Promise<T>): Promise<T> {
  return withFileLock(secretsLockPath(), { timeoutError: secretsLockTimeoutError }, async () => {
    const store = await loadFileSecrets(false)
    const ret = await fn(store)
    await writeFileSecrets(store)
    return ret
  })
}

/** 清除全部密钥缓存（file 后端整表解密缓存 + 外部后端 TTL 缓存）：
 *  文件 watcher 触发的 reload 调用此后，另一进程 / 控制台改的 key 即刻（file）或最迟 1 分钟（keychain）生效。 */
export function invalidateSecretsCache(): void {
  fileCache = null
  externalCache.clear()
}

/** 读取 key；plain 代表明文内嵌在 config 里（不推荐，直接返回） */
export async function getSecret(ref: string): Promise<string | null> {
  const { scheme, id } = parseKeyRef(ref)
  if (scheme === 'plain') return id
  if (scheme === 'env') return process.env[id] ?? null
  if (scheme === 'keychain' || scheme === 'secret-service') return getExternal(scheme, id)
  const store = await loadFileSecrets()
  const v = store[id]
  return typeof v === 'string' && v !== '' ? v : null
}

/** 写入 key，返回应写入 config 的 key_ref */
export async function setSecret(id: string, value: string, backend: SecretBackend): Promise<string> {
  if (backend === 'keychain' || backend === 'secret-service') {
    await setExternal(backend, id, value)
    return makeKeyRef(backend, id)
  }
  return mutateFileSecrets((store) => {
    store[id] = value
    return makeKeyRef('file', id)
  })
}

/** 批量写入多个 key（导入用）：file backend 只做一次整表写盘，避免逐 key 重写；
 *  keychain/secret-service 各写入一次外部存储。返回 id → key_ref。 */
export async function setSecretsBatch(
  entries: Record<string, string>,
  backend: SecretBackend
): Promise<Record<string, string>> {
  const refs: Record<string, string> = {}
  if (backend === 'keychain' || backend === 'secret-service') {
    for (const [id, val] of Object.entries(entries)) {
      await setExternal(backend, id, val)
      refs[id] = makeKeyRef(backend, id)
    }
    return refs
  }
  return mutateFileSecrets((store) => {
    for (const [id, val] of Object.entries(entries)) {
      store[id] = val
      refs[id] = makeKeyRef('file', id)
    }
    return refs
  })
}

export async function deleteSecret(ref: string): Promise<void> {
  const { scheme, id } = parseKeyRef(ref)
  if (scheme === 'keychain' || scheme === 'secret-service') {
    await removeExternal(scheme, id)
    return
  }
  if (scheme !== 'file') return
  return mutateFileSecrets((store) => {
    delete store[id]
  })
}