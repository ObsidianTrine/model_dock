/**
 * 下载 / 校验 / 解压通用原语（DUP-02 收敛）。
 *
 * 原三套平行实现合并到此，三处调用方全部改用：
 * - `src/update/check.ts` 的 downloadAsset 逐步写盘段（带进度）+ 内联 SHA256SUMS 正则；
 * - `src/install/noderuntime.ts` 的 downloadText / downloadFile / extractExpectedSha / extractArchive；
 * - `src/update/install.ts` 的 extractArchive。
 *
 * 收敛点：SUMS 解析统一为 tolerant 版本（大小写哈希都认）；解压统一 tar / Expand-Archive
 * 平台分支（zip 走 PowerShell，其余走系统 tar）；下载统一流式写盘 + 进度回调 + fetch 可注入。
 * 校验逻辑（SHA256 比对、删除不通过物）留在调用方，本模块只供原语。
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fetch as undiciFetch, type Dispatcher } from 'undici'
import { ensureDir, sleep } from '../util/fsx.js'
import { buildDispatcher } from '../util/net.js'
import { t } from '../util/i18n.js'

/** 通用下载超时：providers/update/noderuntime 三者共用（fetch 未走慢时网络也要给足余量） */
export const DOWNLOAD_TIMEOUT_MS = 10 * 60_000

/** 代理 dispatcher 按 URL 复用：镜像候选 + 官方候选 + 重试共享一条代理连接池 */
const proxyDispatchers = new Map<string, Dispatcher>()
function dispatcherFor(proxyUrl: string): Dispatcher {
  let d = proxyDispatchers.get(proxyUrl)
  if (!d) {
    d = buildDispatcher(proxyUrl)
    proxyDispatchers.set(proxyUrl, d)
  }
  return d
}

/**
 * 代理感知 fetch：proxyUrl 非空走 undici fetch + ProxyAgent（Node 全局 fetch 不认系统代理，
 * 也不支持运行时注入 env 代理——见 util/sysproxy.ts 头注）；空则全局 fetch 直连（行为不变）。
 * undici 与全局 fetch 的 Response 同源（@types/node 即 undici-types），仅 init 多 dispatcher 项。
 */
export async function doFetch(url: string, init: { headers?: Record<string, string>; signal?: AbortSignal; redirect?: 'follow' | 'error' | 'manual' }, proxyUrl?: string | null): Promise<Response> {
  if (!proxyUrl) return fetch(url, init)
  return (await undiciFetch(url, { ...init, dispatcher: dispatcherFor(proxyUrl) })) as unknown as Response
}

export interface DownloadToFileOpts {
  /** 进度回调：received/total 为字节数；total=0 表示上游未给 content-length。
   *  续传（resumeFrom>0）时 received 为**本次响应的增量**、total 为**本次响应的 content-length**（206 时是剩余量），
   *  全量口径由调用方自行叠加（downloadAsset 负责）；非续传路径语义不变 */
  onProgress?: (received: number, total: number) => void
  /** 超时（ms），缺省 DOWNLOAD_TIMEOUT_MS */
  timeoutMs?: number
  /** 附加请求头（如鉴权）；透传给 fetch */
  headers?: Record<string, string>
  /** redirect 策略透传给 fetch（避免引用 DOM 全局类型，union 展开） */
  redirect?: 'follow' | 'error' | 'manual'
  /** 非空 = 经该代理（http://host:port / socks5://）转发；缺省直连。由 resolveUpdateProxyUrl 解析得出 */
  proxyUrl?: string | null
  /** 断点续传起点（已有半成品字节数）：>0 时发 `Range: bytes=<n>-`。响应 206 → 追加写（'a'）；
   *  200 → 服务器不支持 Range 或资源已变，覆盖重写（'w'），自动退化无需预探测。
   *  416 走 !res.ok 抛错——调用方须保证 start < 资产总大小（半成品已完整时直接走校验，不发请求） */
  resumeFrom?: number
  /** 续传一致性校验：首段响应的 ETag，随 Range 发 `If-Range`。资源中途被换 → 服务器回 200 全量
   *  覆盖，绝不拼出杂交内容；无 ETag 时省略（靠调用方最终 SHA256 兜底） */
  ifRange?: string
  /** 响应元信息回调（续传记账）：headers 到达、body 流开始前回调一次。etag 供下次 If-Range */
  onResponseMeta?: (meta: { status: number; etag: string | null }) => void
}

/**
 * 下载 URL 到文件（流式写盘 + 进度回调）。返回**本次响应写入**的字节数（非续传 = 全量；
 * 206 续传 = 剩余增量，全量 = resumeFrom + 返回值，由调用方叠加）。
 * 非 2xx / 无响应体抛错（消息走 t() 双语，objectName 供点名资产）。走全局 fetch，
 * 测试用本地 mock 服务器桩测，不 vi.mock 模块。
 */
export async function downloadToFile(url: string, dest: string, opts: DownloadToFileOpts & { objectName?: string } = {}): Promise<number> {
  const start = Math.max(0, opts.resumeFrom ?? 0)
  const headers: Record<string, string> = { ...opts.headers }
  if (start > 0) headers.Range = `bytes=${start}-`
  if (start > 0 && opts.ifRange) headers['If-Range'] = opts.ifRange
  const res = await doFetch(url, {
    headers,
    signal: AbortSignal.timeout(opts.timeoutMs ?? DOWNLOAD_TIMEOUT_MS),
    redirect: opts.redirect ?? 'follow',
  }, opts.proxyUrl)
  opts.onResponseMeta?.({ status: res.status, etag: res.headers.get('etag') })
  if (!res.ok || !res.body) {
    throw new Error(
      opts.objectName
        ? t('下载 {n} 失败：HTTP {s}', 'Failed to download {n}: HTTP {s}', { n: opts.objectName, s: res.status })
        : `HTTP ${res.status} ${url}`
    )
  }
  // 206 且确有起点 = 续传命中（追加写）；否则覆盖写（含「发了 Range 被回 200」的退化路径）
  const partial = start > 0 && res.status === 206
  const total = Number(res.headers.get('content-length') ?? 0)
  let received = 0
  await ensureDir(path.dirname(dest))
  const fh = await fsp.open(dest, partial ? 'a' : 'w', 0o600)
  try {
    for await (const chunk of res.body) {
      // undici 的 body chunk 标注为 Uint8Array<ArrayBufferLike>；Buffer.from 接受任意 TypedArray，
      // 经 unknown 双跳只是类型层面的收窄，运行时零变化（T30：DOM lib 下 Uint8Array<ArrayBuffer>
      // 直接 as ArrayBuffer 会被判不充分重叠）
      const buf = Buffer.from(chunk as unknown as ArrayBuffer)
      received += buf.length
      await fh.write(buf)
      opts.onProgress?.(received, total)
    }
  } finally {
    await fh.close()
  }
  return received
}

/** 下载 URL 为文本（SUMS 等小文件）。调用方按语义决定超时。 */
export async function downloadText(
  url: string,
  opts: { timeoutMs?: number; headers?: Record<string, string>; redirect?: 'follow' | 'error' | 'manual'; proxyUrl?: string | null } = {}
): Promise<string> {
  const res = await doFetch(url, {
    headers: opts.headers,
    signal: AbortSignal.timeout(opts.timeoutMs ?? DOWNLOAD_TIMEOUT_MS),
    redirect: opts.redirect ?? 'follow',
  }, opts.proxyUrl)
  if (!res.ok) throw new Error(t('下载 {url} 失败：HTTP {s}', 'Failed to download {url}: HTTP {s}', { url, s: res.status }))
  return res.text()
}

/**
 * SHA256SUMS 解析：每行「哈希  *文件名」，大小写哈希都认（tolerant 正则，对齐 check 与
 * noderuntime 两版的超集），统一返回 { 文件名: 小写哈希 }。空名册返回空对象。
 */
export function parseSums(text: string): Record<string, string> {
  const map: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const m = line.trim().match(/^([0-9a-fA-F]{64})\s+\*?(.+)$/)
    if (m) map[m[2].trim()] = m[1].toLowerCase()
  }
  return map
}

/** 注入用命令执行器：跑解压命令并断言成功，失败抛错（供单测桩拼装命令，不真跑系统工具） */
export type SpawnRunner = (cmd: string, args: string[]) => Promise<void>

/** 零诊断瞬态死亡的重试次数与退避：Windows 高负载 / 杀软活跃窗口里，解压子进程（PowerShell /
 *  tar）偶发「非零退出且 stderr 为空」的瞬态死亡（0xC0000142 / 0xC000013A 一类，无任何诊断输出；
 *  2026-10-31 多套件并发跑测试时 update.test.ts 全链路 Expand-Archive 实测中招）。带退避重试一次；
 *  带 stderr 的真实失败（损坏包、参数错、文件被占）绝不重试——不掩盖真回归。 */
const SPAWN_TRANSIENT_RETRIES = 1
const SPAWN_RETRY_BACKOFF_MS = 150
/** spawn 创建失败里属于「资源暂时耗尽、稍后重试可成」的错误码（ENOENT/EACCES 等确定性失败不在此列） */
const TRANSIENT_SPAWN_ERROR_CODES = new Set(['EAGAIN', 'EMFILE', 'ENFILE', 'ETIMEDOUT'])

/** 单次尝试的失败标记：zeroDiagnostic = 失败未携带任何诊断信息（瞬态死亡的判据），仅这类允许重试 */
interface SpawnAttemptFailure extends Error {
  zeroDiagnostic?: boolean
}

function spawnAttempt(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
    let err = ''
    child.stderr?.on('data', (d) => { err += String(d) })
    child.on('error', (e) => {
      const f = e as SpawnAttemptFailure
      if (e instanceof Error && (e as NodeJS.ErrnoException).code && TRANSIENT_SPAWN_ERROR_CODES.has((e as NodeJS.ErrnoException).code!)) f.zeroDiagnostic = true
      reject(f)
    })
    child.on('close', (code) => {
      if (code === 0) {
        resolve()
        return
      }
      const f = new Error(err.trim() || t('进程退出码 {code}', 'process exited with code {code}', { code: code ?? -1 })) as SpawnAttemptFailure
      if (!err.trim()) f.zeroDiagnostic = true
      reject(f)
    })
  })
}

/** 默认解压执行：spawn 子进程，stdout 忽略、stderr 收集进错误信息，exit 0 即成功；
 *  零诊断瞬态死亡（非零退出且无 stderr / 瞬态创建失败）带退避重试一次。 */
export const defaultSpawnRunner: SpawnRunner = async (cmd, args) => {
  for (let attempt = 0; ; attempt++) {
    try {
      await spawnAttempt(cmd, args)
      return
    } catch (e) {
      if (attempt >= SPAWN_TRANSIENT_RETRIES || !(e as SpawnAttemptFailure)?.zeroDiagnostic) throw e
      await sleep(SPAWN_RETRY_BACKOFF_MS)
    }
  }
}

/**
 * 解压归档到目录：zip 走 PowerShell Expand-Archive，其余（tar.gz 等）走系统 tar
 * （Win10+ 自带 bsdtar）。run 可注入桩验证命令拼装。platform 显式传入便于三平台单测纯函数。
 */
export async function extractArchive(
  archive: string,
  dir: string,
  run: SpawnRunner = defaultSpawnRunner,
  platform: NodeJS.Platform = process.platform
): Promise<void> {
  // Expand-Archive 经 -Command 双引号串传路径：引号把命令拼坏，反引号/$( 触发 PowerShell 插值展开；
  // unix tar 无此问题。落点来自 mkdtemp + validateAssetName，守卫属纵深防御。
  // 守卫先于 mkdir：被拒路径不得落盘（2026-10 测试传相对路径曾把目录建进进程 CWD）
  if (archive.toLowerCase().endsWith('.zip') && platform === 'win32' && (/["`$]/.test(archive) || /["`$]/.test(dir))) {
    throw new Error(t('路径含引号或 PowerShell 元字符，无法解压：{p}', 'Path contains a quote or PowerShell metacharacter, cannot extract: {p}', { p: archive }))
  }
  await fsp.mkdir(dir, { recursive: true })
  if (archive.toLowerCase().endsWith('.zip')) {
    await run('powershell', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath "${archive}" -DestinationPath "${dir}" -Force`])
  } else {
    await run('tar', ['-xzf', archive, '-C', dir])
  }
}