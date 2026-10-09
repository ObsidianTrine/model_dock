import { craftProviderJsonAdapter } from './provider-json.js'
import { desktopPresent } from './presence.js'
import { configCandidates } from './mimo-code.js'
import {
  AdapterError,
  type AdapterStatus,
  type AttachOptions,
  type DetectResult,
  type HarnessAdapter,
  type PlanResult,
} from './types.js'
import type { Config } from '../config/types.js'
import { t } from '../util/i18n.js'

/**
 * MiMo 桌面端（小米 Electron 客户端，实测本机安装于 D:\Programs\Xiaomi MiMo）：
 * 内嵌 mimocode 引擎，自定义供应商与 MiMoCode CLI **共用同一份全局配置**
 * ~/.config/mimocode/mimocode.jsonc（用户在桌面端手动接入 DeepSeek 实测就落到该文件，
 * 格式为 provider.<id>.npm=@ai-sdk/openai-compatible + options.apiKey/models——与 CLI 同构）。
 * 因此接入/断开逻辑完全复用 provider-json 工厂，只把「已安装」判定换成桌面应用本体：
 * 注册表卸载项（实测 HKCU 登记 DisplayName「Xiaomi MiMo 26.923.232338」，用户可自选安装盘，
 * 固定目录扫描覆盖不到）与常见安装目录兜底。
 */
async function appPresent(): Promise<boolean | 'unknown'> {
  return desktopPresent(['Xiaomi MiMo'], 'mimo-desktop')
}

const base = craftProviderJsonAdapter({
  id: 'mimo-desktop',
  get label() {
    return t('MiMo 桌面端', 'MiMo Desktop')
  },
  configFiles: configCandidates,
  install: {
    get guide() {
      return t(
        'MiMo 桌面端是小米的桌面 AI 客户端（内嵌 mimocode 引擎）。请到下方官网桌面版页下载安装（Windows 安装包 / macOS），启动一次后回来点「重新检测」。其自定义供应商与 MiMoCode CLI 共用 ~/.config/mimocode/mimocode.jsonc，ModelDock 一键接入会自动写入；接入后重启桌面端生效。',
        'MiMo Desktop is Xiaomi\'s desktop AI client (embedding the mimocode engine). Download and install it from the official desktop page below (Windows installer / macOS), launch it once, then come back and click Re-detect. Its custom providers share ~/.config/mimocode/mimocode.jsonc with the MiMoCode CLI — ModelDock attach writes it automatically; restart the desktop app after attaching.'
      )
    },
    // /go/desktop 实测跳转到桌面版下载页（mimo.xiaomimimo.com/desktop）
    homepage: 'https://mimo.xiaomi.com/go/desktop',
  },
  // 桌面端模型选择按 provider.models 展示，与 CLI 一致需要显式声明（否则不列出）
  declareModels: true,
})

export const mimoDesktopAdapter: HarnessAdapter = {
  ...base,
  // 展开会把 base 的 label getter 求值固化，这里重新挂 getter 保持按语言懒求值
  get label() {
    return base.label
  },

  async detect(): Promise<DetectResult> {
    const det = await base.detect()
    const present = await appPresent()
    if (present === false) {
      if (!det.installed) return det
      return {
        installed: false,
        configFiles: [],
        note: t(
          '检测到配置残留（{files}），但未找到 MiMo 桌面端（注册表卸载项/常见安装目录都没有）——可能已卸载；若仍在使用，请重新安装并启动一次后点「重新检测」',
          'Found leftover config ({files}) but the MiMo desktop app is missing (neither the registry uninstall entries nor common install directories have it) — it may have been uninstalled; if you still use it, reinstall, launch it once, then click Re-detect',
          { files: det.configFiles.join('、') }
        ),
      }
    }
    if (!det.installed && present === true) {
      return {
        installed: true,
        configFiles: [],
        note: t(
          '已安装 MiMo 桌面端，但还没有自定义模型配置（首次添加自定义供应商后生成）；可直接「一键接入」，将自动创建',
          'The MiMo desktop app is installed but has no custom model config yet (created when you first add a custom provider); you can attach directly and it will be created for you'
        ),
      }
    }
    return det
  },

  async planAttach(opts: AttachOptions, cfg: Config): Promise<PlanResult> {
    if ((await appPresent()) === false) {
      throw new AdapterError(
        t(
          '未找到 MiMo 桌面端本体（注册表卸载项/常见安装目录都没有）——可能已卸载（配置只是残留）；请先安装并启动一次 MiMo 桌面端后再接入',
          'The MiMo desktop app itself was not found (neither the registry uninstall entries nor common install directories have it) — it may have been uninstalled (the config is leftover only); install and launch the MiMo desktop app once before attaching'
        )
      )
    }
    return base.planAttach(opts, cfg)
  },

  async status(cfg: Config, port: number): Promise<AdapterStatus> {
    const st = await base.status(cfg, port)
    const present = await appPresent()
    if (present === false) {
      if (!st.installed) return st
      return {
        installed: false,
        attached: st.attached,
        pointing: 'unknown',
        detail: t('检测到配置残留，但未找到 MiMo 桌面端（可能已卸载）', 'Found leftover config but the MiMo desktop app is missing (may have been uninstalled)'),
      }
    }
    if (!st.installed && present === true) {
      return {
        installed: true,
        attached: false,
        pointing: 'unknown',
        detail: t('已安装，尚无自定义模型配置（未接入）', 'Installed, no custom model config yet (not attached)'),
      }
    }
    return st
  },
}
