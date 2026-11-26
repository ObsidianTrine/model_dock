import type http from 'node:http'
import { DEFAULT_GATEWAY_PORT } from '../../config/types.js'
import { safeEqual } from '../../util/safe-equal.js'
import { adminCookieName } from '../cookies.js'
import type { GatewayRuntime } from '../state.js'

/** 管理面所有端点（含 GET）的 Host 白名单：DNS rebinding 的 Host 不是本机，读取类端点同样拒绝。
 *  参照 Vite allowedHosts（CVE-2025-31125 同类问题的标准修法）。 */
export function hostAllowed(req: http.IncomingMessage): boolean {
  const host = String(req.headers.host ?? '')
  return /^(127\.0\.0\.1|\[::1\]|localhost)(:\d+)?$/i.test(host)
}

// cookie 名 → 提取正则缓存：admin/device cookie 名在进程内只有个位数个（随端口），避免每请求重新编译
const cookieValueReCache = new Map<string, RegExp>()
export function cookieValueRe(name: string): RegExp {
  let re = cookieValueReCache.get(name)
  if (!re) {
    re = new RegExp(`(?:^|;\\s*)${name}=([^;]+)`)
    cookieValueReCache.set(name, re)
  }
  return re
}

/** cookie 值解码：畸形值（如裸 `%`）会让 decodeURIComponent 抛 URIError 穿到顶层变 500，
 *  这里按解码失败=值不匹配处理，让鉴权路径落到正常的 401/403。 */
export function safeCookieDecode(v: string): string {
  try {
    return decodeURIComponent(v)
  } catch {
    return v
  }
}

export function adminAuthorized(rt: GatewayRuntime, req: http.IncomingMessage): boolean {
  const h = req.headers['x-modeldock-admin']
  if (typeof h === 'string' && safeEqual(h, rt.adminToken)) return true
  // Web 控制台的 cookie 登录（HttpOnly + SameSite=Lax，跨站 POST 不携带）
  const cookie = req.headers.cookie
  if (typeof cookie === 'string') {
    const m = cookieValueRe(adminCookieName(rt.port ?? DEFAULT_GATEWAY_PORT)).exec(cookie)
    if (m && safeEqual(safeCookieDecode(m[1]), rt.adminToken)) return true
  }
  return false
}
