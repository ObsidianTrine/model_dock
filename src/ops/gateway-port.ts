import { DEFAULT_GATEWAY_PORT } from '../config/types.js'
import { gatewayLive } from '../gateway/state.js'

/** 探测某端口是否有存活的 ModelDock 网关（health 端点 1s 内可达）。 */
async function gatewayHealthOk(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/_modeldock/health`, { signal: AbortSignal.timeout(1000) })
    return res.ok
  } catch {
    return false
  }
}

/** 写客户端文件的目标网关端口解析。优先级：显式端口 > 生产默认端口的存活网关 > 状态文件里的存活网关 > 配置值 > 默认。
 *  多实例（生产 8687 + dev 8890 等）共用一份配置与单一网关状态文件，状态文件只记录"最后启动的实例"——
 *  若直接采信，dev 实例会把真实客户端文件重写到自己的端口（2026-10-01 用户实测踩中：生产控制台
 *  接入/切换服务后，客户端 detail 恒为 http://127.0.0.1:8890）。网关自身的操作必须显式传 rt.port。 */
export async function resolveClientGatewayPort(explicit: number | undefined, cfgPort: number | undefined): Promise<number> {
  if (explicit) return explicit
  // 沙箱（FAKE_HOME）是「独立机器」：不得探测生产默认端口的存活网关——否则沙箱内 CLI 未显式
  // 传端口的 attach/刷新会把客户端文件指到真机 8687，破坏沙箱隔离语义（CORRECT-05 同域）
  if (!process.env.MODELRDOCK_FAKE_HOME && (await gatewayHealthOk(DEFAULT_GATEWAY_PORT))) return DEFAULT_GATEWAY_PORT
  return (await gatewayLive())?.port ?? cfgPort ?? DEFAULT_GATEWAY_PORT
}
