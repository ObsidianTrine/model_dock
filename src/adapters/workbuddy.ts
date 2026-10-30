import path from 'node:path'
import { biJoin, homeDir, readTextIfExists, t } from '../util/index.js'
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
import { detectJsonIndent, parseJsonStrict, serializeJson } from './format.js'
import { desktopPresent, residueNote } from './presence.js'
import { changeIfChanged, directAttachNote, noChangeResult, oursEntryUrl, resolveRoute, routeModelNote } from './shared.js'

/**
 * WorkBuddy AI（腾讯 AI 办公客户端）的自定义模型走本地 models.json：应用只读该文件并
 * fs.watch 热加载。两种形态——顶层数组（UI「添加模型」保存的格式）或 { models: [...] }
 * （手写格式）；条目 { id, name, url, apiKey, ... }，其中 url 是**完整请求端点**（实测
 * UI 写的是 https://api.deepseek.com/chat/completions 这类 full URL），请求发出的 model
 * 名即条目 id（custom-local: 前缀由应用按产品开关自行处理并把原 id 收进条目 aliases）。
 * apiKey 明文合法：应用侧编解码器只处理其自有密文格式。
 */
interface WorkbuddyModelEntry {
  id?: unknown
  name?: unknown
  url?: unknown
  apiKey?: unknown
  [k: string]: unknown
}

interface WorkbuddyModelsObject {
  models?: unknown
  availableModels?: unknown
  [k: string]: unknown
}

/**
 * 候选配置目录，第一个已存在的为准（新建文件落到第一个候选）：
 * - env 覆盖与应用侧 getUserConfigPath 同序（WORKBUDDY_CONFIG_DIR → CODEBUDDY_CONFIG_DIR）
 * - ~/.workbuddy-ai：产品「WorkBuddy AI」实际使用的目录（UI 保存的 models.json 在这里，实测）
 * - ~/.workbuddy：应用内 server 代码的默认名，旧版/sidecar 场景可见
 */
function candidateDirs(): string[] {
  const envDir = process.env.WORKBUDDY_CONFIG_DIR?.trim() || process.env.CODEBUDDY_CONFIG_DIR?.trim()
  if (envDir) return [envDir]
  return [path.join(homeDir(), '.workbuddy-ai'), path.join(homeDir(), '.workbuddy')]
}

function candidateFiles(): string[] {
  return candidateDirs().map((d) => path.join(d, 'models.json'))
}

/** 导入扫描（import/sources.ts）复用：models.json 候选路径 */
export function modelsFileCandidates(): string[] {
  return candidateFiles()
}

/** 已接入文件解析：多个候选都存在时取第一个（与 planAttach 写入目标一致） */
async function activeFile(): Promise<string | null> {
  for (const p of candidateFiles()) {
    if ((await readTextIfExists(p)) !== null) return p
  }
  return null
}

/** 安装信号：产品目录下首启生成的文件；都没有再看 server 侧的 device-id */
async function installMarker(): Promise<string | null> {
  const candidates = [
    path.join(homeDir(), '.workbuddy-ai', 'settings.json'),
    path.join(homeDir(), '.workbuddy-ai', 'install-timing-reported'),
    path.join(homeDir(), '.workbuddy', 'device-id'),
  ]
  for (const p of candidates) {
    if ((await readTextIfExists(p)) !== null) return p
  }
  return null
}

/** 模型条目的请求端点（网关 OpenAI 协议 + chat/completions 全路径，与 UI 保存的格式一致） */
function gatewayEndpointUrl(port: number): string {
  return `${gatewayBaseOpenAI(port)}/chat/completions`
}

function isOursEntry(e: WorkbuddyModelEntry, cfg: Config): boolean {
  // 网关条目按 gateway_base 匹配；独立直连条目按登记的 direct_base 精确匹配（换直连目标/切回网关时幂等摘除）
  if (oursEntryUrl(e.url, 'workbuddy', cfg)) return true
  const directBase = cfg.harness['workbuddy']?.direct_base
  return !!directBase && typeof e.url === 'string' && e.url === directBase
}

function extractEntries(parsed: unknown): WorkbuddyModelEntry[] {
  if (Array.isArray(parsed)) return parsed as WorkbuddyModelEntry[]
  if (parsed !== null && typeof parsed === 'object' && Array.isArray((parsed as WorkbuddyModelsObject).models)) {
    return (parsed as WorkbuddyModelsObject).models as WorkbuddyModelEntry[]
  }
  return []
}

/** detect 展示排序用：条目是否指向本机回环（精确判定在 status/detach，走 isOursEntry） */
function isGatewayish(e: WorkbuddyModelEntry): boolean {
  const url = typeof e.url === 'string' ? e.url : ''
  return /^https?:\/\/(127\.|localhost|\[::1\])/i.test(url)
}

/**
 * WorkBuddy 桌面应用本体（双信号之一）：注册表卸载项（实测 HKCU 登记 DisplayName「WorkBuddy 5.6.2」）
 * / 常见安装目录 / macOS /Applications。CodeBuddy 为其曾用名/同源产品名，一并探测。
 * ~/.workbuddy-ai/ 不随卸载删除，只认目录会把「已卸载有残留」误报成已安装。
 */
async function appPresent(): Promise<boolean | 'unknown'> {
  return desktopPresent(['WorkBuddy', 'CodeBuddy'], 'workbuddy')
}

export const workbuddyAdapter: HarnessAdapter = {
  id: 'workbuddy',
  get label() { return t('WorkBuddy（腾讯 AI 办公客户端）', 'WorkBuddy (Tencent AI office client)') },
  directMode: true,
  bakesModels: true, // models.json 里烙着模型列表，全局切换后需重写（见 refreshBakedModelClients）
  install: {
    get guide() {
      return t(
        'WorkBuddy 是腾讯的桌面 AI 办公客户端。请到官网下载安装（Windows/macOS），启动一次后回来点「重新检测」。其自定义模型通过 ~/.workbuddy-ai/models.json 本地文件配置，ModelDock 接入时会自动创建。',
        'WorkBuddy is Tencent\'s desktop AI office client. Download and install it from the official site (Windows/macOS), launch it once, then come back and click Re-detect. Its custom models are configured via the local ~/.workbuddy-ai/models.json file, which ModelDock creates automatically when attaching.'
      )
    },
    homepage: 'https://workbuddy.tencent.com',
  },

  async detect(): Promise<DetectResult> {
    const p = await activeFile()
    if (p === null) {
      const marker = await installMarker()
      if (marker !== null) {
        if ((await appPresent()) === false) {
          return {
            installed: false,
            configFiles: [],
            note: residueNote([marker], 'WorkBuddy'),
          }
        }
        return {
          installed: true,
          configFiles: [],
          note: t(
            '已安装 WorkBuddy，但还没有 models.json；可直接「一键接入」，将自动创建该文件',
            'WorkBuddy is installed but has no models.json yet; you can attach directly and the file will be created for you'
          ),
        }
      }
      if ((await appPresent()) === true) {
        return {
          installed: true,
          configFiles: [],
          note: t(
            '已安装 WorkBuddy，但还没有 ~/.workbuddy-ai/ 配置（首次启动会生成）；启动一次后点「重新检测」，或直接「一键接入」',
            'WorkBuddy is installed but has no ~/.workbuddy-ai/ config yet (generated on first launch); launch it once and click Re-detect, or attach directly'
          ),
        }
      }
      return {
        installed: false,
        configFiles: [],
        note: t(
          '未找到 WorkBuddy（无 ~/.workbuddy-ai/ 与 ~/.workbuddy/ 安装痕迹）；请先安装并启动一次',
          'WorkBuddy not found (no install traces in ~/.workbuddy-ai/ or ~/.workbuddy/); install it and launch it once'
        ),
      }
    }
    if ((await appPresent()) === false) {
      return {
        installed: false,
        configFiles: [],
        note: residueNote([p], 'WorkBuddy'),
      }
    }
    const text = await readTextIfExists(p)
    try {
      const entries = extractEntries(parseJsonStrict(text!, p))
      // 优先报指向本机网关的条目，其次第一条（与 zcode detect 一致的展示约定）
      const first = entries.find((e) => isGatewayish(e)) ?? entries[0]
      return { installed: true, configFiles: [p], current: typeof first?.url === 'string' ? first.url : undefined }
    } catch {
      return { installed: true, configFiles: [p], note: t('models.json 无法解析（attach 时会中止）', 'models.json cannot be parsed (attach will abort)') }
    }
  },

  async planAttach(opts: AttachOptions, cfg: Config): Promise<PlanResult> {
    if ((await appPresent()) === false) {
      throw new AdapterError(
        t('未找到 WorkBuddy 桌面应用（注册表卸载项/常见安装目录都没有）——可能已卸载（~/.workbuddy-ai/ 只是残留配置）', 'The WorkBuddy desktop app was not found (neither the registry uninstall entries nor common install directories have it) — it may have been uninstalled (~/.workbuddy-ai/ is leftover config only)'),
        t('请先安装并启动一次 WorkBuddy 后再接入', 'Install and launch WorkBuddy once before attaching')
      )
    }
    const existing = await activeFile()
    const p = existing ?? candidateFiles()[0]
    const text = existing !== null ? await readTextIfExists(existing) : null

    // 模型列表：与 zcode 一致，取当前路由对应服务的模型目录；请求 model 名 = 条目 id，
    // 网关对未命中别名的模型名原样透传，所以 id 必须是真实模型名（resolveRoute 与 dsh/zcode/provider-json 共用）
    const route = resolveRoute(opts, cfg)
    const { routeName, profile, providerId, provider } = route
    const modelIds = Object.keys(route.modelMap)

    const notes: string[] = []
    if (providerId && profile) {
      notes.push(routeModelNote(String(routeName), String(provider?.name ?? providerId), modelIds.length))
    }
    if (modelIds.length === 0) {
      throw new AdapterError(
        t('当前路由（{route}）没有可写入的模型目录', 'The current route ({route}) has no model catalog to write', { route: routeName ?? '(未设置)' }),
        t('请先在 ModelDock 中应用服务/拉取模型，再重新接入 WorkBuddy', 'Apply a service / fetch models in ModelDock first, then attach WorkBuddy again')
      )
    }

    // WorkBuddy 条目的 url 是完整请求端点（OpenAI chat/completions 全路径）：直连时用上游 openai 端点拼同款路径
    const d = opts.direct
    const directBase = d ? ((d.base_url_openai ?? d.base_url).replace(/\/+$/, '') + '/chat/completions') : undefined
    const base = directBase ?? gatewayEndpointUrl(opts.gatewayPort)
    const mine: WorkbuddyModelEntry[] = modelIds.map((mid) => ({
      id: mid,
      name: provider?.models?.[mid]?.display_name || mid,
      url: base,
      apiKey: d ? d.key : opts.token,
    }))
    const directNotes: string[] = []
    if (d) {
      directNotes.push(directAttachNote(base))
      if (d.protocol !== 'openai' && !d.base_url_openai) {
        directNotes.push(
          t(
            '提示: 该服务未配置 OpenAI 协议端点，而 WorkBuddy 条目走 chat/completions（OpenAI 协议）；请确认上游兼容或在「编辑服务」里补填',
            'Note: this service has no OpenAI protocol endpoint, but WorkBuddy entries use chat/completions (OpenAI protocol); make sure the upstream is compatible or fill it in under Edit Service'
          )
        )
      }
    }

    let root: unknown
    let shape: 'array' | 'object'
    if (text === null) {
      root = mine
      shape = 'array'
      notes.push(t('将新建 {path}（顶层数组，WorkBuddy UI 同款格式）', 'Will create {path} (top-level array, same format as the WorkBuddy UI)', { path: p }))
    } else {
      root = parseJsonStrict(text, p) as unknown
      if (Array.isArray(root)) {
        shape = 'array'
      } else if (root !== null && typeof root === 'object' && Array.isArray((root as WorkbuddyModelsObject).models)) {
        shape = 'object'
      } else {
        throw new AdapterError(
          t('{path} 既不是模型数组也不是 { models: [...] } 结构，已中止', '{path} is neither a model array nor a { models: [...] } object; aborted', { path: p }),
          t('请手工整理后再接入（原文可经 restore 找回旧快照）', 'Tidy it up by hand before attaching (the original can be recovered from an older snapshot via restore)')
        )
      }
    }

    // 只摘除指向本网关的条目（幂等重接），用户自己的条目一律不动
    const entries = (shape === 'array' ? (root as WorkbuddyModelEntry[]) : ((root as WorkbuddyModelsObject).models as WorkbuddyModelEntry[]))
      .filter((e) => !isOursEntry(e, cfg))

    const skipped: string[] = []
    for (const entry of mine) {
      const id = entry.id as string
      const clash = entries.find((e) => e.id === id)
      if (clash) {
        skipped.push(id)
        continue
      }
      entries.push(entry)
    }
    if (skipped.length > 0) {
      notes.push(
        t(
          '这些模型你已有自己的自定义条目（指向其它端点），ModelDock 不覆盖：{ids}',
          'You already have your own custom entries for these models (pointing elsewhere); ModelDock does not overwrite them: {ids}',
          { ids: biJoin('、', ', ', skipped) }
        )
      )
    }
    if (shape === 'object') {
      const obj = root as WorkbuddyModelsObject
      obj.models = entries
      if (Array.isArray(obj.availableModels)) {
        const ids = obj.availableModels.filter((x): x is string => typeof x === 'string')
        obj.availableModels = [...new Set([...ids, ...mine.map((m) => m.id as string)])]
        notes.push(
          t(
            '已把 ModelDock 模型并入 availableModels（该文件为手写对象格式）',
            'Merged the ModelDock models into availableModels (this file uses the hand-written object format)'
          )
        )
      }
    } else {
      root = entries
    }

    const after = serializeJson(root, text !== null ? detectJsonIndent(text) : '  ', text !== null ? text.endsWith('\n') : true)
    const attachChange = changeIfChanged(
      p,
      text,
      after,
      text === null
        ? t('创建 models.json 并写入 ModelDock 模型', 'Create models.json and write the ModelDock models')
        : t('更新 ModelDock 模型条目（不动其它条目）', 'Update the ModelDock model entries (other entries untouched)')
    )
    const changes: FileChange[] = attachChange ? [attachChange] : []

    notes.push(
      t(
        'WorkBuddy 运行中会监听 models.json 自动加载；模型列表未刷新时重启 WorkBuddy',
        'WorkBuddy watches models.json and loads it automatically while running; if the model list does not refresh, restart WorkBuddy'
      )
    )
    notes.push(
      ...(d
        ? []
        : [
            t(
              'token 为本地网关令牌（非真实凭据）；新建文件以 0600 落盘，已有文件保留原权限；detach 时移除',
              'The token is a local gateway token (not real credentials); new files are written with 0600, existing files keep their permissions, and it is removed on detach'
            ),
          ]),
      ...directNotes
    )
    return { changes, notes, writtenBaseUrl: directBase }
  },

  async planDetach(cfg: Config): Promise<PlanResult> {
    const p = await activeFile()
    if (p === null) return noChangeResult([t('WorkBuddy 未指向 ModelDock 网关，无需改动', 'WorkBuddy is not pointing at the ModelDock gateway; nothing to change')])
    const text = await readTextIfExists(p)
    let root: unknown
    try {
      root = parseJsonStrict(text!, p) as unknown
    } catch {
      return { changes: [], notes: [t('models.json 无法解析，跳过（可用 restore 还原快照）', 'models.json cannot be parsed; skipped (you can restore from a snapshot)')] }
    }
    const isArray = Array.isArray(root)
    // 字面量 null / 非对象（如数字、字符串）都不是合法结构，走既有跳过路径，避免对 null 取属性抛 TypeError
    const entries = isArray
      ? (root as WorkbuddyModelEntry[])
      : root !== null && typeof root === 'object'
        ? (root as WorkbuddyModelsObject).models
        : undefined
    if (!Array.isArray(entries)) return { changes: [], notes: [t('models.json 结构无法识别，跳过', 'models.json has an unrecognized structure; skipped')] }

    const ours = entries.filter((e) => isOursEntry(e, cfg))
    if (ours.length === 0) {
      return noChangeResult([t('WorkBuddy 未指向 ModelDock 网关，无需改动', 'WorkBuddy is not pointing at the ModelDock gateway; nothing to change')])
    }
    const remaining = entries.filter((e) => !isOursEntry(e, cfg))
    const removedIds = new Set(ours.map((e) => e.id).filter((x): x is string => typeof x === 'string'))

    const afterRoot: unknown = isArray ? remaining : { ...(root as WorkbuddyModelsObject), models: remaining }
    // availableModels 里只清掉已无任何条目引用的 id（我们自己并入的那部分）
    if (!isArray && Array.isArray((root as WorkbuddyModelsObject).availableModels)) {
      const avail = (root as WorkbuddyModelsObject).availableModels as unknown[]
      const keptIds = new Set(remaining.map((e) => e.id).filter((x): x is string => typeof x === 'string'))
      ;(afterRoot as WorkbuddyModelsObject).availableModels = avail.filter(
        (x) => !(typeof x === 'string' && removedIds.has(x) && !keptIds.has(x))
      )
    }

    const after = serializeJson(afterRoot, detectJsonIndent(text!), text!.endsWith('\n'))
    return {
      changes: [
        changeIfChanged(
          p,
          text,
          after,
          t(
            '移除 {count} 个 ModelDock 模型条目（其余条目不动）',
            'Remove {count} ModelDock model entries (other entries untouched)',
            { count: ours.length }
          )
        ),
      ].filter((c): c is NonNullable<typeof c> => c !== null),
      notes: [t('若 WorkBuddy 模型列表仍显示 ModelDock，重启 WorkBuddy', 'If WorkBuddy still shows ModelDock in its model list, restart WorkBuddy')],
    }
  },

  async status(cfg: Config, port: number): Promise<AdapterStatus> {
    const p = await activeFile()
    const present = await appPresent()
    if (p === null) {
      if ((await installMarker()) !== null) {
        if (present === false) {
          return {
            installed: false,
            attached: !!cfg.harness['workbuddy'],
            pointing: 'unknown',
            detail: t('检测到配置残留，但未找到桌面应用（可能已卸载）', 'Found leftover config but the desktop app is missing (may have been uninstalled)'),
          }
        }
        return {
          installed: true,
          attached: !!cfg.harness['workbuddy'],
          pointing: 'unknown',
          detail: t('已安装，尚无 models.json（未接入）', 'Installed, no models.json yet (not attached)'),
        }
      }
      if (present === true) {
        return {
          installed: true,
          attached: false,
          pointing: 'unknown',
          detail: t('已安装，尚未启动过（无 ~/.workbuddy-ai/ 配置）', 'Installed but never launched (no ~/.workbuddy-ai/ config)'),
        }
      }
      return { installed: false, attached: false }
    }
    if (present === false) {
      return {
        installed: false,
        attached: !!cfg.harness['workbuddy'],
        pointing: 'unknown',
        detail: t('检测到配置残留，但未找到桌面应用（可能已卸载）', 'Found leftover config but the desktop app is missing (may have been uninstalled)'),
      }
    }
    const text = await readTextIfExists(p)
    try {
      const entries = extractEntries(parseJsonStrict(text!, p))
      const ours = entries.filter((e) => isOursEntry(e, cfg))
      const oursBase = typeof ours[0]?.url === 'string' ? (ours[0]!.url as string) : undefined
      const otherBase = entries.map((e) => (typeof e.url === 'string' ? e.url : undefined)).find((u) => u !== undefined)
      return {
        installed: true,
        attached: !!cfg.harness['workbuddy'],
        pointing: oursBase
          ? oursBase === gatewayEndpointUrl(port)
            ? 'gateway'
            : 'other'
          : otherBase
            ? 'other'
            : 'unknown',
        detail:
          (oursBase ?? t('(未注册 ModelDock 模型)', '(no ModelDock models registered)')) +
          (ours.length > 0 ? t(' · {count} 个模型', ' · {count} models', { count: ours.length }) : ''),
      }
    } catch {
      return { installed: true, attached: !!cfg.harness['workbuddy'], pointing: 'unknown', detail: t('models.json 解析失败', 'Failed to parse models.json') }
    }
  },
}
