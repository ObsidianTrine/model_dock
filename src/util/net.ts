import { Agent, ProxyAgent, type Dispatcher } from 'undici'

/** 上游连接空闲复用窗口：undici 全局 dispatcher 的 keepAliveTimeout 默认仅 4s，AI 请求间隔
 *  普遍超过它，每次都要重付 TCP+TLS 握手（跨境 100ms+）。55s 保守值低于常见反代默认
 *  keep-alive（nginx 75s），降低「服务端已断、客户端还在复用」的竞态面：对端在空闲期发的 FIN
 *  会让 socket 关闭并被连接池剔除，池里不会留死连接；FIN 与请求在途交叠的极端情形由既有的
 *  连接错误重试兜底（relay.ts 的 isConnectError 含 ECONNRESET/EPIPE）。三平台纯库行为，无差异。 */
const UPSTREAM_KEEPALIVE = {
  keepAliveTimeout: 55_000,
  keepAliveMaxTimeout: 600_000,
  keepAliveTimeoutThreshold: 2_000,
} as const

/** direct 直连共享 Agent：此前回落全局 dispatcher（4s 空闲断连），显式持有一份调优实例。
 *  模块级单例与 runtime 生命周期解耦——reloadRuntime 清 dispatcher 缓存时不关它，跨重载复用。 */
const directAgent = new Agent(UPSTREAM_KEEPALIVE)

/** 解析 proxy 配置为实际代理 URL：'direct'/未配置 → null；'env' → 环境变量值（空串视为未设，
 *  与原 buildDispatcher 的 truthy 判断一致）；URL 字符串 → 原样。供 buildDispatcher 与调用方的
 *  dispatcher 缓存 key 共用——'env' 模式的缓存 key 必须用解析后的 URL，拿 'env' 字符串当 key
 *  会把首次解析结果冻结（环境变量变了仍走旧代理）。 */
export function resolveProxyUrl(proxy?: string): string | null {
  const mode = proxy ?? 'direct'
  if (mode === 'direct') return null
  if (mode === 'env') {
    const raw =
      process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.HTTP_PROXY ?? process.env.http_proxy
    return raw || null
  }
  return mode
}

/** provider.proxy → dispatcher；'direct' 返回共享调优 Agent，'env' 读 HTTPS_PROXY/HTTP_PROXY（兼容 clash 等本地代理）。
 *  本函数无状态、每次调用都新建 ProxyAgent（连接池归属调用方）——需要复用的路径在调用侧按
 *  resolveProxyUrl 结果缓存（update/transfer.ts 与 providers/fetch.ts 的 dispatcherFor 同款），
 *  网关转发走 gateway/proxy.ts 的 rt.dispatchers（随热加载销毁重建）。
 *  ProxyAgent 的 keepAlive* 选项经内部 {...opts} 透传给按 origin 建的 Agent；注意不能传 connect
 *  对象（构造器把 connect 当 connector 函数解读，proxy TLS 走 requestTls/proxyTls 选项）。 */
export function buildDispatcher(proxy?: string): Dispatcher {
  const url = resolveProxyUrl(proxy)
  if (!url) return directAgent
  return new ProxyAgent({ uri: url, ...UPSTREAM_KEEPALIVE })
}