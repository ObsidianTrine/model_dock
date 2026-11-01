/** 导入落地：候选 → providers（key 批量入 secret store）+ 可选 profiles */
import { slugify } from '../../util/index.js'
import { t } from '../../util/i18n.js'
import type { Config, ModelMeta } from '../../config/types.js'
import { defaultStore, getSecret, setSecretsBatch } from '../../config/secrets.js'
import { resolveModelMeta } from '../../providers/resolve.js'
import { normalizeBaseUrl, type ImportCandidate } from './common.js'

export interface ImportReport {
  providers: string[]
  profiles: string[]
  skipped: { id: string; reason: string }[]
}

/** 导入候选 → providers（key 存入 secret store）+ 可选 profiles；只读不写原文件。
 *  兜底去重：地址已存在（或本批已导入过）的候选一律跳过并注明原因。 */
export async function applyImport(
  cfg: Config,
  cands: ImportCandidate[],
  opts: { withProfiles: boolean }
): Promise<ImportReport> {
  const report: ImportReport = { providers: [], profiles: [], skipped: [] }
  // 现有服务按归一化地址索引（key 仅在 URL 命中时才解析，避免大表全量 getSecret）
  const existingByUrl = new Map<string, { pid: string; key?: string }[]>()
  for (const [pid, p] of Object.entries(cfg.providers)) {
    const norm = normalizeBaseUrl(p.base_url)
    const arr = existingByUrl.get(norm) ?? []
    arr.push({ pid })
    existingByUrl.set(norm, arr)
  }
  const backend = cfg.security?.store ?? (await defaultStore())
  /** 现有同 URL 服务里是否有同一 key？有则返回其 pid（视为重复）。
   *  坏 key_ref（缺字段/非串/解不开，700e29f 同根残留）降级为 ''：只跳过该条的 key 比对，
   *  不让单条坏数据卡死整个 import/init（2026-11-02 复查）。 */
  const findByKey = async (list: { pid: string; key?: string }[], key: string): Promise<string | null> => {
    for (const e of list) {
      if (e.key === undefined) {
        const ref = cfg.providers[e.pid]?.key_ref
        e.key = ref && typeof ref === 'string' ? ((await getSecret(ref).catch(() => null)) ?? '') : ''
      }
      if (e.key === key) return e.pid
    }
    return null
  }

  // ① 先算好每个候选的 id 与是否要写 key（不立即写盘）
  //    检测层已按「归一化地址」去重（保留使用中）；这里再按地址+key 精确判断与已有服务的重复并跳过
  const addedByPair = new Map<string, string>()
  const usedIds = new Set<string>()
  const meta: { id: string; cand: ImportCandidate }[] = []
  const keyBatch: Record<string, string> = {}
  for (const cand of cands) {
    if (cand.skip_reason || !cand.base_url) {
      report.skipped.push({ id: cand.suggest_id, reason: cand.skip_reason ?? t('无 base_url', 'no base_url') })
      continue
    }
    const norm = normalizeBaseUrl(cand.base_url)
    const candKey = cand.key ?? ''
    const pair = `${norm}\u0000${candKey}`
    const existing = existingByUrl.get(norm)
    const dupOf = existing ? await findByKey(existing, candKey) : null
    if (dupOf) {
      report.skipped.push({ id: cand.suggest_id, reason: t('与已有服务「{name}」地址相同且 Key 相同，已跳过', 'Same base URL and key as existing service "{name}"; skipped', { name: dupOf }) })
      continue
    }
    const addedDup = addedByPair.get(pair)
    if (addedDup) {
      report.skipped.push({ id: cand.suggest_id, reason: t('本批已导入「{name}」（同地址同 Key），已跳过', 'Already imported in this batch as "{name}" (same base URL and key); skipped', { name: addedDup }) })
      continue
    }
    let id = cand.suggest_id || slugify(cand.name || cand.base_url)
    // 撞车兜底须同时查两处：cfg.providers（已有服务）+ 本批已用 id——批内条目到第③步才落盘，
    // 只查 cfg 的话，base_url 不同但 suggest_id 相同的两个候选（one-api 同名渠道、cc-switch
    // 同名行很常见，CLI checkbox 还按 suggest_id 连选）会拿到同一 id，写入时后者静默覆盖前者。
    const base = id
    let n = 2
    while (cfg.providers[id] || usedIds.has(id)) id = `${base}-${n++}`
    usedIds.add(id)
    addedByPair.set(pair, id)
    meta.push({ id, cand })
    if (cand.key) keyBatch[id] = cand.key
  }

  // ② 批量写入全部 key（file/dpapi 一次整表写盘，避免逐 key 重写）
  const refs = Object.keys(keyBatch).length > 0 ? await setSecretsBatch(keyBatch, backend) : {}

  // ③ 落 provider / profile
  for (const { id, cand } of meta) {
    const keyRef = refs[id] ?? `env:${envHint(cand)}` // 无 key 时沿用 env 引用占位
    cfg.providers[id] = {
      name: cand.name,
      base_url: normalizeBaseUrl(cand.base_url),
      protocol: cand.protocol,
      auth_style: cand.auth_style,
      key_ref: keyRef,
      models: toMeta(cand.models),
    }
    report.providers.push(id)
    if (opts.withProfiles && !cfg.profiles[id]) {
      cfg.profiles[id] = { name: cand.name, provider: id, default_model: cand.models?.[0] }
      report.profiles.push(id)
    }
    if (cand.is_current && !cfg.active_profile) cfg.active_profile = id
  }
  return report
}

function envHint(cand: ImportCandidate): string {
  return `${cand.suggest_id.toUpperCase().replace(/-/g, '_')}_API_KEY`
}

function toMeta(models: string[] | undefined): Record<string, ModelMeta> | undefined {
  if (!models?.length) return undefined
  const out: Record<string, ModelMeta> = {}
  for (const id of models) {
    const known = resolveModelMeta(id)
    out[id] = known
      ? { source: 'manual', context_window: known.context_window, max_output: known.max_output }
      : { source: 'manual' }
  }
  return out
}
