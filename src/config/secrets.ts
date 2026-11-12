import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { stat as fsStat } from 'node:fs/promises'
import { secretsPath } from '../util/paths.js'
import { atomicWrite, readTextIfExists, withFileLock } from '../util/fsx.js'
import { t } from '../util/i18n.js'
import { debugLog, debugOn } from '../gateway/state/debuglog.js'

const exec = promisify(execFile)

// 外部子进程统一超时：钥匙环工具 / PowerShell 挂死（AV 扫描、DPAPI 故障、钥匙环守护僵死）
// 不能让 getSecret 永久 pending——relay 在发上游请求**之前** await getSecret，挂着即请求悬挂、
// pending 逐请求累积，failover 的 candidateSkip（key 读失败跳下一候选）也永远走不到。
// 超时强杀 + 普通错误上抛：getSecret / loadFileSecrets 的既有包装会把错误转成可操作
// SecretsError（relay 已把 SecretsError 转 candidateSkip，天然收敛）。
// 10s 给 PowerShell 冷启动 + 批量条目留足余量；探测类调用（hasSecretTool）仍用各自的短超时。
let childTimeoutMs = 10_000
export function __testSetChildTimeoutMs(ms?: number): void {
  childTimeoutMs = ms ?? 10_000
}

interface ChildTimeoutGuard {
  timedOut: () => boolean
  dispose: () => void
  timeoutError: () => Error
}

/** 给 spawn 的子进程挂超时强杀守卫：到点 kill（SIGKILL；Windows 等价 TerminateProcess），
 *  close/error 处必须调 dispose() 清定时器。导出仅供单测直驱（挂一个长睡子进程验 kill）。 */
export function armChildTimeout(child: ReturnType<typeof spawn>, label: string): ChildTimeoutGuard {
  let fired = false
  const timer = setTimeout(() => {
    fired = true
    try { child.kill('SIGKILL') } catch { /* 已退出 */ }
  }, childTimeoutMs)
  timer.unref?.()
  return {
    timedOut: () => fired,
    dispose: () => clearTimeout(timer),
    timeoutError: () => new Error(t('{label} 超时（{ms}ms 无退出），已强制终止——外部工具可能挂死，重试或改用 file 存储', '{label} timed out after {ms}ms and was killed — the external tool may be hung; retry or switch to file storage', { label, ms: String(childTimeoutMs) })),
  }
}

/** promisify(execFile) 的超时选项（keychain 的 exec 调用族用）：execFile 原生支持 timeout 到点杀。 */
function execChildOpts(): { timeout: number; killSignal: 'SIGKILL' } {
  return { timeout: childTimeoutMs, killSignal: 'SIGKILL' }
}

export type SecretBackend = 'file' | 'keychain' | 'secret-service'

/** secrets.json 损坏 / 不可操作时的可操作报错（对照 store.ts 的 ConfigError） */
export class SecretsError extends Error {
  /** 可操作修复建议（CLI 统一出口打「提示: …」、网关 errorReply 放 modeldock.hint） */
  hint?: string
  constructor(msg: string, hint?: string) {
    super(msg)
    this.name = 'SecretsError'
    this.hint = hint
  }
}

/** secrets.json 写锁文件路径（与 config.toml 的 .lock 同语义、独立文件，互不串扰） */
export const secretsLockPath = () => secretsPath() + '.lock'

export interface KeyRef {
  scheme: 'file' | 'keychain' | 'secret-service' | 'env' | 'plain'
  id: string
}

export function parseKeyRef(ref: string): KeyRef {
  // 非 string（undefined/null：config.toml 条目缺 key_ref 字段、手编坏值）此前直接崩
  // `ref.startsWith` 的 TypeError 栈——转发热路径（relay）与控制台 overview 都会把
  // provider.key_ref 原样喂进来。改可操作报错（CORRECT 口径：宽容解析只会推迟暴露）。
  // 空串不在此抛：maintenance/collect 以 `parseKeyRef(p.key_ref ?? '')` 当「无 ref」哨兵
  // 解析 .scheme，空串落 plain 才是既有语义；空 plain 的拒绝在 getSecret 层。
  if (typeof ref !== 'string') {
    throw new SecretsError(
      t('key_ref 非法（收到 {got}）：provider 条目缺 key_ref 字段', 'key_ref is invalid (got {got}): a provider entry is missing its key_ref field', { got: ref === undefined ? 'undefined' : ref === null ? 'null' : typeof ref }),
      t('检查 config.toml 对应 [providers.*] 条目补上 key_ref（modeldock provider set-key <服务ID> 重设），或修正手编的坏值', 'Check the [providers.*] entry in config.toml and set key_ref (modeldock provider set-key <serviceId> to re-set it), or fix the hand-edited value')
    )
  }
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
 *  win32→file（其内部用 DPAPI 加密），darwin→keychain，linux→secret-service（无钥匙环则回退 file）。
 *  沙箱（MODELRDOCK_FAKE_HOME，dev/测试重定向 home）一律返回 file：keychain/secret-service 是机器级
 *  全局存储、不随 home 重定向隔离，沙箱里写/删钥匙环条目动的是生产实例的密钥。附带效果：
 *  migrateSecretsToSecure 在沙箱因 target==='file' 直接 no-op，不会把沙箱密钥迁进真钥匙环。 */
export async function defaultStore(): Promise<SecretBackend> {
  if (process.env.MODELRDOCK_FAKE_HOME) return 'file'
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
    const guard = armChildTimeout(child, 'secret-tool')
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    child.on('error', (e) => { guard.dispose(); reject(e) })
    child.on('close', (code) => {
      guard.dispose()
      if (guard.timedOut()) return reject(guard.timeoutError())
      if (op === 'lookup') resolve(out.trim())
      else if (code === 0) resolve(out.trim())
      else reject(new Error(err.trim() || `secret-tool exited ${code}`))
    })
    if (op === 'store' && secret != null) {
      // 同上：子进程早退时 stdin EPIPE 不能崩整个进程
      child.stdin.on('error', () => {})
      child.stdin.end(Buffer.from(secret, 'utf8'))
    } else {
      child.stdin.on('error', () => {})
      child.stdin.end()
    }
  })
}

// 外部后端（keychain / secret-service）解密结果缓存：扩展转发每请求读 key，必须避免每请求 spawn 子进程。
// 带 60s TTL：keychain 这类外部源经其他进程 / 控制台直接改 key 不会产生文件事件，TTL 保证最迟 1 分钟生效；
// 命中路径仍是纯内存时间戳比较，不给转发热路径加 I/O。TTL 结构参考 src/adapters/presence.ts 的 regMemo。
const EXT_TTL = 60_000
const externalCache = new Map<string, { at: number; val: string | null }>()
const extKey = (scheme: string, id: string) => `${scheme}:${id}`
// TTL 过期瞬间的在途读取共享：不收敛则并发请求各自 spawn 一次 security/secret-tool（N 倍延迟尖峰）
const inflightExternal = new Map<string, Promise<string | null>>()

type ExternalReader = (scheme: 'keychain' | 'secret-service', id: string) => Promise<string | null>

/** 真实外部读取：keychain 经 `security find-generic-password`，secret-service 经 secret-tool。
 *  「条目不存在」返回 null（可缓存，避免未命中条目每请求都 spawn）；其他失败（钥匙环被锁、
 *  工具瞬时故障）向上抛——失败结果不进 60s 缓存，下一次读取立即重试。此前一切异常都当
 *  null 缓存 60s：钥匙环解锁前的整分钟内网关都在发无 key 请求（上游 401）。 */
const realReadExternal: ExternalReader = async (scheme, id) => {
  if (scheme === 'keychain') {
    try {
      const { stdout } = await exec('security', ['find-generic-password', '-s', 'modeldock', '-a', id, '-w'], execChildOpts())
      return stdout.trim() || null
    } catch (e) {
      // 44 = errSecItemNotFound：条目确实不存在，按 null（可缓存）；其余退出码 = 瞬时故障，上抛
      if ((e as { code?: unknown }).code === 44) return null
      throw e
    }
  } else {
    // secret-tool lookup 无匹配时退出码 1、输出为空（secretToolOp 对 lookup 一律 resolve 输出串）
    return (await secretToolOp('lookup', id)) || null
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
  const inflight = inflightExternal.get(ck)
  if (inflight) return inflight
  const task = (async () => {
    try {
      const val = await readExternal(scheme, id)
      // 只缓存成功读取（含「确认不存在」的 null）；readExternal 对瞬时故障上抛，任务 reject、
      // 缓存不落——外层 getSecret 转成可操作 SecretsError
      externalCache.set(ck, { at: Date.now(), val })
      return val
    } finally {
      inflightExternal.delete(ck)
    }
  })()
  inflightExternal.set(ck, task)
  return task
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
    return exec('security', ['add-generic-password', '-s', 'modeldock', '-a', id, '-w', value, '-U'], execChildOpts()).then(() => undefined)
  }
  return new Promise((resolve, reject) => {
    const child = spawn('security', ['-i'], { windowsHide: true })
    const guard = armChildTimeout(child, 'security')
    let err = ''
    child.stderr.on('data', (d) => (err += d))
    child.on('error', (e) => { guard.dispose(); reject(e) })
    child.stdin.on('error', () => {})
    child.on('close', (code) => {
      guard.dispose()
      // 交互模式 `-i`：逐行执行 stdin 的子命令直至 EOF；密钥在 stdin 而非 argv
      if (guard.timedOut()) return reject(guard.timeoutError())
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
  try {
    if (scheme === 'keychain') {
      await exec('security', ['delete-generic-password', '-s', 'modeldock', '-a', id], execChildOpts())
    } else {
      await secretToolOp('clear', id)
    }
  } catch (e) {
    // macOS 删不存在的条目返回 44（errSecItemNotFound）：等价删除成功。其余失败（钥匙环被锁等）
    // 上抛——旧 key 实际还在，绝不能把 null 写进缓存（TTL 过后旧值「复活」、UI 误报已删）
    if (!(scheme === 'keychain' && (e as { code?: unknown }).code === 44)) {
      externalCache.delete(extKey(scheme, id))
      throw new SecretsError(
        t('删除系统钥匙环条目失败（{scheme}:{id}）：{msg}', 'Failed to delete the system keyring entry ({scheme}:{id}): {msg}', { scheme, id, msg: (e as Error).message }),
        t('钥匙环可能被锁定——解锁后重试，或稍后再删（条目仍在，既有 key 不受影响）', 'The keyring may be locked — unlock it and retry, or delete later (the entry remains; existing keys keep working)')
      )
    }
  }
  externalCache.set(extKey(scheme, id), { at: Date.now(), val: null })
}

// Windows DPAPI 加密（file 后端在 win32 上加密存储）
// 值前缀 `enc:dpapi:<base64>`；密文绑定当前 Windows 账号，换账号/换机器后解不开
// （解不开时 loadFileSecrets 抛可操作 SecretsError 提示重设密钥，绝不回退明文——见其解密守卫）。
// 关键：整表批量加/解密用**一次** PowerShell 进程处理，避免每条目 spawn 子进程——逐条曾使
// 导入 6 个 key 慢到几十秒。payload 经 stdin 传、密钥不进命令行。
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
          const guard = armChildTimeout(child, 'powershell DPAPI')
          let out = ''
          let err = ''
          child.stdout.on('data', (d) => (out += d))
          child.stderr.on('data', (d) => (err += d))
          child.on('error', (e) => { guard.dispose(); reject(e) })
          child.stdin.on('error', () => {})
          child.on('close', (code) => {
            guard.dispose()
            if (guard.timedOut()) return reject(guard.timeoutError())
            if (code !== 0) return reject(new Error(err.trim() || `powershell exited ${code}`))
            resolve(out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean))
          })
          child.stdin.end(b64In.join('\n'))
        })
      } catch (e) {
        lastErr = e
      }
    }
    // debug 探针：DPAPI 是 Windows daemon 读写密钥的必经 spawn，失败此前只在上抛链可见，
    // 上层吞掉时（如导入路径）完全无痕。明文绝不入日志（密钥走 stdin，err 是 PowerShell 报错）
    if (debugOn()) {
      debugLog('spawn', 'dpapi', { ok: false, attempts: 2, err: String((lastErr as Error)?.message ?? lastErr).slice(0, 200) })
    }
    throw lastErr
  })()
}

// 整表加解密统一模型（DUP-07：encryptAll/decryptAll 与 encryptMachineAll/decryptMachineAll 同构
// 双实现合并）：file 后端按平台一次选定加密方案，读/写分支只认 { prefix, encryptTable, decryptTable }。
// win32→DPAPI（逐条 spawn 曾致几十秒，改用整表一次 PowerShell），linux 无钥匙环→machine-id 绑定 AES，
// 其余→明文。

export interface FileCipher {
  prefix: string
  enabled: boolean
  /** 整表解密：raw（带 prefix 的密文表）→ 明文表；未带 prefix 的值原样透传（存量明文/普通值） */
  decryptTable: (raw: Record<string, string>) => Promise<Record<string, string>>
  /** 整表加密：dec（明文表）→ 带 prefix 的密文表；空值/已带 prefix 原样保留。
   *  reuse（可选，perf-secrets-cache）：写路径的「未变更条目复用原密文」凭据——raw[k] 是上一版
   *  盘上密文、plain[k] 是与之配对的明文（fileCache 的 raw↔snapshot 对）；dec[k] === plain[k]
   *  且 raw[k] 带本方案 prefix 的条目直接沿用 raw[k]，不送加密（密文非确定性，重加密纯浪费）。
   *  传了 reuse 也只信「带 prefix 的密文」：明文残留（迁移中盘表）不会被当密文复用。 */
  encryptTable: (dec: Record<string, string>, reuse?: { raw: Record<string, string>; plain: Record<string, string> }) => Promise<Record<string, string>>
}

/** secrets.json 写路径锁超时的可操作报错（对照 config 的 ConfigError 用 SecretsError 分流） */
function secretsLockTimeoutError(lp: string): SecretsError {
  return new SecretsError(
    t('secrets.json 写锁超时：{lp} 被其他进程长期占用', 'Timed out acquiring the secrets write lock: {lp} has been held by another process for too long', { lp }),
    t('确认没有其他 modeldock 进程在写密钥后，可删除该 .lock 文件重试', 'After confirming no other modeldock process is writing keys, delete the .lock file and retry')
  )
}

export const dpapiCipher: FileCipher = {
  prefix: DPAPI_PREFIX,
  enabled: CAN_DPAPI,
  async encryptTable(dec, reuse) {
    const raw: Record<string, string> = { ...dec }
    if (reuse) {
      // 未变更条目回填原密文：带 prefix 才可信（见 FileCipher.encryptTable 注）
      for (const [k, v] of Object.entries(dec)) {
        const prevC = reuse.raw[k]
        if (typeof v === 'string' && v !== '' && typeof prevC === 'string' && prevC.startsWith(DPAPI_PREFIX) && reuse.plain[k] === v) {
          raw[k] = prevC
        }
      }
    }
    const entries = Object.entries(raw).filter(
      ([, v]) => typeof v === 'string' && v !== '' && !v.startsWith(DPAPI_PREFIX)
    )
    if (entries.length === 0) return raw
    const outs = await dpapiBatch(DPAPI_ENC, entries.map(([, v]) => Buffer.from(v, 'utf8').toString('base64')))
    if (outs.length < entries.length) {
      throw new SecretsError(
        t('DPAPI 加密表行数与输入不匹配（{got}/{want}），secrets.json 可能未完整加密', 'DPAPI encrypt output line count ({got}/{want}) does not match input; secrets.json may be incompletely encrypted', { got: String(outs.length), want: String(entries.length) }),
        t('请重新写入密钥后重试', 'Re-set your keys and retry')
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
        t('DPAPI 解密表行数与输入不匹配（{got}/{want}），secrets.json 可能已损坏', 'DPAPI decrypt output line count ({got}/{want}) does not match input; secrets.json may be corrupted', { got: String(outs.length), want: String(encs.length) }),
        t('可备份后删除该文件，各密钥重新设置', 'Back it up, delete it, and re-set your keys')
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
  async encryptTable(dec, reuse) {
    const raw: Record<string, string> = {}
    for (const [k, v] of Object.entries(dec)) {
      const prevC = reuse?.raw[k]
      if (
        typeof v === 'string' && v !== '' && !v.startsWith(MACH_PREFIX) &&
        typeof prevC === 'string' && prevC.startsWith(MACH_PREFIX) && reuse?.plain[k] === v
      ) {
        raw[k] = prevC
        continue
      }
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
  async encryptTable(dec, _reuse) {
    return { ...dec }
  },
  async decryptTable(raw) {
    return { ...raw }
  },
}

/** 测试注入的 file 后端加密方案（跨平台守卫分支无法按平台到达，如在本机强制 plainCipher）；
 *  undefined=按平台真实选定。与既有 __testSetDpapiBatch 同套路：模块内 let 替换，不碰 vi.mock 跨文件雷区。 */
let cipherOverride: FileCipher | undefined
export function __testSetFileCipher(c?: FileCipher): void {
  cipherOverride = c
}

/** 按平台一次选定 file 后端加密方案（DPAPI > machine-id AES > 明文） */
export function pickFileCipher(): FileCipher {
  if (cipherOverride) return cipherOverride
  if (CAN_DPAPI) return dpapiCipher
  if (CAN_MACH) return machCipher
  return plainCipher
}

// file 后端的解密缓存：扩展转发每请求读 key，缓存避免每请求 spawn 子进程。
// 缓存按 secrets.json 路径归属（path + data）：切换 MODELRDOCK_FAKE_HOME（测试多沙箱）或换数据源时，
// 路径不同自然失效，避免拿上一份数据（home）的缓存污染当前读取。单 home 生产下路径恒定，行为同旧缓存。
// key = 填缓存**前**取的盘上指纹（mtimeMs:size；stat 先于读——读之后才落盘的并发写会使盘上
// mtime 变化，下次回验必然 miss，不会把新指纹配旧数据）。指纹回验两用：
// ① 写路径锁内「新鲜读」凭指纹相等直接复用解密表——file 后端全部写路径过同一把锁，持锁期间
//   无并发写者，指纹相等即缓存必然反映盘上当前内容（win32 省一次 PowerShell 解密 spawn，
//   写路径锁内从此通常只剩加密一次）；
// ② 读路径周期回验兜底 watcher 漏事件：另一进程改 key 最迟一个回验周期生效；窗口内转发热路径
//   零 I/O（旧实现是纯内存时间戳比较直到显式失效，此处保持每窗口至多一次 stat 的回验节奏）。
// raw/snapshot 配对（perf-secrets-cache）：raw 是生成 data 时的盘上密文表（raw[k] 解密必得
// snapshot[k]）、snapshot 是与之配对的明文快照——writeFileSecrets 写回时「明文 == snapshot」的
// 条目沿用 raw 原密文不再重加密；缺失 = 无法按条
// 复用，整表加密（保守）。mutateFileSecrets 会原地改 data 返回值，写路径判「条目未变更」必须比对
// snapshot 而非 data 本身。
const FILE_RECHECK_MS = 5_000
let fileCache: {
  path: string
  key: string
  data: Record<string, string>
  checkedAt: number
  /** 生成 data 时的盘上原始密文表（明文后端 = 原表拷贝）；缺失 = 写路径无法按条复用原密文 */
  raw?: Record<string, string>
  /** 与 raw 配对的明文快照（缓存写入时刻的 data 拷贝），见上方配对说明 */
  snapshot?: Record<string, string>
} | null = null

/** secrets.json 盘上指纹；stat 失败（文件不存在）返回 null。 */
async function secretsStatKey(): Promise<string | null> {
  try {
    const st = await fsStat(secretsPath())
    return `${st.mtimeMs}:${st.size}`
  } catch {
    return null
  }
}

let secretsRawImpl: (() => Promise<Record<string, string>>) | undefined
export function __testSetSecretsRawReader(fn?: () => Promise<Record<string, string>>): void {
  secretsRawImpl = fn
}

/** 读 secrets.json 原始明文表；损坏抛可操作 SecretsError（不再静默当「无密钥」） */
async function readSecretsRaw(): Promise<Record<string, string>> {
  if (secretsRawImpl) return secretsRawImpl()
  const text = await readTextIfExists(secretsPath())
  if (!text) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (e) {
    throw new SecretsError(
      t('secrets.json 解析失败：{msg}\n文件路径：{p}', 'Failed to parse secrets.json: {msg}\nPath: {p}', { msg: (e as Error).message, p: secretsPath() }),
      t('请备份后删除或修正该文件，各密钥重新设置即可', 'Back up, then delete or fix this file; re-set your keys afterwards')
    )
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new SecretsError(
      t('secrets.json 内容不是密钥表对象（当前是{kind}）。文件路径：{p}', 'secrets.json is not a key-table object (got {kind}). Path: {p}', { kind: Array.isArray(parsed) ? '数组/array' : typeof parsed, p: secretsPath() }),
      t('请备份后删除或修正该文件，各密钥重新设置即可', 'Back up, then delete or fix this file; re-set your keys afterwards')
    )
  }
  return parsed as Record<string, string>
}

// 并发去重单飞：overview 的 keyPresence 会对全部 provider 并发 getSecret，缓存冷时若各自走
// loadFileSecrets，DPAPI 后端（win32 整表解密 spawn 一次 PowerShell）会并发 spawn 12 份、12 次重复
// 读盘——12 个 PowerShell 冷启动同时抢 CPU 正是 Windows 首屏秒级尖峰的大头。读请求共享同一次
// 读盘+解密；写路径（useCache=false，锁内强制重读）不参与合并，保持锁内新鲜语义。
let fileLoadInflight: Promise<Record<string, string>> | null = null

/** 读盘 → 异源密文守卫 → 解密 → 存量明文迁移写；成功后以「读取前指纹」回填解密缓存。
 *  指纹在 stat 先于读的时序下取：读完成后才落盘的并发写会使盘上 mtime 变化，下次回验必然
 *  miss 重读，不会把新指纹配旧数据。 */
async function readAndDecryptSecrets(): Promise<Record<string, string>> {
  const path = secretsPath()
  let key = await secretsStatKey()
  const raw = await readSecretsRaw()
  const cipher = pickFileCipher()
  // 异平台密文守卫：跨机器拷贝 home（如 Linux 的 enc:mach: 落到 win，或 enc:dpapi: 落到 linux/mac）
  // 时，异源密文不带本平台 prefix，会被当「存量明文」再包一层加密（加密后端）或原样当 key 发上游
  // （明文后端）——原值永久丢失，发上游 401。守卫必须盖住明文后端（enabled=false 的早退分支之前）：
  // plainCipher prefix='' 时 startsWith('') 恒真会让异源密文整类漏报，前缀为空时 enc: 即异源
  // （对齐 diag.ts detectForeignCipherRefs 口径）。检测到异源前缀即抛可操作错误，绝不重加密。
  const foreign = Object.entries(raw).find(
    ([, v]) => typeof v === 'string' && v.startsWith('enc:') && !(cipher.prefix && v.startsWith(cipher.prefix))
  )
  if (foreign) {
    const fp = foreign[1].slice(0, foreign[1].indexOf(':', 4) + 1)
    throw new SecretsError(
      t('secrets.json 的「{k}」是其他平台/机器加密的密文（{p} 前缀），本机无法解密', '"{k}" in secrets.json is ciphertext encrypted on another machine/platform ({p} prefix) and cannot be decrypted here', { k: foreign[0], p: fp }),
      t('请在本机重新设置各密钥（modeldock provider set-key），不要直接拷贝 secrets.json', 'Re-set the keys on this machine (modeldock provider set-key) instead of copying secrets.json')
    )
  }
  if (!cipher.enabled) {
    warnPlainFileOnce()
    fileCache = { path, key: key ?? '', data: raw, checkedAt: Date.now(), raw: { ...raw }, snapshot: { ...raw } }
    return raw
  }
  const hasLegacyPlain = Object.values(raw).some(
    (v) => typeof v === 'string' && v !== '' && !v.startsWith(cipher.prefix)
  )
  let dec: Record<string, string>
  try {
    dec = await cipher.decryptTable(raw)
  } catch (e) {
    if (e instanceof SecretsError) throw e
    // 解不开（换 Windows 账号/换机器/文件损坏）：给可操作错误，不透传 PowerShell stderr / GCM 英文原文
    throw new SecretsError(
      t('secrets.json 解密失败（{msg}）：密文可能来自其他 Windows 账号或机器', 'Failed to decrypt secrets.json ({msg}): the ciphertext may come from another Windows account or machine', { msg: (e as Error).message }),
      t('请重新设置各密钥（modeldock provider set-key / Web 控制台「服务」页），或备份后删除 secrets.json 重建', 'Re-set your keys (modeldock provider set-key or the Services page in the web console), or back up and delete secrets.json to rebuild')
    )
  }
  // 迁移写成功则盘上已是 encTable（缓存 raw 跟着换成新密文表，写路径的按条复用凭据才与盘配对）；
  // 跳过/失败则维持本次读到的 raw（盘上不是它 → 下次指纹失配走完整解密，保守正确）。
  let cacheRaw: Record<string, string> = raw
  if (hasLegacyPlain) {
    // 明文→加密迁移写必须持锁 + 持锁后重读盘比对：本函数是热读路径（getSecret/verify 都触发），
    // 无锁整表写回会覆盖并发写进程（mutateFileSecrets 持锁「新鲜读→改→整表写回」）刚写入的 key
    // ——读进程拿旧表做迁移原子覆盖 = 丢更新竞态，用户刚设置的 key 静默丢失、引用悬空（转发 503）。
    // DPAPI 解密要 spawn PowerShell（秒级），窗口不小。持锁后盘上内容已被改过（≠ 本次读到的 raw）
    // 就跳过迁移写：本次会话仍返回 dec（读到的旧表），盘上以写进程的新表为准，下次冷读自然一致。
    // withFileLock 有 AsyncLocalStorage 重入豁免：mutateFileSecrets 持锁内走到这里不会自死锁。
    try {
      await withFileLock(secretsLockPath(), { timeoutError: secretsLockTimeoutError }, async () => {
        const fresh = await readSecretsRaw()
        if (JSON.stringify(fresh) === JSON.stringify(raw)) {
          // 迁移写也是自家写：宽限窗与写后指纹一并记上，watcher 的 secrets.json 事件不误失效缓存
          selfWriteAt = Date.now()
          const encTable = await cipher.encryptTable(dec)
          await atomicWrite(secretsPath(), JSON.stringify(encTable, null, 2) + '\n', 0o600)
          cacheRaw = encTable
          key = await secretsStatKey()
          selfWriteKey = key
        }
      })
    } catch (e) {
      // 迁移是安全优化不是正确性前提：key 已解出、本次读取照常返回，不因迁移失败拖死读路径
      //（锁被长期占用时宁可跳过也不等满超时）；留可观测告警，下次冷读自动重试迁移。
      console.error(t('[modeldock] secrets.json 明文→加密迁移写跳过/失败（不影响本次读取，下次读取重试）：{msg}', '[modeldock] secrets.json plaintext-to-encrypted migration skipped/failed (this read is unaffected; retried on next read): {msg}', { msg: (e as Error).message }))
    }
  }
  fileCache = { path, key: key ?? '', data: dec, checkedAt: Date.now(), raw: { ...cacheRaw }, snapshot: { ...dec } }
  return dec
}

/** 读取 file 后端解密表；win32/linux 首次加载会把存量明文自动加密迁移（整表一次进程）。
 *  @param useCache 默认读内存缓存（FILE_RECHECK_MS 窗口内零 I/O，窗口到 stat 回验，盘未变续期复用）。
 *  写路径传 false：跳过节流窗直接回验、指纹相等即复用缓存解密表（锁-指纹论据见上方 fileCache 块注）。 */
async function loadFileSecrets(useCache = true): Promise<Record<string, string>> {
  const cached = fileCache && fileCache.path === secretsPath() ? fileCache : null
  if (cached) {
    if (useCache && Date.now() - cached.checkedAt < FILE_RECHECK_MS) {
      return cached.data // 回验窗口内：纯内存命中（转发热路径零 I/O）
    }
    const k = await secretsStatKey()
    if (k !== null && k === cached.key) {
      cached.checkedAt = Date.now()
      return cached.data // 盘未变：续期复用（写路径锁内免一次解密 spawn；读路径免一次重读）
    }
  }
  if (useCache && fileLoadInflight) return fileLoadInflight
  const job = readAndDecryptSecrets()
  if (!useCache) return job
  fileLoadInflight = job
  try {
    return await job
  } finally {
    if (fileLoadInflight === job) fileLoadInflight = null
  }
}

// 自家写盘指纹与宽限窗：watcher 收到 secrets.json 事件时区分自家写与外部写。自家写已随写
// 更新 fileCache，再失效只会让下一次读取白付一次解密（win32 是一次 PowerShell spawn）；
// 宽限窗兜底 atomicWrite rename 事件与写后 stat 的竞速——事件先到时指纹还没记上，窗口内的
// secrets.json 事件都当自家写处理；外部极近的连续写由 loadFileSecrets 的回验周期兜底。
let selfWriteKey: string | null = null
let selfWriteAt = 0

/** 解密表整体加密写回文件（file 后端；整表一次进程，而非逐条）。
 *  未变更条目复用原密文（perf-secrets-cache）：以缓存 raw↔snapshot 配对为凭，明文未变的条目
 *  沿用旧密文，只对新增/变更条目出加密调用——全部未变时整次写 0 spawn（删 key、重设同值即此形态）；
 *  常规 set-key 只加密 1 条（一次 spawn），不再整表重加密。写后回填缓存（含新密文表与快照）
 *  与自家写指纹，下一次锁内新鲜读的指纹比对因此能命中。 */
async function writeFileSecrets(dec: Record<string, string>): Promise<void> {
  const cipher = pickFileCipher()
  const path = secretsPath()
  const prev = fileCache && fileCache.path === path && fileCache.raw && fileCache.snapshot
    ? { raw: fileCache.raw, plain: fileCache.snapshot }
    : undefined
  const raw = await cipher.encryptTable(dec, prev)
  selfWriteAt = Date.now()
  await atomicWrite(path, JSON.stringify(raw, null, 2) + '\n', 0o600)
  // 写后回填缓存与自家写指纹：缓存让本进程后续读零 I/O；指纹供 watcher 的事件回调区分自家写
  const key = await secretsStatKey()
  selfWriteKey = key
  fileCache = { path, key: key ?? '', data: dec, checkedAt: Date.now(), raw, snapshot: { ...dec } }
}

/** 写路径统一入口：跨进程锁（与 config 同语义）+ 锁内新鲜读拼最新的解密表，改后整表写回。
 *  锁内新鲜读按盘上指纹复用缓存解密表（loadFileSecrets(false)；锁-指纹论据见上方 fileCache 块注），跨进程丢更新防线不变。
 *  锁内的 DPAPI 加密（win32 spawn PowerShell，最坏 2 次 × 10s 超时 ≈ 20s）**有意留在临界区**，
 *  依赖 fsx 的持锁喂狗保活（acquireFileLock 心跳刷新锁 mtime，陈锁判定对活者永不满足）：
 *  解密已可凭指纹跳过；加密移不出锁——改后整表只有锁内才知道，而整表原子写必须发生在锁内。
 *  竞态防线见 test/secrets-lock.test.ts。 */
function mutateFileSecrets<T>(fn: (store: Record<string, string>) => T | Promise<T>): Promise<T> {
  return withFileLock(secretsLockPath(), { timeoutError: secretsLockTimeoutError }, async () => {
    const store = await loadFileSecrets(false)
    const ret = await fn(store)
    await writeFileSecrets(store)
    return ret
  })
}

/** 清除全部密钥缓存（file 后端整表解密缓存 + 外部后端 TTL 缓存）：测试与「确认要强制重读」的
 *  场景用。网关热加载路径不再走这里——config.toml 写不清密钥缓存（写者自带更新），失效收口为：
 *  watcher 收 secrets.json 事件走 {@link invalidateSecretsCacheIfExternal}（外部写即刻生效、自家写
 *  跳过），外加 fileCache 回验周期兜底 watcher 漏事件。 */
export function invalidateSecretsCache(): void {
  fileCache = null
  externalCache.clear()
}

/** watcher / 手动热加载口径的密钥缓存失效：secrets.json 事件到达时，自家刚写的按写后指纹与
 *  宽限窗跳过（缓存已随写更新），外部写才清——另一进程改 key 即刻（file）生效，不再牵连本进程
 *  白付一次解密。watcher 漏事件时由 loadFileSecrets 的回验周期兜底，最迟一个周期生效。 */
export async function invalidateSecretsCacheIfExternal(): Promise<void> {
  if (Date.now() - selfWriteAt < 1500) return
  const k = await secretsStatKey()
  if (k !== null && k === selfWriteKey) return
  invalidateSecretsCache()
}

/** doctor 体检用：验证 file 后端密钥表可读（解析/解密失败给可操作错误而不是抛出）。
 *  外部后端（keychain 等）不在此校验，仍由 getSecret 按条读取。 */
export async function verifySecretsStore(): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await loadFileSecrets()
    return { ok: true }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

/** provider 的 key 引用清单（多 key 池兼容口径）：keys 非空（过滤非串条目后）以其为准，
 *  否则回落 [key_ref]——向后兼容单 key 配置；两处都缺 = ['']（空 plain 哨兵），
 *  getSecret 层按既有语义给「key_ref 缺失/为空」可操作报错。key_ref 与 keys 同时配置时
 *  以 keys 为准（key_ref 仅为向后兼容保留，不并入池，避免同 key 重复占位）。 */
export function providerKeyRefs(p: { key_ref?: string; keys?: string[] }): string[] {
  const keys = Array.isArray(p.keys) ? p.keys.filter((k): k is string => typeof k === 'string') : []
  if (keys.length > 0) return keys
  return [p.key_ref ?? '']
}

/** provider 密钥的**全量可删清单**（purge/reset/provider rm/控制台删服务的删除口径）。
 *  与 providerKeyRefs 的差别：池存在时 key_ref 不参与转发，但仍可能持有独立的旧密钥条目
 *  （--add 追加不清 key_ref、去重只在池内做）——不可逆删除漏掉它会在系统钥匙环留下孤儿
 *  条目（secrets.json 随目录删除，外部后端条目删不掉）。空哨兵与重复引用剔除。 */
export function providerAllKeyRefs(p: { key_ref?: string; keys?: string[] }): string[] {
  const out = new Set(providerKeyRefs(p))
  if (typeof p.key_ref === 'string' && p.key_ref !== '') out.add(p.key_ref)
  out.delete('')
  return [...out]
}

/** 解析 provider 的整个 key 池：逐 ref 复用既有 scheme 解析（getSecret），单个 ref 解析失败
 *  （ SecretsError / 条目缺失 / env 未设 / 空 plain）只跳过该 key、不致命——池内其余 key 照常用。
 *  返回条目带 index（在 refs 数组中的原始位置）：key 级冷却态（state/keypool.ts）按该索引记账，
 *  与配置重载清零配合，保证索引语义稳定。绝不抛出：全部失败 = 空数组，由调用方决定兜底。 */
export async function resolveProviderKeys(
  refs: string[]
): Promise<Array<{ index: number; ref: string; key: string }>> {
  const out: Array<{ index: number; ref: string; key: string }> = []
  for (let i = 0; i < refs.length; i++) {
    try {
      const key = await getSecret(refs[i])
      if (key) out.push({ index: i, ref: refs[i], key })
    } catch {
      // 单个 ref 解析失败（key 缺失/钥匙环锁定/坏引用）：跳过该 key 不标记失效——
      // 失效标记只由上游 401/403 触发（401 = key 被上游拒绝；读不到 ≠ 无效）
    }
  }
  return out
}

/** 读取 provider key 池里第一把可读的 key（keys 池按序尝试，单 key 配置即 key_ref；全不可读/未配返回 null）。
 *  供「只关心有没有一把能用」的非转发场景：overview hasKey 展示、编辑弹窗用已保存 Key 拉模型等。
 *  不做冷却过滤——那是转发热路径的事（relay + state/keypool.ts）。绝不抛出。 */
export async function getFirstProviderSecret(p: { key_ref?: string; keys?: string[] }): Promise<string | null> {
  for (const ref of providerKeyRefs(p)) {
    try {
      const v = await getSecret(ref)
      if (v) return v
    } catch { /* 单把读不到（钥匙环锁定/坏引用）尝试下一把 */ }
  }
  return null
}

/** 读取 key；plain 代表明文内嵌在 config 里（不推荐，直接返回） */
export async function getSecret(ref: string): Promise<string | null> {
  const { scheme, id } = parseKeyRef(ref)
  if (scheme === 'plain') {
    // 空 plain = 条目缺 key_ref（或手编空值）：明文空 key 等于没配，拒绝并给可操作建议
    //（relay 转发 / overview keyPresence 都经这里，此前 undefined/空串会在 parseKeyRef 崩 TypeError 栈）
    if (id === '') {
      throw new SecretsError(
        t('key_ref 缺失或为空：provider 条目没有可用的 key 引用', 'key_ref is missing or empty: the provider entry has no usable key reference'),
        t('在「编辑服务」里填入 key（或 modeldock provider set-key <服务ID>），config.toml 的 key_ref 不能为空', 'Fill in the key in "Edit Service" (or modeldock provider set-key <serviceId>); key_ref in config.toml must not be empty')
      )
    }
    return id
  }
  if (scheme === 'env') return process.env[id] ?? null
  if (scheme === 'keychain' || scheme === 'secret-service') {
    try {
      return await getExternal(scheme, id)
    } catch (e) {
      if (e instanceof SecretsError) throw e
      throw new SecretsError(
        t('读取系统钥匙环失败（{scheme}:{id}）：{msg}', 'Failed to read the system keyring ({scheme}:{id}): {msg}', { scheme, id, msg: (e as Error).message }),
        t('钥匙环可能被锁定——解锁后重试；或改用 file 存储（config.toml [security] store="file"）后重新设置该 key', 'The keyring may be locked — unlock it and retry, or switch to file storage (config.toml [security] store="file") and re-set the key')
      )
    }
  }
  const store = await loadFileSecrets()
  const v = store[id]
  return typeof v === 'string' && v !== '' ? v : null
}

/** 写入 key，返回应写入 config 的 key_ref。
 *  沙箱守卫：即便调用方（如显式 security.store="keychain"）传入外部后端，也强制落沙箱 secrets.json。 */
export async function setSecret(id: string, value: string, backend: SecretBackend): Promise<string> {
  if (process.env.MODELRDOCK_FAKE_HOME && (backend === 'keychain' || backend === 'secret-service')) {
    backend = 'file'
  }
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
  if (process.env.MODELRDOCK_FAKE_HOME && (backend === 'keychain' || backend === 'secret-service')) {
    backend = 'file'
  }
  if (backend === 'keychain' || backend === 'secret-service') {
    // 各条目互不相依，并发写入——原串行 for-await 下 N 把 key = N 次 security/secret-tool spawn
    // 逐个等（每次几十 ms～秒级），多机同步 pull 在 config 锁内的持锁时长随条目数线性放大
    await Promise.all(
      Object.entries(entries).map(async ([id, val]) => {
        await setExternal(backend, id, val)
        refs[id] = makeKeyRef(backend, id)
      })
    )
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

/** 删除 key。沙箱跳过外部删除：外部存储机器级全局、不随 home 隔离，删的是生产条目（论据见 defaultStore 注） */
export async function deleteSecret(ref: string): Promise<void> {
  const { scheme, id } = parseKeyRef(ref)
  if (scheme === 'keychain' || scheme === 'secret-service') {
    if (process.env.MODELRDOCK_FAKE_HOME) return
    await removeExternal(scheme, id)
    return
  }
  if (scheme !== 'file') return
  return mutateFileSecrets((store) => {
    delete store[id]
  })
}