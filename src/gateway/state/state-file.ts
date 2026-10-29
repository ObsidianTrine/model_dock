import fs from 'node:fs'
import { gatewayStatePath } from '../../util/paths.js'
import { atomicWrite } from '../../util/fsx.js'

export interface GatewayStateFile {
  pid: number
  port: number
  admin_token: string
  started_at: string
  /** 「设备记忆」凭据（锁屏一键重登用）：mdk_device cookie 的值，与令牌同文件同生命周期。
   *  上限 20 个（FIFO），多实例共享此文件故天然跨端口生效。 */
  devices?: string[]
  /** 手机简版控制台（LAN）凭据：mdklan_ 前缀，跨重启稳定（手机 cookie 不掉） */
  lan_token?: string
  /** LAN 实际监听端口（冲突顺延后回写；关闭时移除） */
  lan_port?: number
  /** 更新检查时间（24h TTL 跨网关重启有效）；version = 当时看到的最新版；failedAt = 最近一次失败检查（30min 重试退避，不占成功 TTL）。
   *  at 可选：从未成功过、只有失败记录时没有 at。 */
  update_check?: { at?: number; version?: string; failedAt?: number }
}

export async function readGatewayState(): Promise<GatewayStateFile | null> {
  try {
    const text = await fs.promises.readFile(gatewayStatePath(), 'utf8')
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** 活着的网关状态（gateway.json 存在且 pid 存活，且健康端点验明正身）。
 *  pid 会被系统复用：仅凭 pid 存活就把复用者当网关，stop 会误杀无关进程。 */
export async function gatewayLive(): Promise<GatewayStateFile | null> {
  const state = await readGatewayState()
  if (!state || !pidAlive(state.pid)) return null
  try {
    const res = await fetch(`http://127.0.0.1:${state.port}/_modeldock/health`, {
      signal: AbortSignal.timeout(1000),
    })
    if (!res.ok) return null
    const j = (await res.json()) as { started_at?: string }
    if (j.started_at && state.started_at && j.started_at !== state.started_at) return null
  } catch {
    // 进程在但健康端点不通：多半是 pid 被复用或端口被别的服务占用，按陈旧状态处理
    return null
  }
  return state
}

export async function writeGatewayState(state: GatewayStateFile): Promise<void> {
  await atomicWrite(gatewayStatePath(), JSON.stringify(state, null, 2), 0o600)
}

/** gateway.json 读-改-写的进程内串行队列。登录种设备记忆、lan_token/lan_port 回写、admin_token
 *  轮换都是 read→modify→write：atomicWrite 只保证不写坏、不保证不丢字段，浏览器登录与托盘/
 *  手机端并发写会互相覆盖（丢 devices / lan_port）。单写者即本网关进程，进程内 promise 链
 *  串行即可；fn 返回 null 表示无需写盘。 */
let gatewayStateQueue: Promise<void> = Promise.resolve()
export async function mutateGatewayState(
  fn: (state: GatewayStateFile | null) => GatewayStateFile | null
): Promise<void> {
  const run = gatewayStateQueue.then(async () => {
    const next = fn(await readGatewayState())
    if (next) await writeGatewayState(next)
  })
  gatewayStateQueue = run.catch(() => {})
  await run
}

export async function clearGatewayState(): Promise<void> {
  await fs.promises.rm(gatewayStatePath(), { force: true }).catch(() => {})
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
