import path from 'node:path'
import { homeDir, readTextIfExists, t } from '../util/index.js'
import type { Config, ModelMeta } from '../config/types.js'
import {
  AdapterError,
  gatewayBase,
  isOursGatewayUrl,
  type AdapterStatus,
  type AttachOptions,
  type DetectResult,
  type FileChange,
  type HarnessAdapter,
  type PlanResult,
} from './types.js'
import { detectJsonIndent, parseJsonStrict, serializeJson } from './format.js'
import { desktopPresent, cliPresent, type AppPresent } from './presence.js'
import { resolvedModelView } from '../providers/resolve.js'

/**
 * ZCode 的 provider 存储有两代：
 * - 旧版：config.json 的 provider 表。新版 ZCode 启动时经 importLegacyPersonalProviderConfig
 *   一次性迁移，且迁移代码显式跳过所有 `builtin:` 前缀条目（builtin:bigmodel/zai 除外，
 *   会被映射进官方家族模板）——因此旧版写入的 `builtin:modeldock` 永远不会被显示，只能清理。
 * - 现行：provider_config.json（个人供应商存储，ZCode 运行中轮询热加载）。用户在 ZCode
 *   设置里手动添加的自定义供应商都落在这里，ModelDock 也写这里。
 */
const legacyConfigFile = () => path.join(homeDir(), '.zcode', 'v2', 'config.json')
const personalConfigFile = () => path.join(homeDir(), '.zcode', 'v2', 'provider_config.json')
const LEGACY_ENTRY_ID = 'builtin:modeldock'
const PROVIDER_ID = 'modeldock'
const PROVIDER_NAME = 'ModelDock'

interface ZcodePersonalRule {
  providerId?: string
  templateId?: string | null
  providerName?: string
  enabled?: boolean
  config?: {
    group?: string
    access?: { type?: string; apiKey?: string }
    api?: { type?: string; baseUrl?: string }
    personalModelIds?: string[]
    modelOrder?: string[]
    [k: string]: unknown
  }
  [k: string]: unknown
}

interface ZcodePersonalConfig {
  schemaVersion?: number
  revision?: number
  config?: {
    providerOrder?: string[]
    providerConfigRules?: { providerRules?: ZcodePersonalRule[]; templateRules?: unknown[] }
    modelConfigRules?: {
      providerModelRules?: unknown[]
      manualProviderModelRules?: Array<{ providerId?: string; modelId?: string; config?: Record<string, unknown> }>
    }
    [k: string]: unknown
  }
  [k: string]: unknown
}

function freshPersonalConfig(): ZcodePersonalConfig {
  return {
    schemaVersion: 1,
    config: {
      providerConfigRules: { providerRules: [] },
      modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
    },
  }
}

/**
 * 手动模型定义（modelConfigRules.manualProviderModelRules）。ZCode 对该配置做全字段校验
 * （缺任一必填布尔/对象会导致整份个人配置加载失败，见运行日志 ZodError）：
 * properties 需能力布尔位 + inputFormat，optionSpecs 需 reasoningLevel；上下文/输出未知时
 * 不写该条规则——ZCode 对没有手动规则的模型按「推荐配置」兜底，仍会正常显示。
 */
function modelRuleConfig(meta: ModelMeta | undefined): Record<string, unknown> | undefined {
  if (!meta?.context_window || !meta.max_output) return undefined
  return {
    enabled: true,
    properties: {
      contextWindow: meta.context_window,
      inputFormat: { supportsImage: false, supportsVideo: false, supportsPdf: false },
      supportsJsonSchemaOutput: false,
      supportsNativeWebSearch: false,
      supportsMidConversationSystem: false,
    },
    optionSpecs: {
      // 与 ZCode 内置兜底规则一致：提供推理开关但不改写请求体（map 求值为空对象）
      reasoningLevel: { values: ['disabled', 'enabled'], map: '{}' },
      maxOutputTokens: { max: meta.max_output },
    },
  }
}

function findPersonalRule(root: ZcodePersonalConfig): ZcodePersonalRule | undefined {
  const rules = root.config?.providerConfigRules?.providerRules
  return Array.isArray(rules) ? rules.find((r) => r?.providerId === PROVIDER_ID) : undefined
}

/**
 * ZCode 本体探测（双信号之一，统一逻辑见 presence.ts）：zcode 命令在 PATH 上（开源 CLI 形态），
 * 或桌面应用安装痕迹（Windows 注册表卸载项/常见安装目录、macOS /Applications）。
 * 探测出错或平台未知时回退按配置文件判定——宁可维持旧行为，也不把装好的 ZCode 误报成未安装。
 */
async function appPresent(): Promise<AppPresent> {
  if (cliPresent('zcode', 'zcode')) return true
  return desktopPresent(['zcode'], 'zcode')
}

export const zcodeAdapter: HarnessAdapter = {
  id: 'zcode',
  label: 'ZCode',
  directMode: true,
  bakesModels: true, // personalModelIds 烙着模型列表，全局切换后需重写（见 refreshBakedModelClients）
  install: {
    get guide() {
      return t(
        'ZCode 为独立的 AI 客户端（桌面版 / CLI，非 npm 包），暂不支持由 ModelDock 自动安装。请从下方官网按你的平台下载安装包，装好后运行一次生成配置，再回来点「重新检测」即可一键接入。',
        'ZCode is a standalone AI client (desktop app / CLI, not an npm package); ModelDock cannot install it automatically yet. Download the installer for your platform from the official site below, run it once to generate the config, then come back and click Re-detect to attach.'
      )
    },
    homepage: 'https://zcode.z.ai',
  },

  async detect(): Promise<DetectResult> {
    const personalPath = personalConfigFile()
    const legacyPath = legacyConfigFile()
    const personalText = await readTextIfExists(personalPath)
    const legacyText = await readTextIfExists(legacyPath)
    const present = await appPresent()
    if (personalText === null && legacyText === null) {
      if (present === true) {
        return {
          installed: true,
          configFiles: [],
          note: t(
            '已安装 ZCode，但还没有 ~/.zcode/v2/ 下的配置（首次启动会生成）；可直接「一键接入」，接入时会自动创建',
            'ZCode is installed but has no config under ~/.zcode/v2/ yet (generated on first launch); you can attach directly and it will be created for you'
          ),
        }
      }
      return {
        installed: false,
        configFiles: [],
        note: t(
          '未找到 ~/.zcode/v2/ 下的 provider_config.json 或 config.json，也未找到 ZCode 本体；请先安装并运行一次 ZCode',
          'Neither provider_config.json nor config.json was found under ~/.zcode/v2/, and the ZCode app itself was not found; install ZCode and run it once'
        ),
      }
    }
    const configFiles = [personalPath, legacyPath].filter(
      (_, i) => (i === 0 ? personalText : legacyText) !== null
    )
    if (present === false) {
      // 卸载不删 ~/.zcode：有配置残留不代表还装着。误报已安装会让 Web 控制台对残留文件执行一键接入。
      return {
        installed: false,
        configFiles: [],
        note: t(
          '检测到 ZCode 配置残留（{files}），但未找到 ZCode 本体（zcode 命令不在 PATH 上，常见安装目录也没有桌面应用）——ZCode 可能已卸载；若仍在使用，请重新安装并启动一次后点「重新检测」',
          'Found leftover ZCode config ({files}) but the ZCode app itself is missing (no zcode command on PATH and no desktop app in the common install directories) — ZCode may have been uninstalled; if you still use it, reinstall, launch it once, then click Re-detect',
          { files: configFiles.join('、') }
        ),
      }
    }

    // 优先报我们自己的接入条目，其次任何个人供应商，最后旧版条目
    let current: string | undefined
    if (personalText !== null) {
      try {
        const root = JSON.parse(personalText) as ZcodePersonalConfig
        const rules = root.config?.providerConfigRules?.providerRules ?? []
        const ours = rules.find((r) => r?.providerId === PROVIDER_ID)
        const first = ours ?? rules[0]
        current = first?.config?.api?.baseUrl
      } catch {
        return { installed: true, configFiles, note: t('provider_config.json 无法解析（attach 时会中止）', 'provider_config.json cannot be parsed (attach will abort)') }
      }
    }
    if (current === undefined && legacyText !== null) {
      try {
        const root = JSON.parse(legacyText) as { provider?: Record<string, { options?: { baseURL?: string } }> }
        current = Object.values(root.provider ?? {}).find((v) => v?.options?.baseURL)?.options?.baseURL
      } catch {
        // 旧版文件解析失败不阻断检测（现行存储已足够）
      }
    }
    return { installed: true, configFiles, current }
  },

  async planAttach(opts: AttachOptions, cfg: Config): Promise<PlanResult> {
    const personalPath = personalConfigFile()
    const legacyPath = legacyConfigFile()
    const personalText = await readTextIfExists(personalPath)
    const legacyText = await readTextIfExists(legacyPath)
    // 统一本体门槛（与其他客户端一致）：本体缺席一律拒绝——配置残留时拒绝是为了不在卸载残留上
    // 写入接入条目；探测未知（'unknown'）时仅在配置已存在的情况下放行（回退旧行为）
    const present = await appPresent()
    if (present === false) {
      throw new AdapterError(
        t(
          '未找到 ZCode 本体（zcode 命令不在 PATH 上，注册表/常见安装目录也没有桌面应用）——ZCode 可能已卸载；请先安装并启动一次 ZCode 后再接入',
          'The ZCode app itself was not found (no zcode command on PATH and no desktop app in the registry / common install directories) — ZCode may have been uninstalled; install and launch ZCode once before attaching'
        )
      )
    }
    if (personalText === null && legacyText === null && present !== true) {
      throw new AdapterError(
        t(
          '未找到 {path}，也无法确认 ZCode 已安装；请先安装并启动一次 ZCode 后再接入',
          '{path} not found and ZCode could not be confirmed as installed; install and launch ZCode once before attaching',
          { path: personalPath }
        )
      )
    }

    // 模型列表：与 dsh 一致，取当前路由对应服务的模型目录
    const routeName = opts.profile ?? cfg.active_profile
    const profile = routeName ? cfg.profiles[routeName] : undefined
    const providerId = profile?.provider
    const provider = providerId ? cfg.providers[providerId] : undefined
    const modelMap = provider?.models ?? {}
    const modelIds = Object.keys(modelMap)

    const notes: string[] = []
    if (providerId && profile) {
      notes.push(
        t(
          '模型列表取自当前路由「{route}」（{provider}）：{count} 个模型',
          'The model list comes from the current route "{route}" ({provider}): {count} models',
          { route: String(routeName), provider: String(provider?.name ?? providerId), count: modelIds.length }
        )
      )
    } else {
      notes.push(
        t(
          '当前没有可解析的路由，未写入模型列表；请先在控制台「应用」某个服务，再重新接入',
          'No resolvable route, so no model list was written; apply a service in the console first, then attach again'
        )
      )
    }
    if (modelIds.length === 0) {
      notes.push(
        t(
          '警告：ZCode 的模型选择器按「供应商 → 模型」两级展示，空模型列表会导致没有可选模型',
          'Warning: the ZCode model picker shows "provider → model" in two levels, so an empty model list leaves nothing to choose'
        )
      )
    }
    notes.push(
      t(
        'ZCode 运行中会自动加载个人供应商配置；若模型选择器未立即出现 ModelDock，重启 ZCode 即可',
        'ZCode reloads personal provider config automatically while running; if ModelDock does not appear in the model picker right away, just restart ZCode'
      )
    )
    if (personalText === null) {
      notes.push(
        t('未找到既有 {path}，本次接入将新建该文件', 'No existing {path}; this attach creates the file', { path: personalPath })
      )
    }

    const changes: FileChange[] = []

    // 直连：写上游真实 Key 与对应协议端点（ZCode 与 dsh 同源 llm-pi wire：anthropic-messages / openai-completions）
    const d = opts.direct
    const directApi = d ? (d.protocol === 'openai' ? 'openai-completions' : 'anthropic-messages') : undefined
    const directBase = d ? (d.protocol === 'openai' ? (d.base_url_openai ?? d.base_url) : d.base_url) : undefined
    if (d && d.protocol === 'responses') {
      notes.push(
        t(
          '提示: 该服务是 Responses 协议，ZCode 不支持该 wire 类型；直连条目按 anthropic-messages 写入，请确认上游兼容',
          'Note: this service uses the Responses protocol, which ZCode does not support as a wire type; the direct entry is written as anthropic-messages — make sure the upstream is compatible'
        )
      )
    }

    // 现行存储：provider_config.json 个人供应商
    const root = personalText !== null ? (parseJsonStrict(personalText, personalPath) as ZcodePersonalConfig) : freshPersonalConfig()
    const pconf = (root.config ??= {})
    const rules = ((pconf.providerConfigRules ??= {}).providerRules ??= [])
    pconf.providerConfigRules.providerRules = rules.filter((r) => r?.providerId !== PROVIDER_ID)
    pconf.providerConfigRules.providerRules.push({
      providerId: PROVIDER_ID,
      providerName: PROVIDER_NAME,
      config: {
        group: 'standard-personal',
        access: { type: 'api-key', apiKey: d ? d.key : opts.token },
        api: { type: directApi ?? 'anthropic-messages', baseUrl: directBase ?? gatewayBase(opts.gatewayPort) },
        ...(modelIds.length > 0 ? { personalModelIds: [...modelIds], modelOrder: [...modelIds] } : {}),
      },
    })
    const mconf = (pconf.modelConfigRules ??= { providerModelRules: [], manualProviderModelRules: [] })
    mconf.providerModelRules ??= []
    const manual = (mconf.manualProviderModelRules ??= []).filter((r) => r?.providerId !== PROVIDER_ID)
    for (const mid of modelIds) {
      // 配置缺上下文/输出时走填充链（内置表 → models.dev 目录）补齐，补不齐的仍按「推荐配置」兜底不写规则
      const ruleConfig = modelRuleConfig(resolvedModelView(mid, modelMap[mid], provider?.base_url))
      if (ruleConfig) manual.push({ providerId: PROVIDER_ID, modelId: mid, config: ruleConfig })
    }
    mconf.manualProviderModelRules = manual
    if (Array.isArray(pconf.providerOrder)) {
      pconf.providerOrder = [...pconf.providerOrder.filter((id) => id !== PROVIDER_ID), PROVIDER_ID]
    }

    const afterPersonal = serializeJson(
      root,
      personalText !== null ? detectJsonIndent(personalText) : '  ',
      personalText !== null ? personalText.endsWith('\n') : true
    )
    if (personalText !== afterPersonal) {
      changes.push({
        path: personalPath,
        before: personalText,
        after: afterPersonal,
        note: t(
          '新增/更新 modeldock 个人供应商（含模型列表与模型定义）',
          'Add/update the modeldock personal provider (with model list and model definitions)'
        ),
      })
    }

    // 旧版存储：清理本工具历史版本写入的 builtin:modeldock（新版 ZCode 一律忽略）
    if (legacyText !== null) {
      try {
        const legacy = JSON.parse(legacyText) as { provider?: Record<string, unknown> }
        const providers = legacy.provider
        if (providers && Object.prototype.hasOwnProperty.call(providers, LEGACY_ENTRY_ID)) {
          delete providers[LEGACY_ENTRY_ID]
          changes.push({
            path: legacyPath,
            before: legacyText,
            after: serializeJson(legacy, detectJsonIndent(legacyText), legacyText.endsWith('\n')),
            note: t(
              '移除旧版 builtin:modeldock 条目（新版 ZCode 迁移时会跳过 builtin:* 前缀，该条目永远不会显示）',
              'Remove the legacy builtin:modeldock entry (current ZCode skips builtin:* prefixes during migration, so this entry would never show up)'
            ),
          })
        }
      } catch {
        notes.push(t('旧版 config.json 无法解析，跳过其中残留条目的清理', 'The legacy config.json cannot be parsed; skipped cleaning up its leftover entry'))
      }
    }

    if (d) {
      notes.push(
        t(
          '独立直连：已写入上游 {url} 与真实 Key（明文），网关挂掉后该客户端不受影响',
          'Direct mode: wrote the upstream {url} and the real key (plaintext); this client keeps working if the gateway is down',
          { url: String(directBase) }
        )
      )
    }

    return { changes, notes, writtenBaseUrl: directBase }
  },

  async planDetach(cfg: Config): Promise<PlanResult> {
    const changes: FileChange[] = []
    const notes: string[] = []

    const personalPath = personalConfigFile()
    const personalText = await readTextIfExists(personalPath)
    if (personalText !== null) {
      try {
        const root = JSON.parse(personalText) as ZcodePersonalConfig
        const rule = findPersonalRule(root)
        const base = rule?.config?.api?.baseUrl
        if (rule && isOursGatewayUrl(typeof base === 'string' ? base : undefined, 'zcode', cfg)) {
          const rules = root.config!.providerConfigRules!.providerRules!
          root.config!.providerConfigRules!.providerRules = rules.filter((r) => r?.providerId !== PROVIDER_ID)
          const manual = root.config?.modelConfigRules?.manualProviderModelRules
          if (Array.isArray(manual)) {
            root.config!.modelConfigRules!.manualProviderModelRules = manual.filter((r) => r?.providerId !== PROVIDER_ID)
          }
          if (Array.isArray(root.config?.providerOrder)) {
            root.config!.providerOrder = root.config!.providerOrder!.filter((id) => id !== PROVIDER_ID)
          }
          changes.push({
            path: personalPath,
            before: personalText,
            after: serializeJson(root, detectJsonIndent(personalText), personalText.endsWith('\n')),
            note: t(
              '移除 modeldock 个人供应商（含模型定义与排序项）',
              'Remove the modeldock personal provider (with model definitions and ordering entries)'
            ),
          })
        }
      } catch {
        notes.push(t('provider_config.json 无法解析，跳过', 'provider_config.json cannot be parsed; skipped'))
      }
    }

    const legacyPath = legacyConfigFile()
    const legacyText = await readTextIfExists(legacyPath)
    if (legacyText !== null) {
      try {
        const legacy = JSON.parse(legacyText) as { provider?: Record<string, unknown> }
        const entry = legacy.provider?.[LEGACY_ENTRY_ID] as { options?: { baseURL?: string } } | undefined
        const base = entry?.options?.baseURL
        if (entry && isOursGatewayUrl(typeof base === 'string' ? base : undefined, 'zcode', cfg)) {
          delete legacy.provider![LEGACY_ENTRY_ID]
          changes.push({
            path: legacyPath,
            before: legacyText,
            after: serializeJson(legacy, detectJsonIndent(legacyText), legacyText.endsWith('\n')),
            note: t('移除旧版 modeldock 条目（config.json）', 'Remove the legacy modeldock entry (config.json)'),
          })
        }
      } catch {
        notes.push(t('config.json 无法解析，跳过', 'config.json cannot be parsed; skipped'))
      }
    }

    if (changes.length === 0) {
      return {
        changes: [],
        notes: notes.length > 0 ? notes : [t('ZCode 未指向 ModelDock 网关，无需改动', 'ZCode is not pointing at the ModelDock gateway; nothing to change')],
      }
    }
    notes.push(
      t(
        'ZCode 设置/模型选择器里的 ModelDock 条目会随之消失；若未消失，重启 ZCode',
        'The ModelDock entry in ZCode settings / the model picker disappears with it; if it does not, restart ZCode'
      )
    )
    return { changes, notes }
  },

  async status(cfg: Config, port: number): Promise<AdapterStatus> {
    const personalText = await readTextIfExists(personalConfigFile())
    const legacyText = await readTextIfExists(legacyConfigFile())
    const present = await appPresent()
    if (personalText === null && legacyText === null) {
      if (present === true) {
        return {
          installed: true,
          attached: !!cfg.harness['zcode'],
          pointing: 'unknown',
          detail: t('已安装但尚未运行过（无 ~/.zcode/v2/ 配置）', 'Installed but never run (no ~/.zcode/v2/ config)'),
        }
      }
      return { installed: false, attached: false }
    }

    // 卸载残留：配置文件还在但找不到本体 → 未安装（与 detect 同判据，Web 控制台展示一致）
    if (present === false) {
      return {
        installed: false,
        attached: !!cfg.harness['zcode'],
        pointing: 'unknown',
        detail: t('检测到 ZCode 配置残留，但未找到 ZCode 本体（可能已卸载）', 'Found leftover ZCode config but the ZCode app itself is missing (may have been uninstalled)'),
      }
    }

    let base: string | undefined
    let models = 0
    if (personalText !== null) {
      try {
        const rule = findPersonalRule(JSON.parse(personalText) as ZcodePersonalConfig)
        base = rule?.config?.api?.baseUrl
        models = Array.isArray(rule?.config?.personalModelIds) ? rule!.config!.personalModelIds!.length : 0
      } catch {
        return {
          installed: true,
          attached: !!cfg.harness['zcode'],
          pointing: 'unknown',
          detail: t('provider_config.json 解析失败', 'Failed to parse provider_config.json'),
        }
      }
    }
    if (base === undefined && legacyText !== null) {
      try {
        const root = JSON.parse(legacyText) as { provider?: Record<string, { options?: { baseURL?: string } }> }
        base = root.provider?.[LEGACY_ENTRY_ID]?.options?.baseURL
      } catch {
        // 旧版文件解析失败不影响现行存储的判定
      }
    }
    return {
      installed: true,
      attached: !!cfg.harness['zcode'],
      pointing: base === gatewayBase(port) ? 'gateway' : base ? 'other' : 'unknown',
      detail:
        (base ?? t('(未注册 modeldock 供应商)', '(no modeldock provider registered)')) +
        (models > 0 ? t(' · {count} 个模型', ' · {count} models', { count: models }) : ''),
    }
  },
}
