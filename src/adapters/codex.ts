import path from 'node:path'
import { homeDir, modeldockDir, readTextIfExists, t } from '../util/index.js'
import type { Config } from '../config/types.js'
import {
  AdapterError,
  gatewayBaseOpenAI,
  type AdapterStatus,
  type AttachOptions,
  type DetectResult,
  type FileChange,
  type HarnessAdapter,
  type PlanResult,
} from './types.js'
import { reorderTomlRoot, tomlParse, tomlStringify } from './format.js'
import { cliPresent, residueNote } from './presence.js'
import { changeIfChanged, directAttachNote, directResponsesEndpointNote, ensurePlainObjectField, noChangeResult, oursEntryUrl } from './shared.js'
import { resolveModelMeta } from '../providers/resolve.js'
import { CODEX_BASE_INSTRUCTIONS } from './codex-base-prompt.js'

const configFile = () => path.join(homeDir(), '.codex', 'config.toml')

/** 本体双信号：~/.codex 不随卸载删除，配置在而 codex 命令缺席视为卸载残留，判未安装 */
function present(): boolean {
  return cliPresent('codex', 'codex', { sandboxIsolated: true })
}

// 令牌内联进 http_headers 的 Authorization（Bearer），不写环境变量 → 任何终端/IDE 运行 codex 都能认证，
// 不依赖用户的 shell 启动文件。旧版曾往 shell rc 写 export，detach 时清理其残留哨兵段。
const RC_BEGIN = '# >>> modeldock codex env >>>'
const RC_END = '# <<< modeldock codex env <<<'
const TOKEN_ENV = 'MODELDOCK_CODEX_TOKEN'

/** detach 清理旧版哨兵段时扫描全部已知 shell rc：哨兵是 ModelDock 自己的标记，全量扫描幂等且安全。
 *  不按 SHELL 过滤——用户可能在接入与断开之间换过 shell（macOS 是 zsh、Linux/CI 是 bash），过滤会漏清。 */
function rcCandidates(): string[] {
  return ['.zshrc', '.zprofile', '.bashrc', '.bash_profile', '.profile'].map((f) => path.join(homeDir(), f))
}

/** detach 时清理旧版接入残留的哨兵段（新版内联 http_headers，不再写环境变量）。
 *  空行收敛只作用于删除接缝：哨兵段连同其紧邻的前后空行一起匹配，接缝统一收敛为至多一个
 *  空行——不碰用户 rc 文件其他位置的空行排版（此前 `\n{3,}` 全局 replace 会顺手抹掉用户自己的排版）。 */
function stripEnvBlock(before: string): string {
  const re = new RegExp(
    '(?:\\r?\\n)*[^\\n]*' + RC_BEGIN + '[\\s\\S]*?' + RC_END + '[^\\n]*(?:\\r?\\n|$)(?:\\r?\\n)*'
  )
  return before.replace(re, (_m: string, off: number) => (off === 0 ? '' : '\n\n'))
}

interface CodexConfig {
  model_provider?: string
  model_providers?: Record<string, Record<string, unknown>>
  /** codex 自身 profiles（codex -p <id> 选择）：ModelDock 为每条路由写一份（model_provider
   *  =modeldock + model=该路由默认模型），路由切换免控制台往返。detach 只收自己的条目。 */
  profiles?: Record<string, Record<string, unknown>>
  /** 根级窗口/输出上限（作用于当前激活模型；接入随默认模型写入，detach 随路由接管收回） */
  model_context_window?: number
  model_max_output_tokens?: number
  /** /model 选择器的模型元数据目录文件（codex 0.4x+ 官方机制，小米 token plan 官方模板同款）：
   *  指向 JSON 文件（{ models: [...] }），选择器据此列出内置 GPT 预设之外的模型。
   *  不写此键时选择器只渲染编译进二进制的 OpenAI 静态预设——自定义 provider 的模型
   *  （网关路由的 glm/mimo 等）永远不会出现，且从内置预设选中即 400（路由目录不含）。 */
  model_catalog_json?: string
  /** 内建 web_search 工具开关（小米官方模板写 "disabled"）。codex 0.167 缺省把
   *  web_search 工具类型随请求发出，多数非 OpenAI 上游（小米 token plan 实测）直接
   *  400「tool type 'web_search' is not supported」——接入时缺省关、用户显式值不动。 */
  web_search?: string | boolean
  [k: string]: unknown
}

/** ModelDock 生成的 codex catalog 文件落点（自家目录，config.toml 只写指针）。
 *  惰性求值：MODELRDOCK_FAKE_HOME（测试）在调用时才生效。 */
export const codexCatalogPath = () => path.join(modeldockDir(), 'codex-catalog.json')

/** supported_reasoning_levels 通用四档：catalog 条目的 effort 菜单（文案对齐小米官方目录风格）。 */
const REASONING_LEVELS = [
  { effort: 'none', description: 'No extra reasoning for faster responses' },
  { effort: 'low', description: 'Fast responses with lighter reasoning' },
  { effort: 'medium', description: 'Balances speed and reasoning depth for everyday tasks' },
  { effort: 'high', description: 'Greater reasoning depth for complex problems' },
]

/**
 * 由路由服务商模型目录生成 codex catalog（/model 选择器数据源，model_catalog_json 机制）。
 * 字段投影：slug=模型 id（= codex 发出的模型名 = 网关路由键，picker 选谁路由通谁）；
 * context_window=resolveModelMeta 解析链（只补空）；input_modalities 按视觉能力链
 * （capabilities 含 'vision' → text+image）。目录空返回 null（fail-open：不写键，
 * picker 回落内置预设）。
 * 必填字段（codex 0.167 serde 实测逐轮探明，缺一拒载）：shell_type / support_verbosity /
 * truncation_policy / experimental_supported_tools / base_instructions（或
 * model_messages.instructions_template 二选一）。base_instructions 填 codex 自家默认
 * 指令（codex-base-prompt.ts，0.167 原文）= 与「无 catalog 时 codex 对未知模型的行为」
 * 一致；其余行为位取小米官方 catalog 同款中性值。不注入任何第三方人设/专属提示词。
 */
export function buildCodexCatalog(cfg: Config, providerId: string): { models: Record<string, unknown>[] } | null {
  const provider = cfg.providers[providerId]
  const entries = Object.entries(provider?.models ?? {})
  if (!entries.length) return null
  const models = entries.map(([id, meta], i) => {
    const resolved = resolveModelMeta(id, meta, { baseUrl: provider!.base_url })
    const entry: Record<string, unknown> = {
      slug: id,
      display_name: meta?.display_name ?? id,
      description: `${provider?.name || providerId}: ${id}`,
      default_reasoning_level: 'medium',
      supported_reasoning_levels: REASONING_LEVELS,
      shell_type: 'unified_exec',
      support_verbosity: false,
      truncation_policy: { mode: 'tokens', limit: 10000 },
      experimental_supported_tools: [],
      base_instructions: CODEX_BASE_INSTRUCTIONS,
      visibility: 'list',
      supported_in_api: true,
      priority: i,
    }
    if (resolved?.context_window) {
      entry.context_window = resolved.context_window
      entry.max_context_window = resolved.context_window
    }
    entry.input_modalities = resolved?.capabilities?.includes('vision') ? ['text', 'image'] : ['text']
    return entry
  })
  return { models }
}

export const codexAdapter: HarnessAdapter = {
  id: 'codex',
  label: 'Codex',
  directMode: true,
  // setDefault 时把路由 profile 的默认模型烤进 config.toml 的 root.model，路由切换后需重写跟随
  bakesModels: true,
  // model_providers.modeldock 固定 wire_api='responses'，只讲 Responses 协议
  clientProtocols: ['responses'],
  install: {
    command: 'npm i -g @openai/codex',
    uninstall: 'npm uninstall -g @openai/codex',
    needsNode: true,
    probe: 'codex',
    get guide() {
      return t(
        'Codex CLI 是终端命令（Node 程序）。点「安装并接入」由 ModelDock 自动完成：本机没有 Node 时自动下载托管 Node 运行时，npm 安装自动走大陆镜像，装完自动写配置。手动兜底：npm i -g @openai/codex --registry=https://registry.npmmirror.com（npm 官方源大陆常不可达），装完运行一次 codex 完成初始化。',
        'Codex CLI is a terminal command (a Node program). Click Install & attach and ModelDock handles it: if this machine has no Node.js, the managed Node runtime is downloaded first, npm runs against the official registry, and the config is written automatically. Manual fallback: npm i -g @openai/codex, then run codex once to initialize.'
      )
    },
    // developers.openai.com 大陆 403（实测），换成可达且含安装用法的镜像包页
    homepage: 'https://npmmirror.com/package/@openai/codex',
    bootstrap: { path: () => configFile(), content: '' },
  },

  async detect(): Promise<DetectResult> {
    const p = configFile()
    const text = await readTextIfExists(p)
    if (text === null) {
      // 装了 codex 但从未运行过就没有 config.toml（Windows 新装最常见）：只认配置文件
      // 会把"已安装未初始化"误报成未安装，引导用户重复 npm 安装
      if (present()) {
        return {
          installed: true,
          configFiles: [],
          note: t(
            '已安装 codex 命令，但还没有 ~/.codex/config.toml（首次运行 codex 会自动生成）；可直接「一键接入」',
            'The codex command is installed, but ~/.codex/config.toml does not exist yet (created on first run of codex); you can attach directly'
          ),
        }
      }
      return {
        installed: false,
        configFiles: [],
        note: t('未找到 codex 命令，也未找到 ~/.codex/config.toml', 'codex command not found and ~/.codex/config.toml not found'),
      }
    }
    if (!present()) {
      return {
        installed: false,
        configFiles: [],
        note: residueNote([p], 'Codex'),
      }
    }
    try {
      const root = tomlParse(text) as CodexConfig
      const mp = root.model_providers?.[root.model_provider ?? '']
      return {
        installed: true,
        configFiles: [p],
        current: (mp?.base_url as string) ?? t('(内置 provider)', '(built-in provider)'),
      }
    } catch (e) {
      return { installed: true, configFiles: [p], note: t('config.toml 解析失败：{err}', 'Failed to parse config.toml: {err}', { err: (e as Error).message }) }
    }
  },

  async planAttach(opts: AttachOptions, cfg: Config): Promise<PlanResult> {
    if (!present()) {
      throw new AdapterError(
        t('未找到 codex 命令——Codex 可能已卸载（~/.codex 只是残留配置）', 'codex command not found — Codex may have been uninstalled (~/.codex is leftover config only)'),
        t('请先安装 Codex CLI 后再接入', 'Install Codex CLI first, then attach')
      )
    }
    const p = configFile()
    const text = await readTextIfExists(p)
    let root: CodexConfig = {}
    if (text !== null && text.trim() !== '') {
      try {
        root = tomlParse(text) as CodexConfig
      } catch (e) {
        throw new AdapterError(t('{path} 解析失败，已中止：{err}', 'Failed to parse {path}; aborted: {err}', { path: p, err: (e as Error).message }))
      }
    }
    // 字段级守卫：model_providers 被手编成字符串/数字时，下面赋值会以裸 TypeError 冒顶
    ensurePlainObjectField(root.model_providers, 'model_providers', p)
    const providers = (root.model_providers ??= {})
    const d = opts.direct
    // codex 只讲 Responses 协议：直连时用上游的 responses 端点（未配置则回退默认地址并在 notes 提示）
    const directBase = d ? (d.base_url_responses ?? d.base_url) : undefined
    const directNotes: string[] = []
    providers['modeldock'] = {
      name: 'ModelDock',
      base_url: directBase ?? gatewayBaseOpenAI(opts.gatewayPort),
      http_headers: { Authorization: `Bearer ${d ? d.key : opts.token}` },
      wire_api: 'responses',
    }
    if (d) {
      // 直连守卫（2026-11-09）：codex 只讲 OpenAI Responses 协议（新版 CLI 已移除 wire_api=chat，
      // 多源实证报「wire_api chat is no longer supported」）——Anthropic 协议端点结构性不可直连，
      // 提前给可操作报错；openai/responses 协议的 base_url 回退保持合法（小米 token plan 官方
      // 模板即此形态：base_url 本身暴露 /responses），但 chat-completions-only 上游必败，note 强提示。
      if (d.protocol === 'anthropic') {
        throw new AdapterError(
          t('codex 只讲 OpenAI Responses 协议，无法直连 Anthropic 协议端点', 'Codex speaks the OpenAI Responses protocol only and cannot attach directly to an Anthropic-protocol endpoint'),
          t('改走网关（网关按服务商协议转发），或选暴露 Responses 端点的服务做直连', 'Attach through the gateway instead, or pick a provider that exposes a Responses endpoint for direct mode')
        )
      }
      directNotes.push(directAttachNote(directBase))
      if (!d.base_url_responses) directNotes.push(directResponsesEndpointNote())
      directNotes.push(
        t(
          '注意：新版 codex 仅支持 Responses 协议（wire_api=chat 已移除）——回退 base_url 仅当该地址本身可响应 /responses 时可用（小米 token plan 官方模板即此形态）；chat-completions-only 上游请改走网关',
          'Note: recent Codex builds support the Responses protocol only (wire_api=chat removed) — the base_url fallback works only if that endpoint itself serves /responses (the Xiaomi token plan official template is exactly this shape); for chat-completions-only providers use the gateway'
        )
      )
    }
    if (opts.setDefault) {
      root.model_provider = 'modeldock'
      const def = opts.profile && cfg.profiles[opts.profile] ? cfg.profiles[opts.profile].default_model : undefined
      if (def) {
        root.model = def
        // Codex 对不在其内置表的模型按假定窗口处理（上下文余量显示与压实时机失真）：
        // 随默认模型一并写入窗口与最大输出（解析链见 providers/resolve.ts，只补空）。
        // 根级键作用于当前激活模型，refreshBakedModelClients 重烙时随路由切换同步更新。
        const prof = cfg.profiles[opts.profile!]!
        const provider = prof.provider ? cfg.providers[prof.provider] : undefined
        const meta = resolveModelMeta(def, provider?.models?.[def], { baseUrl: provider?.base_url })
        if (meta?.context_window) root.model_context_window = meta.context_window
        if (meta?.max_output) root.model_max_output_tokens = meta.max_output
      }
    }

    // /model 选择器目录（model_catalog_json 机制）：把当前路由服务商的模型目录投影成
    // catalog 文件——选择器从此只列路由真支持的模型，「从内置预设选中 → 上游 400」与
    // 「选择器里看不到网关模型」两个问题同根消除（2026-11-09 实证：codex 0.167 的
    // 选择器数据源 = 编译进二进制的 OpenAI 静态预设 + 本文件，从不查询 provider）。
    // 直连模式不生成（上游模型目录 ModelDock 未必掌握）；目录空 fail-open。
    const catalogNotes: string[] = []
    const catalogChanges: FileChange[] = []
    if (!d && opts.profile && cfg.profiles[opts.profile]?.provider) {
      const provId = cfg.profiles[opts.profile]!.provider!
      const catalog = buildCodexCatalog(cfg, provId)
      if (catalog) {
        const catPath = codexCatalogPath()
        const existing = root.model_catalog_json
        if (typeof existing === 'string' && existing && existing !== catPath) {
          catalogNotes.push(
            t(
              '用户已自设 model_catalog_json（{v}），ModelDock 不覆盖——/model 目录以用户文件为准',
              'model_catalog_json is user-set ({v}); ModelDock leaves it untouched — the /model catalog follows the user file',
              { v: existing }
            )
          )
        } else {
          root.model_catalog_json = catPath
          const json = `${JSON.stringify(catalog, null, 2)}\n`
          const catChange = changeIfChanged(
            catPath,
            await readTextIfExists(catPath),
            json,
            t('生成 codex /model 目录（当前路由服务商模型）', 'Generate the codex /model catalog (current route provider models)')
          )
          if (catChange) catalogChanges.push(catChange)
          // web_search 工具缺省关（2026-11-09 实测：小米 token plan 上游对独立 web_search
          // 工具类型直接 400；小米官方模板亦写 disabled）。仅补空——用户显式配置不动。
          if (root.web_search === undefined) {
            root.web_search = 'disabled'
            catalogNotes.push(
              t(
                '已缺省 web_search=disabled（多数非 OpenAI 上游不支持该工具类型，小米官方模板同款）；需要联网检索时手动改 web_search 值',
                'Set web_search=disabled by default (most non-OpenAI upstreams reject the standalone web_search tool type; same as the Xiaomi official template); set web_search manually to enable it'
              )
            )
          }
        }
      }
    }

    // codex profiles 多路由（codex-rebake-profiles 卡）：为每条 ModelDock 路由写
    // [profiles.<id>]（model_provider=modeldock + model=该路由默认模型），`codex -p <id>`
    // 一键切换路由，免控制台往返。守卫：同名 profile 已被用户自设（model_provider 不是
    // 我们或非对象）→ 跳过不覆盖；我们自己的旧条目随 planAttach 刷新（路由切换重烤时
    // 跟随新默认模型）。detach 只收 model_provider=modeldock 的条目。
    ensurePlainObjectField(root.profiles, 'profiles', p)
    const rootProfiles = (root.profiles ??= {})
    const skippedProfiles: string[] = []
    for (const [pid, prof] of Object.entries(cfg.profiles)) {
      const model = prof.default_model
      // default_model 必须在 provider 模型目录内（目录空/模型不在目录 → 不写，防烤出
      // 必 400 的死条目——gpt-6-astra 失联教训的路由侧对账）
      if (!model || !prof.provider || !cfg.providers[prof.provider]?.models?.[model]) continue
      const existing = rootProfiles[pid]
      if (existing && existing.model_provider !== undefined && existing.model_provider !== 'modeldock') {
        skippedProfiles.push(pid)
        continue
      }
      rootProfiles[pid] = { model_provider: 'modeldock', model }
    }
    const profileNotes: string[] = []
    if (skippedProfiles.length) {
      profileNotes.push(
        t(
          '同名 profiles {ids} 为用户自设，ModelDock 不覆盖（codex -p 以用户定义为准）',
          'User-defined profiles {ids} are left untouched (codex -p follows the user definitions)',
          { ids: skippedProfiles.join(', ') }
        )
      )
    }

    const body = tomlStringify(reorderTomlRoot(root) as Record<string, unknown>)
    const after = body.endsWith('\n') ? body : body + '\n'
    const notes = [
      ...directNotes,
      ...catalogNotes,
      ...profileNotes,
      t(
        '令牌内联为 http_headers 的 Authorization（Bearer），无需任何环境变量，任何终端/IDE 直接可用',
        'The token is inlined as the http_headers Authorization (Bearer) — no environment variables needed, works in any terminal/IDE'
      ),
      t(
        'wire_api=responses 走 OpenAI Responses API（新版 Codex 必需）；网关自动转发到支持 responses 协议的服务商，缺该协议端点的服务商请在「编辑服务」里补填',
        'wire_api=responses uses the OpenAI Responses API (required by current Codex); the gateway forwards to providers that support the responses protocol — fill in that endpoint under Edit Service for providers that lack it'
      ),
    ]
    if (text !== null && /^\s*#/m.test(text)) {
      notes.push(
        t(
          '提示: config.toml 含注释行；TOML 重写无法保留注释，attach 后原注释会丢失（原文已自动快照，可 restore 找回）',
          'Note: config.toml contains comment lines; rewriting TOML cannot preserve comments and they will be lost after attach (the original is snapshotted automatically and can be restored)'
        )
      )
    }
    if (opts.setDefault) notes.push(t('已把默认 provider 切到 modeldock 并设默认模型（--set-default）', 'Switched the default provider to modeldock and set the default model (--set-default)'))
    else notes.push(t('未改动默认 provider，需要路由到 ModelDock 请加 --set-default', 'Default provider unchanged; add --set-default to route through ModelDock'))

    return {
      changes: [
        changeIfChanged(p, text, after, t('注册 modeldock provider', 'Register the modeldock provider')),
        ...catalogChanges,
      ].filter((c): c is NonNullable<typeof c> => c !== null),
      notes,
      writtenBaseUrl: d ? directBase : undefined,
    }
  },

  async planDetach(cfg: Config): Promise<PlanResult> {
    const p = configFile()
    const text = await readTextIfExists(p)
    const changes: FileChange[] = []
    if (text !== null) {
      let root: CodexConfig
      try {
        root = tomlParse(text) as CodexConfig
      } catch {
        return { changes: [], notes: [t('config.toml 无法解析，跳过', 'config.toml cannot be parsed; skipped')] }
      }
      const entry = root.model_providers?.modeldock
      if (entry && oursEntryUrl(entry.base_url, 'codex', cfg)) {
        delete root.model_providers!.modeldock
        if (root.model_provider === 'modeldock') {
          delete root.model_provider
          // 接入随默认模型写入的窗口/输出上限一并收回（仅路由由我们接管时）；接入前的
          // 用户手设值有 attach 快照兜底，可 restore 找回
          delete root.model_context_window
          delete root.model_max_output_tokens
        }
        // catalog 指针 / web_search 缺省 / profiles 条目的写入不受 setDefault 门控
        // （attach 不带 --set-default 也写），收回同样在 model_provider 门控之外——
        // 否则无 setDefault 的接入 detach 后三处残留（/model 选择器仍列 ModelDock 目录、
        // web_search 被钉 disabled、codex -p 撞失效路由）。
        // catalog 指针仅指向 ModelDock 自家文件时收回（用户自设的他值不动）
        if (root.model_catalog_json === codexCatalogPath()) delete root.model_catalog_json
        // web_search 只收我们补写的缺省值 'disabled'（attach 仅补空、只写这一个值）；
        // 用户改过的任何其他值不动。用户显式配的 'disabled' 与补写值无法区分，一并收回
        // （接入前快照可 restore 找回，与窗口键同一兜底口径）
        if (root.web_search === 'disabled') delete root.web_search
        // 自家 profiles 条目收回（model_provider=modeldock 的才动；用户自设保留）；
        // 收空后整键删除，不残留空表
        const ups = root.profiles
        if (ups && typeof ups === 'object') {
          for (const [pid, pentry] of Object.entries(ups)) {
            if (pentry && typeof pentry === 'object' && (pentry as Record<string, unknown>).model_provider === 'modeldock') {
              delete ups[pid]
            }
          }
          if (Object.keys(ups).length === 0) delete root.profiles
        }
        const c2 = changeIfChanged(p, text, tomlStringify(reorderTomlRoot(root)))
        if (c2) changes.push(c2)
      }
    }
    // 还原 shell 启动文件里由接入写入的令牌，其余内容不动
    for (const cand of rcCandidates()) {
      const cur = await readTextIfExists(cand)
      if (cur !== null && cur.includes(RC_BEGIN)) {
        const c3 = changeIfChanged(
          cand,
          cur,
          stripEnvBlock(cur),
          t('移除 {file} 里的 {env}', 'Remove {env} from {file}', { file: path.basename(cand), env: TOKEN_ENV })
        )
        if (c3) changes.push(c3)
      }
    }
    if (changes.length === 0) return noChangeResult([t('Codex 未指向 ModelDock 网关，无需改动', 'Codex is not pointing at the ModelDock gateway; nothing to change')])
    return { changes, notes: [] }
  },

  async status(cfg: Config, port: number): Promise<AdapterStatus> {
    const text = await readTextIfExists(configFile())
    if (text === null) {
      // 命令在而配置未生成：算已安装（未接入），attach 时会自动创建 config.toml
      if (present()) {
        return {
          installed: true,
          attached: false,
          pointing: 'unknown',
          detail: t('已安装，尚未初始化（无 ~/.codex/config.toml）', 'Installed but not initialized (no ~/.codex/config.toml)'),
        }
      }
      return { installed: false, attached: false }
    }
    if (!present()) {
      return {
        installed: false,
        attached: !!cfg.harness['codex'],
        pointing: 'unknown',
        detail: t('检测到配置残留，但未找到 codex 命令（可能已卸载）', 'Found leftover config but the codex command is missing (may have been uninstalled)'),
      }
    }
    try {
      const root = tomlParse(text) as CodexConfig
      const base = root.model_providers?.modeldock?.base_url as string | undefined
      return {
        installed: true,
        attached: !!cfg.harness['codex'],
        pointing: base === gatewayBaseOpenAI(port) ? 'gateway' : base ? 'other' : 'unknown',
        detail: base ?? t('(未注册 modeldock provider)', '(no modeldock provider registered)'),
      }
    } catch {
      return { installed: true, attached: false, pointing: 'unknown', detail: t('config.toml 解析失败', 'Failed to parse config.toml') }
    }
  },
}
