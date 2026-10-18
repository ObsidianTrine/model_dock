/**
 * 更新跨进程互斥锁（update.lock）：托盘 / Web 控制台 / 手动 CLI 三条入口都能发起
 * `modeldock update --yes`，并发更新会互相停网关、互相替换安装位置，还会按各自的
 * 陈旧文件偏移把同一份日志写花。'wx' 独占创建 + pid 探活 + 启动时间兜底：
 * 进程崩溃残留的陈锁可被接管，持有者存活时给出可操作报错。
 */
import fs from 'node:fs'
import path from 'node:path'
import { modeldockDir } from '../util/paths.js'
import { t } from '../util/i18n.js'
import { UpdateError } from './check.js'

/** 锁超过这个时长视为陈锁（交互确认可以挂很久，取 1 小时） */
const STALE_MS = 60 * 60_000
/** 接管/验证的尝试上限，防极端竞态下的死循环 */
const MAX_ATTEMPTS = 3

interface LockBody {
  pid: number
  startedAt: string
}

export function updateLockPath(): string {
  return path.join(modeldockDir(), 'update.lock')
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM' // 存在但无权发信号：视为存活
  }
}

function readHolder(p: string): LockBody | null {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as LockBody
  } catch {
    return null // 缺失/空文件/半写文件：按无持有者处理
  }
}

/**
 * 独占持有更新锁直至 release。被占用且持有者存活时抛 UpdateError（可操作指引）；
 * 持有者已死或锁超时（崩溃残留）自动接管。release 只删自己写的锁——接管竞态下
 * 文件可能已易主，误删会把别人的锁拆掉。
 */
export async function acquireUpdateLock(): Promise<() => void> {
  const p = updateLockPath()
  fs.mkdirSync(modeldockDir(), { recursive: true }) // 首次运行/新沙箱时目录可能还没建
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const fd = fs.openSync(p, 'wx')
      try {
        fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }))
      } finally {
        fs.closeSync(fd)
      }
      // 写完回读验证归属：'wx' 到 write 之间锁文件可能被陈锁接管方删换，此时自己已不是持有者
      const mine = readHolder(p)
      if (mine?.pid === process.pid) {
        let released = false
        return () => {
          if (released) return
          released = true
          const cur = readHolder(p)
          if (cur?.pid !== process.pid) return // 已易主（接管竞态）：不动别人的锁
          try {
            fs.unlinkSync(p)
          } catch {
            /* 已被清理：无需处理 */
          }
        }
      }
      continue // 丢了（被接管方换锁）：重试一轮
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
      const holder = readHolder(p)
      const fresh = holder ? Date.now() - Date.parse(holder.startedAt) < STALE_MS : false
      const stale = !holder || !holder.pid || !processAlive(holder.pid) || !fresh
      if (!stale) {
        throw new UpdateError(
          t(
            '另一个更新进程正在运行（pid {pid}，{time} 启动）。请等它完成后再试；若确认没有更新在跑，删除 {p} 后重试',
            'Another update is already running (pid {pid}, started at {time}). Wait for it to finish; if no update is running, delete {p} and retry',
            { pid: String(holder!.pid), time: holder!.startedAt, p }
          )
        )
      }
      // 陈锁（进程已死 / 超时 / 内容损坏）：接管
      try {
        fs.unlinkSync(p)
      } catch {
        /* 竞态：对方刚删或刚换新锁，下一轮重试 */
      }
    }
  }
  throw new UpdateError(
    t(
      '更新启动冲突：无法取得更新锁（{p}），请稍后重试',
      'Update conflict: could not acquire the update lock ({p}); please retry shortly',
      { p }
    )
  )
}
