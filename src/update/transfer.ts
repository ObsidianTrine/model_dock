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
import { ensureDir } from '../util/fsx.js'
import { t } from '../util/i18n.js'

/** 通用下载超时：providers/update/noderuntime 三者共用（fetch 未走慢时网络也要给足余量） */
export const DOWNLOAD_TIMEOUT_MS = 10 * 60_000

export interface DownloadToFileOpts {
  /** 进度回调：received/total 为字节数；total=0 表示上游未给 content-length */
  onProgress?: (received: number, total: number) => void
  /** 超时（ms），缺省 DOWNLOAD_TIMEOUT_MS */
  timeoutMs?: number
  /** 附加请求头（如鉴权）；透传给 fetch */
  headers?: Record<string, string>
  /** redirect 策略透传给 fetch（避免引用 DOM 全局类型，union 展开） */
  redirect?: 'follow' | 'error' | 'manual'
}

/**
 * 下载 URL 到文件（流式写盘 + 进度回调）。返回实际写入字节数。
 * 非 2xx / 无响应体抛错（消息走 t() 双语，objectName 供点名资产）。走全局 fetch，
 * 测试用本地 mock 服务器桩测，不 vi.mock 模块。
 */
export async function downloadToFile(url: string, dest: string, opts: DownloadToFileOpts & { objectName?: string } = {}): Promise<number> {
  const res = await fetch(url, {
    headers: opts.headers,
    signal: AbortSignal.timeout(opts.timeoutMs ?? DOWNLOAD_TIMEOUT_MS),
    redirect: opts.redirect ?? 'follow',
  })
  if (!res.ok || !res.body) {
    throw new Error(
      opts.objectName
        ? t('下载 {n} 失败：HTTP {s}', 'Failed to download {n}: HTTP {s}', { n: opts.objectName, s: res.status })
        : `HTTP ${res.status} ${url}`
    )
  }
  const total = Number(res.headers.get('content-length') ?? 0)
  let received = 0
  await ensureDir(path.dirname(dest))
  const fh = await fsp.open(dest, 'w', 0o600)
  try {
    for await (const chunk of res.body) {
      const buf = Buffer.from(chunk as ArrayBuffer)
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
  opts: { timeoutMs?: number; headers?: Record<string, string>; redirect?: 'follow' | 'error' | 'manual' } = {}
): Promise<string> {
  const res = await fetch(url, {
    headers: opts.headers,
    signal: AbortSignal.timeout(opts.timeoutMs ?? DOWNLOAD_TIMEOUT_MS),
    redirect: opts.redirect ?? 'follow',
  })
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

/** 默认解压执行：spawn 子进程，stdout 忽略、stderr 收集进错误信息，exit 0 即成功 */
export const defaultSpawnRunner: SpawnRunner = (cmd, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
    let err = ''
    child.stderr?.on('data', (d) => { err += String(d) })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(err.trim() || t('进程退出码 {code}', 'process exited with code {code}', { code: code ?? -1 })))
    })
  })

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
  await fsp.mkdir(dir, { recursive: true })
  if (archive.toLowerCase().endsWith('.zip')) {
    if (platform === 'win32' && (archive.includes('"') || dir.includes('"'))) {
      // Expand-Archive 用 LiteralPath 传路径，引号会把命令拼坏；unix tar 无此问题。
      // 原 noderuntime 该守卫仅 win 有意义，unix 分支不应被引号误伤。
      throw new Error(t('路径含引号，无法解压：{p}', 'Path contains a quote character, cannot extract: {p}', { p: archive }))
    }
    await run('powershell', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath "${archive}" -DestinationPath "${dir}" -Force`])
  } else {
    await run('tar', ['-xzf', archive, '-C', dir])
  }
}