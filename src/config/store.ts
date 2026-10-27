import path from 'node:path'
import { parse as tomlParse, stringify as tomlStringify } from 'smol-toml'
import { configPath } from '../util/paths.js'
import { atomicWrite, readTextIfExists, withFileLock } from '../util/fsx.js'
import { t } from '../util/i18n.js'
import { CONFIG_VERSION, emptyConfig, type Config, type Lang } from './types.js'

export class ConfigError extends Error {
  constructor(msg: string) {
    super(msg)
    this.name = 'ConfigError'
  }
}

function migrate(raw: Record<string, unknown>): Config {
  // 版本迁移器：version 逐级升级，当前仅 v1
  const version = Number(raw.version ?? 1)
  if (version > CONFIG_VERSION) {
    throw new ConfigError(
      t('config.toml 的 version={v} 高于当前工具支持的 {max}，请先升级 modeldock', 'config.toml version is {v}, newer than the supported {max}; upgrade modeldock first', { v: version, max: CONFIG_VERSION })
    )
  }
  let language: Lang | undefined
  if (raw.language !== undefined && raw.language !== null && raw.language !== '') {
    if (raw.language !== 'zh' && raw.language !== 'en') {
      throw new ConfigError(
        t(
          'config.toml 的 language 只能是 "zh" 或 "en"（当前值：{v}）',
          'config.toml language must be "zh" or "en" (got: {v})',
          { v: String(raw.language) }
        )
      )
    }
    language = raw.language
  }
  const cfg: Config = {
    version: CONFIG_VERSION,
    language,
    active_profile: raw.active_profile as string | undefined,
    providers: containerOrEmpty(raw.providers, 'providers'),
    profiles: containerOrEmpty(raw.profiles, 'profiles'),
    harness: containerOrEmpty(raw.harness, 'harness'),
    adapter_packs: raw.adapter_packs as Config['adapter_packs'],
    gateway: normalizeGateway(normalizable(raw.gateway, 'gateway')),
    lan: normalizable(raw.lan, 'lan'),
    security: normalizable(raw.security, 'security'),
    backup: normalizable(raw.backup, 'backup'),
    update: normalizable(raw.update, 'update'),
    import: normalizable(raw.import, 'import'),
  }
  return cfg
}

/** 容器键形状守卫：手写 TOML 合法但形状错（如 `providers = 5`）时，`as` 断言会原样放行、
 *  下游 Object.entries 抛原始 TypeError。这里显式拦下给可操作 ConfigError（含键名）。 */
function containerOrEmpty<T extends object>(v: unknown, key: string): T {
  if (v === undefined || v === null) return {} as T
  if (typeof v !== 'object' || Array.isArray(v)) {
    throw new ConfigError(
      t('config.toml 的 [{key}] 必须是表（当前是{kind}）。请把该项改为 `[providers.x]` 形态的表，或删除该行恢复默认',
        'config.toml [{key}] must be a table (got {kind}). Change it to a table like `[providers.x]`, or remove the line to use defaults',
        { key, kind: Array.isArray(v) ? '数组/array' : typeof v })
    )
  }
  return v as T
}

/** 可选对象键形状守卫：非 undefined/null 时必须是对象（标量/数组直接给 ConfigError） */
function normalizable<T extends object>(v: unknown, key: string): T | undefined {
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'object' || Array.isArray(v)) {
    throw new ConfigError(
      t('config.toml 的 [{key}] 必须是表（当前是{kind}）。请把该项改为表形态，或删除该行恢复默认',
        'config.toml [{key}] must be a table (got {kind}). Change it to a table, or remove the line to use defaults',
        { key, kind: Array.isArray(v) ? '数组/array' : typeof v })
    )
  }
  return v as T
}

/** 定时切换规范化（日类型模型，2026-10 起）：
 *  - 旧「节假日名单」退役——名单日语义由窗口 dayFilter 表达，存量 holidays 键丢弃；
 *  - 旧 days 简写迁移为 dayFilter：[1..5]→workday（节假日不生效，即「节假日不避开」的既定语义）、[6,7]→weekend；
 *    其余 days 组合（如单日、[1,3]）原样保留。幂等，仅在旧形态出现时改写。 */
function normalizeGateway(input: Config['gateway']): Config['gateway'] {
  if (!input) return input
  // tray_lite 已废弃（旧「托盘轻量模式」键，语义由轻量模式派生态取代）：读入即剥除，
  // 下次整包重写不再落回盘——下方 spread 会原样透传未知键，残留须在此显式删
  const gw = { ...input } as Record<string, unknown>
  delete gw.tray_lite
  const cfg = gw as NonNullable<Config['gateway']>
  const sch = cfg.schedule
  if (!sch) return cfg
  const windows = (sch.windows ?? []).map((w) => {
    if (w.dayFilter || !w.days?.length) return w
    const isWorkday = w.days.length === 5 && [1, 2, 3, 4, 5].every((n, i) => w.days![i] === n)
    const isWeekend = w.days.length === 2 && w.days[0] === 6 && w.days[1] === 7
    if (!isWorkday && !isWeekend) return w
    const { days: _legacy, ...rest } = w
    return { ...rest, dayFilter: isWorkday ? ('workday' as const) : ('weekend' as const) }
  })
  return { ...cfg, schedule: { ...(sch.enabled === undefined ? {} : { enabled: sch.enabled }), ...(windows.length ? { windows } : {}) } }
}

export async function loadConfig(): Promise<Config> {
  const text = await readTextIfExists(configPath())
  if (text === null || text.trim() === '') return emptyConfig()
  let raw: Record<string, unknown>
  try {
    raw = tomlParse(text) as Record<string, unknown>
  } catch (e) {
    throw new ConfigError(
      t('config.toml 解析失败：{msg}\n运行 modeldock config edit 修复，或 modeldock restore 恢复备份', 'Failed to parse config.toml: {msg}\nRun modeldock config edit to fix it, or modeldock restore to restore a backup', { msg: (e as Error).message })
    )
  }
  return migrate(raw)
}

export async function saveConfig(cfg: Config): Promise<void> {
  const next = tomlStringify(cfg)
  // 无变化跳写（PERF-14 残余收口）：序列化结果与磁盘现值逐字节一致时不落盘——mutateConfig
  // 读-改-写后 fn 零改动、或同值重写（控制台轮询保存等）不再产生整包写 + tmp/rename 换新
  // inode 的写放大。比较在调用方的写锁内；字节级比较让归一化首写（磁盘内容不同）语义不回退
  const cur = await readTextIfExists(configPath())
  if (cur !== null && cur === next) return
  // 版本迁移类写盘先快照（CORRECT-03）：migrate/stringify 缺陷的破坏窗口只发生在版本升级写——
  // 磁盘 version 低于当前工具版本时，把旧 config.toml 快照进 backups/config/（'config' 伪 harness，
  // 与 sync 导入前快照同址同型），写坏可经 modeldock restore config 撤销；快照失败不阻断写盘。
  const diskVersion = Number(/^version\s*\=\s*(\d+)/m.exec(cur ?? '')?.[1] ?? 0)
  if (cur !== null && cur.trim() !== '' && diskVersion < CONFIG_VERSION) {
    try {
      const { snapshot } = await import('../backup/snapshot.js')
      await snapshot('config', 'pre-migrate', [configPath()])
    } catch {
      /* 快照失败不阻断写盘：atomicWrite 的原子性仍然兜底 */
    }
  }
  await atomicWrite(configPath(), next, 0o600)
}

// 写并发控制（实现见 src/util/fsx.ts 的 withFileLock：进程内 promise 串行 + 跨进程 O_CREAT|O_EXCL 锁）
// CLI / 网关 daemon / Web 控制台是三个独立写者，都走"读文件→改内存→整文件写回"，
// 无互斥会静默丢更新。
function lockPath(): string {
  return configPath() + '.lock'
}

/** 读-改-写 便捷封装（带锁：同进程串行、跨进程互斥；fn 内不要做慢 I/O，避免长期占锁） */
export async function mutateConfig<T>(fn: (cfg: Config) => T | Promise<T>): Promise<T> {
  return withFileLock(
    lockPath(),
    {
      timeoutError: (lp) =>
        new ConfigError(
          t('配置写入超时：{lp} 被其他进程长期占用（可能是异常退出的残留锁）。确认没有其他 modeldock 进程在写配置后，可删除该 .lock 文件重试',
            'Timed out writing config: {lp} has been held by another process for too long (possibly a stale lock from a crashed process). After confirming no other modeldock process is writing the config, delete the .lock file and retry',
            { lp })
        ),
    },
    async () => {
      const cfg = await loadConfig()
      const ret = await fn(cfg)
      await saveConfig(cfg)
      return ret
    }
  )
}
