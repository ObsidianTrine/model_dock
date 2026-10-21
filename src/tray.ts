import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { gatewayLive } from './gateway/state.js'

/** 托盘拉起。打包形态托盘二进制随 app 分发在主程序旁（mac `ModelDockTray` / win `ModelDockTray.exe`），
 *  npm / dev 形态没有，按「文件是否存在」决定是否拉起。
 *  开机自启（Windows VBS / LaunchAgent / systemd）只登记网关 daemon（autostart.ts 的
 *  gatewayDaemonArgs），daemon 就绪后由 spawnTrayWhenGatewayReady() 在此补拉——这是自启场景
 *  托盘唯一的拉起点（双击场景由 cli.ts launchGui 自己拉，daemon 再拉会被托盘单实例挡掉）。 */

/** 托盘二进制路径：execPath（缺省当前进程）旁存在才返回，否则 null */
export function trayBinaryPath(execPath = process.execPath): string | null {
  const p = path.join(path.dirname(execPath), 'ModelDockTray' + (process.platform === 'win32' ? '.exe' : ''))
  return fs.existsSync(p) ? p : null
}

/** 拉起托盘（best-effort）：托盘内部单实例（mac flock / win Mutex），重复拉起静默退出无副作用；
 *  spawn 失败吞掉——托盘非关键路径，不能拖垮 daemon */
export function spawnTrayIfPresent(opts: { execPath?: string; spawnFn?: typeof spawn } = {}): void {
  const trayPath = trayBinaryPath(opts.execPath)
  if (!trayPath) return
  const spawnFn = opts.spawnFn ?? spawn
  spawnFn(trayPath, [], { detached: true, stdio: 'ignore', env: process.env, windowsHide: true })
    .on('error', () => {})
    .unref()
}

/** 网关就绪后补拉托盘（daemon `--sea-gateway` 入口用，fire-and-forget）。
 *  必须等 gateway.json 落盘（gatewayLive 校验通过）才拉：Windows 托盘首启自带 EnsureGateway，
 *  若在 daemon 启动中途拉起，托盘读到状态缺失会再拉第二个 daemon，与启动中的实例抢端口、
 *  互写 gateway.json。超时放弃（daemon 没能就绪时用户面对的是网关故障，不是缺托盘）。 */
export async function spawnTrayWhenGatewayReady(opts: {
  execPath?: string
  spawnFn?: typeof spawn
  probe?: () => Promise<boolean>
  timeoutMs?: number
} = {}): Promise<void> {
  const probe = opts.probe ?? (async () => (await gatewayLive()) != null)
  const deadline = Date.now() + (opts.timeoutMs ?? 30_000)
  for (;;) {
    if (await probe()) break
    if (Date.now() > deadline) return
    await new Promise((r) => setTimeout(r, 500))
  }
  spawnTrayIfPresent({ execPath: opts.execPath, spawnFn: opts.spawnFn })
}
