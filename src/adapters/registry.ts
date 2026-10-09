import type { Config } from '../config/types.js'
import { t } from '../util/i18n.js'
import { claudeCodeAdapter } from './claude-code.js'
import { codexAdapter } from './codex.js'
import { dshAdapter } from './dsh.js'
import { genericAdapter } from './generic.js'
import { mimoCodeAdapter } from './mimo-code.js'
import { mimoDesktopAdapter } from './mimo-desktop.js'
import { openCodeAdapter } from './opencode.js'
import { packAdapter } from './packs.js'
import { workbuddyAdapter } from './workbuddy.js'
import { zcodeAdapter } from './zcode.js'
import { AdapterError, type AdapterStatus, type AttachOptions, type DetectResult, type HarnessAdapter, type PlanResult } from './types.js'

function builtins(): HarnessAdapter[] {
  return [claudeCodeAdapter, zcodeAdapter, dshAdapter, codexAdapter, openCodeAdapter, mimoCodeAdapter, mimoDesktopAdapter, workbuddyAdapter, genericAdapter]
}

/** 校验失败的坏 pack：以错误占位 adapter 呈现（状态检查时报错），不拖垮整个列表 */
function brokenPackAdapter(id: string, err: unknown): HarnessAdapter {
  const msg =
    err instanceof AdapterError
      ? err.message
      : t('adapter pack「{id}」无效：{err}', 'Adapter pack "{id}" is invalid: {err}', { id, err: (err as Error).message })
  return {
    id,
    get label() {
      return t('{id}（pack 配置错误）', '{id} (broken adapter pack)', { id })
    },
    async detect(): Promise<DetectResult> {
      return { installed: false, configFiles: [], note: msg }
    },
    async planAttach(): Promise<PlanResult> {
      throw new AdapterError(msg)
    },
    async planDetach(): Promise<PlanResult> {
      return { changes: [], notes: [msg] }
    },
    async status(): Promise<AdapterStatus> {
      return { installed: false, attached: false, pointing: 'unknown', detail: msg }
    },
  }
}

/** 内置 + L2 声明式 pack（L3 外部插件在 M2） */
export function allAdapters(cfg: Config): HarnessAdapter[] {
  const list = builtins()
  for (const [id, pack] of Object.entries(cfg.adapter_packs ?? {})) {
    try {
      list.push(packAdapter(id, pack))
    } catch (e) {
      list.push(brokenPackAdapter(id, e))
    }
  }
  return list
}

export async function getAdapter(id: string, cfg: Config): Promise<HarnessAdapter | null> {
  return allAdapters(cfg).find((a) => a.id === id) ?? null
}

export async function requireAdapter(id: string, cfg: Config): Promise<HarnessAdapter> {
  const found = await getAdapter(id, cfg)
  if (!found) {
    const known = allAdapters(cfg)
      .map((a) => a.id)
      .join(', ')
    throw new Error(
      t(
        '未知 harness「{id}」。可用：{known}\n新 harness 可通过 config.toml 的 [adapter_packs.<id>] 声明式接入，或用 generic-env 兜底',
        'Unknown harness "{id}". Available: {known}\nTo add a new harness, declare it under [adapter_packs.<id>] in config.toml, or use generic-env as a fallback',
        { id, known }
      )
    )
  }
  return found
}
