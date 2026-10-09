/**
 * 云端控制面 API v1（docs/design-cloud-sync.md §7.2）。
 * 鉴权：Authorization: Bearer <deviceToken|consoleToken>；控制台页登录后走 HttpOnly cookie（同 token）。
 * 统一 JSON 错误 {error:{code,message}}；限速单 IP 60 req/min（内存计数）。
 * desired 语义按「应用」按钮同款：值是服务（provider）id——详设 §7.2 写 profileId，
 * 实现取 UI 面向用户的「服务」口径（与 switchToService 对齐），字段兼容 service | profileId。
 */
import { createHash } from 'node:crypto'
import http from 'node:http'
import { randomToken } from '../util/fsx.js'
import { CloudStore } from './store.js'
import { renderConsolePage } from './console.js'
import { t } from '../util/i18n.js'

export const DEVICE_ONLINE_WINDOW_MS = 180_000
export const PAIRCODE_TTL_MS = 15 * 60_000

export interface CloudServerOptions {
  consoleToken: string
  /** 测试可调小；默认 60 req/min（详设 §7.2） */
  rateLimitPerMin?: number
  version?: string
}

interface RateBucket {
  count: number
  windowStart: number
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex')
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(text)
}

function fail(res: http.ServerResponse, status: number, code: string, message: string): void {
  json(res, status, { error: { code, message } })
}

/** 配对码：XXXX-XXXX，去掉易混字符（0/O/1/I/L） */
export function generatePairCode(): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
  const pick = (): string => alphabet[Math.floor(Math.random() * alphabet.length)]
  return [0, 1, 2, 3].map(pick).join('') + '-' + [0, 1, 2, 3].map(pick).join('')
}

function readBody(req: http.IncomingMessage, limit = 5 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > limit) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function cookieToken(req: http.IncomingMessage): string | null {
  const raw = req.headers.cookie
  if (!raw) return null
  for (const pair of raw.split(';')) {
    const [k, ...rest] = pair.trim().split('=')
    if (k === 'mdkcloud') return decodeURIComponent(rest.join('='))
  }
  return null
}

export function createCloudServer(store: CloudStore, opts: CloudServerOptions): http.Server {
  const rateLimitPerMin = opts.rateLimitPerMin ?? 60
  const buckets = new Map<string, RateBucket>()

  const server = http.createServer((req, res) => {
    void handle(req, res).catch((e: Error) => {
      fail(res, 500, 'internal', e.message)
    })
  })

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // 限速（按 RemoteAddress；反代场景后续上 TLS/域名时再换 x-forwarded-for）
    const ip = req.socket.remoteAddress ?? '?'
    const now = Date.now()
    const bucket = buckets.get(ip)
    if (!bucket || now - bucket.windowStart >= 60_000) {
      buckets.set(ip, { count: 1, windowStart: now })
    } else {
      bucket.count++
      if (bucket.count > rateLimitPerMin) {
        fail(res, 429, 'rate_limited', t('请求过于频繁，稍后再试', 'Too many requests; slow down'))
        return
      }
    }
    if (buckets.size > 10_000) buckets.clear() // 粗暴防内存膨胀；单用户自托管场景足够

    const url = (req.url ?? '/').split('?')[0]
    const method = req.method ?? 'GET'

    // —— 静态控制台页 ——
    if (method === 'GET' && (url === '/' || url === '/index.html')) {
      const body = renderConsolePage()
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(body)
      return
    }

    const bodyText = method === 'POST' || method === 'PUT' ? await readBody(req) : ''

    // —— 登录（控制台页用；HttpOnly + SameSite=Strict） ——
    if (method === 'POST' && url === '/v1/login') {
      const b = JSON.parse(bodyText || '{}') as { token?: string }
      if (b.token !== opts.consoleToken) {
        fail(res, 401, 'unauthorized', t('控制台令牌不正确', 'Invalid console token'))
        return
      }
      res.setHeader('Set-Cookie', `mdkcloud=${encodeURIComponent(opts.consoleToken)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`)
      json(res, 200, { ok: true })
      return
    }

    // —— 配对（免鉴权：新设备凭一次性码入网） ——

    if (method === 'POST' && url === '/v1/pair') {
      const b = JSON.parse(bodyText || '{}') as { pairCode?: string; devid?: string; deviceName?: string }
      const pairCode = String(b.pairCode ?? '').trim().toUpperCase()
      const devid = String(b.devid ?? '').trim()
      const deviceName = String(b.deviceName ?? '').trim() || 'device'
      if (!pairCode || !devid || devid.length > 128) {
        fail(res, 400, 'invalid', t('缺少 pairCode 或 devid', 'Missing pairCode or devid'))
        return
      }
      store.sweepExpiredPairCodes(now)
      if (!store.takePairCode(pairCode, now)) {
        fail(res, 400, 'paircode_invalid', t('配对码无效或已过期/已使用：请在控制台重新生成', 'Pair code is invalid, expired, or already used; generate a new one in the console'))
        return
      }
      const deviceToken = randomToken('mdkdev')
      store.upsertDevice(devid, deviceName.slice(0, 64), sha256(deviceToken), new Date(now).toISOString())
      json(res, 200, { deviceToken })
      return
    }

    // —— 鉴权：Bearer 头优先，其次控制台 cookie ——
    const bearer = /^Bearer\s+(.+)$/.exec(req.headers.authorization ?? '')
    const token = bearer?.[1] ?? cookieToken(req)
    if (!token) {
      fail(res, 401, 'unauthorized', t('缺少凭据（Bearer token 或控制台登录）', 'Missing credentials (Bearer token or console login)'))
      return
    }
    let role: 'console' | 'device' | null = null
    let deviceDevid: string | null = null
    if (token === opts.consoleToken) {
      role = 'console'
    } else {
      const dev = store.deviceByTokenHash(sha256(token))
      if (dev) {
        role = 'device'
        deviceDevid = dev.devid
      }
    }
    if (!role) {
      fail(res, 401, 'unauthorized', t('凭据无效或已被重置', 'Invalid or revoked credentials'))
      return
    }

    // —— 设备端点 ——

    if (method === 'GET' && url === '/v1/doc') {
      if (role !== 'device') {
        fail(res, 403, 'forbidden', t('该端点仅限设备凭据', 'This endpoint requires a device token'))
        return
      }
      const doc = store.getDoc()
      if (!doc) {
        fail(res, 404, 'no_doc', t('云端还没有配置文档', 'No config document on the cloud yet'))
        return
      }
      const inm = Number(req.headers['if-none-match'] ?? NaN)
      if (Number.isInteger(inm) && inm === doc.rev) {
        res.writeHead(304)
        res.end()
        return
      }
      json(res, 200, { rev: doc.rev, envelope: doc.envelope, ts: doc.ts, byDevid: doc.by_devid })
      return
    }

    if (method === 'PUT' && url === '/v1/doc') {
      if (role !== 'device') {
        fail(res, 403, 'forbidden', t('该端点仅限设备凭据', 'This endpoint requires a device token'))
        return
      }
      const baseRev = Number(req.headers['if-match'] ?? NaN)
      if (!Number.isInteger(baseRev) || baseRev < 0) {
        fail(res, 400, 'invalid', t('缺少 If-Match 基线修订号', 'Missing If-Match base revision'))
        return
      }
      let b: { envelope?: unknown; ts?: unknown }
      try {
        b = JSON.parse(bodyText || '{}')
      } catch {
        fail(res, 400, 'invalid', t('请求体不是合法 JSON', 'Request body is not valid JSON'))
        return
      }
      const envelope = typeof b.envelope === 'string' ? b.envelope : ''
      const ts = typeof b.ts === 'string' ? b.ts : ''
      if (!envelope || !ts) {
        fail(res, 400, 'invalid', t('缺少 envelope 或 ts', 'Missing envelope or ts'))
        return
      }
      let envFmt: unknown
      try {
        envFmt = (JSON.parse(envelope) as Record<string, unknown>).fmt
      } catch {
        envFmt = null
      }
      if (envFmt !== 'modeldock-syncenv') {
        fail(res, 400, 'invalid', t('envelope 不是 ModelDock 同步信封', 'The envelope is not a ModelDock sync envelope'))
        return
      }
      const cur = store.getDoc()
      if (cur && cur.rev !== baseRev) {
        json(res, 409, { error: { code: 'conflict', message: t('基线修订号不符', 'Base revision mismatch') }, rev: cur.rev, ts: cur.ts })
        return
      }
      if (cur && Date.parse(ts) < Date.parse(cur.ts)) {
        fail(res, 422, 'rollback_rejected', t('包时间早于云端现有版本，疑似回滚，已拒收', 'The package timestamp is older than the stored version (rollback); rejected'))
        return
      }
      const newRev = (cur?.rev ?? 0) + 1
      store.putDoc(newRev, envelope, ts, deviceDevid!)
      json(res, 200, { rev: newRev })
      return
    }

    if (method === 'POST' && url === '/v1/heartbeat') {
      if (role !== 'device') {
        fail(res, 403, 'forbidden', t('该端点仅限设备凭据', 'This endpoint requires a device token'))
        return
      }
      let b: { devid?: unknown; version?: unknown; reportedProfile?: unknown; services?: unknown }
      try {
        b = JSON.parse(bodyText || '{}')
      } catch {
        b = {}
      }
      const devid = typeof b.devid === 'string' ? b.devid : ''
      if (devid !== deviceDevid) {
        fail(res, 403, 'forbidden', t('devid 与设备凭据不符', 'devid does not match the device token'))
        return
      }
      const nowIso = new Date(now).toISOString()
      // services：本机可用服务目录（id+显示名，元数据面与 reported_profile 同级暴露；详设 §7.2 heartbeat 的实现扩展——
      // 云端只见密文拿不到服务清单，控制台的切换下拉只能靠各机上报目录并集）
      let servicesJson: string | undefined
      if (Array.isArray(b.services)) {
        const list = (b.services as unknown[])
          .slice(0, 64)
          .map((s) => {
            const o = (s ?? {}) as Record<string, unknown>
            return { id: String(o.id ?? '').slice(0, 128), name: String(o.name ?? '').slice(0, 64) }
          })
          .filter((s) => s.id)
        if (list.length > 0) servicesJson = JSON.stringify(list)
      }
      store.touchDevice(devid, {
        lastSeen: nowIso,
        clientVersion: typeof b.version === 'string' ? b.version.slice(0, 32) : undefined,
        reportedProfile: typeof b.reportedProfile === 'string' ? b.reportedProfile.slice(0, 128) : undefined,
        servicesJson,
      })
      const dev = store.device(devid)
      json(res, 200, { desiredProfile: dev?.desired_profile ?? null, desiredTs: dev?.desired_ts ?? null })
      return
    }

    // —— 控制台端点 ——

    if (method === 'GET' && url === '/v1/devices') {
      if (role !== 'console') {
        fail(res, 403, 'forbidden', t('该端点仅限控制台', 'This endpoint requires the console token'))
        return
      }
      const devices = store.listDevices().map((d) => {
        let services: Array<{ id: string; name: string }> = []
        if (d.services_json) {
          try {
            services = JSON.parse(d.services_json) as Array<{ id: string; name: string }>
          } catch {
            services = []
          }
        }
        return {
          devid: d.devid,
          name: d.name,
          lastSeen: d.last_seen,
          clientVersion: d.client_version,
          reportedProfile: d.reported_profile,
          desiredProfile: d.desired_profile,
          desiredTs: d.desired_ts,
          services,
          online: !!d.last_seen && now - Date.parse(d.last_seen) < DEVICE_ONLINE_WINDOW_MS,
        }
      })
      const doc = store.getDoc()
      json(res, 200, { devices, docUpdatedAt: doc?.ts ?? null, docRev: doc?.rev ?? 0 })
      return
    }

    if (method === 'POST' && url === '/v1/desire') {
      if (role !== 'console') {
        fail(res, 403, 'forbidden', t('该端点仅限控制台', 'This endpoint requires the console token'))
        return
      }
      let b: { devid?: unknown; profileId?: unknown; service?: unknown }
      try {
        b = JSON.parse(bodyText || '{}')
      } catch {
        b = {}
      }
      const target = typeof b.devid === 'string' ? b.devid : ''
      const profileId = typeof b.service === 'string' ? b.service : typeof b.profileId === 'string' ? b.profileId : ''
      if (!target || !profileId) {
        fail(res, 400, 'invalid', t('缺少 devid（或 "all"）与 profileId/service', 'Missing devid (or "all") and profileId/service'))
        return
      }
      if (target !== 'all' && !store.device(target)) {
        fail(res, 404, 'no_device', t('设备不存在：{devid}', 'Unknown device: {devid}', { devid: target }))
        return
      }
      const updated = store.setDesired(target === 'all' ? null : target, profileId.slice(0, 128), new Date(now).toISOString())
      json(res, 200, { ok: true, updated })
      return
    }

    if (method === 'POST' && url === '/v1/paircode') {
      if (role !== 'console') {
        fail(res, 403, 'forbidden', t('该端点仅限控制台', 'This endpoint requires the console token'))
        return
      }
      const code = generatePairCode()
      const expiresAt = new Date(now + PAIRCODE_TTL_MS).toISOString()
      store.createPairCode(code, expiresAt)
      json(res, 200, { pairCode: code, expiresAt })
      return
    }

    fail(res, 404, 'not_found', t('未知路径', 'Unknown path'))
  }

  return server
}

export { sha256 as sha256Hex }
