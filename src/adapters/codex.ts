import path from 'node:path'
import { homeDir, readTextIfExists, t } from '../util/index.js'
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
import { changeIfChanged, directAttachNote, directResponsesEndpointNote, noChangeResult, oursEntryUrl } from './shared.js'

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
  [k: string]: unknown
}

export const codexAdapter: HarnessAdapter = {
  id: 'codex',
  label: 'Codex',
  directMode: true,
  // setDefault 时把路由 profile 的默认模型烤进 config.toml 的 root.model，路由切换后需重写跟随
  bakesModels: true,
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
      directNotes.push(directAttachNote(directBase))
      if (!d.base_url_responses) directNotes.push(directResponsesEndpointNote())
    }
    if (opts.setDefault) {
      root.model_provider = 'modeldock'
      const def = opts.profile && cfg.profiles[opts.profile] ? cfg.profiles[opts.profile].default_model : undefined
      if (def) root.model = def
    }

    const body = tomlStringify(reorderTomlRoot(root) as Record<string, unknown>)
    const after = body.endsWith('\n') ? body : body + '\n'
    const notes = [
      ...directNotes,
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
        if (root.model_provider === 'modeldock') delete root.model_provider
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
