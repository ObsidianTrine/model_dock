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
}
