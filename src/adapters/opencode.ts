import path from 'node:path'
import { homeDir, t } from '../util/index.js'
import { craftProviderJsonAdapter } from './provider-json.js'

// OpenCode（sst/opencode，终端 AI 编码代理）配置为 JSON：provider.<id>.options.baseURL/apiKey + 顶层 model。
// 单一确定路径：~/.config/opencode/opencode.json（Windows 为 %USERPROFILE%\.config\opencode\opencode.json）。
export const openCodeAdapter = craftProviderJsonAdapter({
  id: 'opencode',
  label: 'OpenCode',
  configFiles: () => [path.join(homeDir(), '.config', 'opencode', 'opencode.json')],
  install: {
    command: 'npm i -g opencode-ai',
    needsNode: true,
    probe: 'opencode',
    get guide() {
      return t(
        'OpenCode 是终端代理（Node 程序）。点「安装并接入」由 ModelDock 自动完成：本机没有 Node 时自动下载托管 Node 运行时，npm 安装自动走大陆镜像，装完自动写配置。手动兜底：npm i -g opencode-ai --registry=https://registry.npmmirror.com（npm 官方源大陆常不可达），装完运行一次 opencode 完成初始化。',
        'OpenCode is a terminal agent (a Node program). Click Install & attach and ModelDock handles it: if this machine has no Node.js, the managed Node runtime is downloaded first, npm runs against the official registry, and the config is written automatically. Manual fallback: npm i -g opencode-ai, then run opencode once to initialize.'
      )
    },
    // opencode.ai 大陆直连超时（实测），换成可达且含安装用法的镜像包页
    homepage: 'https://npmmirror.com/package/opencode-ai',
    bootstrap: { path: () => path.join(homeDir(), '.config', 'opencode', 'opencode.json'), content: '{}\n' },
  },
})