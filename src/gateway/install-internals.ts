/** 安装域内部帮手（T05 拆出；install.ts 与后续检查共用） */
import { isNpmGlobalInstall, resolveInstallCommand, type ClientInstall } from '../adapters/types.js'
import { commandOnPath, commandOnPathSandbox } from '../util/fsx.js'
import { sandboxNpmPrefix } from '../util/paths.js'

export /** 安装/卸载前的 probe：可装进沙箱的 npm 类客户端在沙箱实例（FAKE_HOME）下只认沙箱内命中，
 *  宿主真机的同名命令不算数——否则真机装过的客户端在沙箱里永远「跳过安装」，卸载后状态
 *  也回不到未安装（2026-10-11 dev 沙箱实测踩中）。脚本类/桌面类只有真机一份拷贝，保持并集。 */
function probePresent(inst: ClientInstall, cmd: string): boolean {
  const sandboxIsolated = sandboxNpmPrefix() !== null && isNpmGlobalInstall(resolveInstallCommand(inst.command) ?? '')
  return sandboxIsolated ? commandOnPathSandbox(cmd) : commandOnPath(cmd)
}
