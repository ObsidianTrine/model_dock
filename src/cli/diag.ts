import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { c, maskSecret, printTable, randomToken, t } from '../util/index.js'
import { loadConfig, mutateConfig } from '../config/store.js'
import type { Config } from '../config/types.js'
import { getSecret, parseKeyRef, pickFileCipher, verifySecretsStore } from '../config/secrets.js'
import { allAdapters } from '../adapters/registry.js'
import { autostartKind, parseRunCommandLine, windowsStartupPath, windowsRunValueMirrorFile,
  autostartStatus,
  gatewayDaemonArgs,
  readRecordedArgv,
  recordedArgvStale,
  serviceFilePath,
  uninstallAutostart,
} from '../autostart.js'
import { autostartLine } from './gatewaycmd.js'
import { DEFAULT_GATEWAY_PORT, gatewayLive, loadCfg, requireGateway, exitWithError, spawnDaemonAndWait } from './shared.js'
import { resolveClientGatewayPort } from '../ops.js'
import { modeldockDir, secretsPath } from '../util/paths.js'
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
  kind: 'start-gateway' | 'model-refresh' | 'attach' | 'set-proxy' | 'remove-dangling-profiles' | 'autostart-cleanup'
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
  /** 注入端口占用探测（单测免真实 socket） */
  portProbe?: (port: number) => Promise<boolean>
  /** 注入修复确认（单测免 TTY） */
  confirm?: (message: string) => Promise<boolean>
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
          // nativePrefix 为空（本平台 file 后端无加密，如 darwin keychain 形态）时，任何 enc: 密文都
          // 不是本机产出的——统一按异机密文报（否则 !v.startsWith('') 恒假，darwin 永不触发）
          if (typeof v === 'string' && v.startsWith('enc:') && (nativePrefix === '' || !v.startsWith(nativePrefix))) {
            foreignIds.add(k)
            hits.push(`${k}(${v.slice(0, v.indexOf(':', 4) + 1)})`)
          }
        }
      }
    }
  } catch {
    /* 解析失败：secrets.json 损坏由 secrets.store 项报告，此处不重复 */
  }
  for (const [pid, p] of Object.entries(cfg.providers)) {
    if (p.key_ref.includes('enc:mach:') || p.key_ref.includes('enc:dpapi:')) {
      hits.push(`${pid}(key_ref)`)
      continue
    }
    const ref = parseKeyRef(p.key_ref)
    if (ref.scheme === 'file' && foreignIds.has(ref.id)) hits.push(`${pid}(key_ref→${ref.id})`)
  }
  return hits
}

export async function collectDoctorFindings(deps: DoctorDeps = {}): Promise<DoctorFinding[]> {
  const F: DoctorFinding[] = []
  const ok = (id: string, msg: string) => F.push({ id, level: 'ok', msg })
  const warn = (id: string, msg: string, hint?: string, fix?: DoctorFix) => F.push({ id, level: 'warn', msg, hint, fix })
  const bad = (id: string, msg: string, hint?: string, fix?: DoctorFix) => F.push({ id, level: 'bad', msg, hint, fix })
  const info = (id: string, msg: string, hint?: string) => F.push({ id, level: 'info', msg, hint })

  let cfg
  try {
    cfg = await loadConfig()
  } catch (e) {
    bad('config.parse', (e as Error).message, t('modeldock config edit 修复', 'Fix it with modeldock config edit'))
    return F
  }
  ok('config.parse', t('config.toml 可解析（version {v}）', 'config.toml parses (version {v})', { v: cfg.version }))

  // 密钥库整表可读性：损坏时逐条 key 检查只会重复报同一根因，后续跳过
  let secretsOk = true
  try {
    const sv = await verifySecretsStore()
    if (!sv.ok) {
      secretsOk = false
      bad('secrets.store', sv.error, t('各密钥重新设置：modeldock provider set-key <id>', 'Re-set your keys: modeldock provider set-key <id>'))
    }
  } catch {
    /* 验证自身异常不拦截：交由逐条 key 检查暴露 */
  }

  // 跨机密文引用（REVIEW-18）：file 后端密文绑定原机器/平台（win DPAPI / linux machine-id），
  // 跨机拷贝 home 后本机解不开、发上游必 401。在通用 secrets.store 报错之上点名受影响引用与服务，
  // 提示对相应服务重新 set-key（--json 消费方按 id=secrets.foreign_cipher 识别）
  const foreignRefs = await detectForeignCipherRefs(cfg)
  if (foreignRefs.length) {
    bad(
      'secrets.foreign_cipher',
      t('此配置含他机密文引用（{list}）：密文绑定其他机器/平台，本机无法解密', 'This config contains cross-machine ciphertext references ({list}): the ciphertext is bound to another machine or platform and cannot be decrypted here', { list: foreignRefs.join(', ') }),
      t('对相应服务重新设置密钥：modeldock provider set-key <服务 id>；不要直接把别机的 secrets.json 拷到本机', "Re-set the key for each affected service: modeldock provider set-key <provider id>; do not copy another machine's secrets.json here")
    )
  }

  const live = await gatewayLive()
  const cfgPort = cfg.gateway?.port ?? DEFAULT_GATEWAY_PORT
  if (live) {
    ok('gateway.up', t('网关运行中 127.0.0.1:{port}（pid {pid}）', 'Gateway running on 127.0.0.1:{port} (pid {pid})', { port: live.port, pid: live.pid }))
    if (live.port !== cfgPort) {
      warn(
        'gateway.port_drift',
        t('网关实际监听 {actual}，与配置端口 {configured} 不一致（配置端口被占用时启动会漂移）', 'The gateway listens on {actual}, not the configured port {configured} (start drifts when the configured port is taken)', { actual: live.port, configured: cfgPort }),
        t('解除端口占用后 modeldock gateway stop 再启动，即回到配置端口', 'Free the port, then modeldock gateway stop and start again to return to the configured port')
      )
    }
  } else {
    warn(
      'gateway.down',
      t('网关未运行', 'The gateway is not running'),
      'modeldock gateway start --daemon',
      {
        kind: 'start-gateway',
        confirm: false,
        label: t('启动网关（后台）', 'Start the gateway (background)'),
        run:
          deps.startGateway ??
          (async () => {
            const state = await spawnDaemonAndWait([...gatewayDaemonArgs(), '--port', String(cfgPort)])
            if (!state) throw new Error(t('后台启动超时；前台运行 modeldock gateway start 查看错误', 'Background start timed out; run "modeldock gateway start" in the foreground for details'))
            return `http://127.0.0.1:${state.port}`
          }),
      }
    )
    const busy = deps.portProbe ? await deps.portProbe(cfgPort) : await portInUse(cfgPort)
    if (busy) {
      warn(
        'gateway.port_busy',
        t('配置端口 {port} 已被其他进程占用：网关启动后将改用其他端口', 'Configured port {port} is taken by another process: the gateway will fall back to another port on start', { port: cfgPort }),
        t('查看占用者：lsof -nP -iTCP:{port} -sTCP:LISTEN（Windows：netstat -ano | findstr {port}）', 'Find the occupier: lsof -nP -iTCP:{port} -sTCP:LISTEN (Windows: netstat -ano | findstr {port})', { port: cfgPort })
      )
    }
  }

  if (!probeFsWatch()) {
    warn(
      'gateway.watch',
      t('配置目录监听不可用（fs.watch 异常）：网关热加载失效，改配置不会自动生效', 'Config-dir watching is unavailable (fs.watch error): gateway hot-reload is broken; config changes will not apply automatically'),
      t('先重启网关试试；仍不行就改配置后手动热加载（POST /_modeldock/reload）或重启网关', 'Restart the gateway first; if it persists, reload manually after changes (POST /_modeldock/reload) or restart the gateway')
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
    if (sandboxHit) {
      warn(
        'autostart.residue',
        t('开机自启登记指向沙箱路径（{a}）：多为旧版沙箱自启残留，下次登录会拉起失效实例', 'The autostart entry points into a sandbox path ({a}): likely residue from an old sandbox install; it will launch a broken instance at next login', { a: sandboxHit }),
        t('确认是残留后用 --fix 移除（删除登记文件并卸载服务），或手动 modeldock gateway uninstall', 'Remove it with --fix after confirming it is residue (deletes the entry file and unloads the service), or run modeldock gateway uninstall manually'),
        autostartCleanup
      )
    } else if (recordedArgvStale(argv)) {
      const staleArg = fs.existsSync(argv[0]) ? (argv.slice(1).find((a) => !a.startsWith('--') && !fs.existsSync(a)) ?? argv[0]) : argv[0]
      warn(
        'autostart.residue',
        t('开机自启登记的启动命令指向不存在的文件（{a}）：下次登录自启将静默失败', 'The autostart start command points at missing files ({a}): autostart will silently fail at next login', { a: staleArg }),
        t('重装自启：modeldock gateway uninstall 后再 modeldock gateway install；不再需要可用 --fix 移除登记', 'Reinstall it: modeldock gateway uninstall then modeldock gateway install; or remove the entry with --fix if no longer needed'),
        autostartCleanup
      )
    } else {
      ok('autostart.entry', t('开机自启登记有效（{f}）', 'Autostart entry is healthy ({f})', { f: svcFile }))
    }
  }

  // 悬空 profile：引用的 provider 不存在（active_profile 的在下方链路体检里报告，这里只收其余）。
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
    bad(
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

  const ap = cfg.active_profile
  if (!ap) warn('profile.active', t('未设置 active_profile', 'active_profile is not set'), 'modeldock profile use <name>')
  else {
    const profile = cfg.profiles[ap]
    if (!profile) bad('profile.active', t('active_profile「{a}」不存在', 'active_profile "{a}" does not exist', { a: ap }), 'modeldock profile list')
    else {
      const provider = cfg.providers[profile.provider]
      if (!provider) bad('profile.active', t('profile「{a}」的 provider「{p}」不存在', 'provider "{p}" of profile "{a}" does not exist', { a: ap, p: profile.provider }))
      else {
        ok('profile.active', t('active_profile「{a}」→ {p}（{u}）', 'active_profile "{a}" → {p} ({u})', { a: ap, p: provider.name ?? profile.provider, u: provider.base_url }))
        if (secretsOk) {
          try {
            const key = await getSecret(provider.key_ref)
            if (key) ok('provider.key', t('上游 key 可读取（{k}）', 'Upstream key is readable ({k})', { k: maskSecret(key) }))
            else bad('provider.key', t('上游 key 不可用（key_ref={r}）', 'Upstream key is unavailable (key_ref={r})', { r: provider.key_ref }), `modeldock provider set-key ${profile.provider}`)
          } catch (e) {
            // 读取失败（钥匙环被锁/暂时不可用）≠ 未配置密钥：前者是瞬时故障、解锁即恢复，
            // 报 warn + 解锁 hint，不与缺失条目（bad + set-key）混同（REVIEW-19 语义对齐）
            warn(
              'provider.key',
              t('上游 key 读取失败：{m}', 'Failed to read the upstream key: {m}', { m: (e as Error).message }),
              t('这是读取故障（如钥匙环被锁定），与未配置密钥不同：解锁钥匙环后重跑 modeldock doctor 即可恢复；反复出现可改用 file 存储后重新 set-key', 'This is a read failure (e.g. a locked keyring), not a missing key: unlock the keyring and re-run modeldock doctor to recover; if it keeps happening, switch to file storage and re-set the key')
            )
          }
        }
        const reach = await upstreamReachable(provider.base_url, provider.proxy)
        if (reach.ok) ok('upstream.reach', t('上游可达：{d}', 'Upstream is reachable: {d}', { d: reach.detail }))
        else {
          const proxyEnv = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy'].some((k) => process.env[k])
          const canProxyFix = !provider.proxy && proxyEnv
          bad(
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
          warn(
            'models.empty',
            t('该 provider 模型目录为空', 'This provider has an empty model catalog'),
            `modeldock model refresh ${profile.provider}`,
            {
              kind: 'model-refresh',
              target: profile.provider,
              confirm: false,
              label: t('拉取模型目录（{p}）', 'Fetch the model catalog ({p})', { p: profile.provider }),
              run: async () => {
                // 惰性加载：providers 链上挂着 789KB catalog snapshot，status/doctor 只读路径不付这个成本
                const { refreshModelsInto } = await import('./providers.js')
                const r = await refreshModelsInto(profile.provider)
                return t('新增 {a} 个', '{a} added', { a: r.added })
              },
            }
          )
        } else if (profile.default_model && !(provider.models?.[profile.default_model]?.context_window)) {
          warn('model.meta', t('默认模型 {m} 缺上下文元数据', 'Default model {m} is missing context metadata', { m: profile.default_model }), `modeldock model set ${profile.provider} ${profile.default_model} --ctx <n>`)
        }
      }
    }
  }

  const port = live?.port ?? cfgPort
  // 并行探测（status 各自独立只读）；单个 adapter 异常（如 pack 目标文件损坏）不应击穿整条体检——
  // 错误随 adapter 带回，按原顺序逐个输出
  const doctorAdapters = allAdapters(cfg)
  const doctorStatuses = await Promise.all(
    doctorAdapters.map(async (a) => [a, await a.status(cfg, port).catch((e: Error) => e)] as const)
  )
  for (const [a, st] of doctorStatuses) {
    if (st instanceof Error) {
      bad('harness.status_error', t('{l}：状态检查失败（{m}）', '{l}: status check failed ({m})', { l: a.label, m: st.message }), t('modeldock adapter list 查看；若配置了 adapter pack 请检查目标文件', 'Run modeldock adapter list to inspect; if an adapter pack is configured, check its target files'))
      continue
    }
    if (st.attached && st.pointing === 'gateway') ok('harness.pointing', t('{l}：已接管且指向网关', '{l}: attached and pointing at the gateway', { l: a.label }))
    else if (st.attached && st.pointing === 'other')
      bad(
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
    else if (st.attached) warn('harness.pointing', t('{l}：已接管但未检测到指向（file 模式或待重启）', '{l}: attached but no pointing detected (file mode, or restart pending)', { l: a.label }))
    else if (st.installed) warn('harness.detached', t('{l}：已安装未接管（不影响使用）', '{l}: installed but not attached (no impact on use)', { l: a.label }), `modeldock attach ${a.id}`)
    else if (a.id !== 'generic-env') info('harness.absent', t('{l}：未安装，跳过', '{l}: not installed, skipped', { l: a.label }))
  }

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

async function defaultConfirm(message: string): Promise<boolean> {
  const { confirm } = await import('@inquirer/prompts')
  return confirm({ message })
}

/** 执行体检发现的修复：confirm=false 直接执行；confirm=true 无 --yes 时逐项确认。
 *  单个修复失败不中断后续；确认失败（非 TTY 等）按跳过处理。导出供单测直测。 */
export async function runFixes(findings: DoctorFinding[], opts: { yes?: boolean }, deps: DoctorDeps = {}): Promise<void> {
  const fixable = findings.filter((f) => f.fix)
  if (fixable.length === 0) {
    console.log(c.gray(t('没有可自动执行的修复项', 'Nothing to auto-fix')))
    return
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
  console.log(c.gray(t('修复结束（成功 {d} / 失败 {f}）；重跑 modeldock doctor 验证', 'Fixes finished ({d} ok / {f} failed); re-run modeldock doctor to verify', { d: done, f: failed })))
}

function findingsToJson(findings: DoctorFinding[]): unknown {
  return {
    version: 1,
    ok: findings.every((f) => f.level !== 'bad'),
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
  opts: { fix?: boolean; yes?: boolean; json?: boolean } = {},
  deps: DoctorDeps = {}
): Promise<void> {
  const findings = await collectDoctorFindings({ ...deps, fixYes: opts.yes ?? deps.fixYes })
  if (opts.json) {
    console.log(JSON.stringify(findingsToJson(findings), null, 2))
    return
  }
  printDoctor(findings)
  if (opts.fix) await runFixes(findings, { yes: opts.yes }, deps)
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
  const port = await resolveClientGatewayPort(undefined, cfg.gateway?.port)
  const token = cfg.harness['generic-env'].token
  console.log(t('# source 到 shell：eval "$(modeldock env)"', '# Source into your shell: eval "$(modeldock env)"'))
  console.log(`export ANTHROPIC_BASE_URL=http://127.0.0.1:${port}`)
  console.log(`export ANTHROPIC_AUTH_TOKEN=${token}`)
  console.log(`export OPENAI_BASE_URL=http://127.0.0.1:${port}/v1`)
  console.log(`export OPENAI_API_KEY=${token}`)
}
