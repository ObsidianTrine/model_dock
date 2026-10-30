import fsp from 'node:fs/promises'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { homeDir, modeldockDir, sandboxNpmBinDir } from './paths.js'
import { t } from './i18n.js'

// ===== 真实 home 写入门禁（2026-10-05 / 2026-10-30 两次生产覆盖事故防线）=====

/** 测试/agent 上下文判定：vitest worker（VITEST/VITEST_WORKER_ID 注入）或显式标记
 *  MODELRDOCK_TEST=1（tsx 种子脚本等非 vitest 进程，AGENTS.md 配方要求设置）。 */
export function inTestContext(): boolean {
  return process.env.VITEST === 'true' || !!process.env.VITEST_WORKER_ID || process.env.MODELRDOCK_TEST === '1'
}

/** 测试上下文进程眼中的「真实 home」落点：全部重定向 env 都未设时 home 的位置。 */
function realModeldockDir(): string {
  return process.env.MODELRDOCK_HOME || path.join(os.homedir(), '.modeldock')
}

/** 测试/agent 上下文的进程拒写真实 home：atomicWrite / acquireFileLock 统一漏斗前置校验。
 *  两次事故同根——测试进程的异步长尾（sync 引擎在飞 tick、缓冲写盘）在 MODELRDOCK_FAKE_HOME
 *  被恢复后仍按真实 home 解析路径落盘。判定**只看写入目标**、不看 FAKE_HOME 是否已设：
 *  目标落在真实 home 下就拦，覆盖「沙箱配了但调用方传了字面量真实路径」的旁路。
 *  生产进程（无测试标记）零影响；只拦写不拦读。确属有意写真实 home 的场景（当前无）设
 *  MODELRDOCK_ALLOW_REAL_HOME_WRITE=1 显式豁免。非漏斗写入（appendLine 追加日志、catalog
 *  缓存等）不在此防线内——日志类污染不破坏数据，不值得给高频路径加校验。 */
export function assertNotRealHomeWrite(file: string): void {
  if (!inTestContext()) return
  if (process.env.MODELRDOCK_ALLOW_REAL_HOME_WRITE === '1') return
  // darwin/win32 文件系统默认大小写不敏感：小写归一后比较防大小写绕过；linux 保持原样
  const fold = (p: string): string => (process.platform === 'linux' ? p : p.toLowerCase())
  const realDir = fold(path.resolve(realModeldockDir()))
  const target = fold(path.resolve(file))
  if (target === realDir || target.startsWith(realDir + path.sep)) {
    throw new Error(
      t(
        '测试/agent 进程正在写真实 home（{file}），已拒绝：请设置 MODELRDOCK_FAKE_HOME=<独立目录> 用隔离沙箱测试；确属有意操作设 MODELRDOCK_ALLOW_REAL_HOME_WRITE=1 豁免',
        'A test/agent process attempted to write the real home ({file}); blocked. Set MODELRDOCK_FAKE_HOME=<dir> to test in an isolated sandbox; set MODELRDOCK_ALLOW_REAL_HOME_WRITE=1 to override deliberately',
        { file }
      )
    )
  }
}

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
  assertNotRealHomeWrite(file) // 在 ensureDir 之前：连目录创建都不许发生
  await ensureDir(path.dirname(file))
  const tmp = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${Math.random().toString(36).slice(2, 8)}`
  )
  try {
    const fh = await fsp.open(tmp, 'w', mode)
    try {
      await fh.writeFile(content)
      await fh.chmod(mode)
      await fh.sync()
    } finally {
      await fh.close()
    }
  } catch (e) {
    // 写入阶段失败（磁盘满/权限）：与 rename 失败路径同规清掉残留 tmp，不在目标目录留垃圾
    await fsp.rm(tmp, { force: true }).catch(() => {})
    throw e
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
  assertNotRealHomeWrite(lockFile) // 锁文件与被保护文件同目录（<file>.lock），同受门禁约束
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

/** 锁持有者识别（withFileLock 同路径重入）：AsyncLocalStorage 让「持有者调用树内」的嵌套申请
 *  可被精确识别——promise 队列没有线程式的属主概念，嵌套若也走队列会排在自身后面形成死锁
 *  （engine 的 apply+post-collect 原子化正是这个形态：外层持 config 锁，applySyncdoc 内部又
 *  mutateConfig 同一把锁）。跨路径嵌套照常各自排队，不引入跨路径死锁。 */
const lockOwnerStore = new AsyncLocalStorage<{ lockFile: string }>()

/** 读-改-写 便捷封装（同进程串行 + 跨进程互斥锁）。config 的 mutateConfig 与 secrets 写路径共用。
 *  fn 内不要做慢 I/O，避免长期占锁。同路径重入（持有者调用树内再申请同一路径）直接内联执行，
 *  不再排队也不再拿文件锁——文件锁与队列都归外层持有。@param{timeoutError} 覆盖默认超时报错
 *  （store 用它装成 ConfigError）。 */
export async function withFileLock<T>(
  lockFile: string,
  opts: { timeoutError?: (lp: string) => Error } | undefined,
  job: () => Promise<T>
): Promise<T> {
  const owner = lockOwnerStore.getStore()
  if (owner && owner.lockFile === lockFile) return job()
  return enqueueLocked(lockFile, async () => {
    const release = await acquireFileLock(lockFile, opts)
    try {
      return await lockOwnerStore.run({ lockFile }, job)
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
/** 每路径累计的追加写失败次数（进程生命周期内单调递增）。写入错误原先无限期静默——磁盘满等
 *  持久故障无任何观测面；现首次失败打一条双语日志、此后只计数，经 appendLineErrorCount()
 *  暴露给健康检查（/_modeldock/health 的 log_write_errors）。 */
const appendErrorCounts = new Map<string, number>()

/** 全部路径的追加写失败总次数（/health 的 log_write_errors 消费）。 */
export function appendLineErrorCount(): number {
  let total = 0
  for (const n of appendErrorCounts.values()) total += n
  return total
}
/** 空闲刷盘阈值：一条流超过该时长没有新写入就 end 掉（缓冲随关流强制落盘），下一条写入按需重建。
 *  Windows 的 gateway stop 是 TerminateProcess（无信号语义），main.ts 的 cleanup/drainAppendStreams
 *  走不到，不关流的话最后缓冲的尾部日志随进程一起丢；空闲即关把最坏丢失窗口从「直到下次 stop」
 *  压到本阈值秒级，且收益独立于停机路径（崩溃/被杀同样受益）。 */
const APPEND_IDLE_MS = 3000
const appendStreams = new Map<string, fs.WriteStream>()
const appendStreamLastUse = new Map<string, number>()
let appendIdleTimer: NodeJS.Timeout | undefined

/** 周期扫描流池，把空闲超阈值的流关掉刷盘。unref 定时器：不阻止进程自然退出。 */
function appendIdleSweep(): void {
  const now = Date.now()
  for (const [file, ws] of appendStreams) {
    if (now - (appendStreamLastUse.get(file) ?? 0) < APPEND_IDLE_MS) continue
    // 先摘出 map 再 end：appendLine 按 map 命中复用流，摘除后并发到来的写入会走重建分支，
    // 不会命中一个已 end 的流（write after end 会静默丢行）
    appendStreams.delete(file)
    appendStreamLastUse.delete(file)
    ws.end()
  }
}

function ensureAppendIdleTimer(): void {
  if (appendIdleTimer) return
  appendIdleTimer = setInterval(appendIdleSweep, 1000)
  appendIdleTimer.unref?.()
}

/** 停掉空闲刷盘定时器并清空 lastUse 簿记（关停/清理路径收尾用） */
function stopAppendIdleTimer(): void {
  if (appendIdleTimer) {
    clearInterval(appendIdleTimer)
    appendIdleTimer = undefined
  }
  appendStreamLastUse.clear()
}

export function appendLine(file: string, line: string): void {
  appendStreamLastUse.set(file, Date.now())
  ensureAppendIdleTimer()
  const existing = appendStreams.get(file)
  if (existing && !existing.destroyed) {
    existing.write(line)
  } else {
    const ws = fs.createWriteStream(file, { flags: 'a' })
    ws.on('error', (e) => {
      const n = (appendErrorCounts.get(file) ?? 0) + 1
      appendErrorCounts.set(file, n)
      if (n === 1) {
        // 仅首次失败打日志（磁盘满时刷屏报错只会加速故障），后续同类失败只计数
        console.error(t('日志写入失败（{file}）：{msg}；此后该文件的写入失败只计数，可通过 GET /_modeldock/health 的 log_write_errors 观察', 'Log write failed ({file}): {msg}; further write failures for this file are only counted (see log_write_errors via GET /_modeldock/health)', { file, msg: (e as Error).message }))
      }
    })
    appendStreams.delete(file)
    appendStreams.set(file, ws)
    while (appendStreams.size > APPEND_STREAM_CAP) {
      const oldestKey = appendStreams.keys().next().value as string
      const oldest = appendStreams.get(oldestKey)
      appendStreams.delete(oldestKey)
      appendStreamLastUse.delete(oldestKey)
      oldest?.end()
    }
    ws.write(line)
  }
}

/** 关闭全部常驻流：临时目录删除前必须调用——Windows 上目录内有本进程未关的 fd 会 EBUSY。 */
export function closeAppendStreams(): void {
  stopAppendIdleTimer()
  for (const ws of appendStreams.values()) ws.end()
  appendStreams.clear()
}

/** 关闭指定路径的常驻流并等待句柄释放（日志保留期清理删文件前必须先关流——Windows 上
 *  文件有本进程未关 fd 时 unlink 报 EPERM/EBUSY）。无此路径的流立即返回；带超时兜底，
 *  个别流挂住时不阻塞清理（最坏退化为本次删除失败、次日重试）。 */
export async function closeAppendStream(file: string, timeoutMs = 1000): Promise<void> {
  const ws = appendStreams.get(file)
  if (!ws) return
  appendStreams.delete(file)
  appendStreamLastUse.delete(file)
  await Promise.race([
    new Promise<void>((resolve) => {
      if (ws.destroyed || ws.closed) return resolve()
      ws.once('close', () => resolve())
      ws.end()
    }),
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs)
      timer.unref?.()
    }),
  ])
}

/** 优雅关停时排空常驻流：流自带缓冲（默认 16KB），直接 process.exit 会丢掉尾部尚未刷盘的
 *  日志行——appendFile 时代每条独立落盘不会有此问题，属常驻流引入的持久性缺口。带超时兜底
 *  防止个别流挂住阻塞关停（超时即放弃，最坏退化为丢掉尾部日志）。 */
export async function drainAppendStreams(timeoutMs = 1000): Promise<void> {
  stopAppendIdleTimer()
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
