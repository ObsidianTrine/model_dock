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
 *  accept：命中过滤谓词（commandOnPathSandbox 用）——不满足时继续向后扫，而非整场判负。 */
export function commandOnPathResolved(cmd: string, accept?: (p: string) => boolean): string | null {
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
  return sha256(await fsp.readFile(p))
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
      if (delay === undefined || (code !== 'EPERM' && code !== 'EACCES')) {
        await fsp.rm(tmp, { force: true }).catch(() => {}) // 失败时清掉残留 tmp（旧行为会遗留在目标目录）
        throw e
      }
      await new Promise((r) => setTimeout(r, delay))
    }
  }
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

export async function which(cmd: string): Promise<string | null> {
  try {
    await fsp.access(cmd)
    return cmd
  } catch {
    /* fallthrough */
  }
  // Windows 没有 which 命令（execFile('which') 永远 ENOENT）：扫 PATH 按可执行扩展名探测
  if (process.platform === 'win32') {
    const exts = (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM')
      .split(';')
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean)
    const hasExt = exts.some((e) => cmd.toLowerCase().endsWith(e))
    for (const dir of (process.env.PATH ?? '').split(';')) {
      if (!dir) continue
      const candidates = hasExt ? [cmd] : exts.map((e) => cmd + e)
      for (const name of candidates) {
        const p = path.join(dir, name)
        if (await isFile(p)) return p
      }
    }
    return null
  }
  const out = await new Promise<string>((resolve) => {
    import('node:child_process').then(({ execFile }) => {
      execFile('which', [cmd], (err, stdout) => resolve(err ? '' : stdout.trim()))
    })
  })
  return out || null
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
