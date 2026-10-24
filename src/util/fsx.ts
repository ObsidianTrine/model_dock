import fsp from 'node:fs/promises'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { homeDir, modeldockDir, sandboxNpmBinDir } from './paths.js'
import { t } from './i18n.js'

export async function ensureDir(dir: string, mode = 0o700): Promise<void> {
  await fsp.mkdir(dir, { recursive: true, mode })
}

export function sha256(data: string | Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex')
}

/** Windows 可执行文件的后缀（PATHEXT 常见子集，npm 全局 shim 是 .cmd/.exe） */
const WIN_EXE_SUFFIXES = ['.exe', '.cmd', '.bat']

// overview 每轮对每个适配器调 present → commandOnPath①，单次全量扫描含数百次同步 syscall
//（PATH 逐目录 existsSync/statSync/readdirSync + nvm/托管 runtime/Homebrew 兜底）。PATH/APPDATA/
// modeldockDir 探测范围内路径在本进程生命周期内基本不变，按 (调用形态, cmd) 做短 TTL memo。
// 与 presence.ts 的 regMemo「60s 延迟可接受」同思路：安装/卸载后最多延迟 TTL 反映，可接受。
// TTL 取 2 分钟：命令装卸是低频事件且装/卸路径已有主动 clearCommandMemo 失效——45s 时与
// overview 5s 轮询组合，稳态下每 ~45s 必产生一轮全 PATH 同步重扫脉冲，无法收敛
const COMMAND_TTL = 120_000
const commandMemo = new Map<string, { at: number; val: string | null }>()

/** 清空 PATH 探测 memo（测试用，或安装/卸载后主动失效）。 */
export function clearCommandMemo(): void {
  commandMemo.clear()
}

function memoGet(key: string): string | null | undefined {
  const e = commandMemo.get(key)
  if (!e) return undefined
  if (Date.now() - e.at >= COMMAND_TTL) {
    commandMemo.delete(key)
    return undefined
  }
  return e.val
}

/** 探测某命令对应的可执行文件是否存在（纯文件探测，不 spawn 子进程）。
 *  PATH 逐目录查找之外还要兜底扫常见安装位置：LaunchAgent/SEA GUI 场景的 PATH
 *  常缺 nvm/Homebrew/npm 全局目录，只查 PATH 会把已装命令误判成未安装。 */
export function commandOnPath(cmd: string): boolean {
  return commandOnPathResolved(cmd) !== null
}

/** 沙箱感知探测：非沙箱与 commandOnPath 等价；FAKE_HOME 下只认落点在沙箱 home 内的命中
 *  （沙箱 npm-global bin、托管 runtime、fake home 本地 bin）——宿主真机的同名命令不算数。
 *  沙箱是独立的「全新机器」：装/卸/接入状态只反映沙箱自身，否则卸载沙箱副本后卡片仍因
 *  宿主 PATH 上的同名命令显示已安装（2026-10-11 dev 沙箱实测踩中）。仅用于可装进沙箱的
 *  npm 类客户端；桌面/脚本类客户端只有真机一份拷贝，presence 仍走并集（commandOnPath）。
 *  注意不能「取首命中再判位置」——宿主与沙箱都有同名命令时首命中必是宿主（PATH 优先），
 *  须带谓词扫到沙箱内命中为止。 */
export function commandOnPathSandbox(cmd: string): boolean {
  if (!process.env.MODELRDOCK_FAKE_HOME) return commandOnPath(cmd)
  return (
    commandOnPathResolved(cmd, (p) => {
      const rel = path.relative(homeDir(), p)
      return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
    }) !== null
  )
}

/** 同 commandOnPath，但返回命中的可执行文件绝对路径（供注入子进程 PATH）。
 *  探测范围额外含 ModelDock 托管 Node 运行时的 bin 目录（客户端装进托管 prefix 后 probe 能命中）。
 *  accept：命中过滤谓词（commandOnPathSandbox 用）——不满足时继续向后扫，而非整场判负。
 *
 *  memo：查询结果按「调用形态 + cmd」缓存（见顶 COMMAND_TTL）。FAKE_HOME 下完全绕过——沙箱内
 *  装/卸状态必须对 status/detect 即时可见（2026-10-10 空 PATH 关卡 flakiness、2026-10-11「装完
 *  立即可见」前车之鉴），且 accept 谓词只出现在沙箱路径，故以「是否带谓词」作缓存形态分隔，
 *  无谓词（commandOnPath / noderuntime）与带谓词（commandOnPathSandbox）结果不互污染——谓词
 *  是函数不能当键，但两种形态的键空间隔离即可保证正确。 */
export function commandOnPathResolved(cmd: string, accept?: (p: string) => boolean): string | null {
  const useMemo = !process.env.MODELRDOCK_FAKE_HOME
  const key = `\u0000${accept ? 1 : 0}\u0000${process.platform}\u0000${cmd}`
  if (useMemo) {
    const hit = memoGet(key)
    if (hit !== undefined) return hit
  }
  const result = commandOnPathResolvedImpl(cmd, accept)
  if (useMemo) commandMemo.set(key, { at: Date.now(), val: result })
  return result
}

function commandOnPathResolvedImpl(cmd: string, accept?: (p: string) => boolean): string | null {
  const isWin = process.platform === 'win32'
  const names = isWin ? [cmd, ...WIN_EXE_SUFFIXES.map((s) => cmd + s)] : [cmd]
  const dirs = (process.env.PATH ?? '').split(isWin ? ';' : ':').filter(Boolean)
  // Windows npm i -g 的 shim 落在 %APPDATA%\npm，用户改过 PATH 时不在其中
  if (isWin && process.env.APPDATA) dirs.push(path.join(process.env.APPDATA, 'npm'))
  // nvm/用户级 bin 走 homeDir()：FAKE_HOME 下中性化，避免宿主机真实工具链泄漏进「空 PATH」类测试
  const home = homeDir()
  // 托管 Node 运行时（<modeldockDir>/runtime/node/v*/）：unix shim 在 bin/ 下，win 平铺在版本目录
  try {
    const root = path.join(modeldockDir(), 'runtime', 'node')
    dirs.push(
      ...fs.readdirSync(root).map((v) => (isWin ? path.join(root, v) : path.join(root, v, 'bin')))
    )
  } catch { /* 无托管运行时 */ }
  // 沙箱模式（FAKE_HOME）下 npm 全局安装被重定向进 <modeldockDir>/npm-global：探测必须看见
  // 落进沙箱的 shim，装完的 detect/status/probe 才成立（宿主全局 prefix 不会被写入）
  const sandboxBin = sandboxNpmBinDir()
  if (sandboxBin) dirs.push(sandboxBin)
  for (const dir of dirs) {
    for (const name of names) {
      try {
        const p = path.join(dir, name)
        if (fs.existsSync(p) && fs.statSync(p).isFile() && (!accept || accept(p))) return p
      } catch { /* 目录不可读/无权限，跳过 */ }
    }
  }
  if (isWin) return null
  let nvmShims: string[] = []
  try {
    // LaunchAgent 的 PATH 里没有 nvm 当前版本目录：把 ~/.nvm 下各已装版本的 bin 全扫一遍
    const root = path.join(home, '.nvm', 'versions', 'node')
    nvmShims = fs.readdirSync(root).map((v) => path.join(root, v, 'bin', cmd))
  } catch { /* 没有 nvm */ }
  const wellKnown = [
    // 机器级绝对路径（系统/Homebrew prefix）在 FAKE_HOME 下跳过：它们不受沙箱重定向，
    // 宿主任意时刻装/卸命令都会让「空 PATH」类 fakeHome 测试结果漂移（2026-10-10 实测踩中：
    // 用户往 /usr/local/bin 装了 claude，adapters.test 的「未安装」用例转假）。
    // 真实沙箱实例不受影响——PATH 扫描先于本兜底，/usr/local/bin 照常经 PATH 命中。
    ...(process.env.MODELRDOCK_FAKE_HOME
      ? []
      : [`/usr/local/bin/${cmd}`, `/opt/homebrew/bin/${cmd}`]),
    path.join(home, '.local', 'bin', cmd),
    ...nvmShims,
  ]
  for (const p of wellKnown) {
    try {
      if (fs.existsSync(p) && fs.statSync(p).isFile() && (!accept || accept(p))) return p
    } catch { /* 单个位置不可读，继续 */ }
  }
  return null
}

export async function fileSha256(p: string): Promise<string> {
  // 流式 hash：更新包 / Node 运行时包 50–150MB，整读内存峰值 ≈ 包体积（低配 Windows 可感）
  const h = crypto.createHash('sha256')
  for await (const chunk of fs.createReadStream(p)) h.update(chunk as Buffer)
  return h.digest('hex')
}

/** tmp + rename 原子写，显式设置权限位；rename 前 fsync，断电场景不留半截文件 */
export async function atomicWrite(file: string, content: string | Buffer, mode = 0o600): Promise<void> {
  await ensureDir(path.dirname(file))
  const tmp = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${Math.random().toString(36).slice(2, 8)}`
  )
  const fh = await fsp.open(tmp, 'w', mode)
  try {
    await fh.writeFile(content)
    await fh.chmod(mode)
    await fh.sync()
  } finally {
    await fh.close()
  }
  // Windows：rename 覆盖已有文件时，若目标正被其他进程短暂打开（网关热加载读配置、杀毒扫描）
  // 会抛 EPERM/EACCES（libuv 的 REPLACE_EXISTING 不重试）。小步退避重试数次，unix 语义不变。
  const backoff = process.platform === 'win32' ? [50, 150, 400] : []
  for (;;) {
    try {
      await fsp.rename(tmp, file)
      return
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      const delay = backoff.shift()
      if (delay === undefined || !shouldRetryAtomicWrite(code)) {
        await fsp.rm(tmp, { force: true }).catch(() => {}) // 失败时清掉残留 tmp（旧行为会遗留在目标目录）
        throw e
      }
      await new Promise((r) => setTimeout(r, delay))
    }
  }
}

/** atomicWrite 覆盖写失败的错误码是否值得重试。Windows rename 覆盖被占文件时，libuv 把
 *  ERROR_ACCESS_DENIED / ERROR_SHARING_VIOLATION 映射为 EPERM / EACCES / EBUSY——杀毒、编辑器、
 *  备份扫描等短暂占用（EBUSY 最常见）；ENOENT 等目标缺失类错误重试无意义，直接失败。
 *  纯函数导出便于跨平台单测（unix 上 backoff 为空数组本就进不了重试循环，抽函数不影响行为）。 */
export function shouldRetryAtomicWrite(code: string | undefined): boolean {
  return code === 'EPERM' || code === 'EACCES' || code === 'EBUSY'
}

export async function readTextIfExists(p: string): Promise<string | null> {
  let buf: Buffer
  try {
    buf = await fsp.readFile(p)
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return null
    throw e
  }
  // UTF-16（Windows 记事本/PowerShell 另存常见）：按 utf8 解出来是乱码，明确报错比"看似损坏"好排查
  if (buf.length >= 2 && ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff))) {
    throw new Error(t('{p} 是 UTF-16 编码，请用编辑器把它转存为 UTF-8 后重试', '{p} is UTF-16 encoded; re-save it as UTF-8 in an editor and retry', { p }))
  }
  let text = buf.toString('utf8')
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1) // 剥 UTF-8 BOM，否则 JSON.parse 直接炸
  return text
}

// 跨进程写锁（纯 JS，无 native）
// 供 config.toml / secrets.json 等「读文件→改内存→整文件写回」的共享数据做跨进程互斥：CLI /
// 网关 daemon / Web 控制台是三个独立写者，无互斥会静默丢更新。两层防护：进程内 promise 串行
// serialize（同进程并发调用）+ 跨进程 O_CREAT|O_EXCL 锁文件。

const LOCK_TIMEOUT_MS = 10_000
/** 持锁超过该时长视为持有者已死（临界区内不应有慢 I/O），允许抢占。语义即老 config 锁语义，勿改。 */
export const lockStaleMs = 15_000

function lockTimeoutError(lp: string): Error {
  return new Error(
    t('文件写入锁超时：{lp} 被其他进程长期占用（可能是异常退出的残留锁）。确认没有其他 modeldock 进程在写该文件后，可删除该 .lock 文件重试',
      'Timed out acquiring the write lock: {lp} has been held by another process for too long (possibly a stale lock from a crashed process). After confirming no other modeldock process is writing this file, delete the .lock file and retry',
      { lp })
  )
}

/** 跨进程互斥：O_CREAT|O_EXCL 独占创建锁文件；陈旧锁抢占；超时给可操作报错。
 *  release 做 pid 归属校验——仅当锁文件仍写着本进程 pid 才删除。超时抢占后原持有者收尾不删
 *  **新持有者**的锁，第三个写者不会误入临界区。@returns 释放锁的函数。 */
export async function acquireFileLock(
  lockFile: string,
  opts?: { timeoutError?: (lp: string) => Error }
): Promise<() => void> {
  fs.mkdirSync(path.dirname(lockFile), { recursive: true }) // 首次运行时 ~/.modeldock 可能还不存在
  const t0 = Date.now()
  const err = opts?.timeoutError ?? lockTimeoutError
  for (;;) {
    try {
      const fd = fs.openSync(lockFile, 'wx')
      try {
        fs.writeSync(fd, String(process.pid))
      } finally {
        fs.closeSync(fd)
      }
      return () => {
        try {
          // 归属校验：仅当锁文件仍写着本进程 pid 才删（被抢占/删改则不动，留待新持有者收尾）
          if (fs.readFileSync(lockFile, 'utf8') === String(process.pid)) {
            fs.unlinkSync(lockFile)
          }
        } catch {
          /* 已被抢占/删除则忽略 */
        }
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
      try {
        const st = fs.statSync(lockFile)
        if (Date.now() - st.mtimeMs > lockStaleMs) {
          // 抢占前复核身份（ino/mtime/size）：stat 与 unlink 之间锁可能已被他人删除重建，
          // 无条件 unlink 会误删新锁造成双持锁（正是本锁要防的丢更新）。复核把竞态窗口从
          // 一次陈旧判定 IO 收窄到两次背靠背 stat 之间（µs 级；纯 JS 无 flock，这是无原生依赖下的务实上限）
          const st2 = fs.statSync(lockFile)
          if (st2.ino === st.ino && st2.mtimeMs === st.mtimeMs && st2.size === st.size) {
            fs.unlinkSync(lockFile)
          }
          continue
        }
      } catch {
        /* 锁刚被释放，直接重试 */
      }
      if (Date.now() - t0 > LOCK_TIMEOUT_MS) {
        throw err(lockFile)
      }
      await new Promise((r) => setTimeout(r, 50))
    }
  }
}

// 进程内串行队列：按锁文件分队列，互不相关文件（config / secrets）的写并发互不阻塞。
const lockQueues = new Map<string, Promise<unknown>>()

function enqueueLocked<T>(lockFile: string, job: () => Promise<T>): Promise<T> {
  const prev = lockQueues.get(lockFile) ?? Promise.resolve()
  const next = prev.then(job, job)
  lockQueues.set(
    lockFile,
    next.then(
      () => undefined,
      () => undefined
    )
  )
  return next
}

/** 读-改-写 便捷封装（同进程串行 + 跨进程互斥锁）。config 的 mutateConfig 与 secrets 写路径共用。
 *  fn 内不要做慢 I/O，避免长期占锁。@param{timeoutError} 覆盖默认超时报错（store 用它装成 ConfigError）。 */
export async function withFileLock<T>(
  lockFile: string,
  opts: { timeoutError?: (lp: string) => Error } | undefined,
  job: () => Promise<T>
): Promise<T> {
  return enqueueLocked(lockFile, async () => {
    const release = await acquireFileLock(lockFile, opts)
    try {
      return await job()
    } finally {
      release()
    }
  })
}

// 常驻追加流（高频 JSONL 日志落盘）

/** 按路径常驻追加流池：fs.appendFile 每条都是 open+write+close 三个 syscall 走线程池，高频
 *  请求下与转发争 IO；常驻流把每条开销降为一次 write，且同文件写入严格有序。写入错误静默，
 *  流 destroyed 后由下一条写入按需重建。调用方需保证目录已存在（先 ensureDir/mkdirSync）。 */
const APPEND_STREAM_CAP = 8
const appendStreams = new Map<string, fs.WriteStream>()

export function appendLine(file: string, line: string): void {
  const existing = appendStreams.get(file)
  if (existing && !existing.destroyed) {
    existing.write(line)
  } else {
    const ws = fs.createWriteStream(file, { flags: 'a' })
    ws.on('error', () => {})
    appendStreams.delete(file)
    appendStreams.set(file, ws)
    while (appendStreams.size > APPEND_STREAM_CAP) {
      const oldestKey = appendStreams.keys().next().value as string
      const oldest = appendStreams.get(oldestKey)
      appendStreams.delete(oldestKey)
      oldest?.end()
    }
    ws.write(line)
  }
}

/** 关闭全部常驻流：临时目录删除前必须调用——Windows 上目录内有本进程未关的 fd 会 EBUSY。 */
export function closeAppendStreams(): void {
  for (const ws of appendStreams.values()) ws.end()
  appendStreams.clear()
}

/** 优雅关停时排空常驻流：流自带缓冲（默认 16KB），直接 process.exit 会丢掉尾部尚未刷盘的
 *  日志行——appendFile 时代每条独立落盘不会有此问题，属常驻流引入的持久性缺口。带超时兜底
 *  防止个别流挂住阻塞关停（超时即放弃，最坏退化为丢掉尾部日志）。 */
export async function drainAppendStreams(timeoutMs = 1000): Promise<void> {
  const streams = [...appendStreams.values()]
  appendStreams.clear()
  if (!streams.length) return
  await Promise.race([
    Promise.allSettled(
      streams.map(
        (ws) =>
          new Promise<void>((resolve) => {
            if (ws.destroyed || ws.closed) return resolve()
            ws.once('close', () => resolve())
            ws.end()
          })
      )
    ),
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs)
      timer.unref?.()
    }),
  ])
}

export async function isFile(p: string): Promise<boolean> {
  try {
    return (await fsp.stat(p)).isFile()
  } catch {
    return false
  }
}

export async function fileMode(p: string): Promise<number> {
  try {
    return (await fsp.stat(p)).mode & 0o777
  } catch {
    return 0o600
  }
}

export function randomToken(prefix = 'mdk'): string {
  return `${prefix}_${crypto.randomBytes(24).toString('hex')}`
}

export function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'provider'
  )
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
