/** 配置包域：offer/import/export/discover/approve 端点（由 server.ts 拆出，T05，纯搬移零改写）。块序 = 原文件相对次序，未重排未删改。 */
import { AdminCtx, jsonRequestBody, persistConfig, sendError } from './admin-shared.js'
import { collectSyncdoc } from '../sync/collect.js'
import { openEnvelope, sealEnvelope } from '../sync/crypto.js'
import { applyImportedDoc, assertExportable, exportFileName, reportOfDoc } from '../sync/exportImport.js'
import { fetchEnvelopeFromUrl } from './shared.js'
import { clearSyncRequest, createSyncOffer, peekSyncRequest, putSyncGrant } from './lan.js'
import { discoverPeers } from './discover.js'
import { putSyncTicket, takeSyncTicket } from './remote-device.js'
import { validateSyncdoc, type Syncdoc } from '../sync/types.js'
import { invalidateOverviewCache } from './overview-view.js'
import os from 'node:os'
import { bi, t } from '../util/i18n.js'
import { reloadRuntime, type GatewayRuntime } from './state.js'
export async function hSyncOffer(c: AdminCtx): Promise<void> {
  const { rt, res, audit } = c
  // 同网直拉迁移（A 机）：生成一次性链接（口令藏 fragment，10 分钟有效、取走即焚）
  try {
    const r = await createSyncOffer(rt)
    audit(bi('分享配置到附近电脑', 'Share config nearby'), bi('已生成直拉链接', 'pull link created'))
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, ...r }))
  } catch (e) {
    audit(bi('分享配置到附近电脑', 'Share config nearby'), '-', undefined, (e as Error).message)
    sendError(res, 400, (e as Error).message)
  }
  return
}

export async function hSyncImport(c: AdminCtx): Promise<void> {
  const { rt, req, res, audit } = c
  // 同网直拉迁移（B 机）：apply 一键应用（url/file 直发，或附近直拉链路的 ticket）；preview（→ 票据）保留给 API 兼容。
  // 审计只记 phase 与来源形态，绝不记 URL（查询串含 token）与口令
  const b = await jsonRequestBody(req)
  const phase = b.phase === 'apply' ? 'apply' : 'preview'
  const source = (b.source ?? {}) as Record<string, unknown>
  const srcKind = typeof source.kind === 'string' ? source.kind : ''
  const resolveDoc = async (): Promise<{ doc: ReturnType<typeof validateSyncdoc>; env: unknown }> => {
    const passphrase = typeof source.passphrase === 'string' ? source.passphrase : ''
    let envText = ''
    if (srcKind === 'url') {
      envText = await fetchEnvelopeFromUrl(typeof source.url === 'string' ? source.url : '')
    } else if (srcKind === 'file') {
      envText = typeof source.file === 'string' ? source.file : ''
      if (!envText) throw new Error(t('缺少配置包内容', 'Missing package content'))
    } else {
      throw new Error(t('来源类型必须是 url 或 file', 'Source kind must be url or file'))
    }
    if (!passphrase) throw new Error(t('缺少口令（链接 #p= 后段，或导出时设置的口令）', 'Missing passphrase (the #p= part of the link, or the one set at export)'))
    let env: unknown
    try {
      env = JSON.parse(envText)
    } catch {
      throw new Error(t('不是合法的配置包（JSON 解析失败）', 'Not a valid sync package (JSON parse failed)'))
    }
    return { doc: validateSyncdoc(openEnvelope(env, passphrase)), env }
  }
  try {
    if (phase === 'apply') {
      const ticket = typeof source.ticket === 'string' ? source.ticket : ''
      const doc = ticket ? takeSyncTicket(ticket) : (await resolveDoc()).doc
      const report = await applyImportedDoc(doc)
      await reloadRuntime(rt)
      audit(bi('配置直拉导入', 'Config pull import'), phase, bi(ticket ? 'ticket' : srcKind, ticket ? 'ticket' : srcKind))
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, phase, report }))
    } else {
      const { doc, env } = await resolveDoc()
      const metaEnv = env as Record<string, unknown>
      const ticket = putSyncTicket(doc)
      audit(bi('配置直拉导入', 'Config pull import'), phase, bi(srcKind, srcKind))
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        ok: true,
        phase,
        ticket,
        report: reportOfDoc(doc),
        meta: { createdBy: String(metaEnv.created_by ?? ''), createdAt: String(metaEnv.created_at ?? '') },
      }))
    }
  } catch (e) {
    audit(bi('配置直拉导入', 'Config pull import'), phase, bi(srcKind || '-', srcKind || '-'), (e as Error).message)
    sendError(res, 400, (e as Error).message)
  }
  return
}

export async function hConfigExport(c: AdminCtx): Promise<void> {
  const { req, res, audit } = c
  // 导出加密配置包（.msync）：与 /m 导出、CLI config export 同一数据链路（密文出机器，口令保护）。
  // 响应走 JSON 由前端存盘下载；审计只记结果，不记口令
  const b = await jsonRequestBody(req)
  const passphrase = typeof b.passphrase === 'string' ? b.passphrase : ''
  try {
    if (!passphrase) throw new Error(t('口令不能为空', 'Passphrase must not be empty'))
    const { doc, report } = await collectSyncdoc()
    assertExportable(report)
    const env = sealEnvelope(doc, passphrase)
    const name = exportFileName()
    audit(bi('导出配置包', 'Export config package'), name, bi('已生成', 'created'))
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, envelope: env, filename: name }))
  } catch (e) {
    audit(bi('导出配置包', 'Export config package'), '-', undefined, (e as Error).message)
    sendError(res, 400, (e as Error).message)
  }
  return
}

export async function hSyncDiscover(c: AdminCtx): Promise<void> {
  const { rt, res } = c
  // 搜寻附近运行 ModelDock 且开启手机远程的电脑（UDP 广播，1.5s 收集；排除自己）
  try {
    const peers = await discoverPeers({ timeoutMs: 1500, exclude: { name: os.hostname(), port: rt.lan?.port } })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, peers }))
  } catch (e) {
    sendError(res, 400, (e as Error).message)
  }
  return
}

export async function hSyncOfferApprove(c: AdminCtx): Promise<void> {
  const { rt, req, res, audit } = c
  // A 机裁决（桌面确认卡）：approve=true 生成一次性直拉链接写入 grant（对方凭 nonce 取走即焚）；
  // approve=false 写拒绝标记让对方立即结束等待
  const b = await jsonRequestBody(req)
  const nonce = typeof b.nonce === 'string' ? b.nonce : ''
  const approve = b.approve === true
  try {
    const pending = peekSyncRequest()
    if (!pending || pending.nonce !== nonce) throw new Error(t('请求不存在或已过期', 'Request not found or expired'))
    if (approve) {
      const offer = await createSyncOffer(rt)
      putSyncGrant(nonce, { url: offer.urls[0], passphrase: offer.passphrase })
      audit(bi('附近配置直拉', 'Nearby config pull'), bi('已允许', 'approved'), bi(pending.from, pending.from))
    } else {
      putSyncGrant(nonce, { denied: true })
      audit(bi('附近配置直拉', 'Nearby config pull'), bi('已拒绝', 'denied'), bi(pending.from, pending.from))
    }
    clearSyncRequest()
    invalidateOverviewCache() // 确认卡即时消失（overview 有 6s TTL 缓存）
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
  } catch (e) {
    audit(bi('附近配置直拉', 'Nearby config pull'), approve ? bi('已允许', 'approved') : bi('已拒绝', 'denied'), bi('-', '-'), (e as Error).message)
    sendError(res, 400, (e as Error).message)
  }
  return
}

