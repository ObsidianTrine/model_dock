import http from 'node:http'
import { runWithLang, normalizeLang, getLang, t } from '../util/i18n.js'
import { errorReply, sendError } from './admin-shared.js'
import { handleRequest } from './dataplane.js'
import { probe, probePing } from './probe/direct.js'
import { startSchedulers } from './scheduler.js'
import type { GatewayStartOptions } from './start-options.js'
import type { GatewayRuntime } from './state.js'

// T05 拆分后保持原导入面：测试与潜在外部引用仍按 server.js 路径取这些符号
export { OVERVIEW_TTL_MS, overviewCacheHit, overviewServeDecision, warmupOverview } from './overview-view.js'
export { runClientInstall, runClientUninstall } from './install.js'
export { errorReply, maxBodyBytes } from './admin-shared.js'
export { probe, probePing }
export type { PingResult, ProbeResult } from './probe/direct.js'
export type { GatewayStartOptions } from './start-options.js'

export function createGatewayServer(rt: GatewayRuntime, opts: GatewayStartOptions): http.Server {
  const idle = opts.idleTimeoutMs ?? 10 * 60_000
  const retries = opts.retries ?? 1
  const server = http.createServer((req, res) => {
    // 请求级语言：浏览器会话经 x-modeldock-lang 头声明（控制台 fetch 统一携带），
    // 本请求生成的全部服务端文案（错误提示/客户端卡片描述/审计条目）随之；无头回落网关默认语言。
    // AsyncLocalStorage 随异步链传播，并发请求互不串扰。
    const reqLang = normalizeLang(req.headers['x-modeldock-lang'] as string | undefined) ?? getLang()
    void runWithLang(reqLang, async () => {
      try {
        await handleRequest(rt, req, res, { idle, retries })
      } catch (e) {
        // 顶层兜底：漏出的已知错误（UpstreamError / ConfigError / 带 hint 的业务错误）映射为
        // 正确状态码并保留 message + hint——控制台的失败提示依赖它们，不再一律 500「网关内部错误」
        if (res.headersSent) {
          res.destroy()
          return
        }
        const r = errorReply(e)
        if (r.status >= 500) console.error("[gateway] %s %s %s", req.method, req.url ?? "", t('网关内部错误:', 'Gateway internal error:'), e)
        sendError(res, r.status, r.message, r.hint)
      }
    })
  })
  server.requestTimeout = 0
  server.headersTimeout = 60_000
  server.keepAliveTimeout = 75_000
  server.timeout = idle
  server.on('connection', (s) => s.setNoDelay(true))
  // 实际端口自动回写 rt.port：登录 cookie 名内嵌端口号做同机双实例隔离（cookies.ts），
  // 端口必须以真实监听地址为准（EADDRINUSE 顺延、listen(0) 随机端口都覆盖），不能靠调用方手动赋值
  server.on('listening', () => {
    const addr = server.address()
    if (addr && typeof addr === 'object') rt.port = addr.port
  })

  startSchedulers(rt, server, opts)

  return server
}
