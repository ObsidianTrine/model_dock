/**
 * 上游代理 dispatcher 构建。实现已下沉到 `src/util/net.ts`（无状态 undici 纯函数，供 providers
 *  与 gateway 两侧共用，避免 providers 层反向依赖 gateway 层——DESIGN-05）；本文件保留 re-export
 *  作为调用方 shim（state.ts / diag.ts / 既有测试仍从 `gateway/proxy` 引入）。
 */
export { buildDispatcher } from '../util/net.js'