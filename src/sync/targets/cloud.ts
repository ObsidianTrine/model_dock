/**
 * 云端同步目标（docs/design-cloud-sync.md §7.2 的 /v1/doc 协议适配成 SyncTarget 接口）：
 * 引擎的推拉/冲突逻辑零改动复用。信封在 writeBlob 暂存、writeManifest 一并 PUT（If-Match 基线）。
 * 出站超时 10s（详设 §7.5）。
 */
import { request } from 'undici'
import { t } from '../../util/i18n.js'
import { blobRefOf, type SyncManifest, type SyncTarget } from './types.js'

export interface CloudTargetOptions {
  url: string
  token: string
  devid: string
}

const TIMEOUT_MS = 10_000
/** 云端模式的 blobRef 常量：信封随 manifest 一体存取，无独立 blob 路径 */
export const CLOUD_ENVELOPE_REF = 'envelope'

export function createCloudTarget(opts: CloudTargetOptions): SyncTarget {
  const base = opts.url.replace(/\/+$/, '')
  const auth = { authorization: `Bearer ${opts.token}` }
  let cached: { rev: number; ts: string; byDevid: string; envelope: string } | null = null
  let pendingEnvelope: string | null = null

  async function call(method: string, url: string, extra: Record<string, string>, body?: string): Promise<{ code: number; text: string }> {
    let res
    try {
      res = await request(url, { method, headers: { ...auth, ...extra }, body, signal: AbortSignal.timeout(TIMEOUT_MS) })
    } catch (e) {
      throw new Error(t('云端不可达（{url}）：{err}', 'Cloud unreachable ({url}): {err}', { url, err: (e as Error).message }))
    }
    const text = await res.body.text().catch(() => '')
    return { code: res.statusCode, text }
  }

  function manifestOf(): SyncManifest {
    if (!cached) throw new Error(t('云端文档尚未拉取', 'Cloud document has not been fetched yet'))
    return { rev: cached.rev, ts: cached.ts, byDevid: cached.byDevid, blobRef: blobRefOf(cached.rev, opts.devid) }
  }

  return {
    async readManifest(): Promise<SyncManifest | null> {
      const r = await call('GET', `${base}/v1/doc`, cached ? { 'if-none-match': String(cached.rev) } : {})
      if (r.code === 304 && cached) return manifestOf()
      if (r.code === 404) return null
      if (r.code !== 200) {
        throw new Error(t('读取云端文档失败（HTTP {code}）', 'Failed to read the cloud document (HTTP {code})', { code: r.code }))
      }
      const b = JSON.parse(r.text) as { rev: number; envelope: string; ts: string; byDevid: string }
      cached = { rev: b.rev, ts: b.ts, byDevid: b.byDevid, envelope: b.envelope }
      return manifestOf()
    },
    async readBlob(): Promise<string> {
      if (!cached) {
        throw new Error(t('云端文档尚未拉取', 'Cloud document has not been fetched yet'))
      }
      return cached.envelope
    },
    async writeBlob(_rev, _devid, envelope): Promise<void> {
      pendingEnvelope = envelope
      // ts 由 writeManifest 统一携带（即信封的导出时间）
    },
    async writeManifest(m, baseRev): Promise<'ok' | 'conflict'> {
      if (!pendingEnvelope) {
        throw new Error(t('内部错误：推送前未暂存信封', 'Internal error: no envelope staged before push'))
      }
      const r = await call('PUT', `${base}/v1/doc`, { 'if-match': String(baseRev), 'content-type': 'application/json' }, JSON.stringify({ envelope: pendingEnvelope, ts: m.ts }))
      const staged = pendingEnvelope
      pendingEnvelope = null
      if (r.code === 409) return 'conflict'
      if (r.code === 422) {
        throw new Error(t('云端拒收：包时间早于云端现有版本（疑似回滚）。本机时钟异常时请校准后再试', 'Cloud rejected the push: the package is older than the stored version (possible rollback). Check this machine\'s clock and retry'))
      }
      if (r.code !== 200) {
        throw new Error(t('推送云端文档失败（HTTP {code}）：{msg}', 'Failed to push the cloud document (HTTP {code}): {msg}', { code: r.code, msg: r.text.slice(0, 200) }))
      }
      const b = JSON.parse(r.text) as { rev: number }
      cached = { rev: b.rev, ts: m.ts, byDevid: opts.devid, envelope: staged }
      return 'ok'
    },
  }
}
