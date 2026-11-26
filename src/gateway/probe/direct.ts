import { request as undiciRequest } from 'undici'
import type { ProviderConfig } from '../../config/types.js'
import { t } from '../../util/i18n.js'
import { dispatcherFor } from '../proxy.js'
import { forwardToUpstream, readBodyBounded, readUpstreamErrorText, UPSTREAM_ERROR_BODY_MAX_BYTES, UpstreamError } from '../relay.js'
import type { GatewayRuntime } from '../state.js'
import { probeWire } from './wire.js'

export interface ProbeResult {
  ok: boolean
  status: number
  ms: number
  ttfb_ms?: number
  model?: string
  usage?: Record<string, number>
  err?: string
  hint?: string
}

/** 端到端探测：按 profile 发一次最小请求（modeldock test 的后端） */
export async function probe(
  rt: GatewayRuntime,
  target: import('../state.js').ResolvedTarget,
  modelOverride: string | undefined,
  stream: boolean,
  o: { idle: number; retries: number }
): Promise<ProbeResult> {
  const t0 = Date.now()
  const model = modelOverride ?? target.profile.default_model
  if (!model) {
    return { ok: false, status: 0, ms: 0, err: t('该 profile 未设置 default_model，请用 -m 指定或 modeldock profile 修改', 'This profile has no default_model; pass -m or change it with modeldock profile') }
  }
  // 按服务协议拼探针路径与 body：三协议拼装收口到 probe/wire.ts（探针 runners 同源复用，
  // 防口径漂移）。responses 是一等协议（hServiceAdd/hFetchModels 均接受），此前二分法只认
  // anthropic/其他——responses 服务被拼成 /v1/chat/completions，经 clientProtocolFromPath 判成
  // openai，upstreamEndpoint 对未配 openai 端点的服务抛 400，报错还把责任推给「客户端走
  // openai 协议」（实际探针拼错了协议）
  const wire = probeWire(target.provider.protocol, model, { stream })
  const path = wire.path
  const body = wire.body
  try {
    const up = await forwardToUpstream(rt, target, {
      method: 'POST',
      path,
      headers: { 'content-type': 'application/json' },
      body,
      idleTimeoutMs: o.idle,
      retries: o.retries,
    })
    if (up.status >= 400) {
      // 有界读（P2-6 收尾）：探针响应体此前无界，异常上游的超大 body 会整体进堆；
      // readUpstreamErrorText 同时按 content-encoding 解压——压缩错误体直读是乱码，
      // message/hint 提取随之失效
      const text = await readUpstreamErrorText(up.headers, up.body)
      // 转成可读的一行：上游 message + 修复提示，而非整段 JSON
      let msg = text.slice(0, 400)
      try {
        const j = JSON.parse(text)
        msg = [j?.error?.message, j?.modeldock?.hint].filter(Boolean).join(' → ')
      } catch {
        /* 非 JSON 保持原文 */
      }
      return {
        ok: false,
        status: up.status,
        ms: Date.now() - t0,
        model,
        err: msg,
      }
    }
    // 成功体同样有界读（P2-6 收尾）：探测只取 usage（max_tokens=16 的响应 KB 级，1MB 上限
    // 绰绰有余）；截断会让 JSON.parse 失败 → usage 缺席，仅观测降级不致错（见 readBodyBounded 注）
    const text = (await readBodyBounded(up.body, UPSTREAM_ERROR_BODY_MAX_BYTES)).toString('utf8')
    let usage: Record<string, number> | undefined
    if (!stream) {
      try {
        const j = JSON.parse(text)
        const u = j?.usage
        if (u && typeof u === 'object') {
          usage = {}
          for (const [k, v] of Object.entries(u)) {
            if (typeof v === 'number') usage[k] = v
          }
        }
      } catch {
        /* SSE 或非 JSON */
      }
    }
    return { ok: true, status: up.status, ms: Date.now() - t0, model: up.modelAfter ?? model, usage }
  } catch (e) {
    const ue = e as UpstreamError
    return { ok: false, status: ue.status ?? 502, ms: Date.now() - t0, model, err: ue.message, hint: ue.hint }
  }
}

export interface PingResult {
  ok: boolean
  ms: number
  err?: string
  hint?: string
}

/** 纯网络延迟探测：向 provider 的 origin 发一次最小请求，测「首字节到达」耗时（不做模型推理） */
export async function probePing(
  rt: GatewayRuntime,
  provider: ProviderConfig
): Promise<PingResult> {
  const base = (provider.base_url ?? '').trim()
  if (!base) {
    return { ok: false, ms: 0, err: t('provider 未配置 base_url', 'Provider has no base_url configured') }
  }
  let origin: string
  try {
    origin = new URL(base).origin
  } catch {
    return { ok: false, ms: 0, err: t('base_url 无效：{url}', 'Invalid base_url: {url}', { url: base }) }
  }
  const t0 = Date.now()
  try {
    // 请求到 origin 根路径即可；不鉴权、不推理，只测网络往返
    const res = await undiciRequest(origin + '/', {
      method: 'GET',
      dispatcher: dispatcherFor(rt, provider),
      headersTimeout: 10_000,
      bodyTimeout: 10_000,
    })
    const ms = Date.now() - t0
    // 排空响应体让连接回 keepalive 池（旧实现 destroy 每次烧掉一条复用连接——探活一多就把
    // per-provider 连接池打穿，后续真实请求被迫重建 TCP/TLS）。error 抑制保留：排空中连接
    // 中止不上抛；dump 失败（慢上游/断连）best-effort 吞掉，不影响探测结论（ms 在首字节
    // 到达时已记下，2026-11-04 审查 P2）
    if (typeof (res.body as unknown as { on?: Function }).on === 'function') {
      ;(res.body as unknown as NodeJS.EventEmitter).on('error', () => {})
    }
    try {
      await res.body.dump()
    } catch { /* 排空失败（超时/断连）不影响探测结果 */ }
    return { ok: true, ms }
  } catch (e) {
    return {
      ok: false,
      ms: Date.now() - t0,
      err: t('网络不可达：{msg}', 'Network unreachable: {msg}', { msg: (e as Error).message }),
      hint: t('检查网络/代理（provider.proxy），或本地是否放行了该域名', 'Check network/proxy (provider.proxy), or whether this domain is blocked locally'),
    }
  }
}
