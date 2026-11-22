/** 多包合并域：merge/preview 与 merge/apply 端点（provider-probe-suite 任务 11）。
 *  与 configpack.ts（单包直拉导入）同域不同流：合并 = 多包去重 + 探针三档建议 + 勾选保留。
 *  预览零写盘红线：解包/合并/展示全程内存操作；应用走 applyImportedDoc（applySyncdoc 自带
 *  config.toml/secrets.json/presets.json 快照），端点侧不重复快照。key 明文只在内存流转，
 *  响应与审计只出 sha256 前 8 位指纹。 */
import { AdminCtx, jsonRequestBody, sendError } from './admin-shared.js'
import { applyImportedDoc, previewImportText } from '../sync/exportImport.js'
import { filterMergedDoc, makeVerdictFinder, mergePackages } from '../sync/merge.js'
import { validateSyncdoc } from '../sync/types.js'
import { logEvent, reloadRuntime } from './state.js'
import { invalidateOverviewCache } from './overview-view.js'
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

/** 请求体 → 包文本清单。msync 内容 base64 传（JSON 字符串直传会被转义/长度敏感放大），name 仅作展示与审计。 */
function pkgInputs(b: Record<string, unknown>): { inputs: MergePkgInput[]; passphrase: string; err?: string } {
  const passphrase = typeof b.passphrase === 'string' ? b.passphrase : ''
  const raw = Array.isArray(b.packages) ? b.packages : []
  const inputs: MergePkgInput[] = []
  for (const item of raw.slice(0, 16)) {
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    const b64 = typeof o.content_b64 === 'string' ? o.content_b64 : ''
    if (!b64) return { inputs: [], passphrase, err: t('包缺少 content_b64（.msync 文本内容的 base64）', 'A package is missing content_b64 (base64 of the .msync text)') }
    inputs.push({ name: typeof o.name === 'string' && o.name ? o.name.slice(0, 120) : `${inputs.length + 1}.msync`, text: Buffer.from(b64, 'base64').toString('utf8') })
  }
  if (inputs.length < 2) return { inputs: [], passphrase, err: t('合并至少需要两个包（packages 数组，每项 { name, content_b64 }）', 'Merging needs at least two packages (packages array of { name, content_b64 })') }
  if (!passphrase) return { inputs, passphrase, err: t('缺少口令（导出时设置的同步口令）', 'Missing passphrase (the one set at export)') }
  return { inputs, passphrase }
}

function unpackAll(inputs: readonly MergePkgInput[], passphrase: string): { name: string; doc: ReturnType<typeof validateSyncdoc> }[] {
  return inputs.map((p) => ({ name: p.name, doc: previewImportText(p.text, passphrase, p.name).doc }))
}

/** 确认 token：绑定 (adminToken, 包内容摘要, 服务数)。预览时勾选尚未发生（keep 由用户在候选表
 *  上现勾），不能进绑定——token 证明「用户看过这份内容的预览」；keep 完整性由「keep ⊆ 候选集」
 *  校验兜底。预览与确认之间包内容变化即失效；键入 adminToken 防外部伪造；比较走 safeEqual 恒时。 */
function mergeConfirmToken(adminToken: string, pkgDigest: string, serviceCount: number): string {
  return sha256(`${adminToken}|merge-apply|${pkgDigest}|${serviceCount}`).slice(0, 32)
}

function pkgDigest(inputs: readonly MergePkgInput[], passphrase: string): string {
  return sha256(inputs.map((p) => `${p.name}\u0000${sha256(p.text)}`).join('\u0001') + `\u0000${sha256(passphrase)}`)
}

/** POST /_modeldock/merge/preview：多包解包去重 + 探针三档建议（admin 门内只读路径，零写盘）。
 *  请求 { packages: [{ name, content_b64 }], passphrase }；响应 candidates 只含指纹（key 明文不出端点）。 */
export async function hMergePreview(c: AdminCtx): Promise<void> {
  const { rt, req, res, audit } = c
  const b = await jsonRequestBody(req)
  const { inputs, passphrase, err } = pkgInputs(b)
  if (err) {
    return sendError(res, 400, err, t('包内容经 base64 编码随 JSON 上传；两段式流程先 preview 拿 confirmToken 再 apply', 'Package content is uploaded base64-encoded in JSON; preview first to get a confirmToken, then apply'))
  }
  try {
    const unpacked = unpackAll(inputs, passphrase)
    // doc 不出端点（含 key 明文）：预览只回候选视图；apply 凭同请求重推导
    const { preview } = mergePackages(unpacked, makeVerdictFinder(rt.probeVerdicts ?? new Map()))
    audit(bi('合并配置包预览', 'Merge packages preview'), bi('{n} 个包', '{n} packages', { n: inputs.length }), bi('服务 {p} · 去重 {d}', '{p} services · {d} merged', { p: preview.candidates.length, d: preview.duplicatesMerged }))

    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({
        ok: true,
        preview,
        confirmToken: mergeConfirmToken(rt.adminToken, pkgDigest(inputs, passphrase), preview.candidates.length),
        tokenScope: 'unfiltered',
      })
    )
  } catch (e) {
    audit(bi('合并配置包预览', 'Merge packages preview'), '-', undefined, (e as Error).message)
    sendError(res, 400, (e as Error).message, t('逐包检查口令与包完整性（CLI config merge 可逐包追问口令）', 'Check each package passphrase and integrity (CLI config merge can ask per package)'))
  }
  return
}

/** POST /_modeldock/merge/apply：按勾选应用合并结果（admin 门内写路径）。请求在 preview 基础上
 *  追加 { keep: [providerId...], confirmToken }；token 绑定 (包摘要, 勾选, 服务数)，与预览内容
 *  不一致即拒绝重预览。写入经 applyImportedDoc（整包替换可同步态，前先快照），随后热加载。 */
export async function hMergeApply(c: AdminCtx): Promise<void> {
  const { rt, req, res, audit } = c
  const b = await jsonRequestBody(req)
  const { inputs, passphrase, err } = pkgInputs(b)
  const keep = (Array.isArray(b.keep) ? (b.keep as unknown[]) : []).filter(isStr)
  if (err || keep.length === 0) {
    return sendError(res, 400, err ?? t('缺少 keep（要保留的 provider id 清单）', 'Missing keep (provider ids to keep)'), t('先 POST /_modeldock/merge/preview 拿候选清单与 confirmToken', 'POST /_modeldock/merge/preview first for candidates and a confirmToken'))
  }
  try {
    const unpacked = unpackAll(inputs, passphrase)
    const { preview, doc } = mergePackages(unpacked, makeVerdictFinder(rt.probeVerdicts ?? new Map()))
    const known = new Set(preview.candidates.map((cand) => cand.id))
    const unknown = keep.filter((id) => !known.has(id))
    if (unknown.length > 0) {
      return sendError(res, 400, t('keep 含未知服务 id：{ids}', 'keep contains unknown provider ids: {ids}', { ids: unknown.join(', ') }), t('重新 preview 取最新候选清单', 'Re-run preview for the latest candidate list'))
    }
    const token = mergeConfirmToken(rt.adminToken, pkgDigest(inputs, passphrase), preview.candidates.length)
    const supplied = typeof b.confirmToken === 'string' ? b.confirmToken : ''
    if (!supplied || !safeEqual(supplied, token)) {
      return sendError(res, 400, t('confirmToken 与当前包内容/勾选不一致（预览已过期）', 'confirmToken does not match the current packages/selection (preview expired)'), t('重新 POST /_modeldock/merge/preview 后再 apply', 'Re-run merge/preview, then apply again'))
    }
    const filtered = filterMergedDoc(doc, keep)
    validateSyncdoc(filtered.doc)
    const report = await applyImportedDoc(filtered.doc, {
      log: (line) => {
        try {
          logEvent(rt, { level: 'warn', op: 'merge_import', err: line.slice(0, 400) })
        } catch {
          /* 观测失败不影响响应 */
        }
      },
    })
    await reloadRuntime(rt)
    invalidateOverviewCache()
    audit(
      bi('合并配置包应用', 'Merge packages apply'),
      bi('服务 {p} · 路由 {r}', '{p} services · {r} profiles', { p: report.providers.length, r: report.profiles.length }),
      bi('{n} 个包 · 预设 {s} · 定时 {w}', '{n} packages · {s} presets · {w} schedule rules', { n: inputs.length, s: report.presetCount, w: report.scheduleRules })
    )
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, report, droppedProfiles: filtered.droppedProfiles }))
  } catch (e) {
    audit(bi('合并配置包应用', 'Merge packages apply'), '-', undefined, (e as Error).message)
    sendError(res, 400, (e as Error).message)
  }
  return
}
