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

/** provider.proxy → dispatcher；'direct' 返回共享调优 Agent，'env' 读 HTTPS_PROXY/HTTP_PROXY（兼容 clash 等本地代理）。
 *  ProxyAgent 的 keepAlive* 选项经内部 {...opts} 透传给按 origin 建的 Agent；注意不能传 connect
 *  对象（构造器把 connect 当 connector 函数解读，proxy TLS 走 requestTls/proxyTls 选项）。 */
export function buildDispatcher(proxy?: string): Dispatcher {
  const mode = proxy ?? 'direct'
  if (mode === 'direct') return directAgent
  if (mode === 'env') {
    const url =
      process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.HTTP_PROXY ?? process.env.http_proxy
    return url ? new ProxyAgent({ uri: url, ...UPSTREAM_KEEPALIVE }) : directAgent
  }
  return new ProxyAgent({ uri: mode, ...UPSTREAM_KEEPALIVE })
}