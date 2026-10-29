import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { fakeHome } from './helpers.js'
import { loadConfig, saveConfig } from '../src/config/store.js'
import { buildRuntime } from '../src/gateway/state.js'
import { detectDefaultRouteAddress, buildLanStatus, lanAddresses, lanAuthorized, lanPrimaryUrl, lanQrSvg, putSyncRequest, rankLanAddresses, resolveLanToken, startLanServer, stopLan, sweepRequestRateByIp } from '../src/gateway/lan.js'
import { ensureDir } from '../src/util/fsx.js'
import { modeldockDir } from '../src/util/paths.js'
import type { Config } from '../src/config/types.js'

process.env.MODELRDOCK_DISABLE_HOLIDAY_FETCH = '1'
process.env.MODELRDOCK_DISABLE_CATALOG_FETCH = '1'

function twoServiceConfig(): Config {
  return {
    version: 1,
    providers: {
      p1: {
        name: '服务一',
        base_url: 'http://10.0.0.99/api/anthropic',
        protocol: 'anthropic',
        auth_style: 'bearer',
        // 明文 key（types.ts 允许的形态）：专门用来断言 LAN 载荷不泄漏
        key_ref: 'sk-secret-must-not-leak',
        models: {
          'model-one': { source: 'preset', display_name: '模型一', context_window: 128000, max_output: 8192 },
          'model-two': { source: 'preset' },
        },
      },
      p2: {
        name: '服务二',
        base_url: 'http://10.0.0.98/api/anthropic',
        protocol: 'anthropic',
        auth_style: 'bearer',
        key_ref: 'file:k2',
        models: { 'model-three': { source: 'preset' } },
      },
    },
    profiles: {
      'auto-p1': { provider: 'p1', default_model: 'model-one' },
      'auto-p2': { provider: 'p2' },
    },
    active_profile: 'auto-p1',
    harness: {},
  }
}

describe('lan 手机简版控制台', () => {
  let h: ReturnType<typeof fakeHome>
  beforeEach(() => {
    h = fakeHome()
  })
  afterEach(() => {
    h.restore()
  })

  async function start(token = 'mdklan_' + 'a'.repeat(32)) {
    await ensureDir(modeldockDir())
    await saveConfig(twoServiceConfig())
    const rt = buildRuntime(await loadConfig(), 'mdkadm_test')
    const handle = await startLanServer(rt, { port: 0, token, host: '127.0.0.1' })
    return { rt, handle, base: `http://127.0.0.1:${handle.port}`, token }
  }

  it('未带令牌：API 与页面一律拒绝', async () => {
    const { base } = await start()
    const state = await fetch(`${base}/m/api/state`)
    expect(state.status).toBe(403)
    const page = await fetch(`${base}/m`)
    expect(page.status).toBe(403)
    const pageText = await page.text()
    expect(pageText).toContain('二维码')
    expect(pageText).toContain('QR code')
  })

  it('扫码首访 ?token= 种 HttpOnly cookie 且带令牌原地伺服页面（不剥令牌，供跨浏览器/主屏交接）', async () => {
    const { base, token, handle } = await start()
    // 令牌必须留在 URL：微信「在浏览器中打开」/添加主屏只携带地址栏 URL，
    // 若 302 剥令牌，交接后的新浏览器（无 cookie）会 403
    const first = await fetch(`${base}/m?token=${token}`, { redirect: 'manual' })
    expect(first.status).toBe(200)
    expect(first.headers.get('location')).toBeNull()
    const setCookie = first.headers.get('set-cookie') ?? ''
    // cookie 名内嵌端口号：同机双实例固定名会互顶手机端会话（RFC 6265 无端口隔离）
    expect(setCookie).toContain(`mdk_lan_${handle.port}=`)
    expect(setCookie).toContain('HttpOnly')
    const html = await first.text()
    expect(html).toContain('data-i18n="路由||Routing"')
    // 手机页「下一个切换」自动选项与桌面同款：没得切时写明「无备用服务」
    expect(html).toContain('自动 · 无备用服务')
    // 无令牌且无 cookie 的干净地址仍拒绝（错误交接路径的兜底不变）
    const bare = await fetch(`${base}/m`)
    expect(bare.status).toBe(403)
  })

  it('state 载荷含服务与模型，但绝不含 base_url 与 key 明文', async () => {
    const { base, token } = await start()
    const res = await fetch(`${base}/m/api/state`, { headers: { authorization: `Bearer ${token}` } })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.hostname).toBeTruthy()
    expect(body.active.name).toBe('服务一')
    expect(body.active.default_model).toBe('model-one')
    expect(body.active.models).toHaveLength(2)
    expect(body.services).toHaveLength(2)
    expect(body.services[0].models[0].name).toBe('模型一')
    expect(body.services[0].enabled).toBe(true)
    // route 与桌面路由控件同源：未钉定时生效路由 = active_profile 主服务
    expect(body.route.on).toBe(false)
    expect(body.route.forced).toBeNull()
    expect(body.route.failover429).toBe(false)
    expect(body.route.autoFallback).toBe(true) // 自动备用链缺省开：没配手动链也会自动补切换候选
    expect(body.route.provider).toBe('p1')
    expect(body.route.label).toBe('服务一')
    expect(body.route.model).toBe('model-one')
    expect(body.route.autoPrimaryLabel).toBe('服务一')
    expect(body.route.routeNext).toBeNull()
    expect(body.route.next).toBe('p2') // 自动备用链：没配手动链，下一个切换=自动链首个（另一服务）
    expect(body.route.autoNextLabel).toBe('服务二')
    expect(body.route.schedule.windows).toEqual([])
    const raw = JSON.stringify(body)
    expect(raw).not.toContain('sk-secret-must-not-leak')
    expect(raw).not.toContain('10.0.0.99')
    expect(raw).not.toContain('key_ref')
  })

  it('state route 反映自动路由：钉定/限流切换/定时时段如实透出，钉定压过窗口', async () => {
    await ensureDir(modeldockDir())
    const cfg = twoServiceConfig()
    // 窗口全天指向 p1、钉定 p2：窗口命中与否两分支下 autoPrimary 都是 p1（窗口目标=默认路由），断言不随测试时刻漂移
    cfg.gateway = {
      auto_failover: true,
      auto_route_provider: 'p2',
      failover_status_codes: [429, 503],
      schedule: { windows: [{ start: '00:00', end: '23:59', target: 'p1' }] },
    }
    await saveConfig(cfg)
    const rt = buildRuntime(await loadConfig(), 'mdkadm_test')
    const handle = await startLanServer(rt, { port: 0, token: 'mdklan_' + 'a'.repeat(32), host: '127.0.0.1' })
    try {
      const res = await fetch(`http://127.0.0.1:${handle.port}/m/api/state`, { headers: { authorization: `Bearer ${handle.token}` } })
      const body = await res.json()
      expect(body.route.on).toBe(true)
      expect(body.route.forced).toBe('p2')
      expect(body.route.failover429).toBe(true)
      expect(body.route.provider).toBe('p2') // 人工钉定压过定时窗口
      expect(body.route.label).toBe('服务二')
      // 模型随生效服务走：钉定 p2（profile auto-p2 无 default_model → 回落 p2 首个模型 model-three），
      // 与转发改写同源（旧实现取 active_profile 的 model-one，会和实际发往 p2 的模型对不上）
      expect(body.route.model).toBe('model-three')
      expect(body.route.source).toBe('pinned')
      expect(body.route.schedule.applied).toBe(false)
      expect(body.route.schedule.suppressedBy).toBe('pin')
      // 双槽位显示字段：自动态会选的主服务（「自动 · X」的 X）与下一个切换
      expect(body.route.autoPrimaryLabel).toBe('服务一')
      expect(body.route.routeNext).toBeNull()
      expect(body.route.next).toBe('p1') // 钉定主服务后默认路由排候选链末尾兜底=下一个切换
      expect(body.route.nextLabel).toBe('服务一')
      // 自动标签保留主服务钉定（只清本槽钉定）：真会切到的就是链尾兜底的服务一。
      // 若按「忽略全部钉定」算会得到 null，手机与桌面只能显示光秃秃的「自动」
      expect(body.route.autoNextLabel).toBe('服务一')
      expect(body.route.schedule.windows).toEqual([
        { start: '00:00', end: '23:59', target: 'p1', mode: 'prefer', dayFilter: null, days: null },
      ])
    } finally {
      stopLan(rt)
    }
  })

  it('state「使用中」与 route 同源：窗口接管时服务卡徽标切到窗口目标，默认路由保持', async () => {
    await ensureDir(modeldockDir())
    const cfg = twoServiceConfig()
    cfg.gateway = { auto_failover: true, schedule: { enabled: true, windows: [{ start: '00:00', end: '23:59', target: 'p2' }] } }
    await saveConfig(cfg)
    const rt = buildRuntime(await loadConfig(), 'mdkadm_test')
    const handle = await startLanServer(rt, { port: 0, token: 'mdklan_' + 'a'.repeat(32), host: '127.0.0.1' })
    try {
      const res = await fetch(`http://127.0.0.1:${handle.port}/m/api/state`, { headers: { authorization: `Bearer ${handle.token}` } })
      const body: any = await res.json()
      expect(body.route.provider).toBe('p2')
      expect(body.route.model).toBe('model-three')
      expect(body.route.source).toBe('schedule')
      expect(body.route.schedule.applied).toBe(true)
      // 服务卡「使用中」= 全局生效（窗口目标），不再跟着 active_profile（p1）走
      expect(body.services.find((s: any) => s.id === 'p2').active).toBe(true)
      expect(body.services.find((s: any) => s.id === 'p1').active).toBe(false)
      // 默认路由（active_profile）仍作为独立信息保留
      expect(body.active.service).toBe('p1')
    } finally {
      stopLan(rt)
    }
  })

  it('state route.model：时段带模型改写时改写值优先', async () => {
    await ensureDir(modeldockDir())
    const cfg = twoServiceConfig()
    // active_profile 指向 p2（无 default_model，回落 p2 首个模型 model-three）：
    // 窗口命中（改写模型 model-three）与未命中（回落 active profile 首个模型）两分支结果一致，断言不随测试时刻漂移
    cfg.active_profile = 'auto-p2'
    cfg.gateway = {
      auto_failover: true,
      schedule: { windows: [{ start: '00:00', end: '23:59', target: 'p2:model-three' }] },
    }
    await saveConfig(cfg)
    const rt = buildRuntime(await loadConfig(), 'mdkadm_test')
    const handle = await startLanServer(rt, { port: 0, token: 'mdklan_' + 'a'.repeat(32), host: '127.0.0.1' })
    try {
      const res = await fetch(`http://127.0.0.1:${handle.port}/m/api/state`, { headers: { authorization: `Bearer ${handle.token}` } })
      const body = await res.json()
      expect(body.route.provider).toBe('p2')
      expect(body.route.model).toBe('model-three')
    } finally {
      stopLan(rt)
    }
  })

  it('auto-route 端点：开关与强制服务商部分更新、校验与审计', async () => {
    const { base, rt, token } = await start()
    const post = async (body: string, withToken = true): Promise<Response> =>
      fetch(`${base}/m/api/auto-route`, {
        method: 'POST',
        headers: withToken ? { authorization: `Bearer ${token}`, 'content-type': 'application/json' } : { 'content-type': 'application/json' },
        body,
      })
    // 无令牌拒绝、坏 JSON 拒绝
    expect((await post(JSON.stringify({ enabled: true }), false)).status).toBe(403)
    expect((await post('not-json')).status).toBe(400)
    // 开启：写 auto_failover；enabled 缺省=保持现状
    const on = await (await post(JSON.stringify({ enabled: true }))).json()
    expect(on).toMatchObject({ ok: true, enabled: true, provider: null })
    expect(rt.config.gateway?.auto_failover).toBe(true)
    // 设强制服务商：只带 provider 字段（enabled 保持）
    const forced = await (await post(JSON.stringify({ provider: 'p2' }))).json()
    expect(forced).toMatchObject({ ok: true, enabled: true, provider: 'p2' })
    expect(rt.config.gateway?.auto_route_provider).toBe('p2')
    // 未知服务拒绝
    expect((await post(JSON.stringify({ provider: 'nope' }))).status).toBe(400)
    // 清除强制=恢复自动
    const cleared = await (await post(JSON.stringify({ provider: null }))).json()
    expect(cleared).toMatchObject({ ok: true, provider: null })
    expect(rt.config.gateway?.auto_route_provider).toBeUndefined()
    // 关闭
    const off = await (await post(JSON.stringify({ enabled: false }))).json()
    expect(off).toMatchObject({ ok: true, enabled: false })
    expect(rt.config.gateway?.auto_failover).toBe(false)
    // 审计：环形缓冲含 source=lan 条目
    const auditEntry = rt.ring.find((e) => e.kind === 'audit' && e.op === '手机自动路由')
    expect(auditEntry).toBeTruthy()
  })

  it('LAN 切换：写 active_profile、热加载、审计记 source=lan；未知服务报错', async () => {
    const { base, rt, token } = await start()
    const ok = await fetch(`${base}/m/api/switch`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ service: 'p2' }),
    })
    expect(ok.status).toBe(200)
    const cfg = await loadConfig()
    expect(cfg.active_profile).toBe('auto-p2')
    expect(rt.config.active_profile).toBe('auto-p2')
    expect(rt.config.active_profile).not.toBe('auto-p1')
    const auditEntry = rt.ring.find((e) => e.kind === 'audit' && e.op === '手机切换服务')
    expect(auditEntry).toBeTruthy()
    const bad = await fetch(`${base}/m/api/switch`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ service: 'nope' }),
    })
    expect(bad.status).toBe(400)
  })

  it('端口被占自动 +1 顺延（首台 listen(0) 取实际端口，第二台复用同端口）', async () => {
    await ensureDir(modeldockDir())
    await saveConfig(twoServiceConfig())
    // 两个独立 runtime：startLanServer 会先停掉同一 rt 上的旧监听器，顺延场景必须两台并存
    const rt1 = buildRuntime(await loadConfig(), 'mdkadm_test1')
    const rt2 = buildRuntime(await loadConfig(), 'mdkadm_test2')
    const first = await startLanServer(rt1, { port: 0, token: 'mdklan_' + 'a'.repeat(32), host: '127.0.0.1' })
    try {
      const second = await startLanServer(rt2, { port: first.port, token: 'mdklan_' + 'b'.repeat(32), host: '127.0.0.1' })
      expect(second.port).toBe(first.port + 1)
    } finally {
      stopLan(rt1)
      stopLan(rt2)
    }
  })

  it('令牌跨重启稳定：合法旧值复用，非法值重新生成', () => {
    const ok = resolveLanToken('mdklan_' + 'c'.repeat(32))
    expect(ok).toBe('mdklan_' + 'c'.repeat(32))
    const fresh = resolveLanToken('garbage')
    expect(fresh.startsWith('mdklan_')).toBe(true)
    expect(fresh).not.toBe('garbage')
  })

  it('lan 配置段经 save/load 往返保留（migrate 不得剥离新顶层字段）', async () => {
    await ensureDir(modeldockDir())
    const cfg = twoServiceConfig()
    cfg.lan = { enabled: true, port: 8787 }
    await saveConfig(cfg)
    const loaded = await loadConfig()
    expect(loaded.lan).toEqual({ enabled: true, port: 8787 })
  })

  it('lanAddresses 返回字符串数组；QR 生成 SVG', () => {
    expect(Array.isArray(lanAddresses())).toBe(true)
    const svg = lanQrSvg('http://192.168.1.5:8787/m?token=x')
    expect(svg).toContain('<svg')
    expect(svg).toContain('</svg>')
  })
})

describe('requestRateByIp 限频表清扫', () => {
  it('写入超过上限的过期键后，新写入触发清扫、Map 尺寸收敛（254 个过期 IP 不会永久驻留）', () => {
    // 模拟 LAN 扫一遍碾过 254 个 IP，清理发生在 10s 后：每个留下的记录都超出了限频窗口（全为过期键）
    const map = new Map<string, number>()
    const base = 1_000_000_000_000
    for (let i = 0; i < 254; i++) map.set(`10.0.0.${i}`, base) // 上次请求已在窗口之前
    map.set('fresh', base + 9_000) // 9s 前请求，仍在 10s 窗口内的活跃条目
    expect(map.size).toBe(255)

    // putSyncRequest 写入时先清扫：254 条过期键被移除，Map 收敛到仍在限频窗口内的条目
    sweepRequestRateByIp(base + 10_000, map)
    expect(map.size).toBe(1)
    expect(map.has('fresh')).toBe(true)
    expect(map.has('10.0.0.0')).toBe(false)
    expect(map.has('10.0.0.253')).toBe(false)

    // 不传 windowMs 默认 10s，与实际限频窗口一致（过期=距上次 ≥ 10s，新请求本就不会被它限流）
    sweepRequestRateByIp(base + 100_000, map)
    expect(map.size).toBe(0)
  })

  it('putSyncRequest 接线清扫后限流体征不变：同 IP 10s 内重复敲门被拒，不同 IP 各自独立', () => {
    putSyncRequest('n1', 'host-a', '192.168.1.10')
    expect(() => putSyncRequest('n2', 'host-a', '192.168.1.10')).toThrow()
    putSyncRequest('n3', 'host-b', '192.168.1.11') // 另一 IP 不受影响
  })
})

// 二维码指向哪块网卡：Windows 上 Hyper-V/WSL/VMware/VirtualBox 等虚拟网卡常被系统枚举在物理网卡之前，
// 取首个非回环地址会把手机引向连不上的地址（macOS 一般只有一块物理网卡，暴露不出来）
describe('lan 局域网地址优选', () => {
  it('物理网卡排在虚拟网卡之前（系统枚举顺序反过来也一样）', () => {
    const got = rankLanAddresses([
      { iface: 'vEthernet (WSL (Hyper-V firewall))', address: '172.28.96.1' },
      { iface: 'Ethernet', address: '192.168.1.7' },
    ])
    expect(got).toEqual(['192.168.1.7', '172.28.96.1'])
  })

  it('系统默认出口地址优先于同权重网卡', () => {
    const list = [
      { iface: 'Ethernet', address: '192.168.1.7' },
      { iface: 'Wi-Fi', address: '10.0.0.5' },
    ]
    expect(rankLanAddresses(list, '10.0.0.5')[0]).toBe('10.0.0.5')
    expect(rankLanAddresses(list, '192.168.1.7')[0]).toBe('192.168.1.7')
  })

  it('虚拟网卡即便就是系统默认出口（VPN / Clash TUN 接管默认路由）也不抢主地址', () => {
    const list = [
      { iface: 'Mihomo', address: '198.18.0.1' },
      { iface: 'Wi-Fi', address: '192.168.1.7' },
    ]
    expect(rankLanAddresses(list, '198.18.0.1')[0]).toBe('192.168.1.7')
  })

  it('隧道网段按地址兜底降权（网卡名认不出来时）；VirtualBox 宿主网卡同样垫后', () => {
    const got = rankLanAddresses([
      { iface: 'eth0.100', address: '198.18.0.1' },
      { iface: 'VirtualBox Host-Only Network', address: '192.168.56.1' },
      { iface: '以太网', address: '192.168.1.7' },
    ])
    expect(got[0]).toBe('192.168.1.7')
  })

  it('169.254 自分配地址（没拿到 DHCP）垫底但不剔除；地址去重；同权重保持枚举顺序', () => {
    const got = rankLanAddresses([
      { iface: 'Ethernet', address: '169.254.13.9' },
      { iface: 'Wi-Fi', address: '192.168.1.7' },
      { iface: 'Ethernet 2', address: '192.168.1.7' },
    ])
    expect(got).toEqual(['192.168.1.7', '169.254.13.9'])
  })

  it('检测系统默认出口地址不抛错（离线时返回 null），主地址 URL 与端口一致', async () => {
    const preferred = await detectDefaultRouteAddress()
    if (preferred !== null) expect(preferred).toMatch(/^\d{1,3}(\.\d{1,3}){3}$/)
    const url = lanPrimaryUrl(8787)
    if (url !== null) expect(url).toMatch(/^http:\/\/\d{1,3}(\.\d{1,3}){3}:8787\/m$/)
  })
})

describe('lan 鉴权与广告口径（2026-10-30 评测集审出）', () => {
  // lanAuthorized 直测：LAN 关闭（rt.lan=undefined）/令牌为空一律拒绝——
  // 旧实现 `token ?? ''` 让空串对空串通过 safeEqual 的常数时间比较，等于无凭据放行
  const reqWith = (headers: Record<string, string>) => ({ headers }) as unknown as import('node:http').IncomingMessage

  it('LAN 关闭（rt.lan=undefined）时 Bearer 一律拒绝（含空 Bearer）', () => {
    const rt = { lan: undefined } as any
    expect(lanAuthorized(reqWith({ authorization: 'Bearer ' }), rt)).toBe(false)
    expect(lanAuthorized(reqWith({ authorization: 'Bearer whatever' }), rt)).toBe(false)
    expect(lanAuthorized(reqWith({}), rt)).toBe(false)
  })

  it('令牌为空串时一律拒绝（即便请求也带空凭据）', () => {
    const rt = { lan: { server: {}, port: 18999, token: '', host: '0.0.0.0' } } as any
    expect(lanAuthorized(reqWith({ authorization: 'Bearer ' }), rt)).toBe(false)
    expect(lanAuthorized(reqWith({ cookie: `mdk_lan_18999=` }), rt)).toBe(false)
  })

  it('正常令牌：Bearer 与 cookie 两通道仍放行，错令牌拒绝', () => {
    const rt = { lan: { server: {}, port: 18999, token: 'tok123', host: '0.0.0.0' } } as any
    expect(lanAuthorized(reqWith({ authorization: 'Bearer tok123' }), rt)).toBe(true)
    expect(lanAuthorized(reqWith({ authorization: 'Bearer wrong' }), rt)).toBe(false)
    expect(lanAuthorized(reqWith({ cookie: 'mdk_lan_18999=tok123' }), rt)).toBe(true)
    expect(lanAuthorized(reqWith({}), rt)).toBe(false)
  })

  it('stopLan 会断光 keep-alive 连接（closeAllConnections），不只是停新连接', () => {
    const calls: string[] = []
    const fakeServer = {
      close: () => {
        calls.push('close')
        return fakeServer
      },
      closeAllConnections: () => calls.push('closeAllConnections'),
    } as any
    const rt = { config: {} as Config, lan: { server: fakeServer, port: 18999, token: 't', host: '0.0.0.0' } } as any
    stopLan(rt)
    expect(calls).toEqual(['close', 'closeAllConnections'])
    expect(rt.lan).toBeUndefined()
  })

  it('buildLanStatus 尊重绑定 host：只列可达地址（不列全部网卡）', () => {
    const rt = { config: { lan: { enabled: true, port: 45678 } } as Config, lan: { server: {}, port: 45678, token: 't', host: '127.0.0.1' } } as any
    const st = buildLanStatus(rt)
    expect(st.enabled).toBe(true)
    expect(st.urls).toEqual(['http://127.0.0.1:45678/m'])
    expect(st.qrcode).toBeTruthy()
  })

  it('buildLanStatus 默认 0.0.0.0 仍列全部网卡地址（原口径不回退）', () => {
    const rt = { config: { lan: { enabled: true, port: 45678 } } as Config, lan: { server: {}, port: 45678, token: 't', host: '0.0.0.0' } } as any
    const st = buildLanStatus(rt)
    expect(st.urls.length).toBeGreaterThan(0)
    expect(st.urls.every((u) => u.startsWith('http://') && u.endsWith(':45678/m'))).toBe(true)
  })
})
