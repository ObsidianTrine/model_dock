/** 更新面板域：status/check/apply 端点（由 server.ts 拆出，T05，纯搬移零改写）。块序 = 原文件相对次序，未重排未删改。 */
import { AdminCtx, sendError } from './admin-shared.js'
import { applyUpdate, getUpdateStatus, kickUpdateCheck } from '../update/webupdate.js'
import { updateDaemonArgs } from '../autostart.js'
import { engineWarningHint, installChildEnv } from '../install/noderuntime.js'
import { bi, t } from '../util/i18n.js'
import { randomToken } from '../util/fsx.js'
import { mutateGatewayState, type GatewayRuntime } from './state.js'
// 一键更新（M2）：admin 门内；apply 只负责分离 spawn，安装由子进程完成
export async function hUpdateStatus(c: AdminCtx): Promise<void> {
  const { rt, res } = c
  // 惰性周期重查：控制台每 60s 轮询一次状态，顺带触发一次检查——
  // kick 内部有 成功 24h TTL / 失败 30min 退避 双守卫，命中即静默跳过，
  // 常驻网关因此不必重启也能在控制台开着时发现新版本（此前只在启动时查一次）
  void kickUpdateCheck(rt).catch(() => {})
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify(await getUpdateStatus(rt)))
  return
}

export async function hUpdateCheck(c: AdminCtx): Promise<void> {
  const { rt, res } = c
  // 立即返回，页面轮询 status 取结果（GitHub 检查可能十几秒，不占请求）
  void kickUpdateCheck(rt, { force: true }).catch(() => {})
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ ok: true }))
  return
}

export async function hUpdateApply(c: AdminCtx): Promise<void> {
  const { rt, res, audit } = c
  const r = applyUpdate(rt, { argv: updateDaemonArgs() })
  if (r.started) {
    audit(bi('一键更新', 'One-click update'), '-', bi('开始更新到 v{v}，网关将短暂中断', 'Updating to v{v}; the gateway restarts briefly', { v: r.latest ?? '?' }))
  } else {
    const reasonZh = r.reason === 'in_progress' ? '更新已在进行中' : '没有可安装的新版本'
    const reasonEn = r.reason === 'in_progress' ? 'an update is already in progress' : 'no new version to install'
    audit(bi('一键更新', 'One-click update'), '-', bi('未执行：{r}', 'Not started: {r}', { r: bi(reasonZh, reasonEn) }))
  }
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ ok: r.started, ...r }))
  return
}

