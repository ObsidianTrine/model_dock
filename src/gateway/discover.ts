import dgram from 'node:dgram'
import os from 'node:os'

/** 附近电脑发现（sync-nearby）：UDP 广播/单播自研协议，零依赖（node:dgram），不引入 native addon。
 *  协议：查询包 `MDKD1?{json}` → 应答 `MDKD1!{"name":主机名,"port":LAN-TCP端口,"ips":[可达地址]}`。
 *  可达地址由应答方按其监听器实际绑定派生（B 不猜应答包源地址——同机多实例 reuseAddr
 *  抢单播时源地址不可靠）；应答不含任何密钥/令牌。 */

const MAGIC_Q = 'MDKD1?'
const MAGIC_A = 'MDKD1!'

/** 发现固定 UDP 端口（与 TCP LAN 端口无关；SO_REUSEADDR 允许同机多实例共存应答） */
export const SYNC_BEACON_PORT = 8787

export interface NearbyPeer {
  /** 回连地址候选（对方自广告的监听地址；同一台机器多网卡会答多次——依次尝试，任一可达即可） */
  ips: string[]
  /** 对方 LAN 监听器 TCP 端口（/m/sync/* 端点所在） */
  port: number
  /** 对方主机名（展示用；主机名+端口唯一标识一台机器） */
  name: string
}

let beacon: dgram.Socket | null = null

/** 发现应答器：绑定 UDP 8787，收到查询时以本机 LAN 监听器端口与可达地址列表应答。
 *  随手机远程（LAN 监听器）启停——未开启手机远程时不应答、不可被发现。
 *  端口被占/被防火墙拦截时静默降级：本机只是不可被发现，复制链接兜底照常。 */
export function startSyncBeacon(getAdvert: () => { port: number; ips: string[] } | undefined): void {
  stopSyncBeacon()
  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true })
  sock.on('error', () => stopSyncBeacon())
  sock.on('message', (msg, rinfo) => {
    if (msg.slice(0, MAGIC_Q.length).toString('utf8') !== MAGIC_Q) return
    const advert = getAdvert()
    if (!advert || !advert.ips.length) return
    const answer = Buffer.from(MAGIC_A + JSON.stringify({ name: os.hostname(), port: advert.port, ips: advert.ips }), 'utf8')
    sock.send(answer, rinfo.port, rinfo.address, () => {})
  })
  sock.bind(SYNC_BEACON_PORT, () => {
    try {
      sock.setBroadcast(true)
    } catch {
      /* 个别平台默认可广播 */
    }
  })
  beacon = sock
}

export function stopSyncBeacon(): void {
  if (!beacon) return
  const sock = beacon
  beacon = null
  try {
    sock.close()
  } catch {
    /* 已关闭 */
  }
}

/** 搜寻附近的 ModelDock 电脑：向 255.255.255.255 + 各接口子网广播 + 127.0.0.1 发查询，
 *  收集 timeoutMs 内的应答（按 主机名:端口 归组；可排除自己）。失败/超时返回已收集的部分。 */
export function discoverPeers(opts?: {
  timeoutMs?: number
  exclude?: { name: string; port?: number }
}): Promise<NearbyPeer[]> {
  const timeoutMs = Math.min(Math.max(opts?.timeoutMs ?? 1500, 300), 5000)
  return new Promise((resolve) => {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true })
    const found = new Map<string, NearbyPeer>()
    const finish = (): void => {
      clearTimeout(timer)
      try {
        sock.close()
      } catch {
        /* 已关闭 */
      }
      resolve([...found.values()])
    }
    const timer = setTimeout(finish, timeoutMs)
    sock.on('error', finish)
    sock.on('message', (msg, rinfo) => {
      if (msg.slice(0, MAGIC_A.length).toString('utf8') !== MAGIC_A) return
      try {
        const payload = JSON.parse(msg.slice(MAGIC_A.length).toString('utf8')) as { name?: string; port?: number; ips?: unknown }
        if (typeof payload.port !== 'number' || payload.port <= 0) return
        const name = payload.name ?? ''
        // 可达地址以对方自广告为准；应答包源地址只作旧版应答兜底
        const ips = Array.isArray(payload.ips) ? payload.ips.filter((x): x is string => typeof x === 'string' && x !== '') : []
        if (!ips.length) ips.push(rinfo.address)
        const key = `${name}:${payload.port}`
        if (opts?.exclude && name === opts.exclude.name && payload.port === opts.exclude.port) return
        const hit = found.get(key)
        if (hit) {
          for (const ip of ips) if (!hit.ips.includes(ip)) hit.ips.push(ip)
        } else {
          found.set(key, { ips, port: payload.port, name })
        }
      } catch {
        /* 坏包忽略 */
      }
    })
    sock.bind(() => {
      try {
        sock.setBroadcast(true)
      } catch {
        /* ignore */
      }
      const query = Buffer.from(MAGIC_Q + '{}', 'utf8')
      for (const target of ['255.255.255.255', '127.0.0.1', ...subnetBroadcasts()]) {
        sock.send(query, SYNC_BEACON_PORT, target, () => {})
      }
    })
  })
}

/** 各 IPv4 接口的子网定向广播地址（x.y.z.255，按 /24 近似；跨子网靠 255.255.255.255 与链接兜底） */
function subnetBroadcasts(): string[] {
  const out: string[] = []
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list ?? []) {
      if (i.internal || i.family !== 'IPv4') continue
      const parts = i.address.split('.')
      if (parts.length !== 4) continue
      const b = `${parts[0]}.${parts[1]}.${parts[2]}.255`
      if (!out.includes(b)) out.push(b)
    }
  }
  return out
}
