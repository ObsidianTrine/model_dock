import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { secretsPath } from '../util/paths.js'
import { atomicWrite, readTextIfExists } from '../util/fsx.js'
import { t } from '../util/i18n.js'

const exec = promisify(execFile)

export type SecretBackend = 'file' | 'keychain' | 'secret-service'

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

// 外部后端（keychain / secret-service）解密结果缓存：扩展转发每请求读 key，必须避免每请求 spawn 子进程
const externalCache = new Map<string, string | null>()
const extKey = (scheme: string, id: string) => `${scheme}:${id}`

async function getExternal(scheme: 'keychain' | 'secret-service', id: string): Promise<string | null> {
  const ck = extKey(scheme, id)
  if (externalCache.has(ck)) return externalCache.get(ck) ?? null
  let val: string | null = null
  if (scheme === 'keychain') {
    try {
      const { stdout } = await exec('security', ['find-generic-password', '-s', 'modeldock', '-a', id, '-w'])
      val = stdout.trim() || null
    } catch {
      val = null
    }
  } else {
    try {
      val = (await secretToolOp('lookup', id)) || null
    } catch {
      val = null
    }
  }
  externalCache.set(ck, val)
  return val
}

async function setExternal(scheme: 'keychain' | 'secret-service', id: string, value: string): Promise<void> {
  if (scheme === 'keychain') {
    await exec('security', ['add-generic-password', '-s', 'modeldock', '-a', id, '-w', value, '-U'])
  } else {
    await secretToolOp('store', id, value)
  }
  externalCache.set(extKey(scheme, id), value)
}

async function removeExternal(scheme: 'keychain' | 'secret-service', id: string): Promise<void> {
  if (scheme === 'keychain') {
    await exec('security', ['delete-generic-password', '-s', 'modeldock', '-a', id]).catch(() => {})
  } else {
    await secretToolOp('clear', id).catch(() => {})
  }
  externalCache.set(extKey(scheme, id), null)
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
async function encryptMachineAll(dec: Record<string, string>): Promise<Record<string, string>> {
  const raw: Record<string, string> = {}
  for (const [k, v] of Object.entries(dec)) raw[k] = typeof v === 'string' && v !== '' ? await encMach(v) : v
  return raw
}
async function decryptMachineAll(raw: Record<string, string>): Promise<Record<string, string>> {
  const dec: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw)) dec[k] = typeof v === 'string' && v.startsWith(MACH_PREFIX) ? await decMach(v.slice(MACH_PREFIX.length)) : v
  return dec
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

/** 一次 PowerShell 进程批量加/解密多份（base64 入，base64 出，逐行对应） */
function dpapiBatch(script: string, b64In: string[]): Promise<string[]> {
  if (b64In.length === 0) return Promise.resolve([])
  return new Promise((resolve, reject) => {
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
}

async function dpapiProtect(plainUtf8: string): Promise<string> {
  const [enc] = await dpapiBatch(DPAPI_ENC, [Buffer.from(plainUtf8, 'utf8').toString('base64')])
  return enc
}

async function dpapiUnprotect(encB64: string): Promise<string> {
  const [plainB64] = await dpapiBatch(DPAPI_DEC, [encB64])
  return Buffer.from(plainB64, 'base64').toString('utf8')
}

/** 整表批量加密 plain → `enc:dpapi:` 条目（一次 PowerShell 进程，失败回退逐条） */
async function encryptAll(dec: Record<string, string>): Promise<Record<string, string>> {
  const entries = Object.entries(dec).filter(([, v]) => typeof v === 'string' && v !== '')
  const raw: Record<string, string> = { ...dec }
  if (entries.length === 0) return raw
  const inputs = entries.map(([, v]) => Buffer.from(v, 'utf8').toString('base64'))
  let outs: string[]
  try {
    outs = await dpapiBatch(DPAPI_ENC, inputs)
  } catch {
    outs = []
    for (const v of entries.map(([, v]) => v)) outs.push(await dpapiProtect(v))
  }
  entries.forEach(([k], i) => {
    raw[k] = DPAPI_PREFIX + outs[i]
  })
  return raw
}

/** 整表批量解密 `enc:dpapi:` 条目 → 明文（一次 PowerShell 进程，失败回退逐条） */
async function decryptAll(raw: Record<string, string>): Promise<Record<string, string>> {
  const encs = Object.entries(raw).filter(([, v]) => typeof v === 'string' && v.startsWith(DPAPI_PREFIX))
  const dec: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw)) dec[k] = typeof v === 'string' ? v : ''
  if (encs.length === 0) return dec
  const inputs = encs.map(([, v]) => v.slice(DPAPI_PREFIX.length))
  let outs: string[]
  try {
    outs = await dpapiBatch(DPAPI_DEC, inputs)
  } catch {
    outs = []
    for (const b64 of inputs) outs.push(await dpapiUnprotect(b64))
  }
  encs.forEach(([k], i) => {
    dec[k] = Buffer.from(outs[i], 'base64').toString('utf8')
  })
  return dec
}

// file 后端的解密缓存：扩展转发每请求读 key，缓存避免每请求 spawn 子进程。
let fileCache: Record<string, string> | null = null

/** 读取 file 后端解密表；win32 首次加载会把存量明文自动加密迁移（整表一次进程） */
async function loadFileSecrets(): Promise<Record<string, string>> {
  if (fileCache) return fileCache
  let raw: Record<string, string> = {}
  const text = await readTextIfExists(secretsPath())
  if (text) {
    try {
      raw = JSON.parse(text)
    } catch {
      raw = {}
    }
  }
  if (CAN_DPAPI) {
    const dec = await decryptAll(raw)
    const hasLegacyPlain = Object.values(raw).some(
      (v) => typeof v === 'string' && v !== '' && !v.startsWith(DPAPI_PREFIX)
    )
    if (hasLegacyPlain) {
      await atomicWrite(secretsPath(), JSON.stringify(await encryptAll(dec), null, 2) + '\n', 0o600)
    }
    fileCache = dec
    return dec
  }
  if (CAN_MACH) {
    const dec = await decryptMachineAll(raw)
    const hasLegacyPlain = Object.values(raw).some(
      (v) => typeof v === 'string' && v !== '' && !v.startsWith(MACH_PREFIX)
    )
    if (hasLegacyPlain) {
      await atomicWrite(secretsPath(), JSON.stringify(await encryptMachineAll(dec), null, 2) + '\n', 0o600)
    }
    fileCache = dec
    return dec
  }
  warnPlainFileOnce()
  fileCache = raw
  return raw
}

/** 解密表整体加密写回文件（file 后端；整表一次进程，而非逐条） */
async function writeFileSecrets(dec: Record<string, string>): Promise<void> {
  const raw = CAN_DPAPI ? await encryptAll(dec) : CAN_MACH ? await encryptMachineAll(dec) : { ...dec }
  await atomicWrite(secretsPath(), JSON.stringify(raw, null, 2) + '\n', 0o600)
  fileCache = dec
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
  const store = await loadFileSecrets()
  store[id] = value
  await writeFileSecrets(store)
  return makeKeyRef('file', id)
}

/** 批量写入多个 key（导入用）：file/dpapi 后端只做一次整表写盘，避免逐 key 重写；
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
  const store = await loadFileSecrets()
  for (const [id, val] of Object.entries(entries)) {
    store[id] = val
    refs[id] = makeKeyRef('file', id)
  }
  await writeFileSecrets(store)
  return refs
}

export async function deleteSecret(ref: string): Promise<void> {
  const { scheme, id } = parseKeyRef(ref)
  if (scheme === 'keychain' || scheme === 'secret-service') {
    await removeExternal(scheme, id)
    return
  }
  if (scheme !== 'file') return
  const store = await loadFileSecrets()
  delete store[id]
  await writeFileSecrets(store)
}