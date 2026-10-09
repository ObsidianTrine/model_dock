/** WebDAV 同步目标：坚果云/Nextcloud/群晖等通用（详设 §6.1/§6.2）。undici 为既有依赖，零新增 */
import { request } from 'undici'
import { t } from '../../util/i18n.js'
import { SYNC_DIRNAME, blobRefOf, parseManifest, type SyncManifest, type SyncTarget } from './types.js'

export interface WebdavOptions {
  url: string
  /** 网盘内子目录（可含多级，如 'docs/modeldock'）；缺省置于根 */
  dir?: string
  username?: string
  password?: string
}

const TIMEOUT_MS = 15_000

/** base 原样保留（含协议/主机/端口），仅对后续目录段逐段编码 */
function joinUrl(base: string, ...segments: string[]): string {
  const enc = (s: string): string =>
    s
      .split('/')
      .filter(Boolean)
      .map(encodeURIComponent)
      .join('/')
  return base.replace(/\/+$/, '') + '/' + segments.map(enc).filter(Boolean).join('/')
}

export function createWebdavTarget(opts: WebdavOptions): SyncTarget {
  const root = joinUrl(opts.url, opts.dir ?? '', SYNC_DIRNAME)
  const headers: Record<string, string> = {}
  if (opts.username || opts.password) {
    headers.authorization = 'Basic ' + Buffer.from(`${opts.username ?? ''}:${opts.password ?? ''}`).toString('base64')
  }

  async function call(method: string, url: string, body?: string): Promise<{ code: number; text: string }> {
    let res
    try {
      res = await request(url, { method, headers, body, signal: AbortSignal.timeout(TIMEOUT_MS) })
    } catch (e) {
      throw new Error(t('同步目标不可达（{url}）：{err}', 'Sync target unreachable ({url}): {err}', { url, err: (e as Error).message }))
    }
    const text = await res.body.text().catch(() => '')
    return { code: res.statusCode, text }
  }

  /** WebDAV 集合不存在时 PUT 会 409：补 MKCOL 后重试一次（坚果云等要求父集合存在） */
  async function putWithMkcol(url: string, body: string): Promise<void> {
    let r = await call('PUT', url, body)
    if (r.code === 409) {
      await mkcol(url)
      r = await call('PUT', url, body)
    }
    if (r.code < 200 || r.code >= 300) {
      throw new Error(t('写入同步目标失败（HTTP {code}）：{url}', 'Failed to write to the sync target (HTTP {code}): {url}', { code: r.code, url }))
    }
  }

  async function mkcol(url: string): Promise<void> {
    const r = await call('MKCOL', url)
    // 201 创建成功；405/301 多数服务器表示已存在——都视为可用
    if (r.code !== 201 && r.code !== 405 && r.code !== 301) {
      throw new Error(t('在同步目标上创建目录失败（HTTP {code}）：{url}', 'Failed to create a folder on the sync target (HTTP {code}): {url}', { code: r.code, url }))
    }
  }

  async function readUrl(url: string): Promise<string | null> {
    const r = await call('GET', url)
    if (r.code === 404) return null
    if (r.code < 200 || r.code >= 300) {
      throw new Error(t('读取同步目标失败（HTTP {code}）：{url}', 'Failed to read from the sync target (HTTP {code}): {url}', { code: r.code, url }))
    }
    return r.text
  }

  return {
    async readManifest(): Promise<SyncManifest | null> {
      const text = await readUrl(`${root}/manifest.json`)
      return text === null ? null : parseManifest(text)
    },
    async writeBlob(rev, devid, envelope) {
      await putWithMkcol(`${root}/${blobRefOf(rev, devid)}`, envelope)
    },
    async writeManifest(m, baseRev) {
      const cur = await readUrl(`${root}/manifest.json`)
      if (cur !== null && parseManifest(cur).rev !== baseRev) return 'conflict'
      await putWithMkcol(`${root}/manifest.json`, JSON.stringify(m, null, 2) + '\n')
      return 'ok'
    },
    async readBlob(ref) {
      const text = await readUrl(`${root}/${ref.split('/').map(encodeURIComponent).join('/')}`)
      if (text === null) {
        throw new Error(t('同步历史包缺失（{ref}）：同步目标上的 blobs 目录被清理过？', 'Sync blob missing ({ref}): was the blobs folder cleaned up on the target?', { ref }))
      }
      return text
    },
  }
}
