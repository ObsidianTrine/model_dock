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
export const adaptersDir = () => path.join(modeldockDir(), 'adapters')
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
  return p === realHome || p.startsWith(realHome + '/') ? '~' + p.slice(realHome.length) : p
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
