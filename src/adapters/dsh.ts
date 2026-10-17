import path from 'node:path'
import fsp from 'node:fs/promises'
import { isMap, isSeq, type YAMLSeq } from 'yaml'
import { biJoin, dshHomeDir, isFile, readTextIfExists, t } from '../util/index.js'
import type { Config, ModelMeta } from '../config/types.js'
import {
  AdapterError,
  isOursGatewayUrl,
  type AdapterStatus,
  type AttachOptions,
  type DetectResult,
  type FileChange,
  type HarnessAdapter,
  type PlanResult,
} from './types.js'
import { parseDocument } from './format.js'
import { directAttachNote, directResponsesNote, directWire, gatewayWire, isGatewayBase, resolveRoute, routeModelNote } from './shared.js'
import { catalogForRoute, catalogLookupById, loadDshCatalog, type CatalogModel } from '../providers/dshcatalog.js'
import { resolveModelMeta } from '../providers/resolve.js'

/** dsh provider 注册条目 id（旧 settings.yaml 顶层键 / 新 profile patch 的条目 id）；import/sources.ts 也用它定位 */
export const PROVIDERS_ROOT = 'llm-pi-ai'
const AGENT_DEFAULT = 'agent-default-model'
const PATCH_FILE = 'cordis.patch.yml' // 新版 dsh 的 profile 用户层配置（顶层为 patch 条目数组）

type YamlDoc = ReturnType<typeof parseDocument>

/** .credentials.yaml 凭据文件（含 refs 表，ModelDock 注入 token/上游 key）；import/sources.ts 复用 */
export const credFile = () => path.join(dshHomeDir(), '.credentials.yaml')

/** 目录存在探测：只在确为目录的探针上用（~/.dsh 本体及 sessions/storages 等目录型安装信号），
 *  普通文件探针一律 isFile（见 dshInstalled / planAttach 的 fileExists 收敛） */
async function dirExists(p: string): Promise<boolean> {
  try {
    return (await fsp.stat(p)).isDirectory()
  } catch {
    return false
  }
}

/** 测试注入点：替换 catalog 加载器 */
let catalogLoader = loadDshCatalog
export function setDshCatalogLoader(fn: typeof loadDshCatalog): void {
  catalogLoader = fn
}

// 布局发现：旧布局 ~/.dsh/settings.yaml vs 新布局 profiles/<name>/cordis.patch.yml

export interface DshLayout {
  home: string
  /** 旧布局：settings.yaml（新版 dsh 启动时会把它迁移为 settings.yaml.imported） */
  legacyFile: string
  legacyExists: boolean
  /** 新布局：已存在的 profile 用户层 patch 文件 */
  patchFiles: string[]
  /** profiles/ 下的 profile home（含 package.json 里 dsh.profile 者，或已有 patch），patch 尚未创建时用于新建 */
  profileDirs: string[]
}

export async function dshLayout(): Promise<DshLayout> {
  const home = dshHomeDir()
  const legacyFile = path.join(home, 'settings.yaml')
  const legacyExists = await isFile(legacyFile)
  const profileDirs: string[] = []
  const patchFiles: string[] = []
  let names: string[] = []
  try {
    names = (await fsp.readdir(path.join(home, 'profiles'), { withFileTypes: true }))
      .filter((e) => e.isDirectory() && e.name !== 'node_modules')
      .map((e) => e.name)
  } catch {
    /* 无 profiles 目录（旧布局或全新安装） */
  }
  for (const name of names) {
    const dir = path.join(home, 'profiles', name)
    const patch = path.join(dir, PATCH_FILE)
    if (await isFile(patch)) {
      profileDirs.push(dir)
      patchFiles.push(patch)
      continue
    }
    const pkgText = await readTextIfExists(path.join(dir, 'package.json'))
    if (pkgText !== null) {
      try {
        const pkg = JSON.parse(pkgText) as Record<string, unknown>
        if (pkg && typeof pkg === 'object' && 'dsh' in pkg) profileDirs.push(dir)
      } catch {
        /* package.json 损坏则不当作 profile home */
      }
    }
  }
  return { home, legacyFile, legacyExists, patchFiles, profileDirs }
}

/** "dsh 已安装"的信号比 settings.yaml 宽：新版 dsh 迁移后 settings.yaml 会被改名为 .imported，
 *  只认 settings.yaml 会把正在使用的 dsh 误报成未安装。 */
async function dshInstalled(layout: DshLayout): Promise<boolean> {
  const h = layout.home
  const signals = [
    layout.legacyExists,
    layout.patchFiles.length > 0,
    layout.profileDirs.length > 0,
    isFile(credFile()),
    isFile(path.join(h, 'settings.yaml.imported')),
    dirExists(path.join(h, 'sessions')),
    dirExists(path.join(h, 'storages')),
  ]
  return (await Promise.all(signals)).some(Boolean)
}

/** 从两种布局的 toJS 结果里取 llm-pi-ai 的 providers 表（import/sources.ts 复用，dsh 改名不再静默失配） */
export function providersOf(js: unknown, kind: 'legacy' | 'patch'): Record<string, any> | undefined {
  if (kind === 'legacy') return (js as any)?.[PROVIDERS_ROOT]?.providers
  if (!Array.isArray(js)) return undefined
  const entry = (js as any[]).find((e) => e?.id === PROVIDERS_ROOT)
  return entry?.config?.providers
}

/** 现有 dsh profile 名列表（如 desktop / web）：patch 文件取其所在目录名，profile home 本身是目录、直接取目录名 */
export function dshProfileNames(layout: DshLayout): string[] {
  return [
    ...new Set([
      ...layout.patchFiles.map((p) => path.basename(path.dirname(p))),
      ...layout.profileDirs.map((p) => path.basename(p)),
    ]),
  ]
}

/** 按 opts.clientProfiles 限定写入目标（desktop / web 等客户端自身 profile）；未指定 = 全部。
 *  桌面版与 Web 版各是一个 profile（profiles/desktop、profiles/web），手动在某一端配的模型只落它自己的 patch，
 *  这里允许接入时只挑其中几端写入。unknown 非空时抛错并列出现有 profile，避免拼错名字静默落空。 */
function filterProfiles(
  layout: DshLayout,
  wanted: string[] | undefined
): { patchFiles: string[]; profileDirs: string[]; available: string[] } {
  const available = dshProfileNames(layout)
  if (!wanted || wanted.length === 0) {
    return { patchFiles: layout.patchFiles, profileDirs: layout.profileDirs, available }
  }
  const set = new Set(wanted.map((s) => s.trim()).filter(Boolean))
  const unknown = [...set].filter((n) => !available.includes(n))
  if (unknown.length > 0) {
    throw new AdapterError(
      t(
        'dsh 不存在 profile：{unknown}（现有：{available}）；桌面版 / 网页版各为一个 profile（desktop / web），请核对 ~/.dsh/profiles/ 下的目录名',
        'dsh has no profile: {unknown} (existing: {available}); desktop and web are separate profiles (desktop / web) — check the directory names under ~/.dsh/profiles/',
        { unknown: biJoin('、', ', ', unknown), available: available.length > 0 ? biJoin('、', ', ', available) : t('无', 'none') }
      )
    )
  }
  return {
    patchFiles: layout.patchFiles.filter((p) => set.has(path.basename(path.dirname(p)))),
    profileDirs: layout.profileDirs.filter((p) => set.has(path.basename(p))),
    available,
  }
}

/** patch 顶层必须是数组（cordis.patch.yml 约定）；空文档补一个空数组 */
function ensureSeq(doc: YamlDoc, file: string): YAMLSeq {
  if (doc.contents == null) doc.contents = doc.createNode([])
  if (!isSeq(doc.contents)) {
    throw new AdapterError(
      t(
        '{file} 顶层不是数组（cordis.patch.yml 约定为 patch 条目列表），已中止（未做任何改动）',
        'The top level of {file} is not an array (cordis.patch.yml expects a list of patch entries); aborted (nothing changed)',
        { file }
      )
    )
  }
  return doc.contents as YAMLSeq
}

function patchEntryIndex(doc: YamlDoc, id: string): number {
  const contents = doc.contents
  if (!isSeq(contents)) return -1
  for (let i = 0; i < contents.items.length; i++) {
    if (doc.getIn([i, 'id']) === id) return i
  }
  return -1
}

/**
 * 组装 dsh provider 的 models 列表：ModelDock 元数据优先，
 * 缺失字段从 dsh 内置 catalog 补全（route 精确匹配 → 全局 id 匹配）。
 * 返回 YAML 条目与"补全到 ModelDock 目录"的元数据。
 */
export async function buildDshModelEntries(
  providerId: string,
  models: Record<string, ModelMeta> | undefined,
  cfg: Config
): Promise<{ entries: Record<string, unknown>[]; mergedMeta: Record<string, ModelMeta>; metaFilled: number; catalogUsed: boolean }> {
  const catalog = (await catalogLoader())?.catalog ?? null
  const route = catalog ? catalogForRoute(catalog, providerId) : new Map<string, CatalogModel>()
  const entries: Record<string, unknown>[] = []
  const mergedMeta: Record<string, ModelMeta> = {}
  let metaFilled = 0

  for (const [mid, meta] of Object.entries(models ?? {})) {
    const fromCatalog = route.get(mid) ?? (catalog ? catalogLookupById(catalog, mid) : null) ?? null
    const ctx = meta.context_window ?? fromCatalog?.contextWindow
    const out = meta.max_output ?? fromCatalog?.maxTokens
    const display = meta.display_name ?? fromCatalog?.name ?? mid
    const rec: Record<string, unknown> = { id: mid, name: display }
    if (ctx !== undefined) rec.contextWindow = ctx
    if (out !== undefined) rec.maxTokens = out
    // 推理等级：dsh 把「手写声明的模型」一律当只支持 off，不声明则 profile 里保存的思考等级
    // （agent-default-model.reasoningEffort，用户侧存的）会让每次请求直接报 UNSUPPORTED_REASONING_EFFORT。
    // 等级名与 dsh 官方一致；wire 值由 pi-ai 按协议映射（anthropic 下只决定可选等级，实际发 budget_tokens）。
    // 必须省略 off：dsh 的 resolver 把「声明 off: null」落成 map 里无 off 键，pi-ai（0.84.x）对无 off 键
    // 的模型在默认路径发 thinking:{type:'disabled'}，思考内建模型（如 glm-5.3-flash）上游会 400 拒收；
    // 省略 off 才会落成 map.off=null → 不发 thinking 参数，dsh UI 也随之隐藏 off 档。
    rec.reasoningEfforts = { low: 'low', medium: 'medium', high: 'high' }
    // 视觉：可选能力（控制台「视觉」列 / 内置表推断）；不声明时 dsh 按纯文本模态处理，图片会被拦下
    const resolvedCaps = meta.capabilities ?? resolveModelMeta(mid, meta, { baseUrl: cfg.providers[providerId]?.base_url })?.capabilities
    const caps = resolvedCaps ?? []
    if (caps.includes('vision')) rec.input = ['text', 'image']
    entries.push(rec)

    const merged: ModelMeta = {
      ...meta,
      display_name: meta.display_name ?? fromCatalog?.name,
      context_window: ctx,
      max_output: out,
      capabilities: meta.capabilities ?? resolvedCaps,
    }
    if (
      (meta.context_window === undefined && ctx !== undefined) ||
      (meta.max_output === undefined && out !== undefined) ||
      (meta.display_name === undefined && fromCatalog?.name !== undefined) ||
      (meta.capabilities === undefined && resolvedCaps !== undefined)
    ) {
      mergedMeta[mid] = merged
      if (meta.context_window === undefined && ctx !== undefined) metaFilled++
      if (meta.max_output === undefined && out !== undefined) metaFilled++
    }
  }
  return { entries, mergedMeta, metaFilled, catalogUsed: !!catalog }
}

export const dshAdapter: HarnessAdapter = {
  id: 'dsh',
  get label() {
    return t('dsh（DeepSeek Harness）', 'dsh (DeepSeek Harness)')
  },
  directMode: true,
  bakesModels: true,
  install: {
    command: 'npm install -g @deepseek-ai/dsh',
    uninstall: 'npm uninstall -g @deepseek-ai/dsh',
    needsNode: true,
    probe: 'dsh',
    get guide() {
      return t(
        'dsh（DeepSeek Harness CLI）是 npm 包（Node 程序）。点「安装并接入」由 ModelDock 自动完成：本机没有 Node 时先下载托管 Node 运行时（zh 默认国内镜像、en 默认官方源、免管理员、可撤销），再安装 dsh 并预写 ~/.dsh 配置骨架。手动兜底：npm install -g @deepseek-ai/dsh（大陆网络加 --registry=https://registry.npmmirror.com）。桌面版是独立应用、无需 Node，从下方官网 Harness 页下载桌面端安装包（macOS Apple 芯片 / Windows 64 位），装好后点「重新检测」。',
        'The dsh CLI (DeepSeek Harness) is an npm package (a Node program). Click Install & attach and ModelDock handles it: if this machine has no Node.js, the managed Node runtime is downloaded first (zh defaults to the China mirror, en to the official source; no admin rights, reversible), then dsh is installed and a ~/.dsh config skeleton is written. Manual fallback: npm install -g @deepseek-ai/dsh. The desktop app is standalone and needs no Node — download it from the official Harness page below (macOS Apple silicon / Windows x64), then click Re-detect.'
      )
    },
    // 官网 Harness 产品页（内含「下载桌面端」直链 dsh-latest-macos-arm64.dmg / dsh-latest-windows-x64.exe）；
    // 注意 download.deepseek.com 根域是 DeepSeek 聊天 App 的下载页，不是 Harness 桌面端，别指回去
    homepage: 'https://www.deepseek.com/harness',
    bootstrap: {
      path: () => path.join(dshHomeDir(), 'settings.yaml'),
      // 与 planAttach 兜底新建的 settings.yaml 同构；dsh 新版首启会把它导入 profiles 并改名为 .imported
      content: 'llm-pi-ai:\n  providers: {}\n',
    },
  },

  async clientProfileOptions(): Promise<string[]> {
    return dshProfileNames(await dshLayout())
  },

  async detect(): Promise<DetectResult> {
    const layout = await dshLayout()
    if (!(await dshInstalled(layout))) {
      return {
        installed: false,
        configFiles: [],
        note: t(
          '未找到 dsh 配置目录（{home}）；若 dsh 装在别处，请设置 DSH_HOME 环境变量指向其目录',
          'dsh config directory not found ({home}); if dsh is installed elsewhere, set the DSH_HOME environment variable to its directory',
          { home: layout.home }
        ),
      }
    }
    const configFiles: string[] = []
    if (layout.legacyExists) configFiles.push(layout.legacyFile)
    configFiles.push(...layout.patchFiles)
    configFiles.push(credFile())

    let current: string | undefined
    for (const file of configFiles) {
      const text = await readTextIfExists(file)
      if (text === null || file === credFile()) continue
      try {
        const js = parseDocument(text).toJS()
        const providers = providersOf(js, file === layout.legacyFile ? 'legacy' : 'patch') ?? {}
        const first = Object.values(providers).find((v: any) => v?.baseURL) as any
        if (first?.baseURL) {
          current = first.baseURL
          break
        }
      } catch (e) {
        return {
          installed: true,
          configFiles,
          note: t('{file} 解析失败：{err}', 'Failed to parse {file}: {err}', { file: path.basename(file), err: (e as Error).message }),
        }
      }
    }
    const profileNames = dshProfileNames(layout).filter((n) => layout.patchFiles.some((p) => path.basename(path.dirname(p)) === n))
    const scopeHint =
      profileNames.length > 1
        ? t(
            '检测到 {count} 个 dsh profile：{names}（接入默认全部写入，可用 --client-profile 只挑桌面版/网页版）',
            'Found {count} dsh profiles: {names} (attach writes to all of them by default; use --client-profile to pick only desktop/web)',
            { count: profileNames.length, names: biJoin('、', ', ', profileNames) }
          )
        : undefined
    const noConfig =
      configFiles.length === 1
        ? t(
            'dsh 已安装但尚无配置文件；运行一次 dsh 生成（新版 dsh 配置位于 profiles/<名称>/cordis.patch.yml）',
            'dsh is installed but has no config file yet; run dsh once to generate it (new dsh keeps its config at profiles/<name>/cordis.patch.yml)'
          )
        : undefined
    const note = [scopeHint, noConfig].filter(Boolean).join('；') || undefined
    return { installed: true, configFiles, current, note }
  },

  async planAttach(opts: AttachOptions, cfg: Config): Promise<PlanResult> {
    const layout = await dshLayout()
    const targets = filterProfiles(layout, opts.clientProfiles)

    // 解析路由：显式 --profile 优先（含字面名为 "default" 的 profile），否则 active_profile
    //（resolveRoute 与 zcode/workbuddy/provider-json 共用）
    const { routeName, profile, providerId, provider } = resolveRoute(opts, cfg)
    const { entries, mergedMeta, metaFilled, catalogUsed } = await buildDshModelEntries(
      providerId ?? '',
      provider?.models ?? {},
      cfg
    )

    const notes: string[] = []
    if (providerId && profile) {
      notes.push(routeModelNote(String(routeName), String(provider?.name ?? providerId), entries.length))
    } else {
      notes.push(
        t(
          '当前没有可解析的路由，未写入模型列表；dsh 要求 provider 必须声明 models，请先在控制台「应用」某个服务',
          'No resolvable route, so no model list was written; dsh requires a provider to declare models — apply a service in the console first'
        )
      )
    }
    if (catalogUsed && metaFilled > 0) {
      notes.push(
        t(
          '已从 dsh 内置模型目录补全 {count} 项上下文/输出元数据（回写到 ModelDock，其他客户端同样受益）',
          'Filled in {count} context/output metadata entries from the built-in dsh model catalog (written back to ModelDock, benefiting other clients too)',
          { count: metaFilled }
        )
      )
    }
    if (entries.length > 0) {
      notes.push(
        t(
          '未标注上下文/输出的模型由 dsh 默认值兜底（262144/32768）；可在控制台「编辑」里完善',
          'Models without context/output annotations fall back to dsh defaults (262144/32768); you can refine them under Edit in the console'
        )
      )
    }
    if (entries.length === 0) {
      notes.push(
        t(
          '警告：dsh 要求 provider 列出模型（"resolves no models"）；请先给该服务补充模型目录（网页编辑或 modeldock model refresh）',
          'Warning: dsh requires a provider to list models ("resolves no models"); add a model catalog to this service first (web editing or modeldock model refresh)'
        )
      )
    }

    const d = opts.direct
    // 直连按上游协议选 api 类型与端点（directWire 与 ZCode 共用 llm-pi wire 选择）；
    // 网关模式同样跟随当前路由服务的协议（gatewayWire 与 directWire 同规则）
    const { api: directApi, base: directBase } = directWire(d)
    const gw = gatewayWire(provider)

    const providerEntry: Record<string, unknown> = {
      api: directApi ?? gw.api,
      baseURL: directBase ?? gw.base(opts.gatewayPort),
      apiKeyEnv: 'MODELDOCK_TOKEN',
    }
    if (entries.length > 0) providerEntry.models = entries

    const defaultModel = profile?.default_model ?? (entries[0]?.id as string | undefined)
    if (d && d.protocol === 'responses') {
      notes.push(directResponsesNote('dsh'))
    }
    const changes: FileChange[] = []

    // 旧布局：settings.yaml
    if (layout.legacyExists) {
      const text = (await readTextIfExists(layout.legacyFile)) ?? ''
      const doc = parseDocument(text)
      doc.setIn([PROVIDERS_ROOT, 'providers', 'modeldock'], providerEntry)
      if (opts.setDefault) {
        if (defaultModel) {
          doc.setIn([AGENT_DEFAULT], { provider: 'modeldock', model: defaultModel })
          notes.push(
            t(
              'agent-default-model 已切换为 modeldock / {model}（settings.yaml）',
              'agent-default-model switched to modeldock / {model} (settings.yaml)',
              { model: defaultModel }
            )
          )
        } else {
          notes.push(
            t(
              '未指定 --profile 或该 profile 没有 default_model，跳过 agent-default-model 切换',
              'No --profile given or the profile has no default_model; skipped the agent-default-model switch'
            )
          )
        }
      }
      const legacyAfter = doc.toString()
      // 等值过滤：内容无变化不产生 change，稳态重接（周期 refresh/重复 attach）零快照零写盘
      if (legacyAfter !== text) {
        changes.push({
          path: layout.legacyFile,
          before: text,
          after: legacyAfter,
          note: t('新增/更新 modeldock provider（含模型列表，settings.yaml 旧布局）', 'Add/update the modeldock provider (with model list, legacy settings.yaml layout)'),
        })
      }
    }

    // 新布局：profiles/*/cordis.patch.yml
    for (const patchFile of targets.patchFiles) {
      const text = (await readTextIfExists(patchFile)) ?? ''
      const doc = parseDocument(text)
      ensureSeq(doc, patchFile)
      const seq = doc.contents as YAMLSeq
      let idx = patchEntryIndex(doc, PROVIDERS_ROOT)
      if (idx === -1) {
        seq.add({ id: PROVIDERS_ROOT, name: '@deepseek-ai/dsh-llm-pi-ai', config: { providers: { modeldock: providerEntry } } })
      } else {
        if (doc.getIn([idx, 'config']) == null) doc.setIn([idx, 'config'], {})
        if (doc.getIn([idx, 'config', 'providers']) == null) doc.setIn([idx, 'config', 'providers'], {})
        doc.setIn([idx, 'config', 'providers', 'modeldock'], providerEntry)
      }
      if (opts.setDefault) {
        if (defaultModel) {
          let j = patchEntryIndex(doc, AGENT_DEFAULT)
          if (j === -1) {
            seq.add({ id: AGENT_DEFAULT, name: '@deepseek-ai/dsh-agent-default-model', config: { provider: 'modeldock', model: defaultModel } })
          } else {
            if (doc.getIn([j, 'config']) == null) doc.setIn([j, 'config'], {})
            doc.setIn([j, 'config', 'provider'], 'modeldock')
            doc.setIn([j, 'config', 'model'], defaultModel)
          }
        }
      }
      const patchAfter = doc.toString()
      // 等值过滤：与 legacy 分支同理，稳态不产生 change
      if (patchAfter !== text) {
        changes.push({
          path: patchFile,
          before: text,
          after: patchAfter,
          note: t('新增/更新 modeldock provider（含模型列表，cordis.patch.yml 新布局）', 'Add/update the modeldock provider (with model list, cordis.patch.yml layout)'),
        })
      }
    }

    // 两者皆无（legacy 不存在且无 patch 目标）才走新建；等值过滤跳过的稳态不算「皆无」
    if (!layout.legacyExists && targets.patchFiles.length === 0) {
      if (!(await dirExists(layout.home))) {
        throw new AdapterError(
          t(
            '未找到 dsh 配置目录 {home}，请先安装 dsh 并运行一次生成配置（或设置 DSH_HOME 指向其目录）',
            'dsh config directory {home} not found; install dsh and run it once to generate the config (or set DSH_HOME to its directory)',
            { home: layout.home }
          )
        )
      }
      if (targets.profileDirs.length > 0) {
        for (const dir of targets.profileDirs) {
          const patchFile = path.join(dir, PATCH_FILE)
          const doc = parseDocument('')
          ensureSeq(doc, patchFile)
          ;(doc.contents as YAMLSeq).add({ id: PROVIDERS_ROOT, name: '@deepseek-ai/dsh-llm-pi-ai', config: { providers: { modeldock: providerEntry } } })
          if (opts.setDefault && defaultModel) {
            ;(doc.contents as YAMLSeq).add({ id: AGENT_DEFAULT, name: '@deepseek-ai/dsh-agent-default-model', config: { provider: 'modeldock', model: defaultModel } })
          }
          changes.push({
            path: patchFile,
            before: null,
            after: doc.toString(),
            note: t('新建 profile patch 并写入 modeldock provider', 'Create the profile patch and write the modeldock provider'),
          })
        }
      } else {
        // 旧布局 dsh（或尚未运行过的新版 dsh：启动时会把 settings.yaml 导入 profile）
        const doc = parseDocument(`${PROVIDERS_ROOT}:\n  providers: {}\n`)
        doc.setIn([PROVIDERS_ROOT, 'providers', 'modeldock'], providerEntry)
        if (opts.setDefault && defaultModel) {
          doc.setIn([AGENT_DEFAULT], { provider: 'modeldock', model: defaultModel })
        }
        changes.push({
          path: layout.legacyFile,
          before: null,
          after: doc.toString(),
          note: t('新建 settings.yaml 并写入 modeldock provider', 'Create settings.yaml and write the modeldock provider'),
        })
      }
    }

    if (opts.clientProfiles?.length) {
      const scopeNames = dshProfileNames({ ...layout, patchFiles: targets.patchFiles, profileDirs: targets.profileDirs })
      notes.push(
        t(
          '已按 --client-profile 限定范围，只写入：{names}（其余 profile 未动）',
          'Scoped by --client-profile, writing only: {names} (other profiles untouched)',
          { names: scopeNames.length > 0 ? biJoin('、', ', ', scopeNames) : t('（无匹配目标）', '(no matching target)') }
        )
      )
    }
    notes.push(
      t('写入目标：{targets}', 'Write targets: {targets}', {
        targets: biJoin('、', ', ', changes.map((ch) => path.relative(layout.home, ch.path) || ch.path)),
      })
    )
    notes.push(
      t(
        '已新增/更新 modeldock provider（不改写既有 provider 条目）；凭据经 apiKeyEnv 间接引用',
        'Added/updated the modeldock provider (existing provider entries untouched); credentials are referenced indirectly via apiKeyEnv'
      )
    )
    notes.push(
      d
        ? directAttachNote()
        : t('token 已写入 {file} 的 refs.MODELDOCK_TOKEN', 'The token was written to refs.MODELDOCK_TOKEN in {file}', { file: credFile() })
    )

    const ctext = (await readTextIfExists(credFile())) ?? ''
    const cdoc = parseDocument(ctext)
    // dsh-credentials-local 新版要求 version: 1，缺失按 pre-release flat layout 拒载，
    // dsh 启动直接失败（credentials 插件不起，全部依赖服务跟着瘫）；已有 version 不覆写
    if (cdoc.get('version') === undefined) cdoc.set('version', 1)
    cdoc.setIn(['refs', 'MODELDOCK_TOKEN'], d ? d.key : opts.token)
    const credAfter = cdoc.toString()
    if (credAfter !== ctext) {
      changes.push({
        path: credFile(),
        before: ctext === '' ? null : ctext,
        after: credAfter,
        note: d
          ? t('写入上游真实 Key（独立直连）', 'Write the upstream real key (direct mode)')
          : t('写入本地 token（非上游 key）', 'Write the local token (not an upstream key)'),
      })
    }

    return {
      changes,
      notes,
      providerModelMeta:
        Object.keys(mergedMeta).length > 0 && providerId ? { provider: providerId, models: mergedMeta } : undefined,
      writtenBaseUrl: directBase,
    }
  },

  async planDetach(cfg: Config): Promise<PlanResult> {
    const layout = await dshLayout()
    const changes: FileChange[] = []

    // 旧布局
    if (layout.legacyExists) {
      const text = (await readTextIfExists(layout.legacyFile)) ?? ''
      const doc = parseDocument(text)
      const js = doc.toJS() as Record<string, any>
      const entry = js?.[PROVIDERS_ROOT]?.providers?.modeldock
      if (entry && isOursGatewayUrl(typeof entry.baseURL === 'string' ? entry.baseURL : undefined, 'dsh', cfg)) {
        doc.deleteIn([PROVIDERS_ROOT, 'providers', 'modeldock'])
        if (js?.[AGENT_DEFAULT]?.provider === 'modeldock') {
          doc.deleteIn([AGENT_DEFAULT])
        }
        changes.push({
          path: layout.legacyFile,
          before: text,
          after: doc.toString(),
          note: t('移除 modeldock provider（settings.yaml）', 'Remove the modeldock provider (settings.yaml)'),
        })
      }
    }

    // 新布局
    for (const patchFile of layout.patchFiles) {
      const text = (await readTextIfExists(patchFile)) ?? ''
      const doc = parseDocument(text)
      const js = doc.toJS()
      if (!Array.isArray(js)) continue
      const seq = ensureSeq(doc, patchFile)
      let changed = false

      const idx = js.findIndex((e: any) => e?.id === PROVIDERS_ROOT)
      let delIndex = -1
      if (idx >= 0) {
        const entry = js[idx]?.config?.providers?.modeldock
        if (entry && isOursGatewayUrl(typeof entry.baseURL === 'string' ? entry.baseURL : undefined, 'dsh', cfg)) {
          doc.deleteIn([idx, 'config', 'providers', 'modeldock'])
          const providers = doc.getIn([idx, 'config', 'providers'])
          if (isMap(providers) && providers.items.length === 0) doc.deleteIn([idx, 'config', 'providers'])
          const cfgNode = doc.getIn([idx, 'config'])
          if (isMap(cfgNode) && cfgNode.items.length === 0) delIndex = idx
          changed = true
        }
      }
      const j = js.findIndex((e: any) => e?.id === AGENT_DEFAULT)
      let delJ = -1
      if (j >= 0 && js[j]?.config?.provider === 'modeldock') {
        delJ = j
        changed = true
      }
      // 两个下标都取自对象快照 js；先删高下标再删低下标，避免第一次删除改动活序列后第二处下标错位
      for (const k of [delIndex, delJ].filter((x) => x >= 0).sort((a, b) => b - a)) {
        seq.delete(k)
      }
      if (changed) {
        changes.push({
          path: patchFile,
          before: text,
          after: doc.toString(),
          note: t('移除 modeldock provider（cordis.patch.yml）', 'Remove the modeldock provider (cordis.patch.yml)'),
        })
      }
    }

    if (changes.length === 0) {
      return { changes: [], notes: [t('dsh 当前未指向 ModelDock 网关，无需改动', 'dsh is not pointing at the ModelDock gateway; nothing to change')] }
    }
    // 凭据文件不存在时不要凭空创建一个空的 .credentials.yaml
    const ctext = await readTextIfExists(credFile())
    if (ctext !== null) {
      const cdoc = parseDocument(ctext)
      cdoc.deleteIn(['refs', 'MODELDOCK_TOKEN'])
      cdoc.deleteIn(['refs', 'MODELRDOCK_TOKEN']) // 旧拼写（<0.3.1）一并清理
      changes.push({ path: credFile(), before: ctext, after: cdoc.toString(), note: t('移除本地 token', 'Remove the local token') })
    }
    return {
      changes,
      notes: [t('恢复接管前的完整原配置请用快照：modeldock restore dsh', 'To restore the full pre-attach config, use the snapshot: modeldock restore dsh')],
    }
  },

  async status(cfg: Config, port: number): Promise<AdapterStatus> {
    const layout = await dshLayout()
    if (!(await dshInstalled(layout))) return { installed: false, attached: false }
    try {
      let base: string | undefined
      let models = 0
      if (layout.legacyExists) {
        const js = parseDocument((await readTextIfExists(layout.legacyFile)) ?? '').toJS() as Record<string, any>
        const entry = js?.[PROVIDERS_ROOT]?.providers?.modeldock
        if (entry?.baseURL) {
          base = String(entry.baseURL)
          models = Array.isArray(entry?.models) ? entry.models.length : 0
        }
      }
      if (base === undefined) {
        for (const patchFile of layout.patchFiles) {
          const js = parseDocument((await readTextIfExists(patchFile)) ?? '').toJS()
          const entry = Array.isArray(js) ? (js as any[]).find((e) => e?.id === PROVIDERS_ROOT)?.config?.providers?.modeldock : undefined
          if (entry?.baseURL) {
            base = String(entry.baseURL)
            models = Array.isArray(entry?.models) ? entry.models.length : 0
            break
          }
        }
      }
      return {
        installed: true,
        attached: !!cfg.harness['dsh'],
        pointing: isGatewayBase(base, port) ? 'gateway' : base ? 'other' : 'unknown',
        detail:
          (base ?? t('(无 modeldock provider)', '(no modeldock provider)')) +
          (models > 0 ? t(' · {count} 个模型', ' · {count} models', { count: models }) : ''),
      }
    } catch {
      return { installed: true, attached: false, pointing: 'unknown', detail: t('dsh 配置解析失败', 'Failed to parse the dsh config') }
    }
  },
}
