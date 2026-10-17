/**
 * 系统代理解析（update 专用）：更新下载此前走 Node 全局 fetch，不认系统代理——
 * 大陆网络下 Clash 等本地代理开着也会直连 GitHub CDN，表现为进度 0% 长期卡死。
 * 解析链：显式环境变量（HTTPS_PROXY 等，用户明确接管）→ 系统代理设置
 * （macOS `scutil --proxy` / Windows 注册表 Internet Settings；Linux 无统一桌面
 * 接口，回落环境变量）。地址端口全部运行时检测，绝不写死任何代理端点。
 * `MODELRDOCK_NO_SYS_PROXY=1` 一键禁用（自动检测误伤时的逃生口）。
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)

/** 代理端口合法范围（parse 侧共用）：超出即视为检测噪声，弃用走直连 */
function validHostPort(host: string, port: number): boolean {
  return host.length > 0 && Number.isInteger(port) && port >= 1 && port <= 65535
}

/**
 * 环境变量优先级：HTTPS_PROXY > HTTP_PROXY > ALL_PROXY（大小写各一份，HTTPS 优先）。
 * 返回 null = 用户没在环境里声明代理，继续查系统设置。
 */
export function pickEnvProxy(env: NodeJS.ProcessEnv = process.env): string | null {
  for (const k of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']) {
    const v = env[k]?.trim()
    if (v) return v
  }
  return null
}

/**
 * 解析 macOS `scutil --proxy` 输出。优先 HTTPS（更新目标是 https），
 * 其次 HTTP，最后 SOCKS（socks5:// 前缀——ProxyAgent 只认完整 URL 形态）。
 */
export function parseScutilProxy(out: string): string | null {
  const read = (key: string): string | null => {
    const m = out.match(new RegExp(`^\\s*${key}\\s*:\\s*(\\S+)`, 'm'))
    return m ? m[1] : null
  }
  const num = (key: string): number | null => {
    const v = read(key)
    return v && /^\d+$/.test(v) ? Number(v) : null
  }
  const enabled = (key: string): boolean => read(key) === '1'
  if (enabled('HTTPSEnable')) {
    const host = read('HTTPSProxy')
    const port = num('HTTPSPort')
    if (host && port && validHostPort(host, port)) return `http://${host}:${port}`
  }
  if (enabled('HTTPEnable')) {
    const host = read('HTTPProxy')
    const port = num('HTTPPort')
    if (host && port && validHostPort(host, port)) return `http://${host}:${port}`
  }
  if (enabled('SOCKSEnable')) {
    const host = read('SOCKSProxy')
    const port = num('SOCKSPort')
    if (host && port && validHostPort(host, port)) return `socks5://${host}:${port}`
  }
  return null
}

/**
 * 解析 Windows 注册表 ProxyServer 值。两种形态：整機 "host:port"；
 * 分协议 "http=h:p;https=h:p;socks=h:p"（取 https，退 http/socks）。
 */
export function parseWinProxyServer(value: string): string | null {
  const v = value.trim()
  if (!v) return null
  if (v.includes('=')) {
    for (const scheme of ['https', 'http', 'socks']) {
      const m = v.match(new RegExp(`(?:^|;)${scheme}=([^;]+)`, 'i'))
      if (m) {
        const url = normalizeWinEntry(scheme === 'socks' ? `socks5://${m[1]}` : m[1])
        if (url) return url
      }
    }
    return null
  }
  return normalizeWinEntry(v)
}

/** "host:port" → http://host:port（缺端口视为无效——系统代理设置必有端口） */
function normalizeWinEntry(entry: string): string | null {
  const idx = entry.lastIndexOf(':')
  if (idx <= 0) return null
  const host = entry.slice(0, idx).trim()
  const port = Number(entry.slice(idx + 1).trim())
  if (!validHostPort(host, port)) return null
  return entry.startsWith('socks5://') ? entry : `http://${host}:${port}`
}

/** 注册表查询输出 → ProxyServer 值（值串不含空白，REG_SZ 后第一个 token） */
export function parseRegProxyServer(out: string): string | null {
  const m = out.match(/ProxyServer\s+REG_\S+\s+(\S+)/)
  return m ? m[1] : null
}

/** 注册表查询输出 → ProxyEnable 是否为 1 */
export function parseRegProxyEnabled(out: string): boolean {
  return /ProxyEnable\s+REG_\S+\s+0x1\b/.test(out)
}

/** 进程级缓存：一次更新流程解析一次（execFile 有开销；更新进程短命，无需失效逻辑） */
let cached: Promise<string | null> | null = null

/** 测试注入用：清空解析缓存 */
export function resetUpdateProxyCacheForTest(): void {
  cached = null
}

async function detectSystemProxy(): Promise<string | null> {
  try {
    if (process.platform === 'darwin') {
      const { stdout } = await execFileP('scutil', ['--proxy'], { timeout: 5000 })
      return parseScutilProxy(stdout)
    }
    if (process.platform === 'win32') {
      const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'
      const [en, sv] = await Promise.all([
        execFileP('reg', ['query', key, '/v', 'ProxyEnable'], { timeout: 5000 }),
        execFileP('reg', ['query', key, '/v', 'ProxyServer'], { timeout: 5000 }).catch(() => ({ stdout: '' })),
      ])
      if (!parseRegProxyEnabled(en.stdout)) return null
      const value = parseRegProxyServer(sv.stdout)
      return value ? parseWinProxyServer(value) : null
    }
  } catch {
    return null // scutil/reg 缺失或超时：按无代理处理（回落直连，不阻断更新）
  }
  return null // linux/其他：无统一桌面代理接口，回落环境变量链（pickEnvProxy 已在先）
}

/**
 * 更新链路的代理解析入口：显式环境变量优先（含用户 shell 里的 HTTPS_PROXY），
 * 其后 macOS/Windows 系统代理设置；MODELRDOCK_NO_SYS_PROXY=1 直接禁用。
 * 返回 null = 未检测到代理，按直连走（与既有行为一致）。
 */
export async function resolveUpdateProxyUrl(env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  if (env.MODELRDOCK_NO_SYS_PROXY === '1') return null
  const fromEnv = pickEnvProxy(env)
  if (fromEnv) return fromEnv
  cached ??= detectSystemProxy()
  return cached
}
