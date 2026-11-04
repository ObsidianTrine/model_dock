import { randomToken } from '../../util/fsx.js'
import type { Config } from '../../config/types.js'
import type { EphemeralHarnessState, GatewayRuntime } from './types.js'

export function buildTokenIndex(config: Config): Map<string, string> {
  const map = new Map<string, string>()
  for (const [id, he] of Object.entries(config.harness ?? {})) {
    if (he.token) map.set(he.token, id)
  }
  return map
}

// ===== runtime-only 临时 harness（C14 / P2⑧：headless worker 的「用完即焚」凭据）=====
// 定位：Dockmaster 给无人值守长跑 worker 供凭据，此前靠固定 tier token 走 env（永久有效直到
// 重接，泄漏收敛只有整体重接）。临时 harness 反其道：TTL 到点即焚 + 可单独吊销 + 可挂日限额。
// 不落盘：只注入 rt.config.harness / rt.tokens（纯内存）——mutateConfig 每次从盘上重读
// （loadConfig structuredClone），临时条目没有任何写回 config.toml 的路径；进程重启全部清零。

/** TTL 缺省 480 分钟（8 小时）：覆盖一个标准无人值守工作日；不够用由调用方显式加长而不是
 *  无限默认——「临时」凭据的默认寿命就该比持久 token 短一个量级。 */
export const EPHEMERAL_TTL_DEFAULT_MINUTES = 480
/** TTL 上限 1440 分钟（24 小时）：硬顶防止「临时」凭据事实上变成永久凭据（泄漏收敛靠短命）。 */
export const EPHEMERAL_TTL_MAX_MINUTES = 1440
/** TTL sweeper 节奏：60s（与熔断探活 sweeper 同频）。过期凭据最多多活一个间隔——worker
 *  凭据按分钟计精度足够，不再缩短白耗定时器。 */
export const EPHEMERAL_SWEEP_INTERVAL_MS = 60_000

export interface EphemeralHarnessInput {
  id: string
  /** 钉定 profile 名；缺省 = 跟随 active_profile */
  route?: string
  /** 生命周期分钟数（可含小数，测试注入短 TTL 用）；调用方负责先做范围校验 */
  ttlMinutes: number
  maxDailyTokens?: number
  now?: number
}

/** 签发临时 harness：登记生命周期元数据 + 把合成 HarnessEntry 注入 rt.config.harness
 *  （mode 'gateway' + route/token/limits——resolveTarget / checkTokenLimits / pickTarget 等
 *  既有链路零改动即生效）+ token 索引进 rt.tokens。返回状态（含 token 明文，调用方只在
 *  provision 响应里出现一次）。 */
export function registerEphemeralHarness(rt: GatewayRuntime, input: EphemeralHarnessInput): EphemeralHarnessState {
  const now = input.now ?? Date.now()
  const state: EphemeralHarnessState = {
    id: input.id,
    token: randomToken('mdk_eph'),
    ...(input.route ? { route: input.route } : {}),
    createdAt: now,
    expiresAt: now + Math.round(input.ttlMinutes * 60_000),
    ...(input.maxDailyTokens != null ? { maxDailyTokens: input.maxDailyTokens } : {}),
  }
  rt.ephemeral.set(input.id, state)
  applyEphemeralHarness(rt, state)
  return state
}

/** 把临时条目（重新）注入运行态：config.harness 合成条目 + token 索引。reload 后重登记与
 *  首次签发共用此路径。 */
function applyEphemeralHarness(rt: GatewayRuntime, e: EphemeralHarnessState): void {
  rt.config.harness[e.id] = {
    mode: 'gateway',
    ...(e.route ? { route: e.route } : {}),
    token: e.token,
    ...(e.maxDailyTokens != null ? { limits: { daily_tokens: e.maxDailyTokens } } : {}),
  }
  rt.tokens.set(e.token, e.id)
}

/** 吊销临时 harness（幂等）：不存在返回 false。只摘自己登记的条目——id 若已被真实 harness
 *  占用（先 provision 后 attach 同名，边角），不动 config 条目、只摘 token 索引与计数。 */
export function unregisterEphemeralHarness(rt: GatewayRuntime, id: string): boolean {
  const e = rt.ephemeral.get(id)
  if (!e) return false
  rt.ephemeral.delete(id)
  const he = rt.config.harness[id]
  if (he && he.token === e.token) delete rt.config.harness[id]
  if (rt.tokens.get(e.token) === id) rt.tokens.delete(e.token)
  rt.tokenUsage.delete(id)
  return true
}

/** TTL 清扫：摘除全部过期条目，返回被摘的 id 清单（空转零开销）。 */
export function sweepEphemeralHarnesses(rt: GatewayRuntime, now = Date.now()): string[] {
  const swept: string[] = []
  for (const [id, e] of rt.ephemeral) {
    if (e.expiresAt > now) continue
    swept.push(id)
    unregisterEphemeralHarness(rt, id)
  }
  return swept
}

/** 热加载后的重登记：reloadRuntime 整包替换 rt.config / rt.tokens，会把 runtime-only 条目冲掉
 *  （worker 凭据不该因一次配置热加载集体掉线；重启清零是另一回事，设计如此）。先扫过期，
 *  幸存者重新注入；id 已被真实 harness 占用者让位并移除（真实配置优先，临时条目自灭）。 */
export function reapplyEphemeralHarnesses(rt: GatewayRuntime, now = Date.now()): void {
  sweepEphemeralHarnesses(rt, now)
  for (const e of [...rt.ephemeral.values()]) {
    const he = rt.config.harness[e.id]
    if (he && he.token !== e.token) {
      unregisterEphemeralHarness(rt, e.id)
      continue
    }
    applyEphemeralHarness(rt, e)
  }
}

export function buildRuntime(config: Config, adminToken: string): GatewayRuntime {
  return {
    config,
    tokens: buildTokenIndex(config),
    ring: [],
    startedAt: Date.now(),
    adminToken,
    reloads: 0,
    dispatchers: new Map(),
    health: new Map(),
    tokenUsage: new Map(),
    ephemeral: new Map(),
    metricsLatency: new Map(),
    seaErrors: new Map(),
    modelProbe: { results: new Map(), inflight: new Set() },
    keyPool: { cooldown: new Map(), rr: new Map() },
  }
}

export async function reloadRuntime(rt: GatewayRuntime): Promise<void> {
  const { loadConfig } = await import('../../config/store.js')
  const { invalidateSecretsCache } = await import('../../config/secrets.js')
  // 文件 watcher 触发的 reload 会经过这里：清 file/外部后端密钥缓存，另一进程改的 key 即刻（再读盘）生效
  invalidateSecretsCache()
  rt.config = await loadConfig()
  rt.tokens = buildTokenIndex(rt.config)
  rt.reloads++
  // 释放旧的代理 dispatcher（ProxyAgent 连接）；direct 共享 Agent 是模块级单例、跨重载复用，不关
  const keep = rt.dispatchers.get('direct')
  for (const d of rt.dispatchers.values()) {
    if (d && d !== keep && typeof d.close === 'function') {
      Promise.resolve(d.close()).catch(() => {})
    }
  }
  rt.dispatchers.clear()
  // 已删除的 provider 健康条目一并清掉：长生命周期进程反复增删服务不残留（recordOutcome 只增不删）
  for (const id of rt.health.keys()) {
    if (!rt.config.providers[id]) rt.health.delete(id)
  }
  // 海况分桶与模型探测缓存同口径清理：recordOutcome / 周期探测同样只增不删
  for (const id of rt.seaErrors?.keys() ?? []) {
    if (!rt.config.providers[id]) rt.seaErrors?.delete(id)
  }
  for (const id of rt.modelProbe?.results.keys() ?? []) {
    if (!rt.config.providers[id]) rt.modelProbe?.results.delete(id)
  }
  // key 池运行态（失效冷却/轮转游标）全清：keys 配置可能已被改（换 key / 增删条目），
  // 按索引记账的冷却对新 key 不成立——人工换 key 后立即恢复轮转，无须等满 15min 冷却。
  // 内联清空而非引 state/keypool：state/ 四域模块互不引用（见本文件头拆分说明），types ← 四模块单向
  rt.keyPool.cooldown.clear()
  rt.keyPool.rr.clear()
  // 临时 harness 重登记（C14）：热加载整包替换了 config/tokens，runtime-only 的 eph 条目
  // 需重新注入（未过期者）；过期与 id 被真实条目占用者在 reapply 内自行清场
  reapplyEphemeralHarnesses(rt)
}
