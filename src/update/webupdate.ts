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
import { readGatewayState, writeGatewayState, type GatewayRuntime } from '../gateway/state.js'
import { logsDir } from '../util/paths.js'
import { localDateStr, t } from '../util/index.js'
import { compareVersions, fetchLatestRelease, findAsset, selectAssetName, type ReleaseManifest } from './check.js'
import { detectInstallShape } from './install.js'
import { notesToPlain } from './notes.js'

const CHECK_TTL_MS = 24 * 3600_000

interface UpdateWebState {
  checking: boolean
  lastCheckedAt: number | null
  lastError: string | null
  /** 最近一次成功检查的最新版本与说明（可用性按 available 现算，不落旧态）；sizeBytes = 本机适配安装包体积（找不到适配资产为 null） */
  manifest: { version: string; notes: string; htmlUrl: string; sizeBytes: number | null } | null
  updating: boolean
  /** 一键更新失败原因（子进程退出而网关未重启 = 失败；成功路径里网关先死，观察不到退出） */
  applyError: string | null
}

const state: UpdateWebState = { checking: false, lastCheckedAt: null, lastError: null, manifest: null, updating: false, applyError: null }
let inflight: Promise<void> | null = null
/** 测试注入：本地 mock API 基地址（null = 官方 https://api.github.com） */
let apiBaseOverride: string | null = null
/** 测试注入：替换底层拉取函数（单测并发防重入时用桩计数） */
let fetchOverride: ((repo: string, token: string | null, apiBase?: string) => Promise<ReleaseManifest>) | null = null

/** 测试专用：注入更新检查的 API 基地址（单测用本地 http server 伪造 GitHub API） */
export function setUpdateApiBaseForTests(base: string | null): void {
  apiBaseOverride = base
}

/** 测试专用：注入底层拉取函数（null = 默认 fetchLatestRelease） */
export function setUpdateFetchForTests(fn: ((repo: string, token: string | null, apiBase?: string) => Promise<ReleaseManifest>) | null): void {
  fetchOverride = fn
}

/** 测试专用：清空模块级状态（manifest/updating/检查时间跨用例泄漏会让守卫误判） */
export function resetUpdateStateForTests(): void {
  state.checking = false
  state.lastCheckedAt = null
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
}

/** 发起一次检查：检查中 / TTL 内（未 force）静默跳过。匿名（无令牌）照常检查。不等待完成，状态经 getUpdateStatus 轮询。 */
export async function kickUpdateCheck(rt: GatewayRuntime, opts: { force?: boolean } = {}): Promise<void> {
  if (state.checking || inflight) return
  // 在任何 await 之前同步创建并占位 inflight：并发两次 kick 才能被上方 guard 挡住。
  // （此前 inflight 赋值在首个 await resolveTokenAndRepo 之后——并发调用双双穿透，双拉 GitHub 耗 rate-limit。）
  const p = (async () => {
    state.checking = true
    try {
      const resolved = await resolveTokenAndRepo(rt.config)
      if (!opts.force && state.lastCheckedAt && Date.now() - state.lastCheckedAt < CHECK_TTL_MS) return
      const fetchFn = fetchOverride ?? fetchLatestRelease
      const m = await fetchFn(resolved.repo, resolved.token, apiBaseOverride ?? resolved.apiBase)
      state.manifest = { version: m.version, notes: m.notes, htmlUrl: m.htmlUrl, sizeBytes: matchedAssetSize(m) }
      state.lastError = null
      state.lastCheckedAt = Date.now()
      await persistCheckTime(m.version)
    } catch (e) {
      // 检查失败静默（不打扰用户），但记录 lastError 供控制台手动检查时展示
      state.lastError = (e as Error).message
      state.lastCheckedAt = Date.now()
      await persistCheckTime()
    } finally {
      state.checking = false
      inflight = null
    }
  })()
  inflight = p
  await p
}

async function persistCheckTime(version?: string): Promise<void> {
  try {
    const s = await readGatewayState()
    if (s) await writeGatewayState({ ...s, update_check: { at: state.lastCheckedAt ?? Date.now(), ...(version ? { version } : {}) } })
  } catch {
    /* 持久化失败不影响主流程（内存态仍在） */
  }
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
  /** available 时的发布页地址（GitHub Release），供界面「查看完整说明」外链 */
  htmlUrl: string | null
  /** available 时本机适配安装包体积（字节；找不到适配资产为 null），供界面显示 MB */
  sizeBytes: number | null
  /** 一键更新失败原因（更新子进程已退出而网关未重启；null = 无进行中的失败） */
  applyError: string | null
}

/** 本机适配安装包的体积（字节）：按安装形态与架构选资产名；选不到返回 null */
function matchedAssetSize(m: ReleaseManifest): number | null {
  const name = selectAssetName(detectInstallShape(process.execPath, process.platform), process.platform, process.arch, m.version)
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
    // 空串收敛成 null：发布缺 html_url 时上游给的是空串，界面按「有无链接」判断
    htmlUrl: available ? state.manifest?.htmlUrl || null : null,
    sizeBytes: available ? state.manifest?.sizeBytes ?? null : null,
    applyError: state.applyError,
  }
}

export interface ApplyResult {
  started: boolean
  /** no_update = 没有可安装的新版本；in_progress = 更新已在进行 */
  reason?: 'no_update' | 'in_progress'
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
  state.applyError = tailErrorLine(logFile) ?? t('更新子进程已退出，但网关未被替换——详见 ~/.modeldock/logs/ 下的 update 日志', 'The updater subprocess exited without replacing the gateway — see the update log under ~/.modeldock/logs/')
}

/** 取更新日志最后一条非空行作为失败原因（CLI 报错以「✗ 」开头，剥掉前缀） */
function tailErrorLine(logFile: string): string | null {
  try {
    const lines = fs.readFileSync(logFile, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean)
    const last = lines[lines.length - 1]
    return last ? last.replace(/^✗\s*/, '') : null
  } catch {
    return null
  }
}
