import { execFile } from 'node:child_process'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { commandOnPath, homeDir, t } from '../util/index.js'

export type AppPresent = boolean | 'unknown'

/**
 * 客户端「本体探测」：安装判定 = 配置文件 + 程序本体双信号。配置目录（~/.claude、~/.zcode、
 * %APPDATA% 下的应用数据等）不随卸载删除，只认配置文件会把「已卸载有残留」误报成已安装，
 * 还可能对残留文件执行一键接入改写（zcode 实测踩坑）。
 *
 * 测试钩子：`MODELRDOCK_FAKE_<ID 大写下划线>_PRESENT`（如 MODELRDOCK_FAKE_ZCODE_PRESENT /
 * MODELRDOCK_FAKE_CLAUDE_CODE_PRESENT）置 '1'/'0' 可强制按已安装/未安装判定，
 * 让单测与宿主机真实安装状态解耦。
 */
export function fakePresence(id: string): AppPresent | null {
  const v = process.env[`MODELRDOCK_FAKE_${id.toUpperCase().replace(/-/g, '_')}_PRESENT`]
  if (v === '1') return true
  if (v === '0') return false
  return null
}

/** CLI 形态本体：命令在 PATH 上即在场。commandOnPath 纯文件探测（PATH 逐目录 + Windows
 *  %APPDATA%\npm 与 PATHEXT 后缀 + macOS/Linux Homebrew/nvm 等常见位置兜底扫描），不 spawn 子进程。 */
export function cliPresent(cmd: string, id: string): boolean {
  const forced = fakePresence(id)
  if (forced === true) return true
  if (forced === false) return false
  return commandOnPath(cmd)
}

function execText(cmd: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout: timeoutMs }, (err, stdout) => resolve(err ? '' : String(stdout)))
  })
}

/** Windows 卸载表三种视图：HKCU（per-user 安装，如 Xiaomi MiMo / WorkBuddy 实测登记处）、
 *  HKLM 64 位、HKLM WOW6432Node（32 位安装器） */
const REG_UNINSTALL_KEYS = [
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
]

// overview 每 5 秒轮询会对每个桌面客户端调一次 status，reg /s 递归全树查询不能每次都跑：
// 按应用名做 60s 记忆。安装/卸载后最多延迟 1 分钟反映（「重新检测」同延迟，可接受）
const REG_TTL = 60_000
const regMemo = new Map<string, { at: number; hit: boolean }>()

async function registryHas(appName: string): Promise<boolean> {
  const memo = regMemo.get(appName)
  if (memo && Date.now() - memo.at < REG_TTL) return memo.hit
  let hit = false
  for (const key of REG_UNINSTALL_KEYS) {
    if (hit) break
    // /d 只搜数据值（DisplayName 等）；/s /f 全树递归且大小写不敏感，无匹配时 reg 退出码非 0、输出为空
    const out = await execText('reg', ['query', key, '/s', '/f', appName, '/d'], 8000)
    if (out.toLowerCase().includes(appName.toLowerCase())) hit = true
  }
  regMemo.set(appName, { at: Date.now(), hit })
  return hit
}

/** 目录下任一子项名字含关键字（不区分大小写）即视为安装痕迹；目录不存在/不可读视为无 */
async function dirHasEntry(dir: string, keywords: string[]): Promise<boolean> {
  try {
    for (const e of await fsp.readdir(dir)) {
      const lc = e.toLowerCase()
      if (keywords.some((k) => lc.includes(k))) return true
    }
  } catch {
    /* 目录不存在或不可读 */
  }
  return false
}

/**
 * 桌面应用本体探测（Electron/安装器类客户端，如 MiMo 桌面端、WorkBuddy、ZCode）：
 * - Windows：注册表卸载项（HKCU/HKLM/WOW6432Node）或常见安装目录（%LOCALAPPDATA%\Programs、
 *   Program Files 两档）里有应用目录。注册表是主判据——用户可自选安装盘（实测 D:\Programs\Xiaomi MiMo），
 *   固定目录扫描覆盖不到。
 * - macOS：/Applications 与 ~/Applications 下的 .app。
 * - 其他平台或探测自身出错：返回 'unknown'，调用方回退为按配置文件判定——宁可维持旧行为，
 *   也不把装好的客户端误报成未安装。
 */
export async function desktopPresent(appNames: string[], id: string): Promise<AppPresent> {
  const forced = fakePresence(id)
  if (forced !== null) return forced
  try {
    if (process.platform === 'win32') {
      const keywords = appNames.map((n) => n.toLowerCase())
      for (const name of appNames) {
        if (await registryHas(name)) return true
      }
      const bases = [
        process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs') : null,
        process.env['ProgramFiles'],
        process.env['ProgramFiles(x86)'],
      ]
      for (const base of bases) {
        if (base && (await dirHasEntry(base, keywords))) return true
      }
      return false
    }
    if (process.platform === 'darwin') {
      const keywords = appNames.map((n) => n.toLowerCase())
      for (const base of ['/Applications', path.join(homeDir(), 'Applications')]) {
        if (await dirHasEntry(base, keywords)) return true
      }
      return false
    }
  } catch {
    return 'unknown'
  }
  return 'unknown'
}

/** detect/status 通用语义：配置在而本体缺席 → 未安装（卸载残留），附可操作提示 */
export function residueNote(configFiles: string[], what: string): string {
  return t(
    '检测到 {what} 配置残留（{files}），但未找到程序本体——{what} 可能已卸载；若仍在使用，请重新安装并启动一次后点「重新检测」',
    'Found leftover {what} config ({files}) but the app itself is missing — {what} may have been uninstalled; if you still use it, reinstall, launch it once, then click Re-detect',
    { what, files: configFiles.join('、') }
  )
}
