import fs from 'node:fs'
import os from 'node:os'
import net from 'node:net'
import path from 'node:path'
import { c, maskSecret, printTable, randomToken, t } from '../util/index.js'
import { loadConfig, mutateConfig } from '../config/store.js'
import { DEFAULT_LOG_RETENTION_DAYS, type Config, type ProviderConfig } from '../config/types.js'
import { getSecret, parseKeyRef, pickFileCipher, verifySecretsStore } from '../config/secrets.js'
import { debugEnabled } from '../gateway/state/debuglog.js'
import { allAdapters } from '../adapters/registry.js'
import { collectClientSecurityFindings } from '../mcp/security.js'
import { autostartKind, installAutostart, parseRunCommandLine, windowsStartupPath, windowsRunValueMirrorFile,
  autostartStatus,
  gatewayDaemonArgs,
  readRecordedArgv,
  recordedArgvStale,
  serviceFilePath,
  uninstallAutostart,
} from '../autostart.js'
import { VERSION } from '../version.js'
import type { GatewayStateFile } from '../gateway/state.js'
import { autostartLine } from './gatewaycmd.js'
import { DEFAULT_GATEWAY_PORT, gatewayLive, loadCfg, requireGateway, exitWithError, spawnDaemonAndWait } from './shared.js'
import { configPath, logsDir, modeldockDir, secretsPath } from '../util/paths.js'
import { readTextIfExists } from '../util/fsx.js'

export async function cmdStatus(): Promise<void> {
  const cfg = await loadCfg()
  const live = await gatewayLive()
  console.log(
    live
      ? c.green(t('● 网关运行中  http://127.0.0.1:{port}（pid {pid}）', '● Gateway running  http://127.0.0.1:{port} (pid {pid})', { port: live.port, pid: live.pid }))
      : c.yellow(t('○ 网关未运行（modeldock gateway start --daemon）', '○ Gateway not running (modeldock gateway start --daemon)'))
  )
  const svc = autostartStatus()
  if (svc) console.log(autostartLine(svc).trimStart())
  console.log(`active_profile: ${c.bold(cfg.active_profile ?? t('(未设置)', '(not set)'))}`)
  const port = live?.port ?? cfg.gateway?.port ?? DEFAULT_GATEWAY_PORT
  const rows: Record<string, string>[] = []
  // status 各自独立只读，Promise.all 并行（与网关侧 buildOverview 同款），~9 个 adapter 不再逐个串行等
  const statusAdapters = allAdapters(cfg)
  const statusResults = await Promise.all(statusAdapters.map(async (a) => [a, await a.status(cfg, port)] as const))
  for (const [a, st] of statusResults) {
    const he = cfg.harness[a.id]
    const pinned = he?.route && he.route !== 'default' ? he.route : undefined
    rows.push({
      harness: a.id,
      mode: he ? (he.mode === 'direct' ? t('direct(直连)', 'direct') : he.mode) : '-',
      route: pinned ? c.bold(t('钉:{p}', 'pin:{p}', { p: pinned })) : he ? t('跟随全局', 'global') : '-',
      pointing: st.pointing ?? '-',
      detail: st.detail ?? '',
    })
  }
  printTable(rows, ['harness', 'mode', 'route', 'pointing', 'detail'])
  const attached = Object.keys(cfg.harness)
  if (attached.length === 0) console.log(c.gray(t('尚未接管任何 harness；modeldock attach <harness> 或 modeldock init', 'No harnesses attached yet. Use modeldock attach <harness> or modeldock init')))
}

export async function upstreamReachable(base: string, proxy?: string): Promise<{ ok: boolean; detail: string }> {
  // undici 与网关代理模块仅在此使用：惰性加载，避免任何 CLI 命令 / 网关进程为其付出启动成本
  const { request } = await import('undici')
  const { buildDispatcher } = await import('../gateway/proxy.js')
  try {
    const up = await request(base.replace(/\/+$/, '') + '/', {
      method: 'GET',
      dispatcher: buildDispatcher(proxy),
      headersTimeout: 3000,
      bodyTimeout: 3000,
    })
    await up.body.dump()
    return { ok: true, detail: t('HTTP {s}（可达）', 'HTTP {s} (reachable)', { s: up.statusCode }) }
  } catch (e) {
    return { ok: false, detail: (e as Error).message }
  }
}

// ── doctor：结构化体检（每项带稳定 id）+ 分级修复（--fix）+ 机器可读（--json）──────────

export type DoctorLevel = 'ok' | 'warn' | 'bad' | 'info'

export interface DoctorFix {
  /** 稳定 kind（--json 消费方按它识别修复动作） */
  kind: 'start-gateway' | 'restart-gateway' | 'model-refresh' | 'attach' | 'set-proxy'
    | 'remove-dangling-profiles' | 'autostart-cleanup' | 'reinstall-autostart' | 'prune-logs'
  /** 修复对象（provider/harness id 或 profile 名单） */
  target?: string
  /** 需用户把关的修复（依赖外部环境/动第三方状态）：无 --yes 时先确认。attach 例外——自身 diff 确认流程已把关 */
  confirm: boolean
  /** 动作名（输出与确认提示用） */
  label: string
  /** 执行修复，返回一行结果细节（无则不追加） */
  run: () => Promise<string | void>
}

export interface DoctorFinding {
  /** 稳定 id（--json 消费） */
  id: string
  level: DoctorLevel
  msg: string
  hint?: string
  fix?: DoctorFix
}

export interface DoctorDeps {
  /** 注入 start-gateway 修复的执行器（单测传 fake，绝不真起 daemon） */
  startGateway?: () => Promise<string | void>
  /** 注入 restart-gateway 修复的执行器（单测传 fake，绝不真停/真起 daemon） */
  restartGateway?: () => Promise<string | void>
  /** 注入网关存活探测（单测免真实状态文件；默认 gatewayLive()） */
  gatewayLive?: () => Promise<GatewayStateFile | null>
  /** 注入端口占用探测（单测免真实 socket） */
  portProbe?: (port: number) => Promise<boolean>
  /** 注入端口占用者身份查询（单测免真实 lsof/netstat；默认 findPortOccupier） */
  portOccupier?: (port: number) => Promise<string | null>
  /** 注入修复确认（单测免 TTY） */
  confirm?: (message: string) => Promise<boolean>
  /** 注入自启重装（单测免真实 launchctl/systemd；默认 uninstall+install） */
  reinstallAutostart?: () => Promise<string | void>
  /** 注入过期日志清理（单测免真实删盘；默认 pruneExpiredLogs） */
  pruneLogs?: (retentionDays: number) => Promise<number>
  /** 注入 --deep 直连认证探测（单测免真实网络；默认 upstreamAuthProbe） */
  upstreamProbe?: (provider: ProviderConfig) => Promise<DeepProbeResult>
  /** 注入 --deep 经网关端到端测试（单测免真实请求；默认 gatewayE2ETest） */
  gatewayE2E?: (profile: string) => Promise<GatewayE2EResult>
  /** --yes 透传给需要知道是否静默的 fix 闭包（attach 写盘用） */
  fixYes?: boolean
}

/** 端口是否已有进程监听：纯 TCP 连接探测（连上即占用），不发任何应用层请求 */
function portInUse(port: number, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host: '127.0.0.1' })
    const done = (r: boolean): void => {
      sock.removeAllListeners()
      sock.destroy()
      resolve(r)
    }
    sock.setTimeout(timeoutMs, () => done(false))
    sock.once('connect', () => done(true))
    sock.once('error', () => done(false))
  })
}

/** fs.watch 可用性探测。R5：daemon 的 stdout 被丢弃，其启动期「监听失败」告警用户看不见，
 *  热加载失效只能在 CLI 侧检出（同平台同目录，CLI 探不出即 daemon 也探不出）。 */
function probeFsWatch(): boolean {
  try {
    const w = fs.watch(modeldockDir(), () => {})
    w.close()
    return true
  } catch {
    return false
  }
}

/** 服务文件里「指向 dev 沙箱 home（~/.modeldock-dev）」的路径片段（CORRECT-05 残留特征：
 *  旧版沙箱曾把生产 label 自启写进真机）。抓取含该片段的连续非空白/引号段用于展示，
 *  分隔符兼容 [\\/]（Windows 反斜杠）；`(?=[\\/]|$)` 防止误匹配 .modeldock-dev-xxx 这类名字。 */
const SANDBOX_REF_RE = /[^\s"'<>|]*[\\/]\.modeldock-dev(?=[\\/]|$)[^\s"'<>|]*/

/** 跨机密文引用检测（REVIEW-18 语义，doctor 项 secrets.foreign_cipher）。返回受影响引用列表（空=无）。
 *  检测两层：① secrets.json 原始表内出现非本平台加密前缀的密文（跨机拷贝 home 残留，本机解不开）；
 *  ② provider key_ref 内嵌 enc: 密文、或指向 ① 的条目（正常只存引用，密文只该在 secrets.json）。
 *  直接读原始文件，不触发解密；secrets.json 缺失/损坏返回 []——损坏由 secrets.store 项另行报告。 */
async function detectForeignCipherRefs(cfg: Config): Promise<string[]> {
  const nativePrefix = pickFileCipher().prefix
  const foreignIds = new Set<string>()
  const hits: string[] = []
  try {
    const text = await readTextIfExists(secretsPath())
    if (text) {
      const parsed: unknown = JSON.parse(text)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const [k, v] of Object.entries(parsed as Record<string, string>)) {
          if (typeof v !== 'string' || !v.startsWith('enc:')) continue
          // 本机明文后端（plainCipher，prefix=''）下任何 enc: 密文都非本机产物——
          // startsWith('') 恒真会让异平台密文整类漏报（macOS 实证），前缀为空时 enc: 即异源
          if (nativePrefix && v.startsWith(nativePrefix)) continue
          foreignIds.add(k)
          hits.push(`${k}(${v.slice(0, v.indexOf(':', 4) + 1)})`)
        }
      }
    }
  } catch {
    /* 解析失败：secrets.json 损坏由 secrets.store 项报告，此处不重复 */
  }
  for (const [pid, p] of Object.entries(cfg.providers)) {
    // 坏 key_ref（条目缺字段/手编非串/解析拒绝）不整条崩 doctor：parseKeyRef 收紧（700e29f）
    // 后非串会 SecretsError 穿透、undefined 直接 TypeError。坏条目解析不出引用、构不成
    // 他机密文证据，跳过（由 provider.key 检查与 provider list 面点名），其余条目照常
    if (typeof p.key_ref !== 'string') continue
    if (p.key_ref.includes('enc:mach:') || p.key_ref.includes('enc:dpapi:')) {
      hits.push(`${pid}(key_ref)`)
      continue
    }
    let ref: ReturnType<typeof parseKeyRef>
    try {
      ref = parseKeyRef(p.key_ref)
    } catch {
      continue
    }
    if (ref.scheme === 'file' && foreignIds.has(ref.id)) hits.push(`${pid}(key_ref→${ref.id})`)
  }
  return hits
}

/** doctor 第二轮③：MODELRDOCK_FAKE_HOME 误配检测（防测试写穿生产）。
 *  纯函数：fakeHome 由调用方传 env 原值，realHomeDir 传 os.homedir()（测试注入临时目录）。
 *  写入门禁只挡 agent 上下文进程，挡不住用户手动 export。两种误配都报：
 *  - FAKE_HOME === 主目录本体（真正写穿：modeldockDir() 即生产 ~/.modeldock，测试写盘直穿 config/secrets）
 *  - FAKE_HOME === ~/.modeldock（嵌套目录，污染但不覆写生产文件——仍是不该有的指向）
 *  夜间复审修正（2026-11-02）：首版只报后者、漏掉真正危险的前者。 */
export function fakeHomeMisconfig(fakeHome: string | undefined, realHomeDir: string): string | null {
  if (!fakeHome) return null
  const norm = (p: string) => path.resolve(String(p)).replace(/[\\/]+$/, '').toLowerCase()
  if (norm(fakeHome) === norm(realHomeDir)) return realHomeDir
  const nested = path.join(realHomeDir, '.modeldock')
  if (norm(fakeHome) === norm(nested)) return nested
  return null
}

/** doctor 第二轮①：日志体积与所在盘余量的裁决（纯函数，单测注入合成数字）。
 *  请求日志全量落盘（成功流量也记），盘满会先于一切告警打死网关的日志/快照/备份链。
 *  阈值：余量 < 1GB bad；目录 > 512MB warn（保留天数取 gateway.log_retention_days 展示）。 */
export function diskUsageFinding(totalBytes: number, freeBytes: number | null, retentionDays?: number): DoctorFinding {
  const mb = Math.round(totalBytes / (1024 * 1024))
  const days = String(retentionDays ?? '默认')
  // statfs 失败（目录缺失/挂载点不支持）是「无数据」不是「充足」——不能落 ok 谎报（夜间复审⑤）
  if (freeBytes == null) {
    return {
      id: 'logs.disk',
      level: 'info',
      msg: t('日志目录 {mb}MB；所在盘余量无法读取（目录缺失或文件系统不支持 statfs）', 'Log directory is {mb}MB; free disk space unavailable (directory missing or the filesystem does not support statfs)', { mb: String(mb) }),
      hint: t('确认日志目录存在后重跑 modeldock doctor', 'Confirm the log directory exists and re-run modeldock doctor'),
    }
  }
  if (freeBytes < 1 << 30) {
    const gb = Math.round((freeBytes / 1024 ** 3) * 10) / 10
    return {
      id: 'logs.disk',
      level: 'bad',
      msg: t('日志所在盘仅剩 {g}GB：写满后请求日志/快照/备份会整体失败', 'The log drive has only {g}GB left: request logs/snapshots/backups will fail entirely once full', { g: String(gb) }),
      hint: t('清理日志文件或换盘；保留天数在 config.toml [gateway] 的 log_retention_days（当前 {r}）', 'Clean up log files or move to a bigger drive; retention lives under the log_retention_days key of [gateway] in config.toml (currently {r})', { r: days }),
    }
  }
  if (mb > 512) {
    return {
      id: 'logs.disk',
      level: 'warn',
      msg: t('日志目录已达 {mb}MB：请求日志逐日全量落盘，长期偏大占盘', 'The log directory has reached {mb}MB: request logs land on disk per day and add up over time', { mb: String(mb) }),
      hint: t('调小 config.toml [gateway] 的 log_retention_days（当前 {r}）让过期日志自动清理', 'Lower the log_retention_days key of [gateway] in config.toml (currently {r}) so expired logs are pruned automatically', { r: days }),
    }
  }
  return { id: 'logs.disk', level: 'ok', msg: t('日志目录 {mb}MB、所在盘余量充足（保留 {r} 天）', 'Log directory is {mb}MB and the drive has plenty of room (retention: {r} days)', { mb: String(mb), r: days }) }
}

// ── doctor 修复执行器（start/restart 网关、日志清理）与深检探针（--deep）──────────

/** 按配置端口后台启动网关守护进程，返回端点串；超时抛可操作错误。start/restart 两个 fix 共用。 */
async function startGatewayDaemon(cfgPort: number): Promise<string> {
  const state = await spawnDaemonAndWait([...gatewayDaemonArgs(), '--port', String(cfgPort)])
  if (!state) throw new Error(t('后台启动超时；前台运行 modeldock gateway start 查看错误', 'Background start timed out; run "modeldock gateway start" in the foreground for details'))
  return `http://127.0.0.1:${state.port}`
}

/** 重启网关修复（版本漂移 / 端口漂移 / fs.watch 失效共用）：confirm 级——会打断在途请求。
 *  停复用 cmdGatewayStop（launchd 托管卸载语义别重写），起走 startGatewayDaemon。 */
function restartGatewayFix(cfgPort: number, deps: DoctorDeps = {}): DoctorFix {
  return {
    kind: 'restart-gateway',
    confirm: true,
    label: t('重启网关（停旧实例并按配置端口后台重启）', 'Restart the gateway (stop the old instance, then start in background on the configured port)'),
    run:
      deps.restartGateway ??
      (async () => {
        const { cmdGatewayStop } = await import('./gatewaycmd.js')
        await cmdGatewayStop()
        return await startGatewayDaemon(cfgPort)
      }),
  }
}

/** 日志清理修复：按保留期删过期日文件（复用网关侧 pruneExpiredLogs 同一实现与口径）。
 *  保留期 0 = 清理禁用，调用方（withPruneFix）不得挂此修复。confirm 级——删的是用户数据。 */
export function logsPruneFix(retentionDays: number, deps: DoctorDeps = {}): DoctorFix {
  return {
    kind: 'prune-logs',
    confirm: true,
    label: t('清理过期日志（按保留期 {d} 天）', 'Prune expired logs ({d}-day retention)', { d: retentionDays }),
    run: async () => {
      const n = deps.pruneLogs
        ? await deps.pruneLogs(retentionDays)
        : await (await import('../gateway/state/logs.js')).pruneExpiredLogs(retentionDays)
      return n > 0
        ? t('已删除 {n} 个过期日志文件', 'Deleted {n} expired log file(s)', { n })
        : t('没有过期日志文件', 'No expired log files')
    },
  }
}

/** 把日志清理修复挂到 logs.disk 的 warn/bad 结果上（保留期 > 0 才有可删的东西）。 */
export function withPruneFix(f: DoctorFinding, retentionDays: number | undefined, deps: DoctorDeps = {}): DoctorFinding {
  const days = retentionDays ?? DEFAULT_LOG_RETENTION_DAYS
  if ((f.level === 'warn' || f.level === 'bad') && days > 0) f.fix = logsPruneFix(days, deps)
  return f
}

/** 端口占用者身份（pid + 进程名），尽力而为：探测失败/平台工具缺失一律返回 null，
 *  调用方回落到不带身份的原始提示。只读、不杀进程。
 *  - macOS/Linux：lsof -sTCP:LISTEN 第二行取 COMMAND + PID（无 root 也可见监听者）。
 *  - Windows：netstat -ano 找 LISTENING 行取 PID，进程名经 PowerShell Get-Process
 *    （本仓库 win32 进程枚举既有分支用 CIM 全表，这里按 pid 单查更省；netstat/powershell
 *    都是 System32 内不需 shell 的 .exe，输出只解析 ASCII token 与数字 pid，不受区域设置影响）。 */
async function findPortOccupier(port: number): Promise<string | null> {
  try {
    const { spawnSync } = await import('node:child_process')
    if (process.platform === 'win32') {
      const out = spawnSync('netstat', ['-ano'], { encoding: 'utf8', timeout: 5000 })
      const line = (out.stdout ?? '').split(/\r?\n/).find((l) => l.includes(`:${port} `) && /LISTENING/i.test(l))
      const pid = line?.trim().split(/\s+/).pop()
      if (!pid || !/^\d+$/.test(pid)) return null
      const ps = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
        `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).ProcessName`], { encoding: 'utf8', timeout: 8000 })
      const name = (ps.stdout ?? '').trim().split(/\r?\n/)[0] ?? ''
      return name ? `pid ${pid}（${name}）` : `pid ${pid}`
    }
    const out = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8', timeout: 5000 })
    const line = (out.stdout ?? '').split('\n').slice(1).find((l) => l.trim())
    if (!line) return null
    const cols = line.trim().split(/\s+/)
    return cols.length >= 2 ? `pid ${cols[1]}（${cols[0]}）` : null
  } catch {
    return null
  }
}

// ── doctor --deep：真实请求验证 ──
// 浅检 upstream.reach 只做 GET /（404/401 都算「可达」），密钥被拒、模型名写错全绿。
// deep 补两层：网关在线走 /_modeldock/test（token→profile→provider→上游全链）；
// 不在线直连上游 /models 探认证（多候选端点与鉴权头复用 providers/fetch.ts，改出导出）。

export interface DeepProbeResult {
  kind: 'ok' | 'auth' | 'skip' | 'fail'
  /** ok=命中的端点；auth=HTTP 状态与端点；skip/fail=候选拒绝原因摘要 */
  detail: string
  /** ok 时上游 /models 的模型 id 列表（供默认模型名核对） */
  modelIds?: string[]
}

/** 直连上游认证探测：GET /models 多候选，按 protocol/auth_style 带鉴权头。
 *  任一候选 401/403 = 密钥被拒（auth）；200 = 有效（顺带收模型 id）；全 404/不支持 = 无法验证（skip）；
 *  网络层失败 = fail（上游可达性已由 upstream.reach 报告，此处不重复 bad）。 */
export async function upstreamAuthProbe(provider: ProviderConfig): Promise<DeepProbeResult> {
  const key = await getSecret(provider.key_ref).catch(() => null)
  if (!key) return { kind: 'skip', detail: t('key 不可读，跳过认证验证（见上方 key 检查）', 'Key unreadable; auth check skipped (see the key check above)') }
  const { modelEndpoints, authHeaders } = await import('../providers/fetch.js')
  const { request } = await import('undici')
  const { buildDispatcher } = await import('../util/net.js')
  const details: string[] = []
  let sawHttpResponse = false
  for (const endpoint of modelEndpoints(provider.base_url).slice(0, 4)) {
    let up
    try {
      up = await request(endpoint, {
        method: 'GET',
        headers: authHeaders(provider, key),
        dispatcher: buildDispatcher(provider.proxy),
        headersTimeout: 5000,
        bodyTimeout: 5000,
      })
    } catch (e) {
      details.push(`${endpoint} → ${(e as Error).message}`)
      continue
    }
    sawHttpResponse = true
    if (up.statusCode === 200) {
      let ids: string[] = []
      try {
        const len = Number(up.headers['content-length'] ?? 0)
        if (Number.isFinite(len) && len > 20 * 1024 * 1024) throw new Error('oversized')
        const j: unknown = JSON.parse(await up.body.text())
        const arr = Array.isArray((j as { data?: unknown[] })?.data) ? (j as { data: unknown[] }).data : Array.isArray(j) ? j : []
        ids = arr.map((x) => (x as { id?: unknown })?.id).filter((x): x is string => typeof x === 'string')
      } catch {
        await up.body.dump().catch(() => {})
      }
      return { kind: 'ok', detail: endpoint, modelIds: ids }
    }
    await up.body.dump().catch(() => {})
    if (up.statusCode === 401 || up.statusCode === 403) return { kind: 'auth', detail: `HTTP ${up.statusCode} @ ${endpoint}` }
    details.push(`${endpoint} → HTTP ${up.statusCode}`)
  }
  // 全部候选都拿到过 HTTP 应答（非 401/403/200）= 上游不支持模型列表端点，无法验证认证；
  // 一个应答都没有 = 传输层失败（网络可达性由 upstream.reach 项报告，此处降级 info 不重复告警）
  if (sawHttpResponse) return { kind: 'skip', detail: details.slice(0, 2).join(t('；', '; ')) }
  return { kind: 'fail', detail: details.slice(0, 2).join(t('；', '; ')) || t('所有候选端点均不可用', 'All candidate endpoints failed') }
}

export interface GatewayE2EResult {
  ok: boolean
  status?: number
  ms?: number
  model?: string
  err?: string
  hint?: string
}

/** 经网关端到端最小请求（与 cmdTest 同端点同契约；超时 90s 与 cmdTest 默认一致）。 */
async function gatewayE2ETest(live: GatewayStateFile, profileName: string): Promise<GatewayE2EResult> {
  try {
    const res = await fetch(`http://127.0.0.1:${live.port}/_modeldock/test`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-modeldock-admin': live.admin_token },
      body: JSON.stringify({ profile: profileName, stream: true }),
      signal: AbortSignal.timeout(90_000),
    })
    const text = await res.text()
    try {
      return JSON.parse(text) as GatewayE2EResult
    } catch {
      return { ok: false, status: res.status, err: text.slice(0, 200) }
    }
  } catch (e) {
    return { ok: false, err: (e as Error).message, hint: (e as Error).name === 'TimeoutError' ? t('上游响应超时；可先用 modeldock test 加大超时定位', 'The upstream timed out; narrow it down with modeldock test and a larger timeout') : undefined }
  }
}

export async function collectDoctorFindings(deps: DoctorDeps = {}, opts: { deep?: boolean } = {}): Promise<DoctorFinding[]> {
  const F: DoctorFinding[] = []
  const ok = (id: string, msg: string) => F.push({ id, level: 'ok', msg })
  const bad = (id: string, msg: string, hint?: string, fix?: DoctorFix) => F.push({ id, level: 'bad', msg, hint, fix })

  // doctor 第二轮③：FAKE_HOME 指向真实 ~/.modeldock = 测试写穿生产——bad 点名 + 改法
  const mis = fakeHomeMisconfig(process.env.MODELRDOCK_FAKE_HOME, os.homedir())
  if (mis) {
    bad(
      'sandbox.misconfig',
      t('MODELRDOCK_FAKE_HOME 指向真实数据目录（{d}）：测试/实验的任何写盘都会直穿生产配置与密钥', 'MODELRDOCK_FAKE_HOME points at the real data directory ({d}): any write from tests or experiments goes straight through to production config and keys', { d: mis }),
      t('改指独立目录（如 ~/.modeldock-test）或 unset 后再跑测试实例；生产实例永远不要带该变量', 'Point it at a separate directory (e.g. ~/.modeldock-test) or unset it before running test instances; never set it for the production instance')
    )
  }

  let cfg
  try {
    cfg = await loadConfig()
  } catch (e) {
    // doctor 第二轮②：报错带上文件路径——用户不用猜是哪个 config（多沙箱/多实例场景常见）
    bad('config.parse', t('config.toml 解析失败（{f}）：{m}', 'config.toml failed to parse ({f}): {m}', { f: configPath(), m: (e as Error).message }), t('modeldock config edit 修复', 'Fix it with modeldock config edit'))
    return F
  }
  ok('config.parse', t('config.toml 可解析（version {v}）', 'config.toml parses (version {v})', { v: cfg.version }))

  // doctor 第二轮①：日志体积与所在盘余量（请求日志全量落盘，盘满先于一切告警打死网关）
  {
    const dir = logsDir()
    let total = 0
    try {
      if (fs.existsSync(dir)) {
        for (const f of fs.readdirSync(dir)) {
          const st = fs.statSync(path.join(dir, f))
          if (st.isFile()) total += st.size
        }
      }
    } catch { /* 读不了按 0 处理，余量仍可报 */ }
    const s = await fs.promises.statfs(dir).catch(() => null)
    const free = s ? Number(s.bsize) * Number(s.bavail) : null
    F.push(withPruneFix(diskUsageFinding(total, free, cfg.gateway?.log_retention_days), cfg.gateway?.log_retention_days, deps))
  }

  // debug 日志开关自描述（logs.debug）：排障入口——开没开、文件在哪。纯 config/env 推导
  //（--debug 旗标只存在于网关进程，doctor 进程看不到，hint 里写明三通道）
  {
    const on = debugEnabled({ config: cfg.gateway })
    let latest: { name: string; size: number } | null = null
    try {
      const dir = logsDir()
      for (const f of fs.readdirSync(dir)) {
        if (!/^debug-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)) continue
        const st = fs.statSync(path.join(dir, f))
        if (!latest || f > latest.name) latest = { name: f, size: st.size } // 文件名即日期，字典序=时间序
      }
    } catch { /* 目录缺失按无文件 */ }
    if (on) {
      ok(
        'logs.debug',
        t(
          'debug 日志已开启（logs/debug-<date>.jsonl{latest}）',
          'debug logging is on (logs/debug-<date>.jsonl{latest})',
          { latest: latest ? t('，最近 {f}（{n} KB）', ', latest {f} ({n} KB)', { f: latest.name, n: Math.max(1, Math.round(latest.size / 1024)) }) : '' }
        )
      )
    } else {
      F.push({
        id: 'logs.debug',
        level: 'info',
        msg: t('debug 日志未开启（默认关）', 'debug logging is off (default)'),
        hint: t(
          '排障时开启（任一）：config.toml [gateway] debug = true（热加载即时生效）／MODELRDOCK_DEBUG=1／gateway start --debug；日志落 logs/debug-<date>.jsonl，含管理面访问与子进程调用明细',
          'To debug (any of): config.toml [gateway] debug = true (hot-applied) / MODELRDOCK_DEBUG=1 / gateway start --debug; logs go to logs/debug-<date>.jsonl with admin access and child-process details'
        ),
      })
    }
  }

  // ── 分组并行段（perf-p2-polish）：密钥库验证、跨机密文、网关存活/端口/watch/自启/悬空、
  // active_profile 链、适配器探测、安检扫描六组互不依赖，此前串行 await——上游不可达时白等
  // 3s 才轮到适配器与安检段，Windows 冷路径（DPAPI spawn + reg query 全树）叠串行可到 10s+。
  // 分组 Promise.all 后总时延 = 最慢组而非各段之和；各组分桶收集、按原块序归并，--json 的
  // 稳定 id 序不变。真实依赖只有两处，都在组内 await 共享 promise 解决：
  // ① provider.key 子项依赖密钥库验证结果（secretsVerifyP）；② harness 段的探活端口依赖 gatewayLive()。
  const cfgPort = cfg.gateway?.port ?? DEFAULT_GATEWAY_PORT
  const bSecrets: DoctorFinding[] = []
  const bForeign: DoctorFinding[] = []
  const bGateway: DoctorFinding[] = []
  const bChain: DoctorFinding[] = []
  const bHarness: DoctorFinding[] = []
  const bSec: DoctorFinding[] = []
  // 分桶版 ok/warn/bad/info（与 F 直推同款形状），各组先落自己的桶、最后按块序归并
  const H = (arr: DoctorFinding[]) => ({
    ok: (id: string, msg: string) => arr.push({ id, level: 'ok' as const, msg }),
    warn: (id: string, msg: string, hint?: string, fix?: DoctorFix) => arr.push({ id, level: 'warn' as const, msg, hint, fix }),
    bad: (id: string, msg: string, hint?: string, fix?: DoctorFix) => arr.push({ id, level: 'bad' as const, msg, hint, fix }),
    info: (id: string, msg: string, hint?: string) => arr.push({ id, level: 'info' as const, msg, hint }),
  })

  // liveP 是六组共享的探活 promise；gatewayLive 注入口（单测）替换整条来源
  const liveP = deps.gatewayLive ? deps.gatewayLive() : gatewayLive()

  // 密钥库整表可读性：损坏时逐条 key 检查只会重复报同一根因，后续跳过（结果经 secretsVerifyP 供链路组共享）
  const secretsVerifyP = (async (): Promise<boolean> => {
    const b = H(bSecrets)
    try {
      const sv = await verifySecretsStore()
      if (!sv.ok) {
        b.bad('secrets.store', sv.error, t('各密钥重新设置：modeldock provider set-key <id>', 'Re-set your keys: modeldock provider set-key <id>'))
        return false
      }
    } catch {
      /* 验证自身异常不拦截：交由逐条 key 检查暴露 */
    }
    return true
  })()

  // 跨机密文引用（REVIEW-18）：file 后端密文绑定原机器/平台（win DPAPI / linux machine-id），
  // 跨机拷贝 home 后本机解不开、发上游必 401。在通用 secrets.store 报错之上点名受影响引用与服务，
  // 提示对相应服务重新 set-key（--json 消费方按 id=secrets.foreign_cipher 识别）
  const foreignP = (async (): Promise<void> => {
    const b = H(bForeign)
    const foreignRefs = await detectForeignCipherRefs(cfg)
    if (foreignRefs.length) {
      b.bad(
        'secrets.foreign_cipher',
        t('此配置含他机密文引用（{list}）：密文绑定其他机器/平台，本机无法解密', 'This config contains cross-machine ciphertext references ({list}): the ciphertext is bound to another machine or platform and cannot be decrypted here', { list: foreignRefs.join(', ') }),
        t('对相应服务重新设置密钥：modeldock provider set-key <服务 id>；不要直接把别机的 secrets.json 拷到本机', "Re-set the key for each affected service: modeldock provider set-key <provider id>; do not copy another machine's secrets.json here")
      )
    }
  })()

  // 网关存活/端口漂移 + watch + 自启登记 + 悬空 profile（本地快速检查合一段，段内保持原相对次序）
  const gatewayP = (async (): Promise<void> => {
    const b = H(bGateway)
    const live = await liveP
    if (live) {
      b.ok('gateway.up', t('网关运行中 127.0.0.1:{port}（pid {pid}）', 'Gateway running on 127.0.0.1:{port} (pid {pid})', { port: live.port, pid: live.pid }))
      // 版本漂移：升级/改码后 daemon 未重启仍在跑旧代码（本项目无热重载，属高频故障）。
      // 旧版状态文件无 version 字段（undefined）→ 跳过不报，向后兼容。
      if (live.version && live.version !== VERSION) {
        b.warn(
          'gateway.version_drift',
          t('网关进程为 v{gv}，当前 CLI 为 v{cv}：升级或改码后未重启，网关仍在跑旧代码', 'The gateway process is v{gv} but this CLI is v{cv}: the gateway was not restarted after an upgrade or code change and is running stale code', { gv: live.version, cv: VERSION }),
          t('重启网关加载新代码：modeldock gateway stop 后 modeldock gateway start --daemon（或 --fix 重启）', 'Restart the gateway to load the new code: modeldock gateway stop, then modeldock gateway start --daemon (or restart with --fix)'),
          restartGatewayFix(cfgPort, deps)
        )
      }
      if (live.port !== cfgPort) {
        b.warn(
          'gateway.port_drift',
          t('网关实际监听 {actual}，与配置端口 {configured} 不一致（配置端口被占用时启动会漂移）', 'The gateway listens on {actual}, not the configured port {configured} (start drifts when the configured port is taken)', { actual: live.port, configured: cfgPort }),
          t('解除端口占用后 modeldock gateway stop 再启动，即回到配置端口', 'Free the port, then modeldock gateway stop and start again to return to the configured port'),
          restartGatewayFix(cfgPort, deps)
        )
      }
    } else {
      b.warn(
        'gateway.down',
        t('网关未运行', 'The gateway is not running'),
        'modeldock gateway start --daemon',
        {
          kind: 'start-gateway',
          confirm: false,
          label: t('启动网关（后台）', 'Start the gateway (background)'),
          run: deps.startGateway ?? (async () => startGatewayDaemon(cfgPort)),
        }
      )
      const busy = deps.portProbe ? await deps.portProbe(cfgPort) : await portInUse(cfgPort)
      if (busy) {
        const occ = deps.portOccupier ? await deps.portOccupier(cfgPort) : await findPortOccupier(cfgPort)
        b.warn(
          'gateway.port_busy',
          occ
            ? t('配置端口 {port} 已被 {o} 占用：网关启动后将改用其他端口', 'Configured port {port} is taken by {o}: the gateway will fall back to another port on start', { port: cfgPort, o: occ })
            : t('配置端口 {port} 已被其他进程占用：网关启动后将改用其他端口', 'Configured port {port} is taken by another process: the gateway will fall back to another port on start', { port: cfgPort }),
          t('查看占用者：lsof -nP -iTCP:{port} -sTCP:LISTEN（Windows：netstat -ano | findstr {port}）', 'Find the occupier: lsof -nP -iTCP:{port} -sTCP:LISTEN (Windows: netstat -ano | findstr {port})', { port: cfgPort })
        )
      }
    }

    if (!probeFsWatch()) {
      b.warn(
        'gateway.watch',
        t('配置目录监听不可用（fs.watch 异常）：网关热加载失效，改配置不会自动生效', 'Config-dir watching is unavailable (fs.watch error): gateway hot-reload is broken; config changes will not apply automatically'),
        t('先重启网关试试；仍不行就改配置后手动热加载（POST /_modeldock/reload）或重启网关', 'Restart the gateway first; if it persists, reload manually after changes (POST /_modeldock/reload) or restart the gateway'),
        // 重启只对「daemon 探测同样失效」的瞬时场景有效；网关不在运行时无从重启，保持纯提示
        live ? restartGatewayFix(cfgPort, deps) : undefined
      )
    }

    // 自启登记核查（known-issues CORRECT-05 遗留清理）：只读服务文件内容判定，不 spawn launchctl/systemctl。
    // 登记指向沙箱路径 = 旧版沙箱曾把自启写进真机的残留；指向已不存在的文件 = nvm 升级/二进制移动后
    // 自启静默失败。沙箱上下文（FAKE_HOME）下 serviceFilePath 已重定向，只核沙箱自身登记，且豁免自引用
    // （dev 沙箱自己的服务文件引用自家路径属正常）；--fix 走 uninstallAutostart，confirm 把关 + 删前
    // 由本项 msg/hint 打印将删内容（登记文件与指向），不自动删任何数据。
    // Windows 注册表形态（XPLAT-06）没有服务文件：读 Run 键镜像文件（生产 reg add 同步落盘，沙箱下即键值本体）；
    // 仅剩旧 VBS（升级未重装）回读 VBS 内容（ARGV_MARK）——与 windowsStatus 的双源判定同口径
    const svcFile = autostartKind() === 'windows'
      ? (fs.existsSync(windowsRunValueMirrorFile())
          ? windowsRunValueMirrorFile()
          : fs.existsSync(windowsStartupPath()) ? windowsStartupPath() : null)
      : serviceFilePath()
    if (svcFile && fs.existsSync(svcFile)) {
      let text = ''
      try {
        text = fs.readFileSync(svcFile, 'utf8')
      } catch {
        /* 读不了按无登记内容处理，退当前运行时 argv */
      }
      const argv = (autostartKind() === 'windows' ? parseRunCommandLine(text) : readRecordedArgv(text)) ?? gatewayDaemonArgs()
      const fakeHomeRoot = process.env.MODELRDOCK_FAKE_HOME ? path.resolve(process.env.MODELRDOCK_FAKE_HOME) : null
      const sandboxHit = fakeHomeRoot
        ? argv.find((a) => SANDBOX_REF_RE.test(a) && !a.startsWith(fakeHomeRoot))
        : SANDBOX_REF_RE.exec(text)?.[0]
      const autostartCleanup: DoctorFix = {
        kind: 'autostart-cleanup',
        confirm: true,
        label: t('移除开机自启登记（{f}）', 'Remove the autostart entry ({f})', { f: svcFile }),
        run: async () => (await uninstallAutostart()).removed,
      }
      // 启动命令失效的主修复是重装（nvm 升级/二进制移动后原登记已死，用户本意是「要自启」）；
      // 沙箱残留指向的是不该存在的实例，主修复仍是移除
      const autostartReinstall: DoctorFix = {
        kind: 'reinstall-autostart',
        confirm: true,
        label: t('重装开机自启（卸载后按当前程序重新登记）', 'Reinstall the autostart entry (uninstall, then re-register from the current program)'),
        run:
          deps.reinstallAutostart ??
          (async () => {
            await uninstallAutostart()
            const r = await installAutostart()
            return r.file
          }),
      }
      if (sandboxHit) {
        b.warn(
          'autostart.residue',
          t('开机自启登记指向沙箱路径（{a}）：多为旧版沙箱自启残留，下次登录会拉起失效实例', 'The autostart entry points into a sandbox path ({a}): likely residue from an old sandbox install; it will launch a broken instance at next login', { a: sandboxHit }),
          t('确认是残留后用 --fix 移除（删除登记文件并卸载服务），或手动 modeldock gateway uninstall', 'Remove it with --fix after confirming it is residue (deletes the entry file and unloads the service), or run modeldock gateway uninstall manually'),
          autostartCleanup
        )
      } else if (recordedArgvStale(argv)) {
        const staleArg = fs.existsSync(argv[0]) ? (argv.slice(1).find((a) => !a.startsWith('--') && !fs.existsSync(a)) ?? argv[0]) : argv[0]
        b.warn(
          'autostart.residue',
          t('开机自启登记的启动命令指向不存在的文件（{a}）：下次登录自启将静默失败', 'The autostart start command points at missing files ({a}): autostart will silently fail at next login', { a: staleArg }),
          t('--fix 可重装（卸载后按当前程序重新登记）；不再需要自启则 modeldock gateway uninstall 移除', '--fix reinstalls it (uninstalls, then re-registers from the current program); or remove it with modeldock gateway uninstall if no longer needed'),
          autostartReinstall
        )
      } else {
        b.ok('autostart.entry', t('开机自启登记有效（{f}）', 'Autostart entry is healthy ({f})', { f: svcFile }))
      }
    }

    // 悬空 profile：引用的 provider 不存在（active_profile 的在链路组里报告，这里只收其余）。
    // 可移除 = 未被任何 harness 钉定引用；被钉定的只提示，不自动删
    const pinnedRoutes = new Set(
      Object.values(cfg.harness)
        .map((h) => h.route)
        .filter((r): r is string => !!r && r !== 'default')
    )
    const dangling = Object.keys(cfg.profiles).filter((n) => n !== cfg.active_profile && !cfg.providers[cfg.profiles[n].provider])
    if (dangling.length) {
      const removable = dangling.filter((n) => !pinnedRoutes.has(n))
      const pinnedList = dangling.filter((n) => pinnedRoutes.has(n))
      b.bad(
        'profile.dangling',
        t('{n} 个 profile 引用的 provider 不存在：{list}', '{n} profile(s) reference a missing provider: {list}', { n: dangling.length, list: dangling.join(', ') }),
        pinnedList.length
          ? t('「{list}」被 harness 钉定引用，先 modeldock harness route <id> default 解钉', '"{list}" is pinned by a harness; unpin with modeldock harness route <id> default first', { list: pinnedList.join(', ') })
          : undefined,
        removable.length
          ? {
              kind: 'remove-dangling-profiles',
              target: removable.join(','),
              confirm: false,
              label: t('清理悬空 profile', 'Remove dangling profiles'),
              run: async () => {
                await mutateConfig((c2) => {
                  for (const n of removable) delete c2.profiles[n]
                })
                return t('已移除 {n} 个', 'Removed {n}', { n: removable.length })
              },
            }
          : undefined
      )
    }
  })()

  // active_profile 链（组内保持串行：profile→provider→key→上游探测是真实依赖链）；
  // key 检查与密钥库验证组并行（await secretsVerifyP——验证通常早已完成，不付串行等待）
  const chainP = (async (): Promise<void> => {
    const b = H(bChain)
    const ap = cfg.active_profile
    if (!ap) { b.warn('profile.active', t('未设置 active_profile', 'active_profile is not set'), 'modeldock profile use <name>'); return }
    const profile = cfg.profiles[ap]
    if (!profile) { b.bad('profile.active', t('active_profile「{a}」不存在', 'active_profile "{a}" does not exist', { a: ap }), 'modeldock profile list'); return }
    const provider = cfg.providers[profile.provider]
    if (!provider) { b.bad('profile.active', t('profile「{a}」的 provider「{p}」不存在', 'provider "{p}" of profile "{a}" does not exist', { a: ap, p: profile.provider })); return }
    b.ok('profile.active', t('active_profile「{a}」→ {p}（{u}）', 'active_profile "{a}" → {p} ({u})', { a: ap, p: provider.name ?? profile.provider, u: provider.base_url }))
    if (await secretsVerifyP) {
      // 坏 key_ref（缺字段/手编非串）≠ 读取故障：报 bad + set-key hint，不落「解锁钥匙环」
      // 的 warn 口径（700e29f 后 parseKeyRef 抛 SecretsError 曾被下方 catch 当瞬时故障）
      if (typeof provider.key_ref !== 'string') {
        b.bad(
          'provider.key',
          t('上游 key_ref 非法（收到 {got}）：provider 条目缺 key_ref 字段', 'Upstream key_ref is invalid (got {got}): the provider entry is missing its key_ref field', { got: provider.key_ref === undefined ? 'undefined' : typeof provider.key_ref }),
          `modeldock provider set-key ${profile.provider}`
        )
      } else {
        try {
          const key = await getSecret(provider.key_ref)
          if (key) b.ok('provider.key', t('上游 key 可读取（{k}）', 'Upstream key is readable ({k})', { k: maskSecret(key) }))
          else b.bad('provider.key', t('上游 key 不可用（key_ref={r}）', 'Upstream key is unavailable (key_ref={r})', { r: provider.key_ref }), `modeldock provider set-key ${profile.provider}`)
        } catch (e) {
          // 读取失败（钥匙环被锁/暂时不可用）≠ 未配置密钥：前者是瞬时故障、解锁即恢复，
          // 报 warn + 解锁 hint，不与缺失条目（bad + set-key）混同（REVIEW-19 语义对齐）
          b.warn(
            'provider.key',
            t('上游 key 读取失败：{m}', 'Failed to read the upstream key: {m}', { m: (e as Error).message }),
            t('这是读取故障（如钥匙环被锁定），与未配置密钥不同：解锁钥匙环后重跑 modeldock doctor 即可恢复；反复出现可改用 file 存储后重新 set-key', 'This is a read failure (e.g. a locked keyring), not a missing key: unlock the keyring and re-run modeldock doctor to recover; if it keeps happening, switch to file storage and re-set the key')
          )
        }
      }
    }
    const reach = await upstreamReachable(provider.base_url, provider.proxy)
    if (reach.ok) b.ok('upstream.reach', t('上游可达：{d}', 'Upstream is reachable: {d}', { d: reach.detail }))
    else {
      const proxyEnv = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy'].some((k) => process.env[k])
      const canProxyFix = !provider.proxy && proxyEnv
      b.bad(
        'upstream.reach',
        t('上游不可达：{d}', 'Upstream is unreachable: {d}', { d: reach.detail }),
        canProxyFix
          ? t('检测到代理环境变量：可设 provider.proxy="env" 走代理', 'Proxy env vars detected: set provider.proxy="env" to route through it')
          : t('检查网络；国外上游可设 provider.proxy="env" 走代理', 'Check the network. For overseas upstreams, set provider.proxy="env" to go through a proxy'),
        canProxyFix
          ? {
              kind: 'set-proxy',
              target: profile.provider,
              confirm: true,
              label: t('为「{p}」设置 proxy=env', 'Set proxy=env for "{p}"', { p: provider.name ?? profile.provider }),
              run: async () => {
                await mutateConfig((c2) => {
                  const p = c2.providers[profile.provider]
                  if (p) p.proxy = 'env'
                })
              },
            }
          : undefined
      )
    }
    const modelCount = Object.keys(provider.models ?? {}).length
    if (modelCount === 0) {
      b.warn(
        'models.empty',
        t('该 provider 模型目录为空', 'This provider has an empty model catalog'),
        `modeldock model refresh ${profile.provider}`,
        {
          kind: 'model-refresh',
          target: profile.provider,
          confirm: false,
          label: t('拉取模型目录（{p}）', 'Fetch the model catalog ({p})', { p: profile.provider }),
          run: async () => {
            // 惰性加载：providers 链上挂着 catalog snapshot，status/doctor 只读路径不付这个成本
            const { refreshModelsInto } = await import('./providers.js')
            const r = await refreshModelsInto(profile.provider)
            return t('新增 {a} 个', '{a} added', { a: r.added })
          },
        }
      )
    } else if (profile.default_model && !(provider.models?.[profile.default_model]?.context_window)) {
      b.warn('model.meta', t('默认模型 {m} 缺上下文元数据', 'Default model {m} is missing context metadata', { m: profile.default_model }), `modeldock model set ${profile.provider} ${profile.default_model} --ctx <n>`)
    }

    // --deep：真实请求验证（显式开启——日常体检保持秒级不发真请求）。
    // 网关在线走 /_modeldock/test：token→profile→provider→上游全链一次验证；
    // 不在线直连上游探认证：把「可达但 401」「模型名写错」从浅检的假绿里抓出来。
    // 置于链路组末尾：认证/模型名结论引用「上游可达」项，输出序须在其后；探活走共享 liveP。
    if (opts.deep) {
      const gw = await liveP
      if (gw) {
        const e2e = deps.gatewayE2E ? await deps.gatewayE2E(ap) : await gatewayE2ETest(gw, ap)
        if (e2e.ok) {
          b.ok('upstream.e2e', t('端到端请求成功：经网关 →「{p}」（{m}，{ms}ms）', 'End-to-end request succeeded: via gateway → "{p}" ({m}, {ms}ms)', { p: ap, m: e2e.model ?? '-', ms: e2e.ms ?? 0 }))
        } else {
          b.bad(
            'upstream.e2e',
            t('端到端请求失败：{d}', 'End-to-end request failed: {d}', { d: e2e.err ?? `HTTP ${e2e.status ?? '?'}` }),
            e2e.hint
          )
        }
      } else {
        const probe = deps.upstreamProbe ? await deps.upstreamProbe(provider) : await upstreamAuthProbe(provider)
        if (probe.kind === 'ok') {
          b.ok('upstream.auth', t('上游认证有效（{e}）', 'Upstream auth is valid ({e})', { e: probe.detail }))
          const dm = profile.default_model
          if (dm && probe.modelIds?.length && !probe.modelIds.includes(dm)) {
            b.warn(
              'model.missing',
              t('默认模型 {m} 不在上游模型目录（共 {n} 个）：可能仍可用（上游目录未必全），但更可能是名称有误', 'Default model {m} is not in the upstream model catalog ({n} models): it may still work (catalogs can be incomplete), but more likely the name is wrong', { m: dm, n: probe.modelIds.length }),
              t('核对模型名（modeldock profile show）；或 modeldock model refresh {p} 拉取最新目录', 'Verify the model name (modeldock profile show); or run modeldock model refresh {p} to fetch the latest catalog', { p: profile.provider })
            )
          }
        } else if (probe.kind === 'auth') {
          b.bad(
            'upstream.auth',
            t('上游认证失败：{d}——地址可达但密钥被拒', 'Upstream auth failed: {d} — the endpoint is reachable but the key is rejected', { d: probe.detail }),
            t('重新设置密钥：modeldock provider set-key {p}', 'Re-set the key: modeldock provider set-key {p}', { p: profile.provider })
          )
        } else if (probe.kind === 'skip') {
          b.info('upstream.auth', t('无法自动验证认证（上游未提供可用的模型列表端点）：{d}', 'Auth could not be verified automatically (the upstream offers no working model-list endpoint): {d}', { d: probe.detail }))
        } else {
          b.info('upstream.auth', t('认证验证请求失败：{d}（网络可达性已由上方「上游可达」项报告）', 'Auth verification request failed: {d} (network reachability is reported by the "Upstream is reachable" check above)', { d: probe.detail }))
        }
      }
    }
  })()

  const port = (await liveP)?.port ?? cfgPort
  // 适配器状态：组内已并行（各自独立只读）；单个 adapter 异常（如 pack 目标文件损坏）不应击穿
  // 整条体检——错误随 adapter 带回，按原顺序逐个输出
  const harnessP = (async (): Promise<void> => {
    const b = H(bHarness)
    const doctorAdapters = allAdapters(cfg)
    const doctorStatuses = await Promise.all(
      doctorAdapters.map(async (a) => [a, await a.status(cfg, port).catch((e: Error) => e)] as const)
    )
    for (const [a, st] of doctorStatuses) {
      if (st instanceof Error) {
        b.bad('harness.status_error', t('{l}：状态检查失败（{m}）', '{l}: status check failed ({m})', { l: a.label, m: st.message }), t('modeldock adapter list 查看；若配置了 adapter pack 请检查目标文件', 'Run modeldock adapter list to inspect; if an adapter pack is configured, check its target files'))
        continue
      }
      if (st.attached && st.pointing === 'gateway') b.ok('harness.pointing', t('{l}：已接管且指向网关', '{l}: attached and pointing at the gateway', { l: a.label }))
      else if (st.attached && st.pointing === 'other')
        b.bad(
          'harness.pointing',
          t('{l}：已接管但配置指向别处', '{l}: attached but its config points elsewhere', { l: a.label }),
          t('modeldock attach {id} 重新写入', 'Rewrite it with modeldock attach {id}', { id: a.id }),
          {
            kind: 'attach',
            target: a.id,
            confirm: false, // attach 自带 diff + 确认流程把关，doctor 不再叠加一层询问
            label: t('重新写入 {l} 的网关指向', "Rewrite {l}'s gateway target", { l: a.label }),
            run: async () => {
              const { cmdAttach } = await import('./harness.js')
              await cmdAttach(a.id, { yes: deps.fixYes })
            },
          }
        )
      else if (st.attached) b.warn('harness.pointing', t('{l}：已接管但未检测到指向（file 模式或待重启）', '{l}: attached but no pointing detected (file mode, or restart pending)', { l: a.label }))
      else if (st.installed) b.warn('harness.detached', t('{l}：已安装未接管（不影响使用）', '{l}: installed but not attached (no impact on use)', { l: a.label }), `modeldock attach ${a.id}`)
      else if (a.id !== 'generic-env') b.info('harness.absent', t('{l}：未安装，跳过', '{l}: not installed, skipped', { l: a.label }))
    }
  })()

  // Agent 配置安全体检（只读，见 mcp/security.ts）：MCP 危险命令 / env 明文凭据 / 同名重复 / 直连明文 key。
  // 发现本身不带 --fix（都是用户的显式选择，体检只把泄漏面说清）；安检自身异常不击穿整条体检
  const secP = (async (): Promise<void> => {
    const b = H(bSec)
    try {
      const sec = await collectClientSecurityFindings(cfg)
      for (const f of sec) {
        if (f.level === 'warn') b.warn(f.id, f.msg, f.hint)
        else b.info(f.id, f.msg, f.hint)
      }
    } catch {
      /* MCP 配置损坏等已在 scan 侧带错误返回，这里不重复报告 */
    }
  })()

  await Promise.all([secretsVerifyP, foreignP, gatewayP, chainP, harnessP, secP])

  // 按原块序归并（--json 消费方依赖稳定 id 序；组内次序 = 原串行次序）
  F.push(...bSecrets, ...bForeign, ...bGateway, ...bChain, ...bHarness, ...bSec)
  return F
}

function printDoctor(findings: DoctorFinding[]): void {
  console.log()
  const mark: Record<DoctorLevel, string> = { ok: c.green('✓'), warn: c.yellow('!'), bad: c.red('✗'), info: c.gray('○') }
  for (const f of findings) {
    console.log(`${mark[f.level]} ${f.msg}`)
    if (f.hint) console.log(c.gray(`  → ${f.hint}`))
  }
}

/** 体检合计行：一眼看清总量与可自动修复面。 */
function printSummary(findings: DoctorFinding[]): void {
  const n = (lv: DoctorLevel) => findings.filter((f) => f.level === lv).length
  console.log(
    c.gray(
      t(
        '合计 {n} 项检查：✓ {ok} · ! {warn} · ✗ {bad} · ○ {info}；可自动修复 {fix} 项',
        'Total {n} checks: ✓ {ok} · ! {warn} · ✗ {bad} · ○ {info}; {fix} auto-fixable',
        { n: findings.length, ok: n('ok'), warn: n('warn'), bad: n('bad'), info: n('info'), fix: findings.filter((f) => f.fix).length }
      )
    )
  )
}

export interface FixRecheckResult {
  /** 修复前有问题、修复后消失的项（按 id+msg 对账） */
  resolved: DoctorFinding[]
  /** 修复后仍 warn/bad 的项 */
  remaining: DoctorFinding[]
  /** 修复后新出现的问题项（随 remaining 一起打印，标记区分） */
  introduced: DoctorFinding[]
}

/** 修复前后两轮 findings 对账（纯函数）。键 = id + msg：同一 id 会因 adapter/provider 不同
 *  出现多条（harness.pointing），msg 参与键才不误并。 */
export function diffFindings(before: DoctorFinding[], after: DoctorFinding[]): FixRecheckResult {
  const key = (f: DoctorFinding): string => `${f.id}\u0000${f.msg}`
  const problematic = (f: DoctorFinding): boolean => f.level === 'bad' || f.level === 'warn'
  // 只对 after 的问题项建键：warn→ok 的转变才算「已解决」（ok 项占键会把转变误判成仍存在）
  const afterKeys = new Set(after.filter(problematic).map(key))
  const beforeKeys = new Set(before.map(key))
  return {
    resolved: before.filter((f) => problematic(f) && !afterKeys.has(key(f))),
    remaining: after.filter(problematic),
    introduced: after.filter((f) => problematic(f) && !beforeKeys.has(key(f))),
  }
}

/** 修复后复核展示（flutter doctor 的 validate→fix→re-run 闭环）。 */
function printRecheck(d: FixRecheckResult): void {
  console.log()
  console.log(c.bold(t('── 复核 ──', '── Recheck ──')))
  for (const f of d.resolved) console.log(c.green(`✓ ${t('已解决：{m}', 'Resolved: {m}', { m: f.msg })}`))
  for (const f of d.remaining) {
    const isNew = d.introduced.includes(f)
    console.log(isNew
      ? c.yellow(`⚠ ${t('新出现：{m}', 'New: {m}', { m: f.msg })}`)
      : c.red(`✗ ${t('仍存在：{m}', 'Still present: {m}', { m: f.msg })}`))
    if (f.hint) console.log(c.gray(`  → ${f.hint}`))
  }
  if (d.resolved.length === 0 && d.remaining.length === 0) console.log(c.green(t('✓ 无遗留问题', '✓ No issues remain')))
  else console.log(c.gray(t('复核：解决 {a} 项 / 仍余 {b} 项', 'Recheck: {a} resolved / {b} remaining', { a: d.resolved.length, b: d.remaining.length })))
}

async function defaultConfirm(message: string): Promise<boolean> {
  const { confirm } = await import('@inquirer/prompts')
  return confirm({ message })
}

/** 执行体检发现的修复：confirm=false 直接执行；confirm=true 无 --yes 时逐项确认。
 *  单个修复失败不中断后续；确认失败（非 TTY 等）按跳过处理。
 *  返回执行计数——cmdDoctor 凭 done>0 决定是否自动复核。导出供单测直测。 */
export async function runFixes(findings: DoctorFinding[], opts: { yes?: boolean }, deps: DoctorDeps = {}): Promise<{ done: number; failed: number; skipped: number }> {
  const fixable = findings.filter((f) => f.fix)
  if (fixable.length === 0) {
    console.log(c.gray(t('没有可自动执行的修复项', 'Nothing to auto-fix')))
    return { done: 0, failed: 0, skipped: 0 }
  }
  console.log()
  console.log(c.bold(t('── 修复 ──', '── Fixes ──')))
  let done = 0
  let failed = 0
  let skipped = 0
  for (const f of fixable) {
    const fix = f.fix!
    if (fix.confirm && !opts.yes) {
      let go = false
      try {
        go = await (deps.confirm ?? defaultConfirm)(t('执行「{a}」？', 'Apply "{a}"?', { a: fix.label }))
      } catch {
        /* 非 TTY 等确认失败按跳过处理 */
      }
      if (!go) {
        skipped++
        continue
      }
    }
    try {
      const detail = await fix.run()
      done++
      console.log(c.green(`✓ ${fix.label}${detail ? t('：{d}', ': {d}', { d: detail }) : ''}`))
    } catch (e) {
      failed++
      console.error(c.red(t('✗ {a} 失败：{m}', '✗ {a} failed: {m}', { a: fix.label, m: (e as Error).message })))
    }
  }
  if (skipped) console.log(c.gray(t('已跳过 {n} 项待确认的修复（--yes 可跳过确认）', 'Skipped {n} fix(es) pending confirmation (--yes to skip prompts)', { n: skipped })))
  console.log(c.gray(t('修复结束（成功 {d} / 失败 {f}）', 'Fixes finished ({d} ok / {f} failed)', { d: done, f: failed })))
  return { done, failed, skipped }
}

function findingsToJson(findings: DoctorFinding[]): unknown {
  const n = (lv: DoctorLevel) => findings.filter((f) => f.level === lv).length
  return {
    version: 1,
    ok: findings.every((f) => f.level !== 'bad'),
    summary: {
      total: findings.length,
      ok: n('ok'),
      warn: n('warn'),
      bad: n('bad'),
      info: n('info'),
      fixable: findings.filter((f) => f.fix).length,
    },
    findings: findings.map((f) => ({
      id: f.id,
      level: f.level,
      msg: f.msg,
      ...(f.hint ? { hint: f.hint } : {}),
      ...(f.fix ? { fix: { kind: f.fix.kind, target: f.fix.target, confirm: f.fix.confirm } } : {}),
    })),
  }
}

export async function cmdDoctor(
  opts: { fix?: boolean; yes?: boolean; json?: boolean; deep?: boolean } = {},
  deps: DoctorDeps = {}
): Promise<void> {
  const dOpts = { deep: opts.deep ?? false }
  const findings = await collectDoctorFindings({ ...deps, fixYes: opts.yes ?? deps.fixYes }, dOpts)
  if (opts.json) {
    console.log(JSON.stringify(findingsToJson(findings), null, 2))
    // 退出码语义（npm/flutter doctor 同款）：存在 bad 即 1，脚本/CI 可据此分支
    if (findings.some((f) => f.level === 'bad')) process.exitCode = 1
    return
  }
  printDoctor(findings)
  printSummary(findings)
  let fixResult: { done: number; failed: number; skipped: number } | null = null
  if (opts.fix) fixResult = await runFixes(findings, { yes: opts.yes }, deps)
  let finalBad = findings.some((f) => f.level === 'bad')
  // 修复后自动复核：至少执行过一个修复才值得重跑；与首轮同 deep 口径——deep 项虽不带修复，
  // 检查集不同会把「深检 bad」误判成「已解决」（浅检没有该 id）
  if (fixResult && fixResult.done > 0) {
    const after = await collectDoctorFindings({ ...deps, fixYes: opts.yes ?? deps.fixYes }, dOpts)
    printRecheck(diffFindings(findings, after))
    finalBad = after.some((f) => f.level === 'bad')
  }
  if (finalBad) process.exitCode = 1
}

export async function cmdTest(
  profileArg: string | undefined,
  opts: { model?: string; timeout?: string }
): Promise<void> {
  const live = await requireGateway()
  const cfg = await loadCfg()
  const profileName = profileArg ?? cfg.active_profile
  if (!profileName) {
    console.error(c.red(t('✗ 未指定 profile 且未设置 active_profile', '✗ No profile given and active_profile is not set')))
    process.exit(1)
  }
  console.log(c.gray(t('经网关对「{p}」发一次最小请求（stream）…', 'Sending a minimal request to "{p}" through the gateway (stream)…', { p: profileName })))
  try {
    const res = await fetch(`http://127.0.0.1:${live.port}/_modeldock/test`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-modeldock-admin': live.admin_token },
      body: JSON.stringify({ profile: profileName, model: opts.model, stream: true }),
      signal: AbortSignal.timeout((Number(opts.timeout) || 90) * 1000),
    })
    const text = await res.text()
    let j: { ok: boolean; status: number; ms: number; model?: string; usage?: Record<string, number>; err?: string; hint?: string }
    try {
      j = JSON.parse(text)
    } catch {
      exitWithError(
        t('网关返回非 JSON 响应（HTTP {s}）：{b}', 'The gateway returned a non-JSON response (HTTP {s}): {b}', { s: res.status, b: text.slice(0, 120) }),
        t('modeldock gateway status 检查网关状态；端口可能被其他服务占用（modeldock gateway stop 后重启）', 'Check the gateway with modeldock gateway status; the port may be taken by another service (stop with modeldock gateway stop, then restart)')
      )
    }
    if (j.ok) {
      const usage = j.usage ? `  usage=${JSON.stringify(j.usage)}` : ''
      console.log(c.green(t('✓ 畅通：{p} / {m}  {ms}ms{u}', '✓ OK: {p} / {m}  {ms}ms{u}', { p: profileName, m: String(j.model), ms: j.ms, u: usage })))
    } else {
      console.error(c.red(t('✗ 不通：HTTP {s}  {ms}ms', '✗ Failed: HTTP {s}  {ms}ms', { s: j.status, ms: j.ms })))
      if (j.err) console.error(c.gray(`  ${j.err}`))
      if (j.hint) console.error(c.yellow(t('提示: {h}', 'Hint: {h}', { h: j.hint })))
      process.exit(1)
    }
  } catch (e) {
    exitWithError(t('测试失败：{m}', 'Test failed: {m}', { m: (e as Error).message }), (e as Error).name === 'TimeoutError' ? t('上游响应超时，可用 -t 加大秒数', 'The upstream timed out. Increase the seconds with -t') : undefined)
  }
}

export async function cmdEnv(): Promise<void> {
  let cfg = await loadConfig()
  if (!cfg.harness['generic-env']) {
    const token = randomToken('mdk_generic')
    await mutateConfig((c2) => {
      c2.harness['generic-env'] = {
        mode: 'gateway',
        route: 'default',
        token,
        attached_at: new Date().toISOString(),
        files: [],
      }
    })
    console.error(c.gray(t('# 已自动创建 generic-env 接管（无文件改动）；撤销：modeldock detach generic-env', '# generic-env attach was created automatically (no files changed). Undo: modeldock detach generic-env')))
    cfg = await loadConfig()
  }
  // 端口与 gateway status / modeldock test 同源（gatewayLive 优先）：运行中实例的实际端口
  // 即便不是默认端口也如实输出——用户刚起了一个非默认端口实例，env 就该指向它。
  // 刻意不走 resolveClientGatewayPort：那条链供写客户端文件用，为 CORRECT-05 / 2026-10-01
  // 事故固定「生产默认端口存活优先」，会压过状态文件里的非默认实例（2026-10-29 实测 env 恒打 8687）。
  // 无 live 实例回落 config.gateway.port，再回落 DEFAULT_GATEWAY_PORT（与 cmdStatus 同款链）。
  const live = await gatewayLive()
  const port = live?.port ?? cfg.gateway?.port ?? DEFAULT_GATEWAY_PORT
  const token = cfg.harness['generic-env'].token
  console.log(t('# source 到 shell：eval "$(modeldock env)"', '# Source into your shell: eval "$(modeldock env)"'))
  console.log(`export ANTHROPIC_BASE_URL=http://127.0.0.1:${port}`)
  console.log(`export ANTHROPIC_AUTH_TOKEN=${token}`)
  console.log(`export OPENAI_BASE_URL=http://127.0.0.1:${port}/v1`)
  console.log(`export OPENAI_API_KEY=${token}`)
}
