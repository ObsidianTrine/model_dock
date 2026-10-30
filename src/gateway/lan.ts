import crypto from 'node:crypto'
import dgram from 'node:dgram'
import http from 'node:http'
import os from 'node:os'
import qrcode from 'qrcode-generator'
import { DEFAULT_LAN_PORT } from '../config/types.js'
import { refreshBakedModelClients, setAutoRoute, setRouteNext, switchToServiceWithRoute } from '../ops.js'
import { applySyncdoc, collectSyncdoc } from '../sync/collect.js'
import { openEnvelope, sealEnvelope } from '../sync/crypto.js'
import { assertExportable, exportFileName, reportOfDoc } from '../sync/exportImport.js'
import { validateSyncdoc } from '../sync/types.js'
import { randomToken } from '../util/fsx.js'
import { t } from '../util/i18n.js'
import { safeEqual } from '../util/safe-equal.js'
import { listenWithRetry, projectModel, fetchEnvelopeFromUrl } from './shared.js'
import { localIsoTs } from '../util/time.js'
import { autoRouteInfo, logAudit, reloadRuntime, type GatewayRuntime } from './state.js'
import { CONSOLE_CSP } from './console-shared.js'
import { lanCookieName } from './cookies.js'
import { LAN_ICON_192_PNG, LAN_ICON_512_PNG } from './lanAssets.js'
import { renderDeniedPage, renderMobilePage } from './lan-mobile-page.js'
import { startSyncBeacon, stopSyncBeacon } from './discover.js'

// 手机页模板本体已抽至 lan-mobile-page.ts（纯字符串模块）；renderMobilePage 继续从本模块导出，调用点零改动
export { renderMobilePage }

/** 手机简版控制台（LAN）：独立于 8687 主端口的第二监听器。
 *  只暴露「看状态 + 切服务」两个只读级 API 与一个单页，永不返回 base_url/key；
 *  主网关的代理与管理面不在此端口出现（8687 仍仅监听 127.0.0.1，红线不变）。 */

export interface LanHandle {
  server: http.Server
  port: number
  token: string
  /** 实际绑定地址（0.0.0.0=全部网卡；对外 URL 只列真正可达的地址） */
  host: string
}

/** LAN 凭据跨重启稳定（手机 cookie 不掉）：旧值格式合法就复用，否则新生成 */
export function resolveLanToken(previous: string | null | undefined): string {
  if (previous && /^mdklan_[0-9a-f]{32,}$/.test(previous)) return previous
  return randomToken('mdklan')
}

function cookieValue(req: http.IncomingMessage, name: string): string | null {
  const raw = req.headers.cookie
  if (!raw) return null
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=')
    if (idx < 0) continue
    if (part.slice(0, idx).trim() === name) return part.slice(idx + 1).trim()
  }
  return null
}

/** 令牌三通道：?token=（扫码首访）、LAN cookie、Bearer 头（API 均收）。
 *  cookie 名内嵌端口：RFC 6265 cookie 不按端口隔离，同机双实例（生产+dev 的 LAN 端口）
 *  固定名会互顶手机端会话。 */
export function lanAuthorized(req: http.IncomingMessage, rt: GatewayRuntime): boolean {
  // LAN 未启用/已关闭（stopLan 后 rt.lan=undefined，keep-alive 已建连仍可能送达请求）或令牌为空
  // 一律拒绝：空串对空串会通过 safeEqual 的常数时间比较，等于无凭据放行（2026-10-30 评测集审出）
  const token = rt.lan?.token
  if (!token) return false
  const auth = req.headers.authorization
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) return safeEqual(auth.slice(7), token)
  const ck = cookieValue(req, lanCookieName(rt.lan?.port ?? DEFAULT_LAN_PORT))
  return !!ck && safeEqual(ck, token)
}

/** 虚拟网卡名特征：这些网卡上的地址手机不可达（虚拟交换机 / VPN / 隧道 / 蓝牙）。
 *  Windows 上 Hyper-V、WSL、VMware、VirtualBox、Clash 之类虚拟网卡常排在物理网卡之前，
 *  只按系统枚举顺序取首个会把二维码指向手机连不上的地址（macOS 一般只有一块物理网卡，暴露不出来）。 */
const VIRTUAL_IFACE_RE = /(vEthernet|Hyper-V|WSL|VMware|VirtualBox|Virtual Adapter|Wi-Fi Direct|Docker|Loopback|Bluetooth|TAP-|Npcap|wintun|WireGuard|Tailscale|ZeroTier|Clash|Mihomo|utun|bridge|awdl|llw|ipsec)/i

/** 隧道网段（与网卡名无关的兜底）：198.18/15=Clash/Mihomo TUN 假 IP，100.64/10=Tailscale 等 CGNAT */
function isTunnelRange(ip: string): boolean {
  if (ip.startsWith('198.18.') || ip.startsWith('198.19.')) return true
  const m = /^100\.(\d+)\./.exec(ip)
  return !!m && Number(m[1]) >= 64 && Number(m[1]) <= 127
}

export interface LanAddressCandidate {
  /** 网卡名（Windows 上是「以太网」「vEthernet (WSL)」这类可读名） */
  iface: string
  address: string
}

/** 候选地址排序（纯函数，便于单测）：物理网卡 > 系统默认出口 > 其余虚拟网卡/隧道网段 > link-local。
 *  只在权重相同时保持系统枚举顺序，绝不丢地址——主地址不通用时用户还能照着备用地址试。 */
export function rankLanAddresses(list: LanAddressCandidate[], preferred?: string | null): string[] {
  const seen = new Set<string>()
  const scored: { address: string; score: number; idx: number }[] = []
  list.forEach((c, idx) => {
    if (!c.address || c.address === '0.0.0.0' || seen.has(c.address)) return
    seen.add(c.address)
    let score = 0
    if (VIRTUAL_IFACE_RE.test(c.iface)) score += 100
    if (isTunnelRange(c.address)) score += 50
    // 169.254/16 是拿不到 DHCP 时系统自分配的地址，手机一定连不上：垫底但不剔除（好歹给用户看见）
    if (c.address.startsWith('169.254.')) score += 200
    if (preferred && c.address === preferred) score -= 20
    scored.push({ address: c.address, score, idx })
  })
  return scored.sort((a, b) => a.score - b.score || a.idx - b.idx).map((x) => x.address)
}

/** 系统默认出口地址（内核选路结果，UDP connect 不实际发包）：多数情况下正是手机能连上的那块网卡。
 *  Node 的 socket.address() 只在 connect 回调后可读（同步读会 EBADF），故异步取一次并缓存。 */
let preferredAddress: string | null = null
let preferredDetected = false

export function detectDefaultRouteAddress(): Promise<string | null> {
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4')
    let done = false
    const finish = (v: string | null): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      try {
        sock.close()
      } catch {
        /* 已关闭 */
      }
      resolve(v)
    }
    // 无默认路由（离线/纯内网无网关）时 connect 不回调，超时兜底
    const timer = setTimeout(() => finish(null), 300)
    sock.once('error', () => finish(null))
    try {
      sock.connect(9, '8.8.8.8', () => {
        try {
          const a = sock.address()
          finish(a?.address && a.address !== '0.0.0.0' ? a.address : null)
        } catch {
          finish(null)
        }
      })
    } catch {
      finish(null)
    }
  })
}

/** 刷新缓存的默认出口地址（换网/VPN 起停后重算一次即可，排序只把它当倾向而非唯一真相） */
export async function refreshPreferredAddress(): Promise<void> {
  preferredAddress = await detectDefaultRouteAddress()
  preferredDetected = true
}

/** 本机局域网 IPv4 候选（去重 + 优选排序；preferred=系统默认出口地址） */
export function lanAddresses(): string[] {
  const list: LanAddressCandidate[] = []
  for (const [iface, addrs] of Object.entries(os.networkInterfaces())) {
    for (const i of addrs ?? []) {
      if (i.internal) continue
      if (i.family !== 'IPv4') continue
      list.push({ iface, address: i.address })
    }
  }
  return rankLanAddresses(list, preferredAddress)
}

/** 主地址（二维码内容所指向的那条）：手机最可能连上的地址 */
export function lanPrimaryUrl(port: number): string | null {
  const ip = lanAddresses()[0]
  return ip ? `http://${ip}:${port}/m` : null
}

/** 对外广告的可达地址（直拉链接与发现应答共用口径）：默认 0.0.0.0 列全部网卡；
 *  指定绑定（如 127.0.0.1 / MODELRDOCK_LAN_HOST 覆盖）时只列该地址。 */
export function lanAdvertiseIps(host: string): string[] {
  return host === '0.0.0.0' || host === '::' || host === '' ? lanAddresses() : [host]
}

/** 二维码 SVG（纯 JS 生成，无 native 依赖） */
export function lanQrSvg(url: string): string {
  const q = qrcode(0, 'M')
  q.addData(url)
  q.make()
  // 白边=规范 quiet zone 4 模块（8 太肥）；crispEdges 让 CSS 缩小显示后模块边缘仍是硬边（相机好识读）
  return q.createSvgTag(4, 4).replace('<svg ', '<svg shape-rendering="crispEdges" ')
}

// 同网直拉迁移（sync-lan-pull，A 机 offer 侧）

const SYNC_OFFER_TTL_MS = 10 * 60 * 1000

/** 一次性 offer 单槽：新 offer 顶旧 offer；仅存内存（重启失效是特性，重新生成即可）。token 即能力凭据，取走即焚 */
let syncOffer: { token: string; envelopeJson: string; createdAt: number } | null = null

/** 生成同网直拉 offer：可同步态整体密封（随机口令 base64url，免 URL 转义坑），返回各网卡一次性链接（口令藏 fragment 不进查询串）。
 *  前提：手机远程已开启（直拉端点挂在 LAN 监听器上，8687 仍仅 127.0.0.1）。 */
export async function createSyncOffer(rt: GatewayRuntime): Promise<{ urls: string[]; passphrase: string; expiresIn: number }> {
  if (!rt.lan) throw new Error(t('手机远程未开启：先在控制台开启「手机远程」，再生成分享链接', 'Mobile console is off: turn it on in the console before creating a share link'))
  const hosts = lanAdvertiseIps(rt.lan.host)
  if (!hosts.length) throw new Error(t('未检测到局域网 IPv4 地址，无法生成直拉链接', 'No LAN IPv4 address detected; cannot create a pull link'))
  const { doc, report } = await collectSyncdoc()
  assertExportable(report)
  const passphrase = crypto.randomBytes(32).toString('base64url')
  const env = sealEnvelope(doc, passphrase)
  syncOffer = { token: crypto.randomBytes(24).toString('hex'), envelopeJson: JSON.stringify(env, null, 2), createdAt: Date.now() }
  return {
    urls: hosts.map((ip) => `http://${ip}:${rt.lan!.port}/m/sync/pull?t=${syncOffer!.token}#p=${passphrase}`),
    passphrase,
    expiresIn: 600,
  }
}

// 附近电脑确认式直拉（sync-nearby）：B 敲门 → A 确认 → B 凭一次性 nonce 取授权

const SYNC_REQUEST_TTL_MS = 120 * 1000
const SYNC_GRANT_TTL_MS = 120 * 1000

export interface NearbySyncRequest {
  /** 一次性取件凭据（B 生成，128bit hex） */
  nonce: string
  /** 请求方主机名（确认卡展示） */
  from: string
  createdAt: number
}

/** 待确认拉取请求：单槽（新顶旧），到期自动消失。overview 轮询读、确认卡展示 */
let pendingSyncRequest: NearbySyncRequest | null = null
/** 敲门请求按来源 IP 限频（值=上次请求时刻，窗口见 putSyncRequest）。只增不删会随 LAN 扫一遍 254 个 IP 永久驻留——每次写入顺带按窗口清扫过期键。 */
const requestRateByIp = new Map<string, number>()

/** 清扫限频表中过期条目（距上次请求已 ≥ windowMs：新请求不会被它限流，留着只占内存）。
 *  抽成纯函数便于单测清扫逻辑；`now` 可注入。 */
export function sweepRequestRateByIp(now: number, map: Map<string, number>, windowMs = 10_000): void {
  for (const [ip, lastAt] of map) {
    if (now - lastAt >= windowMs) map.delete(ip)
  }
}

export function peekSyncRequest(): NearbySyncRequest | null {
  if (pendingSyncRequest && Date.now() - pendingSyncRequest.createdAt > SYNC_REQUEST_TTL_MS) pendingSyncRequest = null
  return pendingSyncRequest
}

export function clearSyncRequest(): void {
  pendingSyncRequest = null
}

/** 记录敲门请求（无鉴权 LAN 面：请求只是「敲门」，真正的凭据要 A 用户点允许后才生成）。
 *  按来源 IP 限频 10s，防骚扰式刷屏确认卡。 */
export function putSyncRequest(nonce: string, from: string, sourceIp: string): void {
  const now = Date.now()
  sweepRequestRateByIp(now, requestRateByIp) // 写入前先清扫过期键，Map 尺寸收敛（防无界增长）
  if (now - (requestRateByIp.get(sourceIp) ?? 0) < 10_000) {
    throw new Error(t('请求过于频繁，请稍后再试', 'Requests too frequent; try again later'))
  }
  requestRateByIp.set(sourceIp, now)
  // 主机名上限放宽到 128：CI 机器名可能远超 64 字符，截断会让确认卡显示与请求方对不上
  pendingSyncRequest = { nonce, from: from.slice(0, 128), createdAt: now }
}

/** 授权结果按 nonce 存放（B 凭一次性 nonce 取走）。approve=false 写拒绝标记，让 B 立即结束等待 */
const syncGrants = new Map<string, { url?: string; passphrase?: string; denied?: boolean; createdAt: number }>()

export function putSyncGrant(nonce: string, grant: { url: string; passphrase: string } | { denied: true }): void {
  for (const [k, v] of syncGrants) {
    if (Date.now() - v.createdAt > SYNC_GRANT_TTL_MS) syncGrants.delete(k)
  }
  syncGrants.set(nonce, { ...grant, createdAt: Date.now() })
}

/** 取授权（单次焚毁，含拒绝标记）；无结果/过期返回 null */
export function takeSyncGrant(nonce: string): { url: string; passphrase: string } | { denied: true } | null {
  const g = nonce ? syncGrants.get(nonce) : undefined
  if (!g) return null
  syncGrants.delete(nonce)
  if (Date.now() - g.createdAt > SYNC_GRANT_TTL_MS) return null
  if (g.denied) return { denied: true }
  return { url: g.url!, passphrase: g.passphrase! }
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

/** 读取 JSON 请求体（5MB 上限，防 LAN 监听器被异常大包拖垮） */
async function readJsonBody(req: http.IncomingMessage, limitBytes = 5 * 1024 * 1024): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const c of req) {
    size += (c as Buffer).length
    if (size > limitBytes) throw new Error(t('请求体过大', 'Request body too large'))
    chunks.push(c as Buffer)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>
  } catch {
    throw new Error(t('请求体不是合法 JSON', 'Request body is not valid JSON'))
  }
}

function buildState(rt: GatewayRuntime): Record<string, unknown> {
  const cfg = rt.config
  const activeProfileName = cfg.active_profile ?? null
  const activeProfile = activeProfileName ? cfg.profiles[activeProfileName] : undefined
  const activeProviderId = activeProfile?.provider ?? null
  // 手机页与桌面同源：双槽位标签与「使用中」都来自 autoRouteInfo（统一 routeState 口径），
  // 不再用 active_profile 单独推断服务/模型（那会和定时窗口/钉定的实际走向打架）
  const ar = autoRouteInfo(rt)
  const services = Object.entries(cfg.providers).map(([id, p]) => ({
    id,
    name: p.name || id,
    active: id === ar.provider,
    enabled: p.enabled !== false,
    count: Object.keys(p.models ?? {}).length,
    models: Object.entries(p.models ?? {}).map(([mid, m]) => ({ id: mid, name: m.display_name || mid })),
  }))
  const activeProvider = activeProviderId ? cfg.providers[activeProviderId] : undefined
  const active = activeProvider
    ? {
        profile: activeProfile?.name || activeProfileName,
        service: activeProviderId,
        name: activeProvider.name || activeProviderId,
        default_model: activeProfile?.default_model ?? null,
        models: Object.entries(activeProvider.models ?? {}).map(([mid, m]) => projectModel(mid, m, { nameKey: true })),
      }
    : null
  const route = {
    on: ar.on,
    failover429: (cfg.gateway?.failover_status_codes ?? []).includes(429),
    autoFallback: cfg.gateway?.auto_fallback !== false,
    provider: ar.provider,
    label: ar.providerLabel,
    model: ar.model,
    source: ar.source,
    ...(ar.degradedFrom ? { degradedFrom: ar.degradedFrom } : {}),
    forced: ar.forced,
    autoPrimaryLabel: ar.autoPrimaryLabel,
    routeNext: ar.routeNext,
    routeNextLabel: ar.routeNextLabel,
    next: ar.next,
    nextLabel: ar.nextLabel,
    autoNextLabel: ar.autoNextLabel,
    schedule: {
      enabled: ar.schedule.enabled,
      active: ar.schedule.active,
      activeAvoids: ar.schedule.activeAvoids,
      applied: ar.schedule.applied,
      suppressedBy: ar.schedule.suppressedBy,
      windows: ar.schedule.windows.map((w) => ({
        start: w.start,
        end: w.end,
        target: w.target,
        mode: w.mode ?? 'prefer',
        dayFilter: w.dayFilter ?? null,
        days: w.days ?? null,
      })),
    },
  }
  return {
    ok: true,
    hostname: os.hostname(),
    started_at: localIsoTs(new Date(rt.startedAt)),
    uptime_ms: Date.now() - rt.startedAt,
    active,
    route,
    services,
  }
}


// 手机页进程内缓存（页面为静态壳）：懒渲染一次，之后每请求直接回放缓存串 + ETag/304，
// 不再每请求重拼 ~34KB HTML（实测 33707 字节 @2026-10-28）；200 覆盖管理面统一 no-store 为 no-cache，条件请求才会真正发生
let mobilePageCache: { html: string; etag: string } | null = null
function getMobilePage(): { html: string; etag: string } {
  if (!mobilePageCache) {
    const html = renderMobilePage()
    mobilePageCache = { html, etag: '"' + crypto.createHash('sha256').update(html).digest('base64url').slice(0, 22) + '"' }
  }
  return mobilePageCache
}

function serveMobilePage(req: http.IncomingMessage, res: http.ServerResponse): void {
  const { html, etag } = getMobilePage()
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { 'content-security-policy': CONSOLE_CSP })
    res.end()
    return
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', etag, 'cache-control': 'no-cache', 'content-security-policy': CONSOLE_CSP })
  res.end(html)
}


async function handleLanRequest(rt: GatewayRuntime, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = (req.url ?? '').split('?')[0]
  const q = new URL(req.url ?? '', 'http://x').searchParams
  res.setHeader('cache-control', 'no-store')
  if (url === '/m' && req.method === 'GET') {
    const qToken = q.get('token')
    if (qToken && safeEqual(qToken, rt.lan?.token ?? '')) {
      res.setHeader('set-cookie', `${lanCookieName(rt.lan?.port ?? DEFAULT_LAN_PORT)}=${rt.lan?.token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000`)
      // 带令牌原地伺服（不重定向剥令牌）：微信「在浏览器中打开」/「添加到主屏幕」都只携带
      // 当前地址栏 URL，令牌必须留在 URL 里才能跨浏览器/跨存储自举（cookie 仅作会话续命）。
      // 令牌本身即桌面二维码明文内容、作用域仅 LAN 控制台，地址栏可见无新增暴露。
      serveMobilePage(req, res)
      return
    }
    if (lanAuthorized(req, rt)) {
      serveMobilePage(req, res)
      return
    }
    res.writeHead(403, { 'content-type': 'text/html; charset=utf-8' })
    res.end(renderDeniedPage())
    return
  }
  // 同网直拉（sync-lan-pull）：token 即能力凭据（不经 mdklan 鉴权——链接本身视同口令）。
  // 常量时间比对 + TTL + 取走即焚：同一链接第二人拉不到（先到先得），来源电脑重新生成即可
  if (url === '/m/sync/pull' && req.method === 'GET') {
    const got = q.get('t') ?? ''
    if (!syncOffer || !safeEqual(got, syncOffer.token)) {
      return sendJson(res, 404, { ok: false, error: t('链接无效或已被使用', 'Link invalid or already used') })
    }
    if (Date.now() - syncOffer.createdAt > SYNC_OFFER_TTL_MS) {
      syncOffer = null
      return sendJson(res, 410, { ok: false, error: t('链接已过期（10 分钟），请在来源电脑重新生成', 'Link expired (10 min); create a new one on the source computer') })
    }
    const envelopeJson = syncOffer.envelopeJson
    syncOffer = null
    logAudit(rt, { ts: localIsoTs(), kind: 'audit', op: '配置直拉被取走', op_en: 'LAN config pull consumed', target: 'syncdoc', ok: true, source: 'lan' })
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    res.end(envelopeJson)
    return
  }
  // 附近电脑确认式直拉（sync-nearby）：B 机敲门请求授权。无鉴权 LAN 面——请求本身只创建
  // 「待确认」单槽，真正凭据要 A 用户在桌面点允许后才生成且单次焚毁；限频防骚扰
  if (url === '/m/sync/request' && req.method === 'POST') {
    let body: Record<string, unknown>
    try {
      body = await readJsonBody(req, 4 * 1024)
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: (e as Error).message })
    }
    const nonce = typeof body.nonce === 'string' ? body.nonce : ''
    const from = typeof body.from === 'string' ? body.from.trim().slice(0, 128) : ''
    if (!/^[0-9a-f]{32,128}$/.test(nonce) || !from) {
      return sendJson(res, 400, { ok: false, error: t('请求参数不完整', 'Incomplete request') })
    }
    try {
      putSyncRequest(nonce, from, req.socket.remoteAddress ?? '')
    } catch (e) {
      return sendJson(res, 429, { ok: false, error: (e as Error).message })
    }
    return sendJson(res, 200, { ok: true })
  }
  // B 机轮询授权结果：nonce 即取件凭据，取走即焚（拒绝标记同样单次）
  if (url === '/m/sync/grant' && req.method === 'GET') {
    const g = takeSyncGrant(q.get('n') ?? '')
    if (!g) return sendJson(res, 404, { ok: false, error: t('暂无授权结果', 'No grant yet') })
    if ('denied' in g) {
      return sendJson(res, 403, { ok: false, denied: true, error: t('对方已拒绝本次请求', 'The request was denied') })
    }
    return sendJson(res, 200, { ok: true, url: g.url, passphrase: g.passphrase })
  }
  if (url === '/m/api/state' && req.method === 'GET') {
    if (!lanAuthorized(req, rt)) return sendJson(res, 403, { ok: false, error: t('令牌缺失或不正确', 'Token missing or incorrect') })
    return sendJson(res, 200, buildState(rt))
  }
  if (url === '/m/api/switch' && req.method === 'POST') {
    if (!lanAuthorized(req, rt)) return sendJson(res, 403, { ok: false, error: t('令牌缺失或不正确', 'Token missing or incorrect') })
    let body: Record<string, unknown>
    try {
      body = await readJsonBody(req)
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: (e as Error).message })
    }
    const service = String(body.service ?? '')
    const audit = (ok: boolean, err?: string): void =>
      logAudit(rt, {
        ts: localIsoTs(),
        kind: 'audit',
        op: '手机切换服务',
        op_en: 'Mobile switch',
        target: service,
        ok,
        err,
        source: 'lan',
      })
    try {
      if (!rt.config.providers[service]) throw new Error(t('服务不存在：{id}', 'Service not found: {id}', { id: service }))
      // 与桌面「应用/当前」同一链路：写 active_profile + 人工钉定主服务（人为优先于定时窗口）→ 热加载 → 重烤跟随全局的客户端
      await switchToServiceWithRoute(service, rt.config.gateway?.auto_failover === true)
      await reloadRuntime(rt)
      await refreshBakedModelClients({ port: rt.port })
      audit(true)
      return sendJson(res, 200, { ok: true })
    } catch (e) {
      audit(false, (e as Error).message)
      return sendJson(res, 400, { ok: false, error: (e as Error).message })
    }
  }
  if (url === '/m/api/auto-route' && req.method === 'POST') {
    if (!lanAuthorized(req, rt)) return sendJson(res, 403, { ok: false, error: t('令牌缺失或不正确', 'Token missing or incorrect') })
    let body: Record<string, unknown>
    try {
      body = await readJsonBody(req)
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: (e as Error).message })
    }
    const b = body as { enabled?: unknown; provider?: unknown; next?: unknown }
    // 部分更新语义与桌面 /_modeldock/auto-route 一致：enabled 缺省=保持现状；body 带 provider/next 字段才更新（空/null=恢复自动）
    const enabled = b.enabled === undefined
      ? rt.config.gateway?.auto_failover === true
      : b.enabled === true || b.enabled === 'true'
    const provider = 'provider' in b
      ? (typeof b.provider === 'string' && b.provider.trim() ? b.provider.trim() : null)
      : undefined
    const next = 'next' in b
      ? (typeof b.next === 'string' && b.next.trim() ? b.next.trim() : null)
      : undefined
    const audit = (ok: boolean, err?: string): void =>
      logAudit(rt, {
        ts: localIsoTs(),
        kind: 'audit',
        op: '手机自动路由',
        op_en: 'Mobile auto route',
        target:
          `enabled=${enabled}` +
          (provider === undefined ? '' : ` provider=${provider ?? '(自动)'}`) +
          (next === undefined ? '' : ` next=${next ?? '(自动)'}`),
        ok,
        err,
        source: 'lan',
      })
    try {
      if (provider && !rt.config.providers[provider]) throw new Error(t('服务不存在：{id}', 'Service not found: {id}', { id: provider }))
      // 与桌面同一链路：主服务钉定 setAutoRoute、「下一个切换」钉定 setRouteNext → 热加载
      const r2 = await setAutoRoute(enabled, provider)
      const n = next === undefined ? undefined : await setRouteNext(next)
      await reloadRuntime(rt)
      audit(true)
      return sendJson(res, 200, { ok: true, enabled: r2.enabled, provider: r2.provider ?? null, next: n ?? rt.config.gateway?.route_next ?? null })
    } catch (e) {
      audit(false, (e as Error).message)
      return sendJson(res, 400, { ok: false, error: (e as Error).message })
    }
  }
  // 配置同步（M1.5）：导出 = 收集可同步态并密封成 .msync 信封下载；导入 = 手机上传包 → 预览 → 确认应用。
  // 包体恒为密文（D2：配置加密后才出机器），页面与响应永不含 key 明文；机器态（接入/端口/激活路由）不随包。
  if (url === '/m/api/sync/export' && req.method === 'POST') {
    if (!lanAuthorized(req, rt)) return sendJson(res, 403, { ok: false, error: t('令牌缺失或不正确', 'Token missing or incorrect') })
    let body: Record<string, unknown>
    try {
      body = await readJsonBody(req)
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: (e as Error).message })
    }
    const passphrase = typeof body.passphrase === 'string' ? body.passphrase : ''
    const audit = (ok: boolean, err?: string): void =>
      logAudit(rt, { ts: localIsoTs(), kind: 'audit', op: '手机导出配置', op_en: 'Mobile config export', target: 'syncdoc', ok, err, source: 'lan' })
    try {
      if (!passphrase) throw new Error(t('口令不能为空', 'Passphrase must not be empty'))
      const { doc, report } = await collectSyncdoc()
      assertExportable(report)
      const env = sealEnvelope(doc, passphrase)
      const name = exportFileName()
      audit(true)
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-disposition': `attachment; filename="${name}"`,
      })
      res.end(JSON.stringify(env, null, 2))
    } catch (e) {
      audit(false, (e as Error).message)
      return sendJson(res, 400, { ok: false, error: (e as Error).message })
    }
    return
  }
  if (url === '/m/api/sync/import' && req.method === 'POST') {
    if (!lanAuthorized(req, rt)) return sendJson(res, 403, { ok: false, error: t('令牌缺失或不正确', 'Token missing or incorrect') })
    let body: Record<string, unknown>
    try {
      body = await readJsonBody(req)
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: (e as Error).message })
    }
    const phase = body.phase === 'apply' ? 'apply' : 'preview'
    const file = typeof body.file === 'string' ? body.file : ''
    // 粘贴链接导入：信封在来源电脑的局域网端点上，由服务端代拉（手机页跨源 fetch 会被 CORS 拦）
    const url = typeof body.url === 'string' ? body.url : ''
    const passphrase = typeof body.passphrase === 'string' ? body.passphrase : ''
    const audit = (ok: boolean, err?: string): void =>
      logAudit(rt, { ts: localIsoTs(), kind: 'audit', op: '手机导入配置', op_en: 'Mobile config import', target: phase, ok, err, source: 'lan' })
    try {
      let envText = file
      if (!envText && url) envText = await fetchEnvelopeFromUrl(url)
      if (!envText) throw new Error(t('缺少配置包内容（文件或分享链接）', 'Missing package content (file or share link)'))
      if (!passphrase) throw new Error(t('口令不能为空', 'Passphrase must not be empty'))
      let env: unknown
      try {
        env = JSON.parse(envText)
      } catch {
        throw new Error(t('不是合法的配置包（JSON 解析失败）', 'Not a valid sync package (JSON parse failed)'))
      }
      const doc = validateSyncdoc(openEnvelope(env, passphrase))
      if (phase === 'preview') {
        const metaEnv = env as Record<string, unknown>
        audit(true)
        return sendJson(res, 200, {
          ok: true,
          phase,
          report: reportOfDoc(doc),
          meta: { createdBy: String(metaEnv.created_by ?? ''), createdAt: String(metaEnv.created_at ?? '') },
        })
      }
      const report = await applySyncdoc(doc)
      await reloadRuntime(rt)
      audit(true)
      return sendJson(res, 200, { ok: true, phase, report })
    } catch (e) {
      audit(false, (e as Error).message)
      return sendJson(res, 400, { ok: false, error: (e as Error).message })
    }
  }
  // PWA 资源（添加到主屏幕）：manifest 的 start_url 带令牌——iOS 主屏独立窗口与 Safari
  // 存储隔离，带令牌的入口保证新存储也能种 cookie 自举；manifest 本身仅在持令牌时可取。
  if (url === '/m/manifest.webmanifest' && req.method === 'GET') {
    if (!lanAuthorized(req, rt)) return sendJson(res, 403, { ok: false, error: t('令牌缺失或不正确', 'Token missing or incorrect') })
    res.writeHead(200, { 'content-type': 'application/manifest+json; charset=utf-8' })
    res.end(JSON.stringify({
      name: 'ModelDock',
      short_name: 'ModelDock',
      start_url: `/m?token=${rt.lan?.token ?? ''}`,
      scope: '/m/',
      display: 'standalone',
      background_color: '#0f1115',
      theme_color: '#0f1115',
      icons: [
        { src: '/m/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
        { src: '/m/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
      ],
    }))
    return
  }
  if (url === '/m/icon-192.png' && req.method === 'GET') {
    if (!lanAuthorized(req, rt)) return sendJson(res, 403, { ok: false, error: t('令牌缺失或不正确', 'Token missing or incorrect') })
    // 图标是编译期内存常量、内容永不变化：长缓存 + immutable，避免移动端每次重拉
    res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'public, max-age=31536000, immutable' })
    res.end(LAN_ICON_192_PNG)
    return
  }
  if (url === '/m/icon-512.png' && req.method === 'GET') {
    if (!lanAuthorized(req, rt)) return sendJson(res, 403, { ok: false, error: t('令牌缺失或不正确', 'Token missing or incorrect') })
    res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'public, max-age=31536000, immutable' })
    res.end(LAN_ICON_512_PNG)
    return
  }
  sendJson(res, 404, { ok: false, error: t('接口不存在', 'Not found') })
}

/** 起 LAN 第二监听器：默认 0.0.0.0（测试/本机验证用 MODELRDOCK_LAN_HOST 覆盖），
 *  端口从 opts.port 起冲突自动 +1（≤10 次），实际端口回写 rt.lan 供二维码取用。 */
export async function startLanServer(rt: GatewayRuntime, opts: { port?: number; token: string; host?: string }): Promise<LanHandle> {
  if (rt.lan) stopLan(rt)
  // 二维码/直拉链接都按此排序生成：先取一次系统默认出口地址，避免把虚拟网卡排在物理网卡前面
  await refreshPreferredAddress()
  const host = opts.host ?? process.env.MODELRDOCK_LAN_HOST ?? '0.0.0.0'
  const server = http.createServer((req, res) => {
    handleLanRequest(rt, req, res).catch((e) => {
      console.error(t('[modeldock] 手机控制台请求处理失败：{msg}', '[modeldock] Mobile console request failed: {msg}', { msg: (e as Error).message }))
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: t('内部错误', 'Internal error') })
      else res.end()
    })
  })
  const basePort = opts.port ?? DEFAULT_LAN_PORT
  // listen + EADDRINUSE 顺延重试与主网关 start（main.ts）同一实现；listen(0)（测试/临时实例）时取内核分配的实际端口
  const actualPort = await listenWithRetry(server, basePort, host)
  rt.lan = { server, port: actualPort, token: opts.token, host }
  // 附近发现应答器随 LAN 监听器启停：未开启手机远程时不应答、不可被发现；
  // 广告地址按实际绑定派生（B 不猜应答包源地址——同机多实例 reuseAddr 抢单播时不可靠）
  startSyncBeacon(() => {
    if (!rt.lan) return undefined
    return { port: rt.lan.port, ips: lanAdvertiseIps(rt.lan.host) }
  })
  return { server, port: actualPort, token: opts.token, host }
}

export function stopLan(rt: GatewayRuntime): void {
  stopSyncBeacon()
  rt.lan?.server.close()
  // close 只停新连接，keep-alive 已建连仍会被伺服——显式断光（lanAuthorized 的 rt.lan=undefined
  // 拒绝是第一道防线，这里是彻底切断保温连接，防「关闭手机远程后旧连接打穿管理面」）
  rt.lan?.server.closeAllConnections()
  rt.lan = undefined
}

/** 管理端点（/_modeldock/lan GET/POST）共用的状态载荷；二维码只对已过 admin 鉴权的控制台返回。
 *  urls 按「手机最可能连上」排序（见 rankLanAddresses）：[0] 生成二维码，其余供用户换着试；
 *  platform 供控制台判断是否提示 Windows 防火墙放行（首次监听 0.0.0.0 时系统会弹窗，漏点就手机连不上）。 */
export function buildLanStatus(rt: GatewayRuntime): { enabled: boolean; port: number; urls: string[]; qrcode: string | null; platform: string } {
  const enabled = !!rt.config.lan?.enabled && !!rt.lan
  const port = rt.lan?.port ?? rt.config.lan?.port ?? DEFAULT_LAN_PORT
  // 广告口径与直拉链接/发现应答同源（lanAdvertiseIps）：绑定具体 host 时只列该地址，
  // 不再列全部网卡——否则二维码 [0] 大概率指向监听之外的地址，手机必然连不上
  const urls = rt.lan ? lanAdvertiseIps(rt.lan.host).map((ip) => `http://${ip}:${rt.lan!.port}/m`) : []
  const primary = rt.lan ? `${urls[0] ?? `http://127.0.0.1:${rt.lan.port}/m`}?token=${rt.lan.token}` : null
  return { enabled, port, urls, qrcode: primary ? lanQrSvg(primary) : null, platform: process.platform }
}
