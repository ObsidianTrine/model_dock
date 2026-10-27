import fs from 'node:fs'
import type { ProviderConfig } from '../config/types.js'
import { loadConfig, mutateConfig } from '../config/store.js'
import { defaultStore, getSecret, parseKeyRef, setSecretsBatch, type SecretBackend } from '../config/secrets.js'
import { reloadPresets, validateUserPresetEntries } from '../presets/data.js'
import { clearKnownTable } from '../providers/known.js'
import { snapshot } from '../backup/snapshot.js'
import { atomicWrite } from '../util/fsx.js'
import { configPath, presetsJsonPath, secretsPath } from '../util/paths.js'
import { t } from '../util/i18n.js'
import { SCHEMA_VERSION, SYNCDOC_FMT, type Syncdoc, type SyncProviderEntry } from './types.js'

/** 收集/应用摘要：providers/profiles 为 id 清单；envKeyRefs=走环境变量引用不随包的服务；
 *  missingKeys=导出机上 key 已解析不到（引用原样保留）的服务；keysRestored=导入时按本机后端重存的 key 数 */
export interface SyncdocReport {
  providers: string[]
  profiles: string[]
  presetCount: number
  scheduleRules: number
  envKeyRefs: string[]
  missingKeys: string[]
  keysRestored?: number
}

/** 读取 presets.json 原始 JSON（保真不归一化，应用时原样写回）；缺失视为无自定义，格式错误抛可操作报错 */
function readRawUserPresets(): unknown[] | { presets: unknown[] } {
  const fp = presetsJsonPath()
  let text: string | null
  try {
    text = fs.readFileSync(fp, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return []
    throw new Error(t('读取自定义预设 {file} 失败：{err}', 'Failed to read the custom presets file {file}: {err}', { file: fp, err: (e as Error).message }))
  }
  let doc: unknown
  try {
    doc = JSON.parse(text)
  } catch (e) {
    throw new Error(t('自定义预设 {file} 格式错误：{err}（修复后重试导出）', 'Invalid format in the custom presets file {file}: {err} (fix it and retry the export)', { file: fp, err: (e as Error).message }))
  }
  if (Array.isArray(doc)) return doc
  if (typeof doc === 'object' && doc !== null && Array.isArray((doc as Record<string, unknown>).presets)) {
    return doc as { presets: unknown[] }
  }
  throw new Error(t('自定义预设 {file} 顶层应为数组，或 { "presets": [...] }', 'The custom presets file {file} must be an array at top level, or { "presets": [...] }', { file: fp }))
}

/** 收集可同步态 → syncdoc（docs/design-cloud-sync.md §4.1 清单）。
 *  key 处理：file/keychain/secret-service/plain 引用解析为明文随包；env: 引用不解析（机器态）原样保留；
 *  解析不到的引用原样保留并记入 missingKeys。 */
export async function collectSyncdoc(): Promise<{ doc: Syncdoc; report: SyncdocReport }> {
  const cfg = await loadConfig()
  const providers: Record<string, SyncProviderEntry> = {}
  const envKeyRefs: string[] = []
  const missingKeys: string[] = []
  // 密钥解析并行预取：keychain/secret-service 后端每取一次 spawn 一次外部进程，sync tick 又以
  // 分钟级周期全量重收（与密钥缓存 TTL 同频），串行 N 次会把 tick 拖到秒级——与 ops.addService
  // 的并行化同款。env:/plain 分支不触外部 IO，一并进 map 保序；组装循环按同序写
  // providers/envKeyRefs/missingKeys，结果与逐个串行 await 完全一致
  const resolved = await Promise.all(
    Object.entries(cfg.providers).map(async ([id, p]) => {
      const { scheme } = parseKeyRef(p.key_ref)
      if (scheme === 'env') return { id, p, kind: 'env' as const }
      const plain = scheme === 'plain' ? p.key_ref : await getSecret(p.key_ref)
      if (plain === null || plain === '') return { id, p, kind: 'missing' as const }
      return { id, p, kind: 'ok' as const, plain }
    })
  )
  for (const r of resolved) {
    if (r.kind === 'env') {
      providers[r.id] = { ...r.p }
      envKeyRefs.push(r.id)
      continue
    }
    if (r.kind === 'missing') {
      providers[r.id] = { ...r.p }
      missingKeys.push(r.id)
      continue
    }
    const { key_ref: _dropped, ...rest } = r.p
    providers[r.id] = { ...rest, key: r.plain }
  }
  // 逐条校验（缺 id 等问题在导出侧就给出可操作报错），原始 JSON 保真随包——校验与取原始值
  // 共用同一次文件读（readRawUserPresets），presets.json 不再被读+解析两遍
  const userPresets = readRawUserPresets()
  validateUserPresetEntries(Array.isArray(userPresets) ? userPresets : userPresets.presets, presetsJsonPath())
  const scheduleRules = cfg.gateway?.schedule?.windows ? [...cfg.gateway.schedule.windows] : []
  const profileIds = Object.keys(cfg.profiles)
  const providerIds = Object.keys(providers)
  return {
    doc: {
      fmt: SYNCDOC_FMT,
      v: SCHEMA_VERSION,
      ts: new Date().toISOString(),
      data: { providers, profiles: { ...cfg.profiles }, userPresets, scheduleRules },
    },
    report: { providers: providerIds, profiles: profileIds, presetCount: countPresets(userPresets), scheduleRules: scheduleRules.length, envKeyRefs, missingKeys },
  }
}

function countPresets(up: unknown[] | { presets: unknown[] }): number {
  return Array.isArray(up) ? up.length : up.presets.length
}

/** 应用 syncdoc：替换全部可同步态，机器态一律不动（docs/design-cloud-sync.md §5.2）。
 *  顺序：快照（config.toml/secrets.json/presets.json）→ key 按本机后端重存 → 整包替换 → 写预设。
 *  backend 缺省按 config.security.store / 平台默认；测试必须显式传 'file' 以免写真实钥匙串。 */
export async function applySyncdoc(doc: Syncdoc, opts?: { backend?: SecretBackend }): Promise<SyncdocReport> {
  await snapshot('config', 'pre-sync-import', [configPath(), secretsPath(), presetsJsonPath()])
  const cfg = await loadConfig()
  const backend = opts?.backend ?? (cfg.security?.store as SecretBackend | undefined) ?? (await defaultStore())

  const keyEntries: Record<string, string> = {}
  for (const [id, p] of Object.entries(doc.data.providers)) {
    if (typeof p.key === 'string' && p.key !== '') keyEntries[id] = p.key
  }
  const refs = await setSecretsBatch(keyEntries, backend)

  // 定时规则替换 windows、「启用」开关（机器态）保留
  // 校验已保证：无 key 的条目必带 key_ref（env 引用或导出机解析失败的残留）
  const providers: Record<string, ProviderConfig> = {}
  for (const [id, p] of Object.entries(doc.data.providers)) {
    if (typeof p.key === 'string' && p.key !== '') {
      const { key: _k, ...rest } = p
      providers[id] = { ...rest, key_ref: refs[id]! }
    } else {
      providers[id] = { ...p, key_ref: p.key_ref! }
    }
  }
  const rules = doc.data.scheduleRules ?? []
  const profiles = { ...doc.data.profiles }
  await mutateConfig((c) => {
    c.providers = providers
    c.profiles = profiles
    // 新机导入后没有任何路由在供：客户端无可用 profile、手机控制台「实际生效」显示不可用。
    // 只在本机还没选过路由时补默认（首個 profile），已有路由的机器一律不动——当前激活路由
    // 是机器态，不随包覆盖（lansync/syncexport 测试钉死的语义）。远端删掉了正激活 profile 时
    // 会短暂留下悬空引用：转发侧 pickTarget 对未知 profile 安全回落（首候选/无路由），用户
    // 重选一次即恢复；不做自动重指——那会覆盖用户的机器态选择。
    const first = Object.keys(profiles)[0]
    if (!c.active_profile && first) c.active_profile = first
    if (rules.length > 0 || c.gateway?.schedule) {
      c.gateway = { ...c.gateway, schedule: { ...(c.gateway?.schedule?.enabled === undefined ? {} : { enabled: c.gateway.schedule.enabled }), windows: [...rules] } }
    }
  })

  await atomicWrite(presetsJsonPath(), JSON.stringify(doc.data.userPresets ?? [], null, 2) + '\n', 0o600)
  reloadPresets()
  // reloadPresets 只重建预设表：known.ts 的模型索引（byIdTable）首建后不失效的话，
  // 长驻网关进程内同步下来的预设模型元数据一直用旧值直到重启
  clearKnownTable()

  return {
    providers: Object.keys(providers),
    profiles: Object.keys(doc.data.profiles),
    presetCount: doc.data.userPresets === undefined || doc.data.userPresets === null ? 0 : countPresets(doc.data.userPresets),
    scheduleRules: rules.length,
    envKeyRefs: Object.entries(doc.data.providers).filter(([, p]) => parseKeyRef(p.key_ref ?? '').scheme === 'env').map(([id]) => id),
    missingKeys: Object.entries(doc.data.providers)
      .filter(([, p]) => !(typeof p.key === 'string' && p.key !== '') && ['file', 'keychain', 'secret-service'].includes(parseKeyRef(p.key_ref ?? '').scheme))
      .map(([id]) => id),
    keysRestored: Object.keys(keyEntries).length,
  }
}
