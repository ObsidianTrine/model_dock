import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import fsp from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { pipeline } from 'node:stream/promises'
import { createHash, randomBytes } from 'node:crypto'
import { safeEqual } from '../util/safe-equal.js'
import { fetchEnvelopeFromUrl, projectModel } from './shared.js'
import { clearCommandMemo, commandOnPath, commandOnPathSandbox, randomToken, readTextIfExists } from '../util/fsx.js'
import { localIsoTs } from '../util/time.js'
import { ConfigError, loadConfig, mutateConfig } from '../config/store.js'
import { DEFAULT_GATEWAY_PORT, DEFAULT_LAN_PORT, type Config, type ProviderConfig } from '../config/types.js'
import { defaultStore, deleteSecret, getSecret, setSecret } from '../config/secrets.js'
import { allAdapters, requireAdapter } from '../adapters/registry.js'
import { isNpmGlobalInstall, resolveInstallCommand, type ClientInstall, type HarnessAdapter } from '../adapters/types.js'
import { engineWarningHint, ensureNodeRuntime, installChildEnv } from '../install/noderuntime.js'
import { applyChanges } from '../adapters/engine.js'
import { PRESETS, ensurePresetsLoaded, knownModelsForBaseUrl, presetModels } from '../presets/data.js'
import { addService, applyAttach, detachHarness, planAttach, refreshBakedModelClients, removeProviderCascade, resyncHarnessToRoute, setAutoRoute, setRouteNext, switchHarnessMode, switchToService, syncBakedClientsForDisplayRoute } from '../ops.js'
import { autostartOverview, installAutostart, uninstallAutostart, updateDaemonArgs } from '../autostart.js'
import { applyImport, normalizeBaseUrl, scanSources } from '../import/sources.js'
import { resolveModelMeta, fullKnownTable } from '../providers/resolve.js'
import { knownMetaTable, saneCapabilities } from '../providers/known.js'
import { refreshCatalog } from '../providers/catalog.js'
import { fetchModelIds } from '../providers/fetch.js'
import { autoRouteInfo, dispatcherFor, isMeltdown, logAudit, logRequest, parseFallbackEntry, readGatewayState, reloadRuntime, resolveByProfile, resolveTarget, writeGatewayState, type GatewayRuntime, type LogEntry, type ResolvedTarget } from './state.js'
import { buildLanStatus, clearSyncRequest, createSyncOffer, peekSyncRequest, putSyncGrant, refreshPreferredAddress, resolveLanToken, startLanServer, stopLan } from './lan.js'
import { discoverPeers } from './discover.js'
import { adminCookieName, deviceCookieName } from './cookies.js'
import { createUsageTap } from './usage.js'
import { refreshCalendar } from './holidays.js'
import { syncStatus } from '../sync/engine.js'
import { openEnvelope, sealEnvelope } from '../sync/crypto.js'
import { applyImportedDoc, assertExportable, exportFileName, reportOfDoc } from '../sync/exportImport.js'
import { collectSyncdoc } from '../sync/collect.js'
import { validateSyncdoc, type Syncdoc } from '../sync/types.js'
import { applyUpdate, getUpdateStatus, kickUpdateCheck } from '../update/webupdate.js'
import { filterResponseHeaders, forwardToUpstream, forwardWithFailover, translateUpstreamError, UpstreamError, type UpstreamResult } from './relay.js'
import { request as undiciRequest } from 'undici'
import { t, bi, biCat, biJoin, runWithLang, normalizeLang, getLang, type Bilingual } from '../util/i18n.js'
import { displayPath, gatewayStatePath, logsDir, sandboxNpmPrefix } from '../util/paths.js'
import { UI_HTML } from './ui.js'

export interface GatewayStartOptions {
  port: number
  idleTimeoutMs?: number
  retries?: number
  /** 法定节假日每年自动获取（holiday-cn 数据）；默认开启，测试传 false 避免 90s 首查触发出站请求 */
  autoHolidayRefresh?: boolean
  /** 模型元数据目录（models.dev）自动刷新；默认开启，测试传 false 避免出站请求 */
  autoCatalogRefresh?: boolean
}

/** 锁屏提示展示的 gateway.json 路径：随实例实际 home 走（沙箱/自定义 home 时不是 ~/.modeldock），
 *  缩写规则统一走 paths.displayPath（只对真实系统 home 缩写为 ~） */
// 控制台 HTML 体与 home 路径在单进程内固定（displayPath(gatewayStatePath()) 只随环境变量走），
// 惰性渲染一次后缓存最终 HTML 与其内容 ETag，避免每请求整包 replaceAll + 算 hash。
// 缓存以 home 路径为键：生产单进程恒定只算一次；单进程共享单测（fakeHome 每用例换 home）
// 在 home 变化时自动重渲，不服务到旧路径。
// lang 不含进缓存键：UI_HTML 文案经 data-i18n 浏览器端切换，静态体与请求语言无关。
let renderedUICache: { home: string; html: string; etag: string } | null = null
function getRenderedUI(): { html: string; etag: string } {
  const home = gatewayStatePath()
  if (renderedUICache && renderedUICache.home === home) return renderedUICache
  const html = UI_HTML
    .replaceAll('__MD_GATEWAY_STATE__', displayPath(home))
    .replaceAll('__MD_LOGS_DIR__', displayPath(logsDir()))
  const etag = '"' + createHash('sha256').update(html).digest('base64url').slice(0, 22) + '"'
  renderedUICache = { home, html, etag }
  return renderedUICache
}

const MAX_BODY = 64 * 1024 * 1024

/** 收集命令输出的上限（防止日志/响应被刷爆） */
const INSTALL_OUTPUT_MAX = 4000

function runShell(cmd: string, onOut: (c: string) => void, env?: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(cmd, { shell: true, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env })
    child.stdout?.on('data', (d) => onOut(String(d)))
    child.stderr?.on('data', (d) => onOut(String(d)))
    child.on('error', (e) => {
      onOut(String(e.message))
      resolve(1)
    })
    child.on('close', (code) => resolve(code ?? 1))
  })
}

/** 子进程引导共步（安装/卸载的 env 构造 + Node 保障 + PATH 前置 + 执行）：installChildEnv 统一构造
 *  子进程 env，needsNode 时先 ensureNodeRuntime 并把托管 bin 前置 PATH，再 runShell 执行。
 *  返回未被截尾的原始输出数组与退出码；Node 保障失败时 exit 为 null、output 携带失败消息（调用方各自落失败态）。 */
async function runInstallCommand(cmd: string, needsNode: boolean): Promise<{ exit: number | null; output: string[] }> {
  const output: string[] = []
  const env = installChildEnv(process.env)
  if (needsNode) {
    try {
      const nrt = await ensureNodeRuntime((l) => output.push(l + '\n'))
      env.PATH = nrt.binDir + path.delimiter + (env.PATH ?? '')
    } catch (e) {
      output.push((e as Error).message)
      return { exit: null, output }
    }
  }
  const exit = await runShell(cmd, (c) => output.push(c), env)
  return { exit, output }
}

/**
 * 客户端安装：有 install.command 则 shell 执行（npm 类 / 平台脚本类自动安装）→ 成功且声明 bootstrap
 * 则复用 applyChanges 补写空配置文件（自动快照 + 原子写，让 detect 生效、attach 可跑）；无 command
 * 的客户端（ZCode/WorkBuddy）不执行，仅返回指引。needsNode 的命令（npm 类）先 ensureNodeRuntime——
 * 本机无 Node 时下载托管运行时，其 bin 目录前置到子进程 PATH（系统 node 经 well-known 命中时同样
 * 前置：LaunchAgent 的 PATH 常缺 nvm 目录，不前置子进程找不到 npm）；子进程 env 经 installChildEnv
 * 统一构造（剥 npm_* 泄漏 + 注镜像 registry + 沙箱落点）。沙箱模式（MODELRDOCK_FAKE_HOME）只放行
 * 可重定向落点的 npm 全局安装——npm_config_prefix/cache 指进沙箱，不碰宿主全局 prefix；脚本类
 * 安装（curl|bash、irm|iex 等）落点无法重定向，拒绝并提示手动安装。声明 install.probe 的先探测：
 * 命令已在 PATH 就跳过安装——页面状态可能是旧的（用户在别处刚装好），而 npm 全局重装会先把现有
 * 安装目录与 shim 改名 retire 再重建，postinstall 一旦不成功就只剩报错桩，把本来可用的命令弄坏。
 */
export async function runClientInstall(
  adapter: HarnessAdapter,
  cfg: Config,
  port: number
): Promise<{ ok: boolean; auto: boolean; output: string; installed: boolean; skipped: boolean; blocked?: boolean }> {
  const inst = adapter.install
  const lines: string[] = []
  let skipped = false
  if (inst?.command) {
    if (inst.probe && probePresent(inst, inst.probe)) {
      skipped = true
      lines.push(t('已在 PATH 上检测到 {cmd} 命令，跳过安装步骤（不重跑 npm 全局安装）', 'Found {cmd} already on PATH, skipping install (npm global install not re-run)', { cmd: inst.probe }))
    } else {
      const cmd = resolveInstallCommand(inst.command)
      if (cmd === null) {
        // 类型上不可达（command 存在才有 cmd）；防御性兜底走指引分支
        lines.push(t('未配置可执行的安装命令', 'No executable install command configured'))
      } else if (sandboxNpmPrefix() && !isNpmGlobalInstall(cmd) && process.env.MODELRDOCK_INSTALL_ALLOW_ANY !== '1') {
        // MODELRDOCK_INSTALL_ALLOW_ANY=1 为单测桩命令（node -e 等）放行，受控环境专用
        lines.push(t(
          '沙箱环境不支持自动安装该客户端：其安装方式（{cmd}）会把程序写进真机，沙箱无法重定向其落点。请按页面安装指引手动安装（装好后点「重新检测」即可接入沙箱配置）',
          'Sandbox cannot auto-install this client: its install method ({cmd}) writes to the real machine and cannot be redirected. Install manually per the guide, then click Re-detect to attach the sandbox config',
          { cmd }
        ))
        return { ok: false, auto: true, output: tailText(lines), installed: false, skipped: false, blocked: true }
      } else {
        const { exit, output } = await runInstallCommand(cmd, !!inst.needsNode)
        if (exit === null) {
          // Node 保障失败：只报引导错误
          return { ok: false, auto: true, output: tailText(output), installed: false, skipped: false }
        }
        // npm 对 engines 不匹配默认只警告（EBADENGINE）不拦：钉死的托管 Node 过期后新客户端
        // 会「装成功、跑就崩」——把埋在日志里的警告提升为可操作提示，失败/成功路径都要可见
        const engineHint = inst.needsNode ? engineWarningHint(output.join('')) : null
        if (exit !== 0) {
          if (engineHint) output.push(engineHint)
          return { ok: false, auto: true, output: tailText(output), installed: false, skipped: false }
        }
        // 成功也带回子进程输出（npm 进度/下载占比），tailText 统一截尾
        const childOut = output.join('').trim()
        if (childOut) lines.push(childOut)
        if (engineHint) lines.push(engineHint)
        lines.push(t('已执行安装命令：{cmd}', 'Ran install command: {cmd}', { cmd }))
      }
    }
    if (inst.bootstrap && inst.bootstrap.path) {
      const bp = typeof inst.bootstrap.path === 'function' ? inst.bootstrap.path() : inst.bootstrap.path
      // bootstrap 语义是"补写空配置"，不是覆盖：文件已存在时原样保留（before:null 的写入会被引擎的乐观锁拦下）
      if ((await readTextIfExists(bp)) === null) {
        await applyChanges(adapter.id, 'install', [{ path: bp, before: null, after: inst.bootstrap.content }], { yes: true, quiet: true })
        lines.push(t('已写入空配置：{path}', 'Wrote empty config: {path}', { path: bp }))
      } else {
        lines.push(t('配置已存在，保留不动：{path}', 'Config already exists, left untouched: {path}', { path: bp }))
      }
    }
  }
  // 同一进程刚跑完安装命令就重查 status：PATH memo（PERF-07）可能仍缓存着安装前的 miss，
  // 不主动失效会让「装完立即可见」缩水为最多 45s 延迟（review_blockers 记）
  clearCommandMemo()
  const st = await adapter.status(cfg, port)
  return { ok: true, auto: !!inst?.command, output: tailText(lines), installed: st.installed, skipped }
}

/**
 * 客户端卸载：有 install.uninstall 则 shell 执行（仅 npm 类客户端声明），与安装共用同一套子进程
 * 环境（installChildEnv——沙箱下全局落点经 npm_config_prefix 重定向，只卸装进沙箱的副本；
 * needsNode 时先保障 node/npm 可用，托管 runtime 的 shim 在托管 bin 下、PATH 缺它找不到 npm）。
 * probe 未命中说明命令已不在（从未装或已手动卸载），跳过执行仅做 bootstrap 清理；未声明
 * uninstall 的客户端（脚本类安装器 / 桌面应用）拒绝并提示手动卸载。bootstrap 清理：文件内容
 * 恰为安装时写入的空配置（字节相等）才删除，让 detect 回到「未安装」；有用户内容一律保留。
 */
export async function runClientUninstall(
  adapter: HarnessAdapter,
  cfg: Config,
  port: number
): Promise<{ ok: boolean; output: string; installed: boolean; skipped: boolean }> {
  const inst = adapter.install
  const lines: string[] = []
  let skipped = false
  const cmd = resolveInstallCommand(inst?.uninstall)
  if (!cmd) {
    lines.push(t('该客户端未配置自动卸载方式，请按安装指引手动卸载', 'This client has no automated uninstall; please uninstall it manually per the install guide'))
    return { ok: false, output: tailText(lines), installed: (await adapter.status(cfg, port)).installed, skipped }
  }
  if (inst?.probe && !probePresent(inst, inst.probe)) {
    skipped = true
    lines.push(t('{cmd} 命令不在 PATH 上，无需卸载', '{cmd} is not on PATH; nothing to uninstall', { cmd: inst.probe }))
  } else {
    const { exit, output } = await runInstallCommand(cmd, !!inst?.needsNode)
    if (exit === null) {
      // Node 保障失败：只报引导错误
      return { ok: false, output: tailText(output), installed: (await adapter.status(cfg, port)).installed, skipped }
    }
    if (exit !== 0) {
      clearCommandMemo() // 卸载命令已执行（不排除部分删除），重查 status 前主动失效 PATH memo
      return { ok: false, output: tailText(output), installed: (await adapter.status(cfg, port)).installed, skipped }
    }
    const childOut = output.join('').trim()
    if (childOut) lines.push(childOut)
    lines.push(t('已执行卸载命令：{cmd}', 'Ran uninstall command: {cmd}', { cmd }))
  }
  if (inst?.bootstrap?.path) {
    const bp = typeof inst.bootstrap.path === 'function' ? inst.bootstrap.path() : inst.bootstrap.path
    if ((await readTextIfExists(bp)) === inst.bootstrap.content) {
      try {
        await fsp.unlink(bp)
        lines.push(t('已删除安装时写入的空配置：{path}', 'Removed the empty bootstrap config written at install time: {path}', { path: bp }))
      } catch { /* 删除失败不阻断卸载结果 */ }
    } else if (await readTextIfExists(bp) !== null) {
      lines.push(t('配置文件已含其他内容，保留不动：{path}', 'Config file has other content, left untouched: {path}', { path: bp }))
    }
  }
  // 同一进程刚跑完卸载命令就重查 status：主动失效 PATH memo，让「卸完立即可见」
  clearCommandMemo()
  const st = await adapter.status(cfg, port)
  return { ok: true, output: tailText(lines), installed: st.installed, skipped }
}

function tailText(lines: string[], max = INSTALL_OUTPUT_MAX): string {
  const text = lines.join('\n').trim()
  return text.length > max ? text.slice(-max) : text
}

/** 沙箱内该客户端的自动安装能力：无 command → null（本就只展示指引，不执行）；
 *  npm 全局安装 → 'redirect'（落点可重定向进沙箱）；脚本类 → 'unsupported'（写真机，沙箱内拒绝）。
 *  非沙箱恒为 null——UI 与安装行为均维持原样。 */
function sandboxInstallCapability(a: HarnessAdapter): 'redirect' | 'unsupported' | null {
  if (!sandboxNpmPrefix() || !a.install?.command) return null
  return isNpmGlobalInstall(resolveInstallCommand(a.install.command) ?? '') ? 'redirect' : 'unsupported'
}

/** Claude Code gateway discovery 的硬过滤：模型 ID 不含 claude/anthropic 字样的条目全部丢弃
 *  （2.1.296 二进制实测：filter(te=>/(claude|anthropic)/i.test(te.id))，全滤光时
 *  「0 usable models after filter」，/model 选择器只剩内置档位）。 */
const DISCOVERY_ID_RE = /(claude|anthropic)/i

/** discovery 场景服务的模型 ID：非 Claude 系 ID 加 `anthropic.` 前缀别名（Bedrock 同款惯例）
 *  以通过上述过滤；转发时 rewriteModel 按服务目录还原真实 ID，picker 标签仍显示 display_name。 */
function discoveryModelId(id: string): string {
  return DISCOVERY_ID_RE.test(id) ? id : `anthropic.${id}`
}

/** 本地合成 /v1/models 响应：Anthropic 形状为主（type/display_name + 分页字段），兼容 OpenAI 字段
 *  （object/created/owned_by）——两类 SDK 各取所需，多余字段互不解析。目录按写入顺序排列；
 *  有 display_name 的显示名称、没有的回落 ID；目录为空返回空列表（picker 无自定义项，
 *  档位请求仍走内置名兜底改写，不劣化）。discoveryAliases=true（请求带 anthropic-version 头，
 *  即 Claude Code discovery）时对非 Claude 系 ID 加 anthropic. 前缀别名，否则原样。 */
function modelsListPayload(cfg: Config, target: ResolvedTarget, discoveryAliases: boolean) {
  const provider = cfg.providers[target.profile.provider]
  const data = Object.entries(provider?.models ?? {}).map(([rawId, m]) => {
    const id = discoveryAliases ? discoveryModelId(rawId) : rawId
    return {
      id,
      type: 'model',
      display_name: m.display_name || rawId,
      object: 'model',
      created: 0,
      owned_by: target.profile.provider,
    }
  })
  return {
    data,
    first_id: data[0]?.id,
    has_more: false,
    last_id: data[data.length - 1]?.id,
  }
}

/** 安装/卸载前的 probe：可装进沙箱的 npm 类客户端在沙箱实例（FAKE_HOME）下只认沙箱内命中，
 *  宿主真机的同名命令不算数——否则真机装过的客户端在沙箱里永远「跳过安装」，卸载后状态
 *  也回不到未安装（2026-10-11 dev 沙箱实测踩中）。脚本类/桌面类只有真机一份拷贝，保持并集。 */
function probePresent(inst: ClientInstall, cmd: string): boolean {
  const sandboxIsolated = sandboxNpmPrefix() !== null && isNpmGlobalInstall(resolveInstallCommand(inst.command) ?? '')
  return sandboxIsolated ? commandOnPathSandbox(cmd) : commandOnPath(cmd)
}

/** 各网关实例的 picker 展示路由基线（route=上次已同步的展示服务）。模块级 WeakMap：周期检测
 *  在 createGatewayServer 闭包里跑，而 attach/apply handler 在 handleRequest 里——接入后把
 *  基线置 undefined（强制下一周期校准 picker）需要两处共享。按 rt 弱引用，实例关闭自动可回收。 */
const pickerSyncStates = new WeakMap<GatewayRuntime, { route?: string }>()

export function createGatewayServer(rt: GatewayRuntime, opts: GatewayStartOptions): http.Server {
  const idle = opts.idleTimeoutMs ?? 10 * 60_000
  const retries = opts.retries ?? 1
  const server = http.createServer((req, res) => {
    // 请求级语言：浏览器会话经 x-modeldock-lang 头声明（控制台 fetch 统一携带），
    // 本请求生成的全部服务端文案（错误提示/客户端卡片描述/审计条目）随之；无头回落网关默认语言。
    // AsyncLocalStorage 随异步链传播，并发请求互不串扰。
    const reqLang = normalizeLang(req.headers['x-modeldock-lang'] as string | undefined) ?? getLang()
    void runWithLang(reqLang, async () => {
      try {
        await handleRequest(rt, req, res, { idle, retries })
      } catch (e) {
        // 顶层兜底：漏出的已知错误（UpstreamError / ConfigError / 带 hint 的业务错误）映射为
        // 正确状态码并保留 message + hint——控制台的失败提示依赖它们，不再一律 500「网关内部错误」
        if (res.headersSent) {
          res.destroy()
          return
        }
        const r = errorReply(e)
        if (r.status >= 500) console.error("[gateway] " + req.method + " " + (req.url ?? "") + " " + t('网关内部错误:', 'Gateway internal error:'), e)
        sendError(res, r.status, r.message, r.hint)
      }
    })
  })
  server.requestTimeout = 0
  server.headersTimeout = 60_000
  server.keepAliveTimeout = 75_000
  server.timeout = idle
  server.on('connection', (s) => s.setNoDelay(true))
  // 实际端口自动回写 rt.port：登录 cookie 名内嵌端口号做同机双实例隔离（cookies.ts），
  // 端口必须以真实监听地址为准（EADDRINUSE 顺延、listen(0) 随机端口都覆盖），不能靠调用方手动赋值
  server.on('listening', () => {
    const addr = server.address()
    if (addr && typeof addr === 'object') rt.port = addr.port
  })

  // 健康清扫：周期性探活处于熔断冷却期的服务，连通即恢复（故障切换常开后熔断态任何模式下都可能命中，清扫不再看开关）
  const sweeper = setInterval(() => {
    const now = Date.now()
    for (const [id, h] of rt.health) {
      if (h.meltdown_until == null || h.meltdown_until > now) continue
      const p = rt.config.providers[id]
      if (!p || p.enabled === false) continue
      void probePing(rt, p)
        .then((r) => {
          if (r.ok) {
            const hh = rt.health.get(id)
            if (hh) {
              hh.meltdown_until = undefined
              hh.errWindow = { t0: Date.now(), count: 0 }
              hh.lastMs = r.ms
            }
          }
        })
        .catch(() => {})
    }
  }, 60_000)
  sweeper.unref?.()
  server.on('close', () => clearInterval(sweeper))

  // 定时 prefer 窗口接管主候选的展示路由跟随：窗口边界没有事件（请求级时间函数），周期对比
  // 「展示路由」（人工当前 > prefer 窗口 > active_profile，不含熔断等瞬态），变化才把烤模型
  // 客户端（/model 策划表、模型列表）按窗口目标重写一次——手动切换 / 钉定仍走各自的即时同步。
  // 基线初始为 undefined：首检按变化处理一次（refresh 有内容一致守卫，已同步则零写盘），
  // 自愈「网关停摆期间窗口已变」「接入发生在窗口接管期间」两类陈旧；模型生效本身不受此影响
  // （转发按请求即时翻译）。接入/断开后由 handler 将基线置失效，下一检强制校准。
  const pickerSync = pickerSyncStates.get(rt) ?? pickerSyncStates.set(rt, { route: undefined }).get(rt)!
  const pickerSyncTimer = setInterval(() => {
    void syncBakedClientsForDisplayRoute(rt, pickerSync, { port: rt.port })
      .then((r) => {
        if (r.changed) {
          // detail 双语经 bi() 成对构造（两个语言参数同写，未来改文案不漏语言），按审计条目的 zh/en 字段落
          const detail: Bilingual | undefined = r.refreshed.length
            ? bi(`已同步重写 ${r.refreshed.join('、')} 的客户端配置（重开会话生效）`, `rewrote client configs for ${r.refreshed.join(', ')} (restart sessions to apply)`)
            : undefined
          logAudit(rt, {
            ts: localIsoTs(),
            kind: 'audit',
            op: '定时窗口接管路由',
            op_en: 'Schedule window takeover',
            target: r.route ?? '-',
            detail: detail?.zh,
            detail_en: detail?.en,
            ok: true,
            source: 'token',
          })
        }
      })
      .catch(() => {})
  }, 5_000)
  pickerSyncTimer.unref?.()
  server.on('close', () => clearInterval(pickerSyncTimer))

  // 节假日日历每年自动获取（数据源 holiday-cn，国务院公告人工校对）：启动 90s 后首查、之后每 24h；
  // POST /schedule/holidays-cn 可即时触发（CLI/运维用）。失败静默，不影响网关服务
  const holidayTimers: NodeJS.Timeout[] = []
  if (opts.autoHolidayRefresh !== false) {
    const auto = () => void refreshCalendar(rt, { manual: false }).catch(() => {})
    const first = setTimeout(auto, 90_000)
    const loop = setInterval(auto, 24 * 3600_000)
    first.unref?.()
    loop.unref?.()
    holidayTimers.push(first, loop)
  }
  server.on('close', () => holidayTimers.forEach((t) => { clearTimeout(t); clearInterval(t) }))

  // 模型元数据目录（models.dev）自动刷新：启动 90s 后首查、之后每 24h 检查（缓存 7 天内新鲜则跳过）。
  // 失败静默保留旧缓存，不影响网关服务；MODELRDOCK_DISABLE_CATALOG_FETCH=1 停用
  const catalogTimers: NodeJS.Timeout[] = []
  if (opts.autoCatalogRefresh !== false) {
    const autoCatalog = () => void refreshCatalog({ manual: false }).catch(() => {})
    const catFirst = setTimeout(autoCatalog, 90_000)
    const catLoop = setInterval(autoCatalog, 24 * 3600_000)
    catFirst.unref?.()
    catLoop.unref?.()
    catalogTimers.push(catFirst, catLoop)
  }
  server.on('close', () => catalogTimers.forEach((t2) => { clearTimeout(t2); clearInterval(t2) }))

  return server
}

function sendError(res: http.ServerResponse, status: number, message: string, hint?: string): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(hint ? { error: { message }, modeldock: { hint } } : { error: { message } }))
}

/** 顶层兜底的错误→响应映射。此前 jsonRequestBody 的 400（非法 JSON）、readBody 的 413（超限）、
 *  写配置锁超时的 ConfigError、节假日拉取附带的 hint，一旦漏出端点局部 try/catch 都会被
 *  顶层吞成 500「网关内部错误」；这里统一还原为正确状态码与可操作提示。 */
function errorReply(e: unknown): { status: number; message: string; hint?: string } {
  if (e instanceof UpstreamError) return { status: e.status, message: e.message, hint: e.hint }
  if (e instanceof ConfigError) return { status: 400, message: e.message }
  const err = e as Error & { status?: unknown; hint?: unknown }
  const msg = err && typeof err.message === 'string' ? err.message : String(e)
  const hint = err && typeof err.hint === 'string' ? err.hint : undefined
  // 显式带数值 status 的业务错误（如 413 上限）按原状态透出
  if (typeof err?.status === 'number' && err.status >= 400 && err.status <= 599) {
    return { status: err.status, message: msg, hint }
  }
  // 带 hint 但无状态码（如节假日拉取失败）：按上游失败处理
  if (hint) return { status: 502, message: msg, hint }
  return { status: 500, message: t('网关内部错误：{msg}', 'Gateway internal error: {msg}', { msg }) }
}

function extractToken(req: http.IncomingMessage): string | null {
  const auth = req.headers.authorization
  if (typeof auth === 'string' && auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim()
  const xk = req.headers['x-api-key']
  if (typeof xk === 'string') return xk.trim()
  return null
}

async function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(new UpstreamError(413, t('请求体超过 {max} 字节上限', 'Request body exceeds the {max}-byte limit', { max: MAX_BODY })))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

async function handleRequest(
  rt: GatewayRuntime,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  o: { idle: number; retries: number }
): Promise<void> {
  const started = Date.now()
  const url = req.url ?? '/'
  const method = (req.method ?? 'GET').toUpperCase()

  const log = (entry: Omit<LogEntry, 'ts'>) => {
    logRequest(rt, { ...entry, ts: localIsoTs() })
  }

  // 管理面
  if (url.startsWith('/_modeldock/')) {
    return handleAdmin(rt, req, res, o, started)
  }

  // 网站图标：直接回 204、不走鉴权，避免浏览器 favicon 请求打出一条 401 噪音
  if (url === '/favicon.ico') {
    res.writeHead(204)
    res.end()
    return
  }

  // 根路径引导：无认证头的 GET / 不可能是有效代理调用，302 到 Web 控制台；
  // 带 token 的请求、POST、其余路径不受影响，仍走下方认证 → 代理
  if (method === 'GET' && url.split('?')[0] === '/' && !extractToken(req) && req.headers['x-modeldock-admin'] === undefined) {
    res.writeHead(302, { location: '/_modeldock/ui' })
    res.end()
    return
  }

  const adminHeader = req.headers['x-modeldock-admin']
  const adminOk = typeof adminHeader === 'string' && safeEqual(adminHeader, rt.adminToken)
  const resolved = adminOk
    ? resolveByProfile(rt, req.headers['x-modeldock-profile'] as string | undefined)
    : (() => {
        const token = extractToken(req)
        if (!token) return { ok: false as const, status: 401, message: t('缺少认证 token（Authorization: Bearer 或 x-api-key）', 'Missing auth token (Authorization: Bearer or x-api-key)'), hint: t('各 harness 的 token 见 modeldock status', 'Tokens for each harness are listed by modeldock status') }
        return resolveTarget(rt, token)
      })()

  if (!resolved.ok) {
    log({ harness: '-', profile: '-', provider: '-', path: url, status: resolved.status, err: resolved.message, ms: Date.now() - started })
    return sendError(res, resolved.status, resolved.message, resolved.hint)
  }
  const { target } = resolved

  // 本地合成 GET /v1/models：返回当前选路目标服务的模型目录（用户拉取/筛选过的），不透传上游——
  // 上游目录 ≠ 用户目录，且上游未必实现该端点。Claude Code 开 CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1
  // 后据此填充 /model 选择器；选路复用 resolveTarget（钉定/定时/active_profile），列表与实际请求同源。
  // 带 anthropic-version 头 = Claude Code discovery：对非 Claude 系 ID 加 anthropic. 前缀别名
  // 以通过其 ID 过滤（DISCOVERY_ID_RE），转发侧按目录还原。
  if (method === 'GET' && url.split('?')[0] === '/v1/models') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(modelsListPayload(rt.config, target, req.headers['anthropic-version'] !== undefined)))
    return
  }

  const body = await readBody(req)
  const headers: Record<string, string> = {}
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === 'string') headers[k] = v
    else if (Array.isArray(v)) headers[k] = v[0]
  }

  let result: UpstreamResult & { usedProviderId?: string; reason?: string }
  try {
    // 故障切换常开：主候选不可达时按 pickTarget 候选链自动改发（备用链/「下一个切换」钉定），不与「程序自动选主」开关绑定；
    // pickTarget 内部再按 auto_failover 决定定时窗口是否参与选主。候选链只有主服务时行为与直连等价（循环一次）。
    result = await forwardWithFailover(rt, target, {
      method,
      path: url,
      headers,
      body,
      idleTimeoutMs: o.idle,
      retries: o.retries,
      fallbackIds: target.profile.fallback,
    })
  } catch (e) {
    if (e instanceof UpstreamError) {
      log({
        harness: target.harness,
        profile: target.profileName,
        provider: target.profile.provider,
        model: target.profile.default_model,
        path: url,
        status: e.status ?? 502,
        ms: Date.now() - started,
        err: e.message,
        reason: e.routeReason ?? undefined,
      })
      return sendError(res, e.status, e.message, e.hint)
    }
    throw e
  }
  // 自动路由后以最终生效的 provider 记日志
  const providerId = result.usedProviderId ?? target.profile.provider
  const reason = result.reason
  const model = result.modelAfter ?? target.profile.default_model

  const resHeaders = filterResponseHeaders(result.headers)
  if (result.status >= 400) {
    const text = await result.body.text()
    const wrapped = translateUpstreamError(result.status, text, {
      providerId,
      model,
    })
    res.writeHead(result.status, { ...resHeaders, 'content-type': 'application/json' })
    res.end(wrapped)
    log({ harness: target.harness, profile: target.profileName, provider: providerId, model, path: url, status: result.status, ms: Date.now() - started, err: wrapped.slice(0, 200), reason })
    return
  }

  res.writeHead(result.status, resHeaders)
  res.flushHeaders()
  // usage 旁路解析：tap 字节原样透传（转发行为零改变），SSE/JSON 尽力而为提取 token 用量
  const usageTap = createUsageTap(result.headers['content-type'])
  try {
    await pipeline(result.body as any, usageTap, res)
    log({ harness: target.harness, profile: target.profileName, provider: providerId, model, path: url, status: result.status, ms: Date.now() - started, reason, usage: usageTap.getUsage() })
  } catch (e) {
    log({ harness: target.harness, profile: target.profileName, provider: providerId, model, path: url, status: result.status, ms: Date.now() - started, err: t('流中断：{msg}', 'Stream interrupted: {msg}', { msg: (e as Error).message }), reason, usage: usageTap.getUsage() })
  }
}

// 管理面

/** 管理面所有端点（含 GET）的 Host 白名单：DNS rebinding 的 Host 不是本机，读取类端点同样拒绝。
 *  参照 Vite allowedHosts（CVE-2025-31125 同类问题的标准修法）。 */
function hostAllowed(req: http.IncomingMessage): boolean {
  const host = String(req.headers.host ?? '')
  return /^(127\.0\.0\.1|\[::1\]|localhost)(:\d+)?$/i.test(host)
}

function adminAuthorized(rt: GatewayRuntime, req: http.IncomingMessage): boolean {
  const h = req.headers['x-modeldock-admin']
  if (typeof h === 'string' && safeEqual(h, rt.adminToken)) return true
  // Web 控制台的 cookie 登录（HttpOnly + SameSite=Lax，跨站 POST 不携带）
  const cookie = req.headers.cookie
  if (typeof cookie === 'string') {
    const m = new RegExp(`(?:^|;\\s*)${adminCookieName(rt.port ?? DEFAULT_GATEWAY_PORT)}=([^;]+)`).exec(cookie)
    if (m && safeEqual(decodeURIComponent(m[1]), rt.adminToken)) return true
  }
  return false
}

/** 登记「设备记忆」值到 gateway.json 的 devices（FIFO 上限 20）。失败不影响登录本身。 */
async function registerWebDevice(rt: GatewayRuntime, device: string): Promise<void> {
  try {
    const state = await readGatewayState()
    const devices = [device, ...(state?.devices ?? []).filter((d) => d !== device)].slice(0, 20)
    if (state) await writeGatewayState({ ...state, devices })
    // 无状态文件（测试/嵌入式启动）：用运行时信息补一个最小状态，设备记忆才有落点
    else
      await writeGatewayState({
        pid: process.pid,
        port: rt.port ?? 0,
        admin_token: rt.adminToken,
        started_at: localIsoTs(new Date(rt.startedAt)),
        devices,
      })
  } catch {
    /* 登记失败不影响登录 */
  }
}

/**
 * 管理面统一鉴权：admin token（CLI 兼容）或控制台 cookie（?token= 登种，HttpOnly + SameSite=Lax）。
 * 跨站 drive-by 靠 SameSite=Lax 挡住；DNS rebinding 靠 hostAllowed 挡住；本机程序一律需要 token。
 */
async function jsonRequestBody(req: http.IncomingMessage): Promise<any> {
  const raw = await readBody(req)
  if (raw.length === 0) return {}
  try {
    return JSON.parse(raw.toString('utf8'))
  } catch {
    throw new UpstreamError(400, t('请求体必须是 JSON', 'Request body must be JSON'))
  }
}

/** 网关侧配置变更：读盘改盘（与 CLI 共用带锁的 mutateConfig），再热加载内存态 */
async function persistConfig(rt: GatewayRuntime, fn: (cfg: Config) => void): Promise<void> {
  await mutateConfig(fn)
  await reloadRuntime(rt)
}

async function buildConfigView(rt: GatewayRuntime): Promise<Record<string, unknown>> {
  const cfg = rt.config
  const port = rt.port ?? cfg.gateway?.port ?? DEFAULT_GATEWAY_PORT
  // 各适配器 status 相互独立、只读，并发执行；Promise.all 保序，row 顺序与 allAdapters 一致
  const adapters = allAdapters(cfg)
  const statuses = await Promise.all(adapters.map((a) => a.status(cfg, port)))
  const harnessRows = adapters.map((a, i) => {
    const st = statuses[i]
    return {
      id: a.id,
      label: a.label,
      attached: !!cfg.harness[a.id],
      mode: cfg.harness[a.id]?.mode ?? null,
      route: cfg.harness[a.id]?.route ?? null,
      pointing: st.pointing ?? 'unknown',
      detail: st.detail ?? '',
    }
  })
  return {
    active_profile: cfg.active_profile ?? null,
    gateway: { port },
    providers: Object.entries(cfg.providers).map(([id, p]) => ({
      id,
      name: p.name ?? id,
      base_url: p.base_url,
      protocol: p.protocol,
      auth_style: p.auth_style,
      key_ref: p.key_ref,
      proxy: p.proxy ?? 'direct',
      models: Object.entries(p.models ?? {}).map(([mid, meta]) => projectModel(mid, meta, { includeCapabilities: true, includeSource: true })),
    })),
    profiles: Object.entries(cfg.profiles).map(([name, p]) => ({
      name,
      provider: p.provider,
      default_model: p.default_model ?? null,
      aliases: p.aliases ?? {},
    })),
    harness: harnessRows,
    uptime_ms: Date.now() - rt.startedAt,
    reloads: rt.reloads,
  }
}

/** overview 短 TTL 缓存（UI 每 5s 轮询，避免每次全量 adapter IO；绑定 runtime 实例 + 配置重载代数，任一变化即失效）。
 *  data 存序列化后的字符串：TTL 内命中直接 end 缓存串，不再对几十-几百 KB 的 view 逐次重复 stringify。
 *  TTL 必须**大于** UI 轮询间隔（5000ms）才会在两次轮询之间有命中——曾为 2000ms，下次 5s 轮询前必过期，
 *  稳态每次轮询全量重跑 buildOverview（每 provider 一次 keychain getSecret + 适配器 status 探测），缓存形同虚设。 */
export const OVERVIEW_TTL_MS = 6_000
let overviewCache: { at: number; rt: GatewayRuntime; reloads: number; lang: string; data: string } | null = null

/** overview 缓存命中判定（`now` 可注入便于单测给定 TTL 窗口）：
 *  命中须同 runtime 实例 + 同配置重载代数 + 同语言（overview 文案随请求语言生成，语言不同不能互借）+ 未过 TTL。 */
export function overviewCacheHit(
  cached: NonNullable<typeof overviewCache>,
  rt: GatewayRuntime,
  reloads: number,
  lang: string,
  now: number
): boolean {
  return cached.rt === rt && cached.reloads === reloads && cached.lang === lang && now - cached.at < OVERVIEW_TTL_MS
}

/** 控制台 v2 总览：全部用用户语言（服务/客户端），不含 provider/profile 等内部概念 */
async function buildOverview(rt: GatewayRuntime): Promise<Record<string, unknown>> {
  const cfg = rt.config
  const currentProfile = cfg.active_profile ? cfg.profiles[cfg.active_profile] : undefined
  const currentProviderId = currentProfile?.provider
  // harness → 当前路由到的 provider（钉死的 route 优先，否则跟随 active_profile）
  const hidSvc: Record<string, string> = {}
  const hidFollows: Record<string, boolean> = {}
  for (const [hid, he] of Object.entries(cfg.harness ?? {})) {
    const pinned = !!(he.route && he.route !== 'default')
    const routeName = pinned ? he.route : cfg.active_profile
    const prof = routeName ? cfg.profiles[routeName] : undefined
    if (prof) hidSvc[hid] = prof.provider
    hidFollows[hid] = !pinned
  }
  const services = []
  for (const [id, p] of Object.entries(cfg.providers)) {
    // 引用该 provider 的 profile：active_profile 优先（与 /service/update 写 default_model/候选链的选择逻辑一致）
    const profileRef = profileRefForProvider(cfg, id)
    const profileEntry = profileRef ? cfg.profiles[profileRef] : undefined
    const models = Object.keys(p.models ?? {})
    const hasKey = !!(await getSecret(p.key_ref))
    const h = rt.health.get(id)
    const melted = isMeltdown(rt, id)
    services.push({
      id,
      label: p.name ?? id,
      base_url: p.base_url,
      protocol: p.protocol,
      endpoints: p.endpoints ?? undefined,
      hasKey,
      modelsCount: models.length,
      defaultModel: profileEntry?.default_model ?? models[0] ?? null,
      fallback: (profileEntry?.fallback ?? [])
        .map((e) => parseFallbackEntry(e))
        .filter((x): x is { providerId: string; model?: string } => x !== null)
        .map((x) => ({ provider: x.providerId, model: x.model ?? null })),
      isCurrent: id === currentProviderId,
      enabled: p.enabled !== false,
      priority: p.priority ?? 0,
      down: melted,
      meltdown_until: melted ? (h?.meltdown_until ?? null) : null,
      lastMs: h?.lastMs ?? null,
      models: Object.entries(p.models ?? {}).map(([mid, meta]) => projectModel(mid, meta, { includeCapabilities: true })),
    })
  }
  const current = services.find((s) => s.isCurrent) ?? null
  const port = rt.port ?? cfg.gateway?.port ?? DEFAULT_GATEWAY_PORT
  const usedByMap: Record<string, string[]> = {}
  // 各适配器 status 相互独立、只读，并发执行；Promise.all 保序，按 adapter 取回，顺序不受并发影响
  const adapters = allAdapters(cfg)
  const statuses = new Map(await Promise.all(adapters.map(async (a) => [a, await a.status(cfg, port)] as const)))
  const clients = []
  for (const a of adapters) {
    const st = statuses.get(a)!
    const he = cfg.harness[a.id]
    const providerId = he && hidSvc[a.id] ? hidSvc[a.id] : undefined
    // 钉定信息：route 存钉住的 profile 名（null = 跟随全局），pinnedProvider 是该 profile 指向的服务 id（UI 下拉回显用）
    const pinnedRoute = he?.route && he.route !== 'default' ? he.route : null
    clients.push({
      id: a.id,
      label: a.label,
      installed: st.installed,
      attached: st.attached,
      pointing: st.pointing ?? 'unknown',
      detail: st.detail ?? '',
      service: providerId ? (cfg.providers[providerId]?.name ?? providerId) : null,
      followsActive: !!(he && hidFollows[a.id]),
      mode: he?.mode ?? null,
      directSupported: a.directMode === true,
      route: pinnedRoute,
      pinnedProvider: pinnedRoute ? (cfg.profiles[pinnedRoute]?.provider ?? null) : null,
      // 客户端自身 profile（dsh 的 desktop/web 等）：未接入时 UI 据此渲染接入范围选择；attached 后回显已选范围
      clientProfiles: a.clientProfileOptions ? await a.clientProfileOptions() : null,
      clientScope: he?.client_profiles ?? null,
      // 沙箱安装能力（枚举语义见 sandboxInstallCapability）：'unsupported' 时 UI 降级为只展示安装指引
      install: a.install ? {
        auto: !!a.install.command,
        command: resolveInstallCommand(a.install.command),
        guide: a.install.guide,
        homepage: a.install.homepage ?? null,
        sandboxInstall: sandboxInstallCapability(a),
        // 自动卸载能力：null=未声明（UI 不出卸载按钮）；sandbox=卸载是否只落沙箱（FAKE_HOME 下
        // npm 全局卸载经 prefix 重定向，只卸装进沙箱的副本）
        uninstall: resolveInstallCommand(a.install.uninstall)
          ? { command: resolveInstallCommand(a.install.uninstall)!, sandbox: sandboxNpmPrefix() !== null }
          : null,
      } : null,
    })
    if (he && providerId) (usedByMap[providerId] ||= []).push(a.label)
  }
  // 每个服务被哪些客户端使用
  services.forEach((s: any) => { s.usedBy = usedByMap[s.id] ?? [] })
  ensurePresetsLoaded() // 懒加载预设（BUG-12）：presets.json 格式错误在此抛可操作报错，而不是把网关启动都卡死
  return {
    ok: true,
    gateway: {
      port,
      running: true,
      // dev 沙箱实例（run_dev 设置）：配置/日志/客户端写入全部隔离在沙箱 home，UI 据此显示徽标与写操作警示
      sandbox: process.env.MODELRDOCK_DEV_SANDBOX === '1',
      home: (await import('../util/paths.js')).modeldockDir(),
      autoRoute: {
        ...autoRouteInfo(rt),
        failoverOn429: (rt.config.gateway?.failover_status_codes ?? []).includes(429),
        autoFallback: rt.config.gateway?.auto_fallback !== false,
      },
      autostart: autostartOverview(),
    },
    current: current ? { id: current.id, label: current.label, model: current.defaultModel } : null,
    services,
    clients,
    // 预设附带模型目录（添加页首屏直显预设模型；只带用户可见的三个字段，source 等内部字段不出域）
    presets: PRESETS.map((p) => {
      const pm = presetModels(p)
      return {
        id: p.id, label: p.label, vendor: p.vendor, base_url: p.base_url, protocol: p.protocol,
        endpoints: p.endpoints ?? undefined, docs_url: p.docs_url ?? null,
        models: pm ? Object.fromEntries(Object.entries(pm).map(([mid, m]) => [mid, { display_name: m.display_name, context_window: m.context_window, max_output: m.max_output, capabilities: m.capabilities ?? [] }])) : undefined,
      }
    }),
    knownModels: knownMetaTable(),
    // 多机同步状态行（M2）：只读展示，控制台不做同步配置（去电脑端命令行）
    sync: await syncStatus(),
    // 附近电脑的待确认拉取请求（sync-nearby，单槽 120s）：确认卡据此显示
    syncRequest: peekSyncRequest(),
  }
}

/** 服务 → profile 解析（UI 按「服务」操作、底层路由单元是 profile）：
 *  优先 active_profile（若指向该服务），其次已引用该服务的第一个 profile；一个都没有则建隐藏 profile（__pin_<id>）。
 *  可能写 cfg（新建隐藏 profile），必须在 persistConfig 的回调里调用。 */
function profileForProvider(c: Config, providerId: string): string {
  if (c.active_profile && c.profiles[c.active_profile]?.provider === providerId) return c.active_profile
  const existing = Object.keys(c.profiles).find((n) => c.profiles[n].provider === providerId)
  if (existing) return existing
  const name = `__pin_${providerId}`
  c.profiles[name] = { name, provider: providerId, default_model: Object.keys(c.providers[providerId]?.models ?? {})[0] }
  return name
}

/** 引用该 provider 的 profile 名（active_profile 优先），无则 undefined。buildOverview 的「默认模型/备用链
 *  读哪个 profile」与 service/update 的「写哪个 profile」是同一选择逻辑，抽共享避免口径漂移。只读，不建隐藏 profile。 */
function profileRefForProvider(c: Config, providerId: string): string | undefined {
  const refs = Object.keys(c.profiles).filter((n) => c.profiles[n].provider === providerId)
  return refs.length
    ? (c.active_profile && c.profiles[c.active_profile]?.provider === providerId ? c.active_profile : refs[0])
    : undefined
}

// 同网直拉迁移（sync-lan-pull，B 机 import 侧）

const SYNC_TICKET_TTL_MS = 5 * 60 * 1000

/** 票据：preview 阶段解密后的 doc 存内存（网关本就持有 secrets 明文缓存，无新增暴露等级），单次 + 5min TTL */
const syncTickets = new Map<string, { doc: Syncdoc; createdAt: number }>()

function putSyncTicket(doc: Syncdoc): string {
  for (const [k, v] of syncTickets) {
    if (Date.now() - v.createdAt > SYNC_TICKET_TTL_MS) syncTickets.delete(k)
  }
  const ticket = randomToken('mdkticket')
  syncTickets.set(ticket, { doc, createdAt: Date.now() })
  return ticket
}

function takeSyncTicket(ticket: string): Syncdoc {
  const hit = ticket ? syncTickets.get(ticket) : undefined
  if (!hit || Date.now() - hit.createdAt > SYNC_TICKET_TTL_MS) {
    if (ticket) syncTickets.delete(ticket)
    throw new Error(t('票据无效或已过期，请重新预览', 'Ticket invalid or expired; preview again'))
  }
  syncTickets.delete(ticket) // 单次：确认导入后即焚
  return hit.doc
}

// 附近电脑确认式直拉（sync-nearby，B 机发起侧）

interface RemoteRequestState {
  status: 'waiting' | 'granted' | 'denied' | 'timeout' | 'failed'
  ticket?: string
  report?: ReturnType<typeof reportOfDoc>
  meta?: { createdBy: string; createdAt: string }
  error?: string
  createdAt: number
}

const REMOTE_REQUEST_TTL_MS = 5 * 60 * 1000
const remoteRequests = new Map<string, RemoteRequestState>()

function sweepRemoteRequests(): void {
  for (const [k, v] of remoteRequests) {
    if (Date.now() - v.createdAt > REMOTE_REQUEST_TTL_MS) remoteRequests.delete(k)
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** B 机后台链路：向选中的附近电脑敲门（多网卡候选 IP 依次尝试）→ 轮询授权（A 用户在确认卡
 *  点允许/拒绝）→ 拿到一次性直拉链接 → 拉信封（pull 端点焚毁）→ 验签 → 存票据。
 *  全程包体恒密文；失败/拒绝/超时都落状态供前端轮询展示。 */
async function runRemoteRequest(requestId: string, ips: string[], port: number): Promise<void> {
  const nonce = randomBytes(24).toString('hex')
  const from = os.hostname().slice(0, 128)
  const set = (patch: Omit<RemoteRequestState, 'createdAt'>): void => {
    remoteRequests.set(requestId, { ...remoteRequests.get(requestId)!, ...patch })
  }
  try {
    // 敲门：候选 IP 逐个尝试（同机 127.0.0.1 / 局域网多网卡），任一成功即可
    let knocked = false
    let knockedIp = ''
    let lastErr = ''
    for (const ip of ips) {
      try {
        const knock = await fetch(`http://${ip}:${port}/m/sync/request`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ nonce, from }),
          signal: AbortSignal.timeout(5000),
        })
        if (!knock.ok) {
          lastErr = t('对方未接受请求（HTTP {status}）', 'The other computer rejected the request (HTTP {status})', { status: knock.status })
          continue
        }
        knocked = true
        knockedIp = ip
        break
      } catch (e) {
        lastErr = (e as Error).message
      }
    }
    if (!knocked) throw new Error(lastErr || t('对方不可达', 'The other computer is unreachable'))
    let grant: { url: string; passphrase: string } | { denied: true } | null = null
    for (let i = 0; i < 60 && !grant; i++) {
      await sleep(1000)
      const g = await fetch(`http://${knockedIp}:${port}/m/sync/grant?n=${nonce}`, { signal: AbortSignal.timeout(3000) })
      if (g.status === 403) grant = { denied: true }
      else if (g.ok) {
        const j = (await g.json()) as { url?: string; passphrase?: string }
        if (j.url && j.passphrase) grant = { url: j.url, passphrase: j.passphrase }
      }
    }
    if (!grant) {
      set({ status: 'timeout' })
      return
    }
    if ('denied' in grant) {
      set({ status: 'denied' })
      return
    }
    const envText = await fetchEnvelopeFromUrl(grant.url)
    const env: unknown = JSON.parse(envText)
    const doc = validateSyncdoc(openEnvelope(env, grant.passphrase))
    const metaEnv = env as Record<string, unknown>
    set({ status: 'granted', ticket: putSyncTicket(doc), report: reportOfDoc(doc), meta: { createdBy: String(metaEnv.created_by ?? ''), createdAt: String(metaEnv.created_at ?? '') } })
  } catch (e) {
    set({ status: 'failed', error: (e as Error).message })
  }
}

/** 从来源电脑拉取信封（用户自粘的链接）：仅 http/https、禁止重定向、10s 超时、响应体 ≤10MB。
 *  调用者=本机管理员（admin 鉴权 + Host 白名单），无凭据外泄面；上限防异常大包拖垮网关。 */
async function handleAdmin(
  rt: GatewayRuntime,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  o: { idle: number; retries: number },
  started: number
): Promise<void> {
  const url = (req.url ?? '').split('?')[0]

  if (!hostAllowed(req)) {
    return sendError(res, 403, t('管理接口仅限本机访问（Host 必须是 127.0.0.1/localhost）', 'Admin API is local-only (Host must be 127.0.0.1/localhost)'))
  }
  // 管理面响应一律禁止缓存（overview 等含敏感元数据）
  res.setHeader('cache-control', 'no-store')

  // 操作审计：修改类操作的成功/失败都记一条（环形缓冲 + audit-日期.jsonl，不含密钥明文）
  // 能走到端点的请求都过了 adminAuthorized：带 token 头的记为 token（CLI），否则是 cookie 登录的浏览器
  // op/target/detail 双语存储（bi 渲染与当前请求语言无关）：控制台日志表按界面语言取字段，历史条目缺英文时回退主字段
  const src = typeof req.headers['x-modeldock-admin'] === 'string' ? 'token' as const : 'web' as const
  const audit = (op: Bilingual, target: string | Bilingual, detail?: Bilingual, err?: Bilingual | string) => {
    const errZh = err === undefined || typeof err === 'string' ? err : err.zh
    const errEn = err === undefined || typeof err === 'string' ? undefined : err.en
    logAudit(rt, {
      ts: localIsoTs(),
      kind: 'audit',
      op: op.zh,
      op_en: op.en,
      target: typeof target === 'string' ? target : target.zh,
      target_en: typeof target === 'string' ? undefined : target.en,
      detail: detail?.zh,
      detail_en: detail?.en,
      ok: !errZh,
      err: errZh,
      err_en: errEn,
      source: src,
    })
  }

  if (url === '/_modeldock/health' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({
        ok: true,
        started_at: localIsoTs(new Date(rt.startedAt)),
        uptime_ms: Date.now() - rt.startedAt,
        reloads: rt.reloads,
        active_profile: rt.config.active_profile ?? null,
      })
    )
    return
  }

  // Web 控制台页面：?token= 校验通过则种 HttpOnly cookie 后重定向到干净 URL。
  // 同时种 1 年期「设备记忆」cookie（值登记进 gateway.json 的 devices）：
  // 之后令牌轮换/7 天过期，锁屏「重新登录」按钮凭它一键恢复，无需终端。
  // cookie 名内嵌端口：RFC 6265 cookie 不按端口隔离，同机双实例（生产+dev）固定名会互顶登录态
  if (url === '/_modeldock/ui' && req.method === 'GET') {
    const q = new URL(req.url ?? '', 'http://x').searchParams
    const token = q.get('token')
    if (token && safeEqual(token, rt.adminToken)) {
      const device = randomToken('mdkdev')
      await registerWebDevice(rt, device)
      const port = rt.port ?? DEFAULT_GATEWAY_PORT
      res.writeHead(302, {
        'set-cookie': [
          `${adminCookieName(port)}=${encodeURIComponent(rt.adminToken)}; Path=/_modeldock; HttpOnly; SameSite=Lax; Max-Age=604800`,
          `${deviceCookieName(port)}=${encodeURIComponent(device)}; Path=/_modeldock; HttpOnly; SameSite=Lax; Max-Age=31536000`,
        ],
        location: '/_modeldock/ui',
      })
      res.end()
      return
    }
    const { html, etag } = getRenderedUI()
    // 带匹配 ETag 的重复请求直接 304（空 body，保留既有头）：省掉每请求原样重发 236KB 页体。
    // no-store 由管理面统一策略设置，此处叠 ETag 只做条件请求，不放开 JSON 的缓存策略。
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { 'content-type': 'text/html; charset=utf-8', etag })
      res.end()
      return
    }
    // 仅 HTML 页覆盖管理面统一 no-store：no-cache = 可存储但每次必须条件重验证，
    // 浏览器才会存下 236KB 页体并在下一次发 If-None-Match → ETag 304 生效。
    // 页面是静态壳 + 状态路径，无敏感数据；JSON API 的 no-store 策略不动。
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', etag, 'cache-control': 'no-cache' })
    res.end(html)
    return
  }

  // 锁屏「重新登录」：凭设备记忆 cookie 重发 7 天期 admin cookie。
  // 位于 admin 门之前——这正是它的用途（用户已被登出）；没有设备凭据的新浏览器/本机
  // 程序一律 403，走粘贴令牌流程，2026-09 审查闭合的「免凭据放行」口子不会重开。
  if (url === '/_modeldock/auth/relogin' && req.method === 'POST') {
    const port = rt.port ?? DEFAULT_GATEWAY_PORT
    const cookie = req.headers.cookie
    const m = cookie ? new RegExp(`(?:^|;\\s*)${deviceCookieName(port)}=([^;]+)`).exec(cookie) : null
    const device = m ? decodeURIComponent(m[1]) : ''
    const state = await readGatewayState()
    const known = typeof device === 'string' && device.startsWith('mdkdev_') && (state?.devices ?? []).some((d) => safeEqual(d, device))
    if (!known) {
      res.writeHead(403, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: t('本浏览器没有有效的设备记忆，请粘贴网关令牌登录', 'This browser has no valid device memory; paste the gateway token to sign in') }))
      return
    }
    res.writeHead(200, {
      'content-type': 'application/json',
      'set-cookie': `${adminCookieName(port)}=${encodeURIComponent(rt.adminToken)}; Path=/_modeldock; HttpOnly; SameSite=Lax; Max-Age=604800`,
    })
    res.end(JSON.stringify({ ok: true }))
    return
  }

  // 管理面鉴权（/health 探活与 /ui 页面已在前面分支豁免）：读写一律要求 admin 凭据
  // （x-modeldock-admin 头，或 ?token= 登录种的 admin cookie，7 天有效）。
  // 旧版「同源即放行」已移除——本机程序伪造 Origin/Sec-Fetch-Site 即可读写配置，令牌形同虚设
  if (!adminAuthorized(rt, req)) {
    return sendError(res, 401, t('需要登录', 'Sign-in required'), t('控制台请用 modeldock ui 打开（自动携带令牌）；脚本请求请带 x-modeldock-admin 头', 'Open the console with modeldock ui (token carried automatically); scripts must send the x-modeldock-admin header'))
  }

  // 轮换管理令牌（需当前已鉴权，故位于 admin 门之后）：旧 token/cookie 立即失效。
  if (url === '/_modeldock/admin/rotate' && req.method === 'POST') {
    try {
      rt.adminToken = randomToken('mdkadm')
      // 只更新状态文件里的 token；无状态文件（测试/嵌入式启动）则只换内存态
      const state = await readGatewayState()
      if (state) await writeGatewayState({ ...state, admin_token: rt.adminToken })
      const host = req.headers.host ?? `127.0.0.1:${rt.port ?? ''}`
      const consoleUrl = `http://${host}/_modeldock/ui?token=${rt.adminToken}`
      audit(bi('轮换管理令牌', 'Rotate admin token'), '-', bi('旧令牌已失效', 'Old token revoked'))
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, admin_token: rt.adminToken, console_url: consoleUrl }))
    } catch (e) {
      sendError(res, 400, (e as Error).message)
    }
    return
  }

  if (url === '/_modeldock/status' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({
        ok: true,
        active_profile: rt.config.active_profile ?? null,
        providers: Object.keys(rt.config.providers),
        profiles: Object.keys(rt.config.profiles),
        harness: Object.keys(rt.config.harness),
        reloads: rt.reloads,
        uptime_ms: Date.now() - rt.startedAt,
      })
    )
    return
  }

  // 一键更新（M2）：admin 门内；apply 只负责分离 spawn，安装由子进程完成
  if (url === '/_modeldock/admin/update/status' && req.method === 'GET') {
    // 惰性周期重查：控制台每 60s 轮询一次状态，顺带触发一次检查——
    // kick 内部有 成功 24h TTL / 失败 30min 退避 双守卫，命中即静默跳过，
    // 常驻网关因此不必重启也能在控制台开着时发现新版本（此前只在启动时查一次）
    void kickUpdateCheck(rt).catch(() => {})
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(await getUpdateStatus(rt)))
    return
  }

  if (url === '/_modeldock/admin/update/check' && req.method === 'POST') {
    // 立即返回，页面轮询 status 取结果（GitHub 检查可能十几秒，不占请求）
    void kickUpdateCheck(rt, { force: true }).catch(() => {})
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
    return
  }

  if (url === '/_modeldock/admin/update/apply' && req.method === 'POST') {
    const r = applyUpdate(rt, { argv: updateDaemonArgs() })
    if (r.started) {
      audit(bi('一键更新', 'One-click update'), '-', bi('开始更新到 v{v}，网关将短暂中断', 'Updating to v{v}; the gateway restarts briefly', { v: r.latest ?? '?' }))
    } else {
      const reasonZh = r.reason === 'in_progress' ? '更新已在进行中' : '没有可安装的新版本'
      const reasonEn = r.reason === 'in_progress' ? 'an update is already in progress' : 'no new version to install'
      audit(bi('一键更新', 'One-click update'), '-', bi('未执行：{r}', 'Not started: {r}', { r: bi(reasonZh, reasonEn) }))
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: r.started, ...r }))
    return
  }

  if (url === '/_modeldock/logs' && req.method === 'GET') {
    const q = new URL(req.url ?? '', 'http://x').searchParams
    const n = Math.min(500, Math.max(1, Number(q.get('n') ?? 50) || 50))
    const total = rt.ring.length
    // page 从 1 数起，第 1 页是最新 n 条（ring 按 时间正序 追加）；越界页返回空数组
    const page = Math.max(1, Number(q.get('page') ?? 1) || 1)
    const pages = Math.max(1, Math.ceil(total / n))
    const end = Math.max(0, total - (page - 1) * n)
    const start = Math.max(0, end - n)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ logs: rt.ring.slice(start, end), total, page, pages }))
    return
  }

  if (url === '/_modeldock/config' && req.method === 'GET') {
    const view = await buildConfigView(rt)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(view))
    return
  }

  // 面向任务的服务端点（Web 控制台 v2，全部用户语言，无内部概念）

  if (url === '/_modeldock/model-catalog' && req.method === 'GET') {
    // 模型元数据兜底总表（内置表 ∪ models.dev 目录，8000+ 条）：量大，单端点懒加载一次，
    // 不进 overview（每 5s 轮询，塞进去每秒多出百 KB 流量）
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, models: fullKnownTable() }))
    return
  }

  if (url === '/_modeldock/overview' && req.method === 'GET') {
    const cached = overviewCache
    // 缓存键含请求语言：overview 里的客户端卡片描述等文案随请求语言生成，语言不同不能互借缓存
    if (cached && overviewCacheHit(cached, rt, rt.reloads, getLang(), Date.now())) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(cached.data) // 命中直接写缓存串，不再重复 stringify（view 几十-几百 KB）
      return
    }
    const view = await buildOverview(rt)
    const data = JSON.stringify(view)
    overviewCache = { at: Date.now(), rt, reloads: rt.reloads, lang: getLang(), data }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(data)
    return
  }

  if (url === '/_modeldock/service/fetch-models' && req.method === 'POST') {
    // 添加服务时预览拉取：按临时地址+Key 拉取模型，不落盘。
    // 编辑弹窗场景传 id 而不传 key（Key 输入框留空=不修改）：用该服务已保存的 Key 拉取
    const b = await jsonRequestBody(req)
    const baseUrl = typeof b.base_url === 'string' ? b.base_url.trim() : ''
    let key = typeof b.key === 'string' ? b.key.trim() : ''
    const refId = typeof b.id === 'string' ? b.id.trim() : ''
    if (!key && refId) {
      const ref = rt.config.providers[refId]
      if (!ref) return sendError(res, 400, t('服务「{id}」不存在', 'Service "{id}" not found', { id: refId }))
      key = (await getSecret(ref.key_ref)) ?? ''
      if (!key) return sendError(res, 400, t('已保存的 Key 不可读（未设置或系统安全后端拒绝访问），请手动粘贴 Key 后拉取', 'Saved key unreadable (not set or the OS keychain refused access); paste the key manually and fetch again'))
    }
    const proto = (b.protocol === 'openai' || b.protocol === 'responses') ? b.protocol : 'anthropic'
    if (!baseUrl || !/^https?:\/\//i.test(baseUrl)) return sendError(res, 400, t('请先填写协议接口地址（http/https）', 'Fill in the endpoint URL first (http/https)'))
    if (!key) return sendError(res, 400, t('key 不能为空：请先粘贴 Key 再拉取', 'Key is empty: paste the key before fetching'))
    const provider: import('../config/types.js').ProviderConfig = {
      base_url: baseUrl,
      protocol: proto,
      auth_style: 'bearer',
      key_ref: key,
      proxy: 'direct',
    }
    /** 拉取失败/无结果时按厂商 host 回退到 ModelDock 已知模型（预设自带上下文/输出）。声明放在首个调用点之前。 */
    function knownFallback() {
      const fb = knownModelsForBaseUrl(baseUrl)
      return Object.entries(fb).map(([id, m]) => ({ id, display: m.display_name ?? id, context_window: m.context_window ?? null, max_output: m.max_output ?? null, capabilities: m.capabilities ?? [] }))
    }
    try {
      const f = await fetchModelIds(provider)
      let arr: { id: string; display: string; context_window: number | null; max_output: number | null; capabilities: string[] }[] = f.ids.map((id: string) => {
        // 填充链：上游响应自带值 > 内置表 > models.dev 目录（按 base_url host 精确匹配优先）；能力只看内置表（上游不报此项）
        const km = resolveModelMeta(id, null, { upstream: f.meta?.[id], baseUrl })
        return { id, display: f.display[id] ?? id, context_window: km?.context_window ?? null, max_output: km?.max_output ?? null, capabilities: km?.capabilities ?? [] }
      })
      let from = 'fetched'
      if (arr.length === 0) { arr = knownFallback(); from = 'known' }
      if (arr.length === 0) return sendError(res, 400, t('未拉取到模型，且本地没有该厂商的已知模型', 'No models fetched and no known models for this vendor locally'), t('可在「编辑服务」里手动登记模型', 'You can register models manually in "Edit Service"'))
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, protocol: proto, from, models: arr }))
    } catch (e) {
      // 拉取失败 → 按厂商 host 回退到 ModelDock 已知模型（预设自带上下文/输出）
      const arr = knownFallback()
      if (!arr.length) return sendError(res, 400, t('拉取模型失败：{msg}', 'Failed to fetch models: {msg}', { msg: (e as Error).message }), t('检查接口地址 / Key / 网络（境外上游需代理）', 'Check the endpoint URL / key / network (overseas upstreams need a proxy)'))
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, protocol: proto, from: 'known', models: arr }))
    }
    return
  }

  if (url === '/_modeldock/service' && req.method === 'POST') {
    const b = await jsonRequestBody(req)
    try {
      const r = await addService(String(b.presetId ?? ''), String(b.key ?? ''), {
        setActiveIfEmpty: b.setActiveIfEmpty !== false,
        fetch: b.fetch !== false,
        name: typeof b.name === 'string' ? b.name : undefined,
        base_url: typeof b.base_url === 'string' ? b.base_url : undefined,
        protocol: (b.protocol === 'anthropic' || b.protocol === 'openai' || b.protocol === 'responses') ? b.protocol : undefined,
        endpoints: b.endpoints && typeof b.endpoints === 'object' && !Array.isArray(b.endpoints) ? b.endpoints : undefined,
        models: b.models && typeof b.models === 'object' && !Array.isArray(b.models) ? b.models : undefined,
        defaultModel: typeof b.default_model === 'string' && b.default_model.trim() ? b.default_model.trim() : undefined,
        fallback: Array.isArray(b.fallback) ? b.fallback.map((x: unknown) => String(x)) : undefined,
      })
      await reloadRuntime(rt)
      audit(
        bi('添加服务', 'Add service'),
        r.providerId,
        biCat(
          bi('预设 {preset}，路由 {route}，模型 {n} 个', 'Preset {preset}, route {route}, {n} models', { preset: String(b.presetId ?? '-'), route: r.profileName, n: r.fetched }),
          r.fetchError ? bi('（拉取失败已兜底：{msg}）', ' (fetch failed, fell back: {msg})', { msg: r.fetchError }) : ''
        )
      )
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, ...r }))
    } catch (e) {
      audit(bi('添加服务', 'Add service'), String(b.presetId ?? '-'), undefined, (e as Error).message)
      sendError(res, 400, (e as Error).message)
    }
    return
  }

  if (url === '/_modeldock/switch' && req.method === 'POST') {
    const b = await jsonRequestBody(req)
    try {
      const profileName = await switchToService(String(b.service ?? ''))
      // 「应用/当前」= 人工钉定主服务（人为修改优先于定时窗口与自动选路），默认路由同步跟随最后一次人工选择；
      // 钉定持续到「当前」选回「自动 · X」（清除 auto_route_provider），期间定时窗口让位
      await setAutoRoute(rt.config.gateway?.auto_failover === true, String(b.service ?? ''))
      await reloadRuntime(rt)
      // dsh/workbuddy/zcode 的模型列表烙在客户端配置文件里，切全局后需按新路由重写才跟随
      const baked = await refreshBakedModelClients({ port: rt.port })
      const detail = biCat(
        bi('当前路由 → {route}', 'Current route → {route}', { route: profileName }),
        baked.refreshed.length ? bi('；已同步重写 {list} 的客户端配置', '; rewrote client configs for {list}', { list: biJoin('、', ', ', baked.refreshed) }) : '',
        baked.warnings.length ? bi('；{list}', '; {list}', { list: biJoin('；', '; ', baked.warnings) }) : ''
      )
      audit(bi('切换服务', 'Switch service'), String(b.service ?? '-'), detail)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, service: b.service, profile: profileName, ...baked }))
    } catch (e) {
      audit(bi('切换服务', 'Switch service'), String(b.service ?? '-'), undefined, (e as Error).message)
      sendError(res, 400, (e as Error).message)
    }
    return
  }

  if (url === '/_modeldock/auto-route' && req.method === 'POST') {
    const b = await jsonRequestBody(req)
    try {
      // 部分更新语义：未传的字段保持现状（开关 / 主服务钉定 / 下一个切换钉定 / 限流切换 / 自动备用链在 UI 各自独立调用）
      const enabled = b.enabled === undefined
        ? rt.config.gateway?.auto_failover === true
        : b.enabled === true || b.enabled === 'true'
      const provider = 'provider' in b
        ? (typeof b.provider === 'string' && b.provider.trim() ? b.provider.trim() : null)
        : undefined
      const failoverOn429 = b.failoverOn429 === undefined ? undefined : b.failoverOn429 === true
      const autoFallback = b.autoFallback === undefined ? undefined : b.autoFallback === true
      const next = 'next' in b
        ? (typeof b.next === 'string' && b.next.trim() ? b.next.trim() : null)
        : undefined
      const r = await setAutoRoute(enabled, provider, failoverOn429, autoFallback)
      const n = next === undefined ? undefined : await setRouteNext(next)
      await reloadRuntime(rt)
      audit(
        bi('自动路由', 'Auto route'),
        enabled ? bi('开启', 'on') : bi('关闭', 'off'),
        biCat(
          `auto_failover=${r.enabled} primary=`,
          r.provider ?? bi('自动', 'auto'),
          n === undefined ? '' : biCat(' next=', n ?? bi('自动', 'auto')),
          failoverOn429 === undefined ? '' : bi(' 限流切换={v}', ' failover-on-429={v}', { v: failoverOn429 ? bi('开', 'on') : bi('关', 'off') }),
          autoFallback === undefined ? '' : bi(' 自动备用链={v}', ' auto-fallback={v}', { v: autoFallback ? bi('开', 'on') : bi('关', 'off') })
        )
      )
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, ...r, next: n ?? rt.config.gateway?.route_next ?? null }))
    } catch (e) {
      audit(bi('自动路由', 'Auto route'), '-', undefined, (e as Error).message)
      sendError(res, 400, (e as Error).message)
    }
    return
  }

  if (url === '/_modeldock/auto-route/schedule' && req.method === 'POST') {
    // 定时切换：整体替换 {enabled, windows}。窗口按配置顺序取首个命中；空 windows = 清除
    const b = await jsonRequestBody(req)
    const enabled = b.enabled !== false
    if (b.windows !== undefined && !Array.isArray(b.windows)) {
      return sendError(res, 400, t('windows 应为数组', 'windows must be an array'))
    }
    const windows: import('../config/types.js').ScheduleWindow[] = []
    for (const w of b.windows ?? []) {
      const start = String(w?.start ?? '').trim()
      const end = String(w?.end ?? '').trim()
      const target = String(w?.target ?? '').trim()
      const hhmm = /^([01]?\d|2[0-3]):[0-5]\d$/
      if (!hhmm.test(start) || !hhmm.test(end)) {
        return sendError(res, 400, t('时段「{from}-{to}」无效，时间应为 HH:mm', 'Window "{from}-{to}" is invalid; times must be HH:mm', { from: start || '?', to: end || '?' }))
      }
      if (start === end) return sendError(res, 400, t('时段「{from}-{to}」起止相同，不会生效', 'Window "{from}-{to}" has identical start and end; it would never apply', { from: start, to: end }))
      const parsed = parseFallbackEntry(target)
      if (!parsed) return sendError(res, 400, t('时段目标「{target}」无效，应为 服务ID 或 服务ID:模型ID', 'Window target "{target}" is invalid; expected ServiceID or ServiceID:ModelID', { target }))
      if (!rt.config.providers[parsed.providerId]) {
        return sendError(res, 400, t('时段目标服务「{id}」不存在', 'Window target service "{id}" not found', { id: parsed.providerId }), t('在「我的服务」查看服务 ID，或刷新页面同步最新列表', 'Check service IDs in "My Services", or refresh the page for the latest list'))
      }
      // 窗口模式：avoid（避开该服务）或缺省 prefer（优先走该服务/模型）；avoid 仅到服务粒度，模型部分剥掉按整个服务避开
      const mode = w.mode === undefined || w.mode === null || w.mode === '' ? undefined : String(w.mode).trim()
      if (mode !== undefined && mode !== 'prefer' && mode !== 'avoid') {
        return sendError(res, 400, t('时段模式「{mode}」无效，应为 prefer（优先走）或 avoid（避开）', 'Window mode "{mode}" is invalid; expected prefer or avoid', { mode }))
      }
      const avoid = mode === 'avoid'
      // 生效日类型：缺省/any=每天；workday=周一至五与调休补班日（不含法定节假日）；weekend；holiday
      const dayFilterRaw = w.dayFilter === undefined || w.dayFilter === null || w.dayFilter === '' ? undefined : String(w.dayFilter).trim()
      if (dayFilterRaw !== undefined && dayFilterRaw !== 'any' && dayFilterRaw !== 'workday' && dayFilterRaw !== 'weekend' && dayFilterRaw !== 'holiday') {
        return sendError(res, 400, t('生效日类型「{v}」无效，应为 any / workday / weekend / holiday', 'Day filter "{v}" is invalid; expected any / workday / weekend / holiday', { v: dayFilterRaw }))
      }
      const dayFilter = !dayFilterRaw || dayFilterRaw === 'any' ? undefined : (dayFilterRaw as 'workday' | 'weekend' | 'holiday')
      let days: number[] | undefined
      if (Array.isArray(w.days)) {
        const set = new Set<number>()
        for (const d of w.days as unknown[]) {
          const n = Number(d)
          if (Number.isInteger(n) && n >= 1 && n <= 7) set.add(n)
        }
        days = [...set]
        if (days.length === 0) days = undefined
      }
      windows.push({
        start,
        end,
        target: !avoid && parsed.model ? `${parsed.providerId}:${parsed.model}` : parsed.providerId,
        ...(avoid ? { mode: 'avoid' as const } : {}),
        ...(days ? { days } : {}),
        ...(dayFilter ? { dayFilter } : {}),
      })
    }
    await persistConfig(rt, (c) => {
      const g: import('../config/types.js').GatewayConfig = { ...(c.gateway ?? {}) }
      if (!windows.length) delete g.schedule
      else g.schedule = { enabled, windows }
      c.gateway = g
    })
    audit(bi('定时切换', 'Schedule'), enabled ? bi('启用', 'enabled') : bi('停用', 'disabled'), bi('{n} 个时段', '{n} windows', { n: windows.length }))
    // 用户开始使用定时切换后立即后台拉取一次法定节假日（数据源 holiday-cn，失败静默）
    void refreshCalendar(rt, { manual: false }).catch(() => {})
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, windows: windows.length }))
    return
  }

  if (url === '/_modeldock/schedule/holidays-cn' && req.method === 'POST') {
    // 手动触发节假日日历更新（控制台已删手动按钮，日历每日自动更新；端点留给 CLI/运维）：拉取今年/明年数据写缓存，日类型判定随之生效
    const r = await refreshCalendar(rt, { manual: true }).catch((e) => {
      throw Object.assign(new Error(e instanceof Error ? e.message : String(e)), { hint: t('请检查网络后重试；数据源为 holiday-cn（依据国务院办公厅公告校对）', 'Check the network and retry; data source is holiday-cn (verified against State Council announcements)') })
    })
    audit(
      bi('节假日日历', 'Holiday calendar'),
      bi('获取', 'Fetch'),
      r.years.length
        ? bi('更新 {years}，共 {n} 条', 'Updated {years}, {n} entries', { years: biJoin('、', ', ', r.years), n: r.updatedDays })
        : bi('数据源无变化', 'No changes from data sources')
    )
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, ...r }))
    return
  }

  if (url === '/_modeldock/lan' && req.method === 'GET') {
    // 手机简版控制台状态（二维码只对已过 admin 鉴权的本机控制台返回）
    // 顺带重算默认出口地址：换 Wi-Fi / 起停 VPN 后该用哪块网卡会变，面板一刷新即纠正二维码
    await refreshPreferredAddress()
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, ...buildLanStatus(rt) }))
    return
  }

  if (url === '/_modeldock/lan' && req.method === 'POST') {
    // 开关手机简版控制台：config.lan.enabled 落盘并即时启停第二监听器；
    // LAN 凭据复用 gateway.json 旧值（手机 cookie 跨重启不掉），没有才新生成
    const b = await jsonRequestBody(req)
    try {
      if (b.enabled === true) {
        const state = await readGatewayState()
        const lanToken = resolveLanToken(state?.lan_token ?? null)
        await startLanServer(rt, { port: rt.config.lan?.port ?? DEFAULT_LAN_PORT, token: lanToken })
        await mutateConfig((c) => {
          c.lan = { ...(c.lan ?? {}), enabled: true }
        })
        await reloadRuntime(rt)
        const refreshed = await readGatewayState()
        if (refreshed) await writeGatewayState({ ...refreshed, lan_token: lanToken, lan_port: rt.lan?.port })
        audit(bi('手机远程', 'Mobile console'), bi('开启', 'on'), bi('端口 {port}', 'port {port}', { port: rt.lan?.port ?? 0 }))
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, ...buildLanStatus(rt) }))
      } else {
        stopLan(rt)
        await mutateConfig((c) => {
          c.lan = { ...(c.lan ?? {}), enabled: false }
        })
        await reloadRuntime(rt)
        const refreshed = await readGatewayState()
        if (refreshed) await writeGatewayState({ ...refreshed, lan_port: undefined })
        audit(bi('手机远程', 'Mobile console'), bi('关闭', 'off'))
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, ...buildLanStatus(rt) }))
      }
    } catch (e) {
      audit(bi('手机远程', 'Mobile console'), '-', undefined, (e as Error).message)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: (e as Error).message }))
    }
    return
  }

  if (url === '/_modeldock/sync/offer' && req.method === 'POST') {
    // 同网直拉迁移（A 机）：生成一次性链接（口令藏 fragment，10 分钟有效、取走即焚）
    try {
      const r = await createSyncOffer(rt)
      audit(bi('分享配置到附近电脑', 'Share config nearby'), bi('已生成直拉链接', 'pull link created'))
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, ...r }))
    } catch (e) {
      audit(bi('分享配置到附近电脑', 'Share config nearby'), '-', undefined, (e as Error).message)
      sendError(res, 400, (e as Error).message)
    }
    return
  }

  if (url === '/_modeldock/sync/import' && req.method === 'POST') {
    // 同网直拉迁移（B 机）：apply 一键应用（url/file 直发，或附近直拉链路的 ticket）；preview（→ 票据）保留给 API 兼容。
    // 审计只记 phase 与来源形态，绝不记 URL（查询串含 token）与口令
    const b = await jsonRequestBody(req)
    const phase = b.phase === 'apply' ? 'apply' : 'preview'
    const source = (b.source ?? {}) as Record<string, unknown>
    const srcKind = typeof source.kind === 'string' ? source.kind : ''
    const resolveDoc = async (): Promise<{ doc: ReturnType<typeof validateSyncdoc>; env: unknown }> => {
      const passphrase = typeof source.passphrase === 'string' ? source.passphrase : ''
      let envText = ''
      if (srcKind === 'url') {
        envText = await fetchEnvelopeFromUrl(typeof source.url === 'string' ? source.url : '')
      } else if (srcKind === 'file') {
        envText = typeof source.file === 'string' ? source.file : ''
        if (!envText) throw new Error(t('缺少配置包内容', 'Missing package content'))
      } else {
        throw new Error(t('来源类型必须是 url 或 file', 'Source kind must be url or file'))
      }
      if (!passphrase) throw new Error(t('缺少口令（链接 #p= 后段，或导出时设置的口令）', 'Missing passphrase (the #p= part of the link, or the one set at export)'))
      let env: unknown
      try {
        env = JSON.parse(envText)
      } catch {
        throw new Error(t('不是合法的配置包（JSON 解析失败）', 'Not a valid sync package (JSON parse failed)'))
      }
      return { doc: validateSyncdoc(openEnvelope(env, passphrase)), env }
    }
    try {
      if (phase === 'apply') {
        const ticket = typeof source.ticket === 'string' ? source.ticket : ''
        const doc = ticket ? takeSyncTicket(ticket) : (await resolveDoc()).doc
        const report = await applyImportedDoc(doc)
        await reloadRuntime(rt)
        audit(bi('配置直拉导入', 'Config pull import'), phase, bi(ticket ? 'ticket' : srcKind, ticket ? 'ticket' : srcKind))
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, phase, report }))
      } else {
        const { doc, env } = await resolveDoc()
        const metaEnv = env as Record<string, unknown>
        const ticket = putSyncTicket(doc)
        audit(bi('配置直拉导入', 'Config pull import'), phase, bi(srcKind, srcKind))
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          ok: true,
          phase,
          ticket,
          report: reportOfDoc(doc),
          meta: { createdBy: String(metaEnv.created_by ?? ''), createdAt: String(metaEnv.created_at ?? '') },
        }))
      }
    } catch (e) {
      audit(bi('配置直拉导入', 'Config pull import'), phase, bi(srcKind || '-', srcKind || '-'), (e as Error).message)
      sendError(res, 400, (e as Error).message)
    }
    return
  }

  if (url === '/_modeldock/config/export' && req.method === 'POST') {
    // 导出加密配置包（.msync）：与 /m 导出、CLI config export 同一数据链路（密文出机器，口令保护）。
    // 响应走 JSON 由前端存盘下载；审计只记结果，不记口令
    const b = await jsonRequestBody(req)
    const passphrase = typeof b.passphrase === 'string' ? b.passphrase : ''
    try {
      if (!passphrase) throw new Error(t('口令不能为空', 'Passphrase must not be empty'))
      const { doc, report } = await collectSyncdoc()
      assertExportable(report)
      const env = sealEnvelope(doc, passphrase)
      const name = exportFileName()
      audit(bi('导出配置包', 'Export config package'), name, bi('已生成', 'created'))
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, envelope: env, filename: name }))
    } catch (e) {
      audit(bi('导出配置包', 'Export config package'), '-', undefined, (e as Error).message)
      sendError(res, 400, (e as Error).message)
    }
    return
  }

  if (url === '/_modeldock/sync/discover' && req.method === 'POST') {
    // 搜寻附近运行 ModelDock 且开启手机远程的电脑（UDP 广播，1.5s 收集；排除自己）
    try {
      const peers = await discoverPeers({ timeoutMs: 1500, exclude: { name: os.hostname(), port: rt.lan?.port } })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, peers }))
    } catch (e) {
      sendError(res, 400, (e as Error).message)
    }
    return
  }

  if (url === '/_modeldock/sync/request-remote' && req.method === 'POST') {
    // B 机发起：向选中的附近电脑敲门并后台轮询授权，立即返回 requestId 供前端轮询
    const b = await jsonRequestBody(req)
    try {
      const ips = Array.isArray(b.ips) ? (b.ips as unknown[]).filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim()) : []
      const port = Number(b.port)
      if (!ips.length || !Number.isInteger(port) || port <= 0 || port > 65535) {
        throw new Error(t('目标电脑参数不完整', 'Invalid target computer'))
      }
      sweepRemoteRequests()
      const requestId = randomToken('mdknear')
      remoteRequests.set(requestId, { status: 'waiting', createdAt: Date.now() })
      void runRemoteRequest(requestId, ips, port).catch(() => {
        /* runRemoteRequest 内部已兜底落 failed 状态 */
      })
      audit(bi('附近配置直拉', 'Nearby config pull'), bi('已发送请求', 'request sent'), bi(`${ips[0]}:${port}`, `${ips[0]}:${port}`))
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, requestId }))
    } catch (e) {
      audit(bi('附近配置直拉', 'Nearby config pull'), '-', undefined, (e as Error).message)
      sendError(res, 400, (e as Error).message)
    }
    return
  }

  if (url === '/_modeldock/sync/remote-status' && req.method === 'GET') {
    const q = new URL(req.url ?? '', 'http://x').searchParams
    sweepRemoteRequests()
    const st = remoteRequests.get(q.get('id') ?? '')
    if (!st) return sendError(res, 404, t('请求不存在或已过期', 'Request not found or expired'))
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, ...st }))
    return
  }

  if (url === '/_modeldock/sync/offer-approve' && req.method === 'POST') {
    // A 机裁决（桌面确认卡）：approve=true 生成一次性直拉链接写入 grant（对方凭 nonce 取走即焚）；
    // approve=false 写拒绝标记让对方立即结束等待
    const b = await jsonRequestBody(req)
    const nonce = typeof b.nonce === 'string' ? b.nonce : ''
    const approve = b.approve === true
    try {
      const pending = peekSyncRequest()
      if (!pending || pending.nonce !== nonce) throw new Error(t('请求不存在或已过期', 'Request not found or expired'))
      if (approve) {
        const offer = await createSyncOffer(rt)
        putSyncGrant(nonce, { url: offer.urls[0], passphrase: offer.passphrase })
        audit(bi('附近配置直拉', 'Nearby config pull'), bi('已允许', 'approved'), bi(pending.from, pending.from))
      } else {
        putSyncGrant(nonce, { denied: true })
        audit(bi('附近配置直拉', 'Nearby config pull'), bi('已拒绝', 'denied'), bi(pending.from, pending.from))
      }
      clearSyncRequest()
      overviewCache = null // 确认卡即时消失（overview 有 2s TTL 缓存）
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
    } catch (e) {
      audit(bi('附近配置直拉', 'Nearby config pull'), approve ? bi('已允许', 'approved') : bi('已拒绝', 'denied'), bi('-', '-'), (e as Error).message)
      sendError(res, 400, (e as Error).message)
    }
    return
  }

  if (url === '/_modeldock/autostart' && req.method === 'POST') {
    // 开机自启开关。网关必然处于运行中，install 只登记服务文件、不 bootstrap——
    // 否则第二个实例被单实例保护拒掉，launchd KeepAlive 会陷入重启循环。
    const b = await jsonRequestBody(req)
    try {
      if (b.enabled === true) {
        const r = await installAutostart()
        audit(bi('开机自启', 'Start at login'), bi('开启', 'on'), bi('服务文件 {file}', 'Service file {file}', { file: r.file }))
        // 不走 persistConfig（reloads 不变），不清缓存则紧随的 overview GET 会命中 2s TTL 旧值，UI 回灌旧状态
        overviewCache = null
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, installed: true, note: r.note ?? t('下次登录自动启动', 'Starts automatically at next login') }))
      } else {
        const r = await uninstallAutostart()
        audit(bi('开机自启', 'Start at login'), bi('关闭', 'off'), r.wasInstalled ? bi('已移除 {path}', 'Removed {path}', { path: r.removed }) : bi('本就未安装', 'Was not installed'))
        overviewCache = null
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, installed: false }))
      }
    } catch (e) {
      audit(bi('开机自启', 'Start at login'), '-', undefined, (e as Error).message)
      sendError(res, 400, (e as Error).message)
    }
    return
  }

  if (url === '/_modeldock/import/detect' && req.method === 'GET') {
    // 扫描本机各客户端/工具的现有配置（cc-switch / Claude Code / Codex / dsh / ZCode / OpenCode /
    // MiMo / WorkBuddy / CCR / Crush / Gemini CLI）；绝不回传 Key 明文
    const cands = await scanSources('all')
    const existingNorms = new Set(
      Object.values(rt.config.providers).map((p) => normalizeBaseUrl(p.base_url))
    )
    const candidates = cands.map((c) => {
      const dup = existingNorms.has(normalizeBaseUrl(c.base_url))
      return {
        id: c.suggest_id,
        source: c.source,
        name: c.name,
        base_url: c.base_url,
        hasKey: !!c.key,
        isCurrent: !!c.is_current,
        skipReason: c.skip_reason ?? (dup ? t('已在 ModelDock 中', 'Already in ModelDock') : undefined),
      }
    })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, candidates }))
    return
  }

  if (url === '/_modeldock/import/apply' && req.method === 'POST') {
    const b = await jsonRequestBody(req)
    const wantedIds: string[] | null = Array.isArray(b.ids) ? b.ids.map(String) : null
    const cands = await scanSources('all')
    // 地址重复的兜底在 applyImport 内（含批内去重），这里只按用户勾选与可导入性过滤
    const chosen = cands.filter(
      (c) => !c.skip_reason && c.base_url && (wantedIds === null || wantedIds.includes(c.suggest_id))
    )
    if (chosen.length === 0) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, imported: [], profiles: [], skipped: [] }))
      return
    }
    const report = await mutateConfig((c) => applyImport(c, chosen, { withProfiles: true }))
    await reloadRuntime(rt)
    audit(bi('导入配置', 'Import configs'), report.providers.join(',') || '-', bi('导入 {p} 个服务 / {r} 条路由', 'Imported {p} services / {r} routes', { p: report.providers.length, r: report.profiles.length }))
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, imported: report.providers, profiles: report.profiles, skipped: report.skipped }))
    return
  }

  if (url === '/_modeldock/service/update' && req.method === 'POST') {
    // 编辑模型服务：显示名称 / 接口地址 / Key / 模型目录（任选）
    const b = await jsonRequestBody(req)
    const id = typeof b.provider === 'string' ? b.provider : ''
    const p = rt.config.providers[id]
    if (!p) return sendError(res, 400, t('服务「{id}」不存在', 'Service "{id}" not found', { id }))
    const name = typeof b.name === 'string' ? b.name.trim() : ''
    const baseUrl = typeof b.base_url === 'string' ? b.base_url.trim() : ''
    // 默认协议随编辑可变（三协议端点直排后由填写的行推导，缺省保持现状）
    const newProtocol = b.protocol === 'anthropic' || b.protocol === 'openai' || b.protocol === 'responses' ? b.protocol : undefined
    if (baseUrl && !/^https?:\/\//i.test(baseUrl)) {
      return sendError(res, 400, t('接口地址必须以 http:// 或 https:// 开头', 'Base URL must start with http:// or https://'))
    }
    // 去重口径与 addService 一致：同地址且同 Key 才算重复；
    // 同地址不同 Key 是「同一厂商多个账号分别登记」的合法场景，允许共存。
    // 仅当本次提交真正改动了地址或 Key 时才校验，避免历史同对数据在改名等无关编辑时被误拦。
    const hasNewKey = typeof b.key === 'string' && !!b.key
    const oldKey = p.key_ref ? (await getSecret(p.key_ref)) ?? '' : ''
    const effectiveKey = hasNewKey ? (b.key as string) : oldKey
    const urlChanged = !!baseUrl && normalizeBaseUrl(baseUrl) !== normalizeBaseUrl(p.base_url)
    const keyChanged = hasNewKey && (b.key as string) !== oldKey
    if (urlChanged || keyChanged) {
      const norm = normalizeBaseUrl(baseUrl || p.base_url)
      for (const [pid, other] of Object.entries(rt.config.providers)) {
        if (pid === id) continue
        if (normalizeBaseUrl(other.base_url) !== norm) continue
        const otherKey = other.key_ref ? (await getSecret(other.key_ref)) ?? '' : ''
        if (otherKey === effectiveKey) {
          return sendError(res, 400, t('该地址与已有服务「{id}」重复（同地址同 Key）；同地址不同 API Key 可分别保存', 'This URL duplicates existing service "{id}" (same URL and key); the same URL with different API keys can coexist', { id: pid }))
        }
      }
    }
    let newEndpoints: Partial<Record<import('../config/types.js').Protocol, string>> | undefined
    if (b.endpoints && typeof b.endpoints === 'object' && !Array.isArray(b.endpoints)) {
      const e: Partial<Record<import('../config/types.js').Protocol, string>> = {}
      for (const [k, v] of Object.entries(b.endpoints)) {
        if (!(k === 'anthropic' || k === 'openai' || k === 'responses')) continue
        if (typeof v !== 'string') continue
        const val = v.trim()
        if (!val) { e[k as import('../config/types.js').Protocol] = ''; continue }
        if (!/^https?:\/\//i.test(val)) return sendError(res, 400, t('{proto} 协议地址必须以 http:// 或 https:// 开头', 'The {proto} endpoint URL must start with http:// or https://', { proto: k }))
        e[k as import('../config/types.js').Protocol] = val
      }
      if (Object.keys(e).length) newEndpoints = e
    }
    let newKeyRef: string | undefined
    if (typeof b.key === 'string' && b.key) {
      newKeyRef = await setSecret(id, b.key, rt.config.security?.store ?? (await defaultStore()))
    }
    // 模型目录：完整列表替换语义（UI 传全量）。校验：id 非空去重、ctx/out 为正整数；
    // 显示名随模型提交（编辑浮层在 ID 下以副行回显，仅回显与 ID 不同者）
    let newModels: Record<string, import('../config/types.js').ModelMeta> | undefined
    if (b.models && typeof b.models === 'object' && !Array.isArray(b.models)) {
      newModels = {}
      for (const [rawId, rawMeta] of Object.entries(b.models as Record<string, unknown>)) {
        const mid = rawId.trim()
        if (!mid) continue
        const meta = rawMeta as { display_name?: unknown; context_window?: unknown; max_output?: unknown; capabilities?: unknown }
        const rec: import('../config/types.js').ModelMeta = { source: 'manual' }
        const prev = p.models?.[mid]
        // 显示名：提交非空且 ≠ ID 才采用；留空/同名保留既有（预设/CLI 写入的权威名不丢）
        const dn = typeof meta?.display_name === 'string' ? meta.display_name.trim() : ''
        if (dn && dn.toLowerCase() !== mid.toLowerCase()) rec.display_name = dn
        else if (prev?.display_name) rec.display_name = prev.display_name
        const ctx = Number(meta?.context_window)
        const out = Number(meta?.max_output)
        if (Number.isFinite(ctx) && ctx > 0 && Number.isInteger(ctx)) rec.context_window = ctx
        if (Number.isFinite(out) && out > 0 && Number.isInteger(out)) rec.max_output = out
        // 用户留空时，用填充链补齐（内置表 → models.dev 目录；拉取时已收的上游值不会走到这里）
        const k = resolveModelMeta(mid)
        if (rec.context_window == null && k?.context_window != null) rec.context_window = k.context_window
        if (rec.max_output == null && k?.max_output != null) rec.max_output = k.max_output
        // 能力：显式提交 > 保留既有 > 内置表推断（如 kimi-k3 自动带 vision）；空数组=清空
        const caps = saneCapabilities(meta?.capabilities)
        const nextCaps = caps ?? prev?.capabilities ?? saneCapabilities(k?.capabilities)
        if (nextCaps?.length) rec.capabilities = nextCaps
        newModels[mid] = rec
      }
    }
    // 故障切换候选链：写入引用该 provider 的 profile（与 default_model 同一选择逻辑）。
    // 条目 "<providerId>"（透传原模型）或 "<providerId>:<modelId>"（改写模型）；空数组=清空；缺省=不动
    let newFallback: string[] | undefined
    if (Array.isArray(b.fallback)) {
      newFallback = []
      const seenIds = new Set<string>()
      for (const raw of b.fallback) {
        const parsed = parseFallbackEntry(String(raw ?? ''))
        if (!parsed) {
          return sendError(res, 400, t('备用服务条目「{entry}」无效，应为 服务ID 或 服务ID:模型ID', 'Fallback entry "{entry}" is invalid; expected ServiceID or ServiceID:ModelID', { entry: String(raw ?? '') }))
        }
        if (!rt.config.providers[parsed.providerId]) {
          return sendError(res, 400, t('备用服务「{id}」不存在', 'Fallback service "{id}" not found', { id: parsed.providerId }), t('在「我的服务」查看服务 ID，或刷新页面同步最新列表', 'Check service IDs in "My Services", or refresh the page for the latest list'))
        }
        if (parsed.providerId === id || seenIds.has(parsed.providerId)) continue
        seenIds.add(parsed.providerId)
        newFallback.push(parsed.model ? `${parsed.providerId}:${parsed.model}` : parsed.providerId)
      }
    }
    await persistConfig(rt, (c) => {
      const t = c.providers[id]
      if (!t) return
      if (name) t.name = name
      if (baseUrl) t.base_url = baseUrl
      if (newProtocol) t.protocol = newProtocol
      if (newKeyRef) t.key_ref = newKeyRef
      if (newModels) t.models = newModels
      // 协议端点：替换/清空
      if (newEndpoints) {
        const e = { ...(t.endpoints ?? {}) }
        for (const [k, v] of Object.entries(newEndpoints)) { const kp = k as import('../config/types.js').Protocol; if (v) e[kp] = v; else delete e[kp] }
        t.endpoints = Object.keys(e).length ? e : undefined
      }
      // 设置默认模型：写入引用该 provider 的 profile（优先 active_profile）
      if (typeof b.default_model === 'string') {
        const profName = profileRefForProvider(c, id)
        if (profName) {
          if (b.default_model) c.profiles[profName].default_model = b.default_model
          else delete c.profiles[profName].default_model
        }
      }
      if (Array.isArray(newFallback)) {
        const profName = profileRefForProvider(c, id)
        if (profName) {
          if (newFallback.length) c.profiles[profName].fallback = newFallback
          else delete c.profiles[profName].fallback
        }
      }
    })
    // 审计摘要：列出本次实际变更的字段（不落密钥明文）
    const changes = [
      name ? bi('名称 → {name}', 'Name → {name}', { name }) : '',
      baseUrl ? bi('地址 → {url}', 'URL → {url}', { url: baseUrl }) : '',
      newKeyRef ? bi('Key 已更新', 'Key updated') : '',
      newModels ? bi('模型目录 {n} 个', '{n} models', { n: Object.keys(newModels).length }) : '',
      newEndpoints ? bi('端点 {list} 已更新', 'Endpoints {list} updated', { list: Object.keys(newEndpoints).join('/') }) : '',
      typeof b.default_model === 'string' ? bi('默认模型 → {model}', 'Default model → {model}', { model: b.default_model || bi('(清除)', '(cleared)') }) : '',
      Array.isArray(newFallback) ? bi('备用服务 {n} 个', '{n} fallback services', { n: newFallback.length }) : '',
    ].filter(Boolean) as Array<Bilingual | ''>
    audit(bi('编辑服务', 'Edit service'), id, changes.length ? biJoin('，', ', ', changes) : bi('无字段变更', 'No fields changed'))
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
    return
  }

  if (url === '/_modeldock/service/reveal-key' && req.method === 'POST') {
    // 按需查看单个服务的已保存 Key（编辑弹窗点 👁 时调用）。Key 不随 overview 批量下发，
    // 只有显式动作才取一份明文：列表/截屏/日志场景不泄漏，Host 白名单 + 同源校验在此入口统一生效
    const b = await jsonRequestBody(req)
    const id = typeof b.id === 'string' ? b.id : ''
    const p = rt.config.providers[id]
    if (!p) return sendError(res, 400, t('服务「{id}」不存在', 'Service "{id}" not found', { id }))
    const key = await getSecret(p.key_ref)
    audit(bi('查看 Key', 'View key'), id, key ? bi('读取成功', 'Read ok') : bi('Key 不可读（未设置或安全后端拒绝）', 'Key unreadable (not set or the OS keychain refused)'))
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, key: key ?? null }))
    return
  }

  if (url === '/_modeldock/harness/env' && req.method === 'POST') {
    // 按需取某客户端经网关接入用的环境变量（generic-env 的「复制环境变量」按钮调用）。
    // token 属敏感值，与 reveal-key 同策略：不随 overview 批量下发，显式动作才返回一份
    const b = await jsonRequestBody(req)
    const hid = String(b.harness ?? '')
    const he = rt.config.harness[hid]
    if (!he) return sendError(res, 400, t('客户端「{id}」尚未接入，先接入再获取环境变量', 'Client "{id}" is not attached yet; attach it first to get env vars', { id: hid }))
    const token = he.token ?? ''
    if (!token) return sendError(res, 400, t('客户端「{id}」没有网关令牌（该客户端不经本网关转发）', 'Client "{id}" has no gateway token (it does not route through this gateway)', { id: hid }))
    const port = rt.port ?? rt.config.gateway?.port ?? DEFAULT_GATEWAY_PORT
    const base = `http://127.0.0.1:${port}`
    audit(bi('查看环境变量', 'View env vars'), hid)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({
        ok: true,
        harness: hid,
        base_url: base,
        token,
        lines: [
          `export ANTHROPIC_BASE_URL=${base}`,
          `export ANTHROPIC_AUTH_TOKEN=${token}`,
          `export OPENAI_BASE_URL=${base}/v1`,
          `export OPENAI_API_KEY=${token}`,
        ],
      })
    )
    return
  }

  if (url === '/_modeldock/service/delete' && req.method === 'POST') {
    const b = await jsonRequestBody(req)
    const id = typeof b.provider === 'string' ? b.provider : ''
    const p = rt.config.providers[id]
    if (!p) return sendError(res, 400, t('服务「{id}」不存在', 'Service "{id}" not found', { id }))
    // 与 CLI cmdProviderRm 共用 ops.removeProviderCascade：除路由外还清理 auto_route_provider、
    // 各 profile 的 fallback 候选链与定时切换窗口里的悬空条目
    const usedBy = Object.entries(rt.config.profiles).filter(([, pr]) => pr.provider === id).map(([k]) => k)
    // 有客户端钉定/直连在将被删除的路由上：直接拒绝（网关钉定删了留下悬空 route → 请求 503；
    // 独立直连已把该服务 URL+Key 写进客户端文件，删了直连目标失效）。file 模式客户端自管路由、
    // 不沿网关转发，删除服务不影响它，不拦截（其 route 仅登记痕迹，随删除清掉，见 ops.removeProviderCascade）
    const pinned = Object.entries(rt.config.harness).filter(
      ([, he]) => he.route && he.mode !== 'file' && usedBy.includes(he.route)
    )
    if (pinned.length > 0) {
      const pinnedGateway = pinned.filter(([, he]) => he.mode !== 'direct').map(([h]) => h).join(t('、', ', '))
      const pinnedDirect = pinned.filter(([, he]) => he.mode === 'direct').map(([h]) => h).join(t('、', ', '))
      return sendError(
        res,
        400,
        [
          pinnedGateway
            ? t('有客户端钉定在该服务的路由上（{list}），先在客户端卡片把路由改回「跟随全局」再删除', 'A client is pinned to a route of this service ({list}); switch the route back to "follow global" on the client card before deleting', { list: pinnedGateway })
            : '',
          pinnedDirect
            ? t('有客户端独立直连到该服务（{list}），请先断开该客户端的接入，或把它切回网关模式再删除', 'A client connects directly to this service ({list}); detach it or switch it back to gateway mode before deleting', { list: pinnedDirect })
            : '',
        ]
          .filter(Boolean)
          .join(t('；', '; '))
      )
    }
    try { await deleteSecret(p.key_ref) } catch { /* Key 已不存在则忽略 */ }
    let removedProfiles: string[] = []
    await persistConfig(rt, (c) => {
      removedProfiles = removeProviderCascade(c, id)
    })
    audit(bi('删除服务', 'Delete service'), id, removedProfiles.length ? bi('同时删除路由 {list}', 'Also removed routes {list}', { list: biJoin('、', ', ', removedProfiles) }) : undefined)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, removed: id, profiles: removedProfiles }))
    return
  }

  if (url === '/_modeldock/install' && req.method === 'POST') {
    const b = await jsonRequestBody(req)
    try {
      const a = await requireAdapter(String(b.harness ?? ''), rt.config)
      const port = rt.port ?? rt.config.gateway?.port ?? DEFAULT_GATEWAY_PORT
      const r = await runClientInstall(a, rt.config, port)
      audit(
        bi('安装并接入客户端', 'Install & attach client'),
        a.id,
        r.ok
          ? (r.skipped ? bi('命令已存在，跳过安装', 'Command already present, install skipped') : r.auto ? bi('自动安装完成', 'Auto-install finished') : bi('已提供安装指引', 'Install guide provided'))
          : r.blocked
            ? bi('沙箱内不支持自动安装（会写进真机），已提示手动安装', 'Auto-install not supported in sandbox (would write to the real machine); manual install suggested')
            : bi('安装失败', 'Install failed')
      )
      await reloadRuntime(rt)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          ok: r.ok,
          auto: r.auto,
          skipped: r.skipped,
          output: r.output,
          installed: r.installed,
          guide: a.install?.guide ?? '',
          homepage: a.install?.homepage ?? null,
        })
      )
    } catch (e) {
      sendError(res, 400, (e as Error).message)
    }
    return
  }

  if (url === '/_modeldock/uninstall' && req.method === 'POST') {
    const b = await jsonRequestBody(req)
    try {
      const a = await requireAdapter(String(b.harness ?? ''), rt.config)
      // 接入中的客户端先断开：卸载只删程序本体，配置还原是 detach 的职责，顺序反了会留下指向网关的孤儿配置
      if (rt.config.harness[a.id]) {
        throw new Error(t('该客户端仍处于接入状态，请先「断开并还原」再卸载', 'This client is still attached — detach & restore first, then uninstall'))
      }
      const port = rt.port ?? rt.config.gateway?.port ?? DEFAULT_GATEWAY_PORT
      const r = await runClientUninstall(a, rt.config, port)
      audit(
        bi('卸载客户端', 'Uninstall client'),
        a.id,
        r.ok ? (r.skipped ? bi('命令不在 PATH，无需卸载', 'Command not on PATH; nothing to uninstall') : bi('卸载完成', 'Uninstall finished')) : bi('卸载失败', 'Uninstall failed')
      )
      await reloadRuntime(rt)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: r.ok, skipped: r.skipped, output: r.output, installed: r.installed }))
    } catch (e) {
      sendError(res, 400, (e as Error).message)
    }
    return
  }

  // attach 请求体里的 client_profiles：["desktop"] 或 "desktop,web"（后者兼容表单直传）；非法输入一律忽略为全部
  const parseClientProfiles = (v: unknown): string[] | undefined => {
    const list = Array.isArray(v)
      ? v.map((x) => String(x).trim()).filter(Boolean)
      : typeof v === 'string'
        ? v.split(',').map((s) => s.trim()).filter(Boolean)
        : []
    return list.length > 0 ? list : undefined
  }

  if (url === '/_modeldock/attach/plan' && req.method === 'POST') {
    const b = await jsonRequestBody(req)
    try {
      const plan = await planAttach(String(b.harness ?? ''), {
        profile: typeof b.profile === 'string' && b.profile ? b.profile : undefined,
        clientProfiles: parseClientProfiles(b.client_profiles),
        setDefault: b.setDefault === true,
        takeoverModels: b.takeoverModels === true,
        gatewayPort: rt.port, // 本实例自己的端口；状态文件在多实例下可能记录的是别的实例
      })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, ...plan }))
    } catch (e) {
      sendError(res, 400, (e as Error).message)
    }
    return
  }

  if (url === '/_modeldock/attach/apply' && req.method === 'POST') {
    const b = await jsonRequestBody(req)
    try {
      const r = await applyAttach(String(b.harness ?? ''), {
        profile: typeof b.profile === 'string' && b.profile ? b.profile : undefined,
        clientProfiles: parseClientProfiles(b.client_profiles),
        setDefault: b.setDefault === true,
        takeoverModels: b.takeoverModels === true,
        gatewayPort: rt.port, // 本实例自己的端口；状态文件在多实例下可能记录的是别的实例
      })
      await reloadRuntime(rt) // 立即刷新内存态，overview 才能即时反映接入结果
      // attach 写入的 picker 目录取自 active_profile；若此刻正处于 prefer 窗口接管（展示路由 ≠
      // active_profile），基线置失效让周期检测在 5s 内按窗口目标校准一次
      pickerSyncStates.get(rt)!.route = undefined
      audit(bi('接入客户端', 'Attach client'), r.harness, bi('端口 {port}，写入 {n} 个文件', 'Port {port}, wrote {n} files', { port: r.port, n: r.files.length }))
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, ...r, hint: t('重启 {id} 后生效；原文件已自动快照，可随时断开还原', 'Takes effect after restarting {id}; the original files were auto-snapshotted and can be restored anytime by detaching', { id: r.harness }) }))
    } catch (e) {
      audit(bi('接入客户端', 'Attach client'), String(b.harness ?? '-'), undefined, (e as Error).message)
      sendError(res, 400, (e as Error).message)
    }
    return
  }

  if (url === '/_modeldock/detach' && req.method === 'POST') {
    const b = await jsonRequestBody(req)
    try {
      const r = await detachHarness(String(b.harness ?? ''))
      await reloadRuntime(rt)
      audit(bi('断开客户端', 'Detach client'), String(b.harness ?? '-'), r.restored ? bi('已还原到本次接入前（快照 {id}）', 'Restored to the state before this attach (snapshot {id})', { id: r.snapshotId ?? '-' }) : bi('已反向清理网关配置', 'Gateway-side config cleaned up in reverse'))
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, ...r }))
    } catch (e) {
      audit(bi('断开客户端', 'Detach client'), String(b.harness ?? '-'), undefined, (e as Error).message)
      sendError(res, 400, (e as Error).message)
    }
    return
  }

  if (url === '/_modeldock/harness/route' && req.method === 'POST') {
    // 客户端钉路由：UI 按「服务」（provider）操作，API 也可直接指定 profile 名；default = 恢复跟随全局。
    // 路由本身只改 config 的 harness.route（服务端内存，热加载后下一请求生效）；烤模型客户端
    // （dsh/workbuddy/zcode，adapter.bakesModels）的模型列表烙在客户端文件里，钉定后需按新 profile 重写
    const b = await jsonRequestBody(req)
    const hid = String(b.harness ?? '')
    try {
      if (!rt.config.harness[hid]) return sendError(res, 400, t('客户端「{id}」未接入，先接入再设置路由', 'Client "{id}" is not attached; attach it first to set a route', { id: hid }))
      if (rt.config.harness[hid].mode === 'direct') {
        return sendError(res, 400, t('客户端「{id}」是独立直连模式：更换直连目标请用 /harness/mode（需要重写客户端配置文件）', 'Client "{id}" is in standalone direct mode: use /harness/mode to change the direct target (client config files get rewritten)', { id: hid }))
      }
      if (rt.config.harness[hid].mode === 'file') {
        return sendError(res, 400, t('客户端「{id}」是 file 模式（客户端自管路由），不支持钉定', 'Client "{id}" is in file mode (it manages its own routing) and cannot be pinned', { id: hid }))
      }
      const toDefault = b.default === true
      const profileName = typeof b.profile === 'string' && b.profile ? b.profile : ''
      const providerId = typeof b.provider === 'string' && b.provider ? b.provider : ''
      if (!toDefault && !profileName && !providerId) {
        return sendError(res, 400, t('缺少路由目标：provider / profile / default 三选一', 'Missing route target: provide one of provider / profile / default'))
      }
      if (profileName && !rt.config.profiles[profileName]) {
        return sendError(res, 400, t('profile「{name}」不存在', 'Profile "{name}" not found', { name: profileName }))
      }
      if (providerId && !rt.config.providers[providerId]) {
        return sendError(res, 400, t('服务「{id}」不存在', 'Service "{id}" not found', { id: providerId }))
      }
      let finalRoute = toDefault ? 'default' : profileName
      await persistConfig(rt, (c) => {
        if (!toDefault && !profileName && providerId) {
          finalRoute = profileForProvider(c, providerId)
        }
        c.harness[hid] = { ...(c.harness[hid] ?? rt.config.harness[hid]!), route: finalRoute }
      })
      // 烤模型客户端按目标 profile 重写模型列表（恢复跟随 = 按 active_profile 重写；透明客户端为空操作）
      const syncProfile = toDefault ? rt.config.active_profile ?? undefined : finalRoute
      const synced = syncProfile
        ? await resyncHarnessToRoute(hid, syncProfile, { port: rt.port })
        : { refreshed: [], warnings: [] }
      const detail = biCat(
        finalRoute === 'default' ? bi('恢复跟随全局', 'Back to follow global') : bi('钉到 {route}', 'Pinned to {route}', { route: finalRoute }),
        synced.refreshed.length ? bi('；已同步重写 {id} 的模型列表（重启该客户端生效）', '; rewrote the model list of {id} (restart the client to apply)', { id: hid }) : '',
        synced.warnings.length ? bi('；{list}', '; {list}', { list: biJoin('；', '; ', synced.warnings) }) : ''
      )
      audit(bi('客户端钉路由', 'Pin client route'), hid, detail)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, route: finalRoute, ...synced, hint: synced.refreshed.length ? t('已同步重写该客户端的模型列表，重启该客户端后生效', 'Rewrote the model list of this client; restart the client to apply') : undefined }))
    } catch (e) {
      audit(bi('客户端钉路由', 'Pin client route'), hid, undefined, (e as Error).message)
      sendError(res, 400, (e as Error).message)
    }
    return
  }

  if (url === '/_modeldock/harness/mode' && req.method === 'POST') {
    // 接入模式切换：direct（独立直连，写上游 url+真实 Key，重写客户端文件）⇄ gateway（切回网关）。
    // 复用 ops.switchHarnessMode（快照/原子写/登记），直连后客户端不经过网关，网关挂掉仍可用作救援通道
    const b = await jsonRequestBody(req)
    const hid = String(b.harness ?? '')
    const mode = b.mode === 'direct' ? 'direct' : b.mode === 'gateway' ? 'gateway' : ''
    if (!mode) return sendError(res, 400, t('mode 必须是 gateway 或 direct', 'mode must be gateway or direct'))
    const he = rt.config.harness[hid]
    if (!he) return sendError(res, 400, t('客户端「{id}」未接入，先接入再切换模式', 'Client "{id}" is not attached; attach it first to switch modes', { id: hid }))
    if (he.mode === 'file') return sendError(res, 400, t('file 模式的客户端暂不支持切换直连', 'Clients in file mode do not support switching to direct yet'))
    if (mode === 'gateway' && he.mode !== 'direct') {
      return sendError(res, 400, t('客户端「{id}」已是网关接入模式', 'Client "{id}" is already in gateway mode', { id: hid }))
    }
    if (mode === 'direct' && he.mode === 'direct' && !b.profile && !b.provider) {
      return sendError(res, 400, t('客户端「{id}」已是独立直连模式；更换直连目标请带 profile 或 provider', 'Client "{id}" is already in standalone direct mode; pass profile or provider to change the direct target', { id: hid }))
    }
    const profileOverride = typeof b.profile === 'string' && b.profile ? b.profile : ''
    const providerOverride = typeof b.provider === 'string' && b.provider ? b.provider : ''
    if (profileOverride && !rt.config.profiles[profileOverride]) {
      return sendError(res, 400, t('profile「{name}」不存在', 'Profile "{name}" not found', { name: profileOverride }))
    }
    if (providerOverride && !rt.config.providers[providerOverride]) {
      return sendError(res, 400, t('服务「{id}」不存在', 'Service "{id}" not found', { id: providerOverride }))
    }
    try {
      let profile = profileOverride || undefined
      if (mode === 'direct' && !profile && providerOverride) {
        await persistConfig(rt, (c) => {
          profile = profileForProvider(c, providerOverride)
        })
      }
      const r = await switchHarnessMode(hid, mode, { profile, yes: true, port: rt.port })
      await reloadRuntime(rt)
      audit(mode === 'direct' ? bi('客户端切直连', 'Client switched to direct') : bi('客户端切回网关', 'Client switched back to gateway'), hid, bi('目标 {target}，写入 {n} 个文件', 'Target {target}, wrote {n} files', { target: r.profile, n: r.files.length }))
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, ...r, hint: t('重启 {id} 后生效', 'Takes effect after restarting {id}', { id: hid }) }))
    } catch (e) {
      audit(mode === 'direct' ? bi('客户端切直连', 'Client switched to direct') : bi('客户端切回网关', 'Client switched back to gateway'), hid, undefined, (e as Error).message)
      sendError(res, 400, (e as Error).message)
    }
    return
  }

  if (url === '/_modeldock/use' && req.method === 'POST') {
    const b = await jsonRequestBody(req)
    const name = typeof b.profile === 'string' ? b.profile : ''
    if (!name || !rt.config.profiles[name]) {
      return sendError(res, 400, t('profile「{name}」不存在', 'Profile "{name}" not found', { name }), t('modeldock profile list 查看', 'Run modeldock profile list to view profiles'))
    }
    await persistConfig(rt, (c) => {
      c.active_profile = name
    })
    audit(bi('切换路由', 'Switch route'), name)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, active_profile: name }))
    return
  }

  if (url === '/_modeldock/profile' && req.method === 'POST') {
    const b = await jsonRequestBody(req)
    const name = typeof b.name === 'string' ? b.name : ''
    const provider = typeof b.provider === 'string' ? b.provider : ''
    if (!/^[a-zA-Z0-9_-]{1,40}$/.test(name)) {
      return sendError(res, 400, t('profile 名称只能是字母/数字/-/_，长度 ≤40', 'Profile name allows only letters/digits/-/_ and must be ≤40 chars'))
    }
    if (!provider || !rt.config.providers[provider]) {
      return sendError(res, 400, t('provider「{id}」不存在', 'Provider "{id}" not found', { id: provider }))
    }
    if (rt.config.profiles[name]) {
      return sendError(res, 400, t('profile「{name}」已存在', 'Profile "{name}" already exists', { name }))
    }
    const models = rt.config.providers[provider].models ?? {}
    const defaultModel = typeof b.default_model === 'string' && b.default_model ? b.default_model : undefined
    if (defaultModel && Object.keys(models).length > 0 && !models[defaultModel]) {
      return sendError(res, 400, t('模型「{model}」不在 {id} 的目录里', 'Model "{model}" is not in the catalog of {id}', { model: defaultModel, id: provider }), 'modeldock model list ' + provider)
    }
    const aliases =
      b.aliases && typeof b.aliases === 'object' && !Array.isArray(b.aliases)
        ? Object.fromEntries(
            Object.entries(b.aliases as Record<string, unknown>)
              .filter(([k, v]) => typeof k === 'string' && k && typeof v === 'string')
              .map(([k, v]) => [k, String(v)])
          )
        : undefined
    await persistConfig(rt, (c) => {
      c.profiles[name] = { name, provider, default_model: defaultModel, aliases }
      if (!c.active_profile) c.active_profile = name
    })
    audit(bi('新建路由', 'Create route'), name, biCat(`provider=${provider}`, defaultModel ? bi('，默认模型 {model}', ', default model {model}', { model: defaultModel }) : ''))
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, profile: name }))
    return
  }

  if (url === '/_modeldock/key' && req.method === 'POST') {
    const b = await jsonRequestBody(req)
    const provider = typeof b.provider === 'string' ? b.provider : ''
    const key = typeof b.key === 'string' ? b.key : ''
    if (!provider || !rt.config.providers[provider]) {
      return sendError(res, 400, t('provider「{id}」不存在', 'Provider "{id}" not found', { id: provider }))
    }
    if (!key) {
      return sendError(res, 400, t('key 不能为空', 'Key must not be empty'))
    }
    const backend = rt.config.security?.store ?? (await defaultStore())
    const keyRef = await setSecret(provider, key, backend)
    await persistConfig(rt, (c) => {
      if (c.providers[provider]) c.providers[provider].key_ref = keyRef
    })
    audit(bi('更新密钥', 'Update key'), provider, bi('存入 {backend}', 'Stored in {backend}', { backend }))
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
    return
  }

  if (url === '/_modeldock/reload' && req.method === 'POST') {
    try {
      await reloadRuntime(rt)
      audit(bi('重载配置', 'Reload config'), '-', bi('第 {n} 次热重载', 'Hot reload #{n}', { n: rt.reloads }))
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, reloads: rt.reloads }))
    } catch (e) {
      audit(bi('重载配置', 'Reload config'), '-', undefined, (e as Error).message)
      sendError(res, 500, t('配置重载失败：{msg}', 'Failed to reload config: {msg}', { msg: (e as Error).message }))
    }
    return
  }

  if (url === '/_modeldock/test' && req.method === 'POST') {
    const body = await readBody(req)
    let p: { profile?: string; provider?: string; model?: string; stream?: boolean; mode?: string } = {}
    try {
      p = body.length ? JSON.parse(body.toString('utf8')) : {}
    } catch {
      return sendError(res, 400, t('test 请求体必须是 JSON', 'The test request body must be JSON'))
    }
    let resolved: { ok: boolean; target?: ResolvedTarget; status?: number; message?: string; hint?: string }
    if (p.provider) {
      // 按服务直接探测（不必先建路由）
      const provider = rt.config.providers[p.provider]
      if (!provider) return sendError(res, 400, t('服务「{id}」不存在', 'Service "{id}" not found', { id: p.provider }))
      const models = Object.keys(provider.models ?? {})
      const fakeProfile = {
        name: `probe-${p.provider}`,
        provider: p.provider,
        default_model: p.model ?? models[0],
      }
      resolved = { ok: true, target: { harness: 'admin-test', profileName: fakeProfile.name, profile: fakeProfile, provider } }
    } else {
      resolved = resolveByProfile(rt, p.profile)
    }
    if (!resolved.ok) return sendError(res, resolved.status ?? 400, resolved.message ?? t('无法解析路由', 'Cannot resolve a route'), resolved.hint)
    // mode='ping' → 纯网络延迟（不推理）；否则保持原有的完整模型请求测速
    const out = p.mode === 'ping'
      ? await probePing(rt, resolved.target!.provider)
      : await probe(rt, resolved.target!, p.model, p.stream === true, o)
    // 连接测试也记入请求日志（客户端记为 admin-test），便于追溯测试失败原因
    logRequest(rt, {
      ts: localIsoTs(),
      harness: 'admin-test',
      profile: resolved.target?.profileName ?? '-',
      provider: p.provider ?? resolved.target?.profile.provider ?? '-',
      model: (out as { model?: string }).model ?? p.model,
      path: p.mode === 'ping' ? 'ping' : url,
      status: out.ok ? 200 : 502,
      ms: out.ms,
      err: out.err,
    })
    res.writeHead(out.ok ? 200 : 502, { 'content-type': 'application/json' })
    res.end(JSON.stringify(out))
    return
  }

  if (url === '/_modeldock/reset' && req.method === 'POST') {
    const { configPath, secretsPath } = await import('../util/paths.js')
    const fs = await import('node:fs')
    // 先清 OS 钥匙环里的 Key（keychain/secret-service 条目不在 secrets.json 里，删文件清不掉）
    let secretsCleared = 0
    for (const [id, p] of Object.entries(rt.config.providers)) {
      try {
        await deleteSecret(p.key_ref)
        secretsCleared++
      } catch { /* 单项失败不影响其余 */ }
    }
    const files = [configPath(), secretsPath()]
    const deleted: string[] = []
    for (const f of files) {
      try {
        if (fs.existsSync(f)) { fs.unlinkSync(f); deleted.push(f) }
      } catch { /* 忽略 */ }
    }
    // 重载为空配置
    await reloadRuntime(rt)
    audit(bi('重置配置', 'Reset config'), '-', bi('删除 {files}，清除 {n} 个密钥', 'Deleted {files}; cleared {n} keys', { files: deleted.length ? biJoin('、', ', ', deleted) : bi('无文件', 'no files'), n: secretsCleared }))
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, deleted, hint: t('配置已清空（含钥匙环密钥）；快照和日志保留。运行 modeldock init 重新配置', 'Config cleared (including keychain keys); snapshots and logs are kept. Run modeldock init to set up again') }))
    return
  }

  sendError(res, 404, t('未知管理端点 {url}', 'Unknown admin endpoint {url}', { url }))
}

export interface ProbeResult {
  ok: boolean
  status: number
  ms: number
  ttfb_ms?: number
  model?: string
  usage?: Record<string, number>
  err?: string
  hint?: string
}

/** 端到端探测：按 profile 发一次最小请求（modeldock test 的后端） */
export async function probe(
  rt: GatewayRuntime,
  target: import('./state.js').ResolvedTarget,
  modelOverride: string | undefined,
  stream: boolean,
  o: { idle: number; retries: number }
): Promise<ProbeResult> {
  const t0 = Date.now()
  const model = modelOverride ?? target.profile.default_model
  if (!model) {
    return { ok: false, status: 0, ms: 0, err: t('该 profile 未设置 default_model，请用 -m 指定或 modeldock profile 修改', 'This profile has no default_model; pass -m or change it with modeldock profile') }
  }
  const isAnthropic = target.provider.protocol === 'anthropic'
  const path = isAnthropic ? '/v1/messages' : '/v1/chat/completions'
  const body = Buffer.from(
    JSON.stringify({
      model,
      max_tokens: 16,
      stream,
      messages: [{ role: 'user', content: 'ping' }],
    })
  )
  try {
    const up = await forwardToUpstream(rt, target, {
      method: 'POST',
      path,
      headers: { 'content-type': 'application/json' },
      body,
      idleTimeoutMs: o.idle,
      retries: o.retries,
    })
    if (up.status >= 400) {
      const text = await up.body.text()
      // 转成可读的一行：上游 message + 修复提示，而非整段 JSON
      let msg = text.slice(0, 400)
      try {
        const j = JSON.parse(text)
        msg = [j?.error?.message, j?.modeldock?.hint].filter(Boolean).join(' → ')
      } catch {
        /* 非 JSON 保持原文 */
      }
      return {
        ok: false,
        status: up.status,
        ms: Date.now() - t0,
        model,
        err: msg,
      }
    }
    const text = await up.body.text()
    let usage: Record<string, number> | undefined
    if (!stream) {
      try {
        const j = JSON.parse(text)
        const u = j?.usage
        if (u && typeof u === 'object') {
          usage = {}
          for (const [k, v] of Object.entries(u)) {
            if (typeof v === 'number') usage[k] = v
          }
        }
      } catch {
        /* SSE 或非 JSON */
      }
    }
    return { ok: true, status: up.status, ms: Date.now() - t0, model: up.modelAfter ?? model, usage }
  } catch (e) {
    const ue = e as UpstreamError
    return { ok: false, status: ue.status ?? 502, ms: Date.now() - t0, model, err: ue.message, hint: ue.hint }
  }
}

export interface PingResult {
  ok: boolean
  ms: number
  err?: string
  hint?: string
}

/** 纯网络延迟探测：向 provider 的 origin 发一次最小请求，测「首字节到达」耗时（不做模型推理） */
export async function probePing(
  rt: GatewayRuntime,
  provider: ProviderConfig
): Promise<PingResult> {
  const base = (provider.base_url ?? '').trim()
  if (!base) {
    return { ok: false, ms: 0, err: t('provider 未配置 base_url', 'Provider has no base_url configured') }
  }
  let origin: string
  try {
    origin = new URL(base).origin
  } catch {
    return { ok: false, ms: 0, err: t('base_url 无效：{url}', 'Invalid base_url: {url}', { url: base }) }
  }
  const t0 = Date.now()
  try {
    // 请求到 origin 根路径即可；不鉴权、不推理，只测网络往返
    const res = await undiciRequest(origin + '/', {
      method: 'GET',
      dispatcher: dispatcherFor(rt, provider),
      headersTimeout: 10_000,
      bodyTimeout: 10_000,
    })
    const ms = Date.now() - t0
    // 释放连接（抑制 aborted 错误事件）
    if (typeof (res.body as unknown as { on?: Function }).on === 'function') {
      ;(res.body as unknown as NodeJS.EventEmitter).on('error', () => {})
    }
    ;(res.body as unknown as { destroy?: () => void })?.destroy?.()
    return { ok: true, ms }
  } catch (e) {
    return {
      ok: false,
      ms: Date.now() - t0,
      err: t('网络不可达：{msg}', 'Network unreachable: {msg}', { msg: (e as Error).message }),
      hint: t('检查网络/代理（provider.proxy），或本地是否放行了该域名', 'Check network/proxy (provider.proxy), or whether this domain is blocked locally'),
    }
  }
}
