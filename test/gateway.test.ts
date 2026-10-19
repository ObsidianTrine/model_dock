import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import http from 'node:http'
import zlib from 'node:zlib'
import fs from 'node:fs'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { fakeHome } from './helpers.js'
import { activeAvoidTargets, activeScheduleWindow, autoRouteInfo, buildRuntime, displayRouteProvider, isMeltdown, parseFallbackEntry, pickTarget, readGatewayState, recordOutcome, resolveTarget, routeState, writeGatewayState, type ResolvedTarget } from '../src/gateway/state.js'
import { createGatewayServer, OVERVIEW_TTL_MS, overviewCacheHit } from '../src/gateway/server.js'
import { clientProtocolFromPath, endpointRisks } from '../src/gateway/relay.js'
import { consoleBanner, resolveAdminToken } from '../src/gateway/main.js'
import type { Config } from '../src/config/types.js'
import { saveConfig } from '../src/config/store.js'
import { getSecret } from '../src/config/secrets.js'
import { configPath, gatewayStatePath, holidaysCachePath, logsDir } from '../src/util/paths.js'
import { parse as tomlParse } from 'smol-toml'
import { findPreset, presetModels } from '../src/presets/data.js'

// autostart 是唯一改系统层状态（不写 config.toml）的网关端点依赖：mock 成纯内存开关，
// 让 overview 即时性回归测试可跨平台跑（真实 install 在 Linux/Windows CI 会触碰
// systemctl / 真实启动文件夹）。本文件其他用例不依赖 autostart 模块行为。
// spread importOriginal 保留纯函数（gatewayDaemonArgs/updateDaemonArgs 等）——
// isolate:false 共享模块注册表下整模块替换会击穿其他文件经 webupdate 等新链路的静态绑定。
vi.mock('../src/autostart.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/autostart.js')>()
  let installed = false
  return {
    ...original,
    autostartOverview: () => ({ installed, kind: 'launchd' as const }),
    installAutostart: async () => {
      installed = true
      return { kind: 'launchd' as const, file: '/fake/com.modeldock.gateway.plist', argv: ['modeldock', '--sea-gateway'], started: false }
    },
    uninstallAutostart: async () => {
      const was = installed
      installed = false
      return { removed: '/fake/com.modeldock.gateway.plist', wasInstalled: was }
    },
  }
})

// 桌面客户端（workbuddy / zcode / mimo-desktop）的 presence 探测在 Windows 上要跑
// reg /s /f 全树注册表扫描（每个应用最多 3 个视图 × 8s 超时），overview 等聚合端点会
// 逐客户端调 status，把用例拖到 CI 超时。本文件统一强制按「未安装」判定跳过 reg 子进程；
// 需要在场的用例（如 zcode 接入）自行在用例内覆盖为 '1'。不断言 installed 的用例不受影响。
const DESKTOP_PRESENCE_IDS = ['workbuddy', 'zcode', 'mimo-desktop']
beforeEach(() => {
  for (const id of DESKTOP_PRESENCE_IDS) {
    process.env[`MODELRDOCK_FAKE_${id.toUpperCase().replace(/-/g, '_')}_PRESENT`] = '0'
  }
})
afterEach(() => {
  for (const id of DESKTOP_PRESENCE_IDS) {
    delete process.env[`MODELRDOCK_FAKE_${id.toUpperCase().replace(/-/g, '_')}_PRESENT`]
  }
})

// schedule 端点保存成功后会后台拉取节假日日历（外网 holiday-cn），
// 测试环境一律禁用：不发真实网络请求（外网拉取竞态 2026-10-01 实测踩中）。
process.env.MODELRDOCK_DISABLE_HOLIDAY_FETCH = '1'
// 模型目录（models.dev）同理禁用：网关启动定时器 / 目录端点不得触发出站请求
process.env.MODELRDOCK_DISABLE_CATALOG_FETCH = '1'

interface CapturedRequest {
  url: string
  authorization?: string
  xApiKey?: string
  anthropicVersion?: string
  cookie?: string
  modeldockAdmin?: string
  body?: string
}

function startMockUpstream(): Promise<{ port: number; requests: CapturedRequest[]; close: () => void }> {
  const requests: CapturedRequest[] = []
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      requests.push({
        url: req.url ?? '',
        authorization: req.headers.authorization as string | undefined,
        xApiKey: req.headers['x-api-key'] as string | undefined,
        anthropicVersion: req.headers['anthropic-version'] as string | undefined,
        cookie: req.headers.cookie as string | undefined,
        modeldockAdmin: req.headers['x-modeldock-admin'] as string | undefined,
        body,
      })
      if (req.url === '/v1/messages') {
        // 压缩错误体：火山方舟等上游对 4xx 回 gzip 体（真实事故 2026-10-15：dsh 只看到乱码报错）
        if (body.includes('gzip-err-model')) {
          const payload = Buffer.from(
            JSON.stringify({ error: { type: 'BadRequest', code: 'InvalidParameter', message: 'thinking.type `disabled` is not supported by this model' } }),
            'utf8'
          )
          res.writeHead(400, { 'content-type': 'application/json', 'content-encoding': 'gzip' })
          res.end(zlib.gzipSync(payload))
          return
        }
        if (body.includes('gzip-429-model')) {
          const payload = Buffer.from(JSON.stringify({ error: { message: 'rate limited, slow down' } }), 'utf8')
          res.writeHead(429, { 'content-type': 'application/json', 'content-encoding': 'gzip' })
          res.end(zlib.gzipSync(payload))
          return
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write('event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":100,"cache_read_input_tokens":20,"cache_creation_input_tokens":5}}}\n\n')
        res.write('event: content_block_delta\ndata: {"type":"content_block_delta"}\n\n')
        res.write('event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":42}}\n\n')
        res.end('event: message_stop\ndata: {"type":"message_stop"}\n\n')
        return
      }
      if (req.url === '/v1/chat/completions') {
        const j = JSON.parse(body || '{}')
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            choices: [{ message: { role: 'assistant', content: `echo:${j.model}` } }],
            usage: { prompt_tokens: 3, completion_tokens: 4 },
          })
        )
        return
      }
      if (req.url === '/unauth') {
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'invalid api key' } }))
        return
      }
      if (req.url === '/boom') {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'context length exceeded' } }))
        return
      }
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'model not found: nope' } }))
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port
      resolve({
        port,
        requests,
        close: () => {
          // keep-alive 连接不随 close() 退出，主动踢掉让句柄即刻收敛
          server.closeAllConnections?.()
          server.close()
        },
      })
    })
  })
}

function listenEphemeral(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port))
  })
}

const TOKEN = 'mdk_harness_token_abcdef'

async function setup(opts?: { upPath?: string; protocol?: 'anthropic' | 'openai' }): Promise<{
  gwPort: number
  requests: CapturedRequest[]
  rt: ReturnType<typeof buildRuntime>
  closeAll: () => void
}> {
  const h = fakeHome()
  const up = await startMockUpstream()
  const base = `http://127.0.0.1:${up.port}`
  const cfg: Config = {
    version: 1,
    active_profile: 'demo',
    security: { store: 'file' }, // 测试固定用 file 存储，避免受系统默认(keychain 等)影响
    providers: {
      up: {
        name: 'mock',
        base_url: base,
        protocol: opts?.protocol ?? 'anthropic',
        auth_style: 'bearer',
        key_ref: 'sk-upstream-secret',
        models: { 'preset-model': { source: 'preset', context_window: 1000, max_output: 100 } },
      },
    },
    profiles: {
      demo: {
        provider: 'up',
        default_model: 'preset-model',
        aliases: { 'claude-sonnet-*': 'ds-flash-target' },
      },
      other: { provider: 'up', default_model: 'other-model' },
    },
    harness: {
      'claude-code': { mode: 'gateway', route: 'default', token: TOKEN },
    },
  }
  await saveConfig(cfg)
  const rt = buildRuntime(cfg, 'admin-token-x')
  const server = createGatewayServer(rt, { port: 0 })
  const gwPort = await listenEphemeral(server)
  return {
    gwPort,
    requests: up.requests,
    rt,
    closeAll: () => {
      // 网关侧同样踢掉 keep-alive；restore 内部对异步日志落盘的竞态有重试兜底
      server.closeAllConnections?.()
      server.close()
      up.close()
      h.restore()
    },
  }
}

describe('admin token 持久化', () => {
  it('consoleBanner：TTY 输出带 token 的登录地址；重定向时降级不落 token', () => {
    const token = 'mdkadm_' + 'b'.repeat(40)
    // 交互终端：带 token，点开即种 cookie
    const tty = consoleBanner(8687, token, true)
    expect(tty).toContain(`?token=${token}`)
    // 重定向（>log、nohup、systemd）：不落 token，提示 modeldock ui
    const piped = consoleBanner(8687, token, false)
    expect(piped).not.toContain(token)
    expect(piped).toContain('modeldock ui')
    expect(piped).toContain('/_modeldock/ui')
  })

  it('合法旧令牌跨重启复用；缺失/损坏时新生成合法令牌', () => {
    const old = 'mdkadm_' + 'a'.repeat(40)
    expect(resolveAdminToken(old)).toBe(old) // 复用 → 浏览器 cookie 继续有效
    // 空 / 太短 / 前缀错 / 非十六进制：一律不带进运行时
    for (const bad of [undefined, null, '', 'mdkadm_short', 'mdfadm_' + 'a'.repeat(40), 'mdkadm_' + 'g'.repeat(40)]) {
      const next = resolveAdminToken(bad as any)
      expect(next).toMatch(/^mdkadm_[0-9a-f]{32,}$/)
      expect(next).not.toBe(bad)
    }
  })

  it('admin/rotate：未鉴权 401；轮换后旧令牌立即失效、新令牌可用', async () => {
    const t = await setup()
    try {
      const rotateUrl = `http://127.0.0.1:${t.gwPort}/_modeldock/admin/rotate`
      expect((await fetch(rotateUrl, { method: 'POST' })).status).toBe(401)

      const res = await fetch(rotateUrl, { method: 'POST', headers: { 'x-modeldock-admin': 'admin-token-x' } })
      expect(res.status).toBe(200)
      const j: any = await res.json()
      expect(j.admin_token).toMatch(/^mdkadm_[0-9a-f]+$/)
      expect(j.admin_token).not.toBe('admin-token-x')
      expect(j.console_url).toContain('/_modeldock/ui?token=' + j.admin_token)

      const statusUrl = `http://127.0.0.1:${t.gwPort}/_modeldock/status`
      expect((await fetch(statusUrl, { headers: { 'x-modeldock-admin': 'admin-token-x' } })).status).toBe(401) // 旧令牌失效
      expect((await fetch(statusUrl, { headers: { 'x-modeldock-admin': j.admin_token } })).status).toBe(200) // 新令牌可用
    } finally {
      t.closeAll()
    }
  })
})

describe('autostart 与 overview 缓存', () => {
  it('overview 缓存命中逻辑：TTL 内二次请求命中（重建只跑一次），TTL 过期与键变化即失效', () => {
    const fakeRt = {} as any
    const cached = { at: 1_000, rt: fakeRt, reloads: 0, lang: 'zh', data: {} }
    // TTL 内命中；恰好达边界（now - at === TTL）即失效
    expect(overviewCacheHit(cached, fakeRt, 0, 'zh', 1_000 + OVERVIEW_TTL_MS - 1)).toBe(true)
    expect(overviewCacheHit(cached, fakeRt, 0, 'zh', 1_000 + OVERVIEW_TTL_MS)).toBe(false)
    // runtime 实例 / 配置重载代数 / 请求语言任一变化，即使未过 TTL 也失效（回灌新状态/异语言不拿旧缓存）
    expect(overviewCacheHit(cached, { ...fakeRt, n: 1 } as any, 0, 'zh', 1_000 + 100)).toBe(false)
    expect(overviewCacheHit(cached, fakeRt, 1, 'zh', 1_000 + 100)).toBe(false)
    expect(overviewCacheHit(cached, fakeRt, 0, 'en', 1_000 + 100)).toBe(false)
    // BUG-04 根因回归：TTL 必须大于 UI 轮询间隔（5000ms），否则缓存在下一次轮询前必过期、永不命中
    expect(OVERVIEW_TTL_MS).toBeGreaterThan(5_000)
  })

  it('TTL 内二次 GET /overview 命中缓存：响应体完全一致', async () => {
    const t = await setup()
    try {
      const H = { 'x-modeldock-admin': 'admin-token-x' }
      const url = `http://127.0.0.1:${t.gwPort}/_modeldock/overview`
      // 两次连续请求间隔远小于 6s TTL：第二次应命中缓存，响应体逐字节一致（且仅重建一次）
      const b1 = await (await fetch(url, { headers: H })).text()
      const b2 = await (await fetch(url, { headers: H })).text()
      expect(JSON.parse(b1).ok).toBe(true)
      expect(b2).toBe(b1)
      // 语言不同不互借缓存：请求级语言不一致返回的响应也应各自完整（非缓存语义断言，仅防回归）
      const en = await (await fetch(url, { headers: { ...H, 'x-modeldock-lang': 'en' } })).json()
      expect(en.ok).toBe(true)
    } finally {
      t.closeAll()
    }
  })

  it('POST /autostart 后立即 GET overview 应已是新状态（不被 2s TTL 缓存回灌旧值）', async () => {
    const t = await setup()
    try {
      const H = { 'x-modeldock-admin': 'admin-token-x' }
      const base = `http://127.0.0.1:${t.gwPort}/_modeldock`
      // 先拉一次 overview 填充服务端 2s TTL 缓存（installed:false 基线）
      const ov0: any = await (await fetch(base + '/overview', { headers: H })).json()
      expect(ov0.gateway.autostart.installed).toBe(false)
      // 开启：响应即新状态；紧随的 overview GET 必须同步（修复前命中缓存返回 false）
      const on: any = await (await fetch(base + '/autostart', { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify({ enabled: true }) })).json()
      expect(on.installed).toBe(true)
      const ov1: any = await (await fetch(base + '/overview', { headers: H })).json()
      expect(ov1.gateway.autostart.installed).toBe(true)
      // 关闭：同样立即生效
      const off: any = await (await fetch(base + '/autostart', { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify({ enabled: false }) })).json()
      expect(off.installed).toBe(false)
      const ov2: any = await (await fetch(base + '/overview', { headers: H })).json()
      expect(ov2.gateway.autostart.installed).toBe(false)
    } finally {
      t.closeAll()
    }
  })
})

describe('请求级语言与双语审计（i18n）', () => {
  it('x-modeldock-lang: en → 服务端生成的报错文案为英文；无头回落网关默认语言', async () => {
    const g = await setup()
    try {
      const url = `http://127.0.0.1:${g.gwPort}/_modeldock/key`
      const body = JSON.stringify({ provider: 'nope', key: 'x' })
      const en: any = await (
        await fetch(url, {
          method: 'POST',
          headers: { 'x-modeldock-admin': 'admin-token-x', 'content-type': 'application/json', 'x-modeldock-lang': 'en' },
          body,
        })
      ).json()
      expect(en.error.message).toBe('Provider "nope" not found')
      const zh: any = await (
        await fetch(url, {
          method: 'POST',
          headers: { 'x-modeldock-admin': 'admin-token-x', 'content-type': 'application/json' },
          body,
        })
      ).json()
      expect(zh.error.message).toBe('provider「nope」不存在')
    } finally {
      g.closeAll()
    }
  })

  it('审计条目双语存储：/logs 返回 op_en/detail_en，控制台按界面语言渲染有据可依', async () => {
    const g = await setup()
    try {
      const base = `http://127.0.0.1:${g.gwPort}`
      const res = await fetch(base + '/_modeldock/reload', { method: 'POST', headers: { 'x-modeldock-admin': 'admin-token-x' } })
      expect(res.status).toBe(200)
      const j: any = await (await fetch(base + '/_modeldock/logs?n=30', { headers: { 'x-modeldock-admin': 'admin-token-x' } })).json()
      const row = (j.logs ?? []).find((l: any) => l.kind === 'audit' && l.op === '重载配置')
      expect(row).toBeTruthy()
      expect(row.op_en).toBe('Reload config')
      expect(row.detail).toBe('第 1 次热重载')
      expect(row.detail_en).toBe('Hot reload #1')
    } finally {
      g.closeAll()
    }
  })
})

describe('锁屏重登（设备记忆）', () => {
  it('?token= 登录种双 cookie；令牌轮换后旧 admin 失效，设备 cookie 一键恢复；无设备/伪造 403', async () => {
    const t = await setup()
    try {
      const origin = `http://127.0.0.1:${t.gwPort}`
      const getCookie = (headers: Headers, name: string) => {
        const line = headers.getSetCookie().find((c) => c.startsWith(name + '='))
        return line ? decodeURIComponent(/^[^=]+=([^;]+)/.exec(line)![1]) : null
      }

      // 登录：种 admin cookie（7 天，名字内嵌端口号）+ 设备记忆 cookie（1 年，mdkdev_ 前缀）。
      // 名字按端口隔离：RFC 6265 cookie 不按端口隔离，同机双实例（生产+dev）固定名会互顶登录态
      const adminName = `mdk_admin_${t.gwPort}`
      const deviceName = `mdk_device_${t.gwPort}`
      const login = await fetch(`${origin}/_modeldock/ui?token=admin-token-x`, { redirect: 'manual' })
      expect(login.status).toBe(302)
      const adminVal = getCookie(login.headers, adminName)
      const deviceVal = getCookie(login.headers, deviceName)
      expect(adminVal).toBe('admin-token-x')
      expect(deviceVal).toMatch(/^mdkdev_[0-9a-f]+$/)

      // 令牌轮换 → 旧 admin cookie 立即失效（设备 cookie 不受影响）
      const rot = await fetch(`${origin}/_modeldock/admin/rotate`, {
        method: 'POST',
        headers: { 'x-modeldock-admin': 'admin-token-x' },
      })
      const newToken: string = (await rot.json()).admin_token
      expect(
        (await fetch(`${origin}/_modeldock/status`, { headers: { cookie: `${adminName}=${encodeURIComponent(adminVal!)}` } })).status
      ).toBe(401)

      // 锁屏「重新登录」：凭设备 cookie 换发当前令牌的 admin cookie（轮换不踢老浏览器）
      const re = await fetch(`${origin}/_modeldock/auth/relogin`, {
        method: 'POST',
        headers: { cookie: `${deviceName}=${encodeURIComponent(deviceVal!)}` },
      })
      expect(re.status).toBe(200)
      const refreshed = getCookie(re.headers, adminName)
      expect(refreshed).toBe(newToken)
      expect(
        (await fetch(`${origin}/_modeldock/status`, { headers: { cookie: `${adminName}=${encodeURIComponent(refreshed!)}` } })).status
      ).toBe(200)

      // 无设备凭据 / 伪造设备值 → 403（不得免凭据放行，2026-09 审查口子不重开）
      expect((await fetch(`${origin}/_modeldock/auth/relogin`, { method: 'POST' })).status).toBe(403)
      expect(
        (await fetch(`${origin}/_modeldock/auth/relogin`, { method: 'POST', headers: { cookie: `${deviceName}=mdkdev_deadbeef` } })).status
      ).toBe(403)
    } finally {
      t.closeAll()
    }
  })

  it('锁屏 HTML 引导重登/粘贴令牌而非终端命令', async () => {
    const t = await setup()
    try {
      const html = await (await fetch(`http://127.0.0.1:${t.gwPort}/_modeldock/ui`)).text()
      expect(html).toContain('reloginBtn')
      expect(html).toContain('tokenInput')
      // 「下一个切换」自动选项：没得切时写明理由，不能退回光秃秃的「自动」（用户会当成名字没渲染出来）
      expect(html).toContain('自动 · 无备用服务')
      expect(html).not.toContain('modeldock ui</code>')
      // gateway.json 路径按实例实际 home 注入（fakeHome 沙箱下不是 ~/.modeldock），占位符不得残留。
      // 期望值必须走 path.join 与服务端同构：Windows 注入的是反斜杠路径，模板串硬拼 '/' 会在 CI 失配
      expect(html).toContain(path.join(process.env.MODELRDOCK_FAKE_HOME ?? '', '.modeldock', 'gateway.json'))
      // 弹窗正文里的网址要可点：mList 渲染必须过 linkifyText（改回 esc(l) 会让安装指引里的链接变回纯文本）
      expect(html).toContain('function linkifyText(s)')
      expect(html).toContain('linkifyText(l)')
      // 导入配置包的文件选择框不得带 accept：iOS 选择器按类型过滤，未注册的 .msync 会被灰掉选不中
      expect(html).not.toMatch(/<input[^>]*id="impFile2"[^>]*accept/)
      expect(html).not.toContain('__MD_GATEWAY_STATE__')
    } finally {
      t.closeAll()
    }
  })

  it('overview 标记 dev 沙箱：MODELRDOCK_DEV_SANDBOX=1 → sandbox=true + 沙箱 home', async () => {
    process.env.MODELRDOCK_DEV_SANDBOX = '1'
    let t: Awaited<ReturnType<typeof setup>> | null = null
    try {
      t = await setup()
      const ov: any = await (
        await fetch(`http://127.0.0.1:${t.gwPort}/_modeldock/overview`, { headers: { 'x-modeldock-admin': 'admin-token-x' } })
      ).json()
      expect(ov.gateway.sandbox).toBe(true)
      expect(ov.gateway.home).toContain('modeldock-test-') // fakeHome 隔离的 home
      // Windows 的 path.join 产出反斜杠：断言前归一化分隔符（与 guard-develop 的 norm 同法）
      expect(ov.gateway.home.replace(/\\/g, '/').endsWith('/.modeldock')).toBe(true)
    } finally {
      delete process.env.MODELRDOCK_DEV_SANDBOX
      t?.closeAll()
    }
  })

  it('非沙箱实例（未设 DEV_SANDBOX）overview.gateway.sandbox=false', async () => {
    const t = await setup()
    try {
      const ov: any = await (
        await fetch(`http://127.0.0.1:${t.gwPort}/_modeldock/overview`, { headers: { 'x-modeldock-admin': 'admin-token-x' } })
      ).json()
      expect(ov.gateway.sandbox).toBe(false)
    } finally {
      t.closeAll()
    }
  })
})

describe('网关', () => {
  it('无效 token → 401 + 修复提示', async () => {
    const t = await setup()
    try {
      const res = await fetch(`http://127.0.0.1:${t.gwPort}/v1/messages`, {
        method: 'POST',
        headers: { authorization: 'Bearer wrong' },
        body: '{}',
      })
      expect(res.status).toBe(401)
      const j = await res.json()
      expect((j as any).modeldock.hint).toContain('token')
    } finally {
      t.closeAll()
    }
  })

  it('无 token → 401', async () => {
    const t = await setup()
    try {
      const res = await fetch(`http://127.0.0.1:${t.gwPort}/v1/messages`, { method: 'POST', body: '{}' })
      expect(res.status).toBe(401)
    } finally {
      t.closeAll()
    }
  })

  it('上游 gzip 压缩错误体：中继给客户端的是解压后的可读 JSON，且不再声明 content-encoding', async () => {
    const t = await setup()
    try {
      const res = await fetch(`http://127.0.0.1:${t.gwPort}/v1/messages`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'gzip-err-model', messages: [{ role: 'user', content: 'hi' }] }),
      })
      expect(res.status).toBe(400)
      expect(res.headers.get('content-encoding')).toBeNull()
      const j: any = await res.json()
      expect(j.error.code).toBe('InvalidParameter')
      expect(j.error.message).toContain('thinking.type')
      expect(j.modeldock.hint).toBeTruthy()
    } finally {
      t.closeAll()
    }
  })

  it('429 排空重包路径：gzip 体解压判别（非额度类不切换），客户端拿到明文错误', async () => {
    const t = await setup()
    try {
      const res = await fetch(`http://127.0.0.1:${t.gwPort}/v1/messages`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'gzip-429-model', messages: [{ role: 'user', content: 'hi' }] }),
      })
      expect(res.status).toBe(429)
      expect(res.headers.get('content-encoding')).toBeNull()
      const j: any = await res.json()
      expect(j.error.message).toContain('rate limited')
      expect(j.modeldock.hint).toBeTruthy()
    } finally {
      t.closeAll()
    }
  })

  it('根路径：无认证 GET / → 302 到控制台；带 token / POST 不受影响', async () => {
    const t = await setup()
    try {
      // 浏览器直接访问网关根路径 → 引导到 Web 控制台
      const root = await fetch(`http://127.0.0.1:${t.gwPort}/`, { redirect: 'manual' })
      expect(root.status).toBe(302)
      expect(root.headers.get('location')).toBe('/_modeldock/ui')

      // 带 token 的请求仍走代理（mock 上游对未知路径回 404）
      const proxied = await fetch(`http://127.0.0.1:${t.gwPort}/`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      })
      expect(proxied.status).toBe(404)

      // POST / 无认证 → 仍 401，不重定向
      const post = await fetch(`http://127.0.0.1:${t.gwPort}/`, { method: 'POST', body: '' })
      expect(post.status).toBe(401)
    } finally {
      t.closeAll()
    }
  })

  it('别名重写 + Bearer 注入 + SSE 透传', async () => {
    const t = await setup()
    try {
      const res = await fetch(`http://127.0.0.1:${t.gwPort}/v1/messages`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'claude-sonnet-4-6[1M]', max_tokens: 10, messages: [] }),
      })
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toContain('text/event-stream')
      const text = await res.text()
      expect(text).toContain('message_start')
      expect(text).toContain('message_stop')

      const req = t.requests.at(-1)!
      expect(req.authorization).toBe('Bearer sk-upstream-secret')
      expect(JSON.parse(req.body!).model).toBe('ds-flash-target')
      expect(req.anthropicVersion).toBe('2023-06-01')
    } finally {
      t.closeAll()
    }
  })

  it('无别名模型透传；缺模型注入 default_model', async () => {
    const t = await setup()
    try {
      await fetch(`http://127.0.0.1:${t.gwPort}/v1/messages`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ model: 'unknown-model-xyz', messages: [] }),
      })
      expect(JSON.parse(t.requests.at(-1)!.body!).model).toBe('unknown-model-xyz')

      await fetch(`http://127.0.0.1:${t.gwPort}/v1/messages`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ messages: [] }),
      })
      expect(JSON.parse(t.requests.at(-1)!.body!).model).toBe('preset-model')
    } finally {
      t.closeAll()
    }
  })

  it('GET /v1/models 本地合成：返回当前服务目录（含 display_name 与 OpenAI 兼容字段），零上游调用', async () => {
    const t = await setup()
    try {
      const before = t.requests.length
      const res = await fetch(`http://127.0.0.1:${t.gwPort}/v1/models`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      })
      expect(res.status).toBe(200)
      const j: any = await res.json()
      expect(j.data).toEqual([
        { id: 'preset-model', type: 'model', display_name: 'preset-model', object: 'model', created: 0, owned_by: 'up' },
      ])
      expect(j.first_id).toBe('preset-model')
      expect(j.has_more).toBe(false)
      expect(j.last_id).toBe('preset-model')
      // 本地合成的核心验收：上游一个包都没收到（不得透传）
      expect(t.requests.length).toBe(before)
    } finally {
      t.closeAll()
    }
  })

  it('GET /v1/models：display_name 优先、无则回落 ID', async () => {
    const t = await setup()
    try {
      t.rt.config.providers.up.models!['glm-5.3'] = { source: 'manual', display_name: 'GLM-5.3' }
      const res = await fetch(`http://127.0.0.1:${t.gwPort}/v1/models`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      })
      const j: any = await res.json()
      expect(j.data.map((m: any) => [m.id, m.display_name])).toEqual([
        ['preset-model', 'preset-model'],
        ['glm-5.3', 'GLM-5.3'],
      ])
    } finally {
      t.closeAll()
    }
  })

  it('GET /v1/models 跟随选路：钉定路由优先，否则跟 active_profile', async () => {
    const t = await setup()
    try {
      t.rt.config.providers.up2 = {
        name: 'mock-b',
        base_url: 'http://127.0.0.1:1',
        protocol: 'anthropic',
        auth_style: 'bearer',
        key_ref: 'sk-b',
        models: { 'b-model': { source: 'manual', display_name: 'B 模型' } },
      }
      t.rt.config.profiles.p2 = { provider: 'up2', default_model: 'b-model' }
      const get = async () =>
        (await fetch(`http://127.0.0.1:${t.gwPort}/v1/models`, { headers: { authorization: `Bearer ${TOKEN}` } }).then((r) => r.json()) as any)

      // 钉定路由：harness route 指向 p2 → up2 的目录
      t.rt.config.harness['claude-code'].route = 'p2'
      expect((await get()).data[0].id).toBe('b-model')
      // 跟随全局：active_profile 指向 p2 的 profile
      t.rt.config.harness['claude-code'].route = 'default'
      t.rt.config.active_profile = 'p2'
      expect((await get()).data[0].id).toBe('b-model')
      // 定时窗口接管：active_profile 回 demo，但窗口目标 p2 → 列表仍切到窗口服务（与转发同源）
      t.rt.config.active_profile = 'demo'
      t.rt.config.gateway = { auto_failover: true, schedule: { enabled: true, windows: [{ start: '00:00', end: '23:59', target: 'up2' }] } }
      expect((await get()).data[0].id).toBe('b-model')
      delete t.rt.config.gateway
      // 切回 demo
      t.rt.config.active_profile = 'demo'
      expect((await get()).data[0].id).toBe('preset-model')
    } finally {
      t.closeAll()
    }
  })

  it('overview：「正在使用」与服务卡 inUse 跟随定时窗口，defaultRoute 保持默认路由', async () => {
    const t = await setup()
    try {
      t.rt.config.providers.up2 = {
        name: 'mock-b',
        base_url: 'http://127.0.0.1:1',
        protocol: 'anthropic',
        auth_style: 'bearer',
        key_ref: 'sk-b',
        models: { 'b-model': { source: 'manual' } },
      }
      t.rt.config.profiles.p2 = { provider: 'up2', default_model: 'b-model' }
      t.rt.config.gateway = { auto_failover: true, schedule: { enabled: true, windows: [{ start: '00:00', end: '23:59', target: 'up2' }] } }
      const ov: any = await (
        await fetch(`http://127.0.0.1:${t.gwPort}/_modeldock/overview`, { headers: { 'x-modeldock-admin': 'admin-token-x' } })
      ).json()
      // 唯一的「正在使用」口径：服务端 routeState → autoRoute/current/services.inUse 三处一致
      expect(ov.gateway.autoRoute).toMatchObject({ provider: 'up2', model: 'b-model', source: 'schedule' })
      expect(ov.gateway.autoRoute.schedule).toMatchObject({ applied: true, suppressedBy: null })
      expect(ov.current).toMatchObject({ id: 'up2', label: 'mock-b', model: 'b-model' })
      // 默认路由是独立概念（接入/直连用），不跟着窗口变
      expect(ov.defaultRoute).toMatchObject({ id: 'up', model: 'preset-model' })
      expect(ov.services.find((s: any) => s.id === 'up2')).toMatchObject({ inUse: true, isCurrent: true })
      expect(ov.services.find((s: any) => s.id === 'up')).toMatchObject({ inUse: false, isCurrent: false })
      // 跟随全局的客户端行也跟着窗口走（不再是 active_profile 的旧值）
      expect(ov.clients.find((c: any) => c.id === 'claude-code').service).toBe('mock-b')
    } finally {
      t.closeAll()
    }
  })

  it('GET /v1/models：discovery（带 anthropic-version 头）对非 Claude 系 ID 加 anthropic. 前缀，Claude 系 ID 原样', async () => {
    const t = await setup()
    try {
      t.rt.config.providers.up.models!['claude-fake-1'] = { source: 'manual', display_name: 'Fake Claude' }
      const res = await fetch(`http://127.0.0.1:${t.gwPort}/v1/models`, {
        headers: { authorization: `Bearer ${TOKEN}`, 'anthropic-version': '2023-06-01' },
      })
      const j: any = await res.json()
      expect(j.data.map((m: any) => [m.id, m.display_name])).toEqual([
        ['anthropic.preset-model', 'preset-model'],
        ['claude-fake-1', 'Fake Claude'],
      ])
      // 不带头（OpenAI 系客户端）：ID 原样
      const res2 = await fetch(`http://127.0.0.1:${t.gwPort}/v1/models`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      })
      const j2: any = await res2.json()
      expect(j2.data.map((m: any) => m.id)).toEqual(['preset-model', 'claude-fake-1'])
    } finally {
      t.closeAll()
    }
  })

  it('GET /v1/models：目录为空返回空列表；未认证 401', async () => {
    const t = await setup()
    try {
      t.rt.config.providers.empty = {
        name: 'empty',
        base_url: 'http://127.0.0.1:1',
        protocol: 'anthropic',
        auth_style: 'bearer',
        key_ref: 'sk-e',
      }
      t.rt.config.profiles.pe = { provider: 'empty', default_model: 'x' }
      t.rt.config.active_profile = 'pe'
      const res = await fetch(`http://127.0.0.1:${t.gwPort}/v1/models`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      })
      const j: any = await res.json()
      expect(j.data).toEqual([])
      expect(j.has_more).toBe(false)
      expect(j.first_id).toBeUndefined()

      const anon = await fetch(`http://127.0.0.1:${t.gwPort}/v1/models`)
      expect(anon.status).toBe(401)
    } finally {
      t.closeAll()
    }
  })

  it('usage 落盘：SSE（anthropic）与非流式 JSON（openai）的 token 用量进请求日志', async () => {
    // —— anthropic SSE：message_start 带输入/缓存，message_delta 带输出累计 ——
    const t = await setup()
    try {
      const res = await fetch(`http://127.0.0.1:${t.gwPort}/v1/messages`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [] }),
      })
      expect(res.status).toBe(200)
      await res.text()
      await new Promise((r) => setTimeout(r, 50)) // 日志 appendFile 异步，稍等落盘
      const dir = logsDir()
      const logFile = fs.readdirSync(dir).filter((f) => f.startsWith('gateway-')).sort().at(-1)!
      const entries = fs.readFileSync(path.join(dir, logFile), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
      const sseEntry = entries.filter((e) => e.path?.includes('/v1/messages')).at(-1)
      expect(sseEntry.usage).toEqual({ input_tokens: 100, output_tokens: 42, cache_read_tokens: 20, cache_creation_tokens: 5 })
    } finally {
      t.closeAll()
    }

    // —— openai 非流式 JSON：顶层 usage{prompt_tokens, completion_tokens} ——
    const t2 = await setup({ protocol: 'openai' })
    try {
      const res = await fetch(`http://127.0.0.1:${t2.gwPort}/v1/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-x' }),
      })
      expect(res.status).toBe(200)
      await res.json()
      await new Promise((r) => setTimeout(r, 50))
      const dir2 = logsDir()
      const logFile2 = fs.readdirSync(dir2).filter((f) => f.startsWith('gateway-')).sort().at(-1)!
      const entries2 = fs.readFileSync(path.join(dir2, logFile2), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
      const jsonEntry = entries2.filter((e) => e.path?.includes('/v1/chat/completions')).at(-1)
      expect(jsonEntry.usage).toEqual({ input_tokens: 3, output_tokens: 4, cache_read_tokens: 0, cache_creation_tokens: 0 })
    } finally {
      t2.closeAll()
    }
  })

  it('openai 协议路由 + admin test 端到端探测', async () => {
    const t = await setup({ protocol: 'openai' })
    try {
      const res = await fetch(`http://127.0.0.1:${t.gwPort}/_modeldock/test`, {
        method: 'POST',
        headers: { 'x-modeldock-admin': 'admin-token-x', 'content-type': 'application/json' },
        body: JSON.stringify({ profile: 'demo' }),
      })
      const j: any = await res.json()
      expect(j.ok).toBe(true)
      expect(j.model).toBe('preset-model')
      expect(j.usage).toEqual({ prompt_tokens: 3, completion_tokens: 4 })
      expect(t.requests.at(-1)!.authorization).toBe('Bearer sk-upstream-secret')
    } finally {
      t.closeAll()
    }
  })

  it('上游错误被翻译并附 hint', async () => {
    const t = await setup()
    try {
      const res = await fetch(`http://127.0.0.1:${t.gwPort}/unauth`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}` },
        body: '{}',
      })
      expect(res.status).toBe(401)
      const j: any = await res.json()
      expect(j.error.message).toBe('invalid api key')
      expect(j.modeldock.hint).toContain('set-key')
    } finally {
      t.closeAll()
    }
  })

  it('管理面：health 开放，读写一律要求 admin 凭据，伪造同源也被拒', async () => {
    const t = await setup()
    try {
      const health = await fetch(`http://127.0.0.1:${t.gwPort}/_modeldock/health`)
      expect(health.status).toBe(200)
      // 读取类：无凭据 → 401（此前"本机读取开放"已收紧）
      const statusOpen = await fetch(`http://127.0.0.1:${t.gwPort}/_modeldock/status`)
      expect(statusOpen.status).toBe(401)
      // 修改类：伪造同源 Origin（无 token/cookie）→ 401，不再"同源即放行"
      const forged = await fetch(`http://127.0.0.1:${t.gwPort}/_modeldock/use`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${t.gwPort}` },
        body: JSON.stringify({ profile: 'other' }),
      })
      expect(forged.status).toBe(401)
      // 跨站 Origin → 401（Host 合法但无凭据）
      const evil = await fetch(`http://127.0.0.1:${t.gwPort}/_modeldock/use`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'https://evil.com' },
        body: JSON.stringify({ profile: 'other' }),
      })
      expect(evil.status).toBe(401)
      // admin token 仍兼容（CLI 路径）
      const withToken = await fetch(`http://127.0.0.1:${t.gwPort}/_modeldock/use`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-modeldock-admin': 'admin-token-x' },
        body: JSON.stringify({ profile: 'demo' }),
      })
      expect(withToken.status).toBe(200)
    } finally {
      t.closeAll()
    }
  })

  it('日志端点分页：第 1 页为最新 n 条并带 total/pages，越界页为空，不带 page 向后兼容', async () => {
    const h = fakeHome()
    const cfg: Config = {
      version: 1,
      active_profile: 'demo',
      security: { store: 'file' },
      providers: {
        up: {
          name: 'mock',
          base_url: 'http://127.0.0.1:1',
          protocol: 'anthropic',
          auth_style: 'bearer',
          key_ref: 'sk-upstream-secret',
          models: { 'preset-model': { source: 'preset', context_window: 1000, max_output: 100 } },
        },
      },
      profiles: { demo: { provider: 'up', default_model: 'preset-model' } },
      harness: { 'claude-code': { mode: 'gateway', route: 'default', token: TOKEN } },
    }
    await saveConfig(cfg)
    const rt = buildRuntime(cfg, 'admin-token-x')
    for (let i = 1; i <= 25; i++) {
      rt.ring.push({ ts: `2026-09-29T00:00:${String(i).padStart(2, '0')}.000Z`, harness: 'claude-code', profile: 'demo', provider: 'up', model: 'm' + i, path: '/v1/messages', status: 200, ms: i })
    }
    const server = createGatewayServer(rt, { port: 0 })
    const gwPort = await listenEphemeral(server)
    try {
      const ADMIN = { 'x-modeldock-admin': 'admin-token-x' }
      const base = `http://127.0.0.1:${gwPort}/_modeldock/logs`
      const p1: any = await (await fetch(`${base}?n=10&page=1`, { headers: ADMIN })).json()
      expect(p1.total).toBe(25)
      expect(p1.pages).toBe(3)
      expect(p1.logs).toHaveLength(10)
      // ring 按时间正序存放，第 1 页取最新 10 条（m16..m25），UI 侧再反转为最新在上
      expect(p1.logs.map((l: any) => l.model)).toEqual(['m16', 'm17', 'm18', 'm19', 'm20', 'm21', 'm22', 'm23', 'm24', 'm25'])
      const p3: any = await (await fetch(`${base}?n=10&page=3`, { headers: ADMIN })).json()
      expect(p3.logs).toHaveLength(5)
      expect(p3.logs[0].model).toBe('m1')
      const p9: any = await (await fetch(`${base}?n=10&page=9`, { headers: ADMIN })).json()
      expect(p9.logs).toEqual([])
      // 不带 page：维持旧行为（取最后 n 条），兼容现有调用方
      const legacy: any = await (await fetch(`${base}?n=20`, { headers: ADMIN })).json()
      expect(legacy.logs).toHaveLength(20)
      expect(legacy.logs[0].model).toBe('m6')
    } finally {
      server.close()
      h.restore()
    }
  })

  it('Web 控制台 v2：overview 聚合视图 + service/switch 任务端点', async () => {
    const t = await setup()
    try {
      const origin = `http://127.0.0.1:${t.gwPort}`
      const ov = await fetch(`http://127.0.0.1:${t.gwPort}/_modeldock/overview`, { headers: { 'x-modeldock-admin': 'admin-token-x' } })
      expect(ov.status).toBe(200)
      const view: any = await ov.json()
      expect(view.current.label).toBeTruthy()
      expect(view.services[0].isCurrent).toBe(true)
      expect(view.clients.length).toBeGreaterThanOrEqual(5)
      expect(view.presets.length).toBeGreaterThan(10)

      // 添加服务（fetch:false 避免真实网络）
      const svc = await fetch(`http://127.0.0.1:${t.gwPort}/_modeldock/service`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin, 'x-modeldock-admin': 'admin-token-x' },
        body: JSON.stringify({ presetId: 'deepseek-anthropic', key: 'sk-ui-test', fetch: false }),
      })
      const svcJson: any = await svc.json()
      expect(svcJson.ok).toBe(true)
      // 服务 ID 取预设 slug（deepseek-anthropic → deepseek），不再暴露协议后缀
      expect(svcJson.providerId).toBe('deepseek')

      // 切换服务 → active_profile 变化
      const sw = await fetch(`http://127.0.0.1:${t.gwPort}/_modeldock/switch`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin, 'x-modeldock-admin': 'admin-token-x' },
        body: JSON.stringify({ service: 'deepseek' }),
      })
      const swJson: any = await sw.json()
      expect(swJson.ok).toBe(true)
      expect(swJson.profile).toBe('auto-deepseek')
      const onDisk: any = tomlParse(fs.readFileSync(configPath(), 'utf8'))
      expect(onDisk.active_profile).toBe('auto-deepseek')
      expect(onDisk.providers['deepseek'].base_url).toContain('deepseek')
      expect(onDisk.providers['deepseek'].key_ref).toBe('file:deepseek')

      // 按服务测速（provider 直连探测）
      const test = await fetch(`http://127.0.0.1:${t.gwPort}/_modeldock/test`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin, 'x-modeldock-admin': 'admin-token-x' },
        body: JSON.stringify({ provider: 'up', stream: true }),
      })
      const testJson: any = await test.json()
      expect(testJson.ok).toBe(true)
    } finally {
      t.closeAll()
    }
  }, 60_000)

  it('Web 控制台：添加服务支持预设模型目录直显、指定默认模型与故障切换链', async () => {
    const t = await setup()
    try {
      const origin = `http://127.0.0.1:${t.gwPort}`
      const ADMIN = { 'content-type': 'application/json', origin, 'x-modeldock-admin': 'admin-token-x' }
      // overview.presets 携带模型目录（添加页首屏直显预设模型）
      const view: any = await (await fetch(`http://127.0.0.1:${t.gwPort}/_modeldock/overview`, { headers: { 'x-modeldock-admin': 'admin-token-x' } })).json()
      const ds = view.presets.find((p: any) => p.id === 'deepseek-anthropic')
      expect(Object.keys(ds.models || {})).toContain('deepseek-flash')
      expect(ds.models['deepseek-flash'].context_window).toBeGreaterThan(0)
      // 添加：在预设目录上精修上下文 + 指定默认模型 + 备用链（自身条目应被跳过）
      const add: any = await (await fetch(`http://127.0.0.1:${t.gwPort}/_modeldock/service`, {
        method: 'POST', headers: ADMIN,
        body: JSON.stringify({
          presetId: 'deepseek-anthropic', key: 'sk-x', fetch: false,
          models: { 'deepseek-flash': { context_window: 262144 } },
          default_model: 'deepseek-flash',
          fallback: ['up', 'deepseek'],
        }),
      })).json()
      expect(add.ok).toBe(true)
      const cfg: any = tomlParse(fs.readFileSync(configPath(), 'utf8'))
      const prof = cfg.profiles['auto-deepseek']
      expect(prof.default_model).toBe('deepseek-flash')
      expect(prof.fallback).toEqual(['up'])
      // 精修保留预设 display_name，仅覆盖 context_window
      expect(cfg.providers['deepseek'].models['deepseek-flash'].context_window).toBe(262144)
      expect(cfg.providers['deepseek'].models['deepseek-flash'].display_name).toBeTruthy()
      // 校验失败：备用服务不存在 → 400 带可操作报错
      const bad: any = await (await fetch(`http://127.0.0.1:${t.gwPort}/_modeldock/service`, {
        method: 'POST', headers: ADMIN,
        body: JSON.stringify({ presetId: 'openai', key: 'sk-y', fetch: false, fallback: ['ghost'] }),
      })).json()
      expect(bad.error?.message).toContain('ghost')
      // 校验失败：自定义预设缺地址 → 400 可操作报错
      const badUrl: any = await (await fetch(`http://127.0.0.1:${t.gwPort}/_modeldock/service`, {
        method: 'POST', headers: ADMIN,
        body: JSON.stringify({ presetId: 'custom', key: 'sk-z', fetch: false }),
      })).json()
      expect(badUrl.error?.message).toContain('http')
    } finally {
      t.closeAll()
    }
  }, 60_000)

  it('Web 控制台：attach/apply 与 detach 端点（真实文件 + 快照还原）', async () => {
    const t = await setup()
    // claude-code 安装判定要求 claude 命令在场（CI 机器没装）：用测试钩子注入「已安装」，
    // 与宿主机真实安装状态解耦（见 presence.ts fakePresence；zcode 用例同理）
    process.env.MODELRDOCK_FAKE_CLAUDE_CODE_PRESENT = '1'
    try {
      const home = process.env.MODELRDOCK_FAKE_HOME as string
      const fs = await import('node:fs')
      const path = await import('node:path')
      const settings = path.join(home, '.claude', 'settings.json')
      fs.mkdirSync(path.dirname(settings), { recursive: true })
      fs.writeFileSync(
        settings,
        JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://up.example.com', ANTHROPIC_AUTH_TOKEN: 'old' } }, null, 2) + '\n'
      )
      const origin = `http://127.0.0.1:${t.gwPort}`

      const plan = await fetch(`http://127.0.0.1:${t.gwPort}/_modeldock/attach/plan`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin, 'x-modeldock-admin': 'admin-token-x' },
        body: JSON.stringify({ harness: 'claude-code' }),
      })
      const planJson: any = await plan.json()
      expect(planJson.ok).toBe(true)
      expect(planJson.files[0].path).toBe(settings)

      const apply = await fetch(`http://127.0.0.1:${t.gwPort}/_modeldock/attach/apply`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin, 'x-modeldock-admin': 'admin-token-x' },
        body: JSON.stringify({ harness: 'claude-code' }),
      })
      const applyJson: any = await apply.json()
      expect(applyJson.ok).toBe(true)
      const after = JSON.parse(fs.readFileSync(settings, 'utf8'))
      // attach 写入实际监听端口（server 'listening' 钩子自动回写 rt.port，与生产 main.ts 同语义）
      expect(after.env.ANTHROPIC_BASE_URL).toBe(`http://127.0.0.1:${t.gwPort}`)

      // overview 中客户端已接入
      const ov: any = await (await fetch(`http://127.0.0.1:${t.gwPort}/_modeldock/overview`, { headers: { 'x-modeldock-admin': 'admin-token-x' } })).json()
      const cc = ov.clients.find((c: any) => c.id === 'claude-code')
      expect(cc.attached).toBe(true)
      expect(cc.pointing).toBe('gateway')

      // 断开 → 还原
      const detach = await fetch(`http://127.0.0.1:${t.gwPort}/_modeldock/detach`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin, 'x-modeldock-admin': 'admin-token-x' },
        body: JSON.stringify({ harness: 'claude-code' }),
      })
      const detachJson: any = await detach.json()
      expect(detachJson.ok).toBe(true)
      expect(detachJson.restored).toBe(true)
      const restored = JSON.parse(fs.readFileSync(settings, 'utf8'))
      expect(restored.env.ANTHROPIC_BASE_URL).toBe('https://up.example.com')
      expect(restored.env.ANTHROPIC_AUTH_TOKEN).toBe('old')
    } finally {
      delete process.env.MODELRDOCK_FAKE_CLAUDE_CODE_PRESENT
      t.closeAll()
    }
  })

  it('接入/断开后 overview 立即更新（无需等热加载）', async () => {
    const t = await setup()
    // zcode 适配器的安装判定要求本体在场（zcode 命令/桌面应用痕迹），测试机多半没有：
    // 用测试钩子注入「已安装」，让 status 走正常解析分支，pointing 断言才有意义
    process.env.MODELRDOCK_FAKE_ZCODE_PRESENT = '1'
    try {
      const home = process.env.MODELRDOCK_FAKE_HOME as string
      const fs = await import('node:fs')
      const path = await import('node:path')
      // zcode 不在 setup 的 harness 注册表里——用它验证即时性
      const zcfg = path.join(home, '.zcode', 'v2', 'config.json')
      fs.mkdirSync(path.dirname(zcfg), { recursive: true })
      fs.writeFileSync(zcfg, JSON.stringify({ provider: {} }, null, 2) + '\n')
      const origin = `http://127.0.0.1:${t.gwPort}`
      const ov = async () => {
        const j: any = await (await fetch(`http://127.0.0.1:${t.gwPort}/_modeldock/overview`, { headers: { 'x-modeldock-admin': 'admin-token-x' } })).json()
        return j.clients.find((c: any) => c.id === 'zcode')
      }
      expect((await ov()).attached).toBe(false)

      const apply = await fetch(`http://127.0.0.1:${t.gwPort}/_modeldock/attach/apply`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin, 'x-modeldock-admin': 'admin-token-x' },
        body: JSON.stringify({ harness: 'zcode' }),
      })
      expect(((await apply.json()) as any).ok).toBe(true)
      expect((await ov()).attached).toBe(true) // 紧接着查就必须是 true
      expect((await ov()).pointing).toBe('gateway')

      const detach = await fetch(`http://127.0.0.1:${t.gwPort}/_modeldock/detach`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin, 'x-modeldock-admin': 'admin-token-x' },
        body: JSON.stringify({ harness: 'zcode' }),
      })
      expect(((await detach.json()) as any).ok).toBe(true)
      expect((await ov()).attached).toBe(false) // 紧接着查就必须是 false
    } finally {
      delete process.env.MODELRDOCK_FAKE_ZCODE_PRESENT
      t.closeAll()
    }
  })

  it('ZCode 安装指引指向真官网 zcode.z.ai（原 zcode.app 已是域名停放页）', async () => {
    const t = await setup()
    try {
      const j: any = await (
        await fetch(`http://127.0.0.1:${t.gwPort}/_modeldock/overview`, { headers: { 'x-modeldock-admin': 'admin-token-x' } })
      ).json()
      const z = j.clients.find((c: any) => c.id === 'zcode')
      // 无官方 npm 包，只能给指引：install.auto 必须为 false，否则前端会渲染成「一点就装」的假承诺
      expect(z.install.auto).toBe(false)
      expect(z.install.homepage).toBe('https://zcode.z.ai')
      expect(z.install.guide).not.toContain('zcode.app')
    } finally {
      t.closeAll()
    }
  })

  it('generic-env 环境变量端点：接入后返回实际端口 + token + 变量行；未接入/未知 400', async () => {
    const t = await setup()
    try {
      const origin = `http://127.0.0.1:${t.gwPort}`
      const post = (body: Record<string, string>) =>
        fetch(`http://127.0.0.1:${t.gwPort}/_modeldock/harness/env`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin, 'x-modeldock-admin': 'admin-token-x' },
          body: JSON.stringify(body),
        })

      // 未接入 → 400 可操作报错
      expect((await post({ harness: 'generic-env' })).status).toBe(400)

      // Web 端接入（与 UI doAttach 的调用一致）
      const apply = await fetch(`http://127.0.0.1:${t.gwPort}/_modeldock/attach/apply`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin, 'x-modeldock-admin': 'admin-token-x' },
        body: JSON.stringify({ harness: 'generic-env' }),
      })
      expect(((await apply.json()) as any).ok).toBe(true)

      const j: any = await (await post({ harness: 'generic-env' })).json()
      expect(j.ok).toBe(true)
      // rt.port 由 server 'listening' 钩子自动回写为实际监听端口（生产/测试同语义）
      expect(j.base_url).toBe(`http://127.0.0.1:${t.gwPort}`)
      expect(j.token).toMatch(/^mdk_generic/)

      // rt.port 已由 'listening' 钩子回写为实际端口（生产 main.ts 手动赋值同值，幂等）
      t.rt.port = t.gwPort
      const j2: any = await (await post({ harness: 'generic-env' })).json()
      expect(j2.base_url).toBe(`http://127.0.0.1:${t.gwPort}`)
      expect(j2.lines).toEqual([
        `export ANTHROPIC_BASE_URL=http://127.0.0.1:${t.gwPort}`,
        `export ANTHROPIC_AUTH_TOKEN=${j2.token}`,
        `export OPENAI_BASE_URL=http://127.0.0.1:${t.gwPort}/v1`,
        `export OPENAI_API_KEY=${j2.token}`,
      ])

      // 不存在的客户端 → 400
      expect((await post({ harness: 'nope' })).status).toBe(400)
    } finally {
      t.closeAll()
    }
  })

  it('一键迁移：cc-switch 探测 → 导入 → 自动去重', async () => {
    const t = await setup()
    try {
      const { execSync } = await import('node:child_process')
      let hasSqlite = true
      try {
        execSync('which sqlite3', { stdio: 'ignore' })
      } catch {
        hasSqlite = false
      }
      if (!hasSqlite) {
        console.log('skip: 环境无 sqlite3')
        return
      }
      const home = process.env.MODELRDOCK_FAKE_HOME as string
      const db = path.join(home, '.cc-switch', 'cc-switch.db')
      fs.mkdirSync(path.dirname(db), { recursive: true })
      const sqlFile = path.join(home, 'seed.sql')
      fs.writeFileSync(
        sqlFile,
        [
          'CREATE TABLE providers (id INTEGER, app TEXT, name TEXT, settings_config TEXT, is_current INTEGER);',
          `INSERT INTO providers VALUES (1,'claude','火山 Coding','{"env":{"ANTHROPIC_BASE_URL":"https://ark.example.com/api/coding","ANTHROPIC_AUTH_TOKEN":"sk-volc-1","ANTHROPIC_DEFAULT_SONNET_MODEL":"deepseek-v4-flash"}}',1);`,
          `INSERT INTO providers VALUES (2,'claude','本地代理','{"env":{"ANTHROPIC_BASE_URL":"http://127.0.0.1:15721","ANTHROPIC_AUTH_TOKEN":"x"}}',0);`,
          // 同地址不同 Key：应被视为重复，只导入「使用中」的那一个
          `INSERT INTO providers VALUES (3,'claude','火山 Coding 备份','{"env":{"ANTHROPIC_BASE_URL":"https://ark.example.com/api/coding/","ANTHROPIC_AUTH_TOKEN":"sk-volc-2"}}',0);`,
        ].join('\n')
      )
      execSync(`sqlite3 '${db}' < '${sqlFile}'`)
      const origin = `http://127.0.0.1:${t.gwPort}`

      // 按地址去重：只导入「使用中」的那一个
      const det = await fetch(`http://127.0.0.1:${t.gwPort}/_modeldock/import/detect`, { headers: { 'x-modeldock-admin': 'admin-token-x' } })
      const detJson: any = await det.json()
      const actionable = detJson.candidates.filter((c: any) => !c.skipReason)
      expect(actionable).toHaveLength(1)
      expect(actionable[0].name).toBe('火山 Coding')
      expect(actionable[0].hasKey).toBe(true)
      expect(JSON.stringify(detJson)).not.toContain('sk-volc-1') // Key 明文绝不出现在接口响应里

      // 一键导入
      const apply = await fetch(`http://127.0.0.1:${t.gwPort}/_modeldock/import/apply`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin, 'x-modeldock-admin': 'admin-token-x' },
        body: JSON.stringify({}),
      })
      const applyJson: any = await apply.json()
      expect(applyJson.ok).toBe(true)
      expect(applyJson.imported).toHaveLength(1) // 批内按地址去重

      const onDisk: any = tomlParse(fs.readFileSync(configPath(), 'utf8'))
      const importedId = applyJson.imported[0]
      expect(onDisk.providers[importedId].base_url).toBe('https://ark.example.com/api/coding')
      expect(onDisk.profiles[importedId]).toBeTruthy()
      // secrets 文件里 key 已入库——存储格式是平台实现细节（Linux file 后端为 machine-id 绑定加密
      // enc:mach:*、win32 为 DPAPI），断言解密契约（getSecret 解出原文）而非明文存储格式
      const secrets = JSON.parse(fs.readFileSync(path.join(home, '.modeldock', 'secrets.json'), 'utf8'))
      expect(secrets[importedId]).toBeTruthy()
      expect(await getSecret(onDisk.providers[importedId].key_ref)).toBe('sk-volc-1')
      // 全库只有这一个该地址的 provider，且用的是「使用中」条目的 Key
      const arkProviders = Object.entries(onDisk.providers).filter(([, p]: any) =>
        p.base_url.startsWith('https://ark.example.com')
      )
      expect(arkProviders).toHaveLength(1)
      expect(await getSecret(onDisk.providers[arkProviders[0][0]].key_ref)).toBe('sk-volc-1')

      // applyImport 兜底：重复导入同一批 → 全部因「地址相同」跳过，不产生重复服务
      const apply2 = await fetch(`http://127.0.0.1:${t.gwPort}/_modeldock/import/apply`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin, 'x-modeldock-admin': 'admin-token-x' },
        body: JSON.stringify({}),
      })
      const apply2Json: any = await apply2.json()
      expect(apply2Json.ok).toBe(true)
      expect(apply2Json.imported).toHaveLength(0)
      expect(apply2Json.skipped.length).toBeGreaterThan(0)
      expect(apply2Json.skipped.every((s: any) => /地址相同/.test(s.reason))).toBe(true)

      // 再次探测：已存在 → 不再提示
      const det2: any = await (await fetch(`http://127.0.0.1:${t.gwPort}/_modeldock/import/detect`, { headers: { 'x-modeldock-admin': 'admin-token-x' } })).json()
      expect(det2.candidates.filter((c: any) => !c.skipReason)).toHaveLength(0)
    } finally {
      t.closeAll()
    }
  })

  it('service/update：模型目录编辑（改/删/新增/校验）', async () => {
    const t = await setup()
    try {
      const origin = `http://127.0.0.1:${t.gwPort}`
      const upd = (body: Record<string, unknown>) =>
        fetch(`http://127.0.0.1:${t.gwPort}/_modeldock/service/update`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin, 'x-modeldock-admin': 'admin-token-x' },
          body: JSON.stringify(body),
        })

      // 全量替换：2 个模型，一个带元数据一个不带
      const ok = await upd({
        provider: 'up',
        models: {
          'model-a': { context_window: 131072, max_output: 8192 },
          'model-b': {},
        },
      })
      expect(((await ok.json()) as any).ok).toBe(true)
      const onDisk: any = tomlParse(fs.readFileSync(configPath(), 'utf8'))
      const models = onDisk.providers.up.models
      expect(Object.keys(models).sort()).toEqual(['model-a', 'model-b'])
      expect(models['model-a'].context_window).toBe(131072)
      expect(models['model-a'].source).toBe('manual')
      expect(models['model-b'].context_window).toBeUndefined()

      // overview 输出模型明细
      const ov: any = await (await fetch(`http://127.0.0.1:${t.gwPort}/_modeldock/overview`, { headers: { 'x-modeldock-admin': 'admin-token-x' } })).json()
      const svc = ov.services.find((s: any) => s.id === 'up')
      expect(svc.models.map((m: any) => m.id)).toEqual(['model-a', 'model-b'])
      expect(svc.models[0].context_window).toBe(131072)

      // 视觉是可选的模型能力：勾选写入 capabilities，取消勾选即清空；未提交该字段的服务保留既有标记
      const vis = await upd({ provider: 'up', models: { 'model-a': { context_window: 131072, capabilities: ['vision'] }, 'model-b': {} } })
      expect(((await vis.json()) as any).ok).toBe(true)
      const afterVis: any = tomlParse(fs.readFileSync(configPath(), 'utf8'))
      expect(afterVis.providers.up.models['model-a'].capabilities).toEqual(['vision'])
      expect(afterVis.providers.up.models['model-b'].capabilities).toBeUndefined()
      const ovVis: any = await (await fetch(`http://127.0.0.1:${t.gwPort}/_modeldock/overview`, { headers: { 'x-modeldock-admin': 'admin-token-x' } })).json()
      expect(ovVis.services.find((s: any) => s.id === 'up').models.find((m: any) => m.id === 'model-a').capabilities).toEqual(['vision'])
      // 取消勾选（空数组）→ 标记清除
      const off = await upd({ provider: 'up', models: { 'model-a': { context_window: 131072, capabilities: [] } } })
      expect(((await off.json()) as any).ok).toBe(true)
      const afterOff: any = tomlParse(fs.readFileSync(configPath(), 'utf8'))
      expect(afterOff.providers.up.models['model-a'].capabilities).toBeUndefined()

      // 显示名（display_name）：提交非空且 ≠ ID 才保存（编辑浮层 ID 下副行回显的权威值）；
      // 与 ID 同名的丢弃（去重防「同名两行」）；overview 透传
      const dn1 = await upd({ provider: 'up', models: { 'model-a': { context_window: 131072, display_name: 'Model A Pro' }, 'model-b': { display_name: 'model-b' } } })
      expect(((await dn1.json()) as any).ok).toBe(true)
      const afterDn: any = tomlParse(fs.readFileSync(configPath(), 'utf8'))
      expect(afterDn.providers.up.models['model-a'].display_name).toBe('Model A Pro')
      expect(afterDn.providers.up.models['model-b'].display_name).toBeUndefined()
      const ovDn: any = await (await fetch(`http://127.0.0.1:${t.gwPort}/_modeldock/overview`, { headers: { 'x-modeldock-admin': 'admin-token-x' } })).json()
      expect(ovDn.services.find((s: any) => s.id === 'up').models.find((m: any) => m.id === 'model-a').display_name).toBe('Model A Pro')
      // 留空（UI 对同名/缺失不回传）→ 保留既有，不因全量替换语义丢失
      const dn2 = await upd({ provider: 'up', models: { 'model-a': { context_window: 131072 } } })
      expect(((await dn2.json()) as any).ok).toBe(true)
      const afterDn2: any = tomlParse(fs.readFileSync(configPath(), 'utf8'))
      expect(afterDn2.providers.up.models['model-a'].display_name).toBe('Model A Pro')

      // 非正整数 ctx：服务端静默忽略（不写入、不报错）
      const bad = await upd({ provider: 'up', models: { 'model-a': { context_window: -5 } } })
      const badJson: any = await bad.json()
      expect(badJson.ok).toBe(true)
      const after: any = tomlParse(fs.readFileSync(configPath(), 'utf8'))
      expect(after.providers.up.models['model-a'].context_window).toBeUndefined()

      // 不存在的 provider → 400
      const nope = await upd({ provider: 'nope', models: {} })
      expect(nope.status).toBe(400)

      // 地址冲突校验：冲突指「与其他 provider 地址相同」，不含自己——先做不冲突的改址/改回原址，再建第二个服务测真冲突
      const ov0: any = await (await fetch(`http://127.0.0.1:${t.gwPort}/_modeldock/overview`, { headers: { 'x-modeldock-admin': 'admin-token-x' } })).json()
      const upUrl = ov0.services.find((s: any) => s.id === 'up').base_url
      const ok2 = await upd({ provider: 'up', base_url: `${upUrl}-x` }) // 先改成不冲突的地址
      expect(((await ok2.json()) as any).ok).toBe(true)
      const conflict = await upd({ provider: 'up', base_url: upUrl }) // 改回原地址：该地址已空缺，允许
      expect(((await conflict.json()) as any).ok).toBe(true)
      // 真正冲突：同地址同 Key → 400。先建第二个服务（同预设不同 Key）
      const svc2 = await fetch(`http://127.0.0.1:${t.gwPort}/_modeldock/service`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin, 'x-modeldock-admin': 'admin-token-x' },
        body: JSON.stringify({ presetId: 'deepseek-openai', key: 'sk-x', fetch: false }),
      })
      expect(((await svc2.json()) as any).ok).toBe(true)
      const ov1: any = await (await fetch(`http://127.0.0.1:${t.gwPort}/_modeldock/overview`, { headers: { 'x-modeldock-admin': 'admin-token-x' } })).json()
      const dsUrl = ov1.services.find((s: any) => s.id.startsWith('deepseek')).base_url
      // 同地址不同 Key：允许（同一厂商多账号分别登记）
      const sameUrlDiffKey = await upd({ provider: 'up', base_url: dsUrl })
      expect(sameUrlDiffKey.status).toBe(200)
      // 同地址同 Key：拒绝
      const clash = await upd({ provider: 'up', base_url: dsUrl, key: 'sk-x' })
      expect(clash.status).toBe(400)
      const clashJson: any = await clash.json()
      expect(String(clashJson.error?.message ?? '')).toContain('同地址同 Key')
    } finally {
      t.closeAll()
    }
  })

  it('service/update：三协议端点直排 —— protocol 可改、anthropic 端点全量替换（空串=清）；添加 endpoints 同口径校验', async () => {
    const t = await setup()
    try {
      const origin = `http://127.0.0.1:${t.gwPort}`
      const upd = (body: Record<string, unknown>) =>
        fetch(`http://127.0.0.1:${t.gwPort}/_modeldock/service/update`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin, 'x-modeldock-admin': 'admin-token-x' },
          body: JSON.stringify(body),
        })

      // 编辑表单直排语义：protocol 随表单提交可变；非默认协议行进 endpoints（空串=清该键）
      const r1 = await upd({
        provider: 'up',
        protocol: 'openai',
        base_url: 'https://relay.example.com/v1',
        endpoints: { anthropic: 'https://relay.example.com', openai: 'https://relay.example.com/v1', responses: '' },
      })
      expect(((await r1.json()) as any).ok).toBe(true)
      const after1: any = tomlParse(fs.readFileSync(configPath(), 'utf8'))
      expect(after1.providers.up.protocol).toBe('openai')
      expect(after1.providers.up.base_url).toBe('https://relay.example.com/v1')
      expect(after1.providers.up.endpoints.anthropic).toBe('https://relay.example.com')
      expect(after1.providers.up.endpoints.openai).toBe('https://relay.example.com/v1')
      expect(after1.providers.up.endpoints.responses).toBeUndefined()

      // 默认协议改回 anthropic：anthropic 地址落 base_url，endpoints.anthropic 清除
      const r2 = await upd({
        provider: 'up',
        protocol: 'anthropic',
        base_url: 'https://relay.example.com',
        endpoints: { anthropic: '', openai: 'https://relay.example.com/v1' },
      })
      expect(((await r2.json()) as any).ok).toBe(true)
      const after2: any = tomlParse(fs.readFileSync(configPath(), 'utf8'))
      expect(after2.providers.up.protocol).toBe('anthropic')
      expect(after2.providers.up.base_url).toBe('https://relay.example.com')
      expect(after2.providers.up.endpoints.anthropic).toBeUndefined()
      expect(after2.providers.up.endpoints.openai).toBe('https://relay.example.com/v1')

      // 非法 protocol 值忽略（保持现状）
      const r3 = await upd({ provider: 'up', protocol: 'ws' })
      expect(((await r3.json()) as any).ok).toBe(true)
      const after3: any = tomlParse(fs.readFileSync(configPath(), 'utf8'))
      expect(after3.providers.up.protocol).toBe('anthropic')

      // 添加服务：endpoints 与 /service/update 同口径校验，非法 URL → 400 可操作报错
      const add = (body: Record<string, unknown>) =>
        fetch(`http://127.0.0.1:${t.gwPort}/_modeldock/service`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin, 'x-modeldock-admin': 'admin-token-x' },
          body: JSON.stringify(body),
        })
      const badAdd = await add({ presetId: 'custom', key: 'sk-z', fetch: false, base_url: 'https://relay.example.com', endpoints: { openai: 'ftp://nope' } })
      expect(badAdd.status).toBe(400)
      const badAddJson: any = await badAdd.json()
      expect(String(badAddJson.error?.message ?? '')).toContain('openai')
      // 合法 anthropic 端点随添加落盘
      const goodAdd = await add({ presetId: 'custom', key: 'sk-z2', fetch: false, base_url: 'https://relay2.example.com', protocol: 'openai', endpoints: { anthropic: 'https://relay2.example.com/anthropic' } })
      expect(((await goodAdd.json()) as any).ok).toBe(true)
      const afterAdd: any = tomlParse(fs.readFileSync(configPath(), 'utf8'))
      expect(afterAdd.providers.custom.protocol).toBe('openai')
      expect(afterAdd.providers.custom.endpoints.anthropic).toBe('https://relay2.example.com/anthropic')
    } finally {
      t.closeAll()
    }
  })

  it('service/fetch-models：编辑弹窗按 id 用已保存 Key 拉取；显式 key 优先；缺 key 报可操作错误', async () => {
    const t = await setup()
    try {
      const origin = `http://127.0.0.1:${t.gwPort}`
      const fm = (body: Record<string, unknown>) =>
        fetch(`http://127.0.0.1:${t.gwPort}/_modeldock/service/fetch-models`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin, 'x-modeldock-admin': 'admin-token-x' },
          body: JSON.stringify(body),
        })
      const ov: any = await (await fetch(`http://127.0.0.1:${t.gwPort}/_modeldock/overview`, { headers: { 'x-modeldock-admin': 'admin-token-x' } })).json()
      const baseUrl = ov.services.find((s: any) => s.id === 'up').base_url

      // 编辑场景：key 留空 + id → 服务端取该服务已保存的 Key（plain ref 即明文）探测上游。
      // mock 上游没有 /v1/models → 探测失败落 400，但错误必须是「拉取失败」而非「key 不能为空」
      const r1 = await fm({ base_url: baseUrl, protocol: 'anthropic', id: 'up' })
      expect(r1.status).toBe(400)
      const j1: any = await r1.json()
      expect(j1.error.message).not.toContain('key')
      const modelsReq = t.requests.find((q) => q.url === '/v1/models')
      expect(modelsReq).toBeTruthy()
      expect(modelsReq!.authorization).toBe('Bearer sk-upstream-secret')

      // 显式 key 优先于已保存 Key（用户在编辑弹窗手输了新 Key 的场景）
      t.requests.length = 0
      const r2 = await fm({ base_url: baseUrl, protocol: 'anthropic', id: 'up', key: 'sk-explicit' })
      expect(r2.status).toBe(400)
      const modelsReq2 = t.requests.find((q) => q.url === '/v1/models')
      expect(modelsReq2).toBeTruthy()
      expect(modelsReq2!.authorization).toBe('Bearer sk-explicit')

      // 无 id 无 key（添加页未贴 Key 就点拉取）→ 400 + 修复建议
      const r3 = await fm({ base_url: baseUrl, protocol: 'anthropic' })
      expect(r3.status).toBe(400)
      const j3: any = await r3.json()
      expect(j3.error.message).toContain('key 不能为空')

      // id 不存在 → 400
      const r4 = await fm({ base_url: baseUrl, protocol: 'anthropic', id: 'nope' })
      expect(r4.status).toBe(400)
      const j4: any = await r4.json()
      expect(j4.error.message).toContain('nope')
    } finally {
      t.closeAll()
    }
  })

  it('resolveTarget：token → harness → route', async () => {
    const h = fakeHome()
    try {
      const cfg: Config = {
        version: 1,
        active_profile: 'p1',
        providers: {
          a: { base_url: 'http://x', protocol: 'anthropic', auth_style: 'bearer', key_ref: 'k' },
        },
        profiles: { p1: { provider: 'a' }, p2: { provider: 'a' } },
        harness: { dsh: { mode: 'gateway', route: 'p2', token: 'tok-dsh' } },
      }
      const rt = buildRuntime(cfg, 'adm')
      const r1 = resolveTarget(rt, 'tok-dsh')
      expect(r1.ok && r1.target.profileName).toBe('p2') // 固定 route 优先
      const r2 = resolveTarget(rt, 'bad')
      expect(!r2.ok && r2.status).toBe(401)
    } finally {
      h.restore()
    }
  })

  it('Web 控制台：页面可访问、token 换 cookie、config/use 端点', async () => {
    const t = await setup()
    try {
      // 页面本身免鉴权可加载
      const page = await fetch(`http://127.0.0.1:${t.gwPort}/_modeldock/ui`)
      expect(page.status).toBe(200)
      const html = await page.text()
      expect(html).toContain('ModelDock')
      expect(html).toContain('模型服务')

      // 错误 token 不种 cookie，仍返回页面（页面内会提示登录）
      const bad = await fetch(`http://127.0.0.1:${t.gwPort}/_modeldock/ui?token=wrong`, { redirect: 'manual' })
      expect(bad.status).toBe(200)
      expect(bad.headers.get('set-cookie')).toBeNull()

      // 正确 token → 302 + HttpOnly cookie
      const login = await fetch(`http://127.0.0.1:${t.gwPort}/_modeldock/ui?token=admin-token-x`, {
        redirect: 'manual',
      })
      expect(login.status).toBe(302)
      const setCookie = login.headers.get('set-cookie') ?? ''
      // cookie 名内嵌端口号：同机双实例（生产+dev）固定名会互顶登录态（RFC 6265 无端口隔离）
      expect(setCookie).toContain(`mdk_admin_${t.gwPort}=`)
      expect(setCookie).toContain('HttpOnly')
      expect(setCookie).toContain('SameSite=Lax')
      const cookie = setCookie.split(';')[0]

      // cookie 访问 config 视图
      const cfgRes = await fetch(`http://127.0.0.1:${t.gwPort}/_modeldock/config`, {
        headers: { cookie },
      })
      expect(cfgRes.status).toBe(200)
      const view: any = await cfgRes.json()
      expect(view.active_profile).toBe('demo')
      expect(view.providers[0].base_url).toContain('127.0.0.1:')
      expect(view.profiles.map((p: any) => p.name)).toContain('demo')
      expect(view.harness.length).toBeGreaterThan(0)

      // 读取端点已收紧：无凭据 → 401（提示用 modeldock ui 打开）
      const noAuth = await fetch(`http://127.0.0.1:${t.gwPort}/_modeldock/config`)
      expect(noAuth.status).toBe(401)

      // use 切换 profile → 持久化到 config.toml 且内存态生效
      const useRes = await fetch(`http://127.0.0.1:${t.gwPort}/_modeldock/use`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ profile: 'other' }),
      })
      expect(((await useRes.json()) as any).ok).toBe(true)
      const onDisk: any = tomlParse(fs.readFileSync(configPath(), 'utf8'))
      expect(onDisk.active_profile).toBe('other')

      // 不存在的 profile → 400
      const badUse = await fetch(`http://127.0.0.1:${t.gwPort}/_modeldock/use`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ profile: 'nope' }),
      })
      expect(badUse.status).toBe(400)
    } finally {
      t.closeAll()
    }
  })

  it('Web 控制台：新建 profile 端点（校验 + 持久化）', async () => {
    const t = await setup()
    try {
      const login = await fetch(`http://127.0.0.1:${t.gwPort}/_modeldock/ui?token=admin-token-x`, {
        redirect: 'manual',
      })
      const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]

      const create = await fetch(`http://127.0.0.1:${t.gwPort}/_modeldock/profile`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({
          name: 'web-made',
          provider: 'up',
          default_model: 'preset-model',
          aliases: { 'claude-haiku-*': 'preset-model' },
        }),
      })
      expect(((await create.json()) as any).ok).toBe(true)
      const onDisk: any = tomlParse(fs.readFileSync(configPath(), 'utf8'))
      expect(onDisk.profiles['web-made'].provider).toBe('up')
      expect(onDisk.profiles['web-made'].aliases['claude-haiku-*']).toBe('preset-model')

      // 重名 / 未知 provider / 坏名称
      const dup = await fetch(`http://127.0.0.1:${t.gwPort}/_modeldock/profile`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ name: 'web-made', provider: 'up' }),
      })
      expect(dup.status).toBe(400)
      const badProvider = await fetch(`http://127.0.0.1:${t.gwPort}/_modeldock/profile`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ name: 'x2', provider: 'nope' }),
      })
      expect(badProvider.status).toBe(400)
      const badName = await fetch(`http://127.0.0.1:${t.gwPort}/_modeldock/profile`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ name: '有空格 name', provider: 'up' }),
      })
      expect(badName.status).toBe(400)
    } finally {
      t.closeAll()
    }
  })
})

describe('自动路由 Phase1', () => {
  function makeRuntime(): { rt: ReturnType<typeof buildRuntime>; config: Config } {
    const config: Config = {
      version: 1,
      active_profile: 'demo',
      gateway: { auto_failover: true },
      providers: {
        A: { name: 'A', base_url: 'http://a.example', protocol: 'anthropic', auth_style: 'bearer', key_ref: 'k1', priority: 2 },
        B: { name: 'B', base_url: 'http://b.example', protocol: 'anthropic', auth_style: 'bearer', key_ref: 'k2', priority: 1 },
        C: { name: 'C', base_url: 'http://c.example', protocol: 'anthropic', auth_style: 'bearer', key_ref: 'k3', priority: 3 },
      },
      profiles: { demo: { provider: 'A', default_model: 'm', fallback: ['C', 'B', 'nope'] } },
      harness: { 'claude-code': { mode: 'gateway', route: 'default', token: TOKEN } },
    }
    return { rt: buildRuntime(config, 't'), config }
  }
  function baseOf(rt: ReturnType<typeof buildRuntime>): ResolvedTarget {
    return { harness: 'claude-code', profileName: 'demo', profile: rt.config.profiles.demo, provider: rt.config.providers.A }
  }

  it('pickTarget：主服务优先，fallback 按 priority 降序（去重/忽略不存在的 id）', () => {
    const { rt } = makeRuntime()
    const r = pickTarget(rt, baseOf(rt), rt.config.profiles.demo.fallback!)
    expect(r.ok).toBe(true)
    const ids = (r as { ok: true; ordered: { providerId: string }[] }).ordered.map((c) => c.providerId)
    expect(ids).toEqual(['A', 'C', 'B']) // A 主；C(pr=3) 先于 B(pr=1)；nope 被忽略
  })

  it('pickTarget：人工钉定主服务压过定时窗口（人为修改优先于程序自动）', () => {
    const { rt } = makeRuntime()
    ;(rt.config.gateway as { auto_route_provider?: string }).auto_route_provider = 'B'
    ;(rt.config.gateway as { schedule?: object }).schedule = {
      enabled: true,
      windows: [{ start: '00:00', end: '23:59', target: 'C' }],
    }
    const r = pickTarget(rt, baseOf(rt), rt.config.profiles.demo.fallback!)
    expect((r as { ok: true; ordered: { providerId: string }[] }).ordered[0].providerId).toBe('B')
  })

  it('pickTarget：钉定服务熔断时顺延到窗口目标，不打死在坏服务上', () => {
    const { rt } = makeRuntime()
    ;(rt.config.gateway as { auto_route_provider?: string }).auto_route_provider = 'B'
    ;(rt.config.gateway as { schedule?: object }).schedule = {
      enabled: true,
      windows: [{ start: '00:00', end: '23:59', target: 'C' }],
    }
    for (let i = 0; i < 3; i++) recordOutcome(rt, 'B', { ok: false, cls: 'connect' })
    const r = pickTarget(rt, baseOf(rt), rt.config.profiles.demo.fallback!)
    expect((r as { ok: true; ordered: { providerId: string }[] }).ordered[0].providerId).toBe('C')
  })

  it('pickTarget：「下一个切换」人工钉定插到备用链首位；ignoreManual 忽略两处钉定', () => {
    const { rt } = makeRuntime()
    ;(rt.config.gateway as { auto_route_provider?: string }).auto_route_provider = 'C' // 主服务钉定
    ;(rt.config.gateway as { route_next?: string }).route_next = 'B' // 下一个切换钉定
    const r = pickTarget(rt, baseOf(rt), rt.config.profiles.demo.fallback!)
    expect((r as { ok: true; ordered: { providerId: string }[] }).ordered.map((c) => c.providerId)).toEqual(['C', 'B', 'A'])
    // ignoreManual：程序自动（无钉定）会选的链，供「当前 · 自动」标签使用
    const auto = pickTarget(rt, baseOf(rt), rt.config.profiles.demo.fallback!, { ignoreManual: true })
    expect((auto as { ok: true; ordered: { providerId: string }[] }).ordered.map((c) => c.providerId)).toEqual(['A', 'C', 'B'])
  })

  it('autoRouteInfo：「下一个切换」自动标签=清本槽钉定后的下一跳；没得切时为 null（界面显示「无备用服务」）', () => {
    const { rt } = makeRuntime()
    // ① 有备用链、未钉定：生效链与自动链一致，都是备用链排序首个（C priority 3）
    let ar = autoRouteInfo(rt)
    expect([ar.next, ar.nextLabel, ar.autoNext, ar.autoNextLabel]).toEqual(['C', 'C', 'C', 'C'])
    // ② 钉定「下一个切换」=B（B 排除在备用链外、优先级调到 5 才会排到 C 前面）：
    //    收起态写钉定生效值 B，自动态写不带钉定的 C——下拉收起/展开两个口径都不说谎
    ;(rt.config.providers.B as { priority?: number }).priority = 5
    rt.config.profiles.demo.fallback = ['C']
    ;(rt.config.gateway as { route_next?: string }).route_next = 'B'
    ar = autoRouteInfo(rt)
    expect(ar.routeNext).toBe('B')
    expect([ar.next, ar.nextLabel]).toEqual(['B', 'B'])
    expect([ar.autoNext, ar.autoNextLabel]).toEqual(['C', 'C'])
    // ③ 钉定主服务 + 未配故障切换顺序：链尾兜底把默认主服务排进来，自动标签应写它（A）——
    //    若按「忽略一切钉定」算，链尾兜底会连同主服务钉定一起被抹掉写成 null，界面只能显示光秃秃的「自动」
    //    （关掉自动备用链：本段验证的是钉定/兜底语义，自动补尾会改变下一跳）
    ;(rt.config.gateway as { auto_fallback?: boolean }).auto_fallback = false
    delete (rt.config.gateway as { route_next?: string }).route_next
    ;(rt.config.gateway as { auto_route_provider?: string }).auto_route_provider = 'B'
    delete rt.config.profiles.demo.fallback
    ar = autoRouteInfo(rt)
    expect([ar.next, ar.nextLabel, ar.autoNext, ar.autoNextLabel]).toEqual(['A', 'A', 'A', 'A'])
    // ④ 既没备用链也没钉定：候选链只剩主服务，没有任何可切目标 → null，界面显示「自动 · 无备用服务」
    delete (rt.config.gateway as { auto_route_provider?: string }).auto_route_provider
    ar = autoRouteInfo(rt)
    expect([ar.next, ar.nextLabel, ar.autoNext, ar.autoNextLabel]).toEqual([null, null, null, null])
  })

  it('pickTarget：auto_failover=false 窗口不参与选主，钉定与备用链照常', () => {
    const { rt } = makeRuntime()
    ;(rt.config.gateway as { auto_failover?: boolean }).auto_failover = false
    ;(rt.config.gateway as { schedule?: object }).schedule = {
      enabled: true,
      windows: [{ start: '00:00', end: '23:59', target: 'C' }],
    }
    const r = pickTarget(rt, baseOf(rt), rt.config.profiles.demo.fallback!)
    expect((r as { ok: true; ordered: { providerId: string }[] }).ordered[0].providerId).toBe('A') // 窗口(C)被跳过
  })

  it('pickTarget：主服务熔断被跳过，仅剩 fallback 可选；全灭返回 down_all', () => {
    const { rt } = makeRuntime()
    ;(rt.config.gateway as { auto_fallback?: boolean }).auto_fallback = false // 本测试只验证熔断语义：关掉自动备用链，B 不会来救场
    for (let i = 0; i < 3; i++) recordOutcome(rt, 'A', { ok: false, cls: 'connect' })
    const base = baseOf(rt)
    const r = pickTarget(rt, base, ['C'])
    expect(r.ok).toBe(true)
    expect((r as { ok: true; ordered: { providerId: string }[] }).ordered.map((c) => c.providerId)).toEqual(['C'])
    for (let i = 0; i < 3; i++) recordOutcome(rt, 'C', { ok: false, cls: 'connect' })
    const r2 = pickTarget(rt, base, ['C'])
    expect(r2.ok).toBe(false)
    expect((r2 as { ok: false; reason: string }).reason).toBe('down_all')
  })

  it('pickTarget：enabled=false 的服务被剔除；layout C 仍可选', () => {
    const { rt } = makeRuntime()
    ;(rt.config.gateway as { auto_fallback?: boolean }).auto_fallback = false // 只验证 enabled 过滤：关掉自动备用链，避免 B 混进断言
    ;(rt.config.providers.A as { enabled?: boolean }).enabled = false
    const r = pickTarget(rt, baseOf(rt), ['C'])
    expect(r.ok).toBe(true)
    expect((r as { ok: true; ordered: { providerId: string }[] }).ordered.map((c) => c.providerId)).toEqual(['C'])
  })

  it('recordOutcome：连续 connect 错 3 次→熔断；连续成功 3 次解熔', () => {
    const { rt } = makeRuntime()
    expect(isMeltdown(rt, 'A')).toBe(false)
    for (let i = 0; i < 3; i++) recordOutcome(rt, 'A', { ok: false, cls: 'connect' })
    expect(isMeltdown(rt, 'A')).toBe(true)
    recordOutcome(rt, 'A', { ok: true })
    recordOutcome(rt, 'A', { ok: true })
    expect(isMeltdown(rt, 'A')).toBe(true)
    recordOutcome(rt, 'A', { ok: true })
    expect(isMeltdown(rt, 'A')).toBe(false)
  })

  it('端到端：主服务连接失败→自动改发 fallback，日志记 reason，B 收到请求', async () => {
    const h = fakeHome()
    const up = await startMockUpstream()
    const base = `http://127.0.0.1:${up.port}`
    const cfg: Config = {
      version: 1,
      active_profile: 'demo',
      gateway: { auto_failover: true },
      providers: {
        A: { name: 'downA', base_url: 'http://127.0.0.1:1', protocol: 'anthropic', auth_style: 'bearer', key_ref: 'sk-a' },
        B: { name: 'upB', base_url: base, protocol: 'anthropic', auth_style: 'bearer', key_ref: 'sk-b' },
      },
      profiles: { demo: { provider: 'A', default_model: 'preset-model', fallback: ['B'] } },
      harness: { 'claude-code': { mode: 'gateway', route: 'default', token: TOKEN } },
    }
    await saveConfig(cfg)
    const rt = buildRuntime(cfg, 'admin-token-x')
    const server = createGatewayServer(rt, { port: 0 })
    const gwPort = await listenEphemeral(server)
    try {
      const res = await fetch(`http://127.0.0.1:${gwPort}/v1/messages`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'preset-model', max_tokens: 10, messages: [] }),
      })
      expect(res.status).toBe(200)
      expect(up.requests.length).toBe(1) // A 端口无监听→connect 失败→改发 B
      const logs: any = await (
        await fetch(`http://127.0.0.1:${gwPort}/_modeldock/logs?n=20`, { headers: { 'x-modeldock-admin': 'admin-token-x' } })
      ).json()
      const last = (logs.logs || []).filter((l: any) => l.harness === 'claude-code').at(-1)
      expect(last.provider).toBe('B')
      expect(last.reason).toContain('failover_to:B')
    } finally {
      server.close()
      up.close()
      h.restore()
    }
  })

  it('端到端：主选直连成功不进 Web 日志表（reason 缺席=无事件），JSONL 照常落盘且不带 reason', async () => {
    const h = fakeHome()
    const up = await startMockUpstream()
    const cfg: Config = {
      version: 1,
      active_profile: 'demo',
      providers: { A: { name: 'upA', base_url: `http://127.0.0.1:${up.port}`, protocol: 'anthropic', auth_style: 'bearer', key_ref: 'sk-a' } },
      profiles: { demo: { provider: 'A', default_model: 'preset-model' } },
      harness: { 'claude-code': { mode: 'gateway', route: 'default', token: TOKEN } },
    }
    await saveConfig(cfg)
    const rt = buildRuntime(cfg, 'admin-token-x')
    const server = createGatewayServer(rt, { port: 0 })
    const gwPort = await listenEphemeral(server)
    try {
      const res = await fetch(`http://127.0.0.1:${gwPort}/v1/messages`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'preset-model', max_tokens: 10, messages: [] }),
      })
      expect(res.status).toBe(200)
      await res.text()
      await new Promise((r) => setTimeout(r, 50)) // 日志 appendFile 异步，稍等落盘
      const logs: any = await (
        await fetch(`http://127.0.0.1:${gwPort}/_modeldock/logs?n=20`, { headers: { 'x-modeldock-admin': 'admin-token-x' } })
      ).json()
      expect((logs.logs || []).filter((l: any) => l.harness === 'claude-code')).toHaveLength(0)
      const dir = logsDir()
      const logFile = fs.readdirSync(dir).filter((f) => f.startsWith('gateway-')).sort().at(-1)!
      const entries = fs.readFileSync(path.join(dir, logFile), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
      const hit = entries.filter((e: any) => e.path?.includes('/v1/messages')).at(-1)
      expect(hit.provider).toBe('A')
      expect(hit.reason).toBeUndefined() // 普通成功不带 reason，防止成功请求重新刷屏日志表
    } finally {
      server.close()
      up.close()
      h.restore()
    }
  })

  it('端到端：auto_failover=false 不自动选主（定时窗口不参与），但故障切换仍可用（主连不上改发 B）', async () => {
    // 双槽位语义：pill 只控制「程序自动选主」；故障切换是基础能力，关着也要在主服务不可达时切到下一个
    const h = fakeHome()
    const up = await startMockUpstream()
    const base = `http://127.0.0.1:${up.port}`
    const cfg: Config = {
      version: 1,
      active_profile: 'demo',
      gateway: { auto_failover: false },
      providers: {
        A: { name: 'downA', base_url: 'http://127.0.0.1:1', protocol: 'anthropic', auth_style: 'bearer', key_ref: 'sk-a' },
        B: { name: 'upB', base_url: base, protocol: 'anthropic', auth_style: 'bearer', key_ref: 'sk-b' },
      },
      profiles: { demo: { provider: 'A', default_model: 'preset-model', fallback: ['B'] } },
      harness: { 'claude-code': { mode: 'gateway', route: 'default', token: TOKEN } },
    }
    await saveConfig(cfg)
    const rt = buildRuntime(cfg, 'admin-token-x')
    const server = createGatewayServer(rt, { port: 0 })
    const gwPort = await listenEphemeral(server)
    try {
      const res = await fetch(`http://127.0.0.1:${gwPort}/v1/messages`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'preset-model', max_tokens: 10, messages: [] }),
      })
      expect(res.status).toBe(200) // A 连不上 → 故障切换到 B（窗口不参与选主，但切换照常）
      expect(up.requests.length).toBe(1)
      const logs: any = await (
        await fetch(`http://127.0.0.1:${gwPort}/_modeldock/logs?n=20`, { headers: { 'x-modeldock-admin': 'admin-token-x' } })
      ).json()
      const last = (logs.logs || []).filter((l: any) => l.harness === 'claude-code').at(-1)
      expect(last.provider).toBe('B')
    } finally {
      server.close()
      up.close()
      h.restore()
    }
  })

  it('端到端（安全）：主服务返回 429 不该改发（请求已送达，禁止重放）→ B 不应收到', async () => {
    // 主服务 A 是一个总是回 429 的真实服务；B 是正常服务。开启 auto_failover + fallback=[B]
    const rateLimit = http.createServer((_req, res) => {
      res.writeHead(429, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'payment required / rate limited' } }))
    })
    const aPort = await new Promise<number>((resolve) => rateLimit.listen(0, '127.0.0.1', () => resolve((rateLimit.address() as AddressInfo).port)))
    const up = await startMockUpstream()
    const h = fakeHome()
    const cfg: Config = {
      version: 1,
      active_profile: 'demo',
      gateway: { auto_failover: true },
      providers: {
        A: { name: 'quotaA', base_url: `http://127.0.0.1:${aPort}`, protocol: 'anthropic', auth_style: 'bearer', key_ref: 'sk-a' },
        B: { name: 'upB', base_url: `http://127.0.0.1:${up.port}`, protocol: 'anthropic', auth_style: 'bearer', key_ref: 'sk-b' },
      },
      profiles: { demo: { provider: 'A', default_model: 'preset-model', fallback: ['B'] } },
      harness: { 'claude-code': { mode: 'gateway', route: 'default', token: TOKEN } },
    }
    await saveConfig(cfg)
    const rt = buildRuntime(cfg, 'admin-token-x')
    const server = createGatewayServer(rt, { port: 0 })
    const gwPort = await listenEphemeral(server)
    try {
      const res = await fetch(`http://127.0.0.1:${gwPort}/v1/messages`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'preset-model', messages: [] }),
      })
      expect(res.status).toBe(429) // 就地回传给客户端，不重放
      expect(up.requests.length).toBe(0) // B 绝不收到 → 证明未改发
    } finally {
      server.close()
      rateLimit.close()
      up.close()
      h.restore()
    }
  })
})

describe('自动备用链（auto fallback）', () => {
  function makeRuntime(autoFallback?: boolean): { rt: ReturnType<typeof buildRuntime>; config: Config } {
    const config: Config = {
      version: 1,
      active_profile: 'demo',
      gateway: { auto_failover: true, ...(autoFallback === undefined ? {} : { auto_fallback: autoFallback }) },
      providers: {
        A: { name: 'A', base_url: 'http://a.example', protocol: 'anthropic', auth_style: 'bearer', key_ref: 'k-a', priority: 2 },
        B: { name: 'B', base_url: 'http://b.example', protocol: 'anthropic', auth_style: 'bearer', key_ref: 'k-b', priority: 1 },
        C: { name: 'C', base_url: 'http://c.example', protocol: 'anthropic', auth_style: 'bearer', key_ref: 'k-c', priority: 3 },
      },
      profiles: { demo: { provider: 'A', default_model: 'm' } }, // 不配 fallback：全靠自动备用链
      harness: { 'claude-code': { mode: 'gateway', route: 'default', token: TOKEN } },
    }
    return { rt: buildRuntime(config, 't'), config }
  }
  function baseOf(rt: ReturnType<typeof buildRuntime>): ResolvedTarget {
    return { harness: 'claude-code', profileName: 'demo', profile: rt.config.profiles.demo, provider: rt.config.providers.A }
  }
  const ids = (r: { ok: boolean; ordered?: { providerId: string }[] }) => (r.ok ? r.ordered!.map((c) => c.providerId) : [])

  it('pickTarget：没配手动链时自动补尾，按 priority 降序；模型名透传（无 override）', () => {
    const { rt } = makeRuntime()
    const r = pickTarget(rt, baseOf(rt), undefined)
    expect(ids(r)).toEqual(['A', 'C', 'B']) // C(pr=3) 先于 B(pr=1)
    const ordered = (r as { ok: true; ordered: { modelOverride?: string }[] }).ordered
    expect(ordered.every((c) => c.modelOverride === undefined)).toBe(true)
  })

  it('pickTarget：自动补尾上限 3 个（手动链不计入）', () => {
    const { rt } = makeRuntime()
    for (const id of ['D', 'E', 'F', 'G']) {
      rt.config.providers[id] = { name: id, base_url: `http://${id}.example`, protocol: 'anthropic', auth_style: 'bearer', key_ref: `k-${id}` }
    }
    const r = pickTarget(rt, baseOf(rt), undefined)
    expect(ids(r)).toEqual(['A', 'C', 'B', 'D']) // 自动补 C/B/D 三个封顶，E/F/G 不进链
  })

  it('pickTarget：enabled=false 与熔断中的服务不进自动链', () => {
    const { rt } = makeRuntime()
    ;(rt.config.providers.C as { enabled?: boolean }).enabled = false
    const r = pickTarget(rt, baseOf(rt), undefined)
    expect(ids(r)).toEqual(['A', 'B'])
    const rt2 = makeRuntime()
    for (let i = 0; i < 3; i++) recordOutcome(rt2.rt, 'C', { ok: false, cls: 'connect' })
    expect(ids(pickTarget(rt2.rt, baseOf(rt2.rt), undefined))).toEqual(['A', 'B'])
  })

  it('pickTarget：当前「优先走」窗口命中的目标排自动链最前（priority 更高也让位）', () => {
    const { rt } = makeRuntime()
    // 钉定主服务压住窗口选主（否则窗口目标直接当主候选），窗口只在自动链排序里生效——
    // 对应真实场景：钉定 coding-plan、窗口指向 agent-plan，主服务挂掉时 agent-plan 排补尾首位
    ;(rt.config.gateway as { auto_route_provider?: string }).auto_route_provider = 'A'
    ;(rt.config.gateway as { schedule?: object }).schedule = {
      enabled: true,
      windows: [{ start: '00:00', end: '23:59', target: 'B' }],
    }
    expect(ids(pickTarget(rt, baseOf(rt), undefined))).toEqual(['A', 'B', 'C'])
  })

  it('pickTarget：auto_fallback=false 关闭自动补尾；缺省（未配置）=开启', () => {
    const off = makeRuntime(false)
    expect(ids(pickTarget(off.rt, baseOf(off.rt), undefined))).toEqual(['A'])
    const def = makeRuntime()
    expect(ids(pickTarget(def.rt, baseOf(def.rt), undefined))).toEqual(['A', 'C', 'B'])
  })

  it('recordOutcome：quota 类 3 次即熔断（阈值低于 429 的 5 次）', () => {
    const { rt } = makeRuntime()
    recordOutcome(rt, 'A', { ok: false, cls: 'quota' })
    recordOutcome(rt, 'A', { ok: false, cls: 'quota' })
    expect(isMeltdown(rt, 'A')).toBe(false)
    recordOutcome(rt, 'A', { ok: false, cls: 'quota' })
    expect(isMeltdown(rt, 'A')).toBe(true)
  })

  it('autoRouteInfo：没配 fallback 时「下一个切换」=自动链首个；关掉自动链才是「无备用服务」', () => {
    const { rt } = makeRuntime()
    const ar = autoRouteInfo(rt)
    expect([ar.next, ar.nextLabel]).toEqual(['C', 'C'])
    ;(rt.config.gateway as { auto_fallback?: boolean }).auto_fallback = false
    const ar2 = autoRouteInfo(rt)
    expect([ar2.next, ar2.nextLabel]).toEqual([null, null])
  })

  it('端到端：主服务 402 额度耗尽（无手动链、未配状态码白名单）→ 自动备用链切换，模型名透传', async () => {
    const h = fakeHome()
    const quota = http.createServer((_req, res) => {
      res.writeHead(402, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'Insufficient Balance (request_id: 893f)', code: 'invalid_request_error' } }))
    })
    const aPort = await new Promise<number>((resolve) => quota.listen(0, '127.0.0.1', () => resolve((quota.address() as AddressInfo).port)))
    const up = await startMockUpstream()
    const cfg: Config = {
      version: 1,
      active_profile: 'demo',
      gateway: { auto_failover: true },
      providers: {
        A: { name: 'quotaA', base_url: `http://127.0.0.1:${aPort}`, protocol: 'anthropic', auth_style: 'bearer', key_ref: 'sk-a' },
        B: { name: 'upB', base_url: `http://127.0.0.1:${up.port}`, protocol: 'anthropic', auth_style: 'bearer', key_ref: 'sk-b' },
      },
      profiles: { demo: { provider: 'A', default_model: 'preset-model' } },
      harness: { 'claude-code': { mode: 'gateway', route: 'default', token: TOKEN } },
    }
    await saveConfig(cfg)
    const rt = buildRuntime(cfg, 'admin-token-x')
    const server = createGatewayServer(rt, { port: 0 })
    const gwPort = await listenEphemeral(server)
    try {
      const res = await fetch(`http://127.0.0.1:${gwPort}/v1/messages`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'preset-model', max_tokens: 10, messages: [] }),
      })
      expect(res.status).toBe(200) // 402 额度耗尽 → 自动切到 B
      expect(up.requests.length).toBe(1)
      expect(JSON.parse(up.requests[0].body).model).toBe('preset-model') // 模型名原样透传，网关不改写
      const logs: any = await (
        await fetch(`http://127.0.0.1:${gwPort}/_modeldock/logs?n=20`, { headers: { 'x-modeldock-admin': 'admin-token-x' } })
      ).json()
      const last = (logs.logs || []).filter((l: any) => l.harness === 'claude-code').at(-1)
      expect(last.provider).toBe('B')
      expect(last.reason).toContain('failover_to:B')
      expect(last.reason).toContain('replayed_from:A')
    } finally {
      server.close()
      quota.close()
      up.close()
      h.restore()
    }
  })

  it('端到端：402 无候选可切时原样回传客户端，错误体保留且提示额度不足', async () => {
    const h = fakeHome()
    const quota = http.createServer((_req, res) => {
      res.writeHead(402, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'Insufficient Balance', code: 'invalid_request_error' } }))
    })
    const aPort = await new Promise<number>((resolve) => quota.listen(0, '127.0.0.1', () => resolve((quota.address() as AddressInfo).port)))
    const cfg: Config = {
      version: 1,
      active_profile: 'demo',
      gateway: { auto_failover: true },
      providers: { A: { name: 'quotaA', base_url: `http://127.0.0.1:${aPort}`, protocol: 'anthropic', auth_style: 'bearer', key_ref: 'sk-a' } },
      profiles: { demo: { provider: 'A', default_model: 'preset-model' } },
      harness: { 'claude-code': { mode: 'gateway', route: 'default', token: TOKEN } },
    }
    await saveConfig(cfg)
    const rt = buildRuntime(cfg, 'admin-token-x')
    const server = createGatewayServer(rt, { port: 0 })
    const gwPort = await listenEphemeral(server)
    try {
      const res = await fetch(`http://127.0.0.1:${gwPort}/v1/messages`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'preset-model', max_tokens: 10, messages: [] }),
      })
      expect(res.status).toBe(402)
      const j: any = await res.json()
      expect(j.error.message).toContain('Insufficient Balance') // 上游错误体原样保留
      expect(j.modeldock.hint).toContain('额度不足') // 提示可操作：识别为额度问题
    } finally {
      server.close()
      quota.close()
      h.restore()
    }
  })

  it('端到端：key 未设置的候选被跳过（不中止链），请求落到链上其余服务', async () => {
    const h = fakeHome()
    const up = await startMockUpstream()
    const cfg: Config = {
      version: 1,
      active_profile: 'demo',
      gateway: { auto_failover: true },
      providers: {
        A: { name: 'downA', base_url: 'http://127.0.0.1:1', protocol: 'anthropic', auth_style: 'bearer', key_ref: 'sk-a' },
        B: { name: 'nokeyB', base_url: `http://127.0.0.1:${up.port}`, protocol: 'anthropic', auth_style: 'bearer', key_ref: 'file:missing-key' },
        C: { name: 'upC', base_url: `http://127.0.0.1:${up.port}`, protocol: 'anthropic', auth_style: 'bearer', key_ref: 'sk-c' },
      },
      profiles: { demo: { provider: 'A', default_model: 'preset-model' } },
      harness: { 'claude-code': { mode: 'gateway', route: 'default', token: TOKEN } },
    }
    await saveConfig(cfg)
    const rt = buildRuntime(cfg, 'admin-token-x')
    const server = createGatewayServer(rt, { port: 0 })
    const gwPort = await listenEphemeral(server)
    try {
      const res = await fetch(`http://127.0.0.1:${gwPort}/v1/messages`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'preset-model', max_tokens: 10, messages: [] }),
      })
      expect(res.status).toBe(200) // A 连不上 → B key 未设置被跳过 → C 正常伺服
      expect(up.requests.length).toBe(1)
      const logs: any = await (
        await fetch(`http://127.0.0.1:${gwPort}/_modeldock/logs?n=20`, { headers: { 'x-modeldock-admin': 'admin-token-x' } })
      ).json()
      const last = (logs.logs || []).filter((l: any) => l.harness === 'claude-code').at(-1)
      expect(last.provider).toBe('C')
      expect(last.reason).toContain('replayed_from:B') // key 缺失候选记入重放对账
    } finally {
      server.close()
      up.close()
      h.restore()
    }
  })
})

describe('自动路由 Phase2：候选链模型映射 + 状态码切换', () => {
  function makeRuntime(): { rt: ReturnType<typeof buildRuntime>; config: Config } {
    const config: Config = {
      version: 1,
      active_profile: 'demo',
      gateway: { auto_failover: true },
      providers: {
        A: { name: 'A', base_url: 'http://a.example', protocol: 'anthropic', auth_style: 'bearer', key_ref: 'k1' },
        B: { name: 'B', base_url: 'http://b.example', protocol: 'anthropic', auth_style: 'bearer', key_ref: 'k2' },
        C: { name: 'C', base_url: 'http://c.example', protocol: 'anthropic', auth_style: 'bearer', key_ref: 'k3' },
      },
      profiles: { demo: { provider: 'A', default_model: 'm', fallback: ['C:m-c', 'B'] } },
      harness: { 'claude-code': { mode: 'gateway', route: 'default', token: TOKEN } },
    }
    return { rt: buildRuntime(config, 't'), config }
  }
  function baseOf(rt: ReturnType<typeof buildRuntime>): ResolvedTarget {
    return { harness: 'claude-code', profileName: 'demo', profile: rt.config.profiles.demo, provider: rt.config.providers.A }
  }

  it('parseFallbackEntry：纯 id / id:model / 多冒号 / 非法', () => {
    expect(parseFallbackEntry('B')).toEqual({ providerId: 'B' })
    expect(parseFallbackEntry('B:m1')).toEqual({ providerId: 'B', model: 'm1' })
    expect(parseFallbackEntry('B:m1:v2')).toEqual({ providerId: 'B', model: 'm1:v2' })
    expect(parseFallbackEntry('  B : m1 ')).toEqual({ providerId: 'B', model: 'm1' })
    expect(parseFallbackEntry('')).toBeNull()
    expect(parseFallbackEntry(':m')).toBeNull()
  })

  it('pickTarget：候选条目携带模型映射，candidate 与 target 均带 override', () => {
    const { rt } = makeRuntime()
    const r = pickTarget(rt, baseOf(rt), rt.config.profiles.demo.fallback!)
    expect(r.ok).toBe(true)
    const ordered = (r as { ok: true; ordered: { providerId: string; modelOverride?: string; target: ResolvedTarget }[] }).ordered
    expect(ordered.map((c) => c.providerId)).toEqual(['A', 'C', 'B'])
    expect(ordered[0].modelOverride).toBeUndefined()
    expect(ordered[1].modelOverride).toBe('m-c')
    expect(ordered[1].target.modelOverride).toBe('m-c')
    expect(ordered[2].modelOverride).toBeUndefined()
    expect(ordered[2].target.modelOverride).toBeUndefined()
  })

  it('pickTarget：同 priority 平局按最近耗时升序；均无数据保配置顺序', () => {
    const { rt } = makeRuntime()
    recordOutcome(rt, 'B', { ok: true, ms: 200 })
    recordOutcome(rt, 'C', { ok: true, ms: 100 })
    const r = pickTarget(rt, baseOf(rt), ['B', 'C'])
    expect((r as { ok: true; ordered: { providerId: string }[] }).ordered.map((c) => c.providerId)).toEqual(['A', 'C', 'B'])
    const rt2 = makeRuntime()
    const r2 = pickTarget(rt2.rt, baseOf(rt2.rt), ['B', 'C'])
    expect((r2 as { ok: true; ordered: { providerId: string }[] }).ordered.map((c) => c.providerId)).toEqual(['A', 'B', 'C'])
  })

  it('端到端：候选带模型映射 → 主服务连不上改发备用，上游收到改写后的模型名', async () => {
    const h = fakeHome()
    const up = await startMockUpstream()
    const cfg: Config = {
      version: 1,
      active_profile: 'demo',
      gateway: { auto_failover: true },
      providers: {
        A: { name: 'downA', base_url: 'http://127.0.0.1:1', protocol: 'anthropic', auth_style: 'bearer', key_ref: 'sk-a' },
        B: { name: 'upB', base_url: `http://127.0.0.1:${up.port}`, protocol: 'anthropic', auth_style: 'bearer', key_ref: 'sk-b' },
      },
      profiles: { demo: { provider: 'A', default_model: 'preset-model', fallback: ['B:m-fallback'] } },
      harness: { 'claude-code': { mode: 'gateway', route: 'default', token: TOKEN } },
    }
    await saveConfig(cfg)
    const rt = buildRuntime(cfg, 'admin-token-x')
    const server = createGatewayServer(rt, { port: 0 })
    const gwPort = await listenEphemeral(server)
    try {
      const res = await fetch(`http://127.0.0.1:${gwPort}/v1/messages`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'preset-model', max_tokens: 10, messages: [] }),
      })
      expect(res.status).toBe(200)
      expect(up.requests.length).toBe(1)
      expect(JSON.parse(up.requests[0].body).model).toBe('m-fallback')
    } finally {
      server.close()
      up.close()
      h.restore()
    }
  })

  it('端到端：failover_status_codes=[429] 时主服务 429 自动改发备用', async () => {
    const rateLimit = http.createServer((_req, res) => {
      res.writeHead(429, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'rate limited' } }))
    })
    const aPort = await new Promise<number>((resolve) =>
      rateLimit.listen(0, '127.0.0.1', () => resolve((rateLimit.address() as AddressInfo).port))
    )
    const up = await startMockUpstream()
    const h = fakeHome()
    const cfg: Config = {
      version: 1,
      active_profile: 'demo',
      gateway: { auto_failover: true, failover_status_codes: [429] },
      providers: {
        A: { name: 'quotaA', base_url: `http://127.0.0.1:${aPort}`, protocol: 'anthropic', auth_style: 'bearer', key_ref: 'sk-a' },
        B: { name: 'upB', base_url: `http://127.0.0.1:${up.port}`, protocol: 'anthropic', auth_style: 'bearer', key_ref: 'sk-b' },
      },
      profiles: { demo: { provider: 'A', default_model: 'preset-model', fallback: ['B'] } },
      harness: { 'claude-code': { mode: 'gateway', route: 'default', token: TOKEN } },
    }
    await saveConfig(cfg)
    const rt = buildRuntime(cfg, 'admin-token-x')
    const server = createGatewayServer(rt, { port: 0 })
    const gwPort = await listenEphemeral(server)
    try {
      const res = await fetch(`http://127.0.0.1:${gwPort}/v1/messages`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'preset-model', messages: [] }),
      })
      expect(res.status).toBe(200) // 429 触发切换，备用服务正常响应
      expect(up.requests.length).toBe(1)
    } finally {
      server.close()
      rateLimit.close()
      up.close()
      h.restore()
    }
  })

  it('openai/responses 端点路径拼接：版本段端点并入 /v1 前缀，host 根端点整段拼接', async () => {
    const h = fakeHome()
    const up = await startMockUpstream()
    const base = `http://127.0.0.1:${up.port}`
    const cfg: Config = {
      version: 1,
      active_profile: 'demo',
      security: { store: 'file' },
      providers: {
        up: {
          name: 'mock',
          base_url: base + '/anthropic',
          protocol: 'anthropic',
          auth_style: 'bearer',
          key_ref: 'sk-upstream-secret',
          // 模拟厂商文档 base_url：方舟式版本段路径（/v3）与 host 根路径两种写法
          endpoints: { openai: base + '/openai/v1', responses: base + '/ark/v3' },
          models: { 'm-a': { source: 'manual' } },
        },
      },
      profiles: { demo: { provider: 'up', default_model: 'm-a' } },
      harness: { 'claude-code': { mode: 'gateway', route: 'default', token: TOKEN } },
    }
    await saveConfig(cfg)
    const rt = buildRuntime(cfg, 'admin-token-x')
    const server = createGatewayServer(rt, { port: 0 })
    const gwPort = await listenEphemeral(server)
    try {
      const hdrs = { 'content-type': 'application/json', authorization: 'Bearer ' + TOKEN }
      await fetch(`http://127.0.0.1:${gwPort}/v1/chat/completions`, { method: 'POST', headers: hdrs, body: JSON.stringify({ model: 'm-a', messages: [] }) })
      await fetch(`http://127.0.0.1:${gwPort}/v1/responses`, { method: 'POST', headers: hdrs, body: JSON.stringify({ model: 'm-a', input: 'hi' }) })
      // 版本段端点：客户端 /v1 前缀并入端点版本，不产生 /v1/v1
      expect(up.requests.some((r) => r.url === '/openai/v1/chat/completions')).toBe(true)
      expect(up.requests.some((r) => r.url === '/ark/v3/responses')).toBe(true)
    } finally {
      server.close()
      up.close()
      h.restore()
    }
  })

  it('service/reveal-key：按需读取已保存 Key，overview 不批量携带明文', async () => {
    const t = await setup()
    try {
      const origin = `http://127.0.0.1:${t.gwPort}`
      const reveal = (id: string) =>
        fetch(`${origin}/_modeldock/service/reveal-key`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin, 'x-modeldock-admin': 'admin-token-x' },
          body: JSON.stringify({ id }),
        })

      // 测试配置里 up 的 key_ref 是明文值，getSecret 应原样解出
      const ok = await reveal('up')
      expect(ok.status).toBe(200)
      expect(((await ok.json()) as any).key).toBe('sk-upstream-secret')

      // 不存在的服务 → 400
      expect((await reveal('nope')).status).toBe(400)

      // 安全底线：Key 只按需取，overview 不批量下发明文
      const raw = await (await fetch(`${origin}/_modeldock/overview`, { headers: { 'x-modeldock-admin': 'admin-token-x' } })).text()
      expect(raw).not.toContain('sk-upstream-secret')
    } finally {
      t.closeAll()
    }
  })

  it('service/update：候选链保存/去重/非法 400/清空 + overview 回显', async () => {
    const h = fakeHome()
    const up = await startMockUpstream()
    const cfg: Config = {
      version: 1,
      active_profile: 'demo',
      providers: {
        A: { name: 'A', base_url: 'http://a.example', protocol: 'anthropic', auth_style: 'bearer', key_ref: 'sk-a' },
        B: { name: 'B', base_url: `http://127.0.0.1:${up.port}`, protocol: 'anthropic', auth_style: 'bearer', key_ref: 'sk-b' },
        C: { name: 'C', base_url: 'http://c.example', protocol: 'anthropic', auth_style: 'bearer', key_ref: 'sk-c' },
      },
      profiles: { demo: { provider: 'A', default_model: 'm' } },
      harness: {},
    }
    await saveConfig(cfg)
    const rt = buildRuntime(cfg, 'admin-token-x')
    const server = createGatewayServer(rt, { port: 0 })
    const gwPort = await listenEphemeral(server)
    const origin = `http://127.0.0.1:${gwPort}`
    const upd = (body: Record<string, unknown>) =>
      fetch(`${origin}/_modeldock/service/update`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin, 'x-modeldock-admin': 'admin-token-x' },
        body: JSON.stringify(body),
      })
    try {
      const ok = await upd({ provider: 'A', fallback: ['B:m-b', 'C', 'B'] })
      expect(((await ok.json()) as any).ok).toBe(true)
      const onDisk: any = tomlParse(fs.readFileSync(configPath(), 'utf8'))
      expect(onDisk.profiles.demo.fallback).toEqual(['B:m-b', 'C']) // 重复 B 去重、保序

      const ov: any = await (await fetch(`${origin}/_modeldock/overview`, { headers: { 'x-modeldock-admin': 'admin-token-x' } })).json()
      const svc = ov.services.find((s: any) => s.id === 'A')
      expect(svc.fallback).toEqual([
        { provider: 'B', model: 'm-b' },
        { provider: 'C', model: null },
      ])

      // 非法：provider 不存在 → 400；解析失败 → 400
      expect((await upd({ provider: 'A', fallback: ['nope'] })).status).toBe(400)
      expect((await upd({ provider: 'A', fallback: [':m'] })).status).toBe(400)

      // 空数组清空
      const clear = await upd({ provider: 'A', fallback: [] })
      expect(((await clear.json()) as any).ok).toBe(true)
      const after: any = tomlParse(fs.readFileSync(configPath(), 'utf8'))
      expect(after.profiles.demo.fallback).toBeUndefined()
      const ov2: any = await (await fetch(`${origin}/_modeldock/overview`, { headers: { 'x-modeldock-admin': 'admin-token-x' } })).json()
      expect(ov2.services.find((s: any) => s.id === 'A').fallback).toEqual([])
    } finally {
      server.close()
      up.close()
      h.restore()
    }
  })

  it('auto-route：failoverOn429 开关持久化，部分更新不互相覆盖', async () => {
    const t = await setup()
    try {
      const base = `http://127.0.0.1:${t.gwPort}`
      const H = { 'x-modeldock-admin': 'admin-token-x', 'content-type': 'application/json' }
      const ar = (body: Record<string, unknown>) =>
        fetch(`${base}/_modeldock/auto-route`, { method: 'POST', headers: H, body: JSON.stringify(body) })
      const ov = () => fetch(`${base}/_modeldock/overview`, { headers: H }).then((r) => r.json())

      const on = await ar({ enabled: true, failoverOn429: true })
      expect(((await on.json()) as any).ok).toBe(true)
      let v: any = await ov()
      expect(v.gateway.autoRoute.failoverOn429).toBe(true)
      let onDisk: any = tomlParse(fs.readFileSync(configPath(), 'utf8'))
      expect(onDisk.gateway.failover_status_codes).toEqual([429, 503])

      // 部分更新：只改强制服务商，failover_status_codes 不被清掉
      await ar({ provider: 'up' })
      onDisk = tomlParse(fs.readFileSync(configPath(), 'utf8'))
      expect(onDisk.gateway.auto_route_provider).toBe('up')
      expect(onDisk.gateway.failover_status_codes).toEqual([429, 503])

      // 关闭
      await ar({ failoverOn429: false })
      v = await ov()
      expect(v.gateway.autoRoute.failoverOn429).toBe(false)
      onDisk = tomlParse(fs.readFileSync(configPath(), 'utf8'))
      expect(onDisk.gateway.failover_status_codes).toBeUndefined()
    } finally {
      t.closeAll()
    }
  })
})

describe('自动路由 Phase3：定时切换', () => {
  function makeRt(schedule: Config['gateway']['schedule']): ReturnType<typeof buildRuntime> {
    const config: Config = {
      version: 1,
      active_profile: 'demo',
      gateway: { auto_failover: true, ...(schedule ? { schedule } : {}) },
      providers: {
        A: { name: 'A', base_url: 'http://a.example', protocol: 'anthropic', auth_style: 'bearer', key_ref: 'k1' },
        B: { name: 'B', base_url: 'http://b.example', protocol: 'anthropic', auth_style: 'bearer', key_ref: 'k2' },
        C: { name: 'C', base_url: 'http://c.example', protocol: 'anthropic', auth_style: 'bearer', key_ref: 'k3' },
      },
      profiles: { demo: { provider: 'A', default_model: 'm', fallback: ['C', 'B'] } },
      harness: { 'claude-code': { mode: 'gateway', route: 'default', token: TOKEN } },
    }
    return buildRuntime(config, 't')
  }
  function baseOf(rt: ReturnType<typeof buildRuntime>): ResolvedTarget {
    return { harness: 'claude-code', profileName: 'demo', profile: rt.config.profiles.demo, provider: rt.config.providers.A }
  }
  /** 覆盖全天的两个互补窗口（00:00-12:00 + 12:00-00:00 跨午夜），使断言不受真实时钟影响 */
  const ALL_DAY = [{ start: '00:00', end: '12:00', target: 'C:m-c' }, { start: '12:00', end: '00:00', target: 'C:m-c' }]

  it('activeScheduleWindow：时段命中/不命中/跨午夜回绕', () => {
    const rt = makeRt({ enabled: true, windows: [{ start: '09:00', end: '12:00', target: 'B' }, { start: '22:00', end: '06:00', target: 'C' }] })
    expect(activeScheduleWindow(rt, new Date(2026, 9, 1, 9, 30))?.target).toBe('B')
    expect(activeScheduleWindow(rt, new Date(2026, 9, 1, 13, 0))).toBeNull() // 午间空档
    expect(activeScheduleWindow(rt, new Date(2026, 9, 1, 23, 30))?.target).toBe('C') // 跨午夜
    expect(activeScheduleWindow(rt, new Date(2026, 9, 1, 5, 0))?.target).toBe('C') // 跨午夜后半夜
    expect(activeScheduleWindow(rt, new Date(2026, 9, 1, 6, 0))).toBeNull() // end 不含
  })

  it('activeScheduleWindow：停用/星期过滤（字面星期几，不看日历）', () => {
    const off = makeRt({ enabled: false, windows: [{ start: '09:00', end: '12:00', target: 'B' }] })
    expect(activeScheduleWindow(off, new Date(2026, 9, 2, 10, 0))).toBeNull()
    // days 过滤：字面周一至五；2026-10-03 是周六
    const wd = makeRt({ enabled: true, windows: [{ start: '09:00', end: '12:00', target: 'B', days: [1, 2, 3, 4, 5] }] })
    expect(activeScheduleWindow(wd, new Date(2026, 9, 3, 10, 0))).toBeNull()
    expect(activeScheduleWindow(wd, new Date(2026, 9, 5, 10, 0))?.target).toBe('B') // 10-05 周一
  })

  it('activeScheduleWindow：全天 00:00–23:59 含入 23:59 这一分钟（当天结束惯例，死亡分钟回归）', () => {
    const rt = makeRt({ enabled: true, windows: [{ start: '00:00', end: '23:59', target: 'B' }] })
    expect(activeScheduleWindow(rt, new Date(2026, 9, 1, 0, 0))?.target).toBe('B')
    expect(activeScheduleWindow(rt, new Date(2026, 9, 1, 12, 0))?.target).toBe('B')
    expect(activeScheduleWindow(rt, new Date(2026, 9, 1, 23, 59))?.target).toBe('B')
    // 非全天窗口的 end 不含语义不受影响（09:00–12:00 在 12:00 不命中）
    const half = makeRt({ enabled: true, windows: [{ start: '09:00', end: '12:00', target: 'B' }] })
    expect(activeScheduleWindow(half, new Date(2026, 9, 1, 11, 59))?.target).toBe('B')
    expect(activeScheduleWindow(half, new Date(2026, 9, 1, 12, 0))).toBeNull()
  })

  /** 写入 holiday-cn 缓存夹具（fakeHome 下），供 dayFilter 日类型判定（daytype.ts 按 mtime 自动重读） */
  function writeCalendar(days: { date: string; isOffDay: boolean }[]): void {
    fs.mkdirSync(path.dirname(holidaysCachePath()), { recursive: true })
    fs.writeFileSync(holidaysCachePath(), JSON.stringify({ fetchedAt: new Date().toISOString(), data: { '2026': { year: 2026, days } } }))
  }

  it('activeScheduleWindow：dayFilter 日类型（节假日/工作日含补班/周末）+ 数据范围外按星期降级', () => {
    // 夹具：2026-10-01（周四）、10-02（周五）法定放假；10-10（周六）调休补班
    const h = fakeHome()
    try {
      writeCalendar([
        { date: '2026-10-01', isOffDay: true },
        { date: '2026-10-02', isOffDay: true },
        { date: '2026-10-10', isOffDay: false },
      ])
      const hol = makeRt({ enabled: true, windows: [{ start: '09:00', end: '12:00', target: 'B', dayFilter: 'holiday' }] })
      expect(activeScheduleWindow(hol, new Date(2026, 9, 1, 10, 0))?.target).toBe('B')
      expect(activeScheduleWindow(hol, new Date(2026, 9, 2, 10, 0))?.target).toBe('B')
      expect(activeScheduleWindow(hol, new Date(2026, 9, 16, 10, 0))).toBeNull() // 普通工作日不命中节假日窗口
      const wd = makeRt({ enabled: true, windows: [{ start: '09:00', end: '12:00', target: 'B', dayFilter: 'workday' }] })
      expect(activeScheduleWindow(wd, new Date(2026, 9, 1, 10, 0))).toBeNull() // 法定节假日不算工作日
      expect(activeScheduleWindow(wd, new Date(2026, 9, 10, 10, 0))?.target).toBe('B') // 调休补班周六视同工作日
      expect(activeScheduleWindow(wd, new Date(2026, 9, 16, 10, 0))?.target).toBe('B')
      expect(activeScheduleWindow(wd, new Date(2026, 9, 17, 10, 0))).toBeNull() // 周末
      expect(activeScheduleWindow(wd, new Date(2028, 9, 13, 10, 0))?.target).toBe('B') // 公布范围外（2028 周五）：按星期降级
      const we = makeRt({ enabled: true, windows: [{ start: '09:00', end: '12:00', target: 'B', dayFilter: 'weekend' }] })
      expect(activeScheduleWindow(we, new Date(2026, 9, 17, 10, 0))?.target).toBe('B')
      expect(activeScheduleWindow(we, new Date(2026, 9, 10, 10, 0))).toBeNull() // 补班周六不是休息日
    } finally {
      h.restore()
    }
  })

  it('activeScheduleWindow：跨午夜窗口的生效日按起始日判定（后半夜归属昨天）', () => {
    // 周五 22:00–06:00：周五晚命中；周六凌晨仍命中（属周五这场）；周六晚/周日凌晨不命中。
    // 旧实现对后半夜用「今天」的星期几判定，周六凌晨会因 dow 不符漏判——本用例回归该修复。
    const rt = makeRt({ enabled: true, windows: [{ start: '22:00', end: '06:00', target: 'B', days: [5] }] })
    expect(activeScheduleWindow(rt, new Date(2026, 9, 2, 23, 30))?.target).toBe('B') // 10-02 周五晚
    expect(activeScheduleWindow(rt, new Date(2026, 9, 3, 5, 59))?.target).toBe('B') // 周六凌晨 → 归属周五
    expect(activeScheduleWindow(rt, new Date(2026, 9, 3, 23, 30))).toBeNull() // 周六晚
    expect(activeScheduleWindow(rt, new Date(2026, 9, 4, 5, 0))).toBeNull() // 周日凌晨 → 归属周六
  })

  /** 同 ALL_DAY：全天互补的避开窗口，断言不受真实时钟影响 */
  const ALL_DAY_AVOID = (target: string) => [
    { start: '00:00', end: '12:00', target, mode: 'avoid' as const },
    { start: '12:00', end: '00:00', target, mode: 'avoid' as const },
  ]

  it('activeAvoidTargets：避开窗口求值（target 剥模型按服务避开；停用跳过；优先窗口不混入）', () => {
    const rt = makeRt({ enabled: true, windows: [{ start: '09:00', end: '12:00', target: 'B:m-x', mode: 'avoid' }, { start: '09:00', end: '12:00', target: 'C' }] })
    expect(activeAvoidTargets(rt, new Date(2026, 9, 1, 10, 0))).toEqual(['B'])
    expect(activeScheduleWindow(rt, new Date(2026, 9, 1, 10, 0))?.target).toBe('C') // 优先窗口不受避开影响
    expect(activeAvoidTargets(rt, new Date(2026, 9, 1, 13, 0))).toEqual([]) // 午间空档
    const off = makeRt({ enabled: false, windows: [{ start: '09:00', end: '12:00', target: 'B', mode: 'avoid' }] })
    expect(activeAvoidTargets(off, new Date(2026, 9, 2, 10, 0))).toEqual([])
  })

  it('pickTarget：避开主服务 → 候选链剔除该服务，其余按优先级顺延', () => {
    // 用户场景：9-12 点不用主服务 A，其他服务都行 → 走 fallback 链
    const rt = makeRt({ enabled: true, windows: ALL_DAY_AVOID('A') })
    const r = pickTarget(rt, baseOf(rt), rt.config.profiles.demo.fallback!)
    expect((r as { ok: true; ordered: { providerId: string }[] }).ordered.map((c) => c.providerId)).toEqual(['C', 'B'])
  })

  it('pickTarget：优先窗口目标恰被避开 → 剔除顺延；避开对强制服务商同样生效', () => {
    // 优先窗口全天指向 C，同时全天避开 C → C 被剔除，走 fallback
    const rt = makeRt({ enabled: true, windows: [...ALL_DAY, ...ALL_DAY_AVOID('C')] })
    const r = pickTarget(rt, baseOf(rt), rt.config.profiles.demo.fallback!)
    expect((r as { ok: true; ordered: { providerId: string }[] }).ordered.map((c) => c.providerId)).toEqual(['B', 'A'])
    // 强制服务商被避开 → 不用它，走 fallback + 主服务兜底
    const rt2 = makeRt({ enabled: true, windows: ALL_DAY_AVOID('B') })
    ;(rt2.config.gateway as any).auto_route_provider = 'B'
    const r2 = pickTarget(rt2, baseOf(rt2), rt2.config.profiles.demo.fallback!)
    expect((r2 as { ok: true; ordered: { providerId: string }[] }).ordered.map((c) => c.providerId)).toEqual(['C', 'A'])
  })

  it('pickTarget：全部候选都被避开时回退原链（软约束，宁可沿用也不无服务可用）', () => {
    const rt = makeRt({ enabled: true, windows: [...ALL_DAY_AVOID('A'), ...ALL_DAY_AVOID('C'), ...ALL_DAY_AVOID('B')] })
    const r = pickTarget(rt, baseOf(rt), rt.config.profiles.demo.fallback!)
    expect((r as { ok: true; ordered: { providerId: string }[] }).ordered.map((c) => c.providerId)).toEqual(['A', 'C', 'B'])
  })

  it('pickTarget：避开主服务且未配故障切换 → 链外其余可用服务按 priority 自动补入（禁用/熔断的除外）', () => {
    const rt = makeRt({ enabled: true, windows: ALL_DAY_AVOID('A') })
    ;(rt.config.providers.C as { priority?: number }).priority = 2
    ;(rt.config.providers.B as { priority?: number }).priority = 1
    const r = pickTarget(rt, baseOf(rt), []) // fallback 为空：候选链只剩被避开的主服务
    expect((r as { ok: true; ordered: { providerId: string }[] }).ordered.map((c) => c.providerId)).toEqual(['C', 'B'])
    // 手动下线的服务不参与补入
    ;(rt.config.providers.C as { enabled?: boolean }).enabled = false
    const r2 = pickTarget(rt, baseOf(rt), [])
    expect((r2 as { ok: true; ordered: { providerId: string }[] }).ordered.map((c) => c.providerId)).toEqual(['B'])
  })

  it('pickTarget：人工钉定压过窗口（服务级，窗口模型改写不参与）；钉定熔断回落窗口目标', () => {
    const rt = makeRt({ enabled: true, windows: ALL_DAY })
    ;(rt.config.gateway as any).auto_route_provider = 'B'
    const r = pickTarget(rt, baseOf(rt), rt.config.profiles.demo.fallback!)
    const ordered = (r as { ok: true; ordered: { providerId: string; modelOverride?: string }[] }).ordered
    expect(ordered.map((c) => c.providerId)).toEqual(['B', 'C', 'A']) // 钉定 B 做主候选（人为>程序自动），其后 fallback 链，A 作最后保底
    expect(ordered[0].modelOverride).toBeUndefined() // 钉定为服务级：窗口模型改写不参与
    // 钉定服务熔断 → 顺延到窗口目标 C（带模型映射），不打死在坏服务上
    for (let i = 0; i < 3; i++) recordOutcome(rt, 'B', { ok: false, cls: 'connect' })
    const r2 = pickTarget(rt, baseOf(rt), [])
    expect((r2 as { ok: true; ordered: { providerId: string }[] }).ordered[0].providerId).toBe('C')
    expect((r2 as { ok: true; ordered: { providerId: string; modelOverride?: string }[] }).ordered[0].modelOverride).toBe('m-c')
  })

  it('端到端：时段窗口指向其他服务+模型，请求按窗口改发并改写模型名', async () => {
    const h = fakeHome()
    const up = await startMockUpstream()
    const now = new Date()
    const hm = (d: Date) => String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
    // 以当前时间为中心的 2 小时窗口（跨午夜场景下 HH:mm 回绕规则天然覆盖）
    const cfg: Config = {
      version: 1,
      active_profile: 'demo',
      gateway: { auto_failover: true, schedule: { enabled: true, windows: [{ start: hm(new Date(now.getTime() - 3600e3)), end: hm(new Date(now.getTime() + 3600e3)), target: 'B:m-fallback' }] } },
      providers: {
        A: { name: 'downA', base_url: 'http://127.0.0.1:1', protocol: 'anthropic', auth_style: 'bearer', key_ref: 'sk-a' },
        B: { name: 'upB', base_url: `http://127.0.0.1:${up.port}`, protocol: 'anthropic', auth_style: 'bearer', key_ref: 'sk-b' },
      },
      profiles: { demo: { provider: 'A', default_model: 'preset-model', fallback: [] } },
      harness: { 'claude-code': { mode: 'gateway', route: 'default', token: TOKEN } },
    }
    await saveConfig(cfg)
    const rt = buildRuntime(cfg, 'admin-token-x')
    const server = createGatewayServer(rt, { port: 0 })
    const gwPort = await listenEphemeral(server)
    try {
      const res = await fetch(`http://127.0.0.1:${gwPort}/v1/messages`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'preset-model', max_tokens: 10, messages: [] }),
      })
      expect(res.status).toBe(200)
      expect(up.requests.length).toBe(1)
      expect(JSON.parse(up.requests[0].body).model).toBe('m-fallback') // 窗口携带的模型映射生效
    } finally {
      server.close()
      up.close()
      h.restore()
    }
  })

  it('auto-route/schedule：保存/校验/持久化 + overview 回显', async () => {
    const t = await setup()
    try {
      const origin = `http://127.0.0.1:${t.gwPort}`
      const ar = (body: Record<string, unknown>) =>
        fetch(`${origin}/_modeldock/auto-route/schedule`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin, 'x-modeldock-admin': 'admin-token-x' },
          body: JSON.stringify(body),
        })
      // 非法输入 → 400
      expect((await ar({ windows: [{ start: '9点', end: '12:00', target: 'up' }] })).status).toBe(400)
      expect((await ar({ windows: [{ start: '09:00', end: '12:00', target: 'nope' }] })).status).toBe(400)
      expect((await ar({ windows: [{ start: '09:00', end: '12:00', target: 'up', dayFilter: 'nope' }] })).status).toBe(400)
      // 合法保存：日类型过滤 + 自定义星期几共存
      const ok = await ar({
        enabled: true,
        windows: [
          { start: '09:00', end: '12:00', target: 'up', dayFilter: 'workday' },
          { start: '13:00', end: '14:00', target: 'up', days: [6] },
        ],
      })
      expect(((await ok.json()) as any).ok).toBe(true)
      const onDisk: any = tomlParse(fs.readFileSync(configPath(), 'utf8'))
      expect(onDisk.gateway.schedule.enabled).toBe(true)
      expect(onDisk.gateway.schedule.holidays).toBeUndefined() // 节假日名单已退役
      expect(onDisk.gateway.schedule.windows).toEqual([
        { start: '09:00', end: '12:00', target: 'up', dayFilter: 'workday' },
        { start: '13:00', end: '14:00', target: 'up', days: [6] },
      ])
      const ov: any = await (await fetch(`${origin}/_modeldock/overview`, { headers: { 'x-modeldock-admin': 'admin-token-x' } })).json()
      expect(ov.gateway.autoRoute.schedule.windows[0].target).toBe('up')
      expect(ov.gateway.autoRoute.schedule.today).toBeTruthy() // 今天日类型（供面板解释时段生效情况）
      // 避开窗口：非法 mode → 400；合法时 mode=avoid 落盘且 target 剥掉模型部分（按整个服务避开）
      expect((await ar({ windows: [{ start: '09:00', end: '12:00', target: 'up', mode: 'nope' }] })).status).toBe(400)
      const nowD = new Date()
      const hm = (d: Date) => String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
      const avWin = { start: hm(new Date(nowD.getTime() - 3600e3)), end: hm(new Date(nowD.getTime() + 3600e3)) }
      const av = await ar({ enabled: true, windows: [{ ...avWin, target: 'up:m-x', mode: 'avoid' }] })
      expect(((await av.json()) as any).ok).toBe(true)
      const onDiskAvoid: any = tomlParse(fs.readFileSync(configPath(), 'utf8'))
      expect(onDiskAvoid.gateway.schedule.windows).toEqual([{ ...avWin, target: 'up', mode: 'avoid' }])
      // overview 回显命中的避开时段（当前路由随之反映避开后的顺延结果）
      const ovAvoid: any = await (await fetch(`${origin}/_modeldock/overview`, { headers: { 'x-modeldock-admin': 'admin-token-x' } })).json()
      expect(ovAvoid.gateway.autoRoute.schedule.activeAvoids).toEqual([{ ...avWin, target: 'up' }])
      // 空窗口清除
      await ar({ enabled: false, windows: [] })
      const after: any = tomlParse(fs.readFileSync(configPath(), 'utf8'))
      expect(after.gateway.schedule).toBeUndefined()
    } finally {
      t.closeAll()
    }
  })
})

describe('添加服务：合并模型目录 + 自定义名称', () => {
  it('提交的模型与预设目录合并保留，且使用自定义名称', async () => {
    const t = await setup()
    try {
      const origin = `http://127.0.0.1:${t.gwPort}`
      const res = await fetch(`http://127.0.0.1:${t.gwPort}/_modeldock/service`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin, 'x-modeldock-admin': 'admin-token-x' },
        body: JSON.stringify({
          presetId: 'deepseek-anthropic', key: 'sk-merge-test', name: '我的DeepSeek', fetch: false,
          models: { 'just-fetched-model': { context_window: 1024, max_output: 512 } },
        }),
      })
      expect(res.status).toBe(200)
      const j: any = await res.json()
      expect(j.providerId).toBe('deepseek')
      const onDisk: any = tomlParse(fs.readFileSync(configPath(), 'utf8'))
      const prov = onDisk.providers['deepseek']
      expect(prov.name).toBe('我的DeepSeek')
      // 预设目录 + 提交模型合并：提交的模型在、预设目录的模型也都在（不再整体替换丢模型）
      const catalog = Object.keys(presetModels(findPreset('deepseek-anthropic')!) ?? {})
      expect(catalog.length).toBeGreaterThan(0)
      const ids = Object.keys(prov.models)
      expect(ids).toContain('just-fetched-model')
      catalog.forEach((m) => expect(ids).toContain(m))
    } finally { t.closeAll() }
  })

  it('同一厂商重复添加 → 独立 id + 自定义名，首个不被覆盖', async () => {
    const t = await setup()
    try {
      const origin = `http://127.0.0.1:${t.gwPort}`
      const add = (name: string, key: string) =>
        fetch(`http://127.0.0.1:${t.gwPort}/_modeldock/service`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin, 'x-modeldock-admin': 'admin-token-x' },
          body: JSON.stringify({ presetId: 'deepseek-anthropic', key, name, fetch: false }),
        }).then((r) => r.json())
      const r1: any = await add('DeepSeek 主用', 'sk-a')
      const r2: any = await add('DeepSeek 备用', 'sk-b')
      expect(r1.providerId).toBe('deepseek')
      expect(r2.providerId).toMatch(/^deepseek(-2)?$/)
      expect(r2.providerId).not.toBe(r1.providerId)
      const onDisk: any = tomlParse(fs.readFileSync(configPath(), 'utf8'))
      expect(onDisk.providers[r1.providerId].name).toBe('DeepSeek 主用')
      expect(onDisk.providers[r2.providerId].name).toBe('DeepSeek 备用')
      expect(onDisk.providers[r1.providerId]).toBeTruthy() // 首个仍在，未被覆盖
    } finally { t.closeAll() }
  })

  it('服务 ID 用预设 slug 派生：同厂商不同协议预设共享短名，靠序号去重', async () => {
    const t = await setup()
    try {
      const origin = `http://127.0.0.1:${t.gwPort}`
      const add = (presetId: string, key: string) =>
        fetch(`http://127.0.0.1:${t.gwPort}/_modeldock/service`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin, 'x-modeldock-admin': 'admin-token-x' },
          body: JSON.stringify({ presetId, key, fetch: false }),
        }).then((r) => r.json())
      const r1: any = await add('deepseek-anthropic', 'sk-1')
      const r2: any = await add('deepseek-openai', 'sk-2')
      expect(r1.providerId).toBe('deepseek')
      expect(r2.providerId).toBe('deepseek-2')
    } finally { t.closeAll() }
  })

  it('拉取收敛：自带目录的预设添加不再自动拉取；无目录预设（自定义）才在线补全', async () => {
    const t = await setup()
    try {
      const origin = `http://127.0.0.1:${t.gwPort}`
      const add = (body: Record<string, unknown>) =>
        fetch(`http://127.0.0.1:${t.gwPort}/_modeldock/service`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin, 'x-modeldock-admin': 'admin-token-x' },
          body: JSON.stringify(body),
        }).then((r) => r.json())
      // 带完整目录的预设：未提交 models 也不发起拉取（上游 0 请求、无失败说明，目录用预设的）
      const ds: any = await add({ presetId: 'deepseek-anthropic', key: 'sk-no-fetch' })
      expect(ds.ok).toBe(true)
      expect(ds.fetched).toBe(0)
      expect(ds.fetchError ?? '').toBe('')
      expect(t.requests.length).toBe(0)
      const cfg: any = tomlParse(fs.readFileSync(configPath(), 'utf8'))
      expect(Object.keys(cfg.providers.deepseek.models)).toContain('deepseek-flash')
      // 无目录预设（custom）：仍自动拉取补全（mock 上游无 /v1/models → 失败，但请求已发出且错误可操作）
      const upUrl: string = cfg.providers.up.base_url
      const cus: any = await add({ presetId: 'custom', key: 'sk-fetch', base_url: upUrl })
      expect(cus.ok).toBe(true)
      expect(cus.fetched).toBe(0)
      expect(String(cus.fetchError ?? '')).toContain('候选')
      expect(t.requests.length).toBeGreaterThan(0)
    } finally { t.closeAll() }
  })
})

describe('自动路由开关', () => {
  it('默认关闭；开启/关闭 + 强制服务商 均持久化并反映到 overview.autoRoute', async () => {
    const t = await setup()
    try {
      const base = `http://127.0.0.1:${t.gwPort}`
      const H = { 'x-modeldock-admin': 'admin-token-x', 'content-type': 'application/json' }
      const ov = () => fetch(`${base}/_modeldock/overview`, { headers: H }).then((r) => r.json())
      const setAr = (enabled: boolean, provider?: string | null | undefined) =>
        fetch(`${base}/_modeldock/auto-route`, { method: 'POST', headers: H, body: JSON.stringify({ enabled, provider }) })

      // 默认关、无强制
      let v: any = await ov()
      expect(v.gateway.autoRoute.on).toBe(false)
      expect(v.gateway.autoRoute.forced).toBeNull()
      expect(v.gateway.autoRoute.provider).toBe('up') // 关时=活动 profile 主服务

      // 开启 → on=true、当前路由仍是主服务
      const on = await setAr(true)
      expect(on.status).toBe(200)
      const onJ: any = await on.json()
      expect(onJ.ok).toBe(true)
      expect(onJ.enabled).toBe(true)
      v = await ov()
      expect(v.gateway.autoRoute.on).toBe(true)
      const onDisk: any = tomlParse(fs.readFileSync(configPath(), 'utf8'))
      expect(onDisk.gateway.auto_failover).toBe(true) // 持久化

      // 强制到 'up' → forced='up'、当前路由='up'
      await setAr(true, 'up')
      v = await ov()
      expect(v.gateway.autoRoute.forced).toBe('up')
      expect(v.gateway.autoRoute.provider).toBe('up')
      expect(v.gateway.autoRoute.providerLabel).toContain('mock')
      const onDisk2: any = tomlParse(fs.readFileSync(configPath(), 'utf8'))
      expect(onDisk2.gateway.auto_route_provider).toBe('up') // 落盘

      // 清除强制 → forced=null
      await setAr(true, null)
      v = await ov()
      expect(v.gateway.autoRoute.forced).toBeNull()

      // 关闭 → on=false
      await setAr(false)
      v = await ov()
      expect(v.gateway.autoRoute.on).toBe(false)
    } finally { t.closeAll() }
  })
})

// 2026-09 审查回归：管理面安全

/** 原始 http 请求（可自定义 Host 头；fetch 不允许改 Host） */
function rawRequest(
  port: number,
  path: string,
  host: string,
  method: 'GET' | 'POST' = 'GET',
  body?: string
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path,
        method,
        headers: { host, ...(body ? { 'content-type': 'application/json' } : {}) },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
      }
    )
    req.on('error', reject)
    req.end(body)
  })
}

describe('管理面安全（2026-09 审查回归）', () => {
  it('GET 管理端点：Host 非本机 → 403（DNS rebinding 封死）；本机 Host 无凭据 → 401', async () => {
    const t = await setup()
    try {
      const evil = await rawRequest(t.gwPort, '/_modeldock/status', 'evil.example.com')
      expect(evil.status).toBe(403)
      const local = await rawRequest(t.gwPort, '/_modeldock/status', `127.0.0.1:${t.gwPort}`)
      expect(local.status).toBe(401)
    } finally {
      t.closeAll()
    }
  })

  it('POST 管理端点：Host 非本机 → 403（修改类同样拦截）', async () => {
    const t = await setup()
    try {
      const evil = await rawRequest(t.gwPort, '/_modeldock/use', 'evil.example.com', 'POST', JSON.stringify({ profile: 'demo' }))
      expect(evil.status).toBe(403)
    } finally {
      t.closeAll()
    }
  })

  it('/overview 不回传 Key 明文（只有 hasKey），响应带 no-store', async () => {
    const t = await setup()
    try {
      const res = await fetch(`http://127.0.0.1:${t.gwPort}/_modeldock/overview`, { headers: { 'x-modeldock-admin': 'admin-token-x' } })
      expect(res.status).toBe(200)
      expect(res.headers.get('cache-control')).toContain('no-store')
      const j: any = await res.json()
      expect(j.services.length).toBeGreaterThan(0)
      for (const s of j.services) {
        expect('key' in s).toBe(false)
        expect(typeof s.hasKey).toBe('boolean')
      }
    } finally {
      t.closeAll()
    }
  })

  it('转发上游：cookie 与 x-modeldock-* 一律剥离，不外泄 admin 凭据', async () => {
    const t = await setup()
    try {
      const res = await fetch(`http://127.0.0.1:${t.gwPort}/v1/messages`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${TOKEN}`,
          cookie: `mdk_admin_${t.gwPort}=admin-token-x; other=1`,
          'x-modeldock-admin': 'admin-token-x',
          'x-modeldock-profile': 'other',
          'content-type': 'application/json',
        },
        body: '{}',
      })
      expect(res.status).toBe(200)
      const req = t.requests.at(-1)!
      expect(req.cookie).toBeUndefined()
      expect(req.modeldockAdmin).toBeUndefined()
    } finally {
      t.closeAll()
    }
  })

  it('钉定 route：按 token 解析，钉住的客户端走自己的 profile（不跟随 active_profile）', async () => {
    const h = fakeHome()
    const up = await startMockUpstream()
    const cfg: Config = {
      version: 1,
      active_profile: 'demo',
      security: { store: 'file' },
      providers: {
        up: {
          name: 'mock',
          base_url: `http://127.0.0.1:${up.port}`,
          protocol: 'anthropic',
          auth_style: 'bearer',
          key_ref: 'sk-upstream-secret',
          models: { 'preset-model': { source: 'preset', context_window: 1000, max_output: 100 } },
        },
      },
      profiles: {
        demo: { provider: 'up', default_model: 'preset-model' },
        other: { provider: 'up', default_model: 'other-model' },
      },
      harness: {
        'claude-code': { mode: 'gateway', route: 'default', token: TOKEN },
        'mimo-desktop': { mode: 'gateway', route: 'other', token: 'mdk_mimo_pinned' },
      },
    }
    await saveConfig(cfg)
    const rt = buildRuntime(cfg, 'admin-token-x')
    const server = createGatewayServer(rt, { port: 0 })
    const gwPort = await listenEphemeral(server)
    try {
      // 同一上游：跟随全局的注入 demo.default_model，钉定的注入 other.default_model
      for (const [token, expectModel] of [
        [TOKEN, 'preset-model'],
        ['mdk_mimo_pinned', 'other-model'],
      ] as const) {
        await fetch(`http://127.0.0.1:${gwPort}/v1/messages`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}` },
          body: JSON.stringify({ messages: [] }),
        })
        expect(JSON.parse(up.requests.at(-1)!.body!).model).toBe(expectModel)
      }
    } finally {
      server.close()
      up.close()
      h.restore()
    }
  })

  it('harness/route：按 profile/服务钉定 + 恢复跟随全局（持久化 + overview 回显 + 立即生效）', async () => {
    const t = await setup()
    try {
      const origin = `http://127.0.0.1:${t.gwPort}`
      const H = { 'content-type': 'application/json', origin, 'x-modeldock-admin': 'admin-token-x' }
      const post = (body: Record<string, unknown>) =>
        fetch(`${origin}/_modeldock/harness/route`, { method: 'POST', headers: H, body: JSON.stringify(body) })

      // 按 profile 钉定 → 落盘 + 下一个请求走钉定 profile 的默认模型
      const r1: any = await (await post({ harness: 'claude-code', profile: 'other' })).json()
      expect(r1.ok).toBe(true)
      expect(r1.route).toBe('other')
      const onDisk: any = tomlParse(fs.readFileSync(configPath(), 'utf8'))
      expect(onDisk.harness['claude-code'].route).toBe('other')
      await fetch(`${origin}/v1/messages`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ messages: [] }),
      })
      expect(JSON.parse(t.requests.at(-1)!.body!).model).toBe('other-model')

      // overview 回显钉定状态
      const ov: any = await (await fetch(`${origin}/_modeldock/overview`, { headers: { 'x-modeldock-admin': 'admin-token-x' } })).json()
      const cc = ov.clients.find((c: any) => c.id === 'claude-code')
      expect(cc.route).toBe('other')
      expect(cc.pinnedProvider).toBe('up')
      expect(cc.followsActive).toBe(false)

      // 按服务钉定：active_profile(demo) 已指向 up → 复用 demo，不新建 profile
      const r2: any = await (await post({ harness: 'claude-code', provider: 'up' })).json()
      expect(r2.ok).toBe(true)
      expect(r2.route).toBe('demo')

      // 恢复跟随全局 → 回到 active_profile 的默认模型
      const r3: any = await (await post({ harness: 'claude-code', default: true })).json()
      expect(r3.route).toBe('default')
      await fetch(`${origin}/v1/messages`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ messages: [] }),
      })
      expect(JSON.parse(t.requests.at(-1)!.body!).model).toBe('preset-model')

      // 错误分支：profile 不存在 / 客户端未接入 / 缺路由目标
      expect((await post({ harness: 'claude-code', profile: 'nope' })).status).toBe(400)
      expect((await post({ harness: 'no-such-harness', provider: 'up' })).status).toBe(400)
      expect((await post({ harness: 'claude-code' })).status).toBe(400)
    } finally {
      t.closeAll()
    }
  })

  it('harness/mode：独立直连 ⇄ 网关接入（重写客户端文件 + 登记 + overview 回显 + 守卫）', async () => {
    const t = await setup()
    // planAttach 要求 claude 命令在场（CI 机器没装）：注入「已安装」，与宿主机解耦（见 presence.ts fakePresence）
    process.env.MODELRDOCK_FAKE_CLAUDE_CODE_PRESENT = '1'
    try {
      const home = process.env.MODELRDOCK_FAKE_HOME as string
      const fs = await import('node:fs')
      const path = await import('node:path')
      const settings = path.join(home, '.claude', 'settings.json')
      fs.mkdirSync(path.dirname(settings), { recursive: true })
      fs.writeFileSync(
        settings,
        JSON.stringify(
          { env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:8687', ANTHROPIC_AUTH_TOKEN: 'mdk_harness_token_abcdef' } },
          null,
          2
        ) + '\n'
      )
      const origin = `http://127.0.0.1:${t.gwPort}`
      const ADMIN = { 'content-type': 'application/json', origin, 'x-modeldock-admin': 'admin-token-x' }
      const mode = (body: Record<string, unknown>) =>
        fetch(`${origin}/_modeldock/harness/mode`, { method: 'POST', headers: ADMIN, body: JSON.stringify(body) })

      // 切直连：route 未钉定 → 落到 active_profile(demo)；写上游 url + 真实 key + 完整模型映射
      const r1: any = await (await mode({ harness: 'claude-code', mode: 'direct' })).json()
      expect(r1.ok).toBe(true)
      expect(r1.mode).toBe('direct')
      expect(r1.profile).toBe('demo')
      const directCfg = JSON.parse(fs.readFileSync(settings, 'utf8'))
      expect(directCfg.env.ANTHROPIC_BASE_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
      expect(directCfg.env.ANTHROPIC_BASE_URL).not.toBe('http://127.0.0.1:8687') // 指向上游而非网关
      expect(directCfg.env.ANTHROPIC_AUTH_TOKEN).toBe('sk-upstream-secret')
      // 根 model 直写 default_model（preset-model 上下文 1000 <1M 无 [1m]）；不写 env.ANTHROPIC_MODEL；
      // 显式 sonnet 别名仍走映射 env；子代理不再钉定（跟随主模型）
      expect(directCfg.model).toBe('preset-model')
      expect(directCfg.env.ANTHROPIC_MODEL).toBeUndefined()
      expect(directCfg.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('ds-flash-target')
      expect(directCfg.env.ANTHROPIC_DEFAULT_SONNET_MODEL_NAME).toBe('ds-flash-target')
      expect(directCfg.env.CLAUDE_CODE_SUBAGENT_MODEL).toBeUndefined()
      expect(directCfg.env.CLAUDE_CODE_EFFORT_LEVEL).toBe('max')
      expect(directCfg.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('786432')

      // 登记 + overview 回显 mode
      const onDisk: any = tomlParse(fs.readFileSync(configPath(), 'utf8'))
      expect(onDisk.harness['claude-code'].mode).toBe('direct')
      expect(onDisk.harness['claude-code'].route).toBe('demo')
      const ov: any = await (await fetch(`${origin}/_modeldock/overview`, { headers: { 'x-modeldock-admin': 'admin-token-x' } })).json()
      const cc = ov.clients.find((c: any) => c.id === 'claude-code')
      expect(cc.mode).toBe('direct')
      expect(cc.pinnedProvider).toBe('up')

      // 直连模式下钉路由被拒（应走 /harness/mode）
      const pinDenied = await fetch(`${origin}/_modeldock/harness/route`, {
        method: 'POST',
        headers: ADMIN,
        body: JSON.stringify({ harness: 'claude-code', provider: 'up' }),
      })
      expect(pinDenied.status).toBe(400)

      // 切回网关：恢复网关地址 + 本地 token，清掉 direct 写入的模型映射与根 model
      // （与 attach 同一端口解析，写实际监听端口）
      const r2: any = await (await mode({ harness: 'claude-code', mode: 'gateway' })).json()
      expect(r2.ok).toBe(true)
      const backCfg = JSON.parse(fs.readFileSync(settings, 'utf8'))
      expect(backCfg.env.ANTHROPIC_BASE_URL).toBe(`http://127.0.0.1:${t.gwPort}`)
      expect(backCfg.env.ANTHROPIC_AUTH_TOKEN).toBe('mdk_harness_token_abcdef')
      expect(backCfg.model).toBeUndefined()
      expect(backCfg.env.ANTHROPIC_MODEL).toBeUndefined()
      expect(backCfg.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBeUndefined()
      expect(backCfg.env.ANTHROPIC_DEFAULT_SONNET_MODEL_NAME).toBeUndefined()
      expect(backCfg.env.CLAUDE_CODE_SUBAGENT_MODEL).toBeUndefined()
      expect(backCfg.env.CLAUDE_CODE_EFFORT_LEVEL).toBeUndefined()
      expect(backCfg.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBeUndefined()

      // 错误分支：已是网关再切网关 / 非法 mode / 未接入客户端
      expect((await mode({ harness: 'claude-code', mode: 'gateway' })).status).toBe(400)
      expect((await mode({ harness: 'claude-code', mode: 'bogus' })).status).toBe(400)
      expect((await mode({ harness: 'no-such', mode: 'direct' })).status).toBe(400)
    } finally {
      delete process.env.MODELRDOCK_FAKE_CLAUDE_CODE_PRESENT
      t.closeAll()
    }
  })

  it('harness/route：钉定/恢复跟随都同步烤模型客户端（dsh）的模型列表', async () => {
    const t = await setup()
    try {
      const home = process.env.MODELRDOCK_FAKE_HOME as string
      const fs = await import('node:fs')
      const path = await import('node:path')
      // dsh 配置里烙着旧模型列表（stale-model）
      const yaml = path.join(home, '.dsh', 'settings.yaml')
      fs.mkdirSync(path.dirname(yaml), { recursive: true })
      fs.writeFileSync(
        yaml,
        'llm-pi-ai:\n  providers:\n    modeldock:\n      api: anthropic-messages\n      baseURL: http://127.0.0.1:8687\n      apiKeyEnv: MODELDOCK_TOKEN\n      models:\n        - id: stale-model\n          name: Stale\n'
      )
      // 登记 dsh harness + 追加第二服务（up2 / profile two，独立模型列表）后刷新 runtime 内存态
      const store = await import('../src/config/store.js')
      const cfg = await store.loadConfig()
      cfg.harness['dsh'] = { mode: 'gateway', route: 'default', token: 'mdk_dsh_test' }
      cfg.providers['up2'] = {
        base_url: 'http://127.0.0.1:1',
        protocol: 'anthropic',
        auth_style: 'bearer',
        key_ref: 'sk-two',
        models: { 'two-model': { source: 'manual' } },
      }
      cfg.profiles['two'] = { provider: 'up2', default_model: 'two-model' }
      await store.saveConfig(cfg)
      const origin = `http://127.0.0.1:${t.gwPort}`
      const ADMIN = { 'content-type': 'application/json', origin, 'x-modeldock-admin': 'admin-token-x' }
      await fetch(`${origin}/_modeldock/reload`, { method: 'POST', headers: ADMIN })

      // 钉到 up2 → route 'two'，模型列表被重写为 two-model
      const r: any = await (
        await fetch(`${origin}/_modeldock/harness/route`, {
          method: 'POST',
          headers: ADMIN,
          body: JSON.stringify({ harness: 'dsh', provider: 'up2' }),
        })
      ).json()
      expect(r.ok).toBe(true)
      expect(r.route).toBe('two')
      expect(r.refreshed).toEqual(['dsh'])
      let after = fs.readFileSync(yaml, 'utf8')
      expect(after).toContain('two-model')
      expect(after).not.toContain('stale-model')
      expect(after).toContain(`http://127.0.0.1:${t.gwPort}`) // 仍指向网关（网关模式，钉定 ≠ 直连）

      // 恢复跟随全局 → 按 active_profile(demo/up) 重写回 preset-model
      const r2: any = await (
        await fetch(`${origin}/_modeldock/harness/route`, {
          method: 'POST',
          headers: ADMIN,
          body: JSON.stringify({ harness: 'dsh', default: true }),
        })
      ).json()
      expect(r2.ok).toBe(true)
      expect(r2.route).toBe('default')
      expect(r2.refreshed).toEqual(['dsh'])
      after = fs.readFileSync(yaml, 'utf8')
      expect(after).toContain('preset-model')
      expect(after).not.toContain('two-model')
    } finally {
      t.closeAll()
    }
  })

  it('service/delete：有客户端钉定在该服务路由上时拒绝删除，解除后可删', async () => {
    const t = await setup()
    try {
      const origin = `http://127.0.0.1:${t.gwPort}`
      const H = { 'content-type': 'application/json', origin, 'x-modeldock-admin': 'admin-token-x' }
      const post = (p: string, body: Record<string, unknown>) =>
        fetch(`${origin}/_modeldock/${p}`, { method: 'POST', headers: H, body: JSON.stringify(body) })

      // 钉到 demo（指向 up）后删除 up → 拒绝
      const pin: any = await (await post('harness/route', { harness: 'claude-code', provider: 'up' })).json()
      expect(pin.route).toBe('demo')
      const del = await post('service/delete', { provider: 'up' })
      expect(del.status).toBe(400)
      expect(await del.text()).toContain('钉定')

      // 解除钉定 → 可删
      const unpin = await post('harness/route', { harness: 'claude-code', default: true })
      expect(unpin.status).toBe(200)
      const del2 = await post('service/delete', { provider: 'up' })
      expect(del2.status).toBe(200)
      const j: any = await del2.json()
      expect(j.ok).toBe(true)
      expect(j.removed).toBe('up')
    } finally {
      t.closeAll()
    }
  })

  it('service/delete：file 模式客户端（自管路由）不构成钉定，删除放行且悬空 route 复位', async () => {
    const h = fakeHome()
    const up = await startMockUpstream()
    const base = `http://127.0.0.1:${up.port}`
    const cfg: Config = {
      version: 1,
      active_profile: 'demo',
      security: { store: 'file' },
      providers: { up: { name: 'mock', base_url: base, protocol: 'anthropic', auth_style: 'bearer', key_ref: 'sk-up' } },
      profiles: { demo: { provider: 'up', default_model: 'preset-model' } },
      harness: { dsh: { mode: 'file', route: 'demo', token: 'tok-dsh' } }, // file 模式：客户端自管路由，route 仅登记痕迹
    }
    await saveConfig(cfg)
    const rt = buildRuntime(cfg, 'admin-token-x')
    const server = createGatewayServer(rt, { port: 0 })
    const gwPort = await listenEphemeral(server)
    const origin = `http://127.0.0.1:${gwPort}`
    try {
      const res = await fetch(`${origin}/_modeldock/service/delete`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin, 'x-modeldock-admin': 'admin-token-x' },
        body: JSON.stringify({ provider: 'up' }),
      })
      expect(res.status).toBe(200)
      const j: any = await res.json()
      expect(j.ok).toBe(true)
      expect(j.removed).toBe('up')
      // file 模式的悬空 route 随删除复位 default，不残留指向已删 profile 的引用
      const onDisk = tomlParse(fs.readFileSync(configPath(), 'utf8'))
      expect(onDisk.harness['dsh'].route).toBe('default')
    } finally {
      server.closeAllConnections?.()
      server.close()
      up.close()
      h.restore()
    }
  })

  it('service/delete：direct 模式客户端删除被拦，文案引导先断开/切回网关', async () => {
    const h = fakeHome()
    const up = await startMockUpstream()
    const base = `http://127.0.0.1:${up.port}`
    const cfg: Config = {
      version: 1,
      active_profile: 'demo',
      security: { store: 'file' },
      providers: { up: { name: 'mock', base_url: base, protocol: 'anthropic', auth_style: 'bearer', key_ref: 'sk-up' } },
      profiles: { demo: { provider: 'up', default_model: 'preset-model' } },
      harness: { dsh: { mode: 'direct', route: 'demo', token: 'tok-dsh' } }, // direct：客户端文件已写死该服务 URL+Key
    }
    await saveConfig(cfg)
    const rt = buildRuntime(cfg, 'admin-token-x')
    const server = createGatewayServer(rt, { port: 0 })
    const gwPort = await listenEphemeral(server)
    const origin = `http://127.0.0.1:${gwPort}`
    try {
      const res = await fetch(`${origin}/_modeldock/service/delete`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin, 'x-modeldock-admin': 'admin-token-x' },
        body: JSON.stringify({ provider: 'up' }),
      })
      expect(res.status).toBe(400)
      const text = await res.text()
      expect(text).toContain('独立直连') // 可执行指引（detach/切回网关），而非「改回跟随全局」死胡同
    } finally {
      server.closeAllConnections?.()
      server.close()
      up.close()
      h.restore()
    }
  })

  it('clientProtocolFromPath：embeddings 归 openai，未知路径回退 provider 协议', () => {
    expect(clientProtocolFromPath('/v1/embeddings', 'anthropic')).toBe('openai')
    expect(clientProtocolFromPath('/v1/chat/completions', 'anthropic')).toBe('openai')
    expect(clientProtocolFromPath('/v1/responses', 'anthropic')).toBe('responses')
    expect(clientProtocolFromPath('/v1/messages', 'anthropic')).toBe('anthropic')
    // 未知路径（/v1/models 等非对话端点）回退 provider 自身协议，而不是硬编码 anthropic
    expect(clientProtocolFromPath('/v1/models', 'openai')).toBe('openai')
    expect(clientProtocolFromPath('/v1/models', 'anthropic')).toBe('anthropic')
  })

  it('endpointRisks：公网 https 无风险；公网明文 http 与内网/本机地址给提示', () => {
    // 正常公网 https：无风险提示
    expect(endpointRisks('https://api.deepseek.com/anthropic')).toEqual([])
    // 公网明文 http：key 会明文过网
    expect(endpointRisks('http://api.example.com/v1')).toEqual([expect.stringContaining('明文 http')])
    // 本机回环：http 不重复提示明文（不出本机），但提示本机地址
    const loop = endpointRisks('http://127.0.0.1:11434/v1')
    expect(loop).toHaveLength(1)
    expect(loop[0]).toContain('本机/内网')
    expect(endpointRisks('http://localhost:8080')[0]).toContain('本机/内网')
    expect(endpointRisks('http://[::1]:8080')[0]).toContain('本机/内网')
    // 内网网段：10/8、172.16/12、192.168/16、169.254/16、0.x
    expect(endpointRisks('http://10.0.0.5/v1').some((r) => r.includes('本机/内网'))).toBe(true)
    expect(endpointRisks('http://172.16.1.1/v1').some((r) => r.includes('本机/内网'))).toBe(true)
    expect(endpointRisks('http://172.31.255.1/v1').some((r) => r.includes('本机/内网'))).toBe(true)
    expect(endpointRisks('http://192.168.1.2/v1').some((r) => r.includes('本机/内网'))).toBe(true)
    expect(endpointRisks('http://169.254.0.1/v1').some((r) => r.includes('本机/内网'))).toBe(true)
    // 172.15 / 172.32 不在 172.16/12 内：公网地址只报明文，不报内网
    expect(endpointRisks('http://172.15.0.1/v1').some((r) => r.includes('本机/内网'))).toBe(false)
    expect(endpointRisks('http://172.32.0.1/v1').some((r) => r.includes('本机/内网'))).toBe(false)
    // 内网主机名后缀
    expect(endpointRisks('https://gw.corp.internal/v1')[0]).toContain('本机/内网')
    // 内网 https：只提示内网、不提示明文
    expect(endpointRisks('https://192.168.1.2/v1')).toEqual([expect.stringContaining('本机/内网')])
    // 非法 URL：不抛错、无提示（格式校验在别处）
    expect(endpointRisks('not a url')).toEqual([])
  })

  it('writeGatewayState 原子写：内容可读回、0600 权限、不留 tmp 残留', async () => {
    const h = fakeHome()
    try {
      const state = { pid: 12345, port: 18990, admin_token: 'mdkadm_' + 'a'.repeat(40), started_at: '2026-09-30T00:00:00' }
      await writeGatewayState(state)
      expect(await readGatewayState()).toEqual(state)
      if (process.platform !== 'win32') {
        expect(fs.statSync(gatewayStatePath()).mode & 0o777).toBe(0o600)
      }
      // tmp + rename 原子写：目录里不应残留 .gateway.json.* 临时文件
      const leftovers = fs
        .readdirSync(path.dirname(gatewayStatePath()))
        .filter((f) => f.startsWith('.gateway.json.'))
      expect(leftovers).toEqual([])
    } finally {
      h.restore()
    }
  })

  it('错误管道：管理面端点漏出的非法 JSON 得 400 与原文案，而非 500', async () => {
    const t = await setup()
    try {
      const origin = `http://127.0.0.1:${t.gwPort}`
      // jsonRequestBody 在 switch 端点局部 try 之外：此前飞到顶层被吞成 500「网关内部错误」
      const res = await fetch(`${origin}/_modeldock/switch`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin, 'x-modeldock-admin': 'admin-token-x' },
        body: '{invalid',
      })
      expect(res.status).toBe(400)
      expect(await res.text()).toContain('请求体必须是 JSON')
    } finally {
      t.closeAll()
    }
  })

  it('错误管道：坏 TOML 下写配置的 ConfigError 以 400 与可操作信息透出', async () => {
    const t = await setup()
    try {
      const origin = `http://127.0.0.1:${t.gwPort}`
      const H = { 'content-type': 'application/json', origin, 'x-modeldock-admin': 'admin-token-x' }
      // 把磁盘配置写坏（非法 TOML）：/service/delete 的 mutateConfig 读盘即抛 ConfigError，
      // 此前会被顶层吞成 500「网关内部错误」，丢失「modeldock config edit / restore」的指引
      await fs.promises.writeFile(configPath(), 'this is not [valid toml')
      const res = await fetch(`${origin}/_modeldock/service/delete`, {
        method: 'POST', headers: H, body: JSON.stringify({ provider: 'up' }),
      })
      expect(res.status).toBe(400)
      const text = await res.text()
      expect(text).toContain('config.toml')
      expect(text).toContain('restore')
    } finally {
      t.closeAll()
    }
  })

  it('service/delete 级联清理备用链、自动路由与定时窗口（与 CLI 共用 removeProviderCascade）', async () => {
    const t = await setup()
    try {
      const origin = `http://127.0.0.1:${t.gwPort}`
      const H = { 'content-type': 'application/json', origin, 'x-modeldock-admin': 'admin-token-x' }
      const post = (p: string, body: Record<string, unknown>) =>
        fetch(`${origin}/_modeldock/${p}`, { method: 'POST', headers: H, body: JSON.stringify(body) })
      // 磁盘配置上布置引用网：demo/other 引用 up，k3 备用链含 up，up 是自动路由强制服务，
      // 定时窗口两条目标含 up —— 删除 up 后应全部清理且不影响 keep
      const cfg: Config = {
        version: 1,
        active_profile: 'demo',
        security: { store: 'file' },
        providers: {
          up: { name: 'mock', base_url: 'http://127.0.0.1:9', protocol: 'anthropic', auth_style: 'bearer', key_ref: 'sk-upstream-secret' },
          keep: { name: 'keep', base_url: 'http://127.0.0.1:9', protocol: 'openai', auth_style: 'bearer', key_ref: 'file:keep' },
        },
        profiles: {
          demo: { provider: 'up', default_model: 'preset-model' },
          other: { provider: 'up', default_model: 'other-model' },
          k3: { provider: 'keep', fallback: ['up:alt', 'keep'] },
        },
        harness: { 'claude-code': { mode: 'gateway', route: 'default', token: TOKEN } },
        gateway: {
          auto_route_provider: 'up',
          schedule: {
            windows: [
              { start: '00:30', end: '08:30', target: 'up:m1' },
              { start: '09:00', end: '12:00', target: 'up', mode: 'avoid' },
              { start: '14:00', end: '18:00', target: 'keep:km' },
            ],
          },
        },
      }
      await saveConfig(cfg)
      const del = await post('service/delete', { provider: 'up' })
      expect(del.status).toBe(200)
      const after = tomlParse(fs.readFileSync(configPath(), 'utf8')) as any
      expect(after.providers.up).toBeUndefined()
      expect(after.providers.keep).toBeTruthy()
      expect(after.profiles.demo).toBeUndefined()
      expect(after.profiles.other).toBeUndefined()
      expect(after.profiles.k3.fallback).toEqual(['keep'])
      expect(after.gateway.auto_route_provider).toBeUndefined()
      expect(after.gateway.schedule.holidays).toBeUndefined()
      expect(after.gateway.schedule.windows).toEqual([{ start: '14:00', end: '18:00', target: 'keep:km' }])
      // 再删一次：内存态已经 reload，服务不存在 → 400
      const del2 = await post('service/delete', { provider: 'up' })
      expect(del2.status).toBe(400)
    } finally {
      t.closeAll()
    }
  })
})

describe('displayRouteProvider：烤模型客户端的展示路由（人工当前 > prefer 窗口 > active_profile）', () => {
  const pa = { name: 'A', base_url: 'https://a.example.com', protocol: 'anthropic' as const, auth_style: 'bearer' as const, key_ref: 'file:a' }
  const pb = { ...pa, name: 'B', base_url: 'https://b.example.com', key_ref: 'file:b' }

  function mkRt(gateway: Config['gateway'], activeProfile = 'proA') {
    const cfg: Config = {
      version: 1,
      active_profile: activeProfile,
      security: { store: 'file' },
      providers: { pa, pb },
      profiles: { proA: { provider: 'pa', default_model: 'a' }, proB: { provider: 'pb', default_model: 'b' } },
      gateway,
    }
    return buildRuntime(cfg, 't')
  }

  it('无窗口/无人工当前：回落 active_profile 的服务', () => {
    const rt = mkRt({ auto_failover: true })
    expect(displayRouteProvider(rt)).toBe('pa')
  })

  it('prefer 窗口接管（仅 auto_failover 开启时参与）', () => {
    const rt = mkRt({ auto_failover: true, schedule: { enabled: true, windows: [{ start: '00:00', end: '23:59', target: 'pb' }] } })
    expect(displayRouteProvider(rt)).toBe('pb')
    // 自动故障切换关闭 → 窗口不参与
    rt.config.gateway!.auto_failover = false
    expect(displayRouteProvider(rt)).toBe('pa')
    // schedule 停用同理
    rt.config.gateway!.auto_failover = true
    rt.config.gateway!.schedule = { enabled: false, windows: [{ start: '00:00', end: '23:59', target: 'pb' }] }
    expect(displayRouteProvider(rt)).toBe('pa')
  })

  it('人工「当前」优先于窗口；窗口 target 带模型部分时按服务粒度解析', () => {
    const rt = mkRt({ auto_failover: true, auto_route_provider: 'pa', schedule: { enabled: true, windows: [{ start: '00:00', end: '23:59', target: 'pb:b-model' }] } })
    expect(displayRouteProvider(rt)).toBe('pa')
    delete rt.config.gateway!.auto_route_provider
    expect(displayRouteProvider(rt)).toBe('pb')
  })

  it('窗口目标服务不存在：回落 active_profile', () => {
    const rt = mkRt({ auto_failover: true, schedule: { enabled: true, windows: [{ start: '00:00', end: '23:59', target: 'ghost' }] } })
    expect(displayRouteProvider(rt)).toBe('pa')
  })
})

describe('routeState：统一「正在使用」口径（钉定 > 可用窗口 > 默认，模型随目标服务）', () => {
  const pa = { name: 'A', base_url: 'https://a.example.com', protocol: 'anthropic' as const, auth_style: 'bearer' as const, key_ref: 'file:a' }
  const pb = { ...pa, name: 'B', base_url: 'https://b.example.com', key_ref: 'file:b' }

  function mkRt(gateway: Config['gateway'], activeProfile = 'proA') {
    const cfg: Config = {
      version: 1,
      active_profile: activeProfile,
      security: { store: 'file' },
      // 每个用例独立 provider 对象：某个用例改 enabled 不污染后续用例
      providers: { pa: { ...pa }, pb: { ...pb } },
      profiles: { proA: { provider: 'pa', default_model: 'a' }, proB: { provider: 'pb', default_model: 'b' } },
      gateway,
    }
    return buildRuntime(cfg, 't')
  }
  const winB = { start: '00:00', end: '23:59', target: 'pb' }

  it('窗口接管：生效服务/模型取窗口目标服务的 profile，default 仍是 active_profile', () => {
    const rt = mkRt({ auto_failover: true, schedule: { enabled: true, windows: [winB] } })
    const rs = routeState(rt)
    expect(rs.effective).toMatchObject({ providerId: 'pb', model: 'b', source: 'schedule' })
    expect(rs.default).toMatchObject({ providerId: 'pa', model: 'a' })
    expect(rs.schedule).toMatchObject({ applied: true, suppressedBy: null })
    expect(rs.schedule.hit).toMatchObject({ start: '00:00', end: '23:59', target: 'pb' })
  })

  it('窗口带模型映射：模型改写值优先于目标服务默认模型', () => {
    const rt = mkRt({ auto_failover: true, schedule: { enabled: true, windows: [{ ...winB, target: 'pb:b-override' }] } })
    expect(routeState(rt).effective).toMatchObject({ providerId: 'pb', model: 'b-override', source: 'schedule' })
  })

  it('人工钉定压过窗口：source=pinned、窗口 hit 但 applied=false', () => {
    const rt = mkRt({ auto_failover: true, auto_route_provider: 'pa', schedule: { enabled: true, windows: [winB] } })
    const rs = routeState(rt)
    expect(rs.effective).toMatchObject({ providerId: 'pa', model: 'a', source: 'pinned' })
    expect(rs.schedule).toMatchObject({ applied: false, suppressedBy: 'pin' })
  })

  it('窗口目标下线 → 回落默认路由，并说明未接管原因', () => {
    const rt = mkRt({ auto_failover: true, schedule: { enabled: true, windows: [winB] } })
    ;(rt.config.providers.pb as { enabled?: boolean }).enabled = false
    const rs = routeState(rt)
    expect(rs.effective).toMatchObject({ providerId: 'pa', source: 'default' })
    expect(rs.schedule).toMatchObject({ applied: false, suppressedBy: 'unavailable' })
  })

  it('自动选主关闭：窗口不参与，suppressedBy=off', () => {
    const rt = mkRt({ auto_failover: false, schedule: { enabled: true, windows: [winB] } })
    const rs = routeState(rt)
    expect(rs.effective).toMatchObject({ providerId: 'pa', source: 'default' })
    expect(rs.schedule).toMatchObject({ applied: false, suppressedBy: 'off' })
  })

  it('钉定服务熔断且无窗口：降到自动备用链，标记 failover/degradedFrom=pinned', () => {
    const rt = mkRt({ auto_failover: true, auto_route_provider: 'pa' })
    for (let i = 0; i < 3; i++) recordOutcome(rt, 'pa', { ok: false, cls: 'connect' })
    const rs = routeState(rt)
    expect(rs.effective.providerId).toBe('pb')
    expect(rs.effective.source).toBe('failover')
    expect(rs.effective.degradedFrom).toBe('pinned')
  })

  it('展示路由忽略熔断但跳过已下线：钉定服务下线后写回默认路由', () => {
    const rt = mkRt({ auto_failover: true, auto_route_provider: 'pa' }, 'proB')
    ;(rt.config.providers.pa as { enabled?: boolean }).enabled = false
    expect(displayRouteProvider(rt)).toBe('pb')
  })

  it('autoRouteInfo 与 routeState 同源：手机/桌面读到的服务、模型、来源一致', () => {
    const rt = mkRt({ auto_failover: true, schedule: { enabled: true, windows: [winB] } })
    const rs = routeState(rt)
    const ar = autoRouteInfo(rt)
    expect([ar.provider, ar.model, ar.source, ar.schedule.applied, ar.defaultProvider]).toEqual([
      rs.effective.providerId,
      rs.effective.model,
      rs.effective.source,
      rs.schedule.applied,
      rs.default.providerId,
    ])
  })
})
