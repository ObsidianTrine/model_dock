import os from 'node:os'
import path from 'node:path'

/** 支持测试环境重定向 home（MODELRDOCK_FAKE_HOME），所有模块须经由此函数取 home */
export function homeDir(): string {
  return process.env.MODELRDOCK_FAKE_HOME || os.homedir()
}

export function modeldockDir(): string {
  return process.env.MODELRDOCK_HOME || path.join(homeDir(), '.modeldock')
}

export const configPath = () => path.join(modeldockDir(), 'config.toml')
export const secretsPath = () => path.join(modeldockDir(), 'secrets.json')
export const presetsJsonPath = () => path.join(modeldockDir(), 'presets.json')
export const backupsDir = () => path.join(modeldockDir(), 'backups')
export const logsDir = () => path.join(modeldockDir(), 'logs')
export const gatewayStatePath = () => path.join(modeldockDir(), 'gateway.json')
/** 多机同步本机凭据（docs/design-cloud-sync.md §4.4）：与被同步的 config.toml 分文件，凭据不随包同步 */
export const syncJsonPath = () => path.join(modeldockDir(), 'sync.json')
/** 法定节假日（holiday-cn）数据缓存：拉取结果 + 已并入 config 的数据指纹 */
export const holidaysCachePath = () => path.join(modeldockDir(), 'holidays-cn.json')
/** 模型元数据目录（models.dev 社区数据）缓存：refreshCatalog 的拉取结果 */
export const modelCatalogCachePath = () => path.join(modeldockDir(), 'model-catalog.json')

/** 展开 ~ 前缀（用户在 config 里写的相对家目录路径） */
export function expandHome(p: string): string {
  if (p === '~') return homeDir()
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(homeDir(), p.slice(2))
  return p
}

/** 用户可见的展示路径：仅对真实系统 home 缩写为 ~。沙箱/自定义目录（MODELRDOCK_FAKE_HOME、
 *  MODELRDOCK_HOME）保持绝对路径——对它们缩写会把提示又变回误导性的 ~/.modeldock */
export function displayPath(p: string): string {
  const realHome = os.homedir()
  // 分隔符兼容 `[\\/]`：path.join 在 Windows 产 `\`，仅匹配 `/` 时永不缩写
  const underHome = p.startsWith(realHome + '/') || p.startsWith(realHome + '\\')
  return p === realHome || underHome ? '~' + p.slice(realHome.length) : p
}

/**
 * dsh 的 harness home 目录。与 dsh 自身解析规则一致：`$DSH_HOME` > `~/.dsh`。
 * 测试（MODELRDOCK_FAKE_HOME）下强制走 fake home，避免宿主机 DSH_HOME 泄漏进测试。
 */
export function dshHomeDir(): string {
  if (!process.env.MODELRDOCK_FAKE_HOME && process.env.DSH_HOME) {
    return expandHome(process.env.DSH_HOME)
  }
  return path.join(homeDir(), '.dsh')
}

/** 沙箱模式（MODELRDOCK_FAKE_HOME）下安装子进程的全局落点：npm 全局安装经 npm_config_prefix
 *  重定向到这里，包与 shim 都落沙箱内、不碰宿主全局 prefix（宿主 nvm/npm 全局目录）。
 *  非沙箱（生产/真机）返回 null——安装行为完全不变。 */
export function sandboxNpmPrefix(): string | null {
  return process.env.MODELRDOCK_FAKE_HOME ? path.join(modeldockDir(), 'npm-global') : null
}

/** 沙箱内 npm 缓存目录：与 prefix 同理收进沙箱，避免真机 ~/.npm 被测试安装写进缓存与日志 */
export function sandboxNpmCache(): string | null {
  return process.env.MODELRDOCK_FAKE_HOME ? path.join(modeldockDir(), 'npm-cache') : null
}

/** 沙箱 npm 全局 shim 所在目录（unix 是 prefix/bin，win 平铺在 prefix 根）：
 *  commandOnPathResolved 靠它看见装进沙箱的客户端。 */
export function sandboxNpmBinDir(): string | null {
  const prefix = sandboxNpmPrefix()
  if (!prefix) return null
  return process.platform === 'win32' ? prefix : path.join(prefix, 'bin')
}
