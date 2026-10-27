/** 远端设备域：设备记忆登记、sync ticket、远程请求簿记与执行、fetch-models 负缓存（由 server.ts 拆出，T05，纯搬移零改写）。块序 = 原文件相对次序，未重排未删改。 */
import os from 'node:os'
import { randomBytes } from 'node:crypto'
import { randomToken } from '../util/fsx.js'
import { AdminCtx, jsonRequestBody, persistConfig, sendError } from './admin-shared.js'
import { applyImportedDoc, reportOfDoc } from '../sync/exportImport.js'
import { fetchEnvelopeFromUrl, projectModel } from './shared.js'
import { mutateGatewayState, type GatewayRuntime } from './state.js'
import { openEnvelope, sealEnvelope } from '../sync/crypto.js'
import { validateSyncdoc, type Syncdoc } from '../sync/types.js'
import { bi, t } from '../util/i18n.js'
import { localIsoTs } from '../util/time.js'
/** 登记「设备记忆」值到 gateway.json 的 devices（FIFO 上限 20）。失败不影响登录本身。 */
export async function registerWebDevice(rt: GatewayRuntime, device: string): Promise<void> {
  try {
    await mutateGatewayState((state) => {
      const devices = [device, ...(state?.devices ?? []).filter((d) => d !== device)].slice(0, 20)
      if (state) return { ...state, devices }
      // 无状态文件（测试/嵌入式启动）：用运行时信息补一个最小状态，设备记忆才有落点
      return {
        pid: process.pid,
        port: rt.port ?? 0,
        admin_token: rt.adminToken,
        started_at: localIsoTs(new Date(rt.startedAt)),
        devices,
      }
    })
  } catch {
    /* 登记失败不影响登录 */
  }
}

export const SYNC_TICKET_TTL_MS = 5 * 60 * 1000

/** 票据：preview 阶段解密后的 doc 存内存（网关本就持有 secrets 明文缓存，无新增暴露等级），单次 + 5min TTL */
export const syncTickets = new Map<string, { doc: Syncdoc; createdAt: number }>()

export function putSyncTicket(doc: Syncdoc): string {
  sweepSyncTickets()
  const ticket = randomToken('mdkticket')
  syncTickets.set(ticket, { doc, createdAt: Date.now() })
  return ticket
}

export function sweepSyncTickets(): void {
  for (const [k, v] of syncTickets) {
    if (Date.now() - v.createdAt > SYNC_TICKET_TTL_MS) syncTickets.delete(k)
  }
}

export function takeSyncTicket(ticket: string): Syncdoc {
  const hit = ticket ? syncTickets.get(ticket) : undefined
  if (!hit || Date.now() - hit.createdAt > SYNC_TICKET_TTL_MS) {
    if (ticket) syncTickets.delete(ticket)
    throw new Error(t('票据无效或已过期，请重新预览', 'Ticket invalid or expired; preview again'))
  }
  syncTickets.delete(ticket) // 单次：确认导入后即焚
  return hit.doc
}

// 附近电脑确认式直拉（sync-nearby，B 机发起侧）

export const REMOTE_REQUEST_TTL_MS = 5 * 60 * 1000
export const remoteRequests = new Map<string, RemoteRequestState>()

export function sweepRemoteRequests(): void {
  for (const [k, v] of remoteRequests) {
    if (Date.now() - v.createdAt > REMOTE_REQUEST_TTL_MS) remoteRequests.delete(k)
  }
}

// fetch-models 失败负缓存：键 = 协议|地址|key 摘要（明文 key 不进 Map 键）。上游不可达时
// 60s 内同键请求直接复用上次失败信息，不再重跑 8 端点×15s 的候选链；改 Key/地址即换键不受影响
export const FETCH_MODEL_FAIL_TTL_MS = 60_000
export const fetchModelFailMemo = new Map<string, { at: number; msg: string }>()
export function rememberFetchModelFail(key: string, msg: string): void {
  const now = Date.now()
  for (const [k, v] of fetchModelFailMemo) {
    if (now - v.at > FETCH_MODEL_FAIL_TTL_MS) fetchModelFailMemo.delete(k)
  }
  fetchModelFailMemo.set(key, { at: now, msg })
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** B 机后台链路：向选中的附近电脑敲门（多网卡候选 IP 依次尝试）→ 轮询授权（A 用户在确认卡
 *  点允许/拒绝）→ 拿到一次性直拉链接 → 拉信封（pull 端点焚毁）→ 验签 → 存票据。
 *  全程包体恒密文；失败/拒绝/超时都落状态供前端轮询展示。 */
export async function runRemoteRequest(requestId: string, ips: string[], port: number): Promise<void> {
  const nonce = randomBytes(24).toString('hex')
  const from = os.hostname().slice(0, 128)
  const set = (patch: Omit<RemoteRequestState, 'createdAt'>): void => {
    // 条目可能已被 5min TTL 清扫（敲门逐 IP 5s 超时 + 授权轮询，总时长可超 TTL）：
    // 缺失时须以当前时间重建 createdAt，否则 ...undefined 展开产出无 createdAt 的条目，
    // Date.now() - undefined = NaN 永不过期 → 每次晚完成的请求留一个「永生」条目
    const prev = remoteRequests.get(requestId)
    remoteRequests.set(requestId, { ...(prev ?? { createdAt: Date.now() }), ...patch })
  }
  try {
    // 敲门：候选 IP 逐个尝试（同机 127.0.0.1 / 局域网多网卡），任一成功即可
    let knocked = false
    let knockedIp = ''
    let lastErr = ''
    for (const ip of ips) {
      try {
        const knock = await fetch(`http://${ip}:${port}/m/sync/request`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ nonce, from }),
          signal: AbortSignal.timeout(5000),
        })
        if (!knock.ok) {
          lastErr = t('对方未接受请求（HTTP {status}）', 'The other computer rejected the request (HTTP {status})', { status: knock.status })
          continue
        }
        knocked = true
        knockedIp = ip
        break
      } catch (e) {
        lastErr = (e as Error).message
      }
    }
    if (!knocked) throw new Error(lastErr || t('对方不可达', 'The other computer is unreachable'))
    let grant: { url: string; passphrase: string } | { denied: true } | null = null
    for (let i = 0; i < 60 && !grant; i++) {
      await sleep(1000)
      const g = await fetch(`http://${knockedIp}:${port}/m/sync/grant?n=${nonce}`, { signal: AbortSignal.timeout(3000) })
      if (g.status === 403) grant = { denied: true }
      else if (g.ok) {
        const j = (await g.json()) as { url?: string; passphrase?: string }
        if (j.url && j.passphrase) grant = { url: j.url, passphrase: j.passphrase }
      }
    }
    if (!grant) {
      set({ status: 'timeout' })
      return
    }
    if ('denied' in grant) {
      set({ status: 'denied' })
      return
    }
    const envText = await fetchEnvelopeFromUrl(grant.url)
    const env: unknown = JSON.parse(envText)
    const doc = validateSyncdoc(openEnvelope(env, grant.passphrase))
    const metaEnv = env as Record<string, unknown>
    set({ status: 'granted', ticket: putSyncTicket(doc), report: reportOfDoc(doc), meta: { createdBy: String(metaEnv.created_by ?? ''), createdAt: String(metaEnv.created_at ?? '') } })
  } catch (e) {
    set({ status: 'failed', error: (e as Error).message })
  }
}

// ===== admin 端点处理器（模块级，逐字搬自 handleAdmin 原 if 链，行为零变化）=====
// 分层鉴权不变：tier-1 豁免端点与 admin 门仍留在 handleAdmin；命中 ADMIN_ROUTES 即已过门。

export async function hSyncRequestRemote(c: AdminCtx): Promise<void> {
  const { req, res, audit } = c
  // B 机发起：向选中的附近电脑敲门并后台轮询授权，立即返回 requestId 供前端轮询
  const b = await jsonRequestBody(req)
  try {
    const ips = Array.isArray(b.ips) ? (b.ips as unknown[]).filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim()) : []
    const port = Number(b.port)
    if (!ips.length || !Number.isInteger(port) || port <= 0 || port > 65535) {
      throw new Error(t('目标电脑参数不完整', 'Invalid target computer'))
    }
    sweepRemoteRequests()
    const requestId = randomToken('mdknear')
    remoteRequests.set(requestId, { status: 'waiting', createdAt: Date.now() })
    void runRemoteRequest(requestId, ips, port).catch(() => {
      /* runRemoteRequest 内部已兜底落 failed 状态 */
    })
    audit(bi('附近配置直拉', 'Nearby config pull'), bi('已发送请求', 'request sent'), bi(`${ips[0]}:${port}`, `${ips[0]}:${port}`))
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, requestId }))
  } catch (e) {
    audit(bi('附近配置直拉', 'Nearby config pull'), '-', undefined, (e as Error).message)
    sendError(res, 400, (e as Error).message)
  }
  return
}

export async function hSyncRemoteStatus(c: AdminCtx): Promise<void> {
  const { req, res } = c
  const q = new URL(req.url ?? '', 'http://x').searchParams
  sweepRemoteRequests()
  const st = remoteRequests.get(q.get('id') ?? '')
  if (!st) return sendError(res, 404, t('请求不存在或已过期', 'Request not found or expired'))
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ ok: true, ...st }))
  return
}


export interface RemoteRequestState {
  status: 'waiting' | 'granted' | 'denied' | 'timeout' | 'failed'
  ticket?: string
  report?: ReturnType<typeof reportOfDoc>
  meta?: { createdBy: string; createdAt: string }
  error?: string
  createdAt: number
}
