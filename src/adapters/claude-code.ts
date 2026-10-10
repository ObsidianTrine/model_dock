import path from 'node:path'
import { homeDir, readTextIfExists, t } from '../util/index.js'
import type { Config } from '../config/types.js'
import {
  AdapterError,
  gatewayBase,
  isGatewayUrl,
  isOursGatewayUrl,
  type AttachOptions,
  type DetectResult,
  type HarnessAdapter,
  type PlanResult,
  type AdapterStatus,
} from './types.js'
import { detectJsonIndent, parseJsonStrict, serializeJson } from './format.js'
import { cliPresent } from './presence.js'
import { resolveModelMeta } from '../providers/resolve.js'

const TIER_ENV_KEYS = [
  ['ANTHROPIC_DEFAULT_OPUS_MODEL', 'claude-opus-*'],
  ['ANTHROPIC_DEFAULT_SONNET_MODEL', 'claude-sonnet-*'],
  ['ANTHROPIC_DEFAULT_HAIKU_MODEL', 'claude-haiku-*'],
  ['ANTHROPIC_DEFAULT_FABLE_MODEL', 'claude-fable-*'],
] as const

/** 直连模式：根级 model 固定用 sonnet 别名（客户端经 ANTHROPIC_DEFAULT_SONNET_MODEL 解析到真实模型） */
const ROOT_MODEL_DIRECT = 'sonnet'
/** 上下文 ≥ 1M tokens 时给模型 ID 追加 [1m] 声明（Claude Code 上下文变体后缀，大小写不敏感） */
const ONE_M_TOKEN = 1_000_000
/** 直连调优默认值（与 DeepSeek 官方推荐一致） */
const DIRECT_EFFORT_LEVEL = 'max'
const DIRECT_AUTO_COMPACT_WINDOW = '786432'

/** 去掉 [1m]/[1M]/[128k] 等上下文变体后缀（NAME 显示用；与 import/sources.ts 的清洗正则一致） */
function stripContextSuffix(id: string): string {
  return id.replace(/\[\d+[MmKk]\]$/, '')
}

const settingsFile = () => path.join(homeDir(), '.claude', 'settings.json')

/** 本体双信号：~/.claude 不随卸载删除（npm uninstall 不清配置目录），配置在而 claude 命令
 *  缺席视为卸载残留，判未安装——否则控制台会对残留文件显示已接入并提供一键接入。 */
function present(): boolean {
  return cliPresent('claude', 'claude-code')
}

/** 命令在 PATH 上但 settings.json 还没生成：装好但没跑过首次启动（原生安装器、刚 npm 装完都如此） */
const notInitializedNote = () =>
  t(
    '已安装 claude 命令，但还没有 ~/.claude/settings.json（首次运行 claude 会自动生成）；可直接「一键接入」，接入时会自动创建该文件',
    'The claude command is installed, but ~/.claude/settings.json does not exist yet (created on first run of claude); you can attach directly and the file will be created for you'
  )

interface ClaudeSettings {
  env?: Record<string, string>
  [k: string]: unknown
}

export const claudeCodeAdapter: HarnessAdapter = {
  id: 'claude-code',
  label: 'Claude Code',
  directMode: true,
  install: {
    command: 'npm i -g @anthropic-ai/claude-code',
    needsNode: true,
    probe: 'claude',
    get guide() {
      return t(
        'Claude Code 是终端命令（Node 程序）。点「安装并接入」由 ModelDock 自动完成：本机没有 Node 时自动下载托管 Node 运行时，npm 安装自动走大陆镜像，装完自动写配置。手动兜底：npm i -g @anthropic-ai/claude-code --registry=https://registry.npmmirror.com（npm 官方源大陆常不可达），装完运行一次 claude 完成初始化。',
        'Claude Code is a terminal command (a Node program). Click Install & attach and ModelDock handles it: if this machine has no Node.js, the managed Node runtime is downloaded first, npm runs against the official registry, and the config is written automatically. Manual fallback: npm i -g @anthropic-ai/claude-code, then run claude once to initialize.'
      )
    },
    homepage: 'https://code.claude.com/docs',
    bootstrap: { path: settingsFile, content: '{}\n' },
  },

  async detect(): Promise<DetectResult> {
    const p = settingsFile()
    const text = await readTextIfExists(p)
    if (text === null) {
      // 只认配置文件会把"已安装未初始化"误报成未安装，进而引导用户重跑 npm 全局安装
      // ——那条路径会先 retire 现有安装，postinstall 不成功就只剩报错桩（与 codex 同策略）
      if (present()) return { installed: true, configFiles: [], note: notInitializedNote() }
      return {
        installed: false,
        configFiles: [],
        note: t('未找到 claude 命令，也未找到 ~/.claude/settings.json', 'claude command not found and ~/.claude/settings.json not found'),
      }
    }
    if (!present()) {
      return {
        installed: false,
        configFiles: [],
        note: t(
          '检测到配置残留（{path}），但未找到 claude 命令——Claude Code 可能已卸载；若仍在使用，请重新安装后点「重新检测」',
          'Found leftover config ({path}) but the claude command is missing — Claude Code may have been uninstalled; if you still use it, reinstall and click Re-detect',
          { path: p }
        ),
      }
    }
    let root: ClaudeSettings = {}
    try {
      root = JSON.parse(text)
    } catch {
      return { installed: true, configFiles: [p], note: t('settings.json 无法解析（ attach 时会中止）', 'settings.json cannot be parsed (attach will abort)') }
    }
    return { installed: true, configFiles: [p], current: root.env?.ANTHROPIC_BASE_URL }
  },

  async planAttach(opts: AttachOptions, _cfg: Config): Promise<PlanResult> {
    if (!present()) {
      throw new AdapterError(
        t(
          '未找到 claude 命令——Claude Code 可能已卸载（~/.claude 只是残留配置）；请先安装 Claude Code 后再接入',
          'claude command not found — Claude Code may have been uninstalled (~/.claude is leftover config only); install Claude Code first, then attach'
        )
      )
    }
    const p = settingsFile()
    const text = await readTextIfExists(p)
    const root: ClaudeSettings = text === null ? {} : (parseJsonStrict(text, p) as ClaudeSettings)
    const env = (root.env ??= {})
    const notes: string[] = []
    const profileUpdates: { aliases?: Record<string, string>; default_model?: string } = {}

    if (text === null) {
      notes.push(
        t(
          '未找到 {path}，本次接入会新建：只写网关 env，其余字段由 claude 首次运行时自行补齐',
          '{path} not found; this attach creates it with gateway env only — claude fills in the rest on first run',
          { path: p }
        )
      )
    }

    const d = opts.direct
    const prevBase = env.ANTHROPIC_BASE_URL
    env.ANTHROPIC_BASE_URL = d ? d.base_url : gatewayBase(opts.gatewayPort)
    if (d) {
      // 直连按上游鉴权方式写对应变量，并清掉另一种，避免客户端拿旧的凭据变量先用错
      if (d.auth_style === 'x-api-key') {
        env.ANTHROPIC_API_KEY = d.key
        delete env.ANTHROPIC_AUTH_TOKEN
      } else {
        env.ANTHROPIC_AUTH_TOKEN = d.key
        delete env.ANTHROPIC_API_KEY
      }
      // 直连没有网关的别名重写层：把 profile 的模型映射还原进 env（takeoverModels 的逆操作），
      // 否则客户端发出的 claude-sonnet-* 等模型名上游可能不认
      const prof = opts.profile ? _cfg.profiles[opts.profile] : undefined
      if (!prof) {
        notes.push(
          t(
            '直连模式：未找到目标 profile，模型映射未还原；请确认上游支持客户端默认模型名',
            'Direct mode: target profile not found, model mapping not restored; make sure the upstream supports the client default model names'
          )
        )
      } else {
        const provider = prof.provider ? _cfg.providers[prof.provider] : undefined
        // 目标模型上下文 ≥ 1M 时给模型 ID 追加 [1m] 声明（元数据分层解析：配置 > 内置表 > 目录）
        const suffixed = (target: string): string => {
          const ctx = resolveModelMeta(target, provider?.models?.[target], { baseUrl: provider?.base_url })?.context_window
          return ctx !== undefined && ctx >= ONE_M_TOKEN ? `${target}[1m]` : target
        }
        let restored = 0
        for (const [envKey, glob] of TIER_ENV_KEYS) {
          const star = glob.indexOf('*')
          const pre = glob.slice(0, star)
          const suf = glob.slice(star + 1)
          const aliasKey = Object.keys(prof.aliases ?? {}).find((k) => k.startsWith(pre) && k.endsWith(suf))
          const target = aliasKey !== undefined ? prof.aliases![aliasKey] : undefined
          if (target) {
            env[envKey] = suffixed(target)
            env[`${envKey}_NAME`] = stripContextSuffix(target)
            restored++
          }
        }
        // 方案 A：sonnet 层 = claude-sonnet-* 别名优先，default_model 兜底（保证根 model: sonnet 有值）
        const sonnetTarget =
          env.ANTHROPIC_DEFAULT_SONNET_MODEL ?? (prof.default_model ? suffixed(prof.default_model) : undefined)
        if (sonnetTarget) {
          if (!env.ANTHROPIC_DEFAULT_SONNET_MODEL) {
            env.ANTHROPIC_DEFAULT_SONNET_MODEL = sonnetTarget
            env.ANTHROPIC_DEFAULT_SONNET_MODEL_NAME = stripContextSuffix(sonnetTarget)
            restored++
          }
          // 根 model 用 sonnet 别名（不再写 env.ANTHROPIC_MODEL，避免 env 优先级压掉根 model）
          root.model = ROOT_MODEL_DIRECT
          env.CLAUDE_CODE_SUBAGENT_MODEL = sonnetTarget
        }
        // 直连调优默认值
        env.CLAUDE_CODE_EFFORT_LEVEL = DIRECT_EFFORT_LEVEL
        env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = DIRECT_AUTO_COMPACT_WINDOW
        notes.push(
          t(
            '直连模式：已按 profile「{profile}」还原模型映射（{count} 个分层{model}）',
            'Direct mode: restored model mapping from profile "{profile}" ({count} tier entries{model})',
            {
              profile: String(opts.profile),
              count: restored,
              model: root.model ? t('，根模型 {model}', ', root model {model}', { model: String(root.model) }) : '',
            }
          )
        )
        if (restored === 0) {
          notes.push(
            t(
              '直连模式：该 profile 无默认模型和别名，模型名不做转换，请确认上游支持客户端默认模型名',
              'Direct mode: this profile has no default model or aliases, model names are passed through; make sure the upstream supports the client default model names'
            )
          )
        }
      }
    } else {
      env.ANTHROPIC_AUTH_TOKEN = opts.token
      // 从直连切回：清掉 direct 分支写入的模型映射 env 与根 model——网关侧有别名重写，残留会钉死模型
      if (opts.fromMode === 'direct') {
        delete env.ANTHROPIC_MODEL
        for (const [envKey] of TIER_ENV_KEYS) {
          delete env[envKey]
          delete env[`${envKey}_NAME`]
        }
        delete env.CLAUDE_CODE_SUBAGENT_MODEL
        delete env.CLAUDE_CODE_EFFORT_LEVEL
        delete env.CLAUDE_CODE_AUTO_COMPACT_WINDOW
        if (root.model === ROOT_MODEL_DIRECT) delete root.model
      }
      notes.push(
        t(
          '网关模式：模型映射不写进本文件——claude 内置分层名（claude-sonnet-* 等）由网关按当前服务的默认模型改写，服务切换 / 故障切换即时跟随、无需重启客户端；需要分层用不同模型时在服务的路由别名里配置',
          'Gateway mode: model mappings are not written here — built-in claude tier names (claude-sonnet-* etc.) are rewritten by the gateway to the current service default model, following service switches and failover instantly with no client restart; configure route aliases on the service for per-tier models'
        )
      )
    }

    if (prevBase && !isGatewayUrl(prevBase)) {
      notes.push(
        t(
          '原 base_url「{url}」已替换为网关；原文件已自动快照，可 restore 还原',
          'Original base_url "{url}" was replaced with the gateway; the original file is snapshotted automatically and can be restored',
          { url: prevBase }
        )
      )
    }

    if (opts.takeoverModels) {
      const aliases: Record<string, string> = {}
      for (const [key, glob] of TIER_ENV_KEYS) {
        if (typeof env[key] === 'string') {
          aliases[glob] = env[key]
          delete env[key]
          delete env[`${key}_NAME`] // NAME 是模型映射的显示面，一并迁出，避免残留钉死展示
        }
      }
      if (aliases && Object.keys(aliases).length > 0) profileUpdates.aliases = aliases
      if (typeof env.ANTHROPIC_MODEL === 'string') {
        profileUpdates.default_model = env.ANTHROPIC_MODEL
        delete env.ANTHROPIC_MODEL
      }
      if (Object.keys(profileUpdates).length > 0) {
        notes.push(
          t(
            '已把 ANTHROPIC_MODEL / DEFAULT_*_MODEL 映射迁入 ModelDock profile，settings.json 中的对应键已删除',
            'The ANTHROPIC_MODEL / DEFAULT_*_MODEL mapping was moved into the ModelDock profile and the corresponding keys were removed from settings.json'
          )
        )
      }
    }

    return {
      changes: [
        {
          path: p,
          before: text,
          after: serializeJson(root, text === null ? '  ' : detectJsonIndent(text), text === null || text.endsWith('\n')),
        },
      ],
      notes,
      profileUpdates: Object.keys(profileUpdates).length > 0 ? profileUpdates : undefined,
      writtenBaseUrl: d?.base_url,
    }
  },

  async planDetach(cfg: Config): Promise<PlanResult> {
    const p = settingsFile()
    const text = await readTextIfExists(p)
    if (text === null) return { changes: [], notes: [] }
    let root: ClaudeSettings
    try {
      root = JSON.parse(text)
    } catch {
      return { changes: [], notes: [t('settings.json 无法解析，跳过（可用 restore 还原快照）', 'settings.json cannot be parsed; skipped (you can restore from a snapshot)')] }
    }
    const env = root.env ?? {}
    if (isOursGatewayUrl(env.ANTHROPIC_BASE_URL, 'claude-code', cfg)) {
      delete env.ANTHROPIC_BASE_URL
      delete env.ANTHROPIC_AUTH_TOKEN
      return {
        changes: [
          {
            path: p,
            before: text,
            after: serializeJson(root, detectJsonIndent(text), text.endsWith('\n')),
          },
        ],
        notes: [
          t(
            '已移除 ModelDock 注入的变量；恢复接管前的完整原配置请用 detach 的快照还原',
            'Removed the variables injected by ModelDock; to restore the full pre-attach config, restore the detach snapshot'
          ),
        ],
      }
    }
    return { changes: [], notes: [t('当前未指向 ModelDock 网关，无需改动', 'Not pointing at the ModelDock gateway; nothing to change')] }
  },

  async status(cfg: Config, port: number): Promise<AdapterStatus> {
    const text = await readTextIfExists(settingsFile())
    if (text === null) {
      // 与 detect 同一判据：命令在 PATH 上就算「已装未接入」，否则控制台会推「安装并接入」
      if (present()) {
        return {
          installed: true,
          attached: !!cfg.harness['claude-code'],
          pointing: 'unknown',
          detail: notInitializedNote(),
        }
      }
      return { installed: false, attached: false }
    }
    if (!present()) {
      return {
        installed: false,
        attached: !!cfg.harness['claude-code'],
        pointing: 'unknown',
        detail: t('检测到配置残留，但未找到 claude 命令（可能已卸载）', 'Found leftover config but the claude command is missing (may have been uninstalled)'),
      }
    }
    let env: Record<string, string> = {}
    try {
      env = (JSON.parse(text) as ClaudeSettings).env ?? {}
    } catch {
      return { installed: true, attached: false, pointing: 'unknown', detail: t('settings.json 解析失败', 'Failed to parse settings.json') }
    }
    const base = env.ANTHROPIC_BASE_URL
    return {
      installed: true,
      attached: !!cfg.harness['claude-code'],
      pointing: base === gatewayBase(port) ? 'gateway' : base ? 'other' : 'unknown',
      detail: base ?? t('(未设置 ANTHROPIC_BASE_URL)', '(ANTHROPIC_BASE_URL not set)'),
    }
  },
}
