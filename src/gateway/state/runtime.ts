import type { Config } from '../../config/types.js'
import type { GatewayRuntime } from './types.js'

export function buildTokenIndex(config: Config): Map<string, string> {
  const map = new Map<string, string>()
  for (const [id, he] of Object.entries(config.harness ?? {})) {
    if (he.token) map.set(he.token, id)
  }
  return map
}

export function buildRuntime(config: Config, adminToken: string): GatewayRuntime {
  return {
    config,
    tokens: buildTokenIndex(config),
    ring: [],
    startedAt: Date.now(),
    adminToken,
    reloads: 0,
    dispatchers: new Map(),
    health: new Map(),
    tokenUsage: new Map(),
    metricsLatency: new Map(),
    seaErrors: new Map(),
    modelProbe: { results: new Map(), inflight: new Set() },
  }
}

export async function reloadRuntime(rt: GatewayRuntime): Promise<void> {
  const { loadConfig } = await import('../../config/store.js')
  const { invalidateSecretsCache } = await import('../../config/secrets.js')
  // 文件 watcher 触发的 reload 会经过这里：清 file/外部后端密钥缓存，另一进程改的 key 即刻（再读盘）生效
  invalidateSecretsCache()
  rt.config = await loadConfig()
  rt.tokens = buildTokenIndex(rt.config)
  rt.reloads++
  // 释放旧的代理 dispatcher（ProxyAgent 连接）；direct 共享 Agent 是模块级单例、跨重载复用，不关
  const keep = rt.dispatchers.get('direct')
  for (const d of rt.dispatchers.values()) {
    if (d && d !== keep && typeof d.close === 'function') {
      Promise.resolve(d.close()).catch(() => {})
    }
  }
  rt.dispatchers.clear()
  // 已删除的 provider 健康条目一并清掉：长生命周期进程反复增删服务不残留（recordOutcome 只增不删）
  for (const id of rt.health.keys()) {
    if (!rt.config.providers[id]) rt.health.delete(id)
  }
  // 海况分桶与模型探测缓存同口径清理：recordOutcome / 周期探测同样只增不删
  for (const id of rt.seaErrors?.keys() ?? []) {
    if (!rt.config.providers[id]) rt.seaErrors?.delete(id)
  }
  for (const id of rt.modelProbe?.results.keys() ?? []) {
    if (!rt.config.providers[id]) rt.modelProbe?.results.delete(id)
  }
}
