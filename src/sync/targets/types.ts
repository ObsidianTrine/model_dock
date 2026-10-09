/**
 * 同步目标抽象（docs/design-cloud-sync.md §6.1）。
 * 接口收窄到 manifest/blob 四操作：WebDAV/localdir 之外的新存储（网盘、S3 类）零改动接入引擎。
 */
import { t } from '../../util/i18n.js'

/** 存储上的清单（<root>/manifest.json 的内容） */
export interface SyncManifest {
  rev: number
  ts: string
  byDevid: string
  /** 相对同步根目录的 blob 路径：blobs/<rev>-<devid>.msync */
  blobRef: string
}

export interface SyncTarget {
  /** 无清单（全新目标）返回 null */
  readManifest(): Promise<SyncManifest | null>
  /** 写加密信封 blob（blobs/ 只增不删，保留全部历史） */
  writeBlob(rev: number, devid: string, envelope: string): Promise<void>
  /** 读-改-写清单；baseRev 与存储上的当前 rev 不符 → 'conflict'（D6 冲突语义的检测点） */
  writeManifest(m: SyncManifest, baseRev: number): Promise<'ok' | 'conflict'>
  readBlob(ref: string): Promise<string>
}

export function blobRefOf(rev: number, devid: string): string {
  return `blobs/${rev}-${devid}.msync`
}

/** 同步目录名（localdir 与 WebDAV 两种目标内的固定子目录） */
export const SYNC_DIRNAME = 'modeldock-sync'

/** manifest 内容校验（localdir/WebDAV 共用）。字段不符抛可操作报错，调用方不应用 */
export function parseManifest(text: string): SyncManifest {
  let m: unknown
  try {
    m = JSON.parse(text)
  } catch {
    throw new Error(t('同步清单 manifest.json 不是合法 JSON：同步目标上的文件可能被破坏', 'The sync manifest is not valid JSON: the file on the sync target may be corrupted'))
  }
  const r = m as Record<string, unknown>
  if (typeof r.rev !== 'number' || !Number.isInteger(r.rev) || r.rev < 0 || typeof r.ts !== 'string' || !r.ts || typeof r.byDevid !== 'string' || !r.byDevid || typeof r.blobRef !== 'string' || !r.blobRef) {
    throw new Error(t('同步清单 manifest.json 字段不完整：同步目标上的文件可能被破坏', 'The sync manifest is missing required fields: the file on the sync target may be corrupted'))
  }
  return m as SyncManifest
}
