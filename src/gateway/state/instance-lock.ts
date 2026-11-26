import fs from 'node:fs'
import path from 'node:path'
import { assertNotRealHomeWrite } from '../../util/fsx.js'
import { gatewayLockPath } from '../../util/paths.js'
import { localIsoTs } from '../../util/time.js'
import { pidAlive } from './state-file.js'

/** 实例锁文件内容：谁在何时以哪个端口启动。`port` 是启动时请求的端口（端口顺延前的值），
 *  只用于报错时给用户定位；判活口径是 `pid`。 */
export interface InstanceLockInfo {
  pid: number
  port: number
  acquired_at: string
}

export type InstanceLockResult =
  | { acquired: true; file: string; info: InstanceLockInfo; release: () => void }
  /** holder = 挡路的活持有者；null = 锁文件读不出有效内容且重试窗口内无法接管（磁盘故障等） */
  | { acquired: false; holder: InstanceLockInfo | null }

/** 争夺中的 errno：EEXIST 是常态（锁已存在），EBUSY/EPERM/EACCES 是 Windows 上「文件正被
 *  另一进程短暂打开」时 libuv 的映射（rename/unlink/open 都会撞）——两者同样走「读锁判活 → 重试」。 */
const CONTENDED = new Set(['EEXIST', 'EBUSY', 'EPERM', 'EACCES'])
/** 有界重试窗口（12 × 50ms ≈ 600ms）：覆盖「对手刚 O_EXCL 成功、内容还没写完」的窗口，
 *  也让 Windows 的短暂占用有机会自行消退；耗尽后仍拿不到锁就报可操作错误。 */
const MAX_ATTEMPTS = 12
const RETRY_DELAY_MS = 50

/** 读锁文件（读到什么算什么）：锁不存在 / 不可读 / 内容不是合法实例锁 → null。 */
export function readInstanceLock(): InstanceLockInfo | null {
  try {
    return parseLock(fs.readFileSync(gatewayLockPath(), 'utf8'))
  } catch {
    return null
  }
}

/** 抢占实例锁（O_EXCL 建 `gateway.lock`）。拿不到时读锁判活：
 *  - 持有者 pid 存活 → `{acquired:false, holder}`，调用方报「已在运行或正在启动」并退出；
 *  - 持有者 pid 已死 / 内容损坏（进程在写入前崩溃）→ 复核内容未变后删除并接管，重试建锁。
 *  必须由 daemon/CLI 进程自己调用（锁属主 = 本进程 pid），不要在别的模块里代为获取——
 *  属主对不上会让释放与判活都失效。 */
export async function acquireInstanceLock(port: number): Promise<InstanceLockResult> {
  const file = gatewayLockPath()
  assertNotRealHomeWrite(file) // 与 gateway.json 同目录，同受真实 home 写入门禁约束
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const info: InstanceLockInfo = { pid: process.pid, port, acquired_at: localIsoTs() }
  const text = JSON.stringify(info, null, 2) + '\n'
  let lastHolder: InstanceLockInfo | null = null
  for (let attempt = 0; attempt <= MAX_ATTEMPTS; attempt++) {
    const created = tryCreate(file, info, text)
    if (created) return created
    const raw = readRaw(file)
    const holder = raw === null ? null : parseLock(raw)
    lastHolder = holder
    // 活持有者：不再空转重试（pid 判活是唯一口径，没有心跳/陈锁计时——daemon 长活数月是常态）
    if (holder && pidAlive(holder.pid)) return { acquired: false, holder }
    // 死者残留 / 半截文件：复核内容未变再删（防误删对手刚重建的新锁），删掉后立即重试抢建
    if (raw !== null && (holder !== null || attempt >= MAX_ATTEMPTS)) {
      if (removeIfUnchanged(file, raw)) {
        // 半截文件已等满整个窗口：删完直接再抢一次，不受循环边界收尾影响
        if (attempt >= MAX_ATTEMPTS) {
          const retried = tryCreate(file, info, text)
          if (retried) return retried
        }
        continue
      }
    }
    if (attempt < MAX_ATTEMPTS) await new Promise((r) => setTimeout(r, RETRY_DELAY_MS))
  }
  return { acquired: false, holder: lastHolder }
}

/** 独占建锁（O_CREAT|O_EXCL）。争用类 errno 返回 null 交给调用方判活/重试，其余错误照抛。 */
function tryCreate(file: string, info: InstanceLockInfo, text: string): InstanceLockResult | null {
  try {
    const fd = fs.openSync(file, 'wx', 0o600)
    try {
      fs.writeSync(fd, text)
    } finally {
      fs.closeSync(fd)
    }
    return { acquired: true, file, info, release: () => releaseOwned(file, info) }
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (!code || !CONTENDED.has(code)) throw e
    return null
  }
}

function readRaw(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return null // ENOENT / 被占用：交给调用方按「未知」重试
  }
}

function parseLock(raw: string): InstanceLockInfo | null {
  try {
    const j = JSON.parse(raw) as Partial<InstanceLockInfo>
    if (typeof j.pid !== 'number' || !Number.isInteger(j.pid) || j.pid <= 0) return null
    return {
      pid: j.pid,
      port: typeof j.port === 'number' ? j.port : 0,
      acquired_at: typeof j.acquired_at === 'string' ? j.acquired_at : '',
    }
  } catch {
    return null
  }
}

/** compare-then-delete：读到的内容与判定时一致才删（两次读之间被改写/重建则放弃，避免误删新锁）。 */
function removeIfUnchanged(file: string, raw: string): boolean {
  try {
    if (fs.readFileSync(file, 'utf8') !== raw) return false
    fs.unlinkSync(file)
    return true
  } catch {
    return false
  }
}

/** 释放（同步：要能在 process 'exit' 钩子里跑）。归属校验 pid + acquired_at：锁已被接管/改写
 *  时不动别人的锁。删除失败（Windows 上被杀毒/索引短暂占用）静默——锁留着但 pid 会随进程退出
 *  死亡，下次启动按 pid 判活接管，不会永久卡死。 */
function releaseOwned(file: string, info: InstanceLockInfo): void {
  try {
    const cur = parseLock(fs.readFileSync(file, 'utf8'))
    if (!cur || cur.pid !== info.pid || cur.acquired_at !== info.acquired_at) return
    fs.unlinkSync(file)
  } catch {
    /* 已删除 / 被占用：留待下次启动接管 */
  }
}
