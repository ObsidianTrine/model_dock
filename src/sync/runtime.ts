/** 引擎与 setup 共用的运行时辅助：密钥缓存换算、目标构造、可同步态指纹（叶模块，避免循环依赖） */
import { syncVerifier, type SyncKeys } from './crypto.js'
import type { Syncdoc } from './types.js'
import type { SyncCloudConfig, SyncKeyCache, SyncState, SyncTargetConfig } from './state.js'
import type { SyncTarget } from './targets/types.js'
import { createLocaldirTarget } from './targets/localdir.js'
import { createWebdavTarget } from './targets/webdav.js'
import { createCloudTarget } from './targets/cloud.js'
import { sha256 } from '../util/fsx.js'
import { t } from '../util/i18n.js'

export type { SyncKeys, SyncTarget }

/** sync.json 缓存的密钥 → 引擎直用的密钥材料 */
export function keysFromState(state: SyncState): SyncKeys {
  const k = state.key!
  return {
    encKey: Buffer.from(k.encKey, 'base64'),
    macKey: Buffer.from(k.macKey, 'base64'),
    salt: Buffer.from(k.salt, 'base64'),
    hkdfSalt: Buffer.from(k.hkdfSalt, 'base64'),
  }
}

/** 派生密钥 → sync.json 缓存形态 */
export function keysToCache(keys: SyncKeys): SyncKeyCache {
  return {
    salt: keys.salt.toString('base64'),
    hkdfSalt: keys.hkdfSalt.toString('base64'),
    encKey: keys.encKey.toString('base64'),
    macKey: keys.macKey.toString('base64'),
    verifier: syncVerifier(keys.macKey),
  }
}

export function createTarget(cfg: SyncTargetConfig): SyncTarget {
  if (cfg.kind === 'webdav') return createWebdavTarget({ url: cfg.url, dir: cfg.dir, username: cfg.username, password: cfg.password })
  return createLocaldirTarget(cfg.dir)
}

export function createCloudTargetFrom(cfg: { url: string; devid: string; token: string }): SyncTarget {
  return createCloudTarget({ url: cfg.url, token: cfg.token, devid: cfg.devid })
}

/** 按同步模式解析目标（target=WebDAV/localdir；cloud=自托管控制面）。engine tick 每次现取，改配置即时生效 */
export function targetFromState(state: SyncState): SyncTarget {
  if (state.mode === 'cloud' && state.cloud) return createCloudTargetFrom(state.cloud)
  if (state.mode === 'target' && state.target) return createTarget(state.target)
  throw new Error(t('sync.json 未配置同步目标', 'sync.json has no sync target configured'))
}

/** 稳定键序序列化：只用于本地前后两次收集的指纹比较（apply 后 key_ref 重写由重收集吸收） */
function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']'
  if (typeof v === 'object' && v !== null) {
    const obj = v as Record<string, unknown>
    return (
      '{' +
      Object.keys(obj)
        .sort()
        .map((k) => JSON.stringify(k) + ':' + stableStringify(obj[k]))
        .join(',') +
      '}'
    )
  }
  return JSON.stringify(v)
}

/** 本机可同步态内容指纹（不含 ts——时间戳不参与相等判断） */
export function hashDoc(doc: Syncdoc): string {
  return sha256(stableStringify(doc.data))
}
