/**
 * 网关侧更新服务（M2：Web 控制台 / 托盘的更新入口；实施基准 docs/design-auto-update.md §6）
 *
 * 职责：启动静默检查（24h TTL，gateway.json 持久化，失败静默）、状态查询、
 * 「一键更新」应用。安装动作绝不在本进程执行——网关自己就是被替换对象，
 * 在本进程内停网关等于自杀在半路；apply 只分离 spawn `update --yes` 子进程，
 * 由它复用 M1 CLI 全流程（下载→校验→停网关→替换→拉起），输出落到 logs/update-<日期>.log。
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { VERSION } from '../version.js'
import { DEFAULT_UPDATE_REPO, type Config } from '../config/types.js'
import { getSecret } from '../config/secrets.js'
import { readGatewayState, mutateGatewayState, type GatewayRuntime } from '../gateway/state.js'
import { displayPath, logsDir } from '../util/paths.js'
import { localDateStr, t } from '../util/index.js'
import { compareVersions, fetchLatestRelease, findAsset, selectAssetName, type ReleaseManifest } from './check.js'
import { detectInstallShape, hasWindowsUninstaller } from './install.js'
import { notesSummaryText, notesToPlain } from './notes.js'
import { readUpdateProgress, type UpdateProgress } from './progress.js'
import { resolveUpdateProxyUrl } from '../util/sysproxy.js'

const CHECK_TTL_MS = 24 * 3600_000
/** 检查失败后的重试间隔：失败不该占用 24h 成功窗口（否则 GitHub 偶发不可达要隔天才能再试） */
const FAIL_RETRY_MS = 30 * 60_000

interface UpdateWebState {
  checking: boolean
  /** 最近一次成功检查的时间（可用性判断的时间基准）；失败不写它 */
  lastCheckedAt: number | null
  /** 最近一次失败检查的时间（失败重试退避用） */
  lastFailAt: number | null
  lastError: string | null
  /** 最近一次成功检查的最新版本与说明（可用性按 available 现算，不落旧态）；sizeBytes = 本机适配安装包体积（找不到适配资产为 null） */
  manifest: { version: string; notes: string; htmlUrl: string; sizeBytes: number | null } | null
  updating: boolean
  /** 一键更新失败原因（子进程退出而网关未重启 = 失败；成功路径里网关先死，观察不到退出） */
  applyError: string | null
}

const state: UpdateWebState = { checking: false, lastCheckedAt: null, lastFailAt: null, lastError: null, manifest: null, updating: false, applyError: null }
let inflight: Promise<void> | null = null
/** 测试注入：本地 mock API 基地址（null = 官方 https://api.github.com） */
let apiBaseOverride: string | null = null
/** 测试注入：替换底层拉取函数（单测并发防重入时用桩计数）；第 4 参为代理解析结果 */
let fetchOverride: ((repo: string, token: string | null, apiBase?: string, opts?: { proxyUrl?: string | null }) => Promise<ReleaseManifest>) | null = null

/** 测试专用：注入更新检查的 API 基地址（单测用本地 http server 伪造 GitHub API） */
export function setUpdateApiBaseForTests(base: string | null): void {
  apiBaseOverride = base
}

/** 测试专用：注入底层拉取函数（null = 默认 fetchLatestRelease） */
export function setUpdateFetchForTests(fn: ((repo: string, token: string | null, apiBase?: string, opts?: { proxyUrl?: string | null }) => Promise<ReleaseManifest>) | null): void {
  fetchOverride = fn
}

/** 测试专用：清空模块级状态（manifest/updating/检查时间跨用例泄漏会让守卫误判） */
export function resetUpdateStateForTests(): void {
  state.checking = false
  state.lastCheckedAt = null
  state.lastFailAt = null
  state.lastError = null
  state.manifest = null
  state.updating = false
  state.applyError = null
  inflight = null
}

/** 公开仓库匿名即可检查；配置了 token_ref 才带令牌（私有仓库兼容/提升限流）。
 *  返回 null 仅在极端异常（无 config）时——repo 恒有默认值 */
async function resolveTokenAndRepo(cfg: Config): Promise<{ repo: string; token: string | null; apiBase?: string }> {
  const ref = cfg.update?.token_ref
  const token = ref ? await getSecret(ref) : null
  return { repo: cfg.update?.repo ?? DEFAULT_UPDATE_REPO, token, apiBase: cfg.update?.api_base }
}

/** 启动时恢复上次检查时间（gateway.json 持久化的 24h TTL 跨网关重启有效） */
export async function restoreUpdateCheckState(): Promise<void> {
  const s = await readGatewayState()
  if (s?.update_check?.at) state.lastCheckedAt = s.update_check.at
  if (s?.update_check?.failedAt) state.lastFailAt = s.update_check.failedAt
}

/** 发起一次检查：检查中 / 成功 TTL 内 / 失败重试窗内（未 force）静默跳过。匿名（无令牌）照常检查。
 *  不等待完成，状态经 getUpdateStatus 轮询。 */
export async function kickUpdateCheck(rt: GatewayRuntime, opts: { force?: boolean } = {}): Promise<void> {
  if (state.checking || inflight) return
  // 在任何 await 之前同步创建并占位 inflight：并发两次 kick 才能被上方 guard 挡住。
  // （此前 inflight 赋值在首个 await resolveTokenAndRepo 之后——并发调用双双穿透，双拉 GitHub 耗 rate-limit。）
  const p = (async () => {
    state.checking = true
    try {
      const resolved = await resolveTokenAndRepo(rt.config)
      const now = Date.now()
      if (!opts.force) {
        if (state.lastCheckedAt && now - state.lastCheckedAt < CHECK_TTL_MS) return
        if (state.lastFailAt && now - state.lastFailAt < FAIL_RETRY_MS) return
      }
      // 仅在真的要发请求时才解析代理（TTL 命中的常驻轮询不付 scutil/注册表查询成本）。
      // 与 run.ts 同口径：apiBase 是测试注入缝隙，注入即本地 mock，绝不代理
      const proxyUrl = apiBaseOverride ? null : await resolveUpdateProxyUrl()
      const fetchFn = fetchOverride ?? fetchLatestRelease
      const m = await fetchFn(resolved.repo, resolved.token, apiBaseOverride ?? resolved.apiBase, { proxyUrl })
      state.manifest = { version: m.version, notes: m.notes, htmlUrl: m.htmlUrl, sizeBytes: matchedAssetSize(m) }
      state.lastError = null
      state.lastFailAt = null
      state.lastCheckedAt = Date.now()
      await persistCheckTime(m.version)
    } catch (e) {
      // 检查失败静默（不打扰用户），lastError 供控制台手动检查时展示。
      // 失败不占成功 TTL（lastCheckedAt 不动），只记 lastFailAt 走 30min 重试退避
      state.lastError = (e as Error).message
      state.lastFailAt = Date.now()
      await persistCheckTime()
    } finally {
      state.checking = false
      inflight = null
    }
  })()
  inflight = p
  await p
}

/** 把检查时间落 gateway.json：成功写 at/version 并清 failedAt；失败只写 failedAt（保留此前成功时间）。
 *  走 mutateGatewayState 串行队列：裸 read→modify→write 会与 devices/lan_token 等并发写方整包互相
 *  覆盖——每 60s status 轮询 kick 一次检查，丢刚写入的设备记忆/手机凭据（评测集
 *  runs/2026-10-30-webupdate-latch-no-rollback.md 问题 2，2026-10-31 修复）。 */
function persistCheckTime(version?: string): Promise<void> {
  return mutateGatewayState((s) => {
    if (!s) return null
    const prev = s.update_check
    if (state.lastFailAt != null) {
      return {
        ...s,
        update_check: { ...(prev ? { at: prev.at, version: prev.version } : {}), failedAt: state.lastFailAt },
      }
    }
    if (state.lastCheckedAt != null) {
      return { ...s, update_check: { at: state.lastCheckedAt, ...(version ? { version } : {}) } }
    }
    return null
  }).catch(() => {
    /* 持久化失败不影响主流程（内存态仍在） */
  })
}

/** 网关启动钩子（main.ts 调用）：fire-and-forget，绝不阻塞启动；MODELRDOCK_DISABLE_UPDATE_CHECK=1 关闭 */
export function startBootUpdateCheck(rt: GatewayRuntime): void {
  if (process.env.MODELRDOCK_DISABLE_UPDATE_CHECK === '1') return
  void (async () => {
    await restoreUpdateCheckState()
    await kickUpdateCheck(rt)
  })().catch(() => {})
}

export interface UpdateStatusPayload {
  current: string
  /** 是否配置了更新令牌（可选：公开仓库匿名即可更新；令牌=私有仓库兼容/提升限流） */
  configured: boolean
  checking: boolean
  lastCheckedAt: number | null
  lastError: string | null
  latest: string | null
  available: boolean
  /** available 时的更新说明（已降级为纯文本：去 markdown 标记、保留标题与条目结构） */
  notes: string | null
  /** available 时的说明摘要（首段+要点，同 CLI 检查输出；给原生小窗用，全文仍是 notes） */
  summary: string | null
  /** available 时的发布页地址（GitHub Release），供界面「查看完整说明」外链 */
  htmlUrl: string | null
  /** available 时本机适配安装包体积（字节；找不到适配资产为 null），供界面显示 MB */
  sizeBytes: number | null
  /** 一键更新失败原因（更新子进程已退出而网关未重启；null = 无进行中的失败） */
  applyError: string | null
  /** `update --yes` 子进程写下的阶段进度（无进行中的更新 / 文件缺失或残留过期 = null） */
  progress: UpdateProgress | null
}

/** 本机适配安装包的体积（字节）：按安装形态与架构选资产名；选不到返回 null */
function matchedAssetSize(m: ReleaseManifest): number | null {
  // 第三参必须显式传 LOCALAPPDATA（同 run.ts）：漏传真机永远判 win-bare，资产体积基线选错；
  // 第四参带卸载器指纹（同 run.ts）：安装器装在自定义目录时按 win-setup 选包，界面体积与实际更新一致
  const shape = detectInstallShape(
    process.execPath,
    process.platform,
    process.env.LOCALAPPDATA,
    process.platform === 'win32' ? hasWindowsUninstaller(process.execPath) : false
  )
  const name = selectAssetName(shape, process.platform, process.arch, m.version)
  return name ? findAsset(m, name)?.size ?? null : null
}

export async function getUpdateStatus(rt: GatewayRuntime): Promise<UpdateStatusPayload> {
  const resolved = await resolveTokenAndRepo(rt.config)
  const latest = state.manifest?.version ?? null
  const available = !!(latest && compareVersions(latest, VERSION) > 0)
  // 说明在这里降级一次：控制台的更新卡片是纯文本框（不引 markdown 渲染器），标记裸露会很难看。
  // 卡片刻意给「全文纯文本」而非摘要——它是三个面里的详情视图（有滚动框），
  // 摘要收口只用在命令行与原生弹窗（见 run.ts 的 logReleaseNotes）
  const notes = available && state.manifest?.notes ? notesToPlain(state.manifest.notes).trim() : ''
  return {
    current: VERSION,
    configured: !!resolved?.token,
    checking: state.checking,
    lastCheckedAt: state.lastCheckedAt,
    lastError: state.lastError,
    latest,
    available,
    notes: notes || null,
    // 原生小窗（Windows 托盘）放全文会变成一面墙的长段落，摘要与 CLI 检查输出同源同形（notesSummaryText）
    summary: available && state.manifest?.notes ? notesSummaryText(state.manifest.notes) : null,
    // 空串收敛成 null：发布缺 html_url 时上游给的是空串，界面按「有无链接」判断
    htmlUrl: available ? state.manifest?.htmlUrl || null : null,
    sizeBytes: available ? state.manifest?.sizeBytes ?? null : null,
    applyError: state.applyError,
    progress: await readUpdateProgress(),
  }
}

export interface ApplyResult {
  started: boolean
  /** no_update = 没有可安装的新版本；in_progress = 更新已在进行；failed = 启动阶段同步失败（updating 已复位，可重试） */
  reason?: 'no_update' | 'in_progress' | 'failed'
  latest?: string
}

/** 一键更新：校验有可用新版后分离 spawn `update --yes`，立即返回。网关稍后被子进程停掉、换包、拉起。
 *  argv 由调用方传（server.ts 用 autostart 的 updateDaemonArgs() 推导）——本模块不静态依赖 autostart，
 *  避免单测整模块 mock 与共享模块注册表叠加时击穿静态绑定。 */
export function applyUpdate(
  rt: GatewayRuntime,
  opts: { argv: string[]; latest?: string; spawner?: (argv: string[], logFile: string) => void; watchDelayMs?: number } = { argv: [] }
): ApplyResult {
  void rt
  const latest = opts.latest ?? state.manifest?.version ?? null
  if (!latest || compareVersions(latest, VERSION) <= 0) return { started: false, reason: 'no_update' }
  if (state.updating) return { started: false, reason: 'in_progress' }
  state.updating = true
  state.applyError = null
  try {
    const argv = opts.argv
    // 子进程输出落日志：更新过程跨网关死亡，页面看不到的错误要能从文件里查
    fs.mkdirSync(logsDir(), { recursive: true })
    const logFile = path.join(logsDir(), `update-${localDateStr()}.log`)
    if (opts.spawner) {
      opts.spawner(argv, logFile)
    } else {
      const fd = fs.openSync(logFile, 'a')
      try {
        const child = spawn(argv[0], argv.slice(1), {
          detached: true,
          stdio: ['ignore', fd, fd],
          env: process.env,
          windowsHide: true,
        })
        watchApplyChild(child, logFile, { delayMs: opts.watchDelayMs })
        child.unref()
      } finally {
        fs.closeSync(fd)
      }
    }
  } catch (e) {
    // 门闩后的同步失败（日志目录建不出/日志文件被占 EBUSY/spawn 同步抛）必须复位 updating——
    // 否则 state.updating 永久卡 true，之后所有一键更新都返回 in_progress，只能重启网关（评测集审出）
    state.updating = false
    state.applyError = (e as Error).message
    return { started: false, reason: 'failed' }
  }
  return { started: true, latest }
}

/** 子进程退出而本网关还活着 = 更新失败（成功路径里网关会先被停掉，看不到它的退出）。
 *  延迟 watching：给「正在停网关」的成功路径留出死亡窗口，避免把成功误判为失败。
 *  spawn 失败（ENOENT/EACCES…）Node 不保证发 exit——只发 error：error 视为立即失败，
 *  否则 updating 永久卡 true、后续 apply 全返回 in_progress；settled 防 exit+error 双触发。 */
export function watchApplyChild(
  child: { on: (event: string, cb: (...args: unknown[]) => void) => void },
  logFile: string,
  opts: { delayMs?: number } = {}
): void {
  let settled = false
  child.on('exit', () => {
    if (settled) return
    settled = true
    setTimeout(() => markApplyFailed(logFile), opts.delayMs ?? 3000)
  })
  child.on('error', () => {
    if (settled) return
    settled = true
    markApplyFailed(logFile)
  })
}

function markApplyFailed(logFile: string): void {
  if (!state.updating) return
  state.updating = false
  state.applyError = tailErrorLine(logFile) ?? t('更新子进程已退出，但网关未被替换——详见 {logs} 下的 update 日志', 'The updater subprocess exited without replacing the gateway — see the update log under {logs}', { logs: displayPath(logsDir()) })
}

/** 取更新日志最后一条非空行作为失败原因（CLI 报错以「✗ 」开头，剥掉前缀）。
 *  只读文件尾部固定窗口：下载重试输出叠加时日志可达 MB 级，整读纯属浪费——最后一条非空行
 *  必然落在尾部，窗口首行可能被截半（属更旧的行，直接丢弃不影响结果）。 */
const TAIL_WINDOW_BYTES = 64 * 1024
function tailErrorLine(logFile: string): string | null {
  try {
    const fd = fs.openSync(logFile, 'r')
    try {
      const size = fs.fstatSync(fd).size
      const start = Math.max(0, size - TAIL_WINDOW_BYTES)
      const buf = Buffer.alloc(size - start)
      fs.readSync(fd, buf, 0, buf.length, start)
      const lines = buf.toString('utf8').split('\n').map((l) => l.trim()).filter(Boolean)
      const last = lines[lines.length - 1]
      return last ? last.replace(/^✗\s*/, '') : null
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return null
  }
}
