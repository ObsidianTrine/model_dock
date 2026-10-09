import { t } from '../util/i18n.js'
import type { Config } from '../config/types.js'
import type { AdapterStatus, AttachOptions, DetectResult, HarnessAdapter, PlanResult } from './types.js'

/** 通用环境变量兜底：不写任何文件，配合 modeldock env 使用 */
export const genericAdapter: HarnessAdapter = {
  id: 'generic-env',
  // getter 懒求值：overview/attach 请求期访问时按请求语言渲染（模块加载期 t() 会固化语言）
  get label() {
    return t('通用环境变量（其他客户端兜底）', 'Generic env vars (fallback for other clients)')
  },

  async detect(): Promise<DetectResult> {
    return {
      installed: true,
      configFiles: [],
      note: t(
        '无配置文件；接入后复制环境变量（或执行 eval "$(modeldock env)"）',
        'No config files; after attaching, copy the environment variables (or run eval "$(modeldock env)")'
      ),
    }
  },

  async planAttach(_opts: AttachOptions, _cfg: Config): Promise<PlanResult> {
    return {
      changes: [],
      notes: [
        t(
          '不写任何文件；接入后从控制台点「复制环境变量」，或执行 eval "$(modeldock env)"',
          'No files are written; after attaching, click Copy Environment Variables in the console, or run eval "$(modeldock env)"'
        ),
      ],
    }
  },

  async planDetach(_cfg: Config): Promise<PlanResult> {
    return { changes: [], notes: [t('请从 shell 配置中移除由 modeldock env 注入的变量', 'Remove the variables injected by modeldock env from your shell config')] }
  },

  async status(cfg: Config): Promise<AdapterStatus> {
    const he = cfg.harness['generic-env']
    return {
      installed: true,
      attached: !!he,
      pointing: he ? 'gateway' : 'unknown',
      detail: he
        ? t('点「复制环境变量」，把地址和 Key 填进其他客户端即可经网关调用', 'Click Copy Environment Variables and fill the URL and key into other clients to call them through the gateway')
        : t('不写任何文件，给其他客户端兜底；接入后点「复制环境变量」', 'Writes no files and serves as the fallback for other clients; after attaching, click Copy Environment Variables'),
    }
  },
}
