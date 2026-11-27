/** 多包合并域：merge/preview 与 merge/apply 端点（provider-probe-suite 任务 11；2026-11-27 导入
 *  预览统一改造）。控制台三入口（附近的电脑/粘贴链接/配置包文件）全部走本域：
 *  · packages 形态：包文本 base64 随请求（≥1 个；文件 tab 前端持有字节，预览/应用无状态重传）；
 *  · source:{kind:'url'} 链接形态：一次性直拉链接取走即焚，预览时服务端 fetch → putSyncTicket
 *    暂存副本，响应带 stagedTicket，应用凭 ticket 取暂存（链接已焚无法二次 fetch，无状态重传走不通）；
 *  · source:{kind:'ticket'} 票据形态：附近直拉（runRemoteRequest 已暂存）与链接暂存共用——预览
 *    peekSyncTicket 非破坏读，应用成功后 consumeSyncTicket 显式消费（失败保留可重试）。
 *  追加/替换：mode='add'（默认由前端显式传）走 applySyncdocAdditive（本机现有态保留，勾选并入，
 *  碰撞按 relation 口径：id 撞名=勾选即覆盖）；mode='replace'（缺省，兼容旧调用方）走 applyImportedDoc。
 *  候选带 relation（对账本机现有 provider：id / base_url+key 指纹）。预览零写盘红线：除 url 形态
 *  的 ticket 暂存（内存 Map，非盘）外全程内存操作；应用自带快照。key 明文只在内存流转，
 *  响应与审计只出 sha256 前 8 位指纹。 */
import { AdminCtx, jsonRequestBody, sendError } from './admin-shared.js'
import { applyImportedDoc, previewImportText } from '../sync/exportImport.js'
import { applySyncdocAdditive } from '../sync/collect.js'
import { filterMergedDoc, makeVerdictFinder, mergePackages, normalizeBaseUrl, type MergeCandidate } from '../sync/merge.js'
import { validateSyncdoc, type Syncdoc } from '../sync/types.js'
import { logEvent, reloadRuntime } from './state.js'
import { invalidateOverviewCache } from './overview-view.js'
import { peekSyncTicket, consumeSyncTicket, putSyncTicket } from './remote-device.js'
import { fetchEnvelopeFromUrl } from './shared.js'
import { providerKeyRefs, resolveProviderKeys } from '../config/secrets.js'
import { keyFingerprint } from './probe/verdict.js'
import { sha256 } from '../util/fsx.js'
import { safeEqual } from '../util/safe-equal.js'
import { bi, t } from '../util/i18n.js'

interface MergePkgInput {
  name: string
  text: string
}

function isStr(x: unknown): x is string {
  return typeof x === 'string'
}

/** 请求体 → 包文本清单。msync 内容 base64 传（JSON 字符串直传会被转义/长度敏感放大），name 仅作展示与审计。
 *  口令两种形态：passphrases 数组与 packages 按索引一一对应（控制台「配置包文件」tab 逐包口令行）；
 *  单值 passphrase 向后兼容 = 全部同口令（旧客户端/直调方）。2026-11-27 起放宽为 ≥1（单包=追加预览流的常态）。 */
function pkgInputs(b: Record<string, unknown>): { inputs: MergePkgInput[]; passphrases: string[]; err?: string } {
  const raw = Array.isArray(b.packages) ? b.packages : []
  const inputs: MergePkgInput[] = []
  for (const item of raw.slice(0, 16)) {
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    const b64 = typeof o.content_b64 === 'string' ? o.content_b64 : ''
    if (!b64) return { inputs: [], passphrases: [], err: t('包缺少 content_b64（.msync 文本内容的 base64）', 'A package is missing content_b64 (base64 of the .msync text)') }
    inputs.push({ name: typeof o.name === 'string' && o.name ? o.name.slice(0, 120) : `${inputs.length + 1}.msync`, text: Buffer.from(b64, 'base64').toString('utf8') })
  }
  if (inputs.length < 1) return { inputs: [], passphrases: [], err: t('缺少包（packages 数组，每项 { name, content_b64 }）', 'Missing packages (packages array of { name, content_b64 })') }
  let passphrases: string[] = []
  if (Array.isArray(b.passphrases)) {
    passphrases = (b.passphrases as unknown[]).map((p) => (typeof p === 'string' ? p : ''))
    if (passphrases.length !== inputs.length) {
      return { inputs, passphrases: [], err: t('passphrases 数组与 packages 数量不一致（需一一对应：{n} 个包对应 {n} 条口令）', 'passphrases count does not match packages (one per package: {n} packages need {n} entries)', { n: String(inputs.length) }) }
    }
  } else if (typeof b.passphrase === 'string') {
    passphrases = inputs.map(() => b.passphrase as string)
  }
  if (passphrases.some((p) => !p)) {
    return { inputs, passphrases: [], err: t('缺少口令（passphrases 与包一一对应；或单值 passphrase = 全部同口令）', 'Missing passphrase (passphrases aligned with packages; or a single passphrase for all)') }
  }
  return { inputs, passphrases }
}

/** 逐包用自己的口令解包；任一失败 → 报错带失败包名列表（全部不通过，不出半张清单——应用是整包替换语义，
 *  半张候选清单会让用户误以为其余包已验证通过）。 */
function unpackAll(inputs: readonly MergePkgInput[], passphrases: readonly string[]): { name: string; doc: ReturnType<typeof validateSyncdoc> }[] {
  const failed: string[] = []
  const ok: { name: string; doc: ReturnType<typeof validateSyncdoc> }[] = []
  inputs.forEach((p, i) => {
    try {
      ok.push({ name: p.name, doc: previewImportText(p.text, passphrases[i] ?? '', p.name).doc })
    } catch (e) {
      failed.push(`${p.name}（${(e as Error).message}）`)
    }
  })
  if (failed.length > 0) {
    throw new Error(
      t('以下配置包解包失败，已整体拒绝（不会应用部分结果）：', 'These packages failed to unpack; rejected as a whole (nothing is applied): ') +
        failed.join(t('；', '; '))
    )
  }
  return ok
}

/** 确认 token：绑定 (adminToken, 内容摘要, 服务数)。预览时勾选尚未发生（keep 由用户在候选表
 *  上现勾），不能进绑定——token 证明「用户看过这份内容的预览」；keep 完整性由「keep ⊆ 候选集」
 *  校验兜底。预览与确认之间包内容变化即失效；口令变化不进摘要（CodeQL insufficient-password-hash 污点面），由解包层强制——错口令 openEnvelope 直接失败并报包名，而非「预览过期」；键入 adminToken 防外部伪造；比较走 safeEqual 恒时。 */
function mergeConfirmToken(adminToken: string, pkgDigest: string, serviceCount: number): string {
  return sha256(`${adminToken}|merge-apply|${pkgDigest}|${serviceCount}`).slice(0, 32)
}

/** 包内容摘要：绑定 (name, 包文本) 清单——预览与确认之间内容变化即失效。口令不进摘要：
 *  口令有效性由解包层强制（错口令 openEnvelope 直接失败，apply 报口令错误而非「预览过期」），
 *  且口令若参与快速哈希即构成 password→弱哈希污点面（CodeQL insufficient-password-hash，
 *  2026-11-22 实警 10 条路径全由 sha256(passphrase) 一处引出），安全上零增益。 */
function pkgDigest(inputs: readonly MergePkgInput[]): string {
  return sha256(inputs.map((p) => `${p.name}\u0000${sha256(p.text)}`).join('\u0001'))
}

/** ticket 源的内容摘要：ticket 存的是解密后 doc（无包文本），摘要绑 doc.data 规范化 JSON——
 *  同一 ticket peek/take 拿到同一对象 → 预览与应用两次计算必然一致；ticket 被换/内容被改即失效。
 *  doc.data 含 key 明文，但只进 sha256 摘要不出端点（与包文本摘要同级安全面）。 */
function ticketDigest(doc: Syncdoc): string {
  return sha256(JSON.stringify(doc.data))
}

/** 统一的已解包形态：packages 直传 / ticket 暂存（url 预览后也落 ticket）收敛到这里 */
interface UnpackedSource {
  unpacked: { name: string; doc: Syncdoc }[]
  /** 应用阶段再取内容的载荷（packages=重传清单；ticket=票据引用）；undefined = 仅预览可用 */
  applyPayload?: Record<string, unknown>
  digest: string
  /** url 形态预览时新发的暂存票据（响应带给前端，apply 凭它回来） */
  stagedTicket?: string
}

/** 请求体 → 统一已解包源。phase='preview'：url 形态 fetch+暂存（一次性链接此时焚毁）；
 *  phase='apply'：url 不支持（预览时已暂存，凭 stagedTicket 走 ticket 形态），ticket 形态 peek 不消费
 *  （成功后由调用方 consume）。 */
async function resolveSource(b: Record<string, unknown>, phase: 'preview' | 'apply'): Promise<UnpackedSource> {
  const src = (b.source ?? {}) as Record<string, unknown>
  const srcKind = typeof src.kind === 'string' ? src.kind : ''
  if (Array.isArray(b.packages)) {
    const { inputs, passphrases, err } = pkgInputs(b)
    if (err) throw new Error(err)
    return { unpacked: unpackAll(inputs, passphrases), applyPayload: { packages: b.packages, ...(Array.isArray(b.passphrases) ? { passphrases: b.passphrases } : { passphrase: b.passphrase }) }, digest: pkgDigest(inputs) }
  }
  if (srcKind === 'ticket') {
    const ticket = typeof src.ticket === 'string' ? src.ticket : ''
    if (!ticket) throw new Error(t('缺少票据（ticket）', 'Missing ticket'))
    const doc = peekSyncTicket(ticket) // 非破坏读：预览不能烧票；应用成功后 consumeSyncTicket 显式消费
    return { unpacked: [{ name: t('（拉取的配置）', '(pulled config)'), doc }], applyPayload: { source: { kind: 'ticket', ticket } }, digest: ticketDigest(doc) }
  }
  if (srcKind === 'url') {
    if (phase === 'apply') {
      throw new Error(t('链接形态请在预览后凭暂存票据应用（一次性链接取走即焚，无法二次拉取）', 'Apply a link preview via its staged ticket (one-time links are burned on first fetch and cannot be re-pulled)'))
    }
    const passphrase = typeof src.passphrase === 'string' ? src.passphrase : ''
    if (!passphrase) throw new Error(t('缺少口令（链接 #p= 后段）', 'Missing passphrase (the #p= part of the link)'))
    const text = await fetchEnvelopeFromUrl(typeof src.url === 'string' ? src.url : '')
    const doc = previewImportText(text, passphrase, t('（分享链接）', '(share link)')).doc
    const ticket = putSyncTicket(doc) // 一次性链接已焚：应用只能走暂存副本
    return { unpacked: [{ name: t('（分享链接）', '(share link)'), doc }], applyPayload: { source: { kind: 'ticket', ticket } }, digest: ticketDigest(doc), stagedTicket: ticket }
  }
  throw new Error(t('缺少配置来源（packages 清单，或 source:{kind:"url"|"ticket"}）', 'Missing config source (packages array, or source:{kind:"url"|"ticket"})'))
}

/** 候选 ↔ 本机现有配置对账（追加导入的碰撞标注）：id 撞名=overwrite；规范化 base_url 相同且 key
 *  指纹命中本机该地址任一 key=same-source；其余=new。本机 key 逐家解析（预览是用户触发操作，
 *  非热路径）；单家 keychain 锁定等解析失败不阻塞预览（该家不参与同源判定，id 判定不受影响）。 */
async function classifyRelations(rt: AdminCtx['rt'], candidates: MergeCandidate[]): Promise<void> {
  const ids = new Set(Object.keys(rt.config.providers))
  const fpsByUrl = new Map<string, Set<string>>()
  for (const p of Object.values(rt.config.providers)) {
    const url = normalizeBaseUrl(p.base_url)
    const set = fpsByUrl.get(url) ?? new Set<string>()
    fpsByUrl.set(url, set)
    try {
      for (const k of await resolveProviderKeys(providerKeyRefs(p))) set.add(keyFingerprint(k.key))
    } catch {
      /* 单家解析失败：同源判定对该家缺席（宁漏标不误标），id 判定不受影响 */
    }
  }
  for (const cand of candidates) {
    cand.relation = ids.has(cand.id)
      ? 'overwrite'
      : cand.key_fp !== null && fpsByUrl.get(normalizeBaseUrl(cand.base_url))?.has(cand.key_fp)
        ? 'same-source'
        : 'new'
  }
}

/** POST /_modeldock/merge/preview：解包去重 + 探针三档建议 + 本机关系对账（admin 门内只读路径，
 *  url 形态的 ticket 暂存除外——内存 Map 非盘）。响应 candidates 含 relation；ticket 形态附 stagedTicket。 */
export async function hMergePreview(c: AdminCtx): Promise<void> {
  const { rt, req, res, audit } = c
  const b = await jsonRequestBody(req)
  try {
    const src = await resolveSource(b, 'preview')
    // doc 不出端点（含 key 明文）：预览只回候选视图；apply 凭同请求重推导
    const { preview } = mergePackages(src.unpacked, makeVerdictFinder(rt.probeVerdicts ?? new Map()))
    await classifyRelations(rt, preview.candidates)
    preview.localProviders = Object.keys(rt.config.providers).length
    audit(bi('配置包预览', 'Package import preview'), bi('{n} 个包', '{n} packages', { n: src.unpacked.length }), bi('服务 {p} · 去重 {d}', '{p} services · {d} merged', { p: preview.candidates.length, d: preview.duplicatesMerged }))

    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({
        ok: true,
        preview,
        confirmToken: mergeConfirmToken(rt.adminToken, src.digest, preview.candidates.length),
        tokenScope: 'unfiltered',
        ...(src.stagedTicket ? { ticket: src.stagedTicket } : {}),
      })
    )
  } catch (e) {
    audit(bi('配置包预览', 'Package import preview'), '-', undefined, (e as Error).message)
    sendError(res, 400, (e as Error).message, t('逐包检查口令与包完整性（CLI config merge 可逐包追问口令）', 'Check each package passphrase and integrity (CLI config merge can ask per package)'))
  }
  return
}

/** POST /_modeldock/merge/apply：按勾选应用（admin 门内写路径）。请求在 preview 基础上追加
 *  { keep: [providerId...], mode?: 'add'|'replace', confirmToken }；token 绑定 (内容摘要, 服务数)，
 *  与预览内容不一致即拒绝重预览。mode='add'（追加，控制台默认）走 applySyncdocAdditive：本机现有
 *  态保留、勾选并入（id 撞名覆盖、路由/预设/定时按 id 去重追加）；mode='replace'（缺省，兼容旧
 *  调用方）走 applyImportedDoc 整包替换。写入前快照由两条应用路径自带，随后热加载。
 *  ticket 形态：peek 校验 → 应用成功才 consumeSyncTicket 消费（失败保留可重试）。 */
export async function hMergeApply(c: AdminCtx): Promise<void> {
  const { rt, req, res, audit } = c
  const b = await jsonRequestBody(req)
  const keep = (Array.isArray(b.keep) ? (b.keep as unknown[]) : []).filter(isStr)
  const mode = b.mode === 'add' ? 'add' : 'replace'
  if (keep.length === 0) {
    return sendError(res, 400, t('缺少 keep（要保留的 provider id 清单）', 'Missing keep (provider ids to keep)'), t('先 POST /_modeldock/merge/preview 拿候选清单与 confirmToken', 'POST /_modeldock/merge/preview first for candidates and a confirmToken'))
  }
  let src: UnpackedSource
  try {
    src = await resolveSource(b, 'apply')
  } catch (e) {
    return sendError(res, 400, (e as Error).message, t('重新 POST /_modeldock/merge/preview 后再 apply', 'Re-run merge/preview, then apply again'))
  }
  try {
    const { preview, doc } = mergePackages(src.unpacked, makeVerdictFinder(rt.probeVerdicts ?? new Map()))
    const known = new Set(preview.candidates.map((cand) => cand.id))
    const unknown = keep.filter((id) => !known.has(id))
    if (unknown.length > 0) {
      return sendError(res, 400, t('keep 含未知服务 id：{ids}', 'keep contains unknown provider ids: {ids}', { ids: unknown.join(', ') }), t('重新 preview 取最新候选清单', 'Re-run preview for the latest candidate list'))
    }
    const token = mergeConfirmToken(rt.adminToken, src.digest, preview.candidates.length)
    const supplied = typeof b.confirmToken === 'string' ? b.confirmToken : ''
    if (!supplied || !safeEqual(supplied, token)) {
      return sendError(res, 400, t('confirmToken 与当前包内容/勾选不一致（预览已过期）', 'confirmToken does not match the current packages/selection (preview expired)'), t('重新 POST /_modeldock/merge/preview 后再 apply', 'Re-run merge/preview, then apply again'))
    }
    const filtered = filterMergedDoc(doc, keep)
    validateSyncdoc(filtered.doc)
    const applyOpts = {
      log: (line: string) => {
        try {
          logEvent(rt, { level: 'warn', op: 'merge_import', err: line.slice(0, 400) })
        } catch {
          /* 观测失败不影响响应 */
        }
      },
    }
    const report = mode === 'add' ? await applySyncdocAdditive(filtered.doc, applyOpts) : await applyImportedDoc(filtered.doc, applyOpts)
    if (mode === 'add' && typeof src.applyPayload?.source === 'object' && src.applyPayload.source !== null && (src.applyPayload.source as Record<string, unknown>).kind === 'ticket') {
      consumeSyncTicket(String((src.applyPayload.source as Record<string, unknown>).ticket ?? '')) // 成功才消费（失败保留可重试）
    }
    await reloadRuntime(rt)
    invalidateOverviewCache()
    audit(
      bi(mode === 'add' ? '配置包追加导入' : '配置包应用', mode === 'add' ? 'Package import (additive)' : 'Package import (replace)'),
      bi('服务 {p} · 路由 {r}', '{p} services · {r} profiles', { p: report.providers.length, r: report.profiles.length }),
      bi('{m} · 预设 {s} · 定时 {w}', '{m} · {s} presets · {w} schedule rules', { m: mode === 'add' ? t('追加', 'additive') : t('替换', 'replace'), s: report.presetCount, w: report.scheduleRules })
    )
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, report, droppedProfiles: filtered.droppedProfiles }))
  } catch (e) {
    audit(bi('配置包应用', 'Package import apply'), '-', undefined, (e as Error).message)
    sendError(res, 400, (e as Error).message)
  }
  return
}
