import path from 'node:path'
import { readTextIfExists, expandHome, setPath, getPath, toSegments, t } from '../util/index.js'
import { modeldockDir } from '../util/paths.js'
import type { AdapterPack } from '../config/types.js'
import type { Config } from '../config/types.js'
import {
  AdapterError,
  type AdapterStatus,
  type AttachOptions,
  type DetectResult,
  type HarnessAdapter,
  type PlanResult,
} from './types.js'
import { detectJsonIndent, parseDocument, parseJsonStrict, serializeJson, tomlParse, tomlStringify } from './format.js'

export interface PackVars {
  token: string
  port: string
  base_url: string
  base_url_openai: string
}

function expandVars(tpl: string, vars: PackVars): string {
  const map: Record<string, string> = { ...vars }
  return tpl.replace(/\{(\w+)\}/g, (_, k: string) => {
    const v = map[k]
    if (v === undefined) {
      throw new AdapterError(
        t(
          'adapter pack 模板变量 {name} 不支持（可用：token/port/base_url/base_url_openai）',
          'Adapter pack template variable {name} is not supported (available: token/port/base_url/base_url_openai)',
          { name: `{${k}}` }
        )
      )
    }
    return v
  })
}

/** 对文本应用 pack.upsert，返回新文本（按格式序列化，尽量保持原格式） */
export function applyPackUpsert(text: string, pack: AdapterPack, vars: PackVars): string {
  const entries = Object.entries(pack.upsert)
  switch (pack.format) {
    case 'json': {
      const root = parseJsonStrict(text, pack.config_file)
      for (const [k, v] of entries) setPath(root, k, expandVars(v, vars))
      return serializeJson(root, detectJsonIndent(text), text.endsWith('\n'))
    }
    case 'yaml': {
      const doc = parseDocument(text)
      for (const [k, v] of entries) doc.setIn(toSegments(k), expandVars(v, vars))
      return doc.toString()
    }
    case 'toml': {
      const root = tomlParse(text) as Record<string, unknown>
      for (const [k, v] of entries) setPath(root, k, expandVars(v, vars))
      const out = tomlStringify(root)
      return out.endsWith('\n') ? out : out + '\n'
    }
    default:
      throw new AdapterError(
        t(
          'adapter pack「{id}」的 format「{format}」无效，应为 json / yaml / toml',
          'Adapter pack "{id}" has an invalid format "{format}"; expected json / yaml / toml',
          { id: pack.config_file, format: String(pack.format) }
        )
      )
  }
}

/** L2 声明式 adapter：用户在 config.toml 的 [adapter_packs.<id>] 里定义，零代码接入新 harness */
export function packAdapter(id: string, pack: AdapterPack): HarnessAdapter {
  // 加载期校验：让配置错误在启动/列表期就报可读错误，而不是 attach 时 TypeError
  if (!['json', 'yaml', 'toml'].includes(pack.format)) {
    throw new AdapterError(
      t(
        'adapter pack「{id}」的 format「{format}」无效，应为 json / yaml / toml',
        'Adapter pack "{id}" has an invalid format "{format}"; expected json / yaml / toml',
        { id, format: String(pack.format) }
      )
    )
  }
  if (!pack.config_file?.trim()) {
    throw new AdapterError(t('adapter pack「{id}」缺少 config_file', 'Adapter pack "{id}" is missing config_file', { id }))
  }
  // 防自我改写：pack 的目标文件不允许落在 ModelDock 自己的数据目录里
  const resolved = path.resolve(expandHome(pack.config_file))
  if (resolved.startsWith(path.resolve(modeldockDir()) + path.sep)) {
    throw new AdapterError(
      t(
        'adapter pack「{id}」的 config_file 不允许指向 ModelDock 数据目录（{dir}）',
        'The config_file of adapter pack "{id}" must not point into the ModelDock data directory ({dir})',
        { id, dir: modeldockDir() }
      )
    )
  }
  const file = () => expandHome(pack.config_file)
  return {
    id,
    get label() { return `${id}${t('（声明式 pack）', ' (declarative pack)')}` },
    directMode: true,

    async detect(): Promise<DetectResult> {
      const p = file()
      const text = await readTextIfExists(p)
      if (text === null) return { installed: false, configFiles: [], note: t('{path} 不存在', '{path} does not exist', { path: p }) }
      if (pack.detect?.key_path) {
        let obj: unknown
        try {
          obj =
            pack.format === 'json'
              ? JSON.parse(text)
              : pack.format === 'toml'
                ? tomlParse(text)
                : parseDocument(text).toJS()
        } catch (e) {
          // 目标文件损坏时只标注自身，不炸掉整个 adapter 列表（status/doctor/控制台都在遍历它）
          return {
            installed: true,
            configFiles: [p],
            note: t('目标文件解析失败：{err}', 'Failed to parse the target file: {err}', { err: (e as Error).message }),
          }
        }
        const hit = getPath(obj, pack.detect.key_path)
        if (!hit) {
          return {
            installed: true,
            configFiles: [p],
            note: t('detect.key_path {path} 未命中', 'detect.key_path {path} did not match', { path: pack.detect.key_path }),
          }
        }
      }
      return { installed: true, configFiles: [p] }
    },

    async planAttach(opts: AttachOptions, _cfg: Config): Promise<PlanResult> {
      const p = file()
      const text = await readTextIfExists(p)
      if (text === null) {
        throw new AdapterError(t('{path} 不存在，无法应用 adapter pack', '{path} does not exist; cannot apply the adapter pack', { path: p }))
      }
      // direct 模式代入上游直连值（base_url_openai 缺省回退 base_url：上游 openai 端点由 pack 模板负责拼路径）
      const vars: PackVars = {
        token: opts.direct?.key ?? opts.token,
        port: String(opts.gatewayPort),
        base_url: opts.direct?.base_url ?? `http://127.0.0.1:${opts.gatewayPort}`,
        base_url_openai: opts.direct?.base_url_openai ?? opts.direct?.base_url ?? `http://127.0.0.1:${opts.gatewayPort}/v1`,
      }
      const note = opts.direct
        ? t('adapter pack upsert（独立直连：写入上游地址与真实 Key）', 'adapter pack upsert (direct mode: writes the upstream URL and the real key)')
        : 'adapter pack upsert'
      return {
        changes: [{ path: p, before: text, after: applyPackUpsert(text, pack, vars), note }],
        notes: opts.direct
          ? [
              t(
                '独立直连：已写入上游 base_url 与真实 Key（明文），网关挂掉后该客户端不受影响',
                'Direct mode: wrote the upstream base_url and the real key (plaintext); this client keeps working if the gateway is down'
              ),
            ]
          : [],
        writtenBaseUrl: opts.direct?.base_url,
      }
    },

    async planDetach(_cfg: Config): Promise<PlanResult> {
      return {
        changes: [],
        notes: [
          t(
            '声明式 pack 不记录反向规则；还原请用快照：modeldock restore {id}',
            'Declarative packs record no reverse rules; restore from a snapshot: modeldock restore {id}',
            { id }
          ),
        ],
      }
    },

    async status(cfg: Config): Promise<AdapterStatus> {
      return {
        installed: await readTextIfExists(file()).then((t) => t !== null),
        attached: !!cfg.harness[id],
        pointing: cfg.harness[id] ? 'gateway' : 'unknown',
      }
    },
  }
}
