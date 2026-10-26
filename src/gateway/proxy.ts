/**
 * 上游代理 dispatcher 构建。实现已下沉到 `src/util/net.ts`（无状态 undici 纯函数，供 providers
 *  与 gateway 两侧共用，避免 providers 层反向依赖 gateway 层——DESIGN-05）；本文件保留 re-export
 *  作为调用方 shim（diag.ts / 既有测试仍从 `gateway/proxy` 引入）。
 *
 *  `dispatcherFor` 从 state.ts 移入本文件（P1 启动链修复）：state.ts 是 gatewayLive/运行态的
 *  CLI 侧公共入口，此前对 `./proxy.js` 的静态 import 把 undici（net.ts 顶层 `new Agent`）拖进
 *  每条 CLI 命令的启动链——`--help` / `gateway stop` 都要白付。本文件只在网关侧（relay/server）
 *  被 import，undici 成本只由真正需要它的进程承担。
 */
import type { ProviderConfig } from '../config/types.js'
import type { GatewayRuntime } from './state.js'
import type { Dispatcher } from 'undici'
import { buildDispatcher } from '../util/net.js'

export { buildDispatcher } from '../util/net.js'

/** per-provider 代理：direct 直连；env 读环境变量；字符串视为代理 URL（兼容 clash） */
export function dispatcherFor(rt: GatewayRuntime, provider: ProviderConfig): Dispatcher | undefined {
  const mode = provider.proxy ?? 'direct'
  if (rt.dispatchers.has(mode)) return rt.dispatchers.get(mode)
  const created = buildDispatcher(provider.proxy)
  rt.dispatchers.set(mode, created)
  return created
}
