import path from 'node:path'
import { homeDir, t } from '../util/index.js'
import { craftProviderJsonAdapter } from './provider-json.js'

/**
 * MiMoCode（小米开源终端 AI 编码工具，`mimo` 命令，npm 包 @mimo-ai/cli）。
 * 配置为 JSON/JSONC，官方文档（mimo.xiaomi.com/zh/mimocode，README 已实测核对 0.1.15）：
 * - 全局：~/.config/mimocode/mimocode.jsonc（也支持 .json）；文档另提 Windows 在 %LOCALAPPDATA%\mimocode\
 * - MIMOCODE_HOME 覆盖 XDG 根，配置在其 config/ 子目录（本机实测确认）
 * Windows 实测（本机 mimo 0.1.9 二进制）：全局配置解析仍是 XDG 的 ~/.config/mimocode/，
 * 二进制内无 %LOCALAPPDATA% 路径字样——因此两处都作为候选且 XDG 在前（旧版只认 XDG，
 * 新版文档路径作为兜底），否则 Windows 上检测不到真实配置、接入还会把文件写到应用不读的位置。
 * 字段结构与 OpenCode 同构（provider.<id>.options.baseURL/apiKey + 顶层 model），
 * 官方「自定义 OpenAI 兼容端点」样例即此格式。
 */
/** MiMoCode 全局配置候选（首个存在者生效；都不存在时第一个为新建目标）。
 *  MiMo 桌面端内嵌同一 mimocode 引擎、共用这份配置（mimo-desktop.ts 复用）。 */
export const configCandidates = (): string[] => {
  const list: string[] = []
  const mcHome = process.env.MIMOCODE_HOME?.trim()
  if (mcHome) {
    list.push(path.join(mcHome, 'config', 'mimocode.jsonc'), path.join(mcHome, 'config', 'mimocode.json'))
  }
  const home = homeDir()
  list.push(path.join(home, '.config', 'mimocode', 'mimocode.jsonc'), path.join(home, '.config', 'mimocode', 'mimocode.json'))
  // 测试（MODELRDOCK_FAKE_HOME）下忽略宿主机 LOCALAPPDATA：它指向真实安装，会把断言拖到宿主机目录上。
  // MIMOCODE_HOME 不在此列——那是显式的用户覆盖，测试要能指定。
  if (process.platform === 'win32' && !process.env.MODELRDOCK_FAKE_HOME) {
    const local = process.env.LOCALAPPDATA?.trim() || path.join(home, 'AppData', 'Local')
    list.push(path.join(local, 'mimocode', 'mimocode.jsonc'), path.join(local, 'mimocode', 'mimocode.json'))
  }
  return list
}

export const mimoCodeAdapter = craftProviderJsonAdapter({
  id: 'mimo-code',
  label: 'MiMo Code',
  configFiles: configCandidates,
  install: {
    // 小米官方脚本：从小米自家 CDN 下载编译好的二进制装到 ~/.mimocode/bin（免 sudo、自动改 PATH），
    // 全新机器不需要 Node——npm 路径只作为脚本装不上时的手动兜底写进指引
    command: {
      posix: 'curl -fsSL https://mimo.xiaomi.com/install | bash',
      win32: 'powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://mimo.xiaomi.com/install.ps1 | iex"',
    },
    probe: 'mimo',
    get guide() {
      return t(
        'MiMoCode 是小米开源终端 AI 编码工具（mimo 命令）。点「安装并接入」将执行小米官方安装脚本（内置二进制，不需要 Node.js）。自动安装失败时可手动安装：macOS/Linux 执行 `curl -fsSL https://mimo.xiaomi.com/install | bash`；Windows PowerShell 执行 `irm https://mimo.xiaomi.com/install.ps1 | iex`；或任意有 Node 的机器 `npm install -g @mimo-ai/cli`。装完运行一次 `mimo` 生成配置，再回来点「重新检测」。',
        'MiMoCode is Xiaomi\'s open-source terminal AI coding tool (the mimo command). Click Install & attach to run Xiaomi\'s official installer (bundled binary, no Node.js needed). If automatic install fails: on macOS/Linux run `curl -fsSL https://mimo.xiaomi.com/install | bash`; on Windows PowerShell run `irm https://mimo.xiaomi.com/install.ps1 | iex`; or on any machine with Node, `npm install -g @mimo-ai/cli`. After installing, run `mimo` once to generate the config, then come back and click Re-detect.'
      )
    },
    homepage: 'https://mimo.xiaomi.com/zh/mimocode',
    bootstrap: {
      path: () => configCandidates()[0],
      // 与应用首启自建内容一致（$schema 指官方 Schema，合法 JSON 即合法 JSONC）
      content: JSON.stringify({ $schema: 'https://mimo.xiaomi.com/mimocode/config.json' }, null, 2) + '\n',
    },
  },
  bin: {
    name: 'mimo',
    get noteInstalled() {
      return t(
        '已安装 MiMoCode（mimo 命令可用），尚未生成配置文件；可直接「一键接入」，将自动创建配置',
        'MiMoCode is installed (the mimo command works) but no config file has been generated yet; you can attach directly and the config will be created for you'
      )
    },
  },
  // MiMoCode 要求 provider.models 显式声明模型（官方样例格式），否则 mimo models 不列出
  declareModels: true,
})
