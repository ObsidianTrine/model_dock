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

/** 拉起托盘（best-effort）：托盘内部单实例（mac flock / win Mutex）。注入
 *  MODELRDOCK_TRAY_AUTOSPAWN=1 告知托盘「本次为程序拉起（守护补拉 / cli.ts launchGui），不是用户
 *  双击」——win 托盘抢不到单实例时会把这次拉起当双击自动弹控制台（_autoOpened 守卫是进程内的，
 *  跨进程无效），v1.3.0 安装链「[Run] 托盘 → 守护 → 补拉托盘」因此把控制台弹两份（2026-10 报障）；
 *  带标记的托盘进程一律不自动弹、抢不到单实例即静默退出（控制台由调用方或用户手点负责）。
 *  spawn 失败吞掉——托盘非关键路径，不能拖垮 daemon */
export function spawnTrayIfPresent(opts: { execPath?: string; spawnFn?: typeof spawn } = {}): void {
  const trayPath = trayBinaryPath(opts.execPath)
  if (!trayPath) return
  const spawnFn = opts.spawnFn ?? spawn
  spawnFn(trayPath, [], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, MODELRDOCK_TRAY_AUTOSPAWN: '1' },
    windowsHide: true,
  })
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
