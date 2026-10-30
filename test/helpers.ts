import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { closeAppendStreams } from '../src/util/fsx.js'

// os.tmpdir() 在部分 Windows 机器返回 8.3 短名路径（如 ZHOUQI~1）：网关热加载 / 同步引擎的
// fs.watch(modeldockDir) 在该目录收到文件事件时踩 libuv fs-event 断言（assert
// !_wcsnicmp(filename, dir, dirlen)），整个进程原生崩溃（0xC0000409 fast-fail）——被测网关
// 子进程与测试 fork 都会中招（2026-10-21 本机实测：daemon-lifecycle 篡改纵深用例 exit 0xC0000409、
// synctarget SyncLoop worker 死亡；CI temp 无短名所以不现形）。native realpath 走
// GetFinalPathNameByHandle 把短名展开为长路径；普通 realpathSync 不展开。测试沙箱一律用它打底。
export const TEST_TMP = fs.realpathSync.native(os.tmpdir())

/** 仓库根（test/ 上一级）：子进程端到端配方定位 src/cli.ts 与 package.json 用 */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** tsx 的 ESM loader URL：经 node --import 直跑 .ts 源码，免 shell、三平台一致。
 *  用法见 AGENTS.md「vitest 隔离模型」：扇出广的模块同进程测试是雷区，CLI 行为走
 *  spawnSync(process.execPath, ['--import', TSX_LOADER, CLI_ENTRY, ...]) 子进程 + 独立沙箱。 */
export const TSX_LOADER = pathToFileURL(createRequire(path.join(REPO_ROOT, 'package.json')).resolve('tsx/esm')).href

/**
 * 清理历史测试进程崩溃/被强杀时留下的 modeldock-test-* 残骸（restore 未执行）。
 * 只删超过 24 小时的：新残骸可能是并发测试进程的活跃目录，绝不能碰。
 * 这些残骸若不清理，会被系统的 Temp 清理工具（实测 WorkBuddy 的 safe-delete）成批移进回收站，
 * 用户会在回收站里反复看到 .modeldock/.claude 等文件夹。
 */
function sweepStaleFakeHomes(): void {
  try {
    const cutoff = Date.now() - 24 * 3600_000
    for (const e of fs.readdirSync(TEST_TMP)) {
      if (!e.startsWith('modeldock-test-')) continue
      const p = path.join(TEST_TMP, e)
      try {
        if (fs.statSync(p).mtimeMs < cutoff) fs.rmSync(p, { recursive: true, force: true })
      } catch {
        /* 单个清理失败不影响测试 */
      }
    }
  } catch {
    /* Temp 不可读等，忽略 */
  }
}

/** 同步 sleep：Atomics.wait 阻塞当前线程但让出 CPU；libuv 线程池里的异步落盘不受影响继续跑 */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * 删临时目录，带同步重试：rmSync 与在飞的异步落盘存在竞态——网关请求/审计日志经常驻追加流
 * （fire-and-forget 异步落盘）写入 fakeHome，closeAppendStreams 关流后仍可能有最后一批缓冲
 * 在写盘，删除遍历的瞬间可能刚好新建日志文件 → ENOTEMPTY（macOS CI 实测踩中）。closeAll 已
 * 关停全部 server，在飞写盘是有限的，退避等待片刻必然静止，重删即成功。重试上限约 2 秒，
 * 仍失败则抛原始错误。
 */
function rmRfWithRetry(p: string): void {
  const backoffMs = [10, 50, 100, 250, 500, 1000]
  for (let i = 0; ; i++) {
    try {
      fs.rmSync(p, { recursive: true, force: true })
      return
    } catch (e) {
      const retriable = typeof e === 'object' && e !== null && ['ENOTEMPTY', 'EBUSY', 'EPERM', 'EACCES'].includes((e as NodeJS.ErrnoException).code ?? '')
      if (!retriable || i >= backoffMs.length) throw e
      sleepSync(backoffMs[i])
    }
  }
}

/** 轮询等待：条件一真立即返回；超时抛 'waitFor timeout'。取代「N 次 × sleep」循环——
 *  步进可调（条件出现到被感知的延迟 = stepMs），且超时可设到全局 testTimeout 之下，
 *  worst-case 拿到净超时失败而非被 harness 击杀。 */
export async function waitFor(fn: () => Promise<boolean> | boolean, timeoutMs = 5000, stepMs = 25): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return
    await new Promise((r) => setTimeout(r, stepMs))
  }
  throw new Error('waitFor timeout')
}

// 持久多 home 沙箱三件套：fakeHome.restore 会删目录且是全局 env 单值——与「A 改 → 切 B →
// B 改 → 切回 A」的交错循环冲突（多 home 需要目录存活到文件收尾）。本仓库 vitest 是
// isolate:false + 单 worker（所有文件共用一个进程与 process.env）：newHome 首次调用时捕获
// 进场前 env 原值，文件收尾必须 restoreHomes 恢复原值（不能 delete 留空），否则后续文件
// 会写到真实 home。
const multiHomeDirs: string[] = []
const multiHomePrev: { fake?: string; md?: string } = {}
export function newHome(): string {
  if (multiHomeDirs.length === 0) {
    multiHomePrev.fake = process.env.MODELRDOCK_FAKE_HOME
    multiHomePrev.md = process.env.MODELRDOCK_HOME
  }
  const h = fs.mkdtempSync(path.join(TEST_TMP, 'modeldock-test-'))
  multiHomeDirs.push(h)
  gotoHome(h)
  return h
}
export function gotoHome(h: string): void {
  process.env.MODELRDOCK_FAKE_HOME = h
  delete process.env.MODELRDOCK_HOME
}
export async function restoreHomes(): Promise<void> {
  if (multiHomePrev.fake === undefined) delete process.env.MODELRDOCK_FAKE_HOME
  else process.env.MODELRDOCK_FAKE_HOME = multiHomePrev.fake
  if (multiHomePrev.md === undefined) delete process.env.MODELRDOCK_HOME
  else process.env.MODELRDOCK_HOME = multiHomePrev.md
  for (const d of multiHomeDirs.splice(0)) await fs.promises.rm(d, { recursive: true, force: true }).catch(() => {})
}

/** 临时假 HOME（隔离真实机器配置）；用完必须 restore */
export function fakeHome(): { home: string; restore: () => void } {
  sweepStaleFakeHomes()
  const home = fs.mkdtempSync(path.join(TEST_TMP, 'modeldock-test-'))
  const prevFake = process.env.MODELRDOCK_FAKE_HOME
  const prevMdHome = process.env.MODELRDOCK_HOME
  process.env.MODELRDOCK_FAKE_HOME = home
  delete process.env.MODELRDOCK_HOME
  return {
    home,
    restore: () => {
      // 常驻日志追加流的 fd 指向本目录：先关流再删目录，Windows 上目录内有本进程未关 fd 会 EBUSY
      closeAppendStreams()
      if (prevFake === undefined) delete process.env.MODELRDOCK_FAKE_HOME
      else process.env.MODELRDOCK_FAKE_HOME = prevFake
      if (prevMdHome === undefined) delete process.env.MODELRDOCK_HOME
      else process.env.MODELRDOCK_HOME = prevMdHome
      rmRfWithRetry(home)
    },
  }
}
