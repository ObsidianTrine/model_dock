import { biJoin, commandOnPath, readTextIfExists, t } from '../util/index.js'
import type { Config } from '../config/types.js'
import {
  AdapterError,
  gatewayBaseOpenAI,
  isOursGatewayUrl,
  type AdapterStatus,
  type AttachOptions,
  type DetectResult,
  type HarnessAdapter,
  type PlanResult,
} from './types.js'
import { detectJsonIndent, parseJsonTolerant, serializeJson } from './format.js'
import { cliPresent, residueNote } from './presence.js'
import { changeIfChanged, directAttachNote, resolveRoute, routeModelNote } from './shared.js'
import { resolveModelMeta } from '../providers/resolve.js'

/** mimocode schema 的单模型条目（$schema https://mimo.xiaomi.com/mimocode/config.json 的 provider.<id>.models 值） */
interface JsonModelEntry {
  name?: string
  /** 上下文/输出上限（tokens）：schema 里 context 与 output 均必填，缺一整段不写 */
  limit?: { context: number; output: number }
  /** 文件/图片附件支持（models.dev 同构字段） */
  attachment?: boolean
  /** 输入/输出模态：视觉模型 input 含 image，客户端据此放行图片 */
  modalities?: { input: string[]; output: string[] }
}

interface JsonConfig {
  provider?: Record<
    string,
    {
      name?: string
      options?: Record<string, string>
      npm?: string
      models?: Record<string, JsonModelEntry>
      only_configured_models?: boolean
    }
  >
  model?: string
  [k: string]: unknown
}

export interface ProviderJsonFactoryOptions {
  id: string
  label: string
  /** 候选配置文件；调用时计算（便于测试重定向 homeDir）。第一个同时作为新建目标 */
  configFiles: () => string[]
  /** 客户端安装元数据（未安装时 Web 控制台据此渲染「安装并接入」按钮） */
  install?: import('./types.js').ClientInstall
  /** 客户端命令名：配置文件缺失但命令在 PATH 上时视为「已装未初始化」（与 codex detect 同策略） */
  bin?: { name: string; noteInstalled: string }
  /**
   * 写入 provider.models 声明 + only_configured_models（MiMoCode 官方样例格式）：
   * 不声明时 mimo models 不会列出该 provider 的模型。按当前路由的模型目录写入。
   */
  declareModels?: boolean
}

/**
 * 面向「JSON 配置 + 内嵌 provider」终端的通用 adapter 工厂（OpenCode / MiMo Code 同源结构）：
 * provider.<id>.options.baseURL/apiKey + 顶层 model。与 codex 的 TOML 版逻辑同构。
 * 解析用 parseJsonTolerant（JSONC 注释宽容），重写为标准 JSON 时提示注释丢失。
 */
export function craftProviderJsonAdapter(factory: ProviderJsonFactoryOptions): HarnessAdapter {
  const configFiles = factory.configFiles
  const missingNote = () =>
    t('未找到 {label} 配置（{files}）', '{label} config not found ({files})', {
      label: factory.label,
      files: biJoin(' / ', ', ', configFiles()),
    })

  async function firstExisting(): Promise<string | null> {
    for (const p of configFiles()) {
      if ((await readTextIfExists(p)) !== null) return p
    }
    return null
  }

  /** 未初始化判定：配置不存在但命令在 PATH 上（npm 类装完还没跑过首次启动） */
  function binReady(): boolean {
    return !!factory.bin && commandOnPath(factory.bin.name)
  }

  /** 本体探测命令名（bin 优先，回落 install.probe）；都没有则不做本体门槛 */
  const binName = factory.bin?.name ?? factory.install?.probe

  /** 本体双信号：配置目录不随卸载删除，配置在而命令缺席视为卸载残留，判未安装 */
  function present(): boolean {
    return !binName || cliPresent(binName, factory.id)
  }

  return {
    id: factory.id,
    // 惰性透传：factory.label 可能是 getter（如 MiMo 桌面端按请求语言渲染），加载期直接取值会固化语言
    get label() {
      return factory.label
    },
    directMode: true,
    // setDefault 时默认模型（modeldock/<路由默认>）必烤进配置；declareModels 另烤模型列表。
    // 全局/钉定路由切换后需重写跟随（见 refreshBakedModelClients）
    bakesModels: true,
    ...(factory.install ? { install: factory.install } : {}),

    async detect(): Promise<DetectResult> {
      const p = await firstExisting()
      if (p === null) {
        if (binReady()) return { installed: true, configFiles: [], note: factory.bin!.noteInstalled }
        return { installed: false, configFiles: [], note: missingNote() }
      }
      if (!present()) {
        return {
          installed: false,
          configFiles: [],
          note: residueNote([p], factory.label),
        }
      }
      const text = await readTextIfExists(p)
      const parsed = parseJsonTolerant(text!)
      if (!parsed) {
        return {
          installed: true,
          configFiles: [p],
          note: t('{label} 配置无法解析（attach 时会中止）', 'The {label} config cannot be parsed (attach will abort)', { label: factory.label }),
        }
      }
      const root = parsed.value as JsonConfig
      const first = Object.values(root.provider ?? {}).find((v) => v?.options?.baseURL)
      return { installed: true, configFiles: [p], current: first?.options?.baseURL }
    },

    async planAttach(opts: AttachOptions, cfg: Config): Promise<PlanResult> {
      if (!present()) {
        throw new AdapterError(
          t('未找到 {bin} 命令——{label} 可能已卸载（配置只是残留）', '{bin} command not found — {label} may have been uninstalled (the config is leftover only)', { bin: String(binName), label: factory.label }),
          t('请先安装后再接入', 'Install it first, then attach')
        )
      }
      const p = (await firstExisting()) ?? configFiles()[0]
      const text = await readTextIfExists(p)
      let root: JsonConfig = {}
      let hadComments = false
      if (text) {
        const parsed = parseJsonTolerant(text)
        if (!parsed) {
          throw new AdapterError(t('{path} 无法解析为 JSON/JSONC，已中止（未做任何改动）', '{path} cannot be parsed as JSON/JSONC; aborted (nothing changed)', { path: p }))
        }
        root = parsed.value as JsonConfig
        hadComments = parsed.comments
      }
      const providers = (root.provider ??= {})
      // 直连：openai 兼容客户端用上游 openai 端点（缺省回退 base_url）+ 真实 Key
      const d = opts.direct
      const directBase = d ? (d.base_url_openai ?? d.base_url) : undefined
      providers.modeldock = {
        npm: '@ai-sdk/openai-compatible',
        name: 'ModelDock',
        options: {
          baseURL: directBase ?? gatewayBaseOpenAI(opts.gatewayPort),
          apiKey: d ? d.key : opts.token,
        },
      }
      let modelsNote: string | undefined
      // 模型列表与默认模型必须同源：都按 opts.profile（钉定路由）优先，钉定时不能偷偷跟随全局
      const { routeName, provider, providerId } = resolveRoute(opts, cfg)
      if (factory.declareModels) {
        const models = provider?.models ?? {}
        const ids = Object.keys(models)
        if (ids.length > 0) {
          // mimocode 模型条目按官方 schema 补元数据（limit/modalities/attachment）：
          // 解析链与控制台一致（配置值 > 内置表 > models.dev 目录），只补空不覆盖
          providers.modeldock.models = Object.fromEntries(
            ids.map((id) => {
              const r = resolveModelMeta(id, models[id], { baseUrl: provider?.base_url })
              const entry: JsonModelEntry = { name: models[id]?.display_name || id }
              // schema 里 context 与 output 同为必填：缺任一侧不写整段，避免客户端拒载
              if (r?.context_window !== undefined && r?.max_output !== undefined) {
                entry.limit = { context: r.context_window, output: r.max_output }
              }
              // 能力未知时不声明（客户端按纯文本默认处理），与 dsh 适配器同策略
              const caps = models[id]?.capabilities ?? r?.capabilities
              if (caps !== undefined) {
                const vision = caps.includes('vision')
                entry.attachment = vision
                entry.modalities = { input: vision ? ['text', 'image'] : ['text'], output: ['text'] }
              }
              return [id, entry]
            })
          )
          providers.modeldock.only_configured_models = true
          modelsNote = routeModelNote(String(routeName), String(provider?.name ?? providerId), ids.length)
        }
      }

      const notes: string[] = [
        t('{label} 启动时才读配置，如已运行请退出后重进', '{label} reads its config at startup; if it is running, quit and reopen it', {
          label: factory.label,
        }),
        ...(d
          ? [
              directAttachNote(directBase),
            ]
          : [
              t(
                'token 为本地网关令牌（非真实凭据）；新建文件以 0600 落盘，已有文件保留原权限；detach 时移除',
                'The token is a local gateway token (not real credentials); new files are written with 0600, existing files keep their permissions, and it is removed on detach'
              ),
            ]),
      ]
      if (modelsNote) notes.push(modelsNote)
      if (hadComments) {
        notes.push(
          t(
            '配置含 JSONC 注释，attach 会重写为标准 JSON，注释会丢失（原文已自动快照，可 restore 找回）',
            'The config contains JSONC comments; attach rewrites it as standard JSON and the comments will be lost (the original is snapshotted automatically and can be restored)'
          )
        )
      }
      if (opts.setDefault) {
        const profModel = routeName ? cfg.profiles[routeName]?.default_model : undefined
        if (profModel) {
          root.model = `modeldock/${profModel}`
          notes.push(t('已把默认模型设为 {model}（--set-default）', 'Set the default model to {model} (--set-default)', { model: root.model }))
        } else {
          // 不写猜出来的占位值：客户端解析不到该模型只会报出难排查的错误
          notes.push(
            t(
              '未改动默认模型：当前路由没有 default_model。可先在 ModelDock 设置默认模型，或在客户端里手动选 modeldock',
              'Default model unchanged: the current route has no default_model. Set a default model in ModelDock first, or pick modeldock manually in the client'
            )
          )
        }
      } else {
        notes.push(
          t(
            '未改动默认模型，需要时加 --set-default，或在 {label} 里选 modeldock',
            'Default model unchanged; add --set-default if needed, or pick modeldock in {label}',
            { label: factory.label }
          )
        )
      }

      return {
        changes: [
          changeIfChanged(
            p,
            text,
            serializeJson(root, text ? detectJsonIndent(text) : '  ', text ? text.endsWith('\n') : true),
            t('注册 modeldock provider', 'Register the modeldock provider')
          ),
        ].filter((c): c is NonNullable<typeof c> => c !== null),
        notes,
        writtenBaseUrl: directBase,
      }
    },

    async planDetach(cfg: Config): Promise<PlanResult> {
      const p = await firstExisting()
      if (p === null) return { changes: [], notes: [] }
      const text = await readTextIfExists(p)
      const parsed = parseJsonTolerant(text!)
      if (!parsed) {
        return {
          changes: [],
          notes: [t('{label} 配置无法解析，跳过（可用 restore 还原快照）', 'The {label} config cannot be parsed; skipped (you can restore from a snapshot)', { label: factory.label })],
        }
      }
      const root = parsed.value as JsonConfig
      const entry = root.provider?.modeldock
      const base = entry?.options?.baseURL
      if (entry && isOursGatewayUrl(typeof base === 'string' ? base : undefined, factory.id, cfg)) {
        delete root.provider!.modeldock
        if (root.model?.startsWith('modeldock/')) delete root.model
        if (root.provider && Object.keys(root.provider).length === 0) delete root.provider
        const notes: string[] = []
        if (parsed.comments) {
          notes.push(
            t(
              '配置含 JSONC 注释，detach 重写为标准 JSON 时注释会丢失（原文已自动快照）',
              'The config contains JSONC comments; detaching rewrites it as standard JSON and the comments will be lost (the original is snapshotted automatically)'
            )
          )
        }
        return {
          changes: [
            changeIfChanged(p, text, serializeJson(root, detectJsonIndent(text!), text!.endsWith('\n'))),
          ].filter((c): c is NonNullable<typeof c> => c !== null),
          notes,
        }
      }
      return { changes: [], notes: [t('{label} 未指向 ModelDock 网关，无需改动', '{label} is not pointing at the ModelDock gateway; nothing to change', { label: factory.label })] }
    },

    async status(cfg: Config, port: number): Promise<AdapterStatus> {
      const p = await firstExisting()
      if (p === null) {
        if (binReady()) return { installed: true, attached: !!cfg.harness[factory.id], pointing: 'unknown', detail: factory.bin!.noteInstalled }
        return { installed: false, attached: false }
      }
      if (!present()) {
        return {
          installed: false,
          attached: !!cfg.harness[factory.id],
          pointing: 'unknown',
          detail: t('检测到配置残留，但未找到 {bin} 命令（可能已卸载）', 'Found leftover config but the {bin} command is missing (may have been uninstalled)', { bin: String(binName) }),
        }
      }
      const text = await readTextIfExists(p)
      const parsed = parseJsonTolerant(text!)
      if (!parsed) {
        return {
          installed: true,
          attached: false,
          pointing: 'unknown',
          detail: t('{label} 配置解析失败', 'Failed to parse the {label} config', { label: factory.label }),
        }
      }
      const root = parsed.value as JsonConfig
      const base = root.provider?.modeldock?.options?.baseURL
      return {
        installed: true,
        attached: !!cfg.harness[factory.id],
        pointing: base === gatewayBaseOpenAI(port) ? 'gateway' : base ? 'other' : 'unknown',
        detail: base ?? t('(未注册 modeldock provider)', '(no modeldock provider registered)'),
      }
    },
  }
}
