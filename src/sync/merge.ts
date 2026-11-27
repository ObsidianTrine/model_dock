// merge.ts — 多包合并流核心（provider-probe-suite 任务 11）：多个 .msync 包解出的 syncdoc
// 按 (base_url 规范化, key 指纹) 去重合并 → 逐服务挂本机探针 verdict 与三档建议 → 用户勾选后
// filterMergedDoc 产出待应用 doc。纯内存、零写盘（预览红线）；应用走 applyImportedDoc（自带快照）。
// key 指纹之外绝不输出 key 明文（对齐 verdict.ts keyFingerprint 红线）。

import { keyFingerprint } from '../gateway/probe/verdict.js'
import type { ProbeVerdict, ProbeVerdictState } from '../gateway/state/types.js'
import { SCHEMA_VERSION, SYNCDOC_FMT, type Syncdoc, type SyncProviderEntry } from './types.js'

/** 三档建议：keep=保留候选（healthy 或无探针记录）；review=存疑（degraded/quota/unreachable）；dead=失效（auth-dead） */
export type MergeSuggestion = 'keep' | 'review' | 'dead'

export interface MergeCandidate {
  /** 合并后条目 id（取首次出现的包中的 id） */
  id: string
  base_url: string
  /** sha256 前 8 位指纹；无明文 key（env 引用/缺失）时为 null */
  key_fp: string | null
  protocol: string
  auth_style: string
  /** 模型目录（verdict 匹配用模型取首个） */
  models: string[]
  /** 贡献该服务的包名（按包序） */
  sources: string[]
  /** 被去重合并掉的重复条目数（不含首条） */
  duplicateCount: number
  /** 合并 doc 中引用该服务的路由 id 清单 */
  profiles: string[]
  verdict_state: ProbeVerdictState | null
  verdict_at: number | null
  suggestion: MergeSuggestion
  /** 与本机现有配置的关系（2026-11-27 追加导入）：mergePackages 不知本机配置，由端点侧对账回填——
   *  overwrite=id 撞名（勾选即覆盖，id 保留路由引用不断）；same-source=base_url+key 指纹同源异名；
   *  new=全新。缺省（CLI 直调/旧调用方）视为 new 口径。 */
  relation?: 'new' | 'overwrite' | 'same-source'
}

export interface MergePackageSummary {
  name: string
  providers: number
  profiles: number
}

export interface MergePreview {
  candidates: MergeCandidate[]
  profileTotal: number
  presetCount: number
  scheduleRules: number
  duplicatesMerged: number
  packages: MergePackageSummary[]
  /** 本机现有 provider 总数（追加模式汇总行用；mergePackages 不知本机，端点侧回填） */
  localProviders?: number
}

export interface MergedBundle {
  preview: MergePreview
  /** 去重合并后的完整 doc（未过滤）——filterMergedDoc 的输入 */
  doc: Syncdoc
}

/** verdict 匹配器：按 (key 指纹, model) 全局扫本机探针记录。包内 provider 未进本机路由表，
 *  provider 维度不可用——key 指纹+model 是稳定锚（探针早于导入发生过就有记录）。model='' 表示不限模型。 */
export type VerdictFinder = (keyFp: string, model: string) => ProbeVerdict | undefined

/** 从本机 verdict 热态构建匹配器：同 (指纹, model) 多条结论（多 provider 复用同 key）取最差一条——
 *  坏结论不该被好结论盖住（与 ui/probe.ts 徽标同口径）。CLI 侧传 replayProbeVerdicts 回放的
 *  store，网关侧传 rt.probeVerdicts。 */
export function makeVerdictFinder(store: Map<string, ProbeVerdict>): VerdictFinder {
  return (keyFp, model) => {
    let worst: ProbeVerdict | undefined
    for (const v of store.values()) {
      if (v.keyFp !== keyFp) continue
      if (model !== '' && v.model !== model) continue
      if (!worst || VERDICT_BADNESS[v.state] > VERDICT_BADNESS[worst.state]) worst = v
    }
    return worst
  }
}

/** verdict 状态恶劣度排序（对齐 ui/probe.ts VS_RANK）：数值大者更坏，取服务全部结论里最差一条 */
const VERDICT_BADNESS: Record<ProbeVerdictState, number> = {
  'auth-dead': 6,
  unreachable: 5,
  quota: 4,
  degraded: 3,
  healthy: 2,
  unverified: 1,
  stale: 0,
}

/** verdict 状态 → 三档建议。无记录（undefined）与过期/未验证 = 无负证据，归保留候选（删除决策永远留给人）。 */
function suggestionFor(state: ProbeVerdictState | undefined): MergeSuggestion {
  if (state === 'auth-dead') return 'dead'
  if (state === 'degraded' || state === 'quota' || state === 'unreachable') return 'review'
  return 'keep'
}

/** base_url 去重归一化：小写 + 去尾斜杠（同主机不同书写形式视为同一服务） */
export function normalizeBaseUrl(url: string): string {
  return url.trim().toLowerCase().replace(/\/+$/, '')
}

const KEY_SEP = '\u0000'

/** 去重键：(规范化 base_url, key 指纹)。无明文 key（env 引用/缺失）退回 key_ref 原文做第二分量——
 *  同一 env 引用视为同一凭据来源；两包同 base_url 但凭据不同则不合并（不同的 key 是不同的服务）。 */
function dedupKey(p: SyncProviderEntry): string {
  const fp = typeof p.key === 'string' && p.key !== '' ? `fp:${keyFingerprint(p.key)}` : `ref:${p.key_ref ?? ''}`
  return `${normalizeBaseUrl(p.base_url)}${KEY_SEP}${fp}`
}

function presetArray(up: Syncdoc['data']['userPresets']): unknown[] {
  if (up === undefined || up === null) return []
  return Array.isArray(up) ? up : up.presets
}

/** 预设条目键（跨包与本机追加合并共用）：有 id 按 id；无 id 按内容；内容也拿不到按位置保底（绝不因合并丢条目） */
export function presetKey(entry: unknown, index: number): string {
  if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
    const id = (entry as Record<string, unknown>).id
    if (typeof id === 'string' && id !== '') return `id:${id}`
  }
  // 无 id 条目按内容去重；内容也拿不到时按位置保底（绝不因合并丢条目）
  try {
    return `json:${JSON.stringify(entry)}`
  } catch {
    return `idx:${index}`
  }
}

/** 多包合并：逐包 doc 按 (base_url, key 指纹) 去重并成一份 doc + 预览视图。
 *  口径：provider/profile 的 id 与内容都取首次出现（包序即参数序，稳定可复现）；后续重复条目
 *  只进 sources/duplicateCount 供展示。profiles 引用的 provider id 按去重结果重指；userPresets
 *  按 preset id（或内容）跨包去重；scheduleRules 精确重复去重。 */
export function mergePackages(inputs: readonly { name: string; doc: Syncdoc }[], findVerdict: VerdictFinder): MergedBundle {
  const providers: Record<string, SyncProviderEntry> = {}
  const profiles: Record<string, Syncdoc['data']['profiles'][string]> = {}
  const idMap = new Map<string, string>()
  const groups = new Map<string, { id: string; sources: string[]; duplicates: number; models: string[] }>()
  const packages: MergePackageSummary[] = []

  for (const { name, doc } of inputs) {
    const docProviders = doc.data.providers ?? {}
    packages.push({ name, providers: Object.keys(docProviders).length, profiles: Object.keys(doc.data.profiles ?? {}).length })
    for (const [pid, entry] of Object.entries(docProviders)) {
      const dk = dedupKey(entry)
      const g = groups.get(dk)
      if (!g) {
        providers[pid] = entry
        groups.set(dk, { id: pid, sources: [name], duplicates: 0, models: Object.keys(entry.models ?? {}) })
        idMap.set(pid, pid)
        continue
      }
      g.duplicates++
      if (!g.sources.includes(name)) g.sources.push(name)
      idMap.set(pid, g.id)
    }
    for (const [rid, profile] of Object.entries(doc.data.profiles ?? {})) {
      if (rid in profiles) continue
      profiles[rid] = { ...profile, provider: idMap.get(profile.provider) ?? profile.provider }
    }
  }

  // userPresets / scheduleRules：跨包合并去重（默认保留口径——它们不挂具体 provider，不随勾选剔除）
  const presets: unknown[] = []
  const seenPresets = new Set<string>()
  let presetForm: 'array' | 'object' | null = null
  for (const { doc } of inputs) {
    const up = doc.data.userPresets
    if (up !== undefined && up !== null) presetForm = presetForm ?? (Array.isArray(up) ? 'array' : 'object')
    const arr = presetArray(up)
    for (let i = 0; i < arr.length; i++) {
      const k = presetKey(arr[i], i)
      if (seenPresets.has(k)) continue
      seenPresets.add(k)
      presets.push(arr[i])
    }
  }
  const scheduleRules: Syncdoc['data']['scheduleRules'] = []
  const seenRules = new Set<string>()
  for (const { doc } of inputs) {
    for (const w of doc.data.scheduleRules ?? []) {
      const k = JSON.stringify(w)
      if (seenRules.has(k)) continue
      seenRules.add(k)
      scheduleRules.push(w)
    }
  }
  // 多包预设形态不一致时统一为 {presets:[...]}（两种形态 applySyncdoc 都接受；不做有损归一）
  const userPresets: Syncdoc['data']['userPresets'] = presetForm === 'array' && inputs.every((i) => i.doc.data.userPresets === undefined || Array.isArray(i.doc.data.userPresets))
    ? presets
    : presets.length > 0
      ? { presets }
      : []

  const doc: Syncdoc = {
    fmt: SYNCDOC_FMT,
    v: SCHEMA_VERSION,
    ts: new Date().toISOString(),
    data: {
      providers,
      profiles,
      userPresets,
      scheduleRules,
      ...(mergeAssets(inputs)),
    },
  }

  const candidateIds = Object.keys(providers)
  const profilesByProvider = new Map<string, string[]>()
  for (const [rid, profile] of Object.entries(profiles)) {
    const list = profilesByProvider.get(profile.provider) ?? []
    list.push(rid)
    profilesByProvider.set(profile.provider, list)
  }

  const candidates: MergeCandidate[] = candidateIds.map((id) => {
    const entry = providers[id]
    const g = groups.get(dedupKey(entry))!
    const models = Object.keys(entry.models ?? {})
    const fp = typeof entry.key === 'string' && entry.key !== '' ? keyFingerprint(entry.key) : null
    let worst: ProbeVerdict | undefined
    if (fp) {
      // 逐模型匹配取最差；目录为空时按指纹全模型扫（model='' 不限）
      for (const model of models.length > 0 ? models : ['']) {
        const v = findVerdict(fp, model)
        if (v && (!worst || VERDICT_BADNESS[v.state] > VERDICT_BADNESS[worst.state])) worst = v
      }
    }
    const state = worst ? worst.state : null
    return {
      id,
      base_url: entry.base_url,
      key_fp: fp,
      protocol: entry.protocol,
      auth_style: entry.auth_style,
      models,
      sources: [...g.sources],
      duplicateCount: g.duplicates,
      profiles: [...(profilesByProvider.get(id) ?? [])],
      verdict_state: state,
      verdict_at: worst ? worst.evidence.at : null,
      suggestion: suggestionFor(state ?? undefined),
    }
  })

  const preview: MergePreview = {
    candidates,
    profileTotal: Object.keys(profiles).length,
    presetCount: presets.length,
    scheduleRules: scheduleRules.length,
    duplicatesMerged: candidates.reduce((s, c) => s + c.duplicateCount, 0),
    packages,
  }
  return { preview, doc }
}

/** 资产段跟随合并：同路径多包冲突取首次出现（与 provider 同口径）；各自校验已过，这里只做并集 */
function mergeAssets(inputs: readonly { name: string; doc: Syncdoc }[]): { files: Record<string, string> } | undefined {
  const files: Record<string, string> = {}
  for (const { doc } of inputs) {
    for (const [k, v] of Object.entries(doc.data.assets?.files ?? {})) {
      if (k in files) continue
      files[k] = v
    }
  }
  return Object.keys(files).length > 0 ? { files } : undefined
}

export interface MergeFilterResult {
  /** 只保留勾选 provider 及其路由的 doc——applyImportedDoc 的输入 */
  doc: Syncdoc
  /** 因引用被剔除 provider 而一并剔除的路由 id（计数警告用） */
  droppedProfiles: string[]
}

/** 按勾选过滤合并 doc：只留勾选 provider + 引用它们的路由；userPresets/scheduleRules 不挂 provider，
 *  默认整体保留（口径见 NOTES）。全不勾 = 空 doc，调用方应在应用前拦截确认。 */
export function filterMergedDoc(doc: Syncdoc, keepIds: readonly string[]): MergeFilterResult {
  const keep = new Set(keepIds)
  const providers: Record<string, SyncProviderEntry> = {}
  for (const [id, entry] of Object.entries(doc.data.providers)) {
    if (keep.has(id)) providers[id] = entry
  }
  const profiles: Record<string, Syncdoc['data']['profiles'][string]> = {}
  const droppedProfiles: string[] = []
  for (const [rid, profile] of Object.entries(doc.data.profiles)) {
    if (keep.has(profile.provider)) profiles[rid] = profile
    else droppedProfiles.push(rid)
  }
  return {
    doc: { ...doc, data: { ...doc.data, providers, profiles } },
    droppedProfiles,
  }
}
