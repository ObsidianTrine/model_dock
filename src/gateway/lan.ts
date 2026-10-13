import crypto from 'node:crypto'
import dgram from 'node:dgram'
import http from 'node:http'
import os from 'node:os'
import qrcode from 'qrcode-generator'
import { DEFAULT_LAN_PORT } from '../config/types.js'
import { refreshBakedModelClients, setAutoRoute, setRouteNext, switchToService } from '../ops.js'
import { applySyncdoc, collectSyncdoc } from '../sync/collect.js'
import { openEnvelope, sealEnvelope } from '../sync/crypto.js'
import { assertExportable, exportFileName, reportOfDoc } from '../sync/exportImport.js'
import { validateSyncdoc } from '../sync/types.js'
import { randomToken } from '../util/fsx.js'
import { t } from '../util/i18n.js'
import { safeEqual } from '../util/safe-equal.js'
import { listenWithRetry, projectModel, fetchEnvelopeFromUrl } from './shared.js'
import { localIsoTs } from '../util/time.js'
import { autoRouteInfo, logAudit, parseFallbackEntry, reloadRuntime, type GatewayRuntime } from './state.js'
import { CONSOLE_SHARED_JS } from './console-shared.js'
import { lanCookieName } from './cookies.js'
import { LAN_ICON_192_PNG, LAN_ICON_512_PNG } from './lanAssets.js'
import { startSyncBeacon, stopSyncBeacon } from './discover.js'

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
function lanAuthorized(req: http.IncomingMessage, rt: GatewayRuntime): boolean {
  const token = rt.lan?.token ?? ''
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
  const services = Object.entries(cfg.providers).map(([id, p]) => ({
    id,
    name: p.name || id,
    active: id === activeProviderId,
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
  // 手机页与桌面路由控件同口径：双槽位（当前=主服务 / 下一个切换）的生效值与「自动 · X」标签都来自 autoRouteInfo；
  // 模型取真实请求所带：窗口为主候选（未钉定）时用窗口模型改写，否则 active_profile 默认模型（选主换 provider 不换 profile 模型映射）
  const ar = autoRouteInfo(rt)
  const winModel = !ar.forced && ar.schedule.active ? parseFallbackEntry(ar.schedule.active.target)?.model ?? null : null
  const route = {
    on: ar.on,
    failover429: (cfg.gateway?.failover_status_codes ?? []).includes(429),
    autoFallback: cfg.gateway?.auto_fallback !== false,
    provider: ar.provider,
    label: ar.providerLabel,
    model: winModel ?? activeProfile?.default_model ?? ar.model ?? null,
    forced: ar.forced,
    autoPrimaryLabel: ar.autoPrimaryLabel,
    routeNext: ar.routeNext,
    next: ar.next,
    nextLabel: ar.nextLabel,
    autoNextLabel: ar.autoNextLabel,
    schedule: {
      enabled: ar.schedule.enabled,
      active: ar.schedule.active,
      activeAvoids: ar.schedule.activeAvoids,
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

export function renderMobilePage(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="dark">
<meta name="theme-color" content="#0f1115">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="ModelDock">
<link rel="manifest" href="/m/manifest.webmanifest">
<link rel="apple-touch-icon" href="/m/icon-192.png">
<title>ModelDock · 手机</title>
<style>
/* 令牌与桌面控制台（src/gateway/ui.ts）同源，见 .agents/conventions/ui-kit.md；
 * 控件（.act/.badge/#toast/#confirm）为移动变体保留：16px 输入=iOS 聚焦防缩放特例，44px=触控最小高度 */
:root{--bg:#0f1115;--card:#171a21;--text:#e5e7eb;--muted:#9ca3af;--border:#2a2f3a;--accent:#3b82f6;--accent-weak:#16233c;--ok:#22c55e;--ok-weak:#10241a;--warn:#d97706;--err:#ef4444;
--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
--fs-xs:12px;--fs-sm:13px;--fs-md:14px;--fs-base:15px;--fs-lg:17px;--fs-xl:18px;
--r-sm:8px;--r-md:10px;--r-lg:14px;--r-full:999px;
--shadow-sm:0 1px 2px rgba(0,0,0,.25);--shadow-md:0 4px 14px rgba(0,0,0,.2);--shadow-lg:0 18px 50px rgba(0,0,0,.35);
--z-sticky:35;--z-fab:40;--z-toast:50;--z-pop:70;--z-modal:100;
--dur:.15s}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:var(--fs-base)/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;padding:0 14px calc(20px + env(safe-area-inset-bottom))}
/* 主屏独立窗口（standalone）下页面顶到状态栏：header 让出安全区 */
header{display:flex;align-items:center;gap:8px;padding:calc(14px + env(safe-area-inset-top)) 0 10px}
.dot{width:8px;height:8px;border-radius:99px;background:var(--ok);flex:0 0 auto}
.brand{font-weight:700;font-size:var(--fs-xl)}
.host{margin-left:auto;color:var(--muted);font-size:var(--fs-xs);border:1px solid var(--border);border-radius:var(--r-full);padding:2px 10px;max-width:45%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.card{background:var(--card);border:1px solid var(--border);border-radius:var(--r-lg);padding:14px 16px;margin-bottom:12px}
.label{color:var(--muted);font-size:var(--fs-xs);margin:0 0 6px}
.sname{font-weight:700;font-size:var(--fs-xl);color:var(--accent);word-break:break-all}
.model{color:var(--muted);font-size:var(--fs-sm);margin:4px 0 0;word-break:break-all}
.models{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
.chip{border:1px solid var(--border);background:var(--bg);border-radius:var(--r-sm);padding:3px 9px;font-size:var(--fs-xs);font-family:var(--mono);max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.chip small{color:var(--muted);margin-left:4px}
.row{display:flex;align-items:center;gap:10px;padding:11px 0;border-bottom:1px solid var(--border)}
.row:last-child{border-bottom:none}
.row .info{flex:1;min-width:0}
.row .nm{font-weight:600;word-break:break-all}
.row .meta{color:var(--muted);font-size:var(--fs-xs)}
.badge{display:inline-block;padding:1px 8px;border-radius:var(--r-full);font-size:11px;border:1px solid var(--ok);color:var(--ok);margin-left:6px;vertical-align:1px}
.why{color:var(--muted);font-size:var(--fs-sm);margin:6px 0 0;word-break:break-all}
.why .mini{margin-left:4px;font-size:var(--fs-xs)}
/* 路由控制行（与桌面路由行同构）：label + select；select 16px 避免 iOS 聚焦自动放大 */
.rrow{display:flex;align-items:center;gap:8px;margin:0 0 10px}
.rrow label{font-size:var(--fs-sm);color:var(--muted);flex:0 0 auto}
.rrow select{flex:1;min-width:0;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:var(--r-md);padding:8px 12px;font:inherit;font-size:16px}
.rpill{flex:0 0 auto;border:1px solid var(--border);background:var(--bg);color:var(--muted);border-radius:var(--r-full);padding:8px 12px;font:inherit;font-size:var(--fs-xs);cursor:pointer;white-space:nowrap}
.rpill.on{border-color:var(--ok);color:var(--ok)}
.rpill:disabled{opacity:.6;cursor:wait}
.rsep{border:none;border-top:1px solid var(--border);margin:12px 0 8px}
.rlabel2{color:var(--muted);font-size:var(--fs-xs);margin:0 0 2px}
/* 配置同步：文本输入与 select 同款（16px 防 iOS 聚焦放大） */
.tinput{flex:1;min-width:0;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:var(--r-md);padding:8px 12px;font:inherit;font-size:16px}
.hint{color:var(--muted);font-size:var(--fs-xs);margin:6px 0 0;word-break:break-all}
input[type=file]{color:var(--muted);font-size:var(--fs-sm);max-width:100%}
button.act{border:1px solid var(--border);background:var(--bg);color:var(--accent);border-radius:var(--r-md);padding:9px 14px;font:inherit;font-size:var(--fs-md);cursor:pointer;min-height:44px}
button.act:disabled{color:var(--muted);cursor:not-allowed}
button.act.on{background:var(--accent);border-color:var(--accent);color:#fff}
button.mini{border:none;background:none;color:var(--muted);font:inherit;font-size:var(--fs-xs);cursor:pointer;padding:2px 0}
button.mini:hover{color:var(--accent)}
#toast{position:fixed;left:18px;bottom:24px;background:var(--card);border:1px solid var(--border);border-radius:var(--r-md);padding:10px 16px;font-size:var(--fs-md);display:none;max-width:88%;z-index:var(--z-toast)}
#confirm{position:fixed;inset:0;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;z-index:20}
#confirm[hidden]{display:none}
.confirm-box{background:var(--card);border:1px solid var(--border);border-radius:var(--r-lg);padding:18px;max-width:86%;width:320px}
.confirm-box p{margin:0 0 16px;font-size:var(--fs-base);line-height:1.5;word-break:break-all}
.confirm-box p.chint{color:var(--muted);font-size:var(--fs-sm);margin:-6px 0 14px}
.confirm-btns{display:flex;gap:10px;justify-content:flex-end}
button.cbtn{border:1px solid var(--border);background:var(--bg);color:var(--text);border-radius:var(--r-md);padding:9px 18px;font:inherit;font-size:var(--fs-base);cursor:pointer;min-height:44px}
#confirmYes{background:var(--accent);border-color:var(--accent);color:#fff}
footer{color:var(--muted);font-size:var(--fs-xs);text-align:center;margin-top:6px}
.empty{color:var(--muted);font-size:var(--fs-md);text-align:center;padding:18px 0}
.a2hsrow{text-align:center;margin:2px 0 6px}
</style>
</head>
<body>
<header><span class="dot"></span><span class="brand">ModelDock</span><span class="host" id="host"></span></header>
<div class="card">
  <p class="label" data-i18n="路由||Routing">路由</p>
  <div id="active"></div>
</div>
<div class="card">
  <p class="label" data-i18n="切换服务||Switch service">切换服务</p>
  <div id="services"></div>
</div>
<div class="card">
  <p class="label" data-i18n="配置包||Config package">配置包</p>
  <p class="rlabel2" data-i18n="导出配置包（AES-256-GCM 加密）||Export config package (AES-256-GCM encrypted)">导出配置包（AES-256-GCM 加密）</p>
  <p class="rrow">
    <input type="password" id="expPw" class="tinput" autocomplete="new-password" data-i18n-ph="口令（导入方需输同一口令）||Passphrase (importer types the same one)" placeholder="口令（导入方需输同一口令）">
    <button type="button" class="act on" id="expBtn" data-i18n="导出||Export">导出</button>
  </p>
  <hr class="rsep">
  <p class="rlabel2" data-i18n="导入配置包（文件或分享链接）||Import config package (file or share link)">导入配置包（文件或分享链接）</p>
  <!-- 不设 accept：iOS 选择器按文件类型过滤，.msync 未注册会被灰掉选不中（实测 .json 可选、.txt 与 .msync 不可选），放开才列得出文件 -->
  <p class="rrow"><input type="file" id="impFile"></p>
  <p class="rrow">
    <input type="password" id="impPw" class="tinput" autocomplete="new-password" data-i18n-ph="导出时设置的口令||Passphrase set at export time" placeholder="导出时设置的口令">
    <button type="button" class="act" id="impBtn" data-i18n="导入||Import">导入</button>
  </p>
  <p class="rrow"><textarea id="impLinkUrl" class="tinput" rows="2" data-i18n-ph="或粘贴分享链接：http://192.168.x.x:8787/…#p=…||Or paste a share link: http://192.168.x.x:8787/…#p=…" placeholder="或粘贴分享链接：http://192.168.x.x:8787/…#p=…"></textarea></p>
  <p class="hint" data-i18n="导入会整体替换现有配置，导入前自动快照。||Importing replaces the whole config; a snapshot is taken first.">导入会整体替换现有配置，导入前自动快照。</p>
</div>
<p class="a2hsrow"><button type="button" class="mini" id="a2hsBtn" data-i18n="常驻到手机桌面 · 怎么做？||Keep on home screen · how?">常驻到手机桌面 · 怎么做？</button></p>
<div class="card" id="a2hsCard" hidden><p class="hint" id="a2hsText"></p></div>
<footer data-i18n="仅限局域网 · 状态 / 切换 / 配置包 · 不显示 Key||LAN only · status / switch / config package · keys never shown">仅限局域网 · 状态 / 切换 / 配置包 · 不显示 Key</footer>
<div id="toast"></div>
<div id="confirm" hidden>
  <div class="confirm-box">
    <p id="confirmMsg"></p>
    <p id="confirmHint" class="chint" hidden></p>
    <div class="confirm-btns">
      <button type="button" class="cbtn" id="confirmNo" data-i18n="取消||Cancel">取消</button>
      <button type="button" class="cbtn" id="confirmYes" data-i18n="确定||OK">确定</button>
    </div>
  </div>
</div>
<script>
var LANG = (localStorage.getItem('mdk_lang') || (navigator.language || '').toLowerCase()).indexOf('zh') === 0 ? 'zh' : (localStorage.getItem('mdk_lang') === 'en' ? 'en' : 'zh')
function tr(zh, en) { return LANG === 'en' ? en : zh }
// 与桌面控制台（ui.ts）同源的共用逻辑（parseTarget/impWarnList/routeSelectHtml）：注入单份共享片段，trT=本页翻译函数
var trT = tr
${CONSOLE_SHARED_JS}
Array.prototype.forEach.call(document.querySelectorAll('[data-i18n]'), function (el) {
  var pair = el.getAttribute('data-i18n').split('||')
  el.textContent = tr(pair[0], pair[1])
})
Array.prototype.forEach.call(document.querySelectorAll('[data-i18n-ph]'), function (el) {
  var pair = el.getAttribute('data-i18n-ph').split('||')
  el.setAttribute('placeholder', tr(pair[0], pair[1]))
})
// ── 常驻手机桌面引导（UA 分辨步骤；桌面端隐藏）。添加到主屏幕后图标直达本页（URL 含令牌，持久有效）──
;(function () {
  var btn = document.getElementById('a2hsBtn')
  if (!btn) return
  var ua = navigator.userAgent || ''
  if (!/Mobi|Android|iPhone|iPad|iPod/i.test(ua)) { btn.parentNode.style.display = 'none'; return }
  var isWeChat = /MicroMessenger/i.test(ua)
  var isIOS = /iPhone|iPad|iPod/i.test(ua)
  var steps = isWeChat
    ? tr('微信内不支持直接添加：点右上角「···」→ 在浏览器中打开 → 在浏览器的分享/菜单里选「添加到主屏幕」。', 'Not supported inside WeChat: tap "···" (top right) → Open in browser → use the browser\\'s share/menu to "Add to Home Screen".')
    : isIOS
      ? tr('用 Safari 打开本页 → 点分享按钮 → 选「添加到主屏幕」。', 'Open this page in Safari → tap Share → "Add to Home Screen".')
      : tr('点浏览器菜单（右上角 ⋮ / ⋯）→ 选「添加到主屏幕」或「安装应用」。', 'Open the browser menu (⋮ / ⋯ top right) → "Add to Home Screen" or "Install app".')
  btn.onclick = function () {
    var card = document.getElementById('a2hsCard')
    var show = card.hidden
    card.hidden = !show
    document.getElementById('a2hsText').textContent = steps
    btn.textContent = show ? tr('收起', 'Hide') : tr('常驻到手机桌面 · 怎么做？', 'Keep on home screen · how?')
  }
})()
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] }) }
function toast(msg) { var t = document.getElementById('toast'); t.textContent = msg; t.style.display = 'block'; clearTimeout(t._h); t._h = setTimeout(function () { t.style.display = 'none' }, 2600) }
// 自绘确认弹层（浏览器原生 confirm 的按钮顺序不可控）：右侧确定、左侧取消；hint 为灰色补充说明（路由被自动路由接管时提示切换的实际效果）
function confirmDialog(msg, hint) {
  return new Promise(function (resolve) {
    var box = document.getElementById('confirm')
    var msgEl = document.getElementById('confirmMsg')
    var hintEl = document.getElementById('confirmHint')
    var yes = document.getElementById('confirmYes')
    var no = document.getElementById('confirmNo')
    msgEl.textContent = msg
    if (hint) { hintEl.textContent = hint; hintEl.hidden = false } else { hintEl.textContent = ''; hintEl.hidden = true }
    box.hidden = false
    function done(v) {
      box.hidden = true
      yes.onclick = null
      no.onclick = null
      resolve(v)
    }
    yes.onclick = function () { done(true) }
    no.onclick = function () { done(false) }
  })
}
function chipHtml(m) { return '<span class="chip">' + esc(m.name) + (m.id !== m.name ? ' <small>' + esc(m.id) + '</small>' : '') + '</span>' }
// ── 配置同步：导出/导入。包体恒为密文；口令只出现在请求体（LAN HTTP + mdklan 令牌同一信任域）──
// 导入一键直达（apply 直发 file，不再有预览确认步）；/m 无磨砂弹层，toast 本就可见
document.getElementById('expBtn').onclick = function () {
  var pw = document.getElementById('expPw').value
  if (!pw) { toast(tr('请先输入口令（导入方需输同一口令）', 'Enter a passphrase first (the importer must type the same one)')); return }
  var btn = this
  btn.disabled = true
  fetch('/m/api/sync/export', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ passphrase: pw }) })
    .then(function (r) {
      if (!r.ok) return r.json().then(function (j) { throw new Error(j.error || r.status) })
      // 文件名以服务端 content-disposition 为准（同一份带时间的名字），页面不再自造，避免两处口径漂移
      var name = 'modeldock-config.msync'
      var m = /filename="([^"]+)"/.exec(r.headers.get('content-disposition') || '')
      if (m) name = m[1]
      return r.blob().then(function (b) { return { blob: b, name: name } })
    })
    .then(function (res) {
      var b = res.blob
      var u = URL.createObjectURL(b)
      var a = document.createElement('a')
      a.href = u
      a.download = res.name
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(function () { URL.revokeObjectURL(u) }, 5000)
      // iOS 上下载落在「文件」App，不提示的话用户找不到；其它平台浏览器的下载目录各不相同，不硬说
      var tip = /iPhone|iPad|iPod/.test(navigator.userAgent) ? tr('，存到「文件」App →「下载项」', ' — saved to Files → Downloads') : ''
      toast(tr('已生成加密配置包，浏览器开始下载', 'Encrypted package created — download started') + tip)
      btn.disabled = false
    })
    .catch(function (e) { toast(tr('导出失败：', 'Export failed: ') + e.message); btn.disabled = false })
}
document.getElementById('impBtn').onclick = function () {
  var link = (document.getElementById('impLinkUrl').value || '').trim()
  var f = document.getElementById('impFile').files[0]
  var pw = document.getElementById('impPw').value
  var btn = this
  var bodyP
  if (link) {
    // 链接自带口令（#p= fragment），口令输入框只服务文件导入
    var i = link.indexOf('#p=')
    if (i < 0) { toast(tr('链接缺口号段（#p=…）：请回旧电脑复制完整链接', 'The link lacks the passphrase part (#p=…): copy the full link on the old computer')); return }
    bodyP = Promise.resolve({ phase: 'apply', url: link.slice(0, i), passphrase: link.slice(i + 3) })
  } else {
    if (!f) { toast(tr('请先选择 .msync 配置包文件，或粘贴分享链接', 'Pick a .msync package file first, or paste a share link')); return }
    if (!pw) { toast(tr('请输入导出时设置的口令', 'Enter the passphrase set at export time')); return }
    bodyP = f.text().then(function (txt) { return { phase: 'apply', file: txt, passphrase: pw } })
  }
  btn.disabled = true
  bodyP
    .then(function (b2) {
      return fetch('/m/api/sync/import', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b2) })
        .then(function (r) { return r.json().then(function (aj) { if (!r.ok || !aj.ok) throw new Error(aj.error || r.status); return aj }) })
    })
    .then(function (aj) {
      var rep2 = aj.report || {}
      toast(tr('已导入：服务 {n} · 路由 {n2} · 预设 {n3} · 定时规则 {n4}', 'Imported: {n} providers · {n2} profiles · {n3} presets · {n4} schedule rules').replace('{n}', (rep2.providers || []).length).replace('{n2}', (rep2.profiles || []).length).replace('{n3}', rep2.presetCount || 0).replace('{n4}', rep2.scheduleRules || 0))
      var warns = impWarnList(rep2)
      if (warns.length) toast(warns.join(tr('；', '; ')))
      load()
    })
    .catch(function (e) { toast(tr('导入失败：', 'Import failed: ') + e.message) })
    .then(function () { btn.disabled = false })
}
function render(j) {
  document.getElementById('host').textContent = j.hostname || ''
  var r = j.route || {}
  var sch = r.schedule || {}
  var wins = sch.windows || []
  function svcName(id) {
    for (var i = 0; i < j.services.length; i++) if (j.services[i].id === id) return j.services[i].name
    return id
  }
  function targetLabel(t) { var p = parseTarget(t); return svcName(p.p) + (p.m ? ' · ' + p.m : '') }
  function dayLabel(w) {
    if (w.dayFilter === 'workday') return tr('工作日', 'Weekdays')
    if (w.dayFilter === 'weekend') return tr('周末', 'Weekend')
    if (w.dayFilter === 'holiday') return tr('法定节假日', 'Holidays')
    if (w.days && w.days.length && w.days.length < 7) return w.days.map(function (d) { return tr('周', 'Day ') + d }).join('/')
    return tr('每天', 'Every day')
  }
  // 与桌面路由行同口径同行为（扫谁的码就与谁的桌面一致）：双槽位——「当前」=实际使用的主服务（自动·A / 人工钉定）、
  // 「下一个切换」=主服务不可达时切到谁（自动·B / 人工钉定）；人工修改优先于程序自动（含定时窗口）
  // 「当前」槽：自动态显示「自动 · A」（A=程序会选的：定时窗口/默认路由），人工钉定时显示钉定服务
  var curAutoOpt = !r.forced && r.autoPrimaryLabel ? tr('自动 · ', 'Auto · ') + r.autoPrimaryLabel : tr('自动', 'Auto')
  var curOpts = routeSelectHtml(j.services || [], curAutoOpt, r.forced, r.label || r.forced)
  // 「下一个切换」槽：自动态显示「自动 · B」（B=自动态真会切到的下一跳，桌面同源 autoNextLabel）；没得切时明说无备用服务
  var nextAutoOpt = r.autoNextLabel ? tr('自动 · ', 'Auto · ') + r.autoNextLabel : tr('自动 · 无备用服务', 'Auto · no fallback')
  var nextOpts = routeSelectHtml(j.services || [], nextAutoOpt, r.routeNext, r.nextLabel || r.routeNext)
  var effSvc = null
  if (r.provider) { for (var i = 0; i < j.services.length; i++) if (j.services[i].id === r.provider) { effSvc = j.services[i]; break } }
  var effName = effSvc ? effSvc.name : (j.active ? j.active.name : null)
  var model = r.model != null ? r.model : (j.active ? j.active.default_model : null)
  var why = []
  if (sch.enabled === false && wins.length) why.push(tr('定时切换已停用', 'Timed switching is disabled'))
  if (sch.active) why.push(tr('定时 ', 'Schedule ') + sch.active.start + '–' + sch.active.end + ' · ' + tr('优先 ', 'prefer ') + targetLabel(sch.active.target))
  var av = sch.activeAvoids || []
  if (av.length) why.push(tr('定时避开 ', 'Avoiding ') + av.map(function (w) { return targetLabel(w.target) }).join(tr('、', ', ')) + ' · ' + av[0].start + '–' + av[0].end)
  if (r.forced) why.push(tr('主服务已人工钉定 · 定时窗口暂停，选回「自动」恢复', 'Primary pinned manually — schedule windows paused; pick "Auto" to resume'))
  if (!r.on && wins.length) why.push(tr('自动选主未开启：时段不生效（故障切换不受影响）', 'Auto primary selection is off: windows are inactive (failover still works)'))
  // 故障切换常开：主服务不可达即按候选链切换，与自动选主开关无关
  why.push(tr('限流(429)/网关错误(503) 切备用 · ', 'Fallback on 429/503 · ') + (r.failover429 ? tr('开', 'on') : tr('关', 'off')))
  why.push(tr('自动备用链 · ', 'Auto fallback chain · ') + (r.autoFallback ? tr('开', 'on') : tr('关', 'off')))
  var schedBtn = wins.length
    ? '<p class="why"><button type="button" class="mini" id="schedShow">' + tr('定时时段', 'Timed windows') + ' · ' + wins.length + tr(' 个 · 展开', ' · show') + '</button></p>' +
      '<div class="models" id="schedList" style="display:none">' + wins.map(function (w) {
        return '<span class="chip">' + esc(dayLabel(w) + ' ' + w.start + '–' + w.end + ' · ' + (w.mode === 'avoid' ? tr('避开', 'avoid') : tr('优先', 'prefer')) + ' ' + targetLabel(w.target)) + '</span>'
      }).join('') + '</div>'
    : ''
  var a = document.getElementById('active')
  a.innerHTML =
    '<p class="rrow"><label>' + tr('当前', 'Current') + '</label><select id="curSvc">' + curOpts + '</select></p>' +
    '<p class="rrow"><label>' + tr('下一个切换', 'Next failover') + '</label><select id="nextSvc">' + nextOpts + '</select>' +
    '<button type="button" class="rpill' + (r.on ? ' on' : '') + '" id="arPill">' + (r.on ? tr('自动路由 · 开', 'Auto route · on') : tr('自动路由 · 关', 'Auto route · off')) + '</button></p>' +
    '<hr class="rsep">' +
    '<p class="rlabel2">' + tr('实际生效', 'Actually serving') + '</p>' +
    (effName
      ? '<p class="sname">' + esc(effName) + '</p>' +
        '<p class="model">' + tr('模型', 'Model') + ': ' + esc(model || tr('未设置', 'not set')) + '</p>' +
        '<p class="model">' + tr('下一个切换', 'Next failover') + ': ' + esc(r.nextLabel || tr('无备用服务', 'no fallback')) + (r.routeNext && r.routeNext !== r.provider ? tr('（人工钉定）', ' (pinned)') : '') + '</p>'
      : '<p class="empty">' + (j.services.length
        ? tr('这台电脑还没选当前服务：在上面「当前」里选一个即可', 'No service selected on this computer yet — pick one in Current above')
        : tr('服务不可用', 'unavailable')) + '</p>') +
    (why.length ? '<p class="why">' + why.map(esc).join('<br>') + '</p>' : '') +
    schedBtn
  var curSel = document.getElementById('curSvc')
  if (curSel) {
    curSel.value = r.forced || ''
    // 与桌面「当前」下拉同款快捷路径：选服务=/m/api/switch（写钉定+默认路由），选「自动」=清除钉定；失败经 load() 用服务端真相回滚
    curSel.onchange = function () {
      var id = this.value
      if (id === (r.forced || '')) return
      curSel.disabled = true
      if (!id) {
        fetch('/m/api/auto-route', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider: null }) })
          .then(function (resp) { return resp.json().then(function (j2) { if (!resp.ok || !j2.ok) throw new Error(j2.error || resp.status); return j2 }) })
          .then(function () { toast(tr('已恢复自动选路', 'Back to auto selection')); load() })
          .catch(function (e) { toast(tr('切换失败：', 'Switch failed: ') + e.message); load() })
        return
      }
      fetch('/m/api/switch', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ service: id }) })
        .then(function (resp) { return resp.json().then(function (j2) { if (!resp.ok || !j2.ok) throw new Error(j2.error || resp.status); return j2 }) })
        .then(function () { toast(tr('已切换，新请求立即生效', 'Switched; new requests take effect immediately')); load() })
        .catch(function (e) { toast(tr('切换失败：', 'Switch failed: ') + e.message); load() })
    }
  }
  var nSel = document.getElementById('nextSvc')
  if (nSel) {
    nSel.value = r.routeNext || ''
    // 与桌面「下一个切换」下拉同款：选服务=钉定该槽（插备用链首位），选「自动」=恢复按优先级/实测耗时排序
    nSel.onchange = function () {
      var v = this.value || null
      nSel.disabled = true
      fetch('/m/api/auto-route', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ next: v }) })
        .then(function (resp) { return resp.json().then(function (j2) { if (!resp.ok || !j2.ok) throw new Error(j2.error || resp.status); return j2 }) })
        .then(function () { toast(v ? tr('已钉定下一个切换「', 'Next failover pinned to "') + svcName(v) + tr('」', '"') : tr('下一个切换已恢复自动', 'Next failover back to auto')); load() })
        .catch(function (e) { toast(tr('设置失败：', 'Failed: ') + e.message); load() })
    }
  }
  var pill = document.getElementById('arPill')
  if (pill) {
    pill.onclick = function () {
      pill.disabled = true
      pill.textContent = tr('自动路由 · …', 'Auto route · …')
      fetch('/m/api/auto-route', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: !r.on }) })
        .then(function (resp) { return resp.json().then(function (j2) { if (!resp.ok || !j2.ok) throw new Error(j2.error || resp.status); return j2 }) })
        .then(function (j2) {
          pill.disabled = false
          pill.className = 'rpill' + (j2.enabled ? ' on' : '')
          pill.textContent = j2.enabled ? tr('自动路由 · 开', 'Auto route · on') : tr('自动路由 · 关', 'Auto route · off')
          toast(j2.enabled ? tr('已开启自动路由', 'Auto route enabled') : tr('已关闭自动路由', 'Auto route disabled'))
          load()
        })
        .catch(function (e) { toast(tr('设置失败：', 'Failed: ') + e.message); load() })
    }
  }
  var schedShow = document.getElementById('schedShow')
  if (schedShow) {
    schedShow.onclick = function () {
      var list = document.getElementById('schedList')
      if (!list) return
      var show = list.style.display === 'none'
      list.style.display = show ? 'flex' : 'none'
      schedShow.textContent = tr('定时时段', 'Timed windows') + ' · ' + wins.length + (show ? tr(' 个 · 收起', ' · hide') : tr(' 个 · 展开', ' · show'))
    }
  }
  var box = document.getElementById('services')
  if (!j.services.length) { box.innerHTML = '<p class="empty">' + tr('还没有服务，请先在电脑端添加', 'No services yet — add one on the computer') + '</p>'; return }
  box.innerHTML = j.services.map(function (s) {
    // 「使用中」=全局默认路由（active_profile），与桌面服务卡「正在使用」同口径；实际走向见上方「实际生效」行
    var badge = s.active ? '<span class="badge">' + tr('使用中', 'in use') + '</span>' : ''
    return '<div class="row"><div class="info"><div class="nm">' + esc(s.name) + badge + '</div>' +
      '<div class="meta">' + tr('{n} 个模型', '{n} models').replace('{n}', s.count) + ' <button type="button" class="mini" data-expand="' + esc(s.id) + '">' + tr('展开', 'show') + '</button></div>' +
      '<div class="models" data-models="' + esc(s.id) + '" style="display:none">' + s.models.map(chipHtml).join('') + '</div></div>' +
      '<button type="button" class="act' + (s.active ? '' : ' on') + '" data-switch="' + esc(s.id) + '" data-name="' + esc(s.name) + '"' + (s.active ? ' disabled' : '') + '>' + tr('切换', 'Switch') + '</button></div>'
  }).join('')
  Array.prototype.forEach.call(box.querySelectorAll('[data-expand]'), function (b) {
    b.onclick = function () {
      var box2 = box.querySelector('[data-models="' + CSS.escape(b.getAttribute('data-expand')) + '"]')
      if (!box2) return
      var show = box2.style.display === 'none'
      box2.style.display = show ? 'flex' : 'none'
      b.textContent = show ? tr('收起', 'hide') : tr('展开', 'show')
    }
  })
  Array.prototype.forEach.call(box.querySelectorAll('[data-switch]'), function (b) {
    b.onclick = function () {
      var name = b.getAttribute('data-name')
      // 人工钉定优先于程序自动：切换即钉定该服务（压过定时窗口），直到「当前」选回「自动」
      var hint = r.on
        ? tr('切换会人工钉定该服务：定时时段内也走它，直到「当前」选回「自动」恢复程序自动。', 'This pins the service manually — it applies during schedule windows too, until you pick "Auto" in Current to resume program selection.')
        : ''
      confirmDialog(tr('切换到「' + name + '」？已接入的客户端会立即改走它。', 'Switch to "' + name + '"? Attached clients take effect immediately.'), hint).then(function (ok) {
        if (!ok) return
        b.disabled = true
        fetch('/m/api/switch', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ service: b.getAttribute('data-switch') }) })
          .then(function (r) { return r.json().then(function (j2) { if (!r.ok || !j2.ok) throw new Error(j2.error || r.status); return j2 }) })
          .then(function () { toast(tr('已切换', 'Switched')); load() })
          .catch(function (e) { toast(tr('切换失败：', 'Switch failed: ') + e.message); b.disabled = false })
      })
    }
  })
}
var lastState = null
function load() {
  fetch('/m/api/state').then(function (r) { if (r.status === 403) throw new Error(tr('令牌失效，请重新扫码', 'Token expired — scan the QR again')); return r.json() })
    .then(function (j) {
      if (j) delete j.uptime_ms // 每次轮询都变的字段不参与 diff：数据没变就不重绘，避免打断正在操作的下拉
      var s = JSON.stringify(j)
      if (s === lastState) return
      lastState = s
      render(j)
    })
    .catch(function (e) { document.getElementById('services').innerHTML = '<p class="empty">' + esc(e.message) + '</p>' })
}
load()
setInterval(load, 30000)
</script>
</body>
</html>`
}

function renderDeniedPage(): string {
  const zh = '请从电脑端控制台的二维码进入（令牌缺失或不正确）。'
  const en = 'Open via the QR code shown in the desktop console (token missing or incorrect).'
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>ModelDock</title></head><body style="background:#0f1115;color:#e5e7eb;font:15px/1.7 -apple-system,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;text-align:center"><p style="padding:0 28px">${zh}<br><span style="color:#9ca3af;font-size:13px">${en}</span></p></body></html>`
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
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(renderMobilePage())
      return
    }
    if (lanAuthorized(req, rt)) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(renderMobilePage())
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
      await switchToService(service)
      await setAutoRoute(rt.config.gateway?.auto_failover === true, service)
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
  rt.lan = undefined
}

/** 管理端点（/_modeldock/lan GET/POST）共用的状态载荷；二维码只对已过 admin 鉴权的控制台返回。
 *  urls 按「手机最可能连上」排序（见 rankLanAddresses）：[0] 生成二维码，其余供用户换着试；
 *  platform 供控制台判断是否提示 Windows 防火墙放行（首次监听 0.0.0.0 时系统会弹窗，漏点就手机连不上）。 */
export function buildLanStatus(rt: GatewayRuntime): { enabled: boolean; port: number; urls: string[]; qrcode: string | null; platform: string } {
  const enabled = !!rt.config.lan?.enabled && !!rt.lan
  const port = rt.lan?.port ?? rt.config.lan?.port ?? DEFAULT_LAN_PORT
  const urls = rt.lan ? lanAddresses().map((ip) => `http://${ip}:${rt.lan!.port}/m`) : []
  const primary = rt.lan ? `${urls[0] ?? `http://127.0.0.1:${rt.lan.port}/m`}?token=${rt.lan.token}` : null
  return { enabled, port, urls, qrcode: primary ? lanQrSvg(primary) : null, platform: process.platform }
}
