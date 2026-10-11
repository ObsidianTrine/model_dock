import fs from 'node:fs'
import path from 'node:path'
import { parse as tomlParse, stringify as tomlStringify } from 'smol-toml'
import { configPath } from '../util/paths.js'
import { atomicWrite, readTextIfExists } from '../util/fsx.js'
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
    providers: (raw.providers as Config['providers']) ?? {},
    profiles: (raw.profiles as Config['profiles']) ?? {},
    harness: (raw.harness as Config['harness']) ?? {},
    adapter_packs: raw.adapter_packs as Config['adapter_packs'],
    gateway: normalizeGateway(raw.gateway as Config['gateway']),
    lan: raw.lan as Config['lan'],
    security: raw.security as Config['security'],
    backup: raw.backup as Config['backup'],
    update: raw.update as Config['update'],
  }
  return cfg
}

/** 定时切换规范化（日类型模型，2026-10 起）：
 *  - 旧「节假日名单」退役——名单日语义由窗口 dayFilter 表达，存量 holidays 键丢弃；
 *  - 旧 days 简写迁移为 dayFilter：[1..5]→workday（节假日不生效，即「节假日不避开」的既定语义）、[6,7]→weekend；
 *    其余 days 组合（如单日、[1,3]）原样保留。幂等，仅在旧形态出现时改写。 */
function normalizeGateway(gw: Config['gateway']): Config['gateway'] {
  const sch = gw?.schedule
  if (!sch) return gw
  const windows = (sch.windows ?? []).map((w) => {
    if (w.dayFilter || !w.days?.length) return w
    const isWorkday = w.days.length === 5 && [1, 2, 3, 4, 5].every((n, i) => w.days![i] === n)
    const isWeekend = w.days.length === 2 && w.days[0] === 6 && w.days[1] === 7
    if (!isWorkday && !isWeekend) return w
    const { days: _legacy, ...rest } = w
    return { ...rest, dayFilter: isWorkday ? ('workday' as const) : ('weekend' as const) }
  })
  return { ...gw, schedule: { ...(sch.enabled === undefined ? {} : { enabled: sch.enabled }), ...(windows.length ? { windows } : {}) } }
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
  await atomicWrite(configPath(), tomlStringify(cfg), 0o600)
}

// 写并发控制
// CLI / 网关 daemon / Web 控制台是三个独立写者，都走"读文件→改内存→整文件写回"，
// 无互斥会静默丢更新。两层防护：进程内 promise 串行（同进程并发调用）+ 跨进程锁文件。

const LOCK_TIMEOUT_MS = 10_000
const LOCK_STALE_MS = 15_000 // 持锁超过该时长视为持有者已死（临界区内不应有慢 I/O），允许抢占

function lockPath(): string {
  return configPath() + '.lock'
}

/** 跨进程互斥：O_CREAT|O_EXCL 独占创建锁文件；陈旧锁抢占；超时给可操作报错 */
async function acquireLock(): Promise<() => void> {
  const lp = lockPath()
  fs.mkdirSync(path.dirname(lp), { recursive: true }) // 首次运行时 ~/.modeldock 可能还不存在
  const t0 = Date.now()
  for (;;) {
    try {
      const fd = fs.openSync(lp, 'wx')
      try {
        fs.writeSync(fd, String(process.pid))
      } finally {
        fs.closeSync(fd)
      }
      return () => {
        try {
          fs.unlinkSync(lp)
        } catch {
          /* 已被抢占/删除则忽略 */
        }
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
      try {
        const st = fs.statSync(lp)
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          fs.unlinkSync(lp)
          continue
        }
      } catch {
        /* 锁刚被释放，直接重试 */
      }
      if (Date.now() - t0 > LOCK_TIMEOUT_MS) {
        throw new ConfigError(
          t('配置写入超时：{lp} 被其他进程长期占用（可能是异常退出的残留锁）。确认没有其他 modeldock 进程在写配置后，可删除该 .lock 文件重试',
            'Timed out writing config: {lp} has been held by another process for too long (possibly a stale lock from a crashed process). After confirming no other modeldock process is writing the config, delete the .lock file and retry',
            { lp })
        )
      }
      await new Promise((r) => setTimeout(r, 50))
    }
  }
}

// 进程内串行队列
let queue: Promise<unknown> = Promise.resolve()
function serialize<T>(job: () => Promise<T>): Promise<T> {
  const next = queue.then(job, job)
  queue = next.then(
    () => undefined,
    () => undefined
  )
  return next
}

/** 读-改-写 便捷封装（带锁：同进程串行、跨进程互斥；fn 内不要做慢 I/O，避免长期占锁） */
export async function mutateConfig<T>(fn: (cfg: Config) => T | Promise<T>): Promise<T> {
  return serialize(async () => {
    const release = await acquireLock()
    try {
      const cfg = await loadConfig()
      const ret = await fn(cfg)
      await saveConfig(cfg)
      return ret
    } finally {
      release()
    }
  })
}
