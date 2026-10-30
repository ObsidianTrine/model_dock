import fs from 'node:fs'
import { loadConfig } from '../config/store.js'
import { DEFAULT_GATEWAY_PORT, DEFAULT_LAN_PORT, type Config } from '../config/types.js'
import { migrateSecretsToSecure } from '../ops.js'
import { ensureDir, randomToken, drainAppendStreams } from '../util/fsx.js'
import { t } from '../util/i18n.js'
import { localIsoTs } from '../util/time.js'
import { gatewayStatePath, modeldockDir } from '../util/paths.js'
import { endpointRisks } from './relay.js'
import { lanPrimaryUrl, resolveLanToken, startLanServer } from './lan.js'
import { buildRuntime, clearGatewayState, logEvent, pidAlive, pushRing, readGatewayState, reloadRuntime, setEventRingSink, writeGatewayState } from './state.js'
import { createGatewayServer } from './server.js'
import { warmupOverview } from './overview-view.js'
import { listenWithRetry } from './shared.js'
import { startBootUpdateCheck } from '../update/webupdate.js'
import { remountSyncEngine, stopSyncEngine } from '../sync/engine.js'
import { switchToService } from '../ops.js'
import { appendCrashLog, installCrashHandlers } from '../util/crash.js'
import { startEventLoopDelaySampler } from './state.js'

// 崩溃痕迹兜底：本模块是 --sea-gateway 守护进程入口，daemon 由 stdio 收敛拉起，未处理异常/
// rejection 此前凭空蒸发（无任何落盘）。幂等，cli.ts 已装也不重复。
installCrashHandlers()

async function healthOk(port: number): Promise<boolean> {
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 1000)
    const res = await fetch(`http://127.0.0.1:${port}/_modeldock/health`, { signal: ctrl.signal })
    clearTimeout(t)
    return res.ok
  } catch {
    return false
  }
}

/** 决定本次网关的 admin token：gateway.json 里的旧 token 格式合法（mdkadm_ + 十六进制）就复用，
 *  否则新生成。token 跨重启稳定后，浏览器 cookie 不用每次重新登录（参考 dsh 的持久签名密钥做法）；
 *  显式轮换用 `modeldock gateway rotate-token`。校验格式是为了不把被手改坏的值带进运行时。 */
export function resolveAdminToken(previous: string | null | undefined): string {
  if (previous && /^mdkadm_[0-9a-f]{32,}$/.test(previous)) return previous
  return randomToken('mdkadm')
}

/** Web 控制台启动横幅。stdout 是交互终端时输出带 token 的地址（点开即种 cookie，dsh 的 URL line 做法）；
 *  输出被重定向（>log、nohup、管道、systemd）时 token 会明文落盘，降级为不带 token 的地址 + 提示 modeldock ui */
export function consoleBanner(port: number, adminToken: string, isTty: boolean): string {
  if (isTty) return t('[modeldock] Web 控制台：http://127.0.0.1:{port}/_modeldock/ui?token={token}', '[modeldock] Web console: http://127.0.0.1:{port}/_modeldock/ui?token={token}', { port, token: adminToken })
  return t(
    '[modeldock] Web 控制台：http://127.0.0.1:{port}/_modeldock/ui（输出重定向，令牌未打印；modeldock ui 一键打开）',
    '[modeldock] Web console: http://127.0.0.1:{port}/_modeldock/ui (output redirected, token not printed; run "modeldock ui" to open)',
    { port }
  )
}

/** 启动/重载时对全部 provider 端点做风险提示（明文 http、本机/内网地址），只告警不阻断 */
function logEndpointRisks(cfg: Config): void {
  for (const [id, p] of Object.entries(cfg.providers)) {
    const urls = [p.base_url, ...Object.values(p.endpoints ?? {})]
    for (const u of urls) {
      if (!u) continue
      for (const r of endpointRisks(u)) {
        console.error(t('[modeldock] ⚠ provider「{name}」{url}：{risk}', '[modeldock] ⚠ provider "{name}" {url}: {risk}', { name: p.name ?? id, url: u, risk: r }))
      }
    }
  }
}

/** 前台启动网关（CLI `gateway start` 与守护进程入口共用） */
export async function startForeground(portOverride?: number): Promise<void> {
  const cfg = await loadConfig()
  const requestedPort = portOverride ?? (cfg.gateway?.port ?? DEFAULT_GATEWAY_PORT)

  // 单实例保护
  const existing = await readGatewayState()
  const previousToken = existing?.admin_token // clearGatewayState 之前先取出，供本次复用
  const previousLanToken = existing?.lan_token // LAN 凭据同样跨重启复用（手机 cookie 不掉）
  const previousDevices = existing?.devices // 设备记忆随令牌一起跨重启保留（浏览器一键重登依赖它）
  if (existing && pidAlive(existing.pid)) {
    if (await healthOk(existing.port)) {
      console.error(t('网关已在运行：127.0.0.1:{port}（pid {pid}）', 'Gateway already running: 127.0.0.1:{port} (pid {pid})', { port: existing.port, pid: existing.pid }))
      // 不用 process.exit(1)：stdout 还是管道时（CLI 被脚本/测试捕获输出）强退会在
      // Windows 上撞 libuv 的 UV_HANDLE_CLOSING 断言（进程以 0xC000013A 崩掉而非退出码 1）；
      // 置 exitCode 后自然退出，等管道刷完，行为一致且三平台同码
      process.exitCode = 1
      return
    }
    await clearGatewayState()
  }

  await ensureDir(modeldockDir())
  logEndpointRisks(cfg)
  // 沙箱隔离：种子配置可能带着指向生产钥匙环的 keychain 引用（dev-seed 原样复制 key），
  // 启动时落地为沙箱本地 file 引用，此后沙箱改/删密钥与生产钥匙环彻底解耦
  if (process.env.MODELRDOCK_FAKE_HOME) {
    try {
      const { migrateSandboxKeyRefsToLocal } = await import('../config/sandbox.js')
      const migrated = await migrateSandboxKeyRefsToLocal()
      if (migrated.length > 0) {
        console.log(t('[modeldock] 沙箱模式：已把 {n} 个密钥引用从系统钥匙环落地为沙箱本地存储', '[modeldock] Sandbox mode: moved {n} key ref(s) from the OS keychain to sandbox-local storage', { n: String(migrated.length) }))
      }
    } catch { /* 迁移失败不阻断启动；deleteSecret 沙箱守卫兜底 */ }
  }
  const adminToken = resolveAdminToken(previousToken)
  const rt = buildRuntime(cfg, adminToken)
  // ops 层（switchToService 等，无 rt 上下文）的后台事件经此转发进本网关运行时 ring，页面日志表可见
  setEventRingSink((entry) => pushRing(rt, entry))
  // 将历史明文密钥迁移到平台安全后端（macOS/Linux）；失败不影响网关启动，但不再无声吞掉——
  // 经 logEvent 落 ring 与 events.jsonl（放在 rt 构建之后，事件才有环形缓冲可进）
  migrateSecretsToSecure().catch((e: unknown) => {
    logEvent(rt, { level: 'warn', op: 'secrets_migrate', err: e instanceof Error ? e.message : String(e) })
  })
  // LAN 凭据只在「开着或曾开过」时生成，不在 gateway.json 留无意义字段
  const lanEnabled = !!cfg.lan?.enabled
  const lanToken = lanEnabled || previousLanToken ? resolveLanToken(previousLanToken) : null
  const server = createGatewayServer(rt, {
    port: requestedPort,
    idleTimeoutMs: cfg.gateway?.idle_timeout_ms,
    retries: cfg.gateway?.retries,
  })

  // listen + EADDRINUSE 顺延重试与手机控制台（lan.ts）同一实现（src/gateway/shared.ts）
  const listenPort = await listenWithRetry(server, requestedPort, '127.0.0.1')
  rt.port = listenPort
  // 手机简版控制台（LAN）：开关在 config.lan.enabled；热加载不启停监听器——
  // 启停只走 POST /_modeldock/lan，避免手改配置文件时意外收/放端口
  if (lanEnabled && lanToken) {
    try {
      const lan = await startLanServer(rt, { port: cfg.lan?.port ?? DEFAULT_LAN_PORT, token: lanToken })
      // 日志打出实际选中的网卡地址（多网卡机器上排错全靠它：二维码指哪条一眼可见）
      const primary = lanPrimaryUrl(lan.port) ?? `http://<LAN-IP>:${lan.port}/m`
      console.log(
        t('[modeldock] 手机简版控制台：局域网内扫码或访问 {url}（只读+切换，不含 Key）', '[modeldock] Mobile console: on the LAN scan the QR or open {url} (view & switch, no keys)', { url: primary })
      )
    } catch (e) {
      console.error(t('[modeldock] 手机控制台启动失败：{msg}', '[modeldock] Failed to start mobile console: {msg}', { msg: (e as Error).message }))
    }
  }
  await writeGatewayState({
    pid: process.pid,
    port: listenPort,
    admin_token: adminToken,
    ...(previousDevices?.length ? { devices: previousDevices } : {}),
    ...(lanToken ? { lan_token: lanToken } : {}),
    ...(rt.lan ? { lan_port: rt.lan.port } : {}),
    // 与 health 端点同源（rt.startedAt）：gatewayLive 靠两者一致验证"这是真的网关"而非 pid 复用者
    started_at: localIsoTs(new Date(rt.startedAt)),
  })
  if (listenPort !== requestedPort) {
    console.error(
      t(
        '[modeldock] 配置端口 {requested} 被占用，实际监听 {actual}（attach 会以实际端口写入）',
        '[modeldock] Configured port {requested} is in use, listening on {actual} instead (attach writes the actual port)',
        { requested: requestedPort, actual: listenPort }
      )
    )
  }

  // 多机同步引擎（M2 target / M3 cloud）：按 sync.json 挂载；CLI setup/enroll/pause/resume 写 sync.json 后由下方 watcher 热挂载/摘除。
  // cloud 模式的远程切换回调 = 「应用」按钮同款（switchToService + 热加载），不新开进程
  const applySwitch = async (serviceId: string): Promise<void> => {
    await switchToService(serviceId)
    await reloadRuntime(rt)
  }
  // fire-and-forget 不再无声：失败落盘（daemon 无 stdout 观众）+ 前台可见
  void remountSyncEngine({ applySwitch }).catch((e: Error) => {
    console.error(t('[modeldock] 同步引擎初始挂载失败：{msg}', '[modeldock] Failed to mount the sync engine at startup: {msg}', { msg: e.message }))
    appendCrashLog('remountSyncEngine(startup): ' + (e.stack ?? e.message))
  })

  // 更新静默检查（M2）：启动后台查一次（24h TTL 持久化在 gateway.json），失败不打扰；
  // 结果经 /_modeldock/admin/update/status 供控制台徽标展示
  startBootUpdateCheck(rt)

  startEventLoopDelaySampler()
  // 控制台首屏预热：后台构建一次 overview，把适配器探测 memo（Windows reg query / PATH 扫描）、
  // secrets 解密缓存与缓存串全部焐热——用户随后打开 Web 控制台不再等冷探测的数秒尖峰
  warmupOverview(rt)


  // 配置热加载：CLI 原子写 config.toml → rename 事件 → 防抖重载
  let reloadTimer: NodeJS.Timeout | undefined
  let watcher: fs.FSWatcher | undefined
  let syncRemountTimer: NodeJS.Timeout | undefined
  const scheduleSyncRemount = (): void => {
    clearTimeout(syncRemountTimer)
    syncRemountTimer = setTimeout(() => {
      remountSyncEngine({ applySwitch }).catch((e: Error) => console.error(t('[modeldock] 同步引擎重挂失败：{msg}', '[modeldock] Failed to remount the sync engine: {msg}', { msg: e.message })))
    }, 500)
  }
  const scheduleReload = (): void => {
    clearTimeout(reloadTimer)
    reloadTimer = setTimeout(() => {
      reloadRuntime(rt)
        .then(() => {
          console.log(t('[modeldock] 配置已热加载（第 {n} 次）', '[modeldock] Config hot-reloaded (reload #{n})', { n: rt.reloads }))
          logEndpointRisks(rt.config)
        })
        .catch((e: Error) => console.error(t('[modeldock] 配置重载失败：{msg}', '[modeldock] Config reload failed: {msg}', { msg: e.message })))
    }, 250)
  }
  try {
    watcher = fs.watch(modeldockDir(), (_event, filename) => {
      if (!filename || filename === 'config.toml' || filename === 'secrets.json') scheduleReload()
      // 只认精确文件名：引擎自己写 sync.json（lastAppliedRev 等簿记）签名未变，remount 幂等空转
      if (filename === 'sync.json') scheduleSyncRemount()
    })
    rt.watcherAlive = true
    // watcher 同步构造不抛、但异步失败（EMFILE/ENOSPC 或目录被删）会发 'error'：不接则成
    // uncaught exception 杀网关（sync/engine.ts:233 同款自防）。关闭引用降级，热加载失效
    // 依赖既有 POST /_modeldock/reload 手动兜底（与下方同步 catch 的提示一致）
    watcher.on('error', (err) => {
      console.error(t('[modeldock] 配置目录监听失效（{msg}）：热加载不可用，可 POST /_modeldock/reload 手动触发', '[modeldock] Config dir watcher failed ({msg}): hot reload unavailable; POST /_modeldock/reload to reload manually', { msg: (err as Error).message }))
      watcher?.close()
      watcher = undefined
      rt.watcherAlive = false
    })
  } catch {
    console.error(t('[modeldock] 配置目录监听失败（热加载不可用，可 POST /_modeldock/reload 手动触发）', '[modeldock] Failed to watch config dir (hot reload unavailable; POST /_modeldock/reload to reload manually)'))
  }

  const providers = Object.keys(rt.config.providers).length
  const harnesses = Object.keys(rt.config.harness).length
  console.log(t('[modeldock] 网关已启动：http://127.0.0.1:{port}（pid {pid}）', '[modeldock] Gateway started: http://127.0.0.1:{port} (pid {pid})', { port: listenPort, pid: process.pid }))
  console.log(t('[modeldock] active_profile={profile} providers={providers} harness={harnesses}', '[modeldock] active_profile={profile} providers={providers} harness={harnesses}', { profile: rt.config.active_profile ?? t('（未设置）', '(not set)'), providers, harnesses }))
  console.log(consoleBanner(listenPort, adminToken, !!process.stdout.isTTY))
  console.log(t('[modeldock] Ctrl+C 停止；改配置自动热加载', '[modeldock] Ctrl+C to stop; config changes hot-reload automatically'))

  let stopping = false
  const cleanup = async (): Promise<void> => {
    if (stopping) return
    stopping = true
    watcher?.close()
    await stopSyncEngine() // 收尾等在飞 tick 结束再退出：钉扎跳过/停止后不再有写盘
    server.close()
    rt.lan?.server.close()
    // 排空常驻日志追加流的缓冲：进程退出会丢弃未刷盘的行，这是常驻流相对逐条 appendFile
    // 引入的持久性缺口（带 1s 超时兜底，不阻塞关停）。放在 process.exit 之前。
    await drainAppendStreams()
    // 保留 gateway.json（admin_token/devices）：下次启动复用 → 令牌跨重启稳定，浏览器不掉登录。
    // pid 虽失效但 gatewayLive 有 pid+health+started_at 三重校验，陈旧 state 不会误认。
    process.exit(0)
  }
  process.on('SIGINT', cleanup)
  process.on('SIGTERM', cleanup)
  // 前台运行时关闭终端会发 SIGHUP：也走 cleanup 清状态文件（Windows 无此信号，注册无害）
  process.on('SIGHUP', cleanup)
  // 保活（无请求时也挂住）
  setInterval(() => {}, 60_000)
}
